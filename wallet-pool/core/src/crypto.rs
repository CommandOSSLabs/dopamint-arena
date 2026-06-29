//! Ed25519 keypair and Sui address derivation.
//!
//! Matches the byte conventions used by `rust/engine/tunnel-core/src/crypto.rs`:
//! - ed25519 seeds are 32-byte raw secrets (RFC-8032).
//! - Sui addresses are `0x || blake2b256(0x00 || pubkey)`.

use blake2::digest::consts::U32;
use blake2::{Blake2b, Digest};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use getrandom::getrandom;
use zeroize::{Zeroize, ZeroizeOnDrop};

type Blake2b256 = Blake2b<U32>;

/// An ed25519 keypair derived from a 32-byte seed.
///
/// The public key is cached so callers that need it repeatedly (e.g. address
/// derivation) do not pay the cost of recomputing the verifying key.
#[derive(Clone, Debug)]
pub struct KeyPair {
    signing: SigningKey,
    public: [u8; 32],
}

impl Zeroize for KeyPair {
    fn zeroize(&mut self) {
        // The `SigningKey` already zeroizes its secret bytes on drop via
        // `ZeroizeOnDrop`; we only need to explicitly clear the cached public key.
        self.public.zeroize();
    }
}

impl ZeroizeOnDrop for KeyPair {}

impl KeyPair {
    /// Returns the 32-byte ed25519 public key.
    pub fn public_key(&self) -> [u8; 32] {
        self.public
    }

    /// Returns the 32-byte ed25519 secret seed.
    pub fn secret_key(&self) -> [u8; 32] {
        self.signing.to_bytes()
    }

    /// Signs `msg` and returns the 64-byte raw ed25519 signature.
    pub fn sign(&self, msg: &[u8]) -> [u8; 64] {
        self.signing.sign(msg).to_bytes()
    }
}

/// Fills a fresh `Vec<u8>` with `n` cryptographically secure random bytes.
pub fn random_bytes(n: usize) -> Vec<u8> {
    let mut buf = vec![0u8; n];
    getrandom(&mut buf).expect("getrandom failed");
    buf
}

/// Generates a fresh random ed25519 keypair.
pub fn generate_keypair() -> KeyPair {
    let mut secret = [0u8; 32];
    getrandom(&mut secret).expect("getrandom failed");
    keypair_from_secret(&secret)
}

/// Derives a keypair from a 32-byte ed25519 secret seed.
pub fn keypair_from_secret(secret: &[u8; 32]) -> KeyPair {
    let signing = SigningKey::from_bytes(secret);
    let public = signing.verifying_key().to_bytes();
    KeyPair { signing, public }
}

/// Computes the raw 32-byte Sui address bytes for a 32-byte ed25519 public key.
///
/// Address format: `blake2b256(0x00 || public_key)`.
pub fn ed25519_address_bytes(public_key: &[u8; 32]) -> [u8; 32] {
    let mut data = Vec::with_capacity(1 + public_key.len());
    data.push(0x00);
    data.extend_from_slice(public_key);

    let mut hasher = Blake2b256::new();
    hasher.update(&data);
    hasher.finalize().into()
}

/// Computes the Sui address for a 32-byte ed25519 public key.
///
/// Address format: `0x || hex(blake2b256(0x00 || public_key))`.
pub fn ed25519_address(public_key: &[u8; 32]) -> String {
    format!("0x{}", hex::encode(ed25519_address_bytes(public_key)))
}

/// Verifies an ed25519 signature over the raw message (no pre-hash).
pub fn verify(public_key: &[u8; 32], msg: &[u8], sig: &[u8; 64]) -> bool {
    let Ok(vk) = VerifyingKey::from_bytes(public_key) else {
        return false;
    };
    vk.verify(msg, &Signature::from_bytes(sig)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ed25519_public_key_and_address_match_golden() {
        // Deterministic secret seed: 0x01..0x20.
        let secret: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let kp = keypair_from_secret(&secret);

        assert_eq!(
            hex::encode(kp.public_key()),
            "79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664"
        );
        assert_eq!(
            ed25519_address(&kp.public_key()),
            "0x7573c697fa68450f04fa0dee2d39dcdc8a5ccf5db547f3e47638a6f8eeeec110"
        );
    }

    #[test]
    fn signature_verifies() {
        let kp = generate_keypair();
        let msg = b"hello wallet-pool";
        let sig = kp.sign(msg);

        assert!(verify(&kp.public_key(), msg, &sig));

        // Mismatching message must fail.
        assert!(!verify(&kp.public_key(), b"other", &sig));
    }

    #[test]
    fn keypair_from_secret_round_trip() {
        let kp = generate_keypair();
        let kp2 = keypair_from_secret(&kp.secret_key());

        assert_eq!(kp.public_key(), kp2.public_key());
        assert_eq!(kp.secret_key(), kp2.secret_key());

        let msg = b"round-trip";
        let sig = kp.sign(msg);
        assert!(verify(&kp2.public_key(), msg, &sig));
    }
}
