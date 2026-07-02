//! Swarm-level determinism + conservation.
//!
//! `distribute` semantics (splitting targets across swarms) are applied by the
//! daemon; at the swarm level the guarantees are internal: a golden run is
//! reproducible and its per-tunnel play length is constant. These two invariants
//! are what make the fleet-wide totals a real conservation check rather than a
//! coincidence of timing, so they are pinned here against the public
//! `run_swarm_pipeline` seam.

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use fleet_superx::swarm::pipeline::{
    AnchorChoice, CohortConfig, SwarmOutcome, SwarmParams, run_swarm_pipeline,
};
use fleet_superx::swarm::protocol::{ProtocolKind, Scenario};

/// A golden, memory-anchored swarm of `tunnels` tunnels. Golden fixes the play
/// seed independent of tunnel index, so every tunnel plays the same deterministic
/// game — the source of both invariants asserted below.
fn golden_params(tunnels: u64) -> SwarmParams {
    SwarmParams {
        run_id: "golden".into(),
        swarm_index: 0,
        swarm_count: 1,
        tunnels,
        protocol: ProtocolKind::Payments,
        scenario: Scenario::Golden,
        // Large balances keep every sampled transfer affordable, so payments never
        // stalls on a drained seat and each tunnel plays a constant length.
        initial_balance: 1_000_000,
        anchor: AnchorChoice::Memory,
        cohorts: CohortConfig::unbounded(),
        workers: 2,
        duration_secs: 30,
        moves: None,
        heartbeat: None,
        telemetry_collect: false,
    }
}

fn stop() -> Arc<AtomicBool> {
    Arc::new(AtomicBool::new(false))
}

/// Run the (blocking) pipeline on a watchdog thread so a liveness regression fails
/// the test with a clear message instead of hanging the whole suite.
fn run_bounded(params: SwarmParams) -> SwarmOutcome {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(run_swarm_pipeline(params, stop()));
    });
    rx.recv_timeout(Duration::from_secs(30))
        .expect("pipeline must terminate within 30s, not hang")
}

#[test]
fn golden_swarm_is_deterministic_and_constant() {
    let a = run_bounded(golden_params(4));
    let b = run_bounded(golden_params(4));

    // (1) Determinism: identical params reproduce identical totals. A seed that
    // leaked timing/index nondeterminism into play would diverge here.
    assert_eq!(
        a.moves, b.moves,
        "identical golden params must reproduce identical move totals",
    );
    // Every tunnel opens, plays, and settles over the memory anchor.
    assert_eq!(a.tunnels_settled, 4);
    // (2) Constant per-tunnel length: with a golden (index-independent) seed all
    // four tunnels play the same number of moves, so the total is divisible by the
    // tunnel count. A swarm offset that changed per-tunnel move totals would break
    // this without necessarily breaking (1).
    assert_eq!(
        a.moves % 4,
        0,
        "golden per-tunnel moves must be constant (total {} not divisible by 4)",
        a.moves,
    );
}
