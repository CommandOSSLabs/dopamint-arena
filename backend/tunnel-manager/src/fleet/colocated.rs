//! Co-located fleet supervisor (ADR-0024): in-process bots that register into the [`crate::fleet`]
//! `BotPool` and play arena matches over the relay bus, instead of holding a `/v1/fleet` WebSocket.
//! Removing the per-bot socket is the capacity swap at 5000 CCU.
//!
//! **Inert by default** (`FLEET_COLOCATED_COUNT=0`) — the deployed relay spawns nothing unless
//! explicitly enabled. Bots are spawned **purely on demand** by `arena_allocate` via
//! [`reserve_or_spawn`]: a co-located bot is spawned per allocated seat, up to the per-game cap.
//! Each bot is one-shot: await `Opened` → [`play_arena_match`] (bind to the
//! [`crate::fleet::arena_rendezvous`], wait for the human to join, then drive the game over a
//! [`BusRelayTransport`] with the [`crate::fleet::arena_anchor::RelayBridgedAnchor`] to settlement) →
//! unregister (freeing its in-flight slot).
//!
//! The remaining on-chain dependency is seat-B funding: when the wallet pool is configured, a bot
//! draws a funded address from it ([`reserve_or_spawn`]) and the [`crate::fleet::arena_opener`]
//! `SuiArenaOpener` creates + funds seat B; unconfigured, [`bot_address`] is a deterministic
//! placeholder and the opener is `Noop` (the dev/test default). The off-chain spine — routing,
//! co-signed play, settle-half emission — is complete here.

use std::sync::Arc;
use std::time::Duration;

use anyhow::bail;
use tokio::sync::mpsc;
use transcript_store::TranscriptChunkWriter;
use tunnel_harness::Signer;

use crate::fleet::transcript_upload::{ChunkUpload, S3StreamingRecorder};

use fleet_core::match_channel::MatchChannel;
use fleet_core::play_match::{
    play_battleship, play_blackjack_v2, play_bomb_it, play_caro, play_chicken_cross,
    play_quantum_poker, play_tic_tac_toe, play_world_canvas,
};
use fleet_core::signer_durable::DurableSigner;
use fleet_core::Role;

use crate::fleet::arena_anchor::RelayBridgedAnchor;
use crate::fleet::bus_transport::{BusRelayConnection, BusRelayTransport};
use crate::fleet::{BotHandle, FleetServerMsg};
use crate::state::SharedState;

/// How long the bot waits for the user's browser to connect + `arena.join` after the tunnel opens,
/// before giving up. Generous: the user may sign the open then take a moment to land on the relay.
/// The pool TTL is the backstop for a user who never opens at all.
const ARENA_JOIN_TIMEOUT: Duration = Duration::from_secs(60);

/// Per-spawn sequence for distinct on-demand bot identities — a fixed index would make every
/// concurrent match of a game share one seat-B address. The fallback when no wallet pool is
/// configured; with a pool, the checked-out address is used instead.
static ONDEMAND_SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// On-demand seat-fill: spawn a bot for `game` and reserve it, if the per-game in-flight count is
/// below `cap`. `arena_allocate` calls this so seat-fill scales with real demand, not a pre-spawned
/// pool. Returns `None` when `cap` concurrent matches are already in flight (the admission ceiling —
/// wallets aren't the limiter at a 1M pool, so the in-flight count is). `cap == 0` spawns nothing
/// (inert-by-default).
pub async fn reserve_or_spawn(
    state: &SharedState,
    game: &str,
    now_ms: u64,
    cap: u32,
) -> Option<crate::fleet::Reservation> {
    // Pure on-demand: build the bot's handle and atomically reserve it under the cap (cap 0 ⇒ always
    // None, the inert default). The bot's `ctrl` lands in the pool, so the allocate handler's
    // `notify(Reserved/Opened)` reaches it; its lifecycle runs in a one-shot task.
    let match_key = DurableSigner::from_secret(&random_secret());
    let (ctrl_tx, ctrl_rx) = mpsc::unbounded_channel();
    // Seat-B on-chain identity: a real funded address checked out of the wallet pool (PR #124) when
    // configured, else a distinct deterministic placeholder (a fixed index would collide across
    // concurrent matches). A checkout error is non-fatal — fall back to the placeholder.
    let address = match state.wallet_pool.as_ref().map(|p| p.checkout_address()) {
        Some(Ok(addr)) => addr,
        Some(Err(e)) => {
            tracing::warn!("wallet pool checkout failed, using placeholder: {e:#}");
            bot_address(
                game,
                ONDEMAND_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
            )
        }
        None => bot_address(
            game,
            ONDEMAND_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        ),
    };
    let bot = BotHandle {
        eph_pubkey: hex::encode(match_key.public_key()),
        address,
        ctrl: ctrl_tx,
    };
    let (reservation, bot_id) = state.fleet.reserve_under_cap(game, cap, now_ms, bot)?;
    tokio::spawn(run_on_demand(
        state.clone(),
        game.to_owned(),
        ctrl_rx,
        match_key,
        bot_id,
    ));
    Some(reservation)
}

/// One on-demand bot: it's already registered + reserved, so it just awaits the user's `Opened`,
/// plays the match, and unregisters. It does not loop — on-demand spawns one bot per seat, so the
/// task ends with the match, freeing its in-flight slot.
async fn run_on_demand(
    state: SharedState,
    game: String,
    mut ctrl_rx: mpsc::UnboundedReceiver<FleetServerMsg>,
    match_key: DurableSigner,
    bot_id: u64,
) {
    if let Some(opened) = await_open(&mut ctrl_rx).await {
        if let Err(e) = play_arena_match(&state, &game, &opened, match_key).await {
            tracing::debug!(%game, match_id = %opened.match_id, "on-demand match ended: {e:#}");
        }
    }
    state.fleet.unregister(bot_id);
}

/// The arena identity handed to a reserved bot once the user opens its tunnel.
struct OpenedMatch {
    match_id: String,
    opponent_wallet: String,
    /// The on-chain tunnel the fleet pre-created + funded seat B for at allocate (ADR-0025). The
    /// [`RelayBridgedAnchor`] resolves THIS id in `open()` (no chain call) and settles against it.
    tunnel_id: String,
}

/// Test-only: register a bot directly into the pool with a fresh per-match ephemeral key, to pin the
/// `reserve`/`notify` contract that on-demand seat-fill also relies on. Returns the pool id, the match
/// co-signing key, and the ctrl receiver.
#[cfg(test)]
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
/// final step dispatches on `game` ([`play_game`]). `StreamingRootRecorder` is required (not
/// `Null`): the anchor settles v2 (`close_cooperative_with_root`), so the driver needs a transcript
/// root the FE also signs — it computes that root incrementally (O(log N)) without retaining the
/// entries. On any error the caller ([`run_on_demand`]) unregisters the bot, freeing its slot.
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

    tracing::info!(match_id = %opened.match_id, game = %game, "arena: user joined; bot driving co-signed play");
    let transport = BusRelayTransport::new(conn.clone(), opened.match_id.clone());
    let channel = MatchChannel::new(transport);
    // The bot signs its settlement half with `timestamp = created_at` (matching the FE half, which
    // reads the same on-chain field), so resolve it before play. Fail the match if unreadable — a bot
    // that can't sign a combinable half would only produce a settle the FE rejects.
    let created_at_ms = state
        .arena_opener
        .read_created_at_ms(&opened.tunnel_id)
        .await?;
    let anchor = RelayBridgedAnchor::new(
        opened.tunnel_id.clone(),
        conn,
        opened.match_id.clone(),
        created_at_ms,
    );
    let moves = match play_game(
        game,
        channel,
        anchor,
        match_key,
        &opened.opponent_wallet,
        opened.tunnel_id.clone(),
        state.chunk_upload_tx.clone(),
        state.chunk_writer.clone(),
    )
    .await
    {
        Ok(m) => m,
        Err(e) => {
            tracing::warn!(match_id = %opened.match_id, game = %game, "arena: bot play errored: {e:#}");
            return Err(e);
        }
    };
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
    tunnel_id: String,
    chunk_upload_tx: Option<mpsc::Sender<ChunkUpload>>,
    chunk_writer: Option<Arc<dyn TranscriptChunkWriter>>,
) -> anyhow::Result<u64> {
    // Every game drives the identical party-B seam (Role::B + a fresh transcript recorder); only the
    // protocol's `play_*` entry differs, so each game is one arm. The recorder folds the v2 root
    // incrementally (bounded RAM) AND streams the co-signed transcript to S3 in chunks during play
    // through the shared bounded uploader (`chunk_upload_tx`); `finish()` flushes the tail + seals
    // the manifest via `chunk_writer`. A clone drives the game while this handle is retained to
    // finish. Both `None` (dev/test) → root only, no S3.
    let recorder = S3StreamingRecorder::new(tunnel_id.clone(), chunk_upload_tx, chunk_writer);
    macro_rules! play {
        ($play_fn:ident) => {
            $play_fn(
                channel,
                anchor,
                match_key,
                Role::B,
                opponent_wallet,
                recorder.clone(),
            )
            .await?
        };
    }
    let outcome = match game {
        "blackjack" => play!(play_blackjack_v2),
        "quantum_poker" => play!(play_quantum_poker),
        "bomb_it" => play!(play_bomb_it),
        "chicken_cross" => play!(play_chicken_cross),
        "world_canvas" => play!(play_world_canvas),
        "tic_tac_toe" => play!(play_tic_tac_toe),
        "caro" => play!(play_caro),
        "battleship" => play!(play_battleship),
        other => bail!("co-located fleet has no protocol wired for game '{other}'"),
    };
    recorder.finish().await;
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
    // The stand-in "human" side of the settle test drives with a buffering recorder; the bot side
    // under test uses `StreamingRootRecorder`, and the two roots must match.
    use tunnel_harness::InMemoryTranscriptRecorder;

    // Inert by default: with `cap == 0` (the `FLEET_COLOCATED_COUNT=0` default) and no warm bot,
    // reserve_or_spawn spawns nothing — the guarantee that a deployed relay does not silently start
    // serving bots. The on-demand equivalent of the old static-pool "count 0 registers no bots".
    #[tokio::test]
    async fn reserve_or_spawn_is_inert_at_cap_zero() {
        let state = AppState::in_memory_for_test();
        assert!(
            reserve_or_spawn(&state, "blackjack", 0, 0).await.is_none(),
            "cap 0 must spawn no bot"
        );
        assert!(
            state.fleet.reserve("blackjack", 0).is_none(),
            "and register nothing in the pool"
        );
    }

    // On-demand seat-fill: with free capacity and NO warm bot pre-registered, `reserve_or_spawn`
    // spawns a bot, registers it, and returns a usable reservation. Seat-fill depends on the per-game
    // cap (the concurrency ceiling), not on a pre-spawned warm pool — at a 1M-wallet pool, wallets
    // aren't the limiter, so the in-flight count is what bounds admission.
    #[tokio::test]
    async fn reserve_or_spawn_fills_a_seat_on_demand() {
        let state = AppState::in_memory_for_test();
        let r = reserve_or_spawn(&state, "blackjack", 0, 2)
            .await
            .expect("free capacity fills a seat with no warm bot");
        assert!(!r.address.is_empty(), "reservation carries a bot address");
        assert!(!r.eph_pubkey.is_empty(), "and a per-match ephemeral pubkey");
        // The spawned bot wired its ctrl channel into the pool: a Reserved notify reaches it.
        assert!(
            state.fleet.notify(
                &r.match_id,
                FleetServerMsg::Reserved {
                    match_id: r.match_id.clone(),
                    opponent_wallet: "0xuser".into(),
                },
            ),
            "the on-demand bot is reachable for Reserved/Opened",
        );
    }

    // Each on-demand spawn gets a DISTINCT identity: two concurrent bots for the same game must not
    // share a seat-B address. A fixed index would collide (the bug a per-spawn sequence fixes); the
    // wallet pool's `get_member_key(Ordinal)` replaces this placeholder later.
    #[tokio::test]
    async fn reserve_or_spawn_gives_each_bot_a_distinct_identity() {
        let state = AppState::in_memory_for_test();
        let a = reserve_or_spawn(&state, "blackjack", 0, 2)
            .await
            .expect("first");
        let b = reserve_or_spawn(&state, "blackjack", 0, 2)
            .await
            .expect("second within cap");
        assert_ne!(
            a.address, b.address,
            "concurrent on-demand bots must have distinct addresses"
        );
    }

    // Admission is bounded by the per-game cap: once `cap` bots are in flight, the next call gets
    // nothing until one finishes. This is the ceiling that replaces static pool depth — the limiter
    // is the in-flight count, not the (1M) wallet pool.
    #[tokio::test]
    async fn reserve_or_spawn_is_bounded_by_the_cap() {
        let state = AppState::in_memory_for_test();
        assert!(
            reserve_or_spawn(&state, "blackjack", 0, 1).await.is_some(),
            "first reservation is within cap=1"
        );
        assert!(
            reserve_or_spawn(&state, "blackjack", 0, 1).await.is_none(),
            "second exceeds cap=1 — admission is bounded"
        );
    }

    // The cap is per game: a second game's seat-fill is unaffected by the first game being at cap.
    #[tokio::test]
    async fn reserve_or_spawn_cap_is_per_game() {
        let state = AppState::in_memory_for_test();
        assert!(reserve_or_spawn(&state, "blackjack", 0, 1).await.is_some());
        assert!(
            reserve_or_spawn(&state, "blackjack", 0, 1).await.is_none(),
            "blackjack is at cap"
        );
        assert!(
            reserve_or_spawn(&state, "quantum_poker", 0, 1)
                .await
                .is_some(),
            "a different game has its own cap"
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
        use fleet_core::play_match::{play_blackjack_v2, BLACKJACK};

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
        // createdAt `0` matches the bot side: `play_arena_match` here resolves it via the
        // `NoopArenaOpener` (in-memory state), which returns 0 — so both seats sign `timestamp = 0`.
        let human_anchor =
            RelayBridgedAnchor::new(TUNNEL_ID.to_owned(), human_conn, match_id.to_owned(), 0);
        let human = play_blackjack_v2(
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
