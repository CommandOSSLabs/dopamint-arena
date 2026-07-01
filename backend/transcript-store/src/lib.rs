//! Reusable S3 archive of settle-body transcripts.
//!
//! The transcript archived at settlement is the co-signed settle body (byte-identical to
//! what the on-chain root commits to). This crate owns the one canonical object key and a
//! single store type that both **writes** it (tunnel-manager / bot fleet at settle) and
//! **reads** it back (explorer api, to verify from S3). Keeping key + store here means no
//! per-service drift. Authentication uses the AWS SDK default credential chain — set
//! `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` and go.

use async_trait::async_trait;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client;

/// Canonical object key: `{prefix}transcripts/{tunnel_id}/{tx_digest}.bin`. A tunnel settles
/// once, so one object per (tunnel, close tx); idempotent overwrite. `prefix` is
/// trailing-slash-trimmed; empty prefix yields `transcripts/...`. This is the single source
/// of truth for the key — writers and readers MUST agree, so both go through here.
pub fn transcript_key(prefix: &str, tunnel_id: &str, tx_digest: &str) -> String {
    let prefix = prefix.trim_end_matches('/');
    let base = format!("transcripts/{tunnel_id}/{tx_digest}.bin");
    if prefix.is_empty() {
        base
    } else {
        format!("{prefix}/{base}")
    }
}

/// Small ASCII object metadata (S3 caps object metadata at ~2 KB).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveMeta {
    pub tunnel_id: String,
    pub tx_digest: String,
    /// `0x`-prefixed hex transcript root (the on-chain-anchored Merkle root).
    pub transcript_root: String,
    pub settle_version: u8,
}

/// Writes the archived transcript for a settlement. Keyed by identity, not S3 key — the
/// impl owns the key layout. `Err` = exhausted inline retries (caller may enqueue for a
/// durable retry).
#[async_trait]
pub trait TranscriptArchiver: Send + Sync {
    async fn archive(
        &self,
        tunnel_id: &str,
        tx_digest: &str,
        bytes: &[u8],
        meta: &ArchiveMeta,
    ) -> anyhow::Result<()>;
}

/// Reads the archived transcript for a settlement. `Ok(None)` = not archived here (a reader
/// may fall back to another source, e.g. Walrus); `Err` = a real backend error.
#[async_trait]
pub trait TranscriptReader: Send + Sync {
    async fn read(&self, tunnel_id: &str, tx_digest: &str) -> anyhow::Result<Option<Vec<u8>>>;
}

/// S3-backed transcript store: one `PutObject`/`GetObject` per call at [`transcript_key`].
/// Implements both [`TranscriptArchiver`] and [`TranscriptReader`], so a write-only service
/// (bot fleet) and a read-only service (explorer) depend on the same type via whichever
/// trait they need.
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
    pub async fn from_env() -> anyhow::Result<Self> {
        let bucket = std::env::var("S3_TRANSCRIPTS_BUCKET")
            .map_err(|_| anyhow::anyhow!("S3_TRANSCRIPTS_BUCKET not set"))?;
        if bucket.trim().is_empty() {
            anyhow::bail!("S3_TRANSCRIPTS_BUCKET is empty");
        }
        let prefix = std::env::var("S3_TRANSCRIPTS_PREFIX").unwrap_or_default();
        let config = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .load()
            .await;
        Ok(Self::new(Client::new(&config), bucket, prefix))
    }

    fn key(&self, tunnel_id: &str, tx_digest: &str) -> String {
        transcript_key(&self.prefix, tunnel_id, tx_digest)
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
    ) -> anyhow::Result<()> {
        let key = self.key(tunnel_id, tx_digest);
        let md = [
            ("tunnel-id", meta.tunnel_id.clone()),
            ("tx-digest", meta.tx_digest.clone()),
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
            .map_err(|e| anyhow::anyhow!("s3 put_object {}/{key}: {e}", self.bucket))?;
        Ok(())
    }
}

#[async_trait]
impl TranscriptReader for S3TranscriptStore {
    async fn read(&self, tunnel_id: &str, tx_digest: &str) -> anyhow::Result<Option<Vec<u8>>> {
        let key = self.key(tunnel_id, tx_digest);
        match self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(&key)
            .send()
            .await
        {
            Ok(out) => {
                let bytes = out
                    .body
                    .collect()
                    .await
                    .map_err(|e| anyhow::anyhow!("s3 body read {}/{key}: {e}", self.bucket))?
                    .into_bytes();
                Ok(Some(bytes.to_vec()))
            }
            // A missing key is the expected "not archived here" signal.
            Err(e) => match e.as_service_error() {
                Some(svc) if svc.is_no_such_key() => Ok(None),
                _ => Err(anyhow::anyhow!("s3 get_object {}/{key}: {e}", self.bucket)),
            },
        }
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
        ) -> anyhow::Result<()> {
            if let Some(msg) = self.fail_with {
                anyhow::bail!("{msg}");
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
        async fn read(&self, tunnel_id: &str, tx_digest: &str) -> anyhow::Result<Option<Vec<u8>>> {
            Ok(self
                .objects
                .get(&(tunnel_id.to_string(), tx_digest.to_string()))
                .cloned())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcript_key_is_prefix_stable() {
        assert_eq!(transcript_key("", "0xt", "DiG"), "transcripts/0xt/DiG.bin");
        assert_eq!(transcript_key("dev/", "0xt", "DiG"), "dev/transcripts/0xt/DiG.bin");
        assert_eq!(transcript_key("dev", "0xt", "DiG"), "dev/transcripts/0xt/DiG.bin");
    }
}
