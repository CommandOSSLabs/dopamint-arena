//! Async storage backends for wallet pool blobs.

use crate::error::{Error, Result};
use async_trait::async_trait;
use std::path::{Path, PathBuf};
use tokio::fs;

/// Async storage layer for opaque pool blobs keyed by pool id.
#[async_trait]
pub trait WalletPoolStore: Send + Sync {
    /// Read the blob bytes for `id`, or `None` if it does not exist.
    async fn read(&self, id: &str) -> Result<Option<Vec<u8>>>;

    /// Persist `bytes` for `id`, creating the store directory if needed.
    async fn write(&self, id: &str, bytes: &[u8]) -> Result<()>;

    /// List all pool ids currently stored.
    async fn list(&self) -> Result<Vec<String>>;

    /// Delete the blob for `id`, succeeding if it did not exist.
    async fn delete(&self, id: &str) -> Result<()>;
}

/// On-disk store that keeps one JSON file per pool under a configured directory.
pub struct FileWalletPoolStore {
    dir: PathBuf,
}

impl FileWalletPoolStore {
    /// Create a new file store rooted at `dir`.
    pub fn new(dir: impl AsRef<Path>) -> Self {
        Self {
            dir: dir.as_ref().to_path_buf(),
        }
    }

    /// Resolve the backing file path for `id` after validating it.
    fn path(&self, id: &str) -> Result<PathBuf> {
        validate_id(id)?;
        Ok(self.dir.join(format!("{id}.json")))
    }
}

#[async_trait]
impl WalletPoolStore for FileWalletPoolStore {
    async fn read(&self, id: &str) -> Result<Option<Vec<u8>>> {
        match fs::read(self.path(id)?).await {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(Error::Store(format!("read failed: {e}"))),
        }
    }

    async fn write(&self, id: &str, bytes: &[u8]) -> Result<()> {
        fs::create_dir_all(&self.dir)
            .await
            .map_err(|e| Error::Store(format!("mkdir failed: {e}")))?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&self.dir)
                .await
                .map_err(|e| Error::Store(format!("dir metadata failed: {e}")))?
                .permissions();
            perms.set_mode(0o700);
            fs::set_permissions(&self.dir, perms)
                .await
                .map_err(|e| Error::Store(format!("dir chmod failed: {e}")))?;
        }

        let path = self.path(id)?;
        fs::write(&path, bytes)
            .await
            .map_err(|e| Error::Store(format!("write failed: {e}")))?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&path)
                .await
                .map_err(|e| Error::Store(format!("file metadata failed: {e}")))?
                .permissions();
            perms.set_mode(0o600);
            fs::set_permissions(&path, perms)
                .await
                .map_err(|e| Error::Store(format!("file chmod failed: {e}")))?;
        }

        Ok(())
    }

    async fn list(&self) -> Result<Vec<String>> {
        let mut entries = match fs::read_dir(&self.dir).await {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(Error::Store(format!("list failed: {e}"))),
        };

        let mut ids = Vec::new();
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|e| Error::Store(format!("list failed: {e}")))?
        {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if let Some(id) = name.strip_suffix(".json") {
                ids.push(id.to_string());
            }
        }

        ids.sort();
        Ok(ids)
    }

    async fn delete(&self, id: &str) -> Result<()> {
        match fs::remove_file(self.path(id)?).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(Error::Store(format!("delete failed: {e}"))),
        }
    }
}

/// Validate that `id` matches `wp_[A-Za-z0-9_-]+` and contains no path separators.
pub fn validate_id(id: &str) -> Result<()> {
    if id.len() < 4 || !id.starts_with("wp_") {
        return Err(Error::Store(format!("invalid pool id: {id}")));
    }

    if id.contains('/') || id.contains('\\') {
        return Err(Error::Store(format!("invalid pool id: {id}")));
    }

    let suffix = &id[3..];
    if suffix.is_empty() {
        return Err(Error::Store(format!("invalid pool id: {id}")));
    }

    if !suffix
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(Error::Store(format!("invalid pool id: {id}")));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn file_store_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileWalletPoolStore::new(dir.path());
        let id = "wp_test";

        assert!(store.read(id).await.unwrap().is_none());

        store.write(id, b"hello").await.unwrap();
        let got = store.read(id).await.unwrap().unwrap();
        assert_eq!(got, b"hello");

        let ids = store.list().await.unwrap();
        assert_eq!(ids, vec![id.to_string()]);

        store.delete(id).await.unwrap();
        assert!(store.read(id).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn file_store_lists_sorted_and_skips_non_json() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileWalletPoolStore::new(dir.path());

        store.write("wp_b", b"2").await.unwrap();
        store.write("wp_a", b"1").await.unwrap();
        fs::write(dir.path().join("readme.txt"), b"not a pool")
            .await
            .unwrap();

        let ids = store.list().await.unwrap();
        assert_eq!(ids, vec!["wp_a".to_string(), "wp_b".to_string()]);
    }

    #[tokio::test]
    async fn file_store_list_returns_empty_when_missing_dir() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileWalletPoolStore::new(dir.path().join("does-not-exist"));
        assert!(store.list().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn file_store_rejects_invalid_ids() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileWalletPoolStore::new(dir.path());

        let bad_ids = [
            "wp_",
            "wp_test/escape",
            "wp_test\\escape",
            "no_prefix",
            "wp_hello.world",
            "wp_hello world",
            "wp_hello\x00null",
        ];

        for id in bad_ids {
            assert!(
                store.write(id, b"x").await.is_err(),
                "expected error for id: {id}"
            );
            assert!(store.read(id).await.is_err(), "expected error for id: {id}");
            assert!(
                store.delete(id).await.is_err(),
                "expected error for id: {id}"
            );
        }
    }

    #[tokio::test]
    async fn file_store_accepts_valid_ids() {
        let dir = tempfile::tempdir().unwrap();
        let store = FileWalletPoolStore::new(dir.path());

        let valid_ids = ["wp_a", "wp_A", "wp_1", "wp_abc-123_DEF", "wp________"];

        for id in valid_ids {
            store.write(id, b"ok").await.expect("valid id should write");
            assert_eq!(store.read(id).await.unwrap().unwrap(), b"ok");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn file_store_sets_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let store = FileWalletPoolStore::new(dir.path());

        store.write("wp_perm", b"secret").await.unwrap();

        let dir_mode = fs::metadata(dir.path()).await.unwrap().permissions().mode();
        assert_eq!(dir_mode & 0o777, 0o700);

        let file_mode = fs::metadata(dir.path().join("wp_perm.json"))
            .await
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(file_mode & 0o777, 0o600);
    }
}
