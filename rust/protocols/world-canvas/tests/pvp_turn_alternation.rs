//! World-canvas is a FREE co-draw: `apply_move` accepts either seat and folds both into one shared
//! rolling digest, and an idle `{cells:[]}` move leaves the co-signed state byte-identical (only the
//! nonce advances). So the bot cannot derive whose turn it is from state — and the tunnel seat rejects
//! a cross-propose (`expected ack, got move`). This test pins the fix: with the protocol pinning turns
//! by nonce parity (byte-identical to the FE engine's `turn(nonce)`), two seats ALTERNATE and co-sign a
//! bounded match to a clean settle. Before the fix (always-`Some` strategy, no turn pin) both seats
//! propose nonce 1 at once and abort — this test fails RED. It is the driver-level analogue of the live
//! "human draws while the bot is mid-propose → match dies" bug.

use tunnel_core::crypto::keypair_from_secret;
use tunnel_harness::{
    Balances, DriverRunControl, InMemoryAnchor, InMemoryFrameTransport, LocalSigner, MoveStrategy,
    MoveStrategyContext, NullTranscriptRecorder, PartyDriver, Seat, SeatParts,
};
use tunnel_world_canvas::{
    StrokeCanvasState, StrokePaintMove, WorldCanvasStroke, WorldCanvasStrokeStrategy,
};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn two_seats_alternate_and_cosign_a_bounded_co_draw_without_cross_propose_abort() {
    let sa: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
    let sb: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
    let pk_a = keypair_from_secret(&sa).public_key();
    let pk_b = keypair_from_secret(&sb).public_key();

    let (ch_a, ch_b) = InMemoryFrameTransport::pair();
    let anchor = InMemoryAnchor::new();
    // A hard move cap: world-canvas is never terminal (100k updates), so the run needs a bound to end.
    let run_control = DriverRunControl::with_move_limit(6);

    let driver_a = PartyDriver::new(
        SeatParts {
            protocol: WorldCanvasStroke,
            signer: LocalSigner::from_secret(&sa),
            opponent_pk: pk_b,
            initial: Balances { a: 1, b: 1 },
            seat: Seat::A,
        },
        WorldCanvasStrokeStrategy::new(0xa11ce),
        ch_a,
        anchor.clone(),
        NullTranscriptRecorder,
    )
    .with_run_control(run_control.clone());
    let driver_b = PartyDriver::new(
        SeatParts {
            protocol: WorldCanvasStroke,
            signer: LocalSigner::from_secret(&sb),
            opponent_pk: pk_a,
            initial: Balances { a: 1, b: 1 },
            seat: Seat::B,
        },
        WorldCanvasStrokeStrategy::new(0xb0b),
        ch_b,
        anchor,
        NullTranscriptRecorder,
    )
    .with_run_control(run_control.clone());

    let (ra, rb) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        tokio::join!(driver_a.run(100, || 1), driver_b.run(100, || 1))
    })
    .await
    .expect("turn-pinned seats settle quickly; the un-pinned bug aborts (or hangs) instead");

    let (out_a, _) =
        ra.expect("seat A co-signs the alternating co-draw and settles (no cross-propose)");
    let (out_b, _) =
        rb.expect("seat B co-signs the alternating co-draw and settles (no cross-propose)");

    // Both seats actually painted — the loop alternated, it did not stall on one side.
    assert!(
        out_a.moves > 0 && out_b.moves > 0,
        "both seats advanced the co-signed canvas"
    );
    assert_eq!(
        out_a.moves, out_b.moves,
        "both seats committed the same move count"
    );
    // Free/draw: stakes never move and both agree on the settled balances (the shared anchor paired them).
    assert_eq!(
        out_a.final_balances, out_b.final_balances,
        "seats agree on the settled outcome"
    );
    assert_eq!(out_a.final_balances.sum(), 2, "stakes conserved (1 + 1)");
}

/// Seat A stand-in for the human/FE: on its turn it always co-signs an empty run `{cells:[]}` — the
/// exact idle tick `pvpMatchHook` emits when the human isn't drawing (usePvpWorldCanvas `IDLE_INTENT`).
struct AlwaysIdle;

impl MoveStrategy<WorldCanvasStroke> for AlwaysIdle {
    async fn plan_move(
        &mut self,
        _state: &StrokeCanvasState,
        _seat: Seat,
        _ctx: &MoveStrategyContext,
    ) -> Option<StrokePaintMove> {
        Some(StrokePaintMove { cells: Vec::new() })
    }
}

/// The LIVE arena shape: the human/FE (seat A) is idle and only emits empty `{cells:[]}` ticks on its
/// turn, while the bot (seat B) draws. The turn pin makes the bot WAIT (receiver mode) on A's turns
/// rather than cross-propose — so this proves the fix did NOT trade a "collision abort" for a
/// "bot stalls waiting on a silent peer": the bot keeps getting its turns as long as A idle-ticks, and
/// the empty no-op move round-trips through propose/ACK/digest (state byte-identical, only the nonce
/// advances). If the bot stalled, the move cap is never reached and the 5s timeout fires.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bot_keeps_its_turns_while_an_idle_peer_only_ticks_empty_runs() {
    let sa: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
    let sb: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
    let pk_a = keypair_from_secret(&sa).public_key();
    let pk_b = keypair_from_secret(&sb).public_key();

    let (ch_a, ch_b) = InMemoryFrameTransport::pair();
    let anchor = InMemoryAnchor::new();
    let run_control = DriverRunControl::with_move_limit(6);

    let driver_a = PartyDriver::new(
        SeatParts {
            protocol: WorldCanvasStroke,
            signer: LocalSigner::from_secret(&sa),
            opponent_pk: pk_b,
            initial: Balances { a: 1, b: 1 },
            seat: Seat::A,
        },
        AlwaysIdle,
        ch_a,
        anchor.clone(),
        NullTranscriptRecorder,
    )
    .with_run_control(run_control.clone());
    let driver_b = PartyDriver::new(
        SeatParts {
            protocol: WorldCanvasStroke,
            signer: LocalSigner::from_secret(&sb),
            opponent_pk: pk_a,
            initial: Balances { a: 1, b: 1 },
            seat: Seat::B,
        },
        WorldCanvasStrokeStrategy::new(0xb0b),
        ch_b,
        anchor,
        NullTranscriptRecorder,
    )
    .with_run_control(run_control.clone());

    let (ra, rb) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        tokio::join!(driver_a.run(100, || 1), driver_b.run(100, || 1))
    })
    .await
    .expect("the bot must not stall waiting on the idle peer; it keeps getting its turns");

    let (out_a, _) = ra.expect("idle seat A co-signs empty ticks and settles");
    let (out_b, _) = rb.expect("drawing seat B keeps its turns against an idle peer and settles");
    assert_eq!(
        out_a.moves, out_b.moves,
        "both seats committed the same move count"
    );
    assert!(
        out_b.moves > 0,
        "the bot advanced across the idle peer's ticks"
    );
    assert_eq!(
        out_a.final_balances.sum(),
        2,
        "stakes conserved through empty co-signed ticks"
    );
}
