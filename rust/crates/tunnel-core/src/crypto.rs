//! blake2b256 + ed25519, matching `crypto.ts` (noble) and `signature.move`.

use blake2::digest::consts::U32;
use blake2::{Blake2b, Digest};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};

type Blake2b256 = Blake2b<U32>;

/// Unkeyed BLAKE2b with 32-byte output. Matches `crypto.ts::blake2b256`.
pub fn blake2b256(data: &[u8]) -> [u8; 32] {
    let mut hasher = Blake2b256::new();
    hasher.update(data);
    hasher.finalize().into()
}

/// An ed25519 keypair derived from a 32-byte seed (deterministic, RFC-8032).
#[derive(Clone)]
pub struct KeyPair {
    signing: SigningKey,
}

/// Derive a keypair from a 32-byte ed25519 seed (deterministic, RFC-8032).
pub fn keypair_from_secret(secret: &[u8; 32]) -> KeyPair {
    KeyPair {
        signing: SigningKey::from_bytes(secret),
    }
}

impl KeyPair {
    pub fn public_key(&self) -> [u8; 32] {
        self.signing.verifying_key().to_bytes()
    }

    pub fn sign(&self, msg: &[u8]) -> [u8; 64] {
        self.signing.sign(msg).to_bytes()
    }
}

/// Verify an ed25519 signature over the RAW message (no pre-hash).
pub fn verify(pk: &[u8; 32], msg: &[u8], sig: &[u8; 64]) -> bool {
    let Ok(vk) = VerifyingKey::from_bytes(pk) else {
        return false;
    };
    vk.verify(msg, &Signature::from_bytes(sig)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(s: &str) -> Vec<u8> {
        hex::decode(s).unwrap()
    }

    #[test]
    fn blake2b256_matches_golden_hello() {
        let got = blake2b256(b"hello");
        assert_eq!(
            hex::encode(got),
            "324dcf027dd4a30a932c441f365a25e86b173defa4b8e58948253471b81b72cf"
        );
    }

    #[test]
    fn ed25519_public_key_matches_golden() {
        // secretA = 0x01..0x20
        let secret: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let kp = keypair_from_secret(&secret);
        assert_eq!(
            hex::encode(kp.public_key()),
            "79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664"
        );
    }

    #[test]
    fn ed25519_signature_matches_golden() {
        // The state_update golden message, signed by secretA -> SIG_A.
        let su = h("7375695f74756e6e656c3a3a73746174655f75706461746500000000000000000000000000000000000000000000000000000000000000ab0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20000000000000002a00000000499602d200000000000003e800000000000007d0");
        let secret: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let kp = keypair_from_secret(&secret);
        let sig = kp.sign(&su);
        assert_eq!(hex::encode(sig),
            "6941c8ba5bd00d2695d5edd6d33e3fb3e46a83685e09717382b0b0b82246726323a6abc9bec1ebb8535bb3100a03bf5205e7ce5c898f8d071916c4c795ac180b");
        assert!(verify(&kp.public_key(), &su, &sig));
    }
}
