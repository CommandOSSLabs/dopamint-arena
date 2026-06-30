//! Amazon S3 storage backend for wallet pool blobs.
//!
//! A drop-in [`wallet_pool::store::WalletPoolStore`] that stores one encrypted
//! pool blob per S3 object in a single bucket. Semantics mirror
//! `FileWalletPoolStore`: opaque bytes keyed by pool id; whole-blob overwrite
//! (last-writer-wins). Authentication uses the AWS SDK default credential chain
//! — set `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` and go.

use aws_sdk_s3::Client;
use wallet_pool::error::{Error, Result};
use wallet_pool::store::validate_id;

/// S3-backed [`wallet_pool::store::WalletPoolStore`].
///
/// One object per pool. Object key is `{prefix}{id}.json`, where `id` is the
/// pool id (already filesystem/S3-safe per `validate_id`).
pub struct S3WalletPoolStore {
    client: Client,
    bucket: String,
    prefix: String,
}

impl S3WalletPoolStore {
    /// Wrap an existing S3 [`Client`] with a bucket and key prefix.
    ///
    /// `prefix` is applied verbatim before `{id}.json`; use `""` for a flat
    /// layout or `"pools/"` to namespace objects.
    pub fn new(client: Client, bucket: impl Into<String>, prefix: impl Into<String>) -> Self {
        Self {
            client,
            bucket: bucket.into(),
            prefix: prefix.into(),
        }
    }

    /// Build from the environment.
    ///
    /// Bucket is read from `WALLET_POOL_S3_BUCKET` (required). Optional key
    /// prefix from `WALLET_POOL_S3_PREFIX` (default empty). The [`Client`] is
    /// built from the AWS SDK default region/credential chain, so standard
    /// `AWS_*` environment variables just work.
    pub async fn from_env() -> Result<Self> {
        let bucket = std::env::var("WALLET_POOL_S3_BUCKET")
            .map_err(|_| Error::InvalidInput("WALLET_POOL_S3_BUCKET not set".into()))?;
        if bucket.trim().is_empty() {
            return Err(Error::InvalidInput("WALLET_POOL_S3_BUCKET is empty".into()));
        }
        let prefix = std::env::var("WALLET_POOL_S3_PREFIX").unwrap_or_default();
        let config = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .load()
            .await;
        Ok(Self::new(Client::new(&config), bucket, prefix))
    }

    /// Resolve the full S3 object key for `id`, validating it first.
    pub fn key(&self, id: &str) -> Result<String> {
        validate_id(id)?;
        Ok(format!("{}{id}.json", self.prefix))
    }
}
