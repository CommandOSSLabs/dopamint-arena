//! Decorator wrappers that time the existing anchor / recorder / transport
//! seams into a `TelemetrySink`. Shared state is `Arc`-based so the wrapper
//! satisfies the `PartyDriver` `Send + Sync` bounds and can be cloned into both
//! seats. `NullSink::record` is an inlined no-op, so the only off-state cost is
//! one uncontended lock per seam call — negligible vs the async transport.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::Serialize;
use tunnel_telemetry::{StageCost, StageId, StageSample, TelemetrySink};

use crate::anchor::{
    OpenedTunnel, SettledTunnel, TunnelAnchor, TunnelOpenRequest, TunnelSettleRequest,
};
use crate::error::FrameTransportError;
use crate::frame_transport::FrameTransport;
use crate::transcript::{
    Transcript, TranscriptCodec, TranscriptEntry, TranscriptError, TranscriptRecorder,
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
        // Read the clock before taking the lock so the recorded duration is the
        // seam's latency, not seam + lock-wait under cross-seat contention.
        let dur_ns = started.elapsed().as_nanos() as u64;
        let mut sink = self.sink.lock().expect("sink mutex poisoned");
        if sink.enabled() {
            sink.record(StageSample {
                stage,
                dur_ns,
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

/// Codec-agnostic byte length of a serialized output.
pub trait TranscriptSize {
    fn byte_len(&self) -> usize;
}
impl TranscriptSize for String {
    fn byte_len(&self) -> usize {
        self.len()
    }
}
impl TranscriptSize for Vec<u8> {
    fn byte_len(&self) -> usize {
        self.len()
    }
}

/// Times `TranscriptRecorder::record` (per-op) and export (with serialized byte
/// size). Each seat owns its recorder so `Mutex<S>` (not `Arc`) suffices —
/// `run` hands the recorder back and the bench reads `into_sink` on the
/// returned value.
pub struct InstrumentedRecorder<R, S> {
    inner: R,
    sink: Mutex<S>,
    collect: bool,
}

impl<R, S: TelemetrySink + Send> InstrumentedRecorder<R, S> {
    pub fn new(inner: R, sink: S) -> Self {
        let collect = sink.enabled();
        Self {
            inner,
            sink: Mutex::new(sink),
            collect,
        }
    }

    pub fn into_sink(self) -> S {
        self.sink.into_inner().expect("sink mutex poisoned")
    }

    /// Export, timing the call and capturing the serialized byte length.
    pub fn export_measured<M, C, T, F>(
        &self,
        codec: &C,
        preprocess: F,
    ) -> Result<(C::Output, usize), C::Error>
    where
        R: TranscriptRecorder<M>,
        C: TranscriptCodec,
        C::Output: TranscriptSize,
        F: FnMut(&TranscriptEntry<M>) -> Option<T>,
        T: Serialize,
    {
        let started = self.collect.then(Instant::now);
        let out = self.inner.export(codec, preprocess)?;
        let len = out.byte_len();
        if let Some(started) = started {
            let dur_ns = started.elapsed().as_nanos() as u64;
            let mut sink = self.sink.lock().expect("sink mutex poisoned");
            sink.record(StageSample {
                stage: StageId::RecorderExport,
                dur_ns,
                cost: StageCost {
                    gas_mist: 0,
                    paid_by: None,
                    bytes: len as u64,
                },
            });
        }
        Ok((out, len))
    }
}

impl<M, R: TranscriptRecorder<M> + Send + Sync, S: TelemetrySink + Send> TranscriptRecorder<M>
    for InstrumentedRecorder<R, S>
{
    fn records_transcript(&self) -> bool {
        self.inner.records_transcript()
    }

    fn record(&self, entry: TranscriptEntry<M>) -> Result<(), TranscriptError> {
        let started = self.collect.then(Instant::now);
        let result = self.inner.record(entry);
        if let Some(started) = started {
            let dur_ns = started.elapsed().as_nanos() as u64;
            let mut sink = self.sink.lock().expect("sink mutex poisoned");
            sink.record(StageSample {
                stage: StageId::RecorderRecord,
                dur_ns,
                cost: StageCost::default(),
            });
        }
        result
    }

    fn snapshot(&self) -> Transcript<TranscriptEntry<M>> {
        self.inner.snapshot()
    }

    fn set_tunnel_id(&self, tunnel_id: &str) {
        self.inner.set_tunnel_id(tunnel_id);
    }

    fn canonical_root_for_tunnel(&self, tunnel_id: &str) -> Result<[u8; 32], TranscriptError> {
        self.inner.canonical_root_for_tunnel(tunnel_id)
    }
}

#[cfg(test)]
mod recorder_tests {
    use super::*;
    use crate::transcript::{
        InMemoryTranscriptRecorder, JsonTranscriptCodec, RootOnlyTranscriptRecorder,
        TranscriptEntry, TranscriptRecorder,
    };
    use crate::Seat;
    use tunnel_telemetry::{CollectingSink, StageId};

    fn entry(nonce: u64) -> TranscriptEntry<u8> {
        TranscriptEntry {
            nonce,
            by: Seat::A,
            mv: 7u8,
            state_hash: [0u8; 32],
            timestamp: 0,
            party_a_balance: 200,
            party_b_balance: 200,
            sig_proposer: [0u8; 64],
            sig_responder: [0u8; 64],
        }
    }

    #[test]
    fn export_measured_returns_byte_len_and_records_sample() {
        let inner = InMemoryTranscriptRecorder::<u8>::default();
        let rec = InstrumentedRecorder::new(inner, CollectingSink::with_capacity(4));
        rec.record(entry(0)).unwrap();
        let (json, len) = rec
            .export_measured(&JsonTranscriptCodec, |e| Some(e.clone()))
            .unwrap();
        assert_eq!(len, json.len());
        let sink = rec.into_sink();
        assert_eq!(
            sink.samples()
                .iter()
                .filter(|s| s.stage == StageId::RecorderExport)
                .count(),
            1
        );
        assert!(sink
            .samples()
            .iter()
            .any(|s| s.stage == StageId::RecorderRecord));
    }

    #[test]
    fn instrumented_recorder_forwards_root_only_tunnel_id() {
        let rec = InstrumentedRecorder::new(
            RootOnlyTranscriptRecorder::<u8>::default(),
            CollectingSink::with_capacity(4),
        );

        rec.set_tunnel_id("0x1");
        rec.record(entry(0)).unwrap();

        assert!(rec.canonical_root_for_tunnel("0x1").is_ok());
        assert!(rec.snapshot().entries().is_empty());
    }
}

pub struct InstrumentedTransport<T, S> {
    inner: T,
    sink: Arc<Mutex<S>>,
    bytes_sent: Arc<AtomicU64>,
    collect: bool,
}

impl<T: Clone, S> Clone for InstrumentedTransport<T, S> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
            sink: Arc::clone(&self.sink),
            bytes_sent: Arc::clone(&self.bytes_sent),
            collect: self.collect,
        }
    }
}

impl<T, S: TelemetrySink + Send> InstrumentedTransport<T, S> {
    pub fn new(inner: T, sink: S) -> Self {
        let collect = sink.enabled();
        Self {
            inner,
            sink: Arc::new(Mutex::new(sink)),
            bytes_sent: Arc::new(AtomicU64::new(0)),
            collect,
        }
    }

    /// Drain the shared sink. Caller must hold the only remaining clone (after
    /// the driver that owns the moved-in clone has finished and dropped).
    pub fn into_sink(self) -> S {
        Arc::try_unwrap(self.sink)
            .unwrap_or_else(|_| panic!("transport sink still shared; drop the driver first"))
            .into_inner()
            .expect("sink mutex poisoned")
    }

    pub fn bytes_sent(&self) -> u64 {
        self.bytes_sent.load(Ordering::Relaxed)
    }

    /// Returns clones of the shared byte counter and sink Arc so the caller can
    /// read metrics after moving this wrapper into a driver. No `T: Clone` needed.
    pub fn handle(&self) -> (Arc<AtomicU64>, Arc<Mutex<S>>) {
        (Arc::clone(&self.bytes_sent), Arc::clone(&self.sink))
    }

    #[inline]
    fn emit(&self, stage: StageId, started: Instant, bytes: u64) {
        let dur_ns = started.elapsed().as_nanos() as u64;
        let mut sink = self.sink.lock().expect("sink mutex poisoned");
        sink.record(StageSample {
            stage,
            dur_ns,
            cost: StageCost {
                gas_mist: 0,
                paid_by: None,
                bytes,
            },
        });
    }
}

impl<T: FrameTransport, S: TelemetrySink + Send + 'static> FrameTransport
    for InstrumentedTransport<T, S>
{
    async fn send(&self, bytes: Vec<u8>) -> Result<(), FrameTransportError> {
        let len = bytes.len() as u64;
        let started = self.collect.then(Instant::now);
        let result = self.inner.send(bytes).await;
        if let Some(started) = started {
            self.emit(StageId::FrameSend, started, len);
        }
        if result.is_ok() {
            self.bytes_sent.fetch_add(len, Ordering::Relaxed);
        }
        result
    }

    async fn recv(&self) -> Result<Option<Vec<u8>>, FrameTransportError> {
        let started = self.collect.then(Instant::now);
        let result = self.inner.recv().await;
        if let Some(started) = started {
            let len = result
                .as_ref()
                .ok()
                .and_then(|o| o.as_ref())
                .map(|b| b.len() as u64)
                .unwrap_or(0);
            self.emit(StageId::FrameRecv, started, len);
        }
        result
    }
}

#[cfg(test)]
mod transport_tests {
    use super::*;
    use crate::frame_transport::{in_memory::InMemoryFrameTransport, FrameTransport};
    use tunnel_telemetry::{CollectingSink, StageId};

    fn _assert_send_sync<X: Send + Sync + 'static>() {}

    #[test]
    fn instrumented_transport_is_send_sync() {
        _assert_send_sync::<InstrumentedTransport<InMemoryFrameTransport, CollectingSink>>();
    }

    #[tokio::test]
    async fn send_records_framesend_with_byte_len_and_counts_bytes() {
        let (a, b) = InMemoryFrameTransport::pair();
        let ta = InstrumentedTransport::new(a, CollectingSink::with_capacity(4));
        ta.send(vec![1, 2, 3, 4, 5]).await.unwrap();
        assert_eq!(ta.bytes_sent(), 5);
        // Drain on the peer so the channel isn't dropped mid-flight.
        let _ = b.recv().await.unwrap();
        let sink = ta.into_sink();
        let send = sink
            .samples()
            .iter()
            .find(|s| s.stage == StageId::FrameSend)
            .unwrap();
        assert_eq!(send.cost.bytes, 5);
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
