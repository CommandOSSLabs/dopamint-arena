//! The bench fleet: bots vs bots in-process on Tokio, driving the sans-IO core to
//! prove off-chain throughput and the golden regression gate.
pub mod cgroup;
pub mod cli;
pub mod heartbeat;
pub mod humanize;
pub mod party_driver;
mod pre_open_gate;
pub mod protocols;
pub mod report;
pub mod resources;
mod settle_wave_gate;
pub mod stats;
pub mod swarm;

pub use party_driver::{play_tunnel_seeded, SeatKit, TunnelOutcome};
