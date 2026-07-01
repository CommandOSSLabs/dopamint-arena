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
    sink: CollectingSink,
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
    samples: Vec<TunnelSample>,
    elapsed_ms: u128,
    move_window_elapsed_ms: u128,
    open_active_elapsed_ms: u128,
    settle_active_elapsed_ms: u128,
    gas: AnchorCostSnapshot,
    sui_ptb_metrics: SuiPtbMetrics,
    tunnels_aborted: u64,
) -> SwarmOutcome {
    let tunnels_claimed = samples.len() as u64;
    let tunnels_opened = samples.iter().filter(|s| s.open_ok).count() as u64;
    let tunnels_settled = samples.iter().filter(|s| s.settle_ok).count() as u64;
    let tunnels_failed = tunnels_claimed.saturating_sub(tunnels_settled);
    let moves: u64 = samples.iter().map(|s| s.moves).sum();
    let bytes: u64 = samples.iter().map(|s| s.bytes).sum();
    let play_ns_total: u128 = samples.iter().map(|s| s.play_ns).sum();
    let total_ns_total: u128 = samples.iter().map(|s| s.total_ns).sum();
    let moves_dist = summarize(&samples.iter().map(|s| s.moves as f64).collect::<Vec<_>>());
    let play_ns_dist = summarize(&samples.iter().map(|s| s.play_ns as f64).collect::<Vec<_>>());
    let per_tunnel_tps_play = summarize(
        &samples
            .iter()
            .filter(|s| s.play_ns > 0)
            .map(|s| s.moves as f64 * 1_000_000_000.0 / s.play_ns as f64)
            .collect::<Vec<_>>(),
    );
    let per_tunnel_tps_e2e = summarize(
        &samples
            .iter()
            .filter(|s| s.total_ns > 0)
            .map(|s| s.moves as f64 * 1_000_000_000.0 / s.total_ns as f64)
            .collect::<Vec<_>>(),
    );
    let telemetry = RunTelemetry::from_sinks(samples.iter().map(|s| s.sink.clone()).collect());
    // Single source of truth: export bytes come from the recorder's measured
    // `RecorderExport` samples, never double-counted with a separate total.
    let transcript_export_bytes = telemetry.export_bytes_total();

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
    kit: SeatKit,
    run_control: Option<DriverRunControl>,
    stage_windows: Option<StageWindowRecorder>,
) -> TunnelSample {
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
        sink: r.sink,
    }
}

fn record_tunnel_join(
    samples: &mut Vec<TunnelSample>,
    result: Result<TunnelSample, JoinError>,
) -> bool {
    match result {
        Ok(sample) => {
            samples.push(sample);
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
        Some(MoveTarget::Count(moves)) => moves.max(crate::protocols::DEFAULT_MAX_MOVES_PER_TUNNEL),
        Some(MoveTarget::Max) | None => u64::MAX - 1,
    }
}

fn move_target_count(moves: Option<MoveTarget>) -> Option<u64> {
    match moves {
        Some(MoveTarget::Count(moves)) => Some(moves),
        Some(MoveTarget::Max) | None => None,
    }
}

fn reached_move_target(samples: &[TunnelSample], moves: Option<MoveTarget>) -> bool {
    let Some(target) = move_target_count(moves) else {
        return false;
    };
    samples.iter().map(|sample| sample.moves).sum::<u64>() >= target
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
        let kit_for = |index: u64| -> SeatKit {
            if preinitialize {
                preinit_kits[index as usize % preinit_kits.len()].clone()
            } else {
                random_seat_kit()
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
                telemetry,
                kit_for(index),
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

        let mut samples = Vec::new();
        let mut tunnels_aborted = 0;
        let Some(move_window_started) = wait_for_first_play_window(
            &stage_windows_for_tasks,
            &mut tasks,
            &mut samples,
            &mut tunnels_aborted,
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
                if run_control_for_tasks.moves() > 0 {
                    run_control_for_tasks.request_stop();
                    break Instant::now();
                }
                match tokio::time::timeout(Duration::from_millis(1), tasks.join_next()).await {
                    Ok(Some(result)) => {
                        if record_tunnel_join(&mut samples, result) {
                            tunnels_aborted += 1;
                        }
                        if tasks.is_empty() {
                            break Instant::now();
                        }
                    }
                    Ok(None) => break Instant::now(),
                    Err(_) => {}
                }
                continue;
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

        while let Some(result) = tasks.join_next().await {
            if record_tunnel_join(&mut samples, result) {
                tunnels_aborted += 1;
            }
        }

        (
            samples,
            stop_observed_at
                .duration_since(move_window_started)
                .as_millis(),
            tunnels_aborted,
        )
    });
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
    let elapsed_ms = started.elapsed().as_millis();
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
    samples: &mut Vec<TunnelSample>,
    tunnels_aborted: &mut u64,
) -> Option<Instant> {
    loop {
        if let Some(start) = stage_windows.first_play_started() {
            return Some(start);
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
            sink: CollectingSink::with_capacity(0),
        }
    }

    #[test]
    fn aggregates_per_tunnel_tps_distribution() {
        let outcome = aggregate(
            vec![sample_with_tps(300.0), sample_with_tps(500.0)],
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

            let mut samples = Vec::new();
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
                    let mut samples = Vec::new();
                    for tunnel_index in 0..8 {
                        let run_control = DriverRunControl::with_move_limit(20 + tunnel_index);
                        samples.push(
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
                                },
                                random_seat_kit(),
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
                .iter()
                .map(|sample| sample.moves as f64)
                .collect::<Vec<_>>(),
        );
        assert!(samples.iter().all(|sample| sample.settle_ok));
        assert!(
            moves_dist.peak > moves_dist.min,
            "move-control samples should vary: {moves_dist:?}"
        );
        assert!(samples.iter().all(|sample| sample.play_ns > 0));
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
            },
            false,
        );
        assert!(
            out.tunnels_claimed > 2,
            "refill should replace completed lifecycles beyond the initial pool, got {}",
            out.tunnels_claimed
        );
        assert_eq!(out.tunnels_settled, out.tunnels_claimed);
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
            },
            false,
        );

        assert!(out.moves >= 1);
        assert_eq!(out.tunnels_opened, 1);
        assert_eq!(out.tunnels_settled, 1);
        assert_eq!(out.tunnels_aborted, 0);
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
    fn max_moves_per_tunnel_tracks_requested_benchmark_moves() {
        assert_eq!(
            max_moves_per_tunnel_for_run(Some(MoveTarget::Count(
                crate::protocols::DEFAULT_MAX_MOVES_PER_TUNNEL + 1,
            ))),
            crate::protocols::DEFAULT_MAX_MOVES_PER_TUNNEL + 1
        );
        assert_eq!(
            max_moves_per_tunnel_for_run(Some(MoveTarget::Max)),
            u64::MAX - 1
        );
        assert_eq!(max_moves_per_tunnel_for_run(None), u64::MAX - 1);
    }

    #[test]
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
            },
            false,
        );

        assert_eq!(out.tunnels_aborted, 0);
        assert_eq!(out.tunnels_settled, out.tunnels_claimed);
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
            },
            false,
        );

        assert_eq!(out.tunnels_claimed, 1);
        assert_eq!(out.tunnels_settled, 1);
        assert!(out.moves > 0);
        assert!(
            out.moves < 143,
            "duration=0 should stop at the first graceful close boundary, got {} moves",
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
