//! fleet-superx entrypoint: one binary, subcommands for daemon + client + swarm worker.
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "fleet-superx")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run the supervisor daemon.
    Daemon(fleet_superx::daemon::DaemonArgs),
    /// Start a swarm run.
    Start(fleet_superx::client::StartArgs),
    /// Stop a swarm run.
    Stop(fleet_superx::client::StopArgs),
    /// List swarm runs.
    Ls(fleet_superx::client::LsArgs),
    /// Watch a run's live monitoring.
    Watch(fleet_superx::client::WatchArgs),
    /// Internal: run one swarm (spawned by the daemon).
    #[command(hide = true, name = "run-swarm")]
    RunSwarm(fleet_superx::swarm::cli::RunSwarmArgs),
}

fn main() {
    let cli = Cli::parse();
    let code = match cli.cmd {
        Cmd::RunSwarm(a) => fleet_superx::swarm::run_swarm_main(a),
        Cmd::Daemon(a) => fleet_superx::daemon::daemon_main(a),
        Cmd::Start(a) => fleet_superx::client::start_main(a),
        Cmd::Stop(a) => fleet_superx::client::stop_main(a),
        Cmd::Ls(a) => fleet_superx::client::ls_main(a),
        Cmd::Watch(a) => fleet_superx::client::watch_main(a),
    };
    std::process::exit(code);
}
