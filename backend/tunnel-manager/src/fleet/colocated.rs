//! Co-located fleet supervisor (ADR-0024): in-process bots that register into the [`crate::fleet`]
//! `BotPool` and play arena matches over the relay bus, instead of holding a `/v1/fleet` WebSocket.
//! Removing the per-bot socket is the capacity swap at 5000 CCU.
//!
//! **Inert by default** (`FLEET_COLOCATED_COUNT=0`) — the deployed relay spawns nothing unless
//! explicitly enabled. Each bot loops: register a warm bot (so `arena_allocate` reserves it exactly
//! like a WS bot) → await `Reserved` then `Opened` on its pool ctrl channel → [`play_arena_match`]
//! (bind to the [`crate::fleet::arena_rendezvous`], wait for the human to join, then drive
//! `fleet_core::play_blackjack` over a [`BusRelayTransport`] with the
//! [`crate::fleet::arena_anchor::RelayBridgedAnchor`] to settlement) → re-register.
//!
//! The remaining on-chain dependency is the funded bot account pool: [`bot_address`] is a
//! deterministic placeholder until a durable/KMS key store lands, and the real seat-B funding lives
//! in the [`crate::fleet::arena_opener`] (still `Noop` by default). The off-chain spine — routing,
//! co-signed play, settle-half emission — is complete here.

use std::time::Duration;

use anyhow::bail;
use tokio::sync::mpsc;
use tunnel_harness::{InMemoryTranscriptRecorder, Signer};

use fleet_core::match_channel::MatchChannel;
use fleet_core::play_match::{play_blackjack, play_quantum_poker};
use fleet_core::signer_durable::DurableSigner;
use fleet_core::Role;

use crate::fleet::arena_anchor::RelayBridgedAnchor;
use crate::fleet::bus_transport::{BusRelayConnection, BusRelayTransport};
use crate::fleet::{BotHandle, FleetServerMsg};
use crate::state::SharedState;

/// Backoff before a bot re-registers after a match, so a tight failure loop can't spin the pool.
const REQUEUE_BACKOFF: Duration = Duration::from_secs(1);

/// How long the bot waits for the user's browser to connect + `arena.join` after the tunnel opens,
/// before giving up and re-registering. Generous: the user may sign the open then take a moment to
/// land on the relay. The pool TTL is the backstop for a user who never opens at all.
const ARENA_JOIN_TIMEOUT: Duration = Duration::from_secs(60);

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
            if let Err(e) = play_arena_match(&state, &game, &opened, match_key).await {
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
    /// The on-chain tunnel the fleet pre-created + funded seat B for at allocate (ADR-0025). The
    /// [`RelayBridgedAnchor`] resolves THIS id in `open()` (no chain call) and settles against it.
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

/// Play one reserved+opened arena match to settlement as party B (the dealer), over the relay bus.
///
/// Sequence: register a virtual relay connection → bind it to the match and wait until the human
/// also joins (so routing is live before our first frame, or the hello is dropped and the handshake
/// deadlocks) → drive the merged `PartyDriver` over a [`BusRelayTransport`], with the
/// [`RelayBridgedAnchor`] resolving the pre-created tunnel and emitting our settle half. The human FE
/// pairs both halves and submits the cooperative close (`POST /settle`).
///
/// The connection + transport + anchor are game-agnostic; only the protocol+strategy differ, so the
/// final step dispatches on `game` ([`play_game`]). `InMemoryTranscriptRecorder` is required (not
/// `Null`): the anchor settles v2 (`close_cooperative_with_root`), so the driver needs the transcript
/// to compute the root the FE also signs. Any error re-registers the bot, so a failed match never
/// drains the warm pool.
async fn play_arena_match(
    state: &SharedState,
    game: &str,
    opened: &OpenedMatch,
    match_key: DurableSigner,
) -> anyhow::Result<()> {
    let conn = BusRelayConnection::register(state.clone());
    let ready = state
        .arena
        .bind_bot(state, &opened.match_id, conn.conn_ref())
        .await;
    match tokio::time::timeout(ARENA_JOIN_TIMEOUT, ready).await {
        Ok(Ok(())) => {} // user joined; the MatchRecord is live, routing works
        Ok(Err(_)) => bail!(
            "arena match {} vanished before the user joined",
            opened.match_id
        ),
        Err(_) => {
            state.arena.forget(&opened.match_id);
            bail!("user did not join arena match {} in time", opened.match_id);
        }
    }

    let transport = BusRelayTransport::new(conn.clone(), opened.match_id.clone());
    let channel = MatchChannel::new(transport);
    let anchor = RelayBridgedAnchor::new(opened.tunnel_id.clone(), conn, opened.match_id.clone());
    let moves = play_game(game, channel, anchor, match_key, &opened.opponent_wallet).await?;
    tracing::info!(
        match_id = %opened.match_id,
        game = %game,
        tunnel = %opened.tunnel_id,
        moves,
        "co-located arena match settled",
    );
    Ok(())
}

/// Drive the bot (party B) through one match of `game` over `channel`, settling via `anchor`. The
/// transport/anchor are game-agnostic; this is the one place protocol+strategy are chosen, so adding
/// a game is a single arm here — once its Rust protocol byte-matches the FE's TS protocol (verified
/// by a cross-language golden test) and it has a `MoveStrategy`. Returns the move count.
async fn play_game(
    game: &str,
    channel: MatchChannel<BusRelayTransport>,
    anchor: RelayBridgedAnchor,
    match_key: DurableSigner,
    opponent_wallet: &str,
) -> anyhow::Result<u64> {
    let outcome = match game {
        "blackjack" => {
            play_blackjack(
                channel,
                anchor,
                match_key,
                Role::B,
                opponent_wallet,
                InMemoryTranscriptRecorder::new(),
            )
            .await?
        }
        "quantum_poker" => {
            play_quantum_poker(
                channel,
                anchor,
                match_key,
                Role::B,
                opponent_wallet,
                InMemoryTranscriptRecorder::new(),
            )
            .await?
        }
        other => bail!("co-located fleet has no protocol wired for game '{other}'"),
    };
    Ok(outcome.moves)
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

    // The whole co-located arena seam, end to end over the REAL relay bus: the supervisor's
    // `play_arena_match` (party B) plays a full co-signed blackjack match to settlement against a
    // stand-in human (party A) that joins by match id. This exercises the rendezvous (bot binds and
    // parks; the human's `arena.join` completes the MatchRecord and wakes the bot), bidirectional
    // `relay_to_other` routing, the merged `PartyDriver` move loop, and BOTH seats' relay-bridged
    // anchors emitting their settle half. Both sides returning a settled outcome proves the seam
    // carries a genuine two-party match without a WebSocket — the on-chain open/funding is the only
    // remaining dependency. A regression in the join, routing, or settle wiring deadlocks or errors
    // here. (Settle-half PAIRING is covered by `bus_transport::full_match_completes_over_the_bus`
    // and the byte-exact emit by `arena_anchor::settle_emits_the_co_signed_half_to_the_peer`.)
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn play_arena_match_settles_against_a_stand_in_human() {
        use fleet_core::play_match::{play_blackjack, BLACKJACK};

        // A valid-hex tunnel id (the co-signed move loop serializes it as a 32-byte address).
        const TUNNEL_ID: &str = "0xdead";
        let state = AppState::in_memory_for_test();
        let match_id = "arena-e2e";
        let bot_addr = bot_address("blackjack", 0);
        state
            .arena
            .seed(match_id, "blackjack", "0xuser", &bot_addr, TUNNEL_ID);

        // Bot side: the real supervisor entry. It registers its bus conn, binds + parks on the
        // rendezvous, then plays once the human joins.
        let bot_state = state.clone();
        let bot = tokio::spawn(async move {
            let opened = OpenedMatch {
                match_id: match_id.to_owned(),
                opponent_wallet: "0xuser".to_owned(),
                tunnel_id: TUNNEL_ID.to_owned(),
            };
            let bot_key = DurableSigner::from_secret(&[7u8; 32]);
            play_arena_match(&bot_state, "blackjack", &opened, bot_key).await
        });

        // Human side: register, join by match id, then wait for MatchFound so routing is live before
        // driving the match (the same ordering the FE follows).
        let human_conn = BusRelayConnection::register(state.clone());
        assert!(
            state
                .arena
                .bind_user(&state, match_id, human_conn.conn_ref(), "0xuser")
                .await,
            "the allocating user joins its arena match"
        );
        // Wait for `match.found` (delivered first, before the bot's hello) so routing is live before
        // we drive — the same ordering the FE follows. It is the first frame, so we never drain past
        // it into the bot's buffered hello.
        let first = human_conn
            .recv_for_test()
            .await
            .expect("human receives a frame");
        assert!(
            first.contains("match.found"),
            "first inbound frame must be the match announcement, got: {first}"
        );

        let human_transport = BusRelayTransport::new(human_conn.clone(), match_id.to_owned());
        let human_channel = MatchChannel::new(human_transport);
        let human_anchor =
            RelayBridgedAnchor::new(TUNNEL_ID.to_owned(), human_conn, match_id.to_owned());
        let human = play_blackjack(
            human_channel,
            human_anchor,
            DurableSigner::from_secret(&[42u8; 32]),
            Role::A,
            &bot_addr,
            InMemoryTranscriptRecorder::new(),
        );

        let (bot_res, human_res) = tokio::join!(bot, human);
        bot_res
            .expect("bot task did not panic")
            .expect("bot (party B) plays to settlement over the bus");
        let human_outcome = human_res.expect("human (party A) plays to settlement over the bus");
        assert!(human_outcome.moves > 0, "the match actually progressed");
        assert_eq!(
            human_outcome.final_balances.sum(),
            2 * BLACKJACK.stake_each,
            "stakes are conserved across the genuine two-party match",
        );
    }
}
