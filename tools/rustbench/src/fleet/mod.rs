//! Multi-core bench fleet: a rayon pool of long-lived workers running full
//! off-chain matches until a duration-or-matches stop, plus resource sampling.
pub mod resources;
pub mod swarm;
