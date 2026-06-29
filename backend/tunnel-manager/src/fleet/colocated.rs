//! Co-located fleet supervisor (ADR-0024): in-process bots that register into the [`crate::fleet`]
//! `BotPool` and play arena matches over the relay bus, instead of holding a `/v1/fleet` WebSocket.
//! Removing the per-bot socket is the capacity swap at 5000 CCU.
//!
//! **Inert by default** (`FLEET_COLOCATED_COUNT=0`) — the deployed relay spawns nothing unless
//! explicitly enabled. **Scaffold, not yet live end to end:** the bot lifecycle here is real —
//! register a warm bot (so `arena_allocate` reserves it exactly like a WS bot) → await `Reserved`
//! then `Opened` on its pool ctrl channel → play → re-register. The PLAY step drives the genuine
//! `fleet_core::play_match` over a [`BusRelayTransport`], but with [`NoopAnchor`] and without the
//! arena flow yet creating a `MatchRecord` (it captures no human relay `ConnRef`), so an enabled
//! bot parks awaiting bus frames. The boss's `SuiAnchor` (real seat-B deposit + settle) plus the
//! `MatchRecord`/human-conn association make it live; this module is where both plug in.

use std::time::Duration;

use tokio::sync::mpsc;
use tunnel_harness::Signer;

use fleet_core::signer_durable::DurableSigner;

use crate::fleet::bus_transport::{BusRelayConnection, BusRelayTransport};
use crate::fleet::{BotHandle, FleetServerMsg};
use crate::state::SharedState;

/// Backoff before a bot re-registers after a match, so a tight failure loop can't spin the pool.
const REQUEUE_BACKOFF: Duration = Duration::from_secs(1);

/// Spawn the co-located fleet if enabled. A no-op when `count == 0` or no games are listed, so the
/// deployed relay stays inert unless explicitly turned on. Each (game × index) is one looping bot.
pub fn spawn(state: SharedState, count: u32, games: &[String]) {
    if count == 0 || games.is_empty() {
        return;
    }
    tracing::info!(count, ?games, "co-located fleet enabled");
    for game in games {
        for idx in 0..count {
            tokio::spawn(run_bot(state.clone(), game.clone(), idx));
        }
    }
}

/// One bot: a stable on-chain identity, looping register → await reservation+open → play →
/// re-register with a fresh per-match key.
async fn run_bot(state: SharedState, game: String, idx: u32) {
    let address = bot_address(&game, idx);
    loop {
        let (bot_id, match_key, mut ctrl_rx) = register_bot(&state, &game, &address);
        if let Some(opened) = await_open(&mut ctrl_rx).await {
            if let Err(e) = play_arena_match(&state, &opened, match_key).await {
                tracing::debug!(%game, match_id = %opened.match_id, "co-located match ended: {e:#}");
            }
        }
        // The registration is consumed (played out, or its ctrl channel closed) — drop it and
        // re-register fresh for the next match.
        state.fleet.unregister(bot_id);
        tokio::time::sleep(REQUEUE_BACKOFF).await;
    }
}

/// The arena identity handed to a reserved bot once the user opens its tunnel.
struct OpenedMatch {
    match_id: String,
    opponent_wallet: String,
    /// The on-chain tunnel the user opened. The `NoopAnchor` scaffold does not consume it (the
    /// generic `play_match` re-derives a tunnel via the anchor); `SuiAnchor` + an arena-aware play
    /// entry will deposit seat B into THIS tunnel instead.
    tunnel_id: String,
}

/// Register one warm bot into the pool with a fresh per-match ephemeral key. Returns the pool id
/// (for `unregister`), the match co-signing key, and the ctrl channel the pool pushes onto.
/// Separated from the run loop so the registration contract is deterministically testable.
fn register_bot(
    state: &SharedState,
    game: &str,
    address: &str,
) -> (u64, DurableSigner, mpsc::UnboundedReceiver<FleetServerMsg>) {
    let match_key = DurableSigner::from_secret(&random_secret());
    let eph_pubkey = hex::encode(match_key.public_key());
    let (ctrl_tx, ctrl_rx) = mpsc::unbounded_channel();
    let bot_id = state.fleet.register(
        game,
        BotHandle {
            eph_pubkey,
            address: address.to_owned(),
            ctrl: ctrl_tx,
        },
    );
    (bot_id, match_key, ctrl_rx)
}

/// Await `Reserved` then `Opened` on the bot's pool ctrl channel. A re-reservation (the prior one
/// TTL-expired back to free) just updates the opponent. `None` if the channel closes first.
async fn await_open(ctrl_rx: &mut mpsc::UnboundedReceiver<FleetServerMsg>) -> Option<OpenedMatch> {
    let mut opponent_wallet = String::new();
    loop {
        match ctrl_rx.recv().await? {
            FleetServerMsg::Reserved {
                opponent_wallet: w, ..
            } => opponent_wallet = w,
            FleetServerMsg::Opened {
                match_id,
                tunnel_id,
            } => {
                return Some(OpenedMatch {
                    match_id,
                    opponent_wallet,
                    tunnel_id,
                })
            }
        }
    }
}

/// Establish the bus seam for one reserved+opened arena match, as seat B (the dealer).
///
/// SCAFFOLD STUB — it does NOT yet play. Two pieces are missing and are the boss's to wire:
///   1. **The play itself** needs `SuiAnchor` (deposit seat B into the user-opened tunnel + settle);
///      `NoopAnchor` can't touch a real tunnel.
///   2. **Routing**: the arena flow creates no `MatchRecord` and captures no human relay `ConnRef`,
///      so nothing routes to this bot's `BusRelayConnection` yet.
///
/// It must also reconcile the open-flow: arena has the HUMAN open (funds seat A) and hands the bot
/// `opened.tunnel_id` via `Opened`, whereas the generic `play_match` (`GameProfile{host:B}`) would
/// have the BOT open — so the real entry threads `opened.tunnel_id` in rather than calling
/// `anchor.open()`. Returning `Ok` here keeps an enabled bot cycling (register → reserve → open →
/// here → re-register) instead of parking forever, so the warm pool never silently drains to empty.
async fn play_arena_match(
    state: &SharedState,
    opened: &OpenedMatch,
    _match_key: DurableSigner, // the per-match co-signing key the real (SuiAnchor) play will sign with
) -> anyhow::Result<()> {
    // Register this bot's relay presence for the match (the transport the real play drives over).
    let conn = BusRelayConnection::register(state.clone());
    let _arena_transport = BusRelayTransport::new(conn, opened.match_id.clone());
    tracing::warn!(
        match_id = %opened.match_id,
        tunnel = %opened.tunnel_id,
        opponent = %opened.opponent_wallet,
        "co-located arena play pending SuiAnchor + MatchRecord wiring; bot not yet serving humans",
    );
    Ok(())
}

/// A bot's stable on-chain address — distinct per (game, idx), the same across its matches (only
/// the per-match co-signing key rotates). Placeholder identity for the scaffold; a real fleet loads
/// funded per-bot accounts from a durable store / KMS.
fn bot_address(game: &str, idx: u32) -> String {
    format!("0x{}", hex::encode(identity_secret(game, idx)))
}

/// Deterministic, distinct-per-(game, idx) identity secret. Placeholder for a durable/KMS key.
fn identity_secret(game: &str, idx: u32) -> [u8; 32] {
    let mut s = [0u8; 32];
    s[..4].copy_from_slice(&idx.to_le_bytes());
    let g = game.as_bytes();
    let n = g.len().min(27);
    s[4..4 + n].copy_from_slice(&g[..n]);
    s[31] = 0xb0; // fleet-bot marker (cosmetic)
    s
}

/// A random 32-byte per-match ephemeral secret, from the already-present `uuid` v4 RNG (two uuids =
/// 32 random bytes) — no extra crypto dependency for a scaffold key.
fn random_secret() -> [u8; 32] {
    let mut s = [0u8; 32];
    s[..16].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    s[16..].copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;

    // The supervisor stays inert unless explicitly enabled: count 0 (the default) registers no bot,
    // so `arena_allocate` finds nothing — the guarantee that a deployed relay does not silently
    // start serving bots.
    #[tokio::test]
    async fn spawn_is_inert_when_count_zero() {
        let state = AppState::in_memory_for_test();
        spawn(state.clone(), 0, &["blackjack".to_owned()]);
        assert!(
            state.fleet.reserve("blackjack", 0).is_none(),
            "count 0 must register no bots"
        );
    }

    // A registered co-located bot is allocatable exactly like a WS fleet bot: `reserve` returns its
    // party-B identity (stable address + a per-match ephemeral pubkey), and a pool `notify` reaches
    // the bot's ctrl channel. This is the contract `arena_allocate`/`arena_opened` depend on.
    #[tokio::test]
    async fn registered_bot_is_reservable_and_reachable() {
        let state = AppState::in_memory_for_test();
        let address = bot_address("blackjack", 0);
        let (_bot_id, _key, mut ctrl_rx) = register_bot(&state, "blackjack", &address);

        let r = state
            .fleet
            .reserve("blackjack", 0)
            .expect("the registered bot is reservable");
        assert_eq!(r.address, address, "reservation carries the bot's address");
        assert!(
            !r.eph_pubkey.is_empty(),
            "and its per-match ephemeral pubkey"
        );

        assert!(state.fleet.notify(
            &r.match_id,
            FleetServerMsg::Reserved {
                match_id: r.match_id.clone(),
                opponent_wallet: "0xuser".into(),
            },
        ));
        assert!(
            matches!(ctrl_rx.try_recv(), Ok(FleetServerMsg::Reserved { .. })),
            "notify reaches the co-located bot's ctrl channel"
        );
    }

    // `await_open` is the bot's lifecycle state machine: it ignores (records) `Reserved` and
    // returns the match identity on `Opened`. Re-reservation (a prior TTL-expired hold) must just
    // refresh the opponent, not lose the eventual open.
    #[tokio::test]
    async fn await_open_returns_match_on_opened_after_rereservation() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        tx.send(FleetServerMsg::Reserved {
            match_id: "m1".into(),
            opponent_wallet: "0xfirst".into(),
        })
        .unwrap();
        tx.send(FleetServerMsg::Reserved {
            match_id: "m1".into(),
            opponent_wallet: "0xsecond".into(),
        })
        .unwrap();
        tx.send(FleetServerMsg::Opened {
            match_id: "m1".into(),
            tunnel_id: "0xtunnel".into(),
        })
        .unwrap();

        let opened = await_open(&mut rx).await.expect("resolves on Opened");
        assert_eq!(opened.match_id, "m1");
        assert_eq!(
            opened.opponent_wallet, "0xsecond",
            "latest reservation's opponent wins"
        );
        assert_eq!(opened.tunnel_id, "0xtunnel");
    }

    // The placeholder identity must be stable per bot and distinct across bots, so two bots never
    // collide on the same on-chain address.
    #[test]
    fn bot_address_is_stable_and_distinct() {
        assert_eq!(bot_address("blackjack", 0), bot_address("blackjack", 0));
        assert_ne!(bot_address("blackjack", 0), bot_address("blackjack", 1));
        assert_ne!(bot_address("blackjack", 0), bot_address("caro", 0));
    }
}
