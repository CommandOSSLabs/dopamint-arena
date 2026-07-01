//! The bench fleet: bots vs bots in-process on Tokio, driving the sans-IO core to
//! prove off-chain throughput and the golden regression gate.
pub mod cgroup;
pub mod cli;
pub mod heartbeat;
pub mod humanize;
pub mod party_driver;
pub mod protocols;
pub mod report;
pub mod resources;
pub mod stats;
pub mod swarm;

pub use party_driver::{play_tunnel_seeded, SeatKit, TunnelOutcome};
