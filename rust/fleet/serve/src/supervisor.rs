//! Runs many serving units concurrently on the tokio runtime — one task per unit —
//! and aggregates a Metrics summary. No shared mutable state across tasks.

use std::future::Future;
use std::pin::Pin;

use crate::heartbeat::HeartbeatReporter;
use tunnel_harness::{
    DriverOutcome, FrameTransport, HarnessError, MoveStrategy, PartyDriver, Protocol, Signer,
    TranscriptRecorder, TunnelAnchor,
};

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

pub type DriverUnit = Pin<Box<dyn Future<Output = Result<DriverOutcome, HarnessError>> + Send>>;

pub struct FleetSupervisor;

impl FleetSupervisor {
    /// Spawn each unit as its own task; await all; aggregate. A unit that errors counts
    /// toward `tunnels` but not `settled`, and does not abort the fleet.
    pub async fn run_drivers(units: Vec<DriverUnit>) -> Metrics {
        let handles: Vec<_> = units.into_iter().map(tokio::spawn).collect();
        let mut m = Metrics::default();
        for h in handles {
            m.tunnels += 1;
            if let Ok(Ok(outcome)) = h.await {
                m.total_moves += outcome.moves;
                m.settled += 1;
            }
        }
        m
    }
}

/// Build a supervisable serving unit: attach the session owner's `HeartbeatReporter`
/// as a lifecycle observer, then box the driver's run future as a `DriverUnit`.
///
/// This is the one production seam wiring telemetry into a serving driver. The
/// reporter is fire-and-forget, so a heartbeat failure never blocks the move loop.
/// Attaching a reporter is the act of claiming ownership: only call this for a
/// tunnel whose session this party registered (and whose `stats_token` it holds).
///
/// The returned `DriverUnit` must be polled within a tokio runtime: the reporter
/// spawns its POSTs onto the ambient runtime (as `FleetSupervisor` does).
pub fn into_serving_unit<P, Pol, Ch, S, A, R>(
    driver: PartyDriver<P, Pol, Ch, S, A, R>,
    reporter: HeartbeatReporter,
    max_moves: u64,
    now: impl FnMut() -> u64 + Send + 'static,
) -> DriverUnit
where
    P: Protocol,
    Pol: MoveStrategy<P>,
    Ch: FrameTransport,
    S: Signer,
    A: TunnelAnchor + Send + Sync + 'static,
    R: TranscriptRecorder<P::Move> + Send + Sync + 'static,
{
    Box::pin(async move {
        driver
            .observe(Box::new(reporter))
            .run(max_moves, now)
            .await
            .map(|(outcome, _recorder)| outcome)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tunnel_harness::Balances;

    fn ok_unit(moves: u64) -> DriverUnit {
        Box::pin(async move {
            Ok(DriverOutcome {
                moves,
                final_balances: Balances { a: 1, b: 1 },
                play_ns: 0,
            })
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
