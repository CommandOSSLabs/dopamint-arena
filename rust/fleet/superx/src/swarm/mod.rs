//! staged swarm engine
//!
//! Submodules are added task-by-task (protocol, gates, anchor, settle_manager,
//! pipeline, resources, cgroup, stats, report, heartbeat, drain). Only the CLI
//! surface exists in the skeleton.
pub mod cli;
// pub mod protocol;
// pub mod gates;
// pub mod anchor;
// pub mod settle_manager;
// pub mod pipeline;
pub mod resources;
pub mod cgroup;
pub mod stats;
// pub mod report;
// pub mod heartbeat;
// pub mod drain;

/// Entrypoint for the hidden `run-swarm` subcommand (filled in later tasks).
pub fn run_swarm_main(_a: cli::RunSwarmArgs) -> i32 {
    eprintln!("not implemented");
    2
}
