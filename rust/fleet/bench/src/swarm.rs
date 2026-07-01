//! The local CPU fleet. Each requested tunnel is spawned as an async task and
//! driven through the same `PartyDriver` path as the serving fleet. Total work
//! under `--tunnel-concurrency N` with `ScenarioMode::Golden` is exact
//! (143*N moves), which is the golden regression gate; `--duration` is only a
//! guard that can end a run before all spawned tunnels complete.

use crate::cli::{AnchorMode, FrameCodecKind, ScenarioMode};
use crate::party_driver::{SeatKit, SuiSponsoredBenchContext, TunnelTelemetry};
use crate::protocols::{play_tunnel_for, PlayTunnelRequest};
use crate::stats::{summarize, Distribution};
use std::time::{Duration, Instant};
use sui_tunnel_anchor::AnchorCostSnapshot;
use tokio::task::JoinSet;
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
    pub play_ns_total: u128,
    pub total_ns_total: u128,
    pub moves_dist: Distribution,
    pub play_ns_dist: Distribution,
    pub tunnels_failed: u64,
    /// Tunnels that were in flight when the run ended (duration cutoff in
    /// steady-state, or the duration guard firing in burst mode) and were
    /// aborted without completing. Reported so abandoned work is visible rather
    /// than silently dropped from the counts.
    pub tunnels_aborted: u64,
    pub per_tunnel_tps_play: Distribution,
    pub per_tunnel_tps_e2e: Distribution,
    pub telemetry: RunTelemetry,
    pub gas_funder_mist: u64,
    pub gas_sponsor_mist: u64,
    pub transcript_export_bytes: u64,
}

/// Distinct, valid hex tunnel id per tunnel (offset by 1 to avoid the all-zero address).
pub fn tunnel_id_for(tunnel_index: u64) -> String {
    format!("0x{:x}", tunnel_index + 1)
}

fn aggregate(
    samples: Vec<TunnelSample>,
    elapsed_ms: u128,
    gas: AnchorCostSnapshot,
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
    telemetry: TunnelTelemetry,
    kit: SeatKit,
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
        kit: &kit,
        tunnel_id: &tunnel_id,
        anchor_mode,
        sui_context: sui_context.as_ref(),
        telemetry,
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

/// Reaps tasks that already finished but haven't been joined yet, so they count
/// as completed (their moves kept) rather than aborted. Without this, the
/// deadline path would abort just-finished tasks and undercount throughput.
fn reap_finished(tasks: &mut JoinSet<TunnelSample>, samples: &mut Vec<TunnelSample>) {
    while let Some(joined) = tasks.try_join_next() {
        if let Ok(sample) = joined {
            samples.push(sample);
        }
    }
}

/// Drains the burst's tasks, returning completed samples and the count of
/// tunnels still genuinely in flight when the `--duration` guard fired (aborted,
/// not completed). Returning the aborted count keeps abandoned work visible
/// instead of silently dropping it.
async fn collect_spawned_tunnels(
    mut tasks: JoinSet<TunnelSample>,
    duration_secs: u64,
) -> (Vec<TunnelSample>, u64) {
    let mut samples = Vec::new();
    if duration_secs == 0 {
        while let Some(result) = tasks.join_next().await {
            samples.push(result.expect("tunnel task joined"));
        }
        return (samples, 0);
    }

    let deadline = Instant::now() + Duration::from_secs(duration_secs);
    loop {
        if tasks.is_empty() {
            break;
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            reap_finished(&mut tasks, &mut samples);
            let aborted = tasks.len() as u64;
            tasks.abort_all();
            return (samples, aborted);
        }
        match tokio::time::timeout(remaining, tasks.join_next()).await {
            Ok(Some(result)) => samples.push(result.expect("tunnel task joined")),
            Ok(None) => break,
            Err(_) => {
                reap_finished(&mut tasks, &mut samples);
                let aborted = tasks.len() as u64;
                tasks.abort_all();
                return (samples, aborted);
            }
        }
    }
    (samples, 0)
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

#[allow(clippy::too_many_arguments)]
fn run_concurrent_with_kits<I>(
    workers: usize,
    duration_secs: u64,
    scenario: ScenarioMode,
    codec: FrameCodecKind,
    anchor_mode: AnchorMode,
    sui_context: Option<&SuiSponsoredBenchContext>,
    protocol_id: &'static str,
    telemetry: TunnelTelemetry,
    kits: I,
) -> SwarmOutcome
where
    I: IntoIterator<Item = (u64, SeatKit)>,
{
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .worker_threads(workers)
        .thread_name("fleet-bench-tunnel")
        .build()
        .expect("fleet bench runtime");
    let sui_context = sui_context.cloned();
    let gas_context = sui_context.clone();
    let tunnel_concurrency = kits.into_iter().collect::<Vec<_>>();
    let started = Instant::now();
    tracing::info!(
        concurrency = tunnel_concurrency.len(),
        workers,
        protocol_id,
        duration_secs,
        ?anchor_mode,
        ?codec,
        ?scenario,
        "fleet run start"
    );
    let gas_before = gas_context
        .as_ref()
        .map(SuiSponsoredBenchContext::cost_snapshot)
        .unwrap_or_default();
    let (samples, aborted) = runtime.block_on(async move {
        let mut tasks = JoinSet::new();
        for (tunnel_index, kit) in tunnel_concurrency {
            tasks.spawn(run_one_tunnel(
                tunnel_index,
                scenario,
                codec,
                anchor_mode,
                sui_context.clone(),
                protocol_id,
                telemetry,
                kit,
            ));
        }
        collect_spawned_tunnels(tasks, duration_secs).await
    });
    if aborted > 0 {
        tracing::warn!(
            completed = samples.len(),
            aborted,
            duration_secs,
            protocol_id,
            ?anchor_mode,
            "fleet duration guard aborted in-flight tunnels"
        );
    }
    let gas_after = gas_context
        .as_ref()
        .map(SuiSponsoredBenchContext::cost_snapshot)
        .unwrap_or_default();
    let gas = gas_delta(gas_before, gas_after);
    let outcome = aggregate(samples, started.elapsed().as_millis(), gas, aborted);
    tracing::info!(
        moves = outcome.moves,
        secs = outcome.elapsed_ms as f64 / 1000.0,
        tunnels_opened = outcome.tunnels_opened,
        tunnels_settled = outcome.tunnels_settled,
        tunnels_failed = outcome.tunnels_failed,
        tunnels_aborted = outcome.tunnels_aborted,
        "fleet run done"
    );
    outcome
}

#[allow(clippy::too_many_arguments)]
pub fn run_concurrent_tunnels(
    workers: usize,
    duration_secs: u64,
    tunnel_concurrency: u64,
    scenario: ScenarioMode,
    codec: FrameCodecKind,
    anchor_mode: AnchorMode,
    sui_context: Option<&SuiSponsoredBenchContext>,
    protocol_id: &'static str,
    telemetry: TunnelTelemetry,
) -> SwarmOutcome {
    let kits = (0..tunnel_concurrency).map(|idx| (idx, random_seat_kit()));
    run_concurrent_with_kits(
        workers,
        duration_secs,
        scenario,
        codec,
        anchor_mode,
        sui_context,
        protocol_id,
        telemetry,
        kits,
    )
}

#[cfg(test)]
#[allow(clippy::too_many_arguments)]
fn run_simple(
    workers: usize,
    duration_secs: u64,
    tunnels: Option<u64>,
    scenario: ScenarioMode,
    codec: FrameCodecKind,
    anchor_mode: AnchorMode,
    sui_context: Option<&SuiSponsoredBenchContext>,
    protocol_id: &'static str,
) -> SwarmOutcome {
    let tunnel_count = tunnels.unwrap_or(workers.max(1) as u64);
    let kits = (0..tunnel_count).map(|idx| (idx, SeatKit::new(&SEAT_A, &SEAT_B)));
    run_concurrent_with_kits(
        workers,
        duration_secs,
        scenario,
        codec,
        anchor_mode,
        sui_context,
        protocol_id,
        TunnelTelemetry {
            collect: false,
            record_transcript: false,
        },
        kits,
    )
}

/// Apples-to-apples-with-loadbench fleet: generates two fresh ed25519 keypairs
/// per tunnel (mirroring loadbench's per-tunnel `generateKeyPairSync`) inside the
/// timed window, then derives their public keys via `play_fixed_match_seeded`.
/// The efficient binary codec and native crypto stay; only the *harness* shape
/// (fresh per-tunnel key setup) is matched to loadbench. With
/// `ScenarioMode::Golden`, cards derive from `round`, so totals stay 143*N moves.
#[cfg(test)]
#[allow(clippy::too_many_arguments)]
fn run_fresh_keys(
    workers: usize,
    duration_secs: u64,
    tunnels: Option<u64>,
    scenario: ScenarioMode,
    codec: FrameCodecKind,
    anchor_mode: AnchorMode,
    sui_context: Option<&SuiSponsoredBenchContext>,
    protocol_id: &'static str,
) -> SwarmOutcome {
    run_concurrent_tunnels(
        workers,
        duration_secs,
        tunnels.unwrap_or(workers.max(1) as u64),
        scenario,
        codec,
        anchor_mode,
        sui_context,
        protocol_id,
        TunnelTelemetry {
            collect: false,
            record_transcript: false,
        },
    )
}

fn random_seat_kit() -> SeatKit {
    let mut secret_a = [0u8; 32];
    let mut secret_b = [0u8; 32];
    getrandom::getrandom(&mut secret_a).expect("os rng");
    getrandom::getrandom(&mut secret_b).expect("os rng");
    SeatKit::new(&secret_a, &secret_b)
}

/// Steady-state fleet: create every tunnel's signer material before the timed
/// window, then run exactly that many tunnels from the pre-built pool.
#[allow(clippy::too_many_arguments)]
pub fn run_preinitialized_signers(
    workers: usize,
    duration_secs: u64,
    tunnels: u64,
    scenario: ScenarioMode,
    codec: FrameCodecKind,
    anchor_mode: AnchorMode,
    sui_context: Option<&SuiSponsoredBenchContext>,
    protocol_id: &'static str,
    telemetry: TunnelTelemetry,
) -> SwarmOutcome {
    let kits: Vec<SeatKit> = (0..tunnels).map(|_| random_seat_kit()).collect();
    run_concurrent_with_kits(
        workers,
        duration_secs,
        scenario,
        codec,
        anchor_mode,
        sui_context,
        protocol_id,
        telemetry,
        kits.into_iter()
            .enumerate()
            .map(|(idx, kit)| (idx as u64, kit)),
    )
}

/// Duration-led steady state for `--tunnel-concurrency auto`: keep `in_flight`
/// tunnels running, relaunching each as it finishes, until `--duration` elapses.
/// Throughput is measured over the full window (stable), unlike a one-shot burst
/// that finishes in milliseconds. `preinitialize` builds the signer pool up front
/// so key generation stays out of the timed loop; otherwise each tunnel gets a
/// fresh keypair. Tunnels still running at the deadline are aborted and reported.
#[allow(clippy::too_many_arguments)]
pub fn run_steady_state(
    workers: usize,
    duration_secs: u64,
    in_flight: usize,
    scenario: ScenarioMode,
    codec: FrameCodecKind,
    anchor_mode: AnchorMode,
    sui_context: Option<&SuiSponsoredBenchContext>,
    protocol_id: &'static str,
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
    let pool = in_flight.max(1);
    let preinit_kits: Vec<SeatKit> = if preinitialize {
        (0..pool).map(|_| random_seat_kit()).collect()
    } else {
        Vec::new()
    };
    let started = Instant::now();
    tracing::info!(
        in_flight = pool,
        workers,
        protocol_id,
        duration_secs,
        ?anchor_mode,
        ?codec,
        ?scenario,
        preinitialize,
        "fleet steady-state start"
    );
    let gas_before = gas_context
        .as_ref()
        .map(SuiSponsoredBenchContext::cost_snapshot)
        .unwrap_or_default();
    let (samples, aborted) = runtime.block_on(async move {
        let deadline = Instant::now() + Duration::from_secs(duration_secs.max(1));
        let kit_for = |index: u64| -> SeatKit {
            if preinitialize {
                preinit_kits[index as usize % preinit_kits.len()].clone()
            } else {
                random_seat_kit()
            }
        };
        let mut tasks = JoinSet::new();
        let mut next_index: u64 = 0;
        for _ in 0..pool {
            tasks.spawn(run_one_tunnel(
                next_index,
                scenario,
                codec,
                anchor_mode,
                sui_context.clone(),
                protocol_id,
                telemetry,
                kit_for(next_index),
            ));
            next_index += 1;
        }
        let mut samples = Vec::new();
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            match tokio::time::timeout(remaining, tasks.join_next()).await {
                Ok(Some(result)) => {
                    samples.push(result.expect("tunnel task joined"));
                    // Refill to keep the pool full until the deadline.
                    if Instant::now() < deadline {
                        tasks.spawn(run_one_tunnel(
                            next_index,
                            scenario,
                            codec,
                            anchor_mode,
                            sui_context.clone(),
                            protocol_id,
                            telemetry,
                            kit_for(next_index),
                        ));
                        next_index += 1;
                    }
                }
                Ok(None) => break,
                Err(_) => break,
            }
        }
        // Reap tasks that finished during the final window so they're counted as
        // completed, not aborted.
        reap_finished(&mut tasks, &mut samples);
        let aborted = tasks.len() as u64;
        tasks.abort_all();
        (samples, aborted)
    });
    if aborted > 0 {
        tracing::warn!(
            completed = samples.len(),
            aborted,
            duration_secs,
            protocol_id,
            ?anchor_mode,
            "fleet steady-state duration ended with in-flight tunnels"
        );
    }
    let gas_after = gas_context
        .as_ref()
        .map(SuiSponsoredBenchContext::cost_snapshot)
        .unwrap_or_default();
    let gas = gas_delta(gas_before, gas_after);
    let outcome = aggregate(samples, started.elapsed().as_millis(), gas, aborted);
    tracing::info!(
        moves = outcome.moves,
        secs = outcome.elapsed_ms as f64 / 1000.0,
        tunnels = outcome.tunnels_claimed,
        tunnels_opened = outcome.tunnels_opened,
        tunnels_settled = outcome.tunnels_settled,
        tunnels_failed = outcome.tunnels_failed,
        tunnels_aborted = outcome.tunnels_aborted,
        "fleet steady-state done"
    );
    outcome
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
            AnchorCostSnapshot::default(),
            0,
        );

        assert!(outcome.per_tunnel_tps_play.peak >= 500.0);
        assert_eq!(outcome.per_tunnel_tps_e2e.peak, 250.0);
        assert_eq!(outcome.telemetry.count(StageId::Move), 0);
        assert_eq!(outcome.tunnels_failed, 0);
    }

    #[test]
    fn fresh_signers_conserve_totals() {
        // Fresh per-tunnel keys don't change gameplay (cards derive from round),
        // so the golden gate holds: exactly 143*N moves.
        // golden frame bytes are stable at 75_982/tunnel; exact total is asserted
        // in telemetry_collection_preserves_move_and_byte_invariants.
        let out = run_fresh_keys(
            2,
            3600,
            Some(6),
            ScenarioMode::Golden,
            FrameCodecKind::Json,
            AnchorMode::Memory,
            None,
            BLACKJACK_BET_V1,
        );
        assert_eq!(out.tunnels_claimed, 6);
        assert_eq!(out.tunnels_settled, 6);
        assert_eq!(out.moves, 143 * 6);
        assert!(out.bytes > 0, "frame bytes must be non-zero");
    }

    #[test]
    fn concurrent_tunnels_spawn_requested_count() {
        let out = run_concurrent_tunnels(
            2,
            0,
            8,
            ScenarioMode::Golden,
            FrameCodecKind::Json,
            AnchorMode::Memory,
            None,
            BLACKJACK_BET_V1,
            TunnelTelemetry {
                collect: false,
                record_transcript: false,
            },
        );
        assert_eq!(out.tunnels_claimed, 8);
        assert_eq!(out.tunnels_settled, 8);
        assert_eq!(out.moves, 143 * 8);
        assert!(out.bytes > 0, "frame bytes must be non-zero");
    }

    #[test]
    fn preinitialized_signers_match_baseline_totals() {
        let simple = run_simple(
            2,
            3600,
            Some(8),
            ScenarioMode::Golden,
            FrameCodecKind::Json,
            AnchorMode::Memory,
            None,
            BLACKJACK_BET_V1,
        );
        let preinitialized = run_preinitialized_signers(
            2,
            3600,
            8,
            ScenarioMode::Golden,
            FrameCodecKind::Json,
            AnchorMode::Memory,
            None,
            BLACKJACK_BET_V1,
            TunnelTelemetry {
                collect: false,
                record_transcript: false,
            },
        );
        assert_eq!(preinitialized.moves, simple.moves);
        assert_eq!(preinitialized.bytes, simple.bytes);
        assert_eq!(preinitialized.tunnels_settled, simple.tunnels_settled);
    }

    #[test]
    fn tunnel_ids_are_distinct_and_hex() {
        assert_eq!(tunnel_id_for(0), "0x1");
        assert_eq!(tunnel_id_for(254), "0xff");
        assert_ne!(tunnel_id_for(10), tunnel_id_for(11));
    }

    #[test]
    fn single_worker_golden_matches_are_constant() {
        // matches-bounded: exactly N matches => 143*N moves, N tunnels.
        // golden frame bytes are stable at 75_982/tunnel; exact total is asserted
        // in telemetry_collection_preserves_move_and_byte_invariants.
        let out = run_simple(
            1,
            3600,
            Some(5),
            ScenarioMode::Golden,
            FrameCodecKind::Json,
            AnchorMode::Memory,
            None,
            BLACKJACK_BET_V1,
        );
        assert_eq!(out.tunnels_claimed, 5);
        assert_eq!(out.tunnels_settled, 5);
        assert_eq!(out.moves, 143 * 5);
        assert!(out.bytes > 0, "frame bytes must be non-zero");
    }

    #[test]
    fn memory_anchor_mode_executes_matches() {
        let out = run_simple(
            1,
            3600,
            Some(2),
            ScenarioMode::Golden,
            FrameCodecKind::Json,
            AnchorMode::Memory,
            None,
            BLACKJACK_BET_V1,
        );
        assert_eq!(out.tunnels_opened, 2);
        assert_eq!(out.tunnels_settled, 2);
    }

    #[test]
    fn multi_worker_conserves_totals() {
        // Total work is fixed by --tunnel-concurrency regardless of worker count.
        // golden frame bytes are stable at 75_982/tunnel; exact total is asserted
        // in telemetry_collection_preserves_move_and_byte_invariants.
        let out = run_simple(
            4,
            3600,
            Some(20),
            ScenarioMode::Golden,
            FrameCodecKind::Json,
            AnchorMode::Memory,
            None,
            BLACKJACK_BET_V1,
        );
        assert_eq!(out.tunnels_claimed, 20);
        assert_eq!(out.tunnels_settled, 20);
        assert_eq!(out.moves, 143 * 20);
        assert!(out.bytes > 0, "frame bytes must be non-zero");
    }

    #[test]
    fn varied_mode_produces_a_nondegenerate_move_distribution() {
        let out = run_simple(
            2,
            3600,
            Some(24),
            ScenarioMode::Varied,
            FrameCodecKind::Bcs,
            AnchorMode::Memory,
            None,
            BLACKJACK_BET_V1,
        );
        assert_eq!(out.tunnels_settled, 24);
        assert_eq!(out.tunnels_claimed, 24);
        // Varied cards => not every match is 143 moves.
        assert!(
            out.moves_dist.peak > out.moves_dist.min,
            "moves should vary: {:?}",
            out.moves_dist
        );
        assert!(out.play_ns_total > 0);
        assert_eq!(
            out.tunnels_opened, out.tunnels_settled,
            "synchronous build: opened == settled"
        );
    }

    #[test]
    fn golden_scenario_is_constant_143() {
        let out = run_simple(
            2,
            3600,
            Some(50),
            ScenarioMode::Golden,
            FrameCodecKind::Json,
            AnchorMode::Memory,
            None,
            BLACKJACK_BET_V1,
        );
        assert_eq!(out.moves, 143 * 50);
        assert_eq!(out.moves_dist.min, 143.0);
        assert_eq!(out.moves_dist.peak, 143.0);
    }

    #[test]
    fn codec_choice_is_consensus_invisible() {
        let json = run_simple(
            2,
            3600,
            Some(8),
            ScenarioMode::Golden,
            FrameCodecKind::Json,
            AnchorMode::Memory,
            None,
            BLACKJACK_BET_V1,
        );
        let bcs = run_simple(
            2,
            3600,
            Some(8),
            ScenarioMode::Golden,
            FrameCodecKind::Bcs,
            AnchorMode::Memory,
            None,
            BLACKJACK_BET_V1,
        );
        let postcard = run_simple(
            2,
            3600,
            Some(8),
            ScenarioMode::Golden,
            FrameCodecKind::Postcard,
            AnchorMode::Memory,
            None,
            BLACKJACK_BET_V1,
        );

        assert_eq!(bcs.moves, json.moves);
        assert_eq!(postcard.moves, json.moves);
        assert_eq!(bcs.tunnels_settled, json.tunnels_settled);
        assert_eq!(postcard.tunnels_settled, json.tunnels_settled);
        assert!(bcs.bytes < json.bytes && postcard.bytes < json.bytes);
    }

    #[test]
    fn blackjack_v2_matches_execute() {
        let out = run_simple(
            1,
            3600,
            Some(3),
            ScenarioMode::Golden,
            FrameCodecKind::Json,
            AnchorMode::Memory,
            None,
            tunnel_core::protocol_id::BLACKJACK_V2,
        );
        assert_eq!(out.tunnels_claimed, 3);
        assert_eq!(out.tunnels_settled, 3);
        assert!(out.moves > 0);
        assert!(out.bytes > 0);
    }

    #[test]
    fn payments_matches_execute() {
        let out = run_simple(
            1,
            3600,
            Some(3),
            ScenarioMode::Golden,
            FrameCodecKind::Json,
            AnchorMode::Memory,
            None,
            tunnel_core::protocol_id::PAYMENTS_V1,
        );
        assert_eq!(out.tunnels_claimed, 3);
        assert_eq!(out.tunnels_settled, 3);
        assert!(out.moves > 0);
        assert!(out.bytes > 0);
    }

    fn run_simple_for_test(tunnel_count: u64, collect: bool) -> SwarmOutcome {
        run_concurrent_tunnels(
            2,
            0,
            tunnel_count,
            ScenarioMode::Golden,
            FrameCodecKind::Json,
            AnchorMode::Memory,
            None,
            BLACKJACK_BET_V1,
            TunnelTelemetry {
                collect,
                record_transcript: false,
            },
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
        assert_eq!(on.bytes, 75_982 * n);
    }

    #[test]
    #[ignore = "timing-sensitive; run manually"]
    fn steady_state_refills_pool_across_the_duration_window() {
        // Duration-led: a 4-deep pool relaunched for ~1s must complete far more
        // than 4 tunnels, proving the refill loop runs (not a one-shot burst).
        // Ignored in CI: the fixed 1s window is starved of CPU when this runs
        // alongside the other heavy swarm tests on a small shared runner, so the
        // throughput assertion is unreliable there. Run manually or in isolation.
        let out = run_steady_state(
            2,
            1,
            4,
            ScenarioMode::Golden,
            FrameCodecKind::Json,
            AnchorMode::Memory,
            None,
            BLACKJACK_BET_V1,
            TunnelTelemetry {
                collect: false,
                record_transcript: false,
            },
            false,
        );
        assert!(
            out.tunnels_claimed > 4,
            "refill should exceed the in-flight pool, got {}",
            out.tunnels_claimed
        );
        // Every completed golden tunnel is 143 moves; aborted ones aren't counted.
        assert_eq!(out.moves, 143 * out.tunnels_claimed);
        assert_eq!(out.tunnels_settled, out.tunnels_claimed);
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
