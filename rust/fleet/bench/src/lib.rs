//! The bench fleet: bots vs bots in-process on rayon, driving the sans-IO core to
//! prove off-chain throughput and the deterministic regression gate.
pub mod driver;
pub mod stats;
pub mod swarm;

pub use driver::{play_match_seeded, MatchResult, SeatKit};
