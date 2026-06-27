//! The bench fleet: bots vs bots in-process on rayon, driving the sans-IO core to
//! prove off-chain throughput and the deterministic regression gate.
pub mod cgroup;
pub mod cli;
pub mod driver;
pub mod report;
pub mod resources;
pub mod stats;
pub mod swarm;

pub use driver::{play_match_seeded, MatchResult, SeatKit};
