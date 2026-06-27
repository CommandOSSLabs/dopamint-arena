//! The serving fleet: bots acting as the async counterparty to remote users by
//! running `tunnel-harness` party drivers under tokio.

pub mod supervisor;
pub use supervisor::{DriverUnit, FleetSupervisor, Metrics};
