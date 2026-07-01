//! A `Signer` whose key survives process restarts.
//!
//! v1 persists the raw 32-byte ed25519 secret to disk. In production this is swapped for a
//! KMS-backed impl (the secret never leaves the HSM) — same `Signer` seam, different backing.
//! Durability matters because a bot custodies an open on-chain tunnel with a multi-hour dispute
//! obligation; the watcher must be able to reconstruct the signer after any restart.

use std::path::Path;
use tunnel_harness::{LocalSigner, Signer};

pub struct DurableSigner {
    inner: LocalSigner,
    secret: [u8; 32],
}

impl DurableSigner {
    pub fn from_secret(secret: &[u8; 32]) -> DurableSigner {
        DurableSigner {
            inner: LocalSigner::from_secret(secret),
            secret: *secret,
        }
    }

    /// Persist the secret so a restarted process can `load` the same identity.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        std::fs::write(path, self.secret)
    }

    pub fn load(path: &Path) -> std::io::Result<DurableSigner> {
        let bytes = std::fs::read(path)?;
        let secret: [u8; 32] = bytes.as_slice().try_into().map_err(|_| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, "key file is not 32 bytes")
        })?;
        Ok(DurableSigner::from_secret(&secret))
    }
}

impl Signer for DurableSigner {
    fn public_key(&self) -> [u8; 32] {
        self.inner.public_key()
    }

    fn sign(&self, msg: &[u8]) -> [u8; 64] {
        self.inner.sign(msg)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tunnel_core::crypto::verify;

    fn secret() -> [u8; 32] {
        std::array::from_fn(|i| (i + 1) as u8)
    }

    #[test]
    fn signs_a_verifiable_signature() {
        let s = DurableSigner::from_secret(&secret());
        let sig = s.sign(b"hello");
        assert!(verify(&s.public_key(), b"hello", &sig));
        assert!(!verify(&s.public_key(), b"tampered", &sig));
    }

    #[test]
    fn survives_a_save_then_load() {
        let tmp = std::env::temp_dir().join("bot-fleet-durable-signer-test.key");
        let original = DurableSigner::from_secret(&secret());
        original.save(&tmp).unwrap();

        let reloaded = DurableSigner::load(&tmp).unwrap();
        // Same identity after a restart, and signatures from the reloaded key verify.
        assert_eq!(reloaded.public_key(), original.public_key());
        let sig = reloaded.sign(b"resume");
        assert!(verify(&original.public_key(), b"resume", &sig));

        std::fs::remove_file(&tmp).ok();
    }
}
