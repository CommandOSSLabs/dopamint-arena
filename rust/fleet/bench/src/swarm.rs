//! The local CPU fleet. Tunnel concurrency is an in-flight lifecycle pool: each
//! task opens, plays, and settles one tunnel through the same `PartyDriver` path
//! as the serving fleet, and completed lifecycles are replaced until the global
//! duration stops new launches or the move limit stops move production.

use crate::cli::{AnchorMode, FrameCodecKind, MoveTarget, ScenarioMode};
use crate::party_driver::{
    SeatKit, StageWindowRecorder, SuiSponsoredBenchContext, TunnelTelemetry,
};
use crate::protocols::{play_tunnel_for, PlayTunnelRequest};
use crate::stats::{summarize, Distribution};
use std::time::{Duration, Instant};
use sui_tunnel_anchor::{
    AnchorCostSnapshot, SuiPtbExecution, SuiPtbFlushReason, SuiPtbMetricsSnapshot,
};
use tokio::task::{JoinError, JoinSet};
use tunnel_harness::DriverRunControl;
use tunnel_telemetry::{CollectingSink, RunTelemetry};

const TUNNEL_DRAIN_TIMEOUT: Duration = Duration::from_secs(60);

/// Wall-clock grace granted to detached background tasks (fire-and-forget
/// heartbeat POSTs) to finish after the measured run ends. Dropping a runtime
/// cancels its still-pending tasks mid-request, so an explicit timed shutdown
/// lets terminal heartbeats drain. Costs nothing when no tasks are pending.
const RUNTIME_SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// Cap on retained per-tunnel samples. Headline totals and counts are tracked
/// exactly regardless of this cap; only the inputs to per-tunnel *distributions*
/// and telemetry are bounded (via reservoir sampling), so a multi-million-tunnel
/// soak run cannot grow memory without limit. Runs at or below this many tunnels
/// retain every sample, so their reported distributions are exact.
const SAMPLE_RESERVOIR_CAP: usize = 50_000;

/// Golden seat A secret: bytes 0x01..0x20.
pub const SEAT_A: [u8; 32] = {
    let mut k = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        k[i] = (i + 1) as u8;
        i += 1;
    }
    k
};

/// Golden seat B secret: bytes 0x21..0x40.
pub const SEAT_B: [u8; 32] = {
    let mut k = [0u8; 32];
    let mut i = 0;
    while i < 32 {
        k[i] = (i + 33) as u8;
        i += 1;
    }
    k
};

/// One completed tunnel's measurements.
#[derive(Clone)]
pub(crate) struct TunnelSample {
    moves: u64,
    bytes: u64,
    /// Move-loop wall time alone (gameplay latency, excludes open/settle).
    play_ns: u128,
    /// End-to-end wall time (open + play + settle).
    total_ns: u128,
    open_ok: bool,
    settle_ok: bool,
    /// Exact serialized transcript bytes exported by this tunnel.
    export_bytes: u64,
    sink: CollectingSink,
}

/// How a tunnel task obtains its seat keys. `Fresh` defers key generation into
/// the spawned task so per-tunnel keygen runs across the worker pool instead of
/// serializing on the single refill coordinator.
enum SeatKitSource {
    /// Boxed so the zero-data `Fresh` variant — the hot refill path — stays
    /// pointer-sized to move, instead of carrying a full `SeatKit` inline.
    Preinitialized(Box<SeatKit>),
    Fresh,
}

impl SeatKitSource {
    fn resolve(self) -> SeatKit {
        match self {
            SeatKitSource::Preinitialized(kit) => *kit,
            SeatKitSource::Fresh => random_seat_kit(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct SwarmOutcome {
    pub moves: u64,
    pub bytes: u64,
    pub tunnels_settled: u64,
    pub tunnels_opened: u64,
    pub tunnels_claimed: u64,
    pub elapsed_ms: u128,
    pub move_window_elapsed_ms: u128,
    pub open_active_elapsed_ms: u128,
    pub settle_active_elapsed_ms: u128,
    pub play_ns_total: u128,
    pub total_ns_total: u128,
    pub moves_dist: Distribution,
    pub play_ns_dist: Distribution,
    pub tunnels_failed: u64,
    /// Tunnels abandoned before settlement. Normal lifecycle stops drain to
    /// settlement, so this should stay zero outside legacy/error paths.
    pub tunnels_aborted: u64,
    pub per_tunnel_tps_play: Distribution,
    pub per_tunnel_tps_e2e: Distribution,
    pub telemetry: RunTelemetry,
    pub gas_funder_mist: u64,
    pub gas_sponsor_mist: u64,
    pub transcript_export_bytes: u64,
    pub sui_ptb_metrics: SuiPtbMetrics,
}

#[derive(Clone, Debug, Default)]
pub struct SuiPtbMetrics {
    pub open_count: u64,
    pub settle_count: u64,
    pub open_batch_size: Distribution,
    pub settle_batch_size: Distribution,
    pub open_flush_reasons: SuiPtbFlushReasonCounts,
    pub settle_flush_reasons: SuiPtbFlushReasonCounts,
    pub open_tx_digests: Vec<String>,
    pub settle_tx_digests: Vec<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SuiPtbFlushReasonCounts {
    pub immediate: u64,
    pub full: u64,
    pub debounce: u64,
    pub shutdown: u64,
    pub retry_split: u64,
}

impl SuiPtbFlushReasonCounts {
    fn record(&mut self, reason: SuiPtbFlushReason) {
        match reason {
            SuiPtbFlushReason::Immediate => self.immediate += 1,
            SuiPtbFlushReason::Full => self.full += 1,
            SuiPtbFlushReason::Debounce => self.debounce += 1,
            SuiPtbFlushReason::Shutdown => self.shutdown += 1,
            SuiPtbFlushReason::RetrySplit => self.retry_split += 1,
        }
    }
}

/// Distinct, valid hex tunnel id per tunnel (offset by 1 to avoid the all-zero address).
pub fn tunnel_id_for(tunnel_index: u64) -> String {
    format!("0x{:x}", tunnel_index + 1)
}

fn ptb_metrics_delta(before: SuiPtbMetricsSnapshot, after: SuiPtbMetricsSnapshot) -> SuiPtbMetrics {
    fn execution_delta(
        before_len: usize,
        after: Vec<SuiPtbExecution>,
    ) -> (u64, Distribution, SuiPtbFlushReasonCounts, Vec<String>) {
        let executions = after.into_iter().skip(before_len).collect::<Vec<_>>();
        let batch_sizes = executions
            .iter()
            .map(|execution| execution.batch_size as f64)
            .collect::<Vec<_>>();
        let mut flush_reasons = SuiPtbFlushReasonCounts::default();
        for execution in &executions {
            flush_reasons.record(execution.flush_reason);
        }
        let tx_digests = executions
            .into_iter()
            .map(|execution| execution.tx_digest)
            .collect::<Vec<_>>();
        (
            tx_digests.len() as u64,
            summarize(&batch_sizes),
            flush_reasons,
            tx_digests,
        )
    }

    let (open_count, open_batch_size, open_flush_reasons, open_tx_digests) =
        execution_delta(before.open.len(), after.open);
    let (settle_count, settle_batch_size, settle_flush_reasons, settle_tx_digests) =
        execution_delta(before.settle.len(), after.settle);
    SuiPtbMetrics {
        open_count,
        settle_count,
        open_batch_size,
        settle_batch_size,
        open_flush_reasons,
        settle_flush_reasons,
        open_tx_digests,
        settle_tx_digests,
    }
}

#[allow(clippy::too_many_arguments)]
fn aggregate(
    samples: TunnelSamples,
    elapsed_ms: u128,
    move_window_elapsed_ms: u128,
    open_active_elapsed_ms: u128,
    settle_active_elapsed_ms: u128,
    gas: AnchorCostSnapshot,
    sui_ptb_metrics: SuiPtbMetrics,
    tunnels_aborted: u64,
) -> SwarmOutcome {
    // Headline totals/counts are exact (running scalars); only distribution and
    // telemetry inputs come from the bounded reservoir.
    let tunnels_claimed = samples.claimed;
    let tunnels_opened = samples.opened;
    let tunnels_settled = samples.settled;
    let tunnels_failed = tunnels_claimed.saturating_sub(tunnels_settled);
    let moves = samples.moves;
    let bytes = samples.bytes;
    let transcript_export_bytes = samples.export_bytes_total;
    let play_ns_total = samples.play_ns_total;
    let total_ns_total = samples.total_ns_total;
    let retained = samples.reservoir;
    let moves_dist = summarize(&retained.iter().map(|s| s.moves as f64).collect::<Vec<_>>());
    let play_ns_dist = summarize(
        &retained
            .iter()
            .map(|s| s.play_ns as f64)
            .collect::<Vec<_>>(),
    );
    let per_tunnel_tps_play = summarize(
        &retained
            .iter()
            .filter(|s| s.play_ns > 0)
            .map(|s| s.moves as f64 * 1_000_000_000.0 / s.play_ns as f64)
            .collect::<Vec<_>>(),
    );
    let per_tunnel_tps_e2e = summarize(
        &retained
            .iter()
            .filter(|s| s.total_ns > 0)
            .map(|s| s.moves as f64 * 1_000_000_000.0 / s.total_ns as f64)
            .collect::<Vec<_>>(),
    );
    let telemetry = RunTelemetry::from_sinks(retained.iter().map(|s| s.sink.clone()).collect());
    // `transcript_export_bytes` is the exact per-tunnel running total above, not
    // `telemetry.export_bytes_total()` — the latter sums only the bounded reservoir
    // of sinks and would undercount once the run exceeds `SAMPLE_RESERVOIR_CAP`.

    SwarmOutcome {
        moves,
        bytes,
        tunnels_settled,
        tunnels_opened,
        tunnels_claimed,
        elapsed_ms,
        move_window_elapsed_ms,
        open_active_elapsed_ms,
        settle_active_elapsed_ms,
        play_ns_total,
        total_ns_total,
        moves_dist,
        play_ns_dist,
        tunnels_failed,
        tunnels_aborted,
        per_tunnel_tps_play,
        per_tunnel_tps_e2e,
        telemetry,
        gas_funder_mist: gas.gas_funder_mist,
        gas_sponsor_mist: gas.gas_sponsor_mist,
        transcript_export_bytes,
        sui_ptb_metrics,
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_one_tunnel(
    tunnel_index: u64,
    scenario: ScenarioMode,
    codec: FrameCodecKind,
    anchor_mode: AnchorMode,
    sui_context: Option<SuiSponsoredBenchContext>,
    protocol_id: &'static str,
    initial_balance: u64,
    max_moves_per_tunnel: u64,
    telemetry: TunnelTelemetry,
    kit_source: SeatKitSource,
    run_control: Option<DriverRunControl>,
    stage_windows: Option<StageWindowRecorder>,
) -> TunnelSample {
    // Resolve seat keys inside the task so `Fresh` keygen parallelizes across the
    // worker pool rather than serializing on the refill coordinator.
    let kit = kit_source.resolve();
    let tunnel_id = tunnel_id_for(tunnel_index);
    tracing::debug!(
        tunnel_index,
        tunnel_id,
        protocol_id,
        ?anchor_mode,
        ?codec,
        "tunnel task start"
    );
    let r = play_tunnel_for(PlayTunnelRequest {
        protocol_id,
        codec,
        card_seed: scenario.card_seed(tunnel_index),
        run_control,
        kit: &kit,
        tunnel_id: &tunnel_id,
        initial_balance,
        max_moves_per_tunnel,
        anchor_mode,
        sui_context: sui_context.as_ref(),
        telemetry,
        stage_windows,
    })
    .await;
    tracing::debug!(
        tunnel_index,
        tunnel_id,
        protocol_id,
        moves = r.moves,
        bytes = r.bytes,
        open_ok = r.open_ok,
        settle_ok = r.settle_ok,
        e2e_ms = r.e2e_ns as f64 / 1_000_000.0,
        play_ms = r.play_ns as f64 / 1_000_000.0,
        "tunnel task done"
    );

    TunnelSample {
        moves: r.moves,
        bytes: r.bytes,
        // play_ns is the real move-loop time from the driver; total_ns is the
        // full open+play+settle span. Their gap is chain/setup overhead.
        play_ns: r.play_ns,
        total_ns: r.e2e_ns,
        open_ok: r.open_ok,
        settle_ok: r.settle_ok,
        export_bytes: r.export_bytes,
        sink: r.sink,
    }
}

/// Fast, non-cryptographic PRNG for reservoir index selection. Seeded once from
/// the OS RNG; a per-sample syscall would defeat the point of a perf change, and
/// a weak seed only skews *which* samples are retained, never correctness.
struct Xorshift64(u64);

impl Xorshift64 {
    fn seeded() -> Self {
        let mut buf = [0u8; 8];
        let _ = getrandom::getrandom(&mut buf);
        Self(u64::from_le_bytes(buf) | 1)
    }

    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
}

/// Accumulates per-tunnel results with exact running aggregates plus a bounded
/// reservoir of full samples for distribution and telemetry inputs. The coordinator
/// loop grows one entry per completed tunnel for the whole run, so an unbounded Vec
/// would balloon memory and force an O(N²) move-target re-sum; the exact scalars
/// here make the move-target check O(1) and keep headline numbers exact, while the
/// reservoir bounds memory. See `SAMPLE_RESERVOIR_CAP` for the exactness contract.
struct TunnelSamples {
    claimed: u64,
    opened: u64,
    settled: u64,
    moves: u64,
    bytes: u64,
    /// Exact transcript-export bytes across every tunnel, tracked as a running
    /// scalar so the headline total stays exact independent of the reservoir.
    export_bytes_total: u64,
    play_ns_total: u128,
    total_ns_total: u128,
    reservoir: Vec<TunnelSample>,
    rng: Xorshift64,
}

impl TunnelSamples {
    fn new() -> Self {
        Self {
            claimed: 0,
            opened: 0,
            settled: 0,
            moves: 0,
            bytes: 0,
            export_bytes_total: 0,
            play_ns_total: 0,
            total_ns_total: 0,
            reservoir: Vec::new(),
            rng: Xorshift64::seeded(),
        }
    }

    fn record(&mut self, sample: TunnelSample) {
        self.claimed += 1;
        if sample.open_ok {
            self.opened += 1;
        }
        if sample.settle_ok {
            self.settled += 1;
        }
        self.moves += sample.moves;
        self.bytes += sample.bytes;
        self.export_bytes_total += sample.export_bytes;
        self.play_ns_total += sample.play_ns;
        self.total_ns_total += sample.total_ns;

        // Reservoir sampling (Algorithm R): retain a uniform sample of all tunnels.
        if self.reservoir.len() < SAMPLE_RESERVOIR_CAP {
            self.reservoir.push(sample);
        } else {
            let idx = (self.rng.next_u64() % self.claimed) as usize;
            if idx < SAMPLE_RESERVOIR_CAP {
                self.reservoir[idx] = sample;
            }
        }
    }

    /// Exact total committed moves across every recorded tunnel (O(1)).
    fn committed_moves(&self) -> u64 {
        self.moves
    }

    #[cfg(test)]
    fn is_empty(&self) -> bool {
        self.claimed == 0
    }
}

fn record_tunnel_join(
    samples: &mut TunnelSamples,
    result: Result<TunnelSample, JoinError>,
) -> bool {
    match result {
        Ok(sample) => {
            samples.record(sample);
            false
        }
        Err(error) => {
            tracing::warn!(?error, "tunnel task failed to join");
            true
        }
    }
}

/// Per-protocol gas spend = meter after the run minus before. The shared Sui
/// anchor's `CostMeter` is process-wide and monotonic, so without this baseline
/// each protocol in a multi-protocol run would report the cumulative total of
/// every prior protocol.
fn gas_delta(before: AnchorCostSnapshot, after: AnchorCostSnapshot) -> AnchorCostSnapshot {
    AnchorCostSnapshot {
        gas_funder_mist: after.gas_funder_mist.saturating_sub(before.gas_funder_mist),
        gas_sponsor_mist: after
            .gas_sponsor_mist
            .saturating_sub(before.gas_sponsor_mist),
    }
}

fn max_moves_per_tunnel_for_run(moves: Option<MoveTarget>) -> u64 {
    match moves {
        Some(MoveTarget::Count(_)) | Some(MoveTarget::Max) | None => u64::MAX - 1,
    }
}

fn move_target_count(moves: Option<MoveTarget>) -> Option<u64> {
    match moves {
        Some(MoveTarget::Count(moves)) => Some(moves),
        Some(MoveTarget::Max) | None => None,
    }
}

fn reached_move_target(samples: &TunnelSamples, moves: Option<MoveTarget>) -> bool {
    let Some(target) = move_target_count(moves) else {
        return false;
    };
    samples.committed_moves() >= target
}

#[allow(clippy::too_many_arguments)]
pub fn run_lifecycle_pipeline(
    workers: usize,
    duration_secs: u64,
    moves: Option<MoveTarget>,
    tunnel_concurrency: usize,
    scenario: ScenarioMode,
    codec: FrameCodecKind,
    anchor_mode: AnchorMode,
    sui_context: Option<&SuiSponsoredBenchContext>,
    protocol_id: &'static str,
    initial_balance: u64,
    telemetry: TunnelTelemetry,
    preinitialize: bool,
) -> SwarmOutcome {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .worker_threads(workers)
        .thread_name("fleet-bench-tunnel")
        // Protocol drive futures (largest: blackjack_v2's betting+card state, plus the
        // ack-resend/timeout wrapper) exceed tokio's default 2 MiB worker stack. Match the
        // 16 MiB used by the module's other tunnel runtimes.
        .thread_stack_size(16 * 1024 * 1024)
        .build()
        .expect("fleet bench runtime");
    let sui_context = sui_context.cloned();
    let gas_context = sui_context.clone();
    let pool = tunnel_concurrency.max(1);
    let preinit_kits: Vec<SeatKit> = if preinitialize {
        (0..pool).map(|_| random_seat_kit()).collect()
    } else {
        Vec::new()
    };
    let run_control = move_target_count(moves)
        .map(DriverRunControl::with_graceful_move_limit)
        .unwrap_or_else(DriverRunControl::graceful_unbounded);
    let max_moves_per_tunnel = max_moves_per_tunnel_for_run(moves);
    let started = Instant::now();
    tracing::info!(
        in_flight = pool,
        workers,
        protocol_id,
        duration_secs,
        ?moves,
        ?anchor_mode,
        ?codec,
        ?scenario,
        preinitialize,
        "fleet lifecycle pipeline start"
    );
    let gas_before = gas_context
        .as_ref()
        .map(SuiSponsoredBenchContext::cost_snapshot)
        .unwrap_or_default();
    let ptb_metrics_before = gas_context
        .as_ref()
        .map(SuiSponsoredBenchContext::ptb_metrics_snapshot)
        .unwrap_or_default();
    let run_control_for_tasks = run_control.clone();
    let stage_windows = StageWindowRecorder::new();
    let stage_windows_for_tasks = stage_windows.clone();
    let (samples, move_window_elapsed_ms, tunnels_aborted) = runtime.block_on(async move {
        let kit_source_for = |index: u64| -> SeatKitSource {
            if preinitialize {
                SeatKitSource::Preinitialized(Box::new(
                    preinit_kits[index as usize % preinit_kits.len()].clone(),
                ))
            } else {
                // Defer keygen into the task so it runs on a worker, not here.
                SeatKitSource::Fresh
            }
        };
        let spawn_tunnel = |tasks: &mut JoinSet<TunnelSample>, index: u64| {
            tasks.spawn(run_one_tunnel(
                index,
                scenario,
                codec,
                anchor_mode,
                sui_context.clone(),
                protocol_id,
                initial_balance,
                max_moves_per_tunnel,
                telemetry.clone(),
                kit_source_for(index),
                Some(run_control_for_tasks.clone()),
                Some(stage_windows_for_tasks.clone()),
            ));
        };

        let mut tasks = JoinSet::new();
        let mut next_index: u64 = 0;
        for _ in 0..pool {
            spawn_tunnel(&mut tasks, next_index);
            next_index += 1;
        }

        let mut samples = TunnelSamples::new();
        let mut tunnels_aborted = 0;
        let Some(move_window_started) = wait_for_first_play_window(
            &stage_windows_for_tasks,
            &mut tasks,
            &mut samples,
            &mut tunnels_aborted,
            TUNNEL_DRAIN_TIMEOUT,
        )
        .await
        else {
            return (samples, 0, tunnels_aborted);
        };
        let deadline = move_window_started + Duration::from_secs(duration_secs);
        let stop_observed_at = loop {
            if reached_move_target(&samples, moves) || run_control_for_tasks.stopped() {
                break Instant::now();
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                run_control_for_tasks.request_stop();
                break Instant::now();
            }

            let poll_window = remaining.min(Duration::from_millis(10));
            match tokio::time::timeout(poll_window, tasks.join_next()).await {
                Ok(Some(result)) => {
                    if record_tunnel_join(&mut samples, result) {
                        tunnels_aborted += 1;
                    }
                    if !reached_move_target(&samples, moves)
                        && !run_control_for_tasks.stopped()
                        && Instant::now() < deadline
                    {
                        spawn_tunnel(&mut tasks, next_index);
                        next_index += 1;
                    }
                }
                Ok(None) => break Instant::now(),
                Err(_) => {}
            }
        };

        drain_join_set_with_timeout(
            &mut tasks,
            &mut samples,
            &mut tunnels_aborted,
            TUNNEL_DRAIN_TIMEOUT,
        )
        .await;

        (
            samples,
            stop_observed_at
                .duration_since(move_window_started)
                .as_millis(),
            tunnels_aborted,
        )
    });
    // Freeze wall time the instant the measured run's tasks finish, before the
    // shutdown grace below — otherwise a slow telemetry backend's drain would
    // dilate `elapsed_ms` and deflate wall move-TPS.
    let elapsed_ms = started.elapsed().as_millis();
    // Play-only TPS divides total moves — including moves committed while the pool
    // drains after the stop signal — by this window. End it at the last tunnel's
    // move-loop end (its settle start), not the stop instant, so the denominator
    // covers the whole span those moves were produced in. Falls back to the
    // stop-observed span when nothing settled.
    let move_window_elapsed_ms = match (
        stage_windows.first_play_started(),
        stage_windows.move_production_end(),
    ) {
        (Some(start), Some(end)) if end > start => {
            end.duration_since(start).as_millis().min(elapsed_ms)
        }
        _ => move_window_elapsed_ms,
    };
    // Give detached telemetry (fire-and-forget heartbeat POSTs) a bounded window
    // to finish; an implicit runtime drop would cancel them mid-request.
    runtime.shutdown_timeout(RUNTIME_SHUTDOWN_GRACE);
    let gas_after = gas_context
        .as_ref()
        .map(SuiSponsoredBenchContext::cost_snapshot)
        .unwrap_or_default();
    let ptb_metrics_after = gas_context
        .as_ref()
        .map(SuiSponsoredBenchContext::ptb_metrics_snapshot)
        .unwrap_or_default();
    let gas = gas_delta(gas_before, gas_after);
    let sui_ptb_metrics = ptb_metrics_delta(ptb_metrics_before, ptb_metrics_after);
    let open_active_elapsed_ms = stage_windows
        .active_elapsed_ms(tunnel_telemetry::StageId::Open)
        .min(elapsed_ms);
    let settle_active_elapsed_ms = stage_windows
        .active_elapsed_ms(tunnel_telemetry::StageId::Settle)
        .min(elapsed_ms);
    let outcome = aggregate(
        samples,
        elapsed_ms,
        move_window_elapsed_ms,
        open_active_elapsed_ms,
        settle_active_elapsed_ms,
        gas,
        sui_ptb_metrics,
        tunnels_aborted,
    );
    tracing::info!(
        moves = outcome.moves,
        secs = outcome.elapsed_ms as f64 / 1000.0,
        move_window_secs = outcome.move_window_elapsed_ms as f64 / 1000.0,
        tunnels = outcome.tunnels_claimed,
        tunnels_opened = outcome.tunnels_opened,
        tunnels_settled = outcome.tunnels_settled,
        tunnels_failed = outcome.tunnels_failed,
        "fleet lifecycle pipeline done"
    );
    outcome
}

async fn wait_for_first_play_window(
    stage_windows: &StageWindowRecorder,
    tasks: &mut JoinSet<TunnelSample>,
    samples: &mut TunnelSamples,
    tunnels_aborted: &mut u64,
    timeout: Duration,
) -> Option<Instant> {
    let now = Instant::now();
    let deadline = now.checked_add(timeout).unwrap_or(now);
    loop {
        if let Some(start) = stage_windows.first_play_started() {
            return Some(start);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            drain_join_set_with_timeout(tasks, samples, tunnels_aborted, Duration::ZERO).await;
            return stage_windows.first_play_started();
        }

        tokio::select! {
            start = stage_windows.wait_for_first_play_start() => return Some(start),
            result = tasks.join_next() => {
                match result {
                    Some(result) => {
                        if record_tunnel_join(samples, result) {
                            *tunnels_aborted += 1;
                        }
                        if tasks.is_empty() {
                            return stage_windows.first_play_started();
                        }
                    }
                    None => return stage_windows.first_play_started(),
                }
            }
            _ = tokio::time::sleep(remaining) => {
                drain_join_set_with_timeout(tasks, samples, tunnels_aborted, Duration::ZERO).await;
                return stage_windows.first_play_started();
            }
        }
    }
}

async fn drain_join_set_with_timeout(
    tasks: &mut JoinSet<TunnelSample>,
    samples: &mut TunnelSamples,
    tunnels_aborted: &mut u64,
    timeout: Duration,
) {
    if !tasks.is_empty() {
        tracing::info!(
            pending = tasks.len(),
            timeout_ms = timeout.as_millis(),
            "draining tunnel tasks after stop"
        );
    }
    let now = Instant::now();
    let deadline = now.checked_add(timeout).unwrap_or(now);
    while !tasks.is_empty() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match tokio::time::timeout(remaining, tasks.join_next()).await {
            Ok(Some(result)) => {
                if record_tunnel_join(samples, result) {
                    *tunnels_aborted += 1;
                }
            }
            Ok(None) => return,
            Err(_) => break,
        }
    }

    if tasks.is_empty() {
        return;
    }

    let pending = tasks.len();
    tracing::warn!(
        pending,
        timeout_ms = timeout.as_millis(),
        "aborting tunnel tasks that did not finish final drain"
    );
    tasks.abort_all();
    while let Some(result) = tasks.join_next().await {
        if record_tunnel_join(samples, result) {
            *tunnels_aborted += 1;
        }
    }
}

fn random_seat_kit() -> SeatKit {
    let mut secret_a = [0u8; 32];
    let mut secret_b = [0u8; 32];
    getrandom::getrandom(&mut secret_a).expect("os rng");
    getrandom::getrandom(&mut secret_b).expect("os rng");
    SeatKit::new(&secret_a, &secret_b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::AnchorMode;
    use sui_tunnel_anchor::AnchorCostSnapshot;
    use tunnel_core::protocol_id::BLACKJACK_BET_V1;
    use tunnel_telemetry::{CollectingSink, StageId};

    fn sample_with_tps(tps: f64) -> TunnelSample {
        TunnelSample {
            moves: tps as u64,
            bytes: 0,
            play_ns: 1_000_000_000,
            total_ns: 2_000_000_000,
            open_ok: true,
            settle_ok: true,
            export_bytes: 0,
            sink: CollectingSink::with_capacity(0),
        }
    }

    #[test]
    fn aggregates_per_tunnel_tps_distribution() {
        let mut samples = TunnelSamples::new();
        samples.record(sample_with_tps(300.0));
        samples.record(sample_with_tps(500.0));
        let outcome = aggregate(
            samples,
            1000,
            900,
            1000,
            1000,
            AnchorCostSnapshot::default(),
            SuiPtbMetrics::default(),
            0,
        );

        assert!(outcome.per_tunnel_tps_play.peak >= 500.0);
        assert_eq!(outcome.per_tunnel_tps_e2e.peak, 250.0);
        assert_eq!(outcome.telemetry.count(StageId::Move), 0);
        assert_eq!(outcome.tunnels_failed, 0);
    }

    #[test]
    fn tunnel_samples_keep_exact_totals_and_bounded_reservoir() {
        let mut samples = TunnelSamples::new();
        let n = SAMPLE_RESERVOIR_CAP as u64 + 1_000;
        for _ in 0..n {
            samples.record(sample_with_tps(3.0));
        }
        // Headline totals stay exact regardless of the cap...
        assert_eq!(samples.claimed, n);
        assert_eq!(samples.committed_moves(), n * 3);
        // ...while retained per-tunnel samples never exceed the reservoir cap.
        assert_eq!(samples.reservoir.len(), SAMPLE_RESERVOIR_CAP);
    }

    #[test]
    fn export_bytes_total_stays_exact_beyond_reservoir_cap() {
        let mut samples = TunnelSamples::new();
        let n = SAMPLE_RESERVOIR_CAP as u64 + 1_000;
        for _ in 0..n {
            let mut sample = sample_with_tps(1.0);
            sample.export_bytes = 7;
            samples.record(sample);
        }
        // Exact running scalar across every tunnel — not a sum over the bounded
        // reservoir, which would undercount once the run exceeds the cap.
        assert_eq!(samples.export_bytes_total, n * 7);
        assert_eq!(samples.reservoir.len(), SAMPLE_RESERVOIR_CAP);
    }

    #[test]
    fn tunnel_ids_are_distinct_and_hex() {
        assert_eq!(tunnel_id_for(0), "0x1");
        assert_eq!(tunnel_id_for(254), "0xff");
        assert_ne!(tunnel_id_for(10), tunnel_id_for(11));
    }

    #[test]
    fn lifecycle_pipeline_executes_memory_anchor() {
        let out = run_lifecycle_pipeline(
            1,
            3600,
            Some(MoveTarget::Count(1)),
            1,
            ScenarioMode::Golden,
            FrameCodecKind::Json,
            AnchorMode::Memory,
            None,
            BLACKJACK_BET_V1,
            crate::protocols::DEFAULT_BALANCE,
            TunnelTelemetry {
                collect: false,
                record_transcript: false,
                heartbeat: None,
            },
            false,
        );
        assert!(out.moves >= 1);
        assert_eq!(out.tunnels_opened, 1);
        assert_eq!(out.tunnels_settled, 1);
        assert_eq!(out.tunnels_aborted, 0);
        assert!(out.bytes > 0, "frame bytes must be non-zero");
    }

    #[test]
    fn tunnel_task_panic_is_counted_as_aborted() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime");
        let (samples, aborted) = runtime.block_on(async {
            let mut tasks = JoinSet::new();
            tasks.spawn(async {
                panic!("synthetic tunnel task panic");
                #[allow(unreachable_code)]
                sample_with_tps(1.0)
            });

            let mut samples = TunnelSamples::new();
            let mut aborted = 0;
            while let Some(result) = tasks.join_next().await {
                if record_tunnel_join(&mut samples, result) {
                    aborted += 1;
                }
            }
            (samples, aborted)
        });

        assert!(samples.is_empty());
        assert_eq!(aborted, 1);
    }

    #[test]
    fn final_drain_aborts_pending_tunnel_tasks_after_timeout() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime");
        let (samples, aborted, empty) = runtime.block_on(async {
            let mut tasks = JoinSet::new();
            tasks.spawn(async {
                std::future::pending::<()>().await;
                #[allow(unreachable_code)]
                sample_with_tps(1.0)
            });

            let mut samples = TunnelSamples::new();
            let mut aborted = 0;
            drain_join_set_with_timeout(
                &mut tasks,
                &mut samples,
                &mut aborted,
                Duration::from_millis(5),
            )
            .await;
            (samples, aborted, tasks.is_empty())
        });

        assert!(samples.is_empty());
        assert_eq!(aborted, 1);
        assert!(empty);
    }

    #[test]
    fn first_play_wait_aborts_pending_tunnel_tasks_after_timeout() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime");
        let (start, samples, aborted, empty) = runtime.block_on(async {
            let stage_windows = StageWindowRecorder::new();
            let mut tasks = JoinSet::new();
            tasks.spawn(async {
                std::future::pending::<()>().await;
                #[allow(unreachable_code)]
                sample_with_tps(1.0)
            });

            let mut samples = TunnelSamples::new();
            let mut aborted = 0;
            let start = wait_for_first_play_window(
                &stage_windows,
                &mut tasks,
                &mut samples,
                &mut aborted,
                Duration::from_millis(5),
            )
            .await;
            (start, samples, aborted, tasks.is_empty())
        });

        assert!(start.is_none());
        assert!(samples.is_empty());
        assert_eq!(aborted, 1);
        assert!(empty);
    }

    #[test]
    fn preinitialized_lifecycle_pool_executes() {
        let out = run_lifecycle_pipeline(
            2,
            3600,
            Some(MoveTarget::Count(2)),
            2,
            ScenarioMode::Golden,
            FrameCodecKind::Json,
            AnchorMode::Memory,
            None,
            BLACKJACK_BET_V1,
            crate::protocols::DEFAULT_BALANCE,
            TunnelTelemetry {
                collect: false,
                record_transcript: false,
                heartbeat: None,
            },
            true,
        );
        assert!(out.moves >= 2);
        assert_eq!(out.tunnels_settled, out.tunnels_opened);
        assert_eq!(out.tunnels_aborted, 0);
    }

    #[test]
    fn varied_mode_settles_when_move_control_stops() {
        let samples = std::thread::Builder::new()
            .name("fleet-varied-mode-test".into())
            .stack_size(16 * 1024 * 1024)
            .spawn(|| {
                let runtime = tokio::runtime::Builder::new_multi_thread()
                    .enable_all()
                    .worker_threads(2)
                    .build()
                    .expect("test runtime");
                runtime.block_on(async {
                    let mut samples = TunnelSamples::new();
                    for tunnel_index in 0..8 {
                        let run_control = DriverRunControl::with_move_limit(20 + tunnel_index);
                        samples.record(
                            run_one_tunnel(
                                tunnel_index,
                                ScenarioMode::Varied,
                                FrameCodecKind::Bcs,
                                AnchorMode::Memory,
                                None,
                                BLACKJACK_BET_V1,
                                crate::protocols::DEFAULT_BALANCE,
                                crate::protocols::DEFAULT_MAX_MOVES_PER_TUNNEL,
                                TunnelTelemetry {
                                    collect: false,
                                    record_transcript: false,
                                    heartbeat: None,
                                },
                                SeatKitSource::Preinitialized(Box::new(random_seat_kit())),
                                Some(run_control),
                                None,
                            )
                            .await,
                        );
                    }
                    samples
                })
            })
            .expect("spawn test thread")
            .join()
            .expect("varied mode test thread");
        let moves_dist = summarize(
            &samples
                .reservoir
                .iter()
                .map(|sample| sample.moves as f64)
                .collect::<Vec<_>>(),
        );
        assert!(samples.reservoir.iter().all(|sample| sample.settle_ok));
        assert!(
            moves_dist.peak > moves_dist.min,
            "move-control samples should vary: {moves_dist:?}"
        );
        assert!(samples.reservoir.iter().all(|sample| sample.play_ns > 0));
    }

    #[test]
    fn golden_scenario_is_constant_143() {
        let out = run_lifecycle_pipeline(
            2,
            3600,
            Some(MoveTarget::Count(143)),
            1,
            ScenarioMode::Golden,
            FrameCodecKind::Json,
            AnchorMode::Memory,
            None,
            BLACKJACK_BET_V1,
            crate::protocols::DEFAULT_BALANCE,
            TunnelTelemetry {
                collect: false,
                record_transcript: false,
                heartbeat: None,
            },
            false,
        );
        assert_eq!(out.moves, 143);
        assert_eq!(out.moves_dist.min, 143.0);
        assert_eq!(out.moves_dist.peak, 143.0);
    }

    #[test]
    fn codec_choice_is_consensus_invisible() {
        let json = run_lifecycle_pipeline(
            2,
            3600,
            Some(MoveTarget::Count(143)),
            1,
            ScenarioMode::Golden,
            FrameCodecKind::Json,
            AnchorMode::Memory,
            None,
            BLACKJACK_BET_V1,
            crate::protocols::DEFAULT_BALANCE,
            TunnelTelemetry {
                collect: false,
                record_transcript: false,
                heartbeat: None,
            },
            false,
        );
        let bcs = run_lifecycle_pipeline(
            2,
            3600,
            Some(MoveTarget::Count(143)),
            1,
            ScenarioMode::Golden,
            FrameCodecKind::Bcs,
            AnchorMode::Memory,
            None,
            BLACKJACK_BET_V1,
            crate::protocols::DEFAULT_BALANCE,
            TunnelTelemetry {
                collect: false,
                record_transcript: false,
                heartbeat: None,
            },
            false,
        );
        let postcard = run_lifecycle_pipeline(
            2,
            3600,
            Some(MoveTarget::Count(143)),
            1,
            ScenarioMode::Golden,
            FrameCodecKind::Postcard,
            AnchorMode::Memory,
            None,
            BLACKJACK_BET_V1,
            crate::protocols::DEFAULT_BALANCE,
            TunnelTelemetry {
                collect: false,
                record_transcript: false,
                heartbeat: None,
            },
            false,
        );

        assert_eq!(bcs.moves, json.moves);
        assert_eq!(postcard.moves, json.moves);
        assert_eq!(bcs.tunnels_settled, json.tunnels_settled);
        assert_eq!(postcard.tunnels_settled, json.tunnels_settled);
        assert!(bcs.bytes < json.bytes && postcard.bytes < json.bytes);
    }

    #[test]
    fn blackjack_v2_matches_execute() {
        let out = run_lifecycle_pipeline(
            1,
            3600,
            Some(MoveTarget::Count(1)),
            1,
            ScenarioMode::Golden,
            FrameCodecKind::Json,
            AnchorMode::Memory,
            None,
            tunnel_core::protocol_id::BLACKJACK_V2,
            crate::protocols::DEFAULT_BALANCE,
            TunnelTelemetry {
                collect: false,
                record_transcript: false,
                heartbeat: None,
            },
            false,
        );
        assert!(out.moves > 0);
        assert_eq!(out.tunnels_settled, out.tunnels_opened);
        assert!(out.bytes > 0);
    }

    #[test]
    fn blackjack_v2_runs_with_one_unit_initial_balance() {
        let out = run_lifecycle_pipeline(
            1,
            3600,
            Some(MoveTarget::Count(1)),
            1,
            ScenarioMode::Golden,
            FrameCodecKind::Json,
            AnchorMode::Memory,
            None,
            tunnel_core::protocol_id::BLACKJACK_V2,
            1,
            TunnelTelemetry {
                collect: false,
                record_transcript: false,
                heartbeat: None,
            },
            false,
        );
        assert!(out.moves > 0);
        assert_eq!(out.tunnels_opened, 1);
        assert_eq!(out.tunnels_settled, 1);
    }

    #[test]
    fn payments_matches_execute() {
        let out = run_lifecycle_pipeline(
            1,
            3600,
            Some(MoveTarget::Count(1)),
            1,
            ScenarioMode::Golden,
            FrameCodecKind::Json,
            AnchorMode::Memory,
            None,
            tunnel_core::protocol_id::PAYMENTS_V1,
            crate::protocols::DEFAULT_BALANCE,
            TunnelTelemetry {
                collect: false,
                record_transcript: false,
                heartbeat: None,
            },
            false,
        );
        assert!(out.moves > 0);
        assert_eq!(out.tunnels_settled, out.tunnels_opened);
        assert!(out.bytes > 0);
    }

    fn run_simple_for_test(tunnel_count: u64, collect: bool) -> SwarmOutcome {
        run_lifecycle_pipeline(
            2,
            3600,
            Some(MoveTarget::Count(143 * tunnel_count)),
            1,
            ScenarioMode::Golden,
            FrameCodecKind::Json,
            AnchorMode::Memory,
            None,
            BLACKJACK_BET_V1,
            crate::protocols::DEFAULT_BALANCE,
            TunnelTelemetry {
                collect,
                record_transcript: false,
                heartbeat: None,
            },
            false,
        )
    }

    #[test]
    fn telemetry_collection_preserves_move_and_byte_invariants() {
        let n = 50u64;
        let off = run_simple_for_test(n, false);
        let on = run_simple_for_test(n, true);

        assert_eq!(off.moves, on.moves);
        assert_eq!(off.bytes, on.bytes);
        assert_eq!(on.moves, 143 * n);
        assert!(on.bytes > 0);
    }

    #[test]
    #[ignore = "timing-sensitive under parallel test load; run manually"]
    fn lifecycle_pipeline_refills_fixed_pool_across_duration_window() {
        // Duration-led: completed finite lifecycles are replaced until the
        // duration ends, then remaining in-flight tunnels drain naturally.
        // Ignored in CI: the fixed 1s window is starved of CPU when this runs
        // alongside the other heavy swarm tests on a small shared runner.
        let out = run_lifecycle_pipeline(
            2,
            1,
            None,
            2,
            ScenarioMode::Golden,
            FrameCodecKind::Json,
            AnchorMode::Memory,
            None,
            BLACKJACK_BET_V1,
            crate::protocols::DEFAULT_BALANCE,
            TunnelTelemetry {
                collect: false,
                record_transcript: false,
                heartbeat: None,
            },
            false,
        );
        assert!(
            out.tunnels_claimed > 2,
            "refill should replace completed lifecycles beyond the initial pool, got {}",
            out.tunnels_claimed
        );
        assert_eq!(out.tunnels_settled, out.tunnels_opened);
        assert_eq!(out.tunnels_aborted, 0);
        assert!(out.move_window_elapsed_ms <= out.elapsed_ms);
        assert!(out.open_active_elapsed_ms > 0);
        assert!(out.settle_active_elapsed_ms > 0);
        assert!(out.open_active_elapsed_ms <= out.elapsed_ms);
        assert!(out.settle_active_elapsed_ms <= out.elapsed_ms);
    }

    #[test]
    fn lifecycle_pipeline_move_target_drains_to_terminal_tunnel() {
        let out = run_lifecycle_pipeline(
            1,
            3600,
            Some(MoveTarget::Count(1)),
            1,
            ScenarioMode::Golden,
            FrameCodecKind::Json,
            AnchorMode::Memory,
            None,
            BLACKJACK_BET_V1,
            crate::protocols::DEFAULT_BALANCE,
            TunnelTelemetry {
                collect: false,
                record_transcript: false,
                heartbeat: None,
            },
            false,
        );

        assert!(out.moves >= 1);
        assert_eq!(out.tunnels_opened, 1);
        assert_eq!(out.tunnels_settled, 1);
        assert_eq!(out.tunnels_aborted, 0);
    }

    #[test]
    fn lifecycle_pipeline_settles_every_tunnel_under_high_concurrency() {
        // Many tunnels in flight share one run-level graceful control. When the
        // move target trips the run-wide stop, each tunnel must still reach its
        // own close boundary and settle. Regression for the shared-drain deadlock
        // that left one seat waiting and wedged large concurrent settlements.
        let out = run_lifecycle_pipeline(
            4,
            3600,
            Some(MoveTarget::Count(64)),
            32,
            ScenarioMode::Golden,
            FrameCodecKind::Json,
            AnchorMode::Memory,
            None,
            BLACKJACK_BET_V1,
            crate::protocols::DEFAULT_BALANCE,
            TunnelTelemetry {
                collect: false,
                record_transcript: false,
                heartbeat: None,
            },
            false,
        );

        assert!(out.moves >= 64);
        assert!(out.tunnels_opened >= 32);
        assert_eq!(out.tunnels_aborted, 0, "no tunnel may be left wedged");
        assert_eq!(
            out.tunnels_settled, out.tunnels_opened,
            "every opened tunnel must settle"
        );
    }

    #[test]
    fn lifecycle_pipeline_move_target_drains_concurrent_tunnels() {
        let out = run_lifecycle_pipeline(
            2,
            3600,
            Some(MoveTarget::Count(1)),
            2,
            ScenarioMode::Golden,
            FrameCodecKind::Json,
            AnchorMode::Memory,
            None,
            BLACKJACK_BET_V1,
            crate::protocols::DEFAULT_BALANCE,
            TunnelTelemetry {
                collect: false,
                record_transcript: false,
                heartbeat: None,
            },
            false,
        );

        assert!(out.moves >= 1);
        assert_eq!(out.tunnels_opened, 2);
        assert_eq!(out.tunnels_settled, out.tunnels_opened);
        assert_eq!(out.tunnels_claimed, out.tunnels_opened);
        assert_eq!(out.tunnels_aborted, 0);
    }

    #[test]
    fn max_moves_per_tunnel_keeps_move_targets_graceful() {
        assert_eq!(
            max_moves_per_tunnel_for_run(Some(MoveTarget::Count(1))),
            u64::MAX - 1
        );
        assert_eq!(
            max_moves_per_tunnel_for_run(Some(MoveTarget::Max)),
            u64::MAX - 1
        );
        assert_eq!(max_moves_per_tunnel_for_run(None), u64::MAX - 1);
    }

    #[test]
    #[ignore = "timing-sensitive under parallel test load; run manually"]
    fn lifecycle_pipeline_duration_stop_drains_in_flight_tunnels() {
        let out = run_lifecycle_pipeline(
            2,
            1,
            None,
            2,
            ScenarioMode::Golden,
            FrameCodecKind::Json,
            AnchorMode::Memory,
            None,
            BLACKJACK_BET_V1,
            crate::protocols::DEFAULT_BALANCE,
            TunnelTelemetry {
                collect: false,
                record_transcript: false,
                heartbeat: None,
            },
            false,
        );

        assert_eq!(out.tunnels_aborted, 0);
        assert_eq!(out.tunnels_settled, out.tunnels_opened);
        assert!(out.elapsed_ms >= out.move_window_elapsed_ms);
    }

    #[test]
    fn duration_end_stops_spawning_and_settles_active_tunnels() {
        let out = run_lifecycle_pipeline(
            1,
            0,
            None,
            1,
            ScenarioMode::Golden,
            FrameCodecKind::Json,
            AnchorMode::Memory,
            None,
            BLACKJACK_BET_V1,
            crate::protocols::DEFAULT_BALANCE,
            TunnelTelemetry {
                collect: false,
                record_transcript: false,
                heartbeat: None,
            },
            false,
        );

        assert_eq!(out.tunnels_claimed, 1);
        assert_eq!(out.tunnels_settled, 1);
        assert!(
            out.moves <= 3,
            "duration=0 should stop at the initial or first close boundary, got {} moves",
            out.moves
        );
        assert_eq!(out.tunnels_aborted, 0);
    }

    #[test]
    #[ignore = "timing-sensitive; run manually"]
    fn telemetry_collection_overhead_under_10pct() {
        let n = 100u64;
        let off = run_simple_for_test(n, false);
        let on = run_simple_for_test(n, true);
        let off_tps = off.moves as f64 * 1_000.0 / off.elapsed_ms.max(1) as f64;
        let on_tps = on.moves as f64 * 1_000.0 / on.elapsed_ms.max(1) as f64;
        let delta = (off_tps - on_tps).abs() / off_tps.max(1.0);

        println!(
            "telemetry off_tps={off_tps:.1} on_tps={on_tps:.1} delta={:.2}%",
            delta * 100.0
        );
        assert!(delta < 0.10, "telemetry delta {:.2}%", delta * 100.0);
    }
}
