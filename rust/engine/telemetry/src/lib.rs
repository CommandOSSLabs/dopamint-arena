//! Generic, near-zero-overhead bench telemetry: a sink trait with a
//! monomorphizing `NullSink`, a fixed stage taxonomy, per-stage cost, and
//! exact summary statistics shared across the fleet bench and serve.

mod stats;

pub use stats::{summarize, Distribution};
