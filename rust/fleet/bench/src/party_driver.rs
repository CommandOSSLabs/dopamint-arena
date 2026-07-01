//! Async per-tunnel runner: two `PartyDriver`s joined over `InMemoryFrameTransport::pair()`,
//! instrumented with the telemetry wrappers. The hand-rolled `deliver`/`block_ready` sync pump is
//! gone; the production engine path drives both seats. Both move count and frame bytes are
//! golden-stable for blackjack.bet.v1 with the default seed (143 moves, 75_982 bytes/tunnel).

use crate::cli::{AnchorMode, SuiSponsoredAnchorOpts};
use crate::heartbeat::HeartbeatConfig;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use sui_tunnel_anchor::{
    AnchorCostSnapshot, SuiOpenIntentAnchor, SuiOpenIntentId, SuiPtbMetricsSnapshot,
    SuiSponsoredAnchor, SuiSponsoredAnchorConfig,
};
use tokio::sync::oneshot;
use tunnel_blackjack::v2::{BlackjackV2, BlackjackV2Move, BlackjackV2Strategy};
use tunnel_blackjack::{BjMove, BjState, Blackjack, BlackjackStrategy};
use tunnel_harness::instrument::{InstrumentedAnchor, InstrumentedRecorder, InstrumentedTransport};
use tunnel_harness::{
    Balances, DriverObserver, DriverRunControl, DriverStart, FrameCodec, HarnessError,
    InMemoryAnchor, InMemoryFrameTransport, InMemoryTranscriptRecorder, LocalSigner, MoveStrategy,
    MoveStrategyContext, NullTranscriptRecorder, OpenedTunnel, PartyDriver, Protocol, Seat,
    SeatParts, SettledTunnel, SettlementMode, Signer, Transcript, TranscriptEntry, TranscriptError,
    TranscriptRecorder, TunnelAnchor, TunnelAnchorError, TunnelOpenRequest, TunnelSettleRequest,
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

    pub(crate) fn ptb_metrics_snapshot(&self) -> SuiPtbMetricsSnapshot {
        self.anchor.ptb_metrics_snapshot()
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
#[derive(Clone, Debug)]
pub struct TunnelTelemetry {
    /// `--per-move-latency`: preallocate per-tunnel sample buffers.
    pub collect: bool,
    /// `--transcript-recorder memory` (or a root-settling anchor): wire the
    /// in-memory transcript recorder instead of the no-op.
    pub record_transcript: bool,
    /// Optional backend heartbeat sink for live stats. Attached only to seat A
    /// so the in-process bench pair does not double-count committed moves.
    pub heartbeat: Option<HeartbeatConfig>,
}

#[derive(Clone)]
pub(crate) struct StageWindowRecorder {
    origin: Instant,
    state: Arc<Mutex<StageWindowState>>,
    play_started: Arc<tokio::sync::Notify>,
}

#[derive(Default)]
struct StageWindowState {
    open: StageWindow,
    settle: StageWindow,
    first_play_start: Option<Duration>,
}

#[derive(Default)]
struct StageWindow {
    intervals: Vec<(Duration, Duration)>,
}

impl StageWindowRecorder {
    pub(crate) fn new() -> Self {
        Self {
            origin: Instant::now(),
            state: Arc::new(Mutex::new(StageWindowState::default())),
            play_started: Arc::new(tokio::sync::Notify::new()),
        }
    }

    fn record(&self, stage: StageId, start: Instant, end: Instant) {
        let start = start.saturating_duration_since(self.origin);
        let end = end.saturating_duration_since(self.origin);
        let mut state = self.state.lock().expect("stage window mutex poisoned");
        let window = match stage {
            StageId::Open => &mut state.open,
            StageId::Settle => &mut state.settle,
            _ => return,
        };
        window.intervals.push((start, end.max(start)));
    }

    pub(crate) fn active_elapsed_ms(&self, stage: StageId) -> u128 {
        let state = self.state.lock().expect("stage window mutex poisoned");
        let window = match stage {
            StageId::Open => &state.open,
            StageId::Settle => &state.settle,
            _ => return 0,
        };
        if window.intervals.is_empty() {
            return 0;
        }
        let mut intervals = window.intervals.clone();
        intervals.sort_by_key(|(start, _)| *start);
        let mut active = Duration::ZERO;
        let (mut current_start, mut current_end) = intervals[0];
        for (start, end) in intervals.into_iter().skip(1) {
            if start <= current_end {
                current_end = current_end.max(end);
            } else {
                active += current_end.saturating_sub(current_start);
                current_start = start;
                current_end = end;
            }
        }
        active += current_end.saturating_sub(current_start);
        let millis = active.as_millis();
        millis.max(1)
    }

    fn record_play_started(&self, start: Instant) {
        let start = start.saturating_duration_since(self.origin);
        let mut state = self.state.lock().expect("stage window mutex poisoned");
        if state.first_play_start.is_none() {
            state.first_play_start = Some(start);
            self.play_started.notify_waiters();
        }
    }

    pub(crate) fn first_play_started(&self) -> Option<Instant> {
        let state = self.state.lock().expect("stage window mutex poisoned");
        state
            .first_play_start
            .and_then(|start| self.origin.checked_add(start))
    }

    pub(crate) async fn wait_for_first_play_start(&self) -> Instant {
        loop {
            if let Some(start) = self.first_play_started() {
                return start;
            }
            self.play_started.notified().await;
        }
    }
}

struct PlayStartObserver {
    stage_windows: StageWindowRecorder,
}

impl DriverObserver for PlayStartObserver {
    fn on_started(&mut self, _start: &DriverStart<'_>) {
        self.stage_windows.record_play_started(Instant::now());
    }
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

    fn settlement_mode(&self) -> SettlementMode {
        match self {
            Self::Memory(a) => a.settlement_mode(),
            Self::Sui(a) => a.settlement_mode(),
        }
    }

    async fn open(&self, request: TunnelOpenRequest) -> Result<OpenedTunnel, TunnelAnchorError> {
        match self {
            Self::Memory(a) => a.open(request).await,
            Self::Sui(a) => a.open(request).await,
        }
    }

    async fn settle(
        &self,
        request: TunnelSettleRequest,
    ) -> Result<SettledTunnel, TunnelAnchorError> {
        match self {
            Self::Memory(a) => a.settle(request).await,
            Self::Sui(a) => a.settle(request).await,
        }
    }
}

#[derive(Clone)]
struct BenchAnchor {
    inner: BenchAnchorInner,
    stage_windows: Option<StageWindowRecorder>,
    submitter: Option<BenchSubmitter>,
    seat: Seat,
}

impl BenchAnchor {
    fn new(
        inner: BenchAnchorInner,
        stage_windows: Option<StageWindowRecorder>,
        submitter: Option<BenchSubmitter>,
        seat: Seat,
    ) -> Self {
        Self {
            inner,
            stage_windows,
            submitter,
            seat,
        }
    }

    fn record_stage(&self, stage: StageId, start: Instant, end: Instant) {
        if let Some(recorder) = &self.stage_windows {
            recorder.record(stage, start, end);
        }
    }
}

type OpenResult = Result<OpenedTunnel, TunnelAnchorError>;
type SettleResult = Result<SettledTunnel, TunnelAnchorError>;
type SharedOpenResult = Arc<OpenResult>;
type SharedSettleResult = Arc<SettleResult>;

#[derive(Clone)]
struct BenchSubmitter {
    inner: Arc<Mutex<BenchSubmitterState>>,
    settle_ready: Arc<tokio::sync::Notify>,
}

#[derive(Default)]
struct BenchSubmitterState {
    open: BenchSubmitterOpenState,
    settle: BenchSubmitterSettleState,
}

#[derive(Default)]
struct BenchSubmitterOpenState {
    result: Option<SharedOpenResult>,
    waiters: Vec<oneshot::Sender<SharedOpenResult>>,
}

#[derive(Default)]
struct BenchSubmitterSettleState {
    request_a: Option<TunnelSettleRequest>,
    request_b: Option<TunnelSettleRequest>,
    result: Option<SharedSettleResult>,
    waiters: Vec<oneshot::Sender<SharedSettleResult>>,
    #[cfg(test)]
    ready_waiters: usize,
}

impl BenchSubmitter {
    fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(BenchSubmitterState::default())),
            settle_ready: Arc::new(tokio::sync::Notify::new()),
        }
    }

    async fn open_as_seat(
        &self,
        seat: Seat,
        inner: &BenchAnchorInner,
        request: TunnelOpenRequest,
    ) -> OpenResult {
        self.open_as_seat_with_pair_timeout(seat, inner, request, None)
            .await
    }

    async fn open_as_seat_with_pair_timeout(
        &self,
        seat: Seat,
        inner: &BenchAnchorInner,
        request: TunnelOpenRequest,
        pair_timeout: Option<Duration>,
    ) -> OpenResult {
        if seat == Seat::A {
            let result = inner.open(request).await;
            self.complete_open(&result);
            return result;
        }

        let receiver = {
            let mut state = self.inner.lock().expect("bench submitter mutex poisoned");
            if let Some(result) = &state.open.result {
                return clone_open_result(result);
            }
            let (sender, receiver) = oneshot::channel();
            state.open.waiters.push(sender);
            receiver
        };
        let shared_result =
            await_submitter_result(receiver, pair_timeout, "paired open submitter").await?;
        clone_open_result(&shared_result)
    }

    fn complete_open(&self, result: &OpenResult) {
        let shared_result = Arc::new(clone_open_result(result));
        let waiters = {
            let mut state = self.inner.lock().expect("bench submitter mutex poisoned");
            if state.open.result.is_some() {
                return;
            }
            state.open.result = Some(Arc::clone(&shared_result));
            std::mem::take(&mut state.open.waiters)
        };
        for waiter in waiters {
            let _ = waiter.send(Arc::clone(&shared_result));
        }
    }

    async fn settle_as_seat(
        &self,
        seat: Seat,
        inner: &BenchAnchorInner,
        request: TunnelSettleRequest,
    ) -> SettleResult {
        self.settle_as_seat_with_pair_timeout(seat, inner, request, None)
            .await
    }

    async fn settle_as_seat_with_pair_timeout(
        &self,
        seat: Seat,
        inner: &BenchAnchorInner,
        request: TunnelSettleRequest,
        pair_timeout: Option<Duration>,
    ) -> SettleResult {
        let receiver = {
            let mut state = self.inner.lock().expect("bench submitter mutex poisoned");
            if let Some(result) = &state.settle.result {
                return clone_settle_result(result);
            }
            match seat {
                Seat::A => state.settle.request_a = Some(request),
                Seat::B => state.settle.request_b = Some(request),
            }
            if state.settle.request_a.is_some() && state.settle.request_b.is_some() {
                self.settle_ready.notify_waiters();
            }
            let (sender, receiver) = oneshot::channel();
            state.settle.waiters.push(sender);
            receiver
        };

        if seat == Seat::A {
            if let Err(error) = self.submit_settle_when_ready(inner, pair_timeout).await {
                let result = Err(error);
                self.complete_settle(&result);
            }
        }

        let shared_result =
            await_submitter_result(receiver, pair_timeout, "paired settle submitter").await?;
        clone_settle_result(&shared_result)
    }

    async fn submit_settle_when_ready(
        &self,
        inner: &BenchAnchorInner,
        pair_timeout: Option<Duration>,
    ) -> Result<(), TunnelAnchorError> {
        loop {
            let notified = self.settle_ready.notified();
            let maybe_requests = {
                let state = self.inner.lock().expect("bench submitter mutex poisoned");
                if let Some(result) = &state.settle.result {
                    return clone_settle_result(result).map(|_| ());
                }
                match (&state.settle.request_a, &state.settle.request_b) {
                    (Some(a), Some(b)) => Some((clone_settle_request(a), clone_settle_request(b))),
                    _ => None,
                }
            };
            let Some((request_a, request_b)) = maybe_requests else {
                self.increment_settle_ready_waiters_for_test();
                let wait_result = await_submitter_notify(notified, pair_timeout).await;
                self.decrement_settle_ready_waiters_for_test();
                wait_result.map_err(|_| {
                    TunnelAnchorError::Unavailable(
                        "timed out waiting for paired settle request".into(),
                    )
                })?;
                continue;
            };

            let (result_a, result_b) =
                tokio::join!(inner.settle(request_a), inner.settle(request_b));
            let result = result_a.or(result_b);
            self.complete_settle(&result);
            return Ok(());
        }
    }

    fn complete_settle(&self, result: &SettleResult) {
        let shared_result = Arc::new(clone_settle_result(result));
        let waiters = {
            let mut state = self.inner.lock().expect("bench submitter mutex poisoned");
            if state.settle.result.is_some() {
                return;
            }
            state.settle.result = Some(Arc::clone(&shared_result));
            std::mem::take(&mut state.settle.waiters)
        };
        for waiter in waiters {
            let _ = waiter.send(Arc::clone(&shared_result));
        }
    }

    fn abort(&self, reason: impl Into<String>) {
        let reason = reason.into();
        let open_result: SharedOpenResult = Arc::new(Err(TunnelAnchorError::Unavailable(format!(
            "bench submitter aborted paired open: {reason}"
        ))));
        let settle_result: SharedSettleResult = Arc::new(Err(TunnelAnchorError::Unavailable(
            format!("bench submitter aborted paired settle: {reason}"),
        )));
        let (open_waiters, settle_waiters) = {
            let mut state = self.inner.lock().expect("bench submitter mutex poisoned");
            let open_waiters = if state.open.result.is_none() {
                state.open.result = Some(Arc::clone(&open_result));
                std::mem::take(&mut state.open.waiters)
            } else {
                Vec::new()
            };
            let settle_waiters = if state.settle.result.is_none() {
                state.settle.result = Some(Arc::clone(&settle_result));
                std::mem::take(&mut state.settle.waiters)
            } else {
                Vec::new()
            };
            (open_waiters, settle_waiters)
        };
        for waiter in open_waiters {
            let _ = waiter.send(Arc::clone(&open_result));
        }
        for waiter in settle_waiters {
            let _ = waiter.send(Arc::clone(&settle_result));
        }
        self.settle_ready.notify_waiters();
    }

    #[cfg(test)]
    fn increment_settle_ready_waiters_for_test(&self) {
        let mut state = self.inner.lock().expect("bench submitter mutex poisoned");
        state.settle.ready_waiters += 1;
    }

    #[cfg(not(test))]
    fn increment_settle_ready_waiters_for_test(&self) {}

    #[cfg(test)]
    fn decrement_settle_ready_waiters_for_test(&self) {
        let mut state = self.inner.lock().expect("bench submitter mutex poisoned");
        state.settle.ready_waiters = state.settle.ready_waiters.saturating_sub(1);
    }

    #[cfg(not(test))]
    fn decrement_settle_ready_waiters_for_test(&self) {}

    #[cfg(test)]
    fn settle_ready_waiter_count_for_test(&self) -> usize {
        self.inner
            .lock()
            .expect("bench submitter mutex poisoned")
            .settle
            .ready_waiters
    }

    #[cfg(test)]
    fn stored_open_result_strong_count_for_test(&self) -> usize {
        self.inner
            .lock()
            .expect("bench submitter mutex poisoned")
            .open
            .result
            .as_ref()
            .map_or(0, Arc::strong_count)
    }

    #[cfg(test)]
    fn stored_settle_result_strong_count_for_test(&self) -> usize {
        self.inner
            .lock()
            .expect("bench submitter mutex poisoned")
            .settle
            .result
            .as_ref()
            .map_or(0, Arc::strong_count)
    }
}

fn clone_open_result(result: &OpenResult) -> OpenResult {
    result
        .as_ref()
        .map(clone_opened_tunnel)
        .map_err(Clone::clone)
}

fn clone_settle_result(result: &SettleResult) -> SettleResult {
    result
        .as_ref()
        .map(clone_settled_tunnel)
        .map_err(Clone::clone)
}

fn clone_opened_tunnel(opened: &OpenedTunnel) -> OpenedTunnel {
    OpenedTunnel {
        tunnel_id: opened.tunnel_id.clone(),
        onchain_nonce: opened.onchain_nonce,
        created_at_ms: opened.created_at_ms,
        created: false,
    }
}

fn clone_settled_tunnel(settled: &SettledTunnel) -> SettledTunnel {
    SettledTunnel {
        digest: settled.digest.clone(),
        final_balances: settled.final_balances,
    }
}

fn clone_settle_request(request: &TunnelSettleRequest) -> TunnelSettleRequest {
    TunnelSettleRequest {
        by: request.by,
        tunnel_id: request.tunnel_id.clone(),
        party_a_balance: request.party_a_balance,
        party_b_balance: request.party_b_balance,
        final_nonce: request.final_nonce,
        timestamp: request.timestamp,
        signature: request.signature,
        transcript_root: request.transcript_root,
        transcript_entries: request.transcript_entries.clone(),
    }
}

async fn await_submitter_result<T>(
    receiver: oneshot::Receiver<T>,
    timeout: Option<Duration>,
    label: &str,
) -> Result<T, TunnelAnchorError> {
    let result = match timeout {
        Some(timeout) => tokio::time::timeout(timeout, receiver).await.map_err(|_| {
            TunnelAnchorError::Unavailable(format!("timed out waiting for {label}"))
        })?,
        None => receiver.await,
    };
    result.map_err(|_| TunnelAnchorError::Unavailable(format!("bench {label} dropped")))
}

async fn await_submitter_notify(
    notified: impl std::future::Future<Output = ()>,
    timeout: Option<Duration>,
) -> Result<(), ()> {
    match timeout {
        Some(timeout) => tokio::time::timeout(timeout, notified)
            .await
            .map_err(|_| ())?,
        None => notified.await,
    }
    Ok(())
}

impl TunnelAnchor for BenchAnchor {
    fn settlement_mode(&self) -> SettlementMode {
        self.inner.settlement_mode()
    }

    async fn open(&self, request: TunnelOpenRequest) -> Result<OpenedTunnel, TunnelAnchorError> {
        let anchor = self.inner.label();
        let protocol = request.protocol.as_str().to_owned();
        tracing::debug!(anchor, protocol, "anchor open start");
        let started = Instant::now();
        let result = if let Some(submitter) = &self.submitter {
            submitter
                .open_as_seat(self.seat, &self.inner, request)
                .await
        } else {
            match &self.inner {
                BenchAnchorInner::Memory(a) => a.open(request).await,
                BenchAnchorInner::Sui(a) => a.open(request).await,
            }
        };
        self.record_stage(StageId::Open, started, Instant::now());
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
        let anchor = self.inner.label();
        let tunnel_id = request.tunnel_id.clone();
        let by = request.by;
        let final_nonce = request.final_nonce;
        tracing::debug!(anchor, tunnel_id, ?by, final_nonce, "anchor settle start");
        let started = Instant::now();
        let result = if let Some(submitter) = &self.submitter {
            submitter
                .settle_as_seat(self.seat, &self.inner, request)
                .await
        } else {
            match &self.inner {
                BenchAnchorInner::Memory(a) => a.settle(request).await,
                BenchAnchorInner::Sui(a) => a.settle(request).await,
            }
        };
        self.record_stage(StageId::Settle, started, Instant::now());
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

fn detail_sink(collect: bool, capacity: usize) -> CollectingSink {
    if collect {
        CollectingSink::with_capacity(capacity)
    } else {
        CollectingSink::disabled()
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
    run_control: Option<DriverRunControl>,
    stage_windows: Option<StageWindowRecorder>,
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
    let ch_a = InstrumentedTransport::new(ch_a_raw, detail_sink(telemetry.collect, capacity));
    let ch_b = InstrumentedTransport::new(ch_b_raw, detail_sink(telemetry.collect, capacity));
    // Grab handles before moving wrappers into drivers (no T: Clone needed).
    let (bytes_a_ctr, sink_ch_a) = ch_a.handle();
    let (bytes_b_ctr, sink_ch_b) = ch_b.handle();

    // One logical anchor per tunnel. Sui bench mode makes seat A the only
    // on-chain submitter while seat B waits on the same lifecycle result.
    let inner_anchor = match anchor_mode {
        AnchorMode::Memory => BenchAnchorInner::Memory(InMemoryAnchor::with_fixed_id(tunnel_id)),
        AnchorMode::SuiSponsored => {
            BenchAnchorInner::Sui(scoped_sui_anchor_for_tunnel(sui_context, tunnel_id))
        }
    };
    // Recorder choice follows the anchor's settlement mode, so capture it before
    // the anchor is moved into the wrapper.
    let settlement_mode = inner_anchor.settlement_mode();
    let submitter = matches!(anchor_mode, AnchorMode::SuiSponsored).then(BenchSubmitter::new);
    let submitter_for_supervisor = submitter.clone();
    let anchor_a = InstrumentedAnchor::new(
        BenchAnchor::new(
            inner_anchor.clone(),
            stage_windows.clone(),
            submitter.clone(),
            Seat::A,
        ),
        CollectingSink::with_capacity(2),
    );
    let anchor_b = InstrumentedAnchor::new(
        BenchAnchor::new(inner_anchor, stage_windows.clone(), submitter, Seat::B),
        CollectingSink::with_capacity(2),
    );
    // Keep handles outside the drivers to read counters after join.
    let anchor_a_handle = anchor_a.clone();
    let anchor_b_handle = anchor_b.clone();

    // Per-seat recorder: no-op for rootless anchors, in-memory for anchors that
    // settle against a transcript root (sponsored Sui). Wiring the no-op for the
    // latter makes the engine reject settle and the join below panic.
    let rec_a = InstrumentedRecorder::new(
        bench_recorder_for::<P::Move>(settlement_mode, telemetry.record_transcript),
        detail_sink(telemetry.collect, capacity),
    );
    let rec_b = InstrumentedRecorder::new(
        bench_recorder_for::<P::Move>(settlement_mode, telemetry.record_transcript),
        detail_sink(telemetry.collect, capacity),
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
        anchor_a,
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
        anchor_b,
        rec_b,
        C::default(),
    );
    let driver_a = if let Some(control) = run_control.as_ref() {
        driver_a.with_run_control(control.clone())
    } else {
        driver_a
    };
    let driver_b = if let Some(control) = run_control.as_ref() {
        driver_b.with_run_control(control.clone())
    } else {
        driver_b
    };
    let driver_a = if let Some(heartbeat) = telemetry.heartbeat.as_ref() {
        driver_a.observe(Box::new(heartbeat.reporter()))
    } else {
        driver_a
    };
    let (driver_a, driver_b) = if let Some(stage_windows) = stage_windows.as_ref() {
        (
            driver_a.observe(Box::new(PlayStartObserver {
                stage_windows: stage_windows.clone(),
            })),
            driver_b.observe(Box::new(PlayStartObserver {
                stage_windows: stage_windows.clone(),
            })),
        )
    } else {
        (driver_a, driver_b)
    };

    let started = Instant::now();
    // Clocks start from CREATED_AT so timestamp magnitudes match the old bench
    // path, keeping the varint (postcard) and JSON digit-count stable.
    let mut clock_a = CREATED_AT;
    let mut clock_b = CREATED_AT;
    let run_a = driver_a.run(max_moves, move || {
        clock_a += 1;
        clock_a
    });
    let run_b = driver_b.run(max_moves, move || {
        clock_b += 1;
        clock_b
    });
    tokio::pin!(run_a);
    tokio::pin!(run_b);
    let mut res_a = None;
    let mut res_b = None;
    while res_a.is_none() || res_b.is_none() {
        tokio::select! {
            result = &mut run_a, if res_a.is_none() => {
                if let Err(error) = &result {
                    if let Some(submitter) = submitter_for_supervisor.as_ref() {
                        submitter.abort(format!("seat A driver completed with error: {error:?}"));
                    }
                }
                res_a = Some(result);
            }
            result = &mut run_b, if res_b.is_none() => {
                if let Err(error) = &result {
                    if let Some(submitter) = submitter_for_supervisor.as_ref() {
                        submitter.abort(format!("seat B driver completed with error: {error:?}"));
                    }
                }
                res_b = Some(result);
            }
        }
    }
    let res_a = res_a.expect("seat A driver result");
    let res_b = res_b.expect("seat B driver result");
    let e2e_ns = started.elapsed().as_nanos();

    let (outcome_a, rec_a_returned) = match res_a {
        Ok((outcome, recorder)) => (Some(outcome), Some(recorder)),
        Err(error) => {
            record_driver_error(tunnel_id, Seat::A, &error);
            (None, None)
        }
    };
    let (outcome_b, rec_b_returned) = match res_b {
        Ok((outcome, recorder)) => (Some(outcome), Some(recorder)),
        Err(error) => {
            record_driver_error(tunnel_id, Seat::B, &error);
            (None, None)
        }
    };

    let bytes_a = bytes_a_ctr.load(std::sync::atomic::Ordering::Relaxed);
    let bytes_b = bytes_b_ctr.load(std::sync::atomic::Ordering::Relaxed);

    let open_ok = anchor_a_handle.opened() + anchor_b_handle.opened() >= 1;
    let settle_ok = anchor_a_handle.closed() + anchor_b_handle.closed() >= 1;
    if open_ok {
        tracing::info!(tunnel_id, "tunnel opened");
    }
    if settle_ok {
        tracing::info!(tunnel_id, "tunnel settled");
    }

    // Merge all sinks into one CollectingSink.
    let mut sink = CollectingSink::with_capacity((capacity * 5).max(2));
    // Drain anchor sinks (requires no other clones of the handles remaining).
    // Both seats pass through bench anchors, so collapse each stage's two
    // samples to the minimum — see `record_min_sample`.
    let mut anchor_sink = anchor_a_handle.into_sink();
    anchor_sink.merge(anchor_b_handle.into_sink());
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
    // Drain recorder sinks when the driver completed successfully. Failed
    // drivers drop their recorder inside `PartyDriver::run`; the anchor and
    // transport samples still show where the lifecycle stopped.
    if let Some(recorder) = rec_a_returned {
        sink.merge(recorder.into_sink());
    }
    if let Some(recorder) = rec_b_returned {
        sink.merge(recorder.into_sink());
    }

    let reference_outcome = outcome_a.as_ref().or(outcome_b.as_ref());

    TunnelOutcome {
        moves: reference_outcome.map_or(0, |outcome| outcome.moves),
        bytes: bytes_a + bytes_b,
        e2e_ns,
        play_ns: reference_outcome.map_or(0, |outcome| outcome.play_ns),
        final_balances: reference_outcome.map_or(initial, |outcome| outcome.final_balances),
        open_ok,
        settle_ok,
        sink,
        export_bytes: 0,
    }
}

fn record_driver_error(tunnel_id: &str, seat: Seat, error: &HarnessError) {
    tracing::warn!(
        tunnel_id,
        ?seat,
        ?error,
        "tunnel driver failed; recording failed tunnel sample"
    );
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
        SeededBlackjack {
            card_seed,
            round_cap: tunnel_blackjack::ROUND_CAP,
        },
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
            heartbeat: None,
        },
        None,
        None,
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
            heartbeat: None,
        },
        None,
        None,
    )
    .await
}

/// Blackjack.bet.v1 protocol wrapper that carries a card seed into `initial_state`.
/// When `card_seed = None` behaviour is byte-identical to the unseeded `Blackjack` struct.
#[derive(Clone)]
pub(crate) struct SeededBlackjack {
    pub(crate) card_seed: Option<u64>,
    pub(crate) round_cap: u64,
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
        tunnel_blackjack::apply_move_with_round_cap(state, *mv, by, self.round_cap)
            .map_err(tunnel_harness::ProtocolError)
    }

    fn encode_state(&self, s: &Self::State) -> Vec<u8> {
        Blackjack.encode_state(s)
    }

    fn balances(&self, s: &Self::State) -> Balances {
        Blackjack.balances(s)
    }

    fn is_terminal(&self, s: &Self::State) -> bool {
        tunnel_blackjack::is_terminal_with_round_cap(s, self.round_cap)
    }

    fn can_gracefully_close(&self, s: &Self::State) -> bool {
        s.phase == tunnel_blackjack::Phase::RoundOver
    }

    fn sample_move(
        &self,
        state: &Self::State,
        seat: Seat,
        rng: &mut dyn FnMut() -> f64,
    ) -> Option<Self::Move> {
        let _ = rng;
        tunnel_blackjack::plan_with_round_cap(state, seat, self.round_cap)
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct SeededBlackjackStrategy {
    pub(crate) round_cap: u64,
}

impl MoveStrategy<SeededBlackjack> for SeededBlackjackStrategy {
    async fn plan_move(
        &mut self,
        state: &BjState,
        seat: Seat,
        _ctx: &MoveStrategyContext,
    ) -> Option<BjMove> {
        tunnel_blackjack::plan_with_round_cap(state, seat, self.round_cap)
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
    use tunnel_harness::{BcsFrameCodec, DriverRunControl, JsonFrameCodec, PostcardFrameCodec};

    #[test]
    fn seeded_blackjack_apply_move_respects_bench_round_cap() {
        let protocol = SeededBlackjack {
            card_seed: None,
            round_cap: tunnel_blackjack::ROUND_CAP + 1,
        };
        let mut state = tunnel_blackjack::initial_state(2_000, 2_000, None);
        state.round = tunnel_blackjack::ROUND_CAP;
        let player = tunnel_blackjack::player_party(state.round + 1);

        let next = protocol.apply_move(
            &state,
            &BjMove::Bet {
                amount: tunnel_blackjack::MIN_BET,
            },
            player,
        );

        assert!(
            next.is_ok(),
            "bench round cap wrapper should allow legal continuation beyond default ROUND_CAP"
        );
    }

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

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn heartbeat_posts_committed_move_deltas_from_seat_a() {
        use crate::heartbeat::HeartbeatConfig;
        use wiremock::matchers::{header, method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/v1/sessions/sess-1/heartbeat"))
            .and(header("authorization", "Bearer tok-1"))
            .respond_with(ResponseTemplate::new(204))
            .expect(1..)
            .mount(&server)
            .await;

        let sa: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let sb: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let kit = SeatKit::new(&sa, &sb);
        let outcome = play_protocol_tunnel_with_strategies::<
            SeededBlackjack,
            JsonFrameCodec,
            SeededBlackjackStrategy,
            SeededBlackjackStrategy,
        >(
            SeededBlackjack {
                card_seed: None,
                round_cap: 4,
            },
            SeededBlackjackStrategy { round_cap: 4 },
            SeededBlackjackStrategy { round_cap: 4 },
            &kit,
            "0xabc",
            200,
            200,
            1000,
            AnchorMode::Memory,
            None,
            TunnelTelemetry {
                collect: false,
                record_transcript: false,
                heartbeat: Some(HeartbeatConfig {
                    base_url: server.uri(),
                    session_id: "sess-1".into(),
                    stats_token: "tok-1".into(),
                    flush_interval_ms: 1,
                }),
            },
            None,
            None,
        )
        .await;

        assert!(outcome.moves > 0);
        assert!(outcome.play_ns > 0);

        let requests = tokio::time::timeout(Duration::from_millis(250), async {
            loop {
                let requests = server.received_requests().await.unwrap();
                let actions = requests
                    .iter()
                    .map(|request| {
                        let body: serde_json::Value =
                            serde_json::from_slice(&request.body).unwrap();
                        body["actionsDelta"].as_u64().unwrap()
                    })
                    .sum::<u64>();
                if actions >= outcome.moves {
                    return requests;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("heartbeat posts");
        let actions = requests
            .iter()
            .map(|request| {
                let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
                body["actionsDelta"].as_u64().unwrap()
            })
            .sum::<u64>();
        assert_eq!(actions, outcome.moves);

        let first: serde_json::Value = serde_json::from_slice(&requests[0].body).unwrap();
        assert_eq!(first["tunnelId"], "0xabc");
        assert!(first["actionsDelta"].as_u64().unwrap() > 0);
        assert!(first["windowMs"].as_u64().unwrap() > 0);
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

    #[test]
    fn stage_window_recorder_counts_same_tick_recording_as_one_ms() {
        let recorder = StageWindowRecorder::new();
        let recorded_at = Instant::now();

        recorder.record(StageId::Open, recorded_at, recorded_at);

        assert_eq!(recorder.active_elapsed_ms(StageId::Open), 1);
        assert_eq!(recorder.active_elapsed_ms(StageId::Settle), 0);
    }

    #[test]
    fn stage_window_recorder_uses_union_of_active_intervals() {
        let recorder = StageWindowRecorder::new();
        let base = recorder.origin;

        recorder.record(
            StageId::Open,
            base + Duration::from_millis(10),
            base + Duration::from_millis(110),
        );
        recorder.record(
            StageId::Open,
            base + Duration::from_millis(40),
            base + Duration::from_millis(80),
        );
        recorder.record(
            StageId::Open,
            base + Duration::from_millis(200),
            base + Duration::from_millis(250),
        );

        assert_eq!(recorder.active_elapsed_ms(StageId::Open), 150);
    }

    #[tokio::test]
    async fn stage_window_recorder_notifies_first_play_start() {
        let recorder = StageWindowRecorder::new();
        assert!(
            tokio::time::timeout(
                Duration::from_millis(5),
                recorder.wait_for_first_play_start()
            )
            .await
            .is_err(),
            "play window should not start before a driver enters the move loop"
        );

        let started = Instant::now();
        recorder.record_play_started(started);
        let observed = tokio::time::timeout(
            Duration::from_millis(50),
            recorder.wait_for_first_play_start(),
        )
        .await
        .expect("play start notification");

        assert!(observed >= started);
        assert_eq!(recorder.first_play_started(), Some(observed));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bench_submitter_makes_seat_b_wait_for_seat_a_open() {
        let submitter = BenchSubmitter::new();
        let inner = BenchAnchorInner::Memory(InMemoryAnchor::with_fixed_id("0x1"));
        let request = TunnelOpenRequest {
            protocol: tunnel_core::protocol_id::ProtocolId::parse("test.protocol.v1")
                .expect("protocol id"),
            party_a: [1u8; 32],
            party_b: [2u8; 32],
            initial: Balances { a: 1, b: 1 },
        };

        let b = {
            let submitter = submitter.clone();
            let inner = inner.clone();
            tokio::spawn(async move { submitter.open_as_seat(Seat::B, &inner, request).await })
        };
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(!b.is_finished(), "seat B must wait for seat A submitter");

        let opened_a = submitter
            .open_as_seat(
                Seat::A,
                &inner,
                TunnelOpenRequest {
                    protocol: tunnel_core::protocol_id::ProtocolId::parse("test.protocol.v1")
                        .expect("protocol id"),
                    party_a: [1u8; 32],
                    party_b: [2u8; 32],
                    initial: Balances { a: 1, b: 1 },
                },
            )
            .await
            .expect("seat A open");
        let opened_b = b.await.expect("seat B join").expect("seat B open");

        assert_eq!(opened_a.tunnel_id, "0x1");
        assert_eq!(opened_b.tunnel_id, "0x1");
        assert!(opened_a.created);
        assert!(!opened_b.created);
        assert_eq!(
            submitter.stored_open_result_strong_count_for_test(),
            1,
            "submitter should retain one shared open result after waiters drain"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bench_submitter_times_out_when_paired_open_never_arrives() {
        let submitter = BenchSubmitter::new();
        let inner = BenchAnchorInner::Memory(InMemoryAnchor::with_fixed_id("0x1"));
        let result = submitter
            .open_as_seat_with_pair_timeout(
                Seat::B,
                &inner,
                TunnelOpenRequest {
                    protocol: tunnel_core::protocol_id::ProtocolId::parse("test.protocol.v1")
                        .expect("protocol id"),
                    party_a: [1u8; 32],
                    party_b: [2u8; 32],
                    initial: Balances { a: 1, b: 1 },
                },
                Some(Duration::from_millis(5)),
            )
            .await;

        assert!(matches!(
            result,
            Err(TunnelAnchorError::Unavailable(message))
                if message.contains("paired open")
        ));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bench_submitter_abort_wakes_paired_open_waiter() {
        let submitter = BenchSubmitter::new();
        let inner = BenchAnchorInner::Memory(InMemoryAnchor::with_fixed_id("0x1"));
        let b = {
            let submitter = submitter.clone();
            let inner = inner.clone();
            tokio::spawn(async move {
                submitter
                    .open_as_seat_with_pair_timeout(
                        Seat::B,
                        &inner,
                        TunnelOpenRequest {
                            protocol: tunnel_core::protocol_id::ProtocolId::parse(
                                "test.protocol.v1",
                            )
                            .expect("protocol id"),
                            party_a: [1u8; 32],
                            party_b: [2u8; 32],
                            initial: Balances { a: 1, b: 1 },
                        },
                        Some(Duration::from_secs(60)),
                    )
                    .await
            })
        };

        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(!b.is_finished(), "seat B must be waiting for paired open");
        submitter.abort("seat A failed");

        let result = b.await.expect("seat B join");
        assert!(matches!(
            result,
            Err(TunnelAnchorError::Unavailable(message))
                if message.contains("aborted paired open")
        ));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bench_submitter_makes_seat_a_submit_paired_settle() {
        let submitter = BenchSubmitter::new();
        let inner = BenchAnchorInner::Memory(InMemoryAnchor::with_fixed_id("0x1"));
        let signer_a = LocalSigner::from_secret(&[1u8; 32]);
        let signer_b = LocalSigner::from_secret(&[2u8; 32]);
        let protocol =
            tunnel_core::protocol_id::ProtocolId::parse("test.protocol.v1").expect("protocol id");
        inner
            .open(TunnelOpenRequest {
                protocol,
                party_a: signer_a.public_key(),
                party_b: signer_b.public_key(),
                initial: Balances { a: 1, b: 1 },
            })
            .await
            .expect("open");
        let settlement = tunnel_core::wire::Settlement {
            tunnel_id: "0x1".into(),
            party_a_balance: 1,
            party_b_balance: 1,
            final_nonce: 1,
            timestamp: 7,
        };
        let msg = tunnel_core::wire::serialize_settlement(&settlement);
        let request_a = TunnelSettleRequest {
            by: Seat::A,
            tunnel_id: "0x1".into(),
            party_a_balance: 1,
            party_b_balance: 1,
            final_nonce: 1,
            timestamp: 7,
            signature: signer_a.sign(&msg),
            transcript_root: None,
            transcript_entries: Vec::new(),
        };
        let request_b = TunnelSettleRequest {
            by: Seat::B,
            signature: signer_b.sign(&msg),
            ..clone_settle_request(&request_a)
        };

        let b = {
            let submitter = submitter.clone();
            let inner = inner.clone();
            tokio::spawn(async move { submitter.settle_as_seat(Seat::B, &inner, request_b).await })
        };
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(!b.is_finished(), "seat B must wait for seat A submitter");

        let settled_a = submitter
            .settle_as_seat(Seat::A, &inner, request_a)
            .await
            .expect("seat A settle");
        let settled_b = b.await.expect("seat B join").expect("seat B settle");

        assert_eq!(settled_a.digest, settled_b.digest);
        assert_eq!(settled_a.final_balances, Balances { a: 1, b: 1 });
        assert_eq!(settled_b.final_balances, Balances { a: 1, b: 1 });
        assert_eq!(
            submitter.stored_settle_result_strong_count_for_test(),
            1,
            "submitter should retain one shared settle result after waiters drain"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bench_submitter_waits_on_settle_ready_notification() {
        let submitter = BenchSubmitter::new();
        let inner = BenchAnchorInner::Memory(InMemoryAnchor::with_fixed_id("0x1"));
        let signer_a = LocalSigner::from_secret(&[1u8; 32]);
        let signer_b = LocalSigner::from_secret(&[2u8; 32]);
        let protocol =
            tunnel_core::protocol_id::ProtocolId::parse("test.protocol.v1").expect("protocol id");
        inner
            .open(TunnelOpenRequest {
                protocol,
                party_a: signer_a.public_key(),
                party_b: signer_b.public_key(),
                initial: Balances { a: 1, b: 1 },
            })
            .await
            .expect("open");
        let settlement = tunnel_core::wire::Settlement {
            tunnel_id: "0x1".into(),
            party_a_balance: 1,
            party_b_balance: 1,
            final_nonce: 1,
            timestamp: 7,
        };
        let msg = tunnel_core::wire::serialize_settlement(&settlement);
        let request_a = TunnelSettleRequest {
            by: Seat::A,
            tunnel_id: "0x1".into(),
            party_a_balance: 1,
            party_b_balance: 1,
            final_nonce: 1,
            timestamp: 7,
            signature: signer_a.sign(&msg),
            transcript_root: None,
            transcript_entries: Vec::new(),
        };
        let request_b = TunnelSettleRequest {
            by: Seat::B,
            signature: signer_b.sign(&msg),
            ..clone_settle_request(&request_a)
        };

        let a = {
            let submitter = submitter.clone();
            let inner = inner.clone();
            tokio::spawn(async move { submitter.settle_as_seat(Seat::A, &inner, request_a).await })
        };
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(
            !a.is_finished(),
            "seat A must wait for seat B's signed half"
        );
        assert_eq!(
            submitter.settle_ready_waiter_count_for_test(),
            1,
            "seat A should park on one settle-ready notification, not spin"
        );

        let settled_b = submitter
            .settle_as_seat(Seat::B, &inner, request_b)
            .await
            .expect("seat B settle");
        let settled_a = a.await.expect("seat A join").expect("seat A settle");

        assert_eq!(settled_a.digest, settled_b.digest);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bench_submitter_times_out_when_paired_settle_never_arrives() {
        let submitter = BenchSubmitter::new();
        let inner = BenchAnchorInner::Memory(InMemoryAnchor::with_fixed_id("0x1"));
        let signer_a = LocalSigner::from_secret(&[1u8; 32]);
        let signer_b = LocalSigner::from_secret(&[2u8; 32]);
        let protocol =
            tunnel_core::protocol_id::ProtocolId::parse("test.protocol.v1").expect("protocol id");
        inner
            .open(TunnelOpenRequest {
                protocol,
                party_a: signer_a.public_key(),
                party_b: signer_b.public_key(),
                initial: Balances { a: 1, b: 1 },
            })
            .await
            .expect("open");
        let settlement = tunnel_core::wire::Settlement {
            tunnel_id: "0x1".into(),
            party_a_balance: 1,
            party_b_balance: 1,
            final_nonce: 1,
            timestamp: 7,
        };
        let msg = tunnel_core::wire::serialize_settlement(&settlement);
        let result = submitter
            .settle_as_seat_with_pair_timeout(
                Seat::A,
                &inner,
                TunnelSettleRequest {
                    by: Seat::A,
                    tunnel_id: "0x1".into(),
                    party_a_balance: 1,
                    party_b_balance: 1,
                    final_nonce: 1,
                    timestamp: 7,
                    signature: signer_a.sign(&msg),
                    transcript_root: None,
                    transcript_entries: Vec::new(),
                },
                Some(Duration::from_millis(5)),
            )
            .await;

        assert!(matches!(
            result,
            Err(TunnelAnchorError::Unavailable(message))
                if message.contains("paired settle")
        ));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bench_submitter_abort_wakes_paired_settle_waiter() {
        let submitter = BenchSubmitter::new();
        let inner = BenchAnchorInner::Memory(InMemoryAnchor::with_fixed_id("0x1"));
        let signer_a = LocalSigner::from_secret(&[1u8; 32]);
        let signer_b = LocalSigner::from_secret(&[2u8; 32]);
        let protocol =
            tunnel_core::protocol_id::ProtocolId::parse("test.protocol.v1").expect("protocol id");
        inner
            .open(TunnelOpenRequest {
                protocol,
                party_a: signer_a.public_key(),
                party_b: signer_b.public_key(),
                initial: Balances { a: 1, b: 1 },
            })
            .await
            .expect("open");
        let settlement = tunnel_core::wire::Settlement {
            tunnel_id: "0x1".into(),
            party_a_balance: 1,
            party_b_balance: 1,
            final_nonce: 1,
            timestamp: 7,
        };
        let msg = tunnel_core::wire::serialize_settlement(&settlement);
        let a = {
            let submitter = submitter.clone();
            let inner = inner.clone();
            tokio::spawn(async move {
                submitter
                    .settle_as_seat_with_pair_timeout(
                        Seat::A,
                        &inner,
                        TunnelSettleRequest {
                            by: Seat::A,
                            tunnel_id: "0x1".into(),
                            party_a_balance: 1,
                            party_b_balance: 1,
                            final_nonce: 1,
                            timestamp: 7,
                            signature: signer_a.sign(&msg),
                            transcript_root: None,
                            transcript_entries: Vec::new(),
                        },
                        Some(Duration::from_secs(60)),
                    )
                    .await
            })
        };

        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(!a.is_finished(), "seat A must be waiting for paired settle");
        submitter.abort("seat B failed");

        let result = a.await.expect("seat A join");
        assert!(matches!(
            result,
            Err(TunnelAnchorError::Unavailable(message))
                if message.contains("aborted paired settle")
        ));
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
            SeededBlackjack {
                card_seed: None,
                round_cap: tunnel_blackjack::ROUND_CAP,
            },
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
                heartbeat: None,
            },
            None,
            None,
        )
        .await;

        assert_eq!(outcome.moves, 143, "golden move count");
        assert!(outcome.settle_ok, "rootless settle must still succeed");
        assert_eq!(outcome.final_balances.sum(), 400, "balances conserved");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn run_control_stops_non_terminal_bench_tunnel_and_settles() {
        let sa: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let sb: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let kit = SeatKit::new(&sa, &sb);
        let run_control = DriverRunControl::with_move_limit(2);

        let outcome = play_protocol_tunnel_with_strategies::<
            SeededBlackjack,
            JsonFrameCodec,
            BlackjackStrategy,
            BlackjackStrategy,
        >(
            SeededBlackjack {
                card_seed: None,
                round_cap: tunnel_blackjack::ROUND_CAP,
            },
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
                record_transcript: false,
                heartbeat: None,
            },
            Some(run_control.clone()),
            None,
        )
        .await;

        assert!(run_control.stopped());
        assert_eq!(
            outcome.moves, 2,
            "move limit should cap committed moves exactly before settlement"
        );
        assert_eq!(run_control.moves(), outcome.moves);
        assert!(
            outcome.moves < 143,
            "control should stop before the terminal golden path"
        );
        assert!(outcome.settle_ok, "cooperative stop still settles");
        assert_eq!(outcome.final_balances.sum(), 400);
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
            SeededBlackjack {
                card_seed: None,
                round_cap: tunnel_blackjack::ROUND_CAP,
            },
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
                heartbeat: None,
            },
            None,
            None,
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
        assert!(
            outcome.sink.samples().len() <= 320,
            "per-tunnel telemetry must stay bounded even when per-move latency is enabled"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn telemetry_off_does_not_collect_per_move_samples() {
        let sa: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let sb: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let kit = SeatKit::new(&sa, &sb);
        let outcome = play_protocol_tunnel_with_strategies::<
            SeededBlackjack,
            JsonFrameCodec,
            BlackjackStrategy,
            BlackjackStrategy,
        >(
            SeededBlackjack {
                card_seed: None,
                round_cap: tunnel_blackjack::ROUND_CAP,
            },
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
                record_transcript: false,
                heartbeat: None,
            },
            None,
            None,
        )
        .await;

        assert!(outcome.bytes > 0, "byte counters remain available");
        assert!(
            outcome.sink.samples().iter().all(|sample| !matches!(
                sample.stage,
                StageId::FrameSend | StageId::FrameRecv | StageId::RecorderRecord
            )),
            "per-move telemetry samples should not be collected when disabled"
        );
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
