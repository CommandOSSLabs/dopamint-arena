//! The serving fleet: bots acting as the async counterparty to remote users over
//! a `Channel`, driving the sans-IO `TunnelSeat` core. tokio lives here, not in
//! the core.
pub mod channel;
pub use channel::{in_memory::InMemoryChannel, Channel};

pub mod policy;
pub use policy::{random::RandomPolicy, Policy};
