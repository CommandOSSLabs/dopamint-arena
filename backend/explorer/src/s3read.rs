//! Read the archived settle-body transcript from S3, so the explorer verifies from S3
//! (primary) rather than proxying the Walrus aggregator. The settle route already archives
//! the whole co-signed body at a deterministic key (`tunnel-manager` `s3::archive_key`), and
//! those bytes are byte-identical to the Walrus blob — so this is a read-source swap, not a
//! new archive format. Behind a trait so the dual-read handler logic is unit-testable without
//! a live S3.

use async_trait::async_trait;

/// Reads the archived transcript bytes for a settlement. `Ok(None)` = not archived in S3
/// (the handler falls back to Walrus); `Err` = a real backend error (not "missing").
#[async_trait]
pub trait TranscriptReader: Send + Sync {
    async fn read(&self, tunnel_id: &str, tx_digest: &str) -> anyhow::Result<Option<Vec<u8>>>;
}

/// The object key the settle route writes: `{prefix}transcripts/{tunnel_id}/{tx_digest}.bin`
/// (mirrors `tunnel-manager`'s `s3::archive_key` — keep the two in sync). Prefix is
/// trailing-slash-trimmed; an empty prefix yields `transcripts/...`.
pub fn transcript_key(prefix: &str, tunnel_id: &str, tx_digest: &str) -> String {
    let prefix = prefix.trim_end_matches('/');
    let base = format!("transcripts/{tunnel_id}/{tx_digest}.bin");
    if prefix.is_empty() {
        base
    } else {
        format!("{prefix}/{base}")
    }
}

/// Production reader: one `GetObject` per call. A missing object maps to `Ok(None)` (fall
/// back to Walrus); any other failure is `Err`.
pub struct S3TranscriptReader {
    client: aws_sdk_s3::Client,
    bucket: String,
    prefix: String,
}

impl S3TranscriptReader {
    pub fn new(client: aws_sdk_s3::Client, bucket: String, prefix: String) -> Self {
        Self {
            client,
            bucket,
            prefix,
        }
    }
}

#[async_trait]
impl TranscriptReader for S3TranscriptReader {
    async fn read(&self, tunnel_id: &str, tx_digest: &str) -> anyhow::Result<Option<Vec<u8>>> {
        let key = transcript_key(&self.prefix, tunnel_id, tx_digest);
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
            // A missing key is the expected "not archived here" signal → fall back to Walrus.
            Err(e) => match e.as_service_error() {
                Some(svc) if svc.is_no_such_key() => Ok(None),
                _ => Err(anyhow::anyhow!("s3 get_object {}/{key}: {e}", self.bucket)),
            },
        }
    }
}

#[cfg(test)]
pub struct FakeTranscriptReader {
    /// keyed by `"{tunnel_id}/{tx_digest}"`.
    pub objects: std::collections::HashMap<String, Vec<u8>>,
}

#[cfg(test)]
#[async_trait]
impl TranscriptReader for FakeTranscriptReader {
    async fn read(&self, tunnel_id: &str, tx_digest: &str) -> anyhow::Result<Option<Vec<u8>>> {
        Ok(self.objects.get(&format!("{tunnel_id}/{tx_digest}")).cloned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcript_key_matches_the_archive_key_format() {
        assert_eq!(
            transcript_key("", "0xtun", "DiG"),
            "transcripts/0xtun/DiG.bin"
        );
        assert_eq!(
            transcript_key("dev/", "0xtun", "DiG"),
            "dev/transcripts/0xtun/DiG.bin"
        );
        assert_eq!(
            transcript_key("dev", "0xtun", "DiG"),
            "dev/transcripts/0xtun/DiG.bin"
        );
    }
}
