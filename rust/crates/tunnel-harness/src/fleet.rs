//! Runs many tunnel units concurrently on the tokio runtime — one task per unit —
//! and aggregates a Metrics summary. No shared mutable state across tasks.

use crate::{DriverOutcome, HarnessError};
use std::future::Future;
use std::pin::Pin;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Metrics {
    pub tunnels: u64,
    pub total_moves: u64,
    pub settled: u64,
}

impl Metrics {
    pub fn settlement_success_rate(&self) -> f64 {
        if self.tunnels == 0 {
            0.0
        } else {
            self.settled as f64 / self.tunnels as f64
        }
    }
}

pub type DriverUnit =
    Pin<Box<dyn Future<Output = Result<DriverOutcome, HarnessError>> + Send>>;

pub struct FleetSupervisor;

impl FleetSupervisor {
    /// Spawn each unit as its own task; await all; aggregate. A unit that errors counts
    /// toward `tunnels` but not `settled`, and does not abort the fleet.
    pub async fn run_drivers(units: Vec<DriverUnit>) -> Metrics {
        let handles: Vec<_> = units.into_iter().map(tokio::spawn).collect();
        let mut m = Metrics::default();
        for h in handles {
            m.tunnels += 1;
            match h.await {
                Ok(Ok(outcome)) => {
                    m.total_moves += outcome.moves;
                    m.settled += 1;
                }
                Ok(Err(_)) | Err(_) => {}
            }
        }
        m
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Balances;

    fn ok_unit(moves: u64) -> DriverUnit {
        Box::pin(async move {
            Ok(DriverOutcome { moves, final_balances: Balances { a: 1, b: 1 } })
        })
    }
    fn err_unit() -> DriverUnit {
        Box::pin(async move { Err(HarnessError::Verification("boom".into())) })
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn aggregates_moves_and_success_rate() {
        let m = FleetSupervisor::run_drivers(vec![ok_unit(3), ok_unit(5), err_unit()]).await;
        assert_eq!(m.tunnels, 3);
        assert_eq!(m.total_moves, 8);
        assert_eq!(m.settled, 2);
        assert!((m.settlement_success_rate() - 2.0 / 3.0).abs() < 1e-9);
    }
}
