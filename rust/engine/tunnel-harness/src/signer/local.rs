//! Local ed25519 signer.

use super::Signer;
use tunnel_core::crypto::{keypair_from_secret, KeyPair};

#[derive(Clone)]
pub struct LocalSigner {
    kp: KeyPair,
    pk: [u8; 32],
}

impl LocalSigner {
    pub fn from_secret(secret: &[u8; 32]) -> LocalSigner {
        let kp = keypair_from_secret(secret);
        let pk = kp.public_key();
        LocalSigner { kp, pk }
    }
}

impl Signer for LocalSigner {
    fn public_key(&self) -> [u8; 32] {
        self.pk
    }

    fn sign(&self, msg: &[u8]) -> [u8; 64] {
        self.kp.sign(msg)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tunnel_core::crypto::verify;

    #[test]
    fn signs_a_verifiable_signature() {
        let secret: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let signer = LocalSigner::from_secret(&secret);
        let sig = signer.sign(b"hello");
        assert!(verify(&signer.public_key(), b"hello", &sig));
        assert!(!verify(&signer.public_key(), b"tampered", &sig));
    }
}
