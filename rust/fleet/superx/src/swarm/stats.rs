//! Re-export of the shared telemetry statistics. The implementation now lives
//! in the `tunnel-telemetry` crate so the bench and serve share one summarizer.
pub use tunnel_telemetry::{summarize, Distribution};
