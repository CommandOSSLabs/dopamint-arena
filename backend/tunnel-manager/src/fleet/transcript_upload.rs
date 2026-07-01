//! Streams the co-signed transcript to S3 in chunks *during play* — the bot owns the whole
//! transcript with bounded RAM, and nothing is uploaded at settle.
//!
//! [`S3StreamingRecorder`] wraps [`StreamingRootRecorder`] (the O(log N) root) and adds a small
//! byte buffer. `record()` appends the 250 B settle-entry and, once the buffer crosses
//! [`CHUNK_TARGET`], **spawns** a `put_chunk` — `record` is synchronous and runs on the per-move
//! hot path, so it must never block on the S3 `PutObject`. `finish()` flushes the tail at settle
//! or teardown. Chunk bytes go through the same [`encode_settle_entry`] as the settle body, so
//! reassembled chunks reproduce exactly what the on-chain root commits to.

use std::sync::{Arc, Mutex};

use tunnel_core::wire::{encode_settle_entry, SettleBodyEntry};
use tunnel_harness::{
    StreamingRootRecorder, Transcript, TranscriptEntry, TranscriptError, TranscriptRecorder,
    TranscriptSettleEntry,
};
use transcript_store::TranscriptChunkWriter;

/// Flush a chunk once the buffer reaches ~1 MB (~4000 entries). Bounds per-match RAM and caps
/// `PutObject`s at ~⌈25 MB / 1 MB⌉ per match — one S3 call per ~4000 moves, never per move.
const CHUNK_TARGET: usize = 1024 * 1024;

#[derive(Default)]
struct ChunkBuf {
    bytes: Vec<u8>,
    seq: u32,
}

/// Root recorder + streaming S3 uploader. Cheaply cloneable (Arc-shared state): one clone drives
/// the game, another is retained to `finish()` the tail after the driver returns.
#[derive(Clone)]
pub struct S3StreamingRecorder {
    inner: StreamingRootRecorder,
    tunnel_id: String,
    writer: Option<Arc<dyn TranscriptChunkWriter>>,
    buf: Arc<Mutex<ChunkBuf>>,
}

impl S3StreamingRecorder {
    /// `writer = None` degrades to a plain root recorder (no S3 archive), so callers wire it
    /// unconditionally and S3 stays optional in dev/test.
    pub fn new(
        tunnel_id: impl Into<String>,
        writer: Option<Arc<dyn TranscriptChunkWriter>>,
    ) -> Self {
        let tunnel_id = tunnel_id.into();
        Self {
            inner: StreamingRootRecorder::new(tunnel_id.clone()),
            tunnel_id,
            writer,
            buf: Arc::new(Mutex::new(ChunkBuf::default())),
        }
    }

    /// Flush the remaining buffered entries as the final chunk. Call once at settle/teardown.
    pub async fn finish(&self) {
        let Some(writer) = &self.writer else {
            return;
        };
        let (seq, bytes) = {
            let mut b = self.buf.lock().expect("chunk buf");
            if b.bytes.is_empty() {
                return;
            }
            let seq = b.seq;
            b.seq += 1;
            (seq, std::mem::take(&mut b.bytes))
        };
        if let Err(e) = writer.put_chunk(&self.tunnel_id, seq, &bytes).await {
            tracing::warn!(tunnel = %self.tunnel_id, seq, error = %e, "transcript tail chunk upload failed");
        }
    }
}

impl<M> TranscriptRecorder<M> for S3StreamingRecorder {
    fn record(&self, entry: TranscriptEntry<M>) -> Result<(), TranscriptError> {
        // Encode the 250 B settle-entry before the root fold consumes `entry`.
        let settle_entry = TranscriptSettleEntry::from_transcript_entry(&self.tunnel_id, &entry);
        self.inner.record(entry)?; // dup/monotonic nonce check + O(log N) root fold

        let Some(writer) = &self.writer else {
            return Ok(());
        };
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
            if b.bytes.len() >= CHUNK_TARGET {
                let seq = b.seq;
                b.seq += 1;
                Some((seq, std::mem::take(&mut b.bytes)))
            } else {
                None
            }
        };
        // Off the hot path: a dropped spawn only loses that chunk (best-effort archive; funds stay
        // safe via the co-signed checkpoint). `record` runs inside the bot's tokio runtime.
        if let Some((seq, bytes)) = ready_chunk {
            let writer = writer.clone();
            let tunnel_id = self.tunnel_id.clone();
            tokio::spawn(async move {
                if let Err(e) = writer.put_chunk(&tunnel_id, seq, &bytes).await {
                    tracing::warn!(tunnel = %tunnel_id, seq, error = %e, "transcript chunk upload failed");
                }
            });
        }
        Ok(())
    }

    fn snapshot(&self) -> Transcript<TranscriptEntry<M>> {
        self.inner.snapshot()
    }

    fn transcript_root(&self, tunnel_id: &str) -> Result<[u8; 32], TranscriptError> {
        // `transcript_root` doesn't mention `M`, so name the impl explicitly.
        <StreamingRootRecorder as TranscriptRecorder<M>>::transcript_root(&self.inner, tunnel_id)
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

    // The whole point: chunks streamed during play, reassembled, are byte-identical to the entries
    // the on-chain root commits to — so a verifier's re-derived root matches the anchor.
    #[tokio::test]
    async fn streamed_chunks_reassemble_to_the_settle_entries() {
        use transcript_store::{testing::FakeChunkStore, TranscriptChunkReader};

        let tunnel_id = TID;
        let entries = vec![entry(1), entry(2), entry(3)];
        let fake = Arc::new(FakeChunkStore::default());
        let recorder =
            S3StreamingRecorder::new(tunnel_id, Some(fake.clone() as Arc<dyn TranscriptChunkWriter>));
        for e in &entries {
            recorder.record(e.clone()).expect("record");
        }
        recorder.finish().await; // sub-chunk match → tail flush is the single chunk

        let reassembled = fake
            .read_transcript(tunnel_id)
            .await
            .unwrap()
            .expect("chunks present");
        assert_eq!(reassembled, expected_entry_bytes(tunnel_id, &entries));
    }

    // No writer → pure root recorder: nothing streamed, root still served.
    #[tokio::test]
    async fn no_writer_streams_nothing_but_keeps_the_root() {
        let recorder = S3StreamingRecorder::new(TID, None);
        recorder.record(entry(1)).expect("record");
        recorder.finish().await; // no-op
        assert!(TranscriptRecorder::<u8>::transcript_root(&recorder, TID).is_ok());
    }
}
