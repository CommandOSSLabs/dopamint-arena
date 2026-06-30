//! Decorator wrappers that time the existing anchor / recorder / transport
//! seams into a `TelemetrySink`. Shared state is `Arc`-based so the wrapper
//! satisfies the `PartyDriver` `Send + Sync` bounds and can be cloned into both
//! seats. `NullSink::record` is an inlined no-op, so the only off-state cost is
//! one uncontended lock per seam call — negligible vs the async transport.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tunnel_telemetry::{StageCost, StageId, StageSample, TelemetrySink};

use crate::anchor::{
    OpenedTunnel, SettledTunnel, TunnelAnchor, TunnelOpenRequest, TunnelSettleRequest,
};
use crate::TunnelAnchorError;

pub struct InstrumentedAnchor<A, S> {
    inner: A,
    sink: Arc<Mutex<S>>,
    opened: Arc<AtomicU64>,
    closed: Arc<AtomicU64>,
    failed: Arc<AtomicU64>,
}

impl<A: Clone, S> Clone for InstrumentedAnchor<A, S> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
            sink: Arc::clone(&self.sink),
            opened: Arc::clone(&self.opened),
            closed: Arc::clone(&self.closed),
            failed: Arc::clone(&self.failed),
        }
    }
}

impl<A, S: TelemetrySink + Send> InstrumentedAnchor<A, S> {
    pub fn new(inner: A, sink: S) -> Self {
        Self {
            inner,
            sink: Arc::new(Mutex::new(sink)),
            opened: Arc::new(AtomicU64::new(0)),
            closed: Arc::new(AtomicU64::new(0)),
            failed: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Drain the shared sink. Caller must hold the only remaining clone (after
    /// both drivers' `run` futures have completed and been dropped).
    pub fn into_sink(self) -> S {
        Arc::try_unwrap(self.sink)
            .unwrap_or_else(|_| panic!("anchor sink still shared; drop both drivers first"))
            .into_inner()
            .expect("sink mutex poisoned")
    }

    pub fn opened(&self) -> u64 {
        self.opened.load(Ordering::Relaxed)
    }

    pub fn closed(&self) -> u64 {
        self.closed.load(Ordering::Relaxed)
    }

    pub fn failed(&self) -> u64 {
        self.failed.load(Ordering::Relaxed)
    }

    #[inline]
    fn emit(&self, stage: StageId, started: Instant) {
        let mut sink = self.sink.lock().expect("sink mutex poisoned");
        if sink.enabled() {
            sink.record(StageSample {
                stage,
                dur_ns: started.elapsed().as_nanos() as u64,
                cost: StageCost::default(),
            });
        }
    }
}

impl<A: TunnelAnchor + Send + Sync, S: TelemetrySink + Send> TunnelAnchor
    for InstrumentedAnchor<A, S>
{
    fn settlement_mode(&self) -> crate::anchor::SettlementMode {
        self.inner.settlement_mode()
    }

    async fn open(&self, request: TunnelOpenRequest) -> Result<OpenedTunnel, TunnelAnchorError> {
        let started = Instant::now();
        let result = self.inner.open(request).await;
        self.emit(StageId::Open, started);
        match &result {
            Ok(_) => {
                self.opened.fetch_add(1, Ordering::Relaxed);
            }
            Err(_) => {
                self.failed.fetch_add(1, Ordering::Relaxed);
            }
        }
        result
    }

    async fn settle(
        &self,
        request: TunnelSettleRequest,
    ) -> Result<SettledTunnel, TunnelAnchorError> {
        let started = Instant::now();
        let result = self.inner.settle(request).await;
        self.emit(StageId::Settle, started);
        match &result {
            Ok(_) | Err(TunnelAnchorError::AlreadySettled) => {
                self.closed.fetch_add(1, Ordering::Relaxed);
            }
            Err(_) => {
                self.failed.fetch_add(1, Ordering::Relaxed);
            }
        }
        result
    }
}

#[cfg(test)]
mod anchor_tests {
    use super::*;
    use crate::anchor::{InMemoryAnchor, TunnelAnchor, TunnelOpenRequest};
    use crate::Balances;
    use tunnel_core::protocol_id::ProtocolId;
    use tunnel_telemetry::{CollectingSink, StageId};

    #[tokio::test]
    async fn open_records_one_open_sample_and_counts_opened() {
        let inner = InMemoryAnchor::with_fixed_id("tunnel-x");
        let anchor = InstrumentedAnchor::new(inner, CollectingSink::with_capacity(2));
        let _ = anchor
            .open(TunnelOpenRequest {
                protocol: ProtocolId::parse("blackjack.bet.v1").unwrap(),
                party_a: [1u8; 32],
                party_b: [2u8; 32],
                initial: Balances { a: 200, b: 200 },
            })
            .await
            .unwrap();
        assert_eq!(anchor.opened(), 1);
        let sink = anchor.into_sink();
        assert_eq!(
            sink.samples()
                .iter()
                .filter(|s| s.stage == StageId::Open)
                .count(),
            1
        );
    }
}
