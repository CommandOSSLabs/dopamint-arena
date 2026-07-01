//! # transcript-store
//!
//! Reusable S3 store for co-signed tunnel transcripts, shared by any Rust service that produces
//! or verifies them (the tunnel-manager settle path, the bot fleet, the explorer).
//!
//! Two storage shapes, one crate:
//! - **One-object archive** ([`TranscriptArchiver`] / [`TranscriptReader`]) — the whole settle
//!   body written once at settlement, keyed by `(tunnel_id, tx_digest)`.
//! - **Streaming chunks** ([`TranscriptChunkWriter`] / [`TranscriptChunkReader`]) — the transcript
//!   flushed to S3 in ~1 MB chunks *during play* so producer RAM stays bounded, sealed with a
//!   [`TranscriptManifest`] and reassembled on read.
//!
//! The store is defined behind traits so a consumer can plug its own backend (or the in-memory
//! [`testing`] doubles); [`S3TranscriptStore`] is the production implementation.
//!
//! ```no_run
//! use std::sync::Arc;
//! use transcript_store::{S3TranscriptStore, TranscriptChunkWriter, TranscriptManifest};
//!
//! # async fn demo() -> transcript_store::Result<()> {
//! let store = S3TranscriptStore::from_env().await?;
//! store.put_chunk("0xtunnel", 0, b"...co-signed entries...".to_vec()).await?;
//! store
//!     .seal("0xtunnel", &TranscriptManifest::new(1, 22, "0xroot".into(), 1))
//!     .await?;
//! # Ok(())
//! # }
//! ```
//!
//! Authentication uses the AWS SDK default credential chain (`AWS_ACCESS_KEY_ID` /
//! `AWS_SECRET_ACCESS_KEY` / `AWS_REGION`).

use async_trait::async_trait;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client;
use serde::{Deserialize, Serialize};

/// Errors returned by this crate. `#[non_exhaustive]` so new variants don't break consumers.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum Error {
    /// An S3 request failed. `op` names the S3 operation, `key` the object key involved.
    #[error("s3 {op} failed for key {key}")]
    S3 {
        op: &'static str,
        key: String,
        #[source]
        source: Box<dyn std::error::Error + Send + Sync + 'static>,
    },
    /// A transcript manifest could not be encoded or decoded as JSON.
    #[error("manifest {key}: {source}")]
    Manifest {
        key: String,
        #[source]
        source: serde_json::Error,
    },
    /// A sealed manifest disagreed with the chunks found (a chunk is missing or truncated) —
    /// reassembly must fail rather than return a partial transcript.
    #[error("transcript {tunnel_id} incomplete: {detail}")]
    Incomplete { tunnel_id: String, detail: String },
    /// Missing or invalid configuration (e.g. an unset environment variable in [`S3TranscriptStore::from_env`]).
    #[error("{0}")]
    Config(String),
}

/// This crate's `Result`, `Err` = [`Error`].
pub type Result<T> = std::result::Result<T, Error>;

fn s3_err(
    op: &'static str,
    key: &str,
    source: impl std::error::Error + Send + Sync + 'static,
) -> Error {
    Error::S3 {
        op,
        key: key.to_string(),
        source: Box::new(source),
    }
}

/// Canonical one-object key: `{prefix}transcripts/{tunnel_id}/{tx_digest}.bin`. A tunnel settles
/// once, so one object per (tunnel, close tx); idempotent overwrite. `prefix` is
/// trailing-slash-trimmed; empty prefix yields `transcripts/...`. This is the single source of
/// truth for the key — writers and readers MUST agree, so both go through here.
pub fn transcript_key(prefix: &str, tunnel_id: &str, tx_digest: &str) -> String {
    format!("{}{tx_digest}.bin", chunk_dir(prefix, tunnel_id))
}

/// Streaming chunk key: `{prefix}transcripts/{tunnel_id}/chunk-{seq:08}.bin`. The producer streams
/// the transcript to S3 as immutable, monotonically-sequenced chunks — the tunnel *is* the
/// transcript, and there is no `tx_digest` until it settles, so chunks key on `tunnel_id`.
/// Zero-padded seq so lexicographic LIST order equals numeric order. The distinct `chunk-`
/// filename prefix keeps these from colliding with the one-object [`transcript_key`] in the same
/// `transcripts/{tunnel_id}/` directory.
pub fn chunk_key(prefix: &str, tunnel_id: &str, seq: u32) -> String {
    format!("{}chunk-{seq:08}.bin", chunk_dir(prefix, tunnel_id))
}

/// Manifest key: `{prefix}transcripts/{tunnel_id}/manifest.json` — the seal that indexes a
/// completed transcript's chunks (see [`TranscriptManifest`]).
pub fn manifest_key(prefix: &str, tunnel_id: &str) -> String {
    format!("{}manifest.json", chunk_dir(prefix, tunnel_id))
}

/// `{prefix}transcripts/{tunnel_id}/` — the directory holding one tunnel's chunks + manifest.
fn chunk_dir(prefix: &str, tunnel_id: &str) -> String {
    let prefix = prefix.trim_end_matches('/');
    if prefix.is_empty() {
        format!("transcripts/{tunnel_id}/")
    } else {
        format!("{prefix}/transcripts/{tunnel_id}/")
    }
}

/// LIST prefix matching exactly one tunnel's streaming chunks (not the manifest or legacy blob).
fn chunk_list_prefix(prefix: &str, tunnel_id: &str) -> String {
    format!("{}chunk-", chunk_dir(prefix, tunnel_id))
}

/// Small ASCII object metadata for the one-object archive (S3 caps object metadata at ~2 KB).
/// Identity (`tunnel_id`, `tx_digest`) is NOT here — it's passed to `archive`/`read` as the single
/// source of truth for the key, so it can't diverge from the metadata.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveMeta {
    /// `0x`-prefixed hex transcript root (the on-chain-anchored Merkle root).
    pub transcript_root: String,
    pub settle_version: u8,
}

/// Seals a completed streamed transcript: the reader fetches this, then the exact `chunk_count`
/// chunks (no LIST), reassembles, checks `total_bytes`, and recomputes the Merkle root against
/// `transcript_root` (which is also anchored on-chain). Written once, at seal. Absent = the
/// transcript was never sealed (still streaming, or abandoned) — readers fall back to listing the
/// chunk objects. `#[non_exhaustive]`; construct via [`TranscriptManifest::new`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct TranscriptManifest {
    /// Chunk objects present: `chunk-00000000.bin` .. `chunk-{chunk_count-1:08}.bin`.
    pub chunk_count: u32,
    /// Byte length of the reassembled transcript (all chunks concatenated).
    pub total_bytes: u64,
    /// `0x`-prefixed hex Merkle root over the transcript entries (also anchored on-chain).
    pub transcript_root: String,
    /// Settle-body wire version the entries were encoded with.
    pub settle_version: u8,
}

impl TranscriptManifest {
    pub fn new(
        chunk_count: u32,
        total_bytes: u64,
        transcript_root: String,
        settle_version: u8,
    ) -> Self {
        Self {
            chunk_count,
            total_bytes,
            transcript_root,
            settle_version,
        }
    }
}

/// Writes the archived transcript for a settlement. `bytes` MUST be the **authoritative co-signed
/// settle body** (byte-for-byte what the on-chain root commits to) — never a locally re-derived
/// transcript — so the archived object verifies against the on-chain root. Keyed by identity, not
/// S3 key (the impl owns the key layout).
#[async_trait]
pub trait TranscriptArchiver: Send + Sync {
    async fn archive(
        &self,
        tunnel_id: &str,
        tx_digest: &str,
        bytes: &[u8],
        meta: &ArchiveMeta,
    ) -> Result<()>;
}

/// Reads the archived transcript for a settlement. `Ok(None)` = not archived here (a reader may
/// fall back to another source, e.g. Walrus); `Err` = a real backend error.
#[async_trait]
pub trait TranscriptReader: Send + Sync {
    async fn read(&self, tunnel_id: &str, tx_digest: &str) -> Result<Option<Vec<u8>>>;
}

/// Streams a transcript to object storage as it is produced. Chunks are immutable and appended
/// with a monotonic `seq` from 0; each `put_chunk` is durable the instant it returns (S3 strong
/// read-after-write), so an abandoned or never-terminal producer keeps every flushed chunk.
/// `bytes` MUST be authoritative co-signed entries byte-for-byte, aligned to whole entries, so
/// concatenating all chunks reproduces exactly what the on-chain root commits to. Call [`seal`]
/// once when the transcript is complete.
///
/// [`seal`]: TranscriptChunkWriter::seal
#[async_trait]
pub trait TranscriptChunkWriter: Send + Sync {
    /// Append one chunk. `seq` is monotonic from 0. Takes the buffer by value — a streaming
    /// producer always owns the flushed chunk, so an owned `Vec` moves into the request body with
    /// no extra copy of the (~1 MB) chunk.
    async fn put_chunk(&self, tunnel_id: &str, seq: u32, bytes: Vec<u8>) -> Result<()>;
    /// Write the manifest that indexes the completed transcript (see [`TranscriptManifest`]).
    /// Call after the final `put_chunk` — never before, or a reader could see a manifest that
    /// promises chunks not yet durable.
    async fn seal(&self, tunnel_id: &str, manifest: &TranscriptManifest) -> Result<()>;
}

/// Reassembles a streamed transcript for verification. `read_transcript` prefers the sealed
/// [`TranscriptManifest`] (exact chunk count, no LIST, completeness check) and falls back to
/// listing chunk objects for an unsealed/abandoned transcript. `Ok(None)` = nothing stored (a
/// reader may fall back to another source, e.g. Walrus).
#[async_trait]
pub trait TranscriptChunkReader: Send + Sync {
    /// The seal, if the transcript was completed. `Ok(None)` = never sealed.
    async fn read_manifest(&self, tunnel_id: &str) -> Result<Option<TranscriptManifest>>;
    /// The full transcript bytes, reassembled in chunk order.
    async fn read_transcript(&self, tunnel_id: &str) -> Result<Option<Vec<u8>>>;
}

/// S3-backed transcript store. Implements every trait above, so a write-only service (bot fleet)
/// and a read-only service (explorer) depend on the same type via whichever trait they need.
#[derive(Clone)]
pub struct S3TranscriptStore {
    client: Client,
    bucket: String,
    prefix: String,
}

impl S3TranscriptStore {
    /// Wrap an existing S3 [`Client`] with a bucket and key prefix.
    pub fn new(client: Client, bucket: impl Into<String>, prefix: impl Into<String>) -> Self {
        Self {
            client,
            bucket: bucket.into(),
            prefix: prefix.into(),
        }
    }

    /// Build from the environment. Bucket from `S3_TRANSCRIPTS_BUCKET` (required, non-empty);
    /// optional prefix from `S3_TRANSCRIPTS_PREFIX`. Client from the AWS default region /
    /// credential chain.
    pub async fn from_env() -> Result<Self> {
        let bucket = std::env::var("S3_TRANSCRIPTS_BUCKET")
            .map_err(|_| Error::Config("S3_TRANSCRIPTS_BUCKET not set".into()))?;
        if bucket.trim().is_empty() {
            return Err(Error::Config("S3_TRANSCRIPTS_BUCKET is empty".into()));
        }
        let prefix = std::env::var("S3_TRANSCRIPTS_PREFIX").unwrap_or_default();
        let config = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .load()
            .await;
        Ok(Self::new(Client::new(&config), bucket, prefix))
    }

    async fn get_bytes(&self, key: &str, op: &'static str) -> Result<Option<Vec<u8>>> {
        match self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
        {
            Ok(out) => {
                let bytes = out
                    .body
                    .collect()
                    .await
                    .map_err(|e| s3_err(op, key, e))?
                    .into_bytes();
                Ok(Some(bytes.to_vec()))
            }
            // A missing key is the expected "not here" signal, not an error.
            Err(e) => match e.as_service_error() {
                Some(svc) if svc.is_no_such_key() => Ok(None),
                _ => Err(s3_err(op, key, e)),
            },
        }
    }

    async fn reassemble_from_manifest(
        &self,
        tunnel_id: &str,
        manifest: &TranscriptManifest,
    ) -> Result<Vec<u8>> {
        let mut transcript = Vec::with_capacity(manifest.total_bytes as usize);
        for seq in 0..manifest.chunk_count {
            let key = chunk_key(&self.prefix, tunnel_id, seq);
            let bytes =
                self.get_bytes(&key, "get_chunk")
                    .await?
                    .ok_or_else(|| Error::Incomplete {
                        tunnel_id: tunnel_id.to_string(),
                        detail: format!(
                            "manifest lists {} chunks but {key} is missing",
                            manifest.chunk_count
                        ),
                    })?;
            transcript.extend_from_slice(&bytes);
        }
        if transcript.len() as u64 != manifest.total_bytes {
            return Err(Error::Incomplete {
                tunnel_id: tunnel_id.to_string(),
                detail: format!(
                    "manifest says {} bytes, reassembled {}",
                    manifest.total_bytes,
                    transcript.len()
                ),
            });
        }
        Ok(transcript)
    }

    async fn reassemble_from_list(&self, tunnel_id: &str) -> Result<Option<Vec<u8>>> {
        let list_prefix = chunk_list_prefix(&self.prefix, tunnel_id);
        let mut keys: Vec<String> = Vec::new();
        let mut continuation: Option<String> = None;
        loop {
            let mut req = self
                .client
                .list_objects_v2()
                .bucket(&self.bucket)
                .prefix(&list_prefix);
            if let Some(token) = &continuation {
                req = req.continuation_token(token);
            }
            let out = req
                .send()
                .await
                .map_err(|e| s3_err("list", &list_prefix, e))?;
            for obj in out.contents() {
                if let Some(k) = obj.key() {
                    keys.push(k.to_string());
                }
            }
            match out.next_continuation_token() {
                Some(token) if out.is_truncated() == Some(true) => {
                    continuation = Some(token.to_string());
                }
                _ => break,
            }
        }
        if keys.is_empty() {
            return Ok(None);
        }
        // Zero-padded seq → lexicographic sort is chunk order.
        keys.sort();
        let mut transcript = Vec::new();
        for key in keys {
            if let Some(bytes) = self.get_bytes(&key, "get_chunk").await? {
                transcript.extend_from_slice(&bytes);
            }
        }
        Ok(Some(transcript))
    }
}

#[async_trait]
impl TranscriptArchiver for S3TranscriptStore {
    async fn archive(
        &self,
        tunnel_id: &str,
        tx_digest: &str,
        bytes: &[u8],
        meta: &ArchiveMeta,
    ) -> Result<()> {
        let key = transcript_key(&self.prefix, tunnel_id, tx_digest);
        let md = [
            ("tunnel-id", tunnel_id.to_string()),
            ("tx-digest", tx_digest.to_string()),
            ("transcript-root", meta.transcript_root.clone()),
            ("settle-version", meta.settle_version.to_string()),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(&key)
            // Callers own the bytes; one copy into the PutObject body is acceptable.
            .body(ByteStream::from(bytes.to_vec()))
            .content_type("application/octet-stream")
            .set_metadata(Some(md))
            .send()
            .await
            .map_err(|e| s3_err("put_object", &key, e))?;
        Ok(())
    }
}

#[async_trait]
impl TranscriptReader for S3TranscriptStore {
    async fn read(&self, tunnel_id: &str, tx_digest: &str) -> Result<Option<Vec<u8>>> {
        let key = transcript_key(&self.prefix, tunnel_id, tx_digest);
        self.get_bytes(&key, "get_object").await
    }
}

#[async_trait]
impl TranscriptChunkWriter for S3TranscriptStore {
    async fn put_chunk(&self, tunnel_id: &str, seq: u32, bytes: Vec<u8>) -> Result<()> {
        let key = chunk_key(&self.prefix, tunnel_id, seq);
        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(&key)
            .body(ByteStream::from(bytes))
            .content_type("application/octet-stream")
            .send()
            .await
            .map_err(|e| s3_err("put_chunk", &key, e))?;
        Ok(())
    }

    async fn seal(&self, tunnel_id: &str, manifest: &TranscriptManifest) -> Result<()> {
        let key = manifest_key(&self.prefix, tunnel_id);
        let body = serde_json::to_vec(manifest).map_err(|e| Error::Manifest {
            key: key.clone(),
            source: e,
        })?;
        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(&key)
            .body(ByteStream::from(body))
            .content_type("application/json")
            .send()
            .await
            .map_err(|e| s3_err("put_manifest", &key, e))?;
        Ok(())
    }
}

#[async_trait]
impl TranscriptChunkReader for S3TranscriptStore {
    async fn read_manifest(&self, tunnel_id: &str) -> Result<Option<TranscriptManifest>> {
        let key = manifest_key(&self.prefix, tunnel_id);
        match self.get_bytes(&key, "get_manifest").await? {
            Some(bytes) => {
                let manifest = serde_json::from_slice(&bytes)
                    .map_err(|e| Error::Manifest { key, source: e })?;
                Ok(Some(manifest))
            }
            None => Ok(None),
        }
    }

    async fn read_transcript(&self, tunnel_id: &str) -> Result<Option<Vec<u8>>> {
        // Prefer the sealed manifest (exact count + completeness check, no LIST); fall back to
        // listing chunk objects for an unsealed / abandoned transcript.
        if let Some(manifest) = self.read_manifest(tunnel_id).await? {
            return Ok(Some(
                self.reassemble_from_manifest(tunnel_id, &manifest).await?,
            ));
        }
        self.reassemble_from_list(tunnel_id).await
    }
}

#[cfg(feature = "testing")]
pub mod testing {
    //! In-memory test doubles for downstream unit tests. Enable with
    //! `transcript-store = { ..., features = ["testing"] }`.
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// Records every archive; `fail_with` forces an error instead.
    #[derive(Default)]
    pub struct FakeArchiver {
        /// `(tunnel_id, tx_digest, bytes)` per successful archive, in order.
        pub archived: Mutex<Vec<(String, String, Vec<u8>)>>,
        pub fail_with: Option<&'static str>,
    }

    #[async_trait]
    impl TranscriptArchiver for FakeArchiver {
        async fn archive(
            &self,
            tunnel_id: &str,
            tx_digest: &str,
            bytes: &[u8],
            _meta: &ArchiveMeta,
        ) -> Result<()> {
            if let Some(msg) = self.fail_with {
                return Err(Error::Config(msg.to_string()));
            }
            self.archived.lock().unwrap().push((
                tunnel_id.to_string(),
                tx_digest.to_string(),
                bytes.to_vec(),
            ));
            Ok(())
        }
    }

    /// Serves pre-seeded objects keyed by `(tunnel_id, tx_digest)`.
    #[derive(Default)]
    pub struct FakeReader {
        pub objects: HashMap<(String, String), Vec<u8>>,
    }

    #[async_trait]
    impl TranscriptReader for FakeReader {
        async fn read(&self, tunnel_id: &str, tx_digest: &str) -> Result<Option<Vec<u8>>> {
            Ok(self
                .objects
                .get(&(tunnel_id.to_string(), tx_digest.to_string()))
                .cloned())
        }
    }

    /// In-memory streaming chunk store: records `put_chunk`/`seal` and reassembles on
    /// `read_transcript` (manifest-first, mirroring the S3 impl) so downstream can unit-test the
    /// round-trip.
    #[derive(Default)]
    pub struct FakeChunkStore {
        /// `(tunnel_id, seq) -> chunk bytes`.
        pub chunks: Mutex<HashMap<(String, u32), Vec<u8>>>,
        /// `tunnel_id -> manifest`, set at `seal`.
        pub manifests: Mutex<HashMap<String, TranscriptManifest>>,
        pub fail_with: Option<&'static str>,
    }

    #[async_trait]
    impl TranscriptChunkWriter for FakeChunkStore {
        async fn put_chunk(&self, tunnel_id: &str, seq: u32, bytes: Vec<u8>) -> Result<()> {
            if let Some(msg) = self.fail_with {
                return Err(Error::Config(msg.to_string()));
            }
            self.chunks
                .lock()
                .unwrap()
                .insert((tunnel_id.to_string(), seq), bytes);
            Ok(())
        }

        async fn seal(&self, tunnel_id: &str, manifest: &TranscriptManifest) -> Result<()> {
            self.manifests
                .lock()
                .unwrap()
                .insert(tunnel_id.to_string(), manifest.clone());
            Ok(())
        }
    }

    #[async_trait]
    impl TranscriptChunkReader for FakeChunkStore {
        async fn read_manifest(&self, tunnel_id: &str) -> Result<Option<TranscriptManifest>> {
            Ok(self.manifests.lock().unwrap().get(tunnel_id).cloned())
        }

        async fn read_transcript(&self, tunnel_id: &str) -> Result<Option<Vec<u8>>> {
            let chunks = self.chunks.lock().unwrap();
            // Manifest-first: fetch exactly `chunk_count` chunks, error on a gap.
            if let Some(manifest) = self.manifests.lock().unwrap().get(tunnel_id).cloned() {
                let mut transcript = Vec::new();
                for seq in 0..manifest.chunk_count {
                    match chunks.get(&(tunnel_id.to_string(), seq)) {
                        Some(bytes) => transcript.extend_from_slice(bytes),
                        None => {
                            return Err(Error::Incomplete {
                                tunnel_id: tunnel_id.to_string(),
                                detail: format!("missing chunk {seq}"),
                            })
                        }
                    }
                }
                return Ok(Some(transcript));
            }
            // Unsealed fallback: seq-sorted concat of whatever chunks exist.
            let mut seqs: Vec<u32> = chunks
                .keys()
                .filter(|(t, _)| t == tunnel_id)
                .map(|(_, s)| *s)
                .collect();
            if seqs.is_empty() {
                return Ok(None);
            }
            seqs.sort_unstable();
            let mut transcript = Vec::new();
            for seq in seqs {
                transcript.extend_from_slice(&chunks[&(tunnel_id.to_string(), seq)]);
            }
            Ok(Some(transcript))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcript_key_is_prefix_stable() {
        assert_eq!(transcript_key("", "0xt", "DiG"), "transcripts/0xt/DiG.bin");
        assert_eq!(
            transcript_key("dev/", "0xt", "DiG"),
            "dev/transcripts/0xt/DiG.bin"
        );
        assert_eq!(
            transcript_key("dev", "0xt", "DiG"),
            "dev/transcripts/0xt/DiG.bin"
        );
    }

    #[test]
    fn chunk_and_manifest_keys_are_seq_ordered_and_distinct() {
        assert_eq!(
            chunk_key("", "0xt", 0),
            "transcripts/0xt/chunk-00000000.bin"
        );
        assert_eq!(
            chunk_key("dev", "0xt", 42),
            "dev/transcripts/0xt/chunk-00000042.bin"
        );
        assert_eq!(manifest_key("", "0xt"), "transcripts/0xt/manifest.json");
        // Reassembly relies on lexicographic order equaling numeric order.
        assert!(chunk_key("", "t", 9) < chunk_key("", "t", 10));
        // Streaming chunks must not collide with the one-object key in the same dir.
        assert_ne!(chunk_key("", "t", 1), transcript_key("", "t", "00000001"));
    }

    #[test]
    fn manifest_round_trips_as_json() {
        let m = TranscriptManifest::new(3, 750, "0xabc".into(), 1);
        let json = serde_json::to_vec(&m).unwrap();
        let back: TranscriptManifest = serde_json::from_slice(&json).unwrap();
        assert_eq!(m, back);
    }
}
