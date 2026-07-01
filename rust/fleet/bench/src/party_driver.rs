//! Async per-tunnel runner: two `PartyDriver`s joined over `InMemoryFrameTransport::pair()`,
//! instrumented with the telemetry wrappers. The hand-rolled `deliver`/`block_ready` sync pump is
//! gone; the production engine path drives both seats. Both move count and frame bytes are
//! golden-stable for blackjack.bet.v1 with the default seed (143 moves, 75_982 bytes/tunnel).

use crate::cli::{AnchorMode, SuiSponsoredAnchorOpts};
use std::sync::Arc;
use std::time::Instant;
use sui_tunnel_anchor::{
    AnchorCostSnapshot, SuiOpenIntentAnchor, SuiOpenIntentId, SuiSponsoredAnchor,
    SuiSponsoredAnchorConfig,
};
use tunnel_blackjack::v2::{BlackjackV2, BlackjackV2Move, BlackjackV2Strategy};
use tunnel_blackjack::{BjMove, BjState, Blackjack, BlackjackStrategy};
use tunnel_harness::instrument::{InstrumentedAnchor, InstrumentedRecorder, InstrumentedTransport};
use tunnel_harness::{
    Balances, FrameCodec, InMemoryAnchor, InMemoryFrameTransport, InMemoryTranscriptRecorder,
    LocalSigner, MoveStrategy, MoveStrategyContext, NullTranscriptRecorder, OpenedTunnel,
    PartyDriver, Protocol, Seat, SeatParts, SettledTunnel, SettlementMode, Signer, Transcript,
    TranscriptEntry, TranscriptError, TranscriptRecorder, TunnelAnchor, TunnelAnchorError,
    TunnelOpenRequest, TunnelSettleRequest,
};
use tunnel_telemetry::{CollectingSink, StageId, TelemetrySink};

pub(crate) const CREATED_AT: u64 = 1_234_567_890;

#[derive(Clone)]
pub struct SuiSponsoredBenchContext {
    anchor: Arc<SuiSponsoredAnchor>,
}

impl SuiSponsoredBenchContext {
    #[cfg(test)]
    fn from_anchor_for_test(anchor: SuiSponsoredAnchor) -> Self {
        Self {
            anchor: Arc::new(anchor),
        }
    }

    pub(crate) fn cost_snapshot(&self) -> AnchorCostSnapshot {
        self.anchor.cost_snapshot()
    }
}

pub fn build_sui_sponsored_bench_context(
    opts: Option<&SuiSponsoredAnchorOpts>,
) -> Result<SuiSponsoredBenchContext, String> {
    let opts = opts.ok_or_else(|| "missing sponsored Sui anchor config".to_string())?;
    let anchor = SuiSponsoredAnchor::new(SuiSponsoredAnchorConfig {
        rpc_url: opts.rpc_url.clone(),
        backend_url: opts.backend_url.clone(),
        package_id: opts.package_id.clone(),
        tunnel_coin_type: opts.tunnel_coin_type.clone(),
        open_mode: opts.open_mode,
        settle_mode: opts.settle_mode,
        funding_profile: opts.funding_profile.clone(),
        open_batching: opts.open_batching.clone(),
        settle_batching: opts.settle_batching.clone(),
    })
    .map_err(|err| format!("sponsored Sui anchor config: {err:?}"))?;
    Ok(SuiSponsoredBenchContext {
        anchor: Arc::new(anchor),
    })
}

fn sui_sponsored_anchor_for_tunnel(
    sui_context: Option<&SuiSponsoredBenchContext>,
) -> &Arc<SuiSponsoredAnchor> {
    &sui_context
        .expect("sponsored Sui anchor mode requires run-level Sui bench context")
        .anchor
}

fn scoped_sui_anchor_for_tunnel(
    sui_context: Option<&SuiSponsoredBenchContext>,
    tunnel_id: &str,
) -> SuiOpenIntentAnchor {
    sui_sponsored_anchor_for_tunnel(sui_context)
        .for_open_intent(SuiOpenIntentId::from_label(tunnel_id))
}

/// Outcome of one completed tunnel (both seats joined).
pub struct TunnelOutcome {
    /// Total committed moves as seen by seat A (equals total tunnel moves).
    pub moves: u64,
    /// Sum of bytes sent by both seats over the frame transport.
    pub bytes: u64,
    /// End-to-end wall time of the joined drivers — open + move loop + settle —
    /// from transport-pair creation to both drivers completing, nanoseconds.
    pub e2e_ns: u128,
    /// Seat A's move-loop wall time alone, nanoseconds — excludes anchor
    /// open/settle. This is gameplay latency; `e2e_ns - play_ns` is chain/setup.
    pub play_ns: u128,
    pub final_balances: Balances,
    /// True if the anchor registered at least one open call.
    pub open_ok: bool,
    /// True if the anchor registered at least one settle call.
    pub settle_ok: bool,
    /// Merged telemetry samples from anchor + both transports + both recorders.
    pub sink: CollectingSink,
    /// Serialized transcript bytes (0 for now; wired in D4).
    pub export_bytes: u64,
}

/// Pre-built signer material for both seats.
#[derive(Clone)]
pub struct SeatKit {
    signer_a: LocalSigner,
    signer_b: LocalSigner,
    pub pk_a: [u8; 32],
    pub pk_b: [u8; 32],
}

impl SeatKit {
    pub fn new(secret_a: &[u8; 32], secret_b: &[u8; 32]) -> SeatKit {
        let signer_a = LocalSigner::from_secret(secret_a);
        let signer_b = LocalSigner::from_secret(secret_b);
        SeatKit {
            pk_a: signer_a.public_key(),
            pk_b: signer_b.public_key(),
            signer_a,
            signer_b,
        }
    }
}

/// Per-tunnel telemetry knobs threaded from the CLI to the tunnel runner.
#[derive(Clone, Copy, Debug)]
pub struct TunnelTelemetry {
    /// `--per-move-latency`: preallocate per-tunnel sample buffers.
    pub collect: bool,
    /// `--transcript-recorder memory` (or a root-settling anchor): wire the
    /// in-memory transcript recorder instead of the no-op.
    pub record_transcript: bool,
}

/// A cloneable anchor that dispatches to either the in-memory or sponsored-Sui backend.
/// Local to the bench so it can implement the foreign TunnelAnchor trait.
#[derive(Clone)]
enum BenchAnchorInner {
    Memory(InMemoryAnchor),
    Sui(SuiOpenIntentAnchor),
}

impl BenchAnchorInner {
    fn label(&self) -> &'static str {
        match self {
            Self::Memory(_) => "memory",
            Self::Sui(_) => "sui-sponsored",
        }
    }
}

impl TunnelAnchor for BenchAnchorInner {
    fn settlement_mode(&self) -> SettlementMode {
        match self {
            Self::Memory(a) => a.settlement_mode(),
            Self::Sui(a) => a.settlement_mode(),
        }
    }

    async fn open(&self, request: TunnelOpenRequest) -> Result<OpenedTunnel, TunnelAnchorError> {
        let anchor = self.label();
        let protocol = request.protocol.as_str().to_owned();
        tracing::debug!(anchor, protocol, "anchor open start");
        let result = match self {
            Self::Memory(a) => a.open(request).await,
            Self::Sui(a) => a.open(request).await,
        };
        match &result {
            Ok(opened) => tracing::debug!(
                anchor,
                protocol,
                tunnel_id = opened.tunnel_id,
                created = opened.created,
                "anchor open done"
            ),
            Err(error) => tracing::warn!(anchor, protocol, ?error, "anchor open failed"),
        }
        result
    }

    async fn settle(
        &self,
        request: TunnelSettleRequest,
    ) -> Result<SettledTunnel, TunnelAnchorError> {
        let anchor = self.label();
        let tunnel_id = request.tunnel_id.clone();
        let by = request.by;
        let final_nonce = request.final_nonce;
        tracing::debug!(anchor, tunnel_id, ?by, final_nonce, "anchor settle start");
        let result = match self {
            Self::Memory(a) => a.settle(request).await,
            Self::Sui(a) => a.settle(request).await,
        };
        match &result {
            Ok(_) => tracing::debug!(anchor, tunnel_id, ?by, final_nonce, "anchor settle done"),
            Err(error) => {
                tracing::warn!(
                    anchor,
                    tunnel_id,
                    ?by,
                    final_nonce,
                    ?error,
                    "anchor settle failed"
                )
            }
        }
        result
    }
}

/// Per-seat transcript recorder chosen at runtime from the anchor's settlement
/// mode. Both seats must share one concrete recorder type, so this is an enum
/// rather than a generic: rootless anchors (memory) get the no-op recorder;
/// root-settling anchors (sponsored Sui) get the in-memory recorder that builds
/// the transcript root `settle` requires. Wiring the no-op recorder for a
/// root-settling anchor makes `drive` reject the settle and the bench panic.
#[derive(Clone)]
enum BenchRecorder<M> {
    Null(NullTranscriptRecorder),
    Memory(InMemoryTranscriptRecorder<M>),
}

impl<M: Clone + Send + Sync> TranscriptRecorder<M> for BenchRecorder<M> {
    fn records_transcript(&self) -> bool {
        match self {
            Self::Null(r) => TranscriptRecorder::<M>::records_transcript(r),
            Self::Memory(r) => r.records_transcript(),
        }
    }
    fn record(&self, entry: TranscriptEntry<M>) -> Result<(), TranscriptError> {
        match self {
            Self::Null(r) => r.record(entry),
            Self::Memory(r) => r.record(entry),
        }
    }
    fn snapshot(&self) -> Transcript<TranscriptEntry<M>> {
        match self {
            Self::Null(r) => TranscriptRecorder::<M>::snapshot(r),
            Self::Memory(r) => r.snapshot(),
        }
    }
}

/// Builds the per-seat recorder. A real (in-memory) recorder is wired when the
/// caller asks to record transcripts (`--transcript-recorder memory`) OR the
/// anchor settles against a transcript root (sponsored Sui, which requires one);
/// otherwise the no-op recorder. So `--transcript-recorder none` truly disables
/// recording and `memory` measures recorder cost even on the memory anchor.
fn bench_recorder_for<M>(
    settlement_mode: SettlementMode,
    record_transcript: bool,
) -> BenchRecorder<M> {
    if record_transcript || matches!(settlement_mode, SettlementMode::TranscriptRoot) {
        BenchRecorder::Memory(InMemoryTranscriptRecorder::new())
    } else {
        BenchRecorder::Null(NullTranscriptRecorder)
    }
}

/// Records the minimum-duration sample for `stage` from `src` into `dst`, if any.
/// Both seats drive the one shared anchor, so each tunnel emits two `Open` and
/// two `Settle` samples; for paired settle one of the two measures cross-seat
/// pairing wait rather than chain cost. Keeping the minimum collapses the pair
/// into the single real open/settle latency instead of a doubled, inflated one.
fn record_min_sample(dst: &mut CollectingSink, src: &CollectingSink, stage: StageId) {
    if let Some(min) = src
        .samples()
        .iter()
        .filter(|s| s.stage == stage)
        .min_by_key(|s| s.dur_ns)
    {
        dst.record(*min);
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn play_protocol_tunnel_with_strategies<P, C, StrategyA, StrategyB>(
    protocol: P,
    strategy_a: StrategyA,
    strategy_b: StrategyB,
    kit: &SeatKit,
    tunnel_id: &str,
    balance_a: u64,
    balance_b: u64,
    max_moves: u64,
    anchor_mode: AnchorMode,
    sui_context: Option<&SuiSponsoredBenchContext>,
    telemetry: TunnelTelemetry,
) -> TunnelOutcome
where
    P: Protocol + Clone,
    P::Move: Clone + Send + Sync,
    C: FrameCodec<P::Move> + Default,
    StrategyA: MoveStrategy<P>,
    StrategyB: MoveStrategy<P>,
{
    let capacity = if telemetry.collect { 64 } else { 0 };
    let initial = Balances {
        a: balance_a,
        b: balance_b,
    };

    // Build the frame transport pair and wrap each end for telemetry.
    let (ch_a_raw, ch_b_raw) = InMemoryFrameTransport::pair();
    let ch_a = InstrumentedTransport::new(ch_a_raw, CollectingSink::with_capacity(capacity));
    let ch_b = InstrumentedTransport::new(ch_b_raw, CollectingSink::with_capacity(capacity));
    // Grab handles before moving wrappers into drivers (no T: Clone needed).
    let (bytes_a_ctr, sink_ch_a) = ch_a.handle();
    let (bytes_b_ctr, sink_ch_b) = ch_b.handle();

    // One anchor shared (cloned) into both seats.
    let inner_anchor = match anchor_mode {
        AnchorMode::Memory => BenchAnchorInner::Memory(InMemoryAnchor::with_fixed_id(tunnel_id)),
        AnchorMode::SuiSponsored => {
            BenchAnchorInner::Sui(scoped_sui_anchor_for_tunnel(sui_context, tunnel_id))
        }
    };
    // Recorder choice follows the anchor's settlement mode, so capture it before
    // the anchor is moved into the wrapper.
    let settlement_mode = inner_anchor.settlement_mode();
    let anchor = InstrumentedAnchor::new(inner_anchor, CollectingSink::with_capacity(capacity));
    // Keep a clone outside the drivers to read counters after join.
    let anchor_handle = anchor.clone();

    // Per-seat recorder: no-op for rootless anchors, in-memory for anchors that
    // settle against a transcript root (sponsored Sui). Wiring the no-op for the
    // latter makes the engine reject settle and the join below panic.
    let rec_a = InstrumentedRecorder::new(
        bench_recorder_for::<P::Move>(settlement_mode, telemetry.record_transcript),
        CollectingSink::with_capacity(capacity),
    );
    let rec_b = InstrumentedRecorder::new(
        bench_recorder_for::<P::Move>(settlement_mode, telemetry.record_transcript),
        CollectingSink::with_capacity(capacity),
    );

    let driver_a = PartyDriver::with_codec(
        SeatParts {
            protocol: protocol.clone(),
            signer: kit.signer_a.clone(),
            opponent_pk: kit.pk_b,
            initial,
            seat: Seat::A,
        },
        strategy_a,
        ch_a,
        anchor.clone(),
        rec_a,
        C::default(),
    );
    let driver_b = PartyDriver::with_codec(
        SeatParts {
            protocol,
            signer: kit.signer_b.clone(),
            opponent_pk: kit.pk_a,
            initial,
            seat: Seat::B,
        },
        strategy_b,
        ch_b,
        anchor,
        rec_b,
        C::default(),
    );

    let started = Instant::now();
    // Clocks start from CREATED_AT so timestamp magnitudes match the old bench
    // path, keeping the varint (postcard) and JSON digit-count stable.
    let mut clock_a = CREATED_AT;
    let mut clock_b = CREATED_AT;
    let (res_a, res_b) = tokio::join!(
        driver_a.run(max_moves, move || {
            clock_a += 1;
            clock_a
        }),
        driver_b.run(max_moves, move || {
            clock_b += 1;
            clock_b
        }),
    );
    let e2e_ns = started.elapsed().as_nanos();

    let (outcome_a, rec_a_returned) = res_a.expect("seat A driver completed");
    let (_outcome_b, rec_b_returned) = res_b.expect("seat B driver completed");

    let bytes_a = bytes_a_ctr.load(std::sync::atomic::Ordering::Relaxed);
    let bytes_b = bytes_b_ctr.load(std::sync::atomic::Ordering::Relaxed);

    let open_ok = anchor_handle.opened() >= 1;
    let settle_ok = anchor_handle.closed() >= 1;
    if open_ok {
        tracing::info!(tunnel_id, "tunnel opened");
    }
    if settle_ok {
        tracing::info!(tunnel_id, "tunnel settled");
    }

    // Merge all sinks into one CollectingSink.
    let mut sink = CollectingSink::with_capacity(capacity * 5);
    // Drain anchor sink (requires no other clones of anchor_handle remaining).
    // Both seats open/settle the shared anchor, so collapse each stage's two
    // samples to the minimum — see `record_min_sample`.
    let anchor_sink = anchor_handle.into_sink();
    record_min_sample(&mut sink, &anchor_sink, StageId::Open);
    record_min_sample(&mut sink, &anchor_sink, StageId::Settle);
    // Drain transport sinks via their Arc handles.
    let sink_ch_a = Arc::try_unwrap(sink_ch_a)
        .unwrap_or_else(|_| panic!("transport A sink still shared"))
        .into_inner()
        .expect("transport A sink mutex poisoned");
    let sink_ch_b = Arc::try_unwrap(sink_ch_b)
        .unwrap_or_else(|_| panic!("transport B sink still shared"))
        .into_inner()
        .expect("transport B sink mutex poisoned");
    sink.merge(sink_ch_a);
    sink.merge(sink_ch_b);
    // Drain recorder sinks (returned from run).
    sink.merge(rec_a_returned.into_sink());
    sink.merge(rec_b_returned.into_sink());

    TunnelOutcome {
        moves: outcome_a.moves,
        bytes: bytes_a + bytes_b,
        e2e_ns,
        play_ns: outcome_a.play_ns,
        final_balances: outcome_a.final_balances,
        open_ok,
        settle_ok,
        sink,
        export_bytes: 0,
    }
}

/// Drives a seeded blackjack.bet.v1 tunnel through the engine. `card_seed = None`
/// reproduces the 143-move golden (default card ordering).
#[allow(clippy::too_many_arguments)]
pub async fn play_tunnel_seeded<C: FrameCodec<BjMove> + Default>(
    card_seed: Option<u64>,
    kit: &SeatKit,
    tunnel_id: &str,
    balance_a: u64,
    balance_b: u64,
    max_moves: u64,
    anchor_mode: AnchorMode,
    sui_context: Option<&SuiSponsoredBenchContext>,
) -> TunnelOutcome {
    // SeededBlackjack carries the card_seed into initial_state.
    play_protocol_tunnel_with_strategies::<SeededBlackjack, C, BlackjackStrategy, BlackjackStrategy>(
        SeededBlackjack { card_seed },
        BlackjackStrategy,
        BlackjackStrategy,
        kit,
        tunnel_id,
        balance_a,
        balance_b,
        max_moves,
        anchor_mode,
        sui_context,
        TunnelTelemetry {
            collect: false,
            record_transcript: false,
        },
    )
    .await
}

#[allow(clippy::too_many_arguments)]
pub async fn play_blackjack_v2_seeded<C: FrameCodec<BlackjackV2Move> + Default>(
    move_seed: u64,
    kit: &SeatKit,
    tunnel_id: &str,
    balance_a: u64,
    balance_b: u64,
    max_moves: u64,
    anchor_mode: AnchorMode,
    sui_context: Option<&SuiSponsoredBenchContext>,
) -> TunnelOutcome {
    play_protocol_tunnel_with_strategies::<BlackjackV2, C, BlackjackV2Strategy, BlackjackV2Strategy>(
        BlackjackV2,
        BlackjackV2Strategy::new(move_seed ^ 0xA5A5_5A5A_D0D0_1CE5),
        BlackjackV2Strategy::new(move_seed ^ 0x5A5A_A5A5_CAFE_BABE),
        kit,
        tunnel_id,
        balance_a,
        balance_b,
        max_moves,
        anchor_mode,
        sui_context,
        TunnelTelemetry {
            collect: false,
            record_transcript: false,
        },
    )
    .await
}

/// Blackjack.bet.v1 protocol wrapper that carries a card seed into `initial_state`.
/// When `card_seed = None` behaviour is byte-identical to the unseeded `Blackjack` struct.
#[derive(Clone)]
pub(crate) struct SeededBlackjack {
    pub(crate) card_seed: Option<u64>,
}

impl Protocol for SeededBlackjack {
    type State = BjState;
    type Move = BjMove;

    fn name(&self) -> &str {
        Blackjack.name()
    }

    fn initial_state(&self, ctx: &tunnel_harness::TunnelContext) -> Self::State {
        tunnel_blackjack::initial_state(ctx.initial.a, ctx.initial.b, self.card_seed)
    }

    fn apply_move(
        &self,
        state: &Self::State,
        mv: &Self::Move,
        by: Seat,
    ) -> Result<Self::State, tunnel_harness::ProtocolError> {
        Blackjack.apply_move(state, mv, by)
    }

    fn encode_state(&self, s: &Self::State) -> Vec<u8> {
        Blackjack.encode_state(s)
    }

    fn balances(&self, s: &Self::State) -> Balances {
        Blackjack.balances(s)
    }

    fn is_terminal(&self, s: &Self::State) -> bool {
        Blackjack.is_terminal(s)
    }

    fn sample_move(
        &self,
        state: &Self::State,
        seat: Seat,
        rng: &mut dyn FnMut() -> f64,
    ) -> Option<Self::Move> {
        Blackjack.sample_move(state, seat, rng)
    }
}

/// `BlackjackStrategy` implements MoveStrategy<Blackjack> in the tunnel_blackjack crate.
/// Re-implement for SeededBlackjack (same logic; local type satisfies orphan rules).
impl MoveStrategy<SeededBlackjack> for BlackjackStrategy {
    async fn plan_move(
        &mut self,
        state: &BjState,
        seat: Seat,
        _ctx: &MoveStrategyContext,
    ) -> Option<BjMove> {
        tunnel_blackjack::plan(state, seat)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tunnel_harness::{BcsFrameCodec, JsonFrameCodec, PostcardFrameCodec};

    async fn golden_match<C: FrameCodec<BjMove> + Default>() -> TunnelOutcome {
        let sa: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let sb: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let kit = SeatKit::new(&sa, &sb);
        play_tunnel_seeded::<C>(None, &kit, "0x1", 200, 200, 1000, AnchorMode::Memory, None).await
    }

    /// Exact wire-byte goldens per codec for the 143-move blackjack.bet.v1
    /// golden. Locks the binary-codec frame sizes (not just `bcs < json`), so a
    /// codec/frame change that inflates BCS or postcard bytes is caught.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn codec_byte_goldens_are_stable() {
        assert_eq!(golden_match::<JsonFrameCodec>().await.bytes, 75_982, "json");
        assert_eq!(golden_match::<BcsFrameCodec>().await.bytes, 29_492, "bcs");
        assert_eq!(
            golden_match::<PostcardFrameCodec>().await.bytes,
            24_985,
            "postcard"
        );
    }

    #[test]
    fn recorder_matches_anchor_settlement_mode() {
        // Regression: a transcript-root anchor (sponsored Sui) needs a recorder
        // that reports records_transcript()==true; wiring the no-op recorder made
        // the engine reject settle and the bench panic on the join.
        let root = bench_recorder_for::<BjMove>(SettlementMode::TranscriptRoot, false);
        assert!(root.records_transcript());
        let rootless = bench_recorder_for::<BjMove>(SettlementMode::Rootless, false);
        assert!(!rootless.records_transcript());
    }

    #[test]
    fn recorder_follows_transcript_flag_on_rootless_anchor() {
        // --transcript-recorder memory wires a real recorder even when the anchor is rootless.
        assert!(bench_recorder_for::<BjMove>(SettlementMode::Rootless, true).records_transcript());
        assert!(
            !bench_recorder_for::<BjMove>(SettlementMode::Rootless, false).records_transcript()
        );
        // Root-settling anchors always get a real recorder regardless of the flag.
        assert!(
            bench_recorder_for::<BjMove>(SettlementMode::TranscriptRoot, false)
                .records_transcript()
        );
    }

    /// End-to-end: `record_transcript: true` on the (rootless) memory anchor wires
    /// the in-memory recorder, records every move, and still settles cleanly —
    /// the `--transcript-recorder memory` path on the memory anchor.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn memory_anchor_records_transcript_when_flag_set() {
        let sa: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let sb: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let kit = SeatKit::new(&sa, &sb);
        let outcome = play_protocol_tunnel_with_strategies::<
            SeededBlackjack,
            JsonFrameCodec,
            BlackjackStrategy,
            BlackjackStrategy,
        >(
            SeededBlackjack { card_seed: None },
            BlackjackStrategy,
            BlackjackStrategy,
            &kit,
            "0x1",
            200,
            200,
            1000,
            AnchorMode::Memory,
            None,
            TunnelTelemetry {
                collect: false,
                record_transcript: true,
            },
        )
        .await;

        assert_eq!(outcome.moves, 143, "golden move count");
        assert!(outcome.settle_ok, "rootless settle must still succeed");
        assert_eq!(outcome.final_balances.sum(), 400, "balances conserved");
    }

    /// D2 golden: engine PartyDriver reproduces the 143-move blackjack.bet.v1 golden.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn engine_driver_plays_blackjack_bet_golden() {
        let sa: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let sb: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let kit = SeatKit::new(&sa, &sb);
        let outcome = play_protocol_tunnel_with_strategies::<
            SeededBlackjack,
            JsonFrameCodec,
            BlackjackStrategy,
            BlackjackStrategy,
        >(
            SeededBlackjack { card_seed: None },
            BlackjackStrategy,
            BlackjackStrategy,
            &kit,
            "0x1",
            200,
            200,
            1000,
            AnchorMode::Memory,
            None,
            TunnelTelemetry {
                collect: true,
                record_transcript: false,
            },
        )
        .await;

        assert_eq!(outcome.moves, 143, "must reproduce 143-move golden");
        assert_eq!(
            outcome.final_balances.sum(),
            400,
            "balances must be conserved"
        );
        assert!(outcome.bytes > 0, "frame bytes must be non-zero");
        assert!(outcome.open_ok, "anchor must have been opened");
        assert!(outcome.settle_ok, "anchor must have been settled");

        let has_open = outcome
            .sink
            .samples()
            .iter()
            .any(|s| s.stage == StageId::Open);
        let has_settle = outcome
            .sink
            .samples()
            .iter()
            .any(|s| s.stage == StageId::Settle);
        let has_frame_send = outcome
            .sink
            .samples()
            .iter()
            .any(|s| s.stage == StageId::FrameSend);
        assert!(has_open, "sink must contain Open sample");
        assert!(has_settle, "sink must contain Settle sample");
        assert!(has_frame_send, "sink must contain FrameSend sample");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn move_count_is_143_for_golden_seed() {
        let r = golden_match::<JsonFrameCodec>().await;
        assert_eq!(r.moves, 143, "golden deterministic move count");
        assert_eq!(r.final_balances.sum(), 400);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn move_count_is_codec_independent() {
        let j = golden_match::<JsonFrameCodec>().await;
        let b = golden_match::<BcsFrameCodec>().await;
        let p = golden_match::<PostcardFrameCodec>().await;
        for r in [&b, &p] {
            assert_eq!(r.moves, j.moves);
            assert_eq!(r.final_balances, j.final_balances);
        }
        assert!(
            b.bytes < j.bytes && p.bytes < j.bytes,
            "json={} bcs={} postcard={}",
            j.bytes,
            b.bytes,
            p.bytes
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn shared_sui_anchor_context_scopes_intents_per_tunnel() {
        let anchor = SuiSponsoredAnchor::new(SuiSponsoredAnchorConfig {
            rpc_url: "http://rpc.invalid".into(),
            backend_url: "http://backend.invalid".into(),
            package_id: "0x2".into(),
            tunnel_coin_type: "0x2::sui::SUI".into(),
            open_mode: sui_tunnel_anchor::SuiOpenMode::SponsoredCreateAndFund,
            settle_mode: sui_tunnel_anchor::SuiSettleMode::BackendSettle,
            funding_profile: sui_tunnel_anchor::SuiFundingProfile::SingleFunder {
                priv_key: "suiprivkey1qqrswpc8qurswpc8qurswpc8qurswpc8qurswpc8qurswpc8qurswxzszc4"
                    .into(),
                stake_source: sui_tunnel_anchor::SuiStakeSource::CoinObject {
                    coin_id: "0x7".into(),
                },
            },
            open_batching: Default::default(),
            settle_batching: Default::default(),
        })
        .expect("test sponsored Sui anchor");
        let context = SuiSponsoredBenchContext::from_anchor_for_test(anchor);

        let first = scoped_sui_anchor_for_tunnel(Some(&context), "bench-tunnel-1");
        let second = scoped_sui_anchor_for_tunnel(Some(&context), "bench-tunnel-2");
        let shared_first = sui_sponsored_anchor_for_tunnel(Some(&context));
        let shared_second = sui_sponsored_anchor_for_tunnel(Some(&context));

        assert_ne!(first.intent_id(), second.intent_id());
        assert!(
            Arc::ptr_eq(shared_first, shared_second),
            "tunnels must reuse the run-level sponsored Sui service"
        );
    }
}
