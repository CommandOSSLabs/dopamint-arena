//! staged swarm engine
//!
//! Submodules are added task-by-task (protocol, gates, anchor, settle_manager,
//! pipeline, resources, cgroup, stats, report, drain). Heartbeat is wired in a
//! later phase.
pub mod cli;
pub mod protocol;
pub mod gates;
pub mod anchor;
pub mod settle_manager;
pub mod pipeline;
pub mod resources;
pub mod cgroup;
pub mod stats;
pub mod report;
pub mod drain;
// pub mod heartbeat;

use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use crate::swarm::pipeline::{SwarmParams, run_swarm_pipeline};
use crate::swarm::report::{build_report, render_human};

/// Sampling cadence (ms) for the CPU/RSS resource sampler wrapping a swarm run.
const RESOURCE_SAMPLE_INTERVAL_MS: u64 = 250;

/// Entrypoint for the hidden `run-swarm` subcommand. Installs the graceful-stop
/// signal handler, samples resources around the staged pipeline, and prints the
/// swarm report (JSON for the daemon, human render otherwise). Returns 0 on a
/// completed run, 1 on a fatal setup error (bad flags).
pub fn run_swarm_main(args: cli::RunSwarmArgs) -> i32 {
    let json = args.wants_json();
    let params = match args.to_params() {
        Ok(params) => params,
        Err(err) => {
            eprintln!("run-swarm: {err}");
            return 1;
        }
    };

    // build_report only reads the run identity and phase windows from the params;
    // the pipeline consumes the real params (including the non-clonable anchor), so
    // snapshot the identity first to feed the report afterwards.
    let report_identity = report_identity(&params);

    let stop = Arc::new(AtomicBool::new(false));
    drain::install_graceful_stop(Arc::clone(&stop));

    let sampler = resources::start(RESOURCE_SAMPLE_INTERVAL_MS, params.workers);
    let outcome = run_swarm_pipeline(params, stop);
    let resource_summary = sampler.stop();

    let report = build_report(&report_identity, &outcome, &resource_summary);
    if json {
        match serde_json::to_string(&report) {
            Ok(line) => println!("{line}"),
            Err(err) => {
                eprintln!("run-swarm: report serialization failed: {err}");
                return 1;
            }
        }
    } else {
        println!("{}", render_human(&report));
    }
    0
}

/// Snapshot the report-relevant identity of a swarm's params before the pipeline
/// consumes them. Only the fields [`build_report`] reads carry real values; the
/// rest are inert placeholders it never inspects.
fn report_identity(params: &SwarmParams) -> SwarmParams {
    use crate::swarm::pipeline::{AnchorChoice, CohortConfig};
    SwarmParams {
        run_id: params.run_id.clone(),
        swarm_index: params.swarm_index,
        swarm_count: params.swarm_count,
        tunnels: params.tunnels,
        protocol: params.protocol,
        scenario: params.scenario,
        initial_balance: params.initial_balance,
        anchor: AnchorChoice::Memory,
        cohorts: CohortConfig::unbounded(),
        workers: params.workers,
        duration_secs: params.duration_secs,
        moves: params.moves,
        heartbeat: None,
        telemetry_collect: params.telemetry_collect,
    }
}
