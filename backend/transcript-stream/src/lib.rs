//! Streams the co-signed transcript to S3 in chunks *during play* with a **hard, DDoS-proof RAM
//! ceiling**: many concurrent sessions can't exhaust server memory even if S3 stalls.
//!
//! - [`S3StreamingRecorder`] wraps [`RootOnlyTranscriptRecorder`] (the O(log N) Merkle frontier root)
//!   and a small byte buffer. `record()` appends the 250 B settle-entry and, once the buffer crosses
//!   [`CHUNK_TARGET`], hands the chunk to the shared [`TranscriptUploader`]. `finish()` flushes the
//!   tail and seals a [`TranscriptManifest`].
//! - [`TranscriptUploader`] is one per instance: a **bounded queue** (the byte-budget) drained by a
//!   worker pool. When the queue is full (S3 behind), producers **block** — never drop, never OOM.
//!   RAM is capped at `UPLOAD_BUDGET_CHUNKS + UPLOAD_WORKERS` chunks regardless of session count.
//!
//! Chunk bytes go through the same [`encode_settle_entry`] as the settle body, so reassembled
//! chunks reproduce exactly what the on-chain root commits to.
//!
//! Both the sink ([`TranscriptUploader`]) and the finish-path writer are abstracted over
//! [`transcript_store::TranscriptChunkWriter`], so a consumer drives the *same* recorder against
//! either the production [`transcript_store::S3TranscriptStore`] or the in-memory
//! `transcript_store::testing::FakeChunkStore`.

use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;
use tokio::sync::mpsc::error::TrySendError;
use transcript_store::{TranscriptChunkWriter, TranscriptManifest};
use tunnel_core::wire::{encode_settle_entry, SettleBodyEntry, SETTLE_BODY_VERSION};
use tunnel_harness::{
    RootOnlyTranscriptRecorder, Transcript, TranscriptEntry, TranscriptError, TranscriptRecorder,
    TranscriptSettleEntry,
};

/// Flush a chunk once the buffer reaches ~1 MB (~4000 entries). Bounds per-session RAM and caps
/// `PutObject`s at ~⌈25 MB / 1 MB⌉ per match — one S3 call per ~4000 moves, never per move.
const CHUNK_TARGET: usize = 1024 * 1024;

/// Max chunks queued for upload across ALL sessions on this instance — the byte-budget. Queued RAM
/// ≈ this × [`CHUNK_TARGET`] (~512 MB). When full, producers block (backpressure).
const UPLOAD_BUDGET_CHUNKS: usize = 512;
/// Max concurrent S3 `put_chunk`s draining the queue.
const UPLOAD_WORKERS: usize = 32;

/// One chunk handed to the [`TranscriptUploader`].
pub struct ChunkUpload {
    pub tunnel_id: String,
    pub seq: u32,
    pub bytes: Vec<u8>,
}

/// Per-instance bounded uploader — the byte-budget that keeps streaming RAM-safe under S3 slowdown.
/// Every session's recorder pushes chunks into one bounded channel; a worker pool drains it to S3
/// with bounded concurrency. A full channel means S3 can't keep up, so producers **block**
/// (backpressure) rather than pile chunks in RAM or drop them.
pub struct TranscriptUploader {
    tx: mpsc::Sender<ChunkUpload>,
}

impl TranscriptUploader {
    /// Spawn the drain task over `writer`. Each recorder clones [`sender`](Self::sender) to stream.
    pub fn spawn(writer: Arc<dyn TranscriptChunkWriter>) -> Self {
        let (tx, mut rx) = mpsc::channel::<ChunkUpload>(UPLOAD_BUDGET_CHUNKS);
        tokio::spawn(async move {
            let concurrency = Arc::new(tokio::sync::Semaphore::new(UPLOAD_WORKERS));
            while let Some(upload) = rx.recv().await {
                // Acquire a worker slot first, so `recv` stops pulling when all workers are busy —
                // the channel then fills and producers feel backpressure.
                let permit = concurrency
                    .clone()
                    .acquire_owned()
                    .await
                    .expect("upload semaphore open");
                let writer = writer.clone();
                tokio::spawn(async move {
                    let ChunkUpload {
                        tunnel_id,
                        seq,
                        bytes,
                    } = upload;
                    if let Err(e) = writer.put_chunk(&tunnel_id, seq, bytes).await {
                        tracing::warn!(tunnel = %tunnel_id, seq, error = %e, "transcript chunk upload failed");
                    }
                    drop(permit);
                });
            }
        });
        Self { tx }
    }

    /// A sender each recorder clones to stream its chunks through the shared budget.
    pub fn sender(&self) -> mpsc::Sender<ChunkUpload> {
        self.tx.clone()
    }
}

#[derive(Default)]
struct ChunkBuf {
    bytes: Vec<u8>,
    /// Next chunk sequence number; equals the total chunk count once the tail is flushed.
    seq: u32,
    /// Cumulative bytes across all flushed chunks — sealed into the manifest's `total_bytes`.
    total_bytes: u64,
}

/// Root recorder + streaming S3 uploader. Cheaply cloneable (Arc-shared state): one clone drives
/// the game, another is retained to `finish()` the tail + seal after the driver returns.
pub struct S3StreamingRecorder<M> {
    inner: RootOnlyTranscriptRecorder<M>,
    tunnel_id: String,
    /// Mid-play chunk sink (bounded, backpressured). `None` = no streaming (dev/test).
    tx: Option<mpsc::Sender<ChunkUpload>>,
    /// Direct writer for the finish path (tail chunk + manifest seal). `None` = no S3.
    writer: Option<Arc<dyn TranscriptChunkWriter>>,
    buf: Arc<Mutex<ChunkBuf>>,
}

// Manual `Clone` (not derived): `M` is only a `PhantomData` marker, so cloning must not require
// `M: Clone`. The inner recorder + buffer are `Arc`-shared, so a clone and the original see the
// same root + chunk state (the play clone's root is visible to the retained handle's `finish()`).
impl<M> Clone for S3StreamingRecorder<M> {
    fn clone(&self) -> Self {
        Self {
            inner: self.inner.clone(),
            tunnel_id: self.tunnel_id.clone(),
            tx: self.tx.clone(),
            writer: self.writer.clone(),
            buf: self.buf.clone(),
        }
    }
}

impl<M> S3StreamingRecorder<M> {
    /// `tx` streams chunks during play (backpressured via the shared budget); `writer` uploads the
    /// tail + seals the manifest at `finish()`. Both `None` degrades to a plain root recorder.
    pub fn new(
        tunnel_id: impl Into<String>,
        tx: Option<mpsc::Sender<ChunkUpload>>,
        writer: Option<Arc<dyn TranscriptChunkWriter>>,
    ) -> Self {
        let tunnel_id = tunnel_id.into();
        let inner = RootOnlyTranscriptRecorder::new();
        // The root recorder rejects `record` until it knows its tunnel id; set it up front so the
        // recorder works even if the driver never calls `set_tunnel_id` (it also does, idempotently).
        inner.set_tunnel_id(&tunnel_id);
        Self {
            inner,
            tunnel_id,
            tx,
            writer,
            buf: Arc::new(Mutex::new(ChunkBuf::default())),
        }
    }

    /// Flush the remaining buffered entries as the final chunk, then seal the manifest that indexes
    /// the transcript for reassembly. Call once at settle/teardown.
    pub async fn finish(&self) {
        let Some(writer) = &self.writer else {
            return;
        };
        // 1. Flush the tail chunk directly (awaited → durable before the manifest seal). No
        //    production is ongoing at finish, so a direct put needs no backpressure.
        let tail = {
            let mut b = self.buf.lock().expect("chunk buf");
            if b.bytes.is_empty() {
                None
            } else {
                let seq = b.seq;
                b.seq += 1;
                b.total_bytes += b.bytes.len() as u64;
                Some((seq, std::mem::take(&mut b.bytes)))
            }
        };
        if let Some((seq, bytes)) = tail {
            if let Err(e) = writer.put_chunk(&self.tunnel_id, seq, bytes).await {
                tracing::warn!(tunnel = %self.tunnel_id, seq, error = %e, "transcript tail chunk upload failed");
            }
        }
        // 2. Seal the manifest so a verifier reassembles by exact count (no LIST) + checks completeness.
        let (chunk_count, total_bytes) = {
            let b = self.buf.lock().expect("chunk buf");
            (b.seq, b.total_bytes)
        };
        if chunk_count == 0 {
            return; // nothing was ever streamed (empty transcript)
        }
        let root = match self.inner.canonical_root_for_tunnel(&self.tunnel_id) {
            Ok(root) => root,
            Err(e) => {
                tracing::warn!(tunnel = %self.tunnel_id, error = %e, "transcript root unavailable; manifest not sealed");
                return;
            }
        };
        let manifest = TranscriptManifest::new(
            chunk_count,
            total_bytes,
            format!("0x{}", hex::encode(root)),
            SETTLE_BODY_VERSION,
        );
        if let Err(e) = writer.seal(&self.tunnel_id, &manifest).await {
            tracing::warn!(tunnel = %self.tunnel_id, error = %e, "transcript manifest seal failed");
        }
    }
}

impl<M> TranscriptRecorder<M> for S3StreamingRecorder<M> {
    fn record(&self, entry: TranscriptEntry<M>) -> Result<(), TranscriptError> {
        // Root only (no sink) → fold into the root and skip the settle-entry serialization.
        if self.tx.is_none() && self.writer.is_none() {
            return self.inner.record(entry);
        }
        // Encode the 250 B settle-entry before the root fold consumes `entry`.
        let settle_entry = TranscriptSettleEntry::from_transcript_entry(&self.tunnel_id, &entry);
        self.inner.record(entry)?; // dup/monotonic nonce check + O(log N) root fold

        let ready_chunk = {
            let mut b = self.buf.lock().expect("chunk buf");
            encode_settle_entry(
                &SettleBodyEntry {
                    message: settle_entry.message,
                    sig_a: settle_entry.sig_a,
                    sig_b: settle_entry.sig_b,
                },
                &mut b.bytes,
            );
            // Flush mid-play only when a bounded uploader exists to receive it; without one
            // (dev/test) the buffer holds until finish().
            if self.tx.is_some() && b.bytes.len() >= CHUNK_TARGET {
                let seq = b.seq;
                b.seq += 1;
                b.total_bytes += b.bytes.len() as u64;
                Some((seq, std::mem::take(&mut b.bytes)))
            } else {
                None
            }
        };
        if let Some((seq, bytes)) = ready_chunk {
            let tx = self.tx.as_ref().expect("tx present when a chunk is ready");
            let upload = ChunkUpload {
                tunnel_id: self.tunnel_id.clone(),
                seq,
                bytes,
            };
            // Fast path; on a full budget PAUSE the producer (never drop, never OOM). `record` is
            // sync, so the blocking send runs under `block_in_place` (needs the multi-thread runtime).
            match tx.try_send(upload) {
                Ok(()) => {}
                Err(TrySendError::Full(upload)) => {
                    let _ = tokio::task::block_in_place(|| tx.blocking_send(upload));
                }
                // Uploader gone (shutdown) → best-effort; the co-signed checkpoint still protects funds.
                Err(TrySendError::Closed(_)) => {}
            }
        }
        Ok(())
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
mod tests {
    use super::*;
    use tunnel_harness::Seat;

    // A valid 32-byte hex address (the state-update message commits to it).
    const TID: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";

    fn entry(nonce: u64) -> TranscriptEntry<u8> {
        TranscriptEntry {
            nonce,
            by: Seat::A,
            mv: nonce as u8,
            state_hash: [nonce as u8; 32],
            timestamp: nonce * 10,
            party_a_balance: 100 - nonce,
            party_b_balance: 100 + nonce,
            sig_proposer: [1u8; 64],
            sig_responder: [2u8; 64],
        }
    }

    /// The bytes the on-chain root commits to: each entry in settle-body wire form, concatenated.
    fn expected_entry_bytes(tunnel_id: &str, entries: &[TranscriptEntry<u8>]) -> Vec<u8> {
        let mut out = Vec::new();
        for e in entries {
            let se = TranscriptSettleEntry::from_transcript_entry(tunnel_id, e);
            encode_settle_entry(
                &SettleBodyEntry {
                    message: se.message,
                    sig_a: se.sig_a,
                    sig_b: se.sig_b,
                },
                &mut out,
            );
        }
        out
    }

    // finish() uploads the tail + seals; the reassembled chunks are byte-identical to the entries
    // the on-chain root commits to.
    #[tokio::test]
    async fn streamed_chunks_reassemble_to_the_settle_entries() {
        use transcript_store::{testing::FakeChunkStore, TranscriptChunkReader};

        let entries = vec![entry(1), entry(2), entry(3)];
        let fake = Arc::new(FakeChunkStore::default());
        // tx=None: 3 small entries never trigger a mid-play flush; finish() uploads via `writer`.
        let recorder = S3StreamingRecorder::<u8>::new(
            TID,
            None,
            Some(fake.clone() as Arc<dyn TranscriptChunkWriter>),
        );
        for e in &entries {
            recorder.record(e.clone()).expect("record");
        }
        recorder.finish().await;

        let reassembled = fake
            .read_transcript(TID)
            .await
            .unwrap()
            .expect("chunks present");
        assert_eq!(reassembled, expected_entry_bytes(TID, &entries));
    }

    // No sink → pure root recorder: nothing streamed, root still served.
    #[tokio::test]
    async fn no_sink_keeps_only_the_root() {
        let recorder = S3StreamingRecorder::<u8>::new(TID, None, None);
        recorder.record(entry(1)).expect("record");
        recorder.finish().await; // no-op
        assert!(recorder.canonical_root_for_tunnel(TID).is_ok());
    }

    // The bounded uploader drains every queued chunk to the store.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn uploader_drains_all_queued_chunks() {
        use transcript_store::testing::FakeChunkStore;

        let fake = Arc::new(FakeChunkStore::default());
        let uploader = TranscriptUploader::spawn(fake.clone() as Arc<dyn TranscriptChunkWriter>);
        let tx = uploader.sender();
        for seq in 0..5u32 {
            tx.send(ChunkUpload {
                tunnel_id: TID.to_string(),
                seq,
                bytes: vec![seq as u8; 16],
            })
            .await
            .expect("queue chunk");
        }
        // Bounded wait for the pool to drain (in-memory puts complete near-instantly).
        for _ in 0..100 {
            if fake.chunks.lock().unwrap().len() == 5 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(fake.chunks.lock().unwrap().len(), 5, "all chunks drained");
    }
}
