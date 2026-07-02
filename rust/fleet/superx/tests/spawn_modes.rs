//! Spawn-mode integration: drive the real `run-swarm` worker (this crate's own
//! binary, reachable via `CARGO_BIN_EXE_fleet-superx`) through each fan-out mode
//! and assert tunnel conservation plus, for `sequential`, real-time non-overlap.

use std::path::Path;
use std::time::{Duration, Instant};

use fleet_superx::proto::{CohortWire, SpawnMode};
use fleet_superx::runconfig::RunConfig;
use fleet_superx::spawn::{run_replicate_or_distribute, run_sequential};

/// The `run-swarm` worker binary: this crate's own bin target. `CARGO_BIN_EXE_*`
/// is set for integration tests because the binary lives in this same crate.
fn worker_exe() -> &'static Path {
    Path::new(env!("CARGO_BIN_EXE_fleet-superx"))
}

fn unbounded_cohorts() -> CohortWire {
    CohortWire {
        open_cohort: None,
        open_spacing: Duration::ZERO,
        settle_cohort: None,
        settle_spacing: Duration::ZERO,
    }
}

fn memory_cfg(mode: SpawnMode, swarms: u64, tunnels: u64, cohorts: CohortWire) -> RunConfig {
    RunConfig {
        run_id: format!("it-{mode:?}-{swarms}x{tunnels}").to_lowercase(),
        mode,
        swarms,
        protocol: "payments.v1".to_string(),
        duration: Duration::ZERO,
        until_stop: false,
        tunnels,
        scenario: "golden".to_string(),
        anchor: "memory".to_string(),
        initial_balance: 1_000_000,
        cohorts,
        extra: Vec::new(),
        heartbeat_sink: None,
        sui: fleet_superx::runconfig::SuiRunConfig::default(),
    }
}

#[tokio::test]
async fn distribute_two_swarms_conserves() {
    let cfg = memory_cfg(SpawnMode::Distribute, 2, 4, unbounded_cohorts());
    let reports: Vec<_> = run_replicate_or_distribute(worker_exe(), &cfg)
        .await
        .into_iter()
        .map(|r| r.expect("swarm report"))
        .collect();

    assert_eq!(reports.len(), 2);
    // Distribute splits the 4 tunnels across the 2 swarms, so the run total is
    // exactly the requested tunnel count — no swarm dropped or duplicated work.
    assert_eq!(
        reports.iter().map(|r| r.tunnels_settled).sum::<u64>(),
        4,
        "distribute must conserve the total tunnel count across swarms",
    );
}

#[tokio::test]
async fn replicate_multiplies_tunnels_across_swarms() {
    let cfg = memory_cfg(SpawnMode::Replicate, 2, 3, unbounded_cohorts());
    let reports: Vec<_> = run_replicate_or_distribute(worker_exe(), &cfg)
        .await
        .into_iter()
        .map(|r| r.expect("swarm report"))
        .collect();

    assert_eq!(reports.len(), 2);
    // Replicate gives every swarm the full per-swarm tunnel count, so the run
    // total is swarms * tunnels — the multiplying fan-out.
    for report in &reports {
        assert_eq!(report.tunnels_settled, 3);
    }
    assert_eq!(reports.iter().map(|r| r.tunnels_settled).sum::<u64>(), 6);
}

#[tokio::test]
async fn sequential_runs_one_swarm_at_a_time() {
    // Open spacing gives each swarm a wall-clock floor driven by *sleeps* (not
    // CPU), so per-swarm `elapsed_ms` is substantial and core-count independent.
    // In sequential mode each swarm's run window is disjoint in real time, so the
    // measured wall must be at least the sum of the per-swarm windows. A regression
    // that ran the swarms concurrently would overlap those windows and measure far
    // less than their sum.
    let cohorts = CohortWire {
        open_cohort: Some(1),
        open_spacing: Duration::from_millis(100),
        settle_cohort: None,
        settle_spacing: Duration::ZERO,
    };
    let cfg = memory_cfg(SpawnMode::Sequential, 3, 3, cohorts);

    let started = Instant::now();
    let reports: Vec<_> = run_sequential(worker_exe(), &cfg)
        .await
        .into_iter()
        .map(|r| r.expect("swarm report"))
        .collect();
    let wall_ms = started.elapsed().as_millis();

    assert_eq!(reports.len(), 3);
    assert_eq!(reports.iter().map(|r| r.tunnels_settled).sum::<u64>(), 9);

    let sum_elapsed_ms: u128 = reports.iter().map(|r| r.elapsed_ms).sum();
    assert!(
        wall_ms >= sum_elapsed_ms,
        "sequential wall {wall_ms}ms must be >= the sum of per-swarm windows \
         {sum_elapsed_ms}ms; overlapping windows mean the swarms ran concurrently",
    );
}
