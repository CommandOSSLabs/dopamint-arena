//! The bench fleet: bots vs bots in-process on rayon, driving the sans-IO core to
//! prove off-chain throughput and the golden regression gate.
pub mod cgroup;
pub mod cli;
pub mod party_driver;
pub mod report;
pub mod resources;
pub mod stats;
pub mod swarm;

pub use party_driver::{play_match_seeded, MatchResult, SeatKit};
