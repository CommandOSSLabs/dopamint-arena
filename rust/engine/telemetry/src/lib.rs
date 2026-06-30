//! Generic, near-zero-overhead bench telemetry: a sink trait with a
//! monomorphizing `NullSink`, a fixed stage taxonomy, per-stage cost, and
//! exact summary statistics shared across the fleet bench and serve.

mod aggregate;
mod sink;
mod stats;

pub use aggregate::RunTelemetry;
pub use sink::{
    AnchorPayer, CollectingSink, NullSink, StageCost, StageId, StageSample, TelemetrySink,
};
pub use stats::{summarize, Distribution};
