//! Connect-handshake signature verification. v1 verifies the ed25519 signature over the
//! server nonce (proves key control); wallet<->pubkey address derivation is a noted
//! follow-up. Uses `ed25519-dalek` directly.

use ed25519_dalek::{Signature, Verifier, VerifyingKey};

/// True iff `sig_hex` is a valid ed25519 signature by `pubkey_hex` over `message`.
/// All inputs are `0x`-optional hex; malformed inputs verify as false (never panic).
pub fn verify_ed25519(pubkey_hex: &str, message: &[u8], sig_hex: &str) -> bool {
    let pk = match decode32(pubkey_hex) {
        Some(b) => b,
        None => return false,
    };
    let sig_bytes = match hex::decode(sig_hex.trim_start_matches("0x")) {
        Ok(b) if b.len() == 64 => b,
        _ => return false,
    };
    let vk = match VerifyingKey::from_bytes(&pk) {
        Ok(v) => v,
        Err(_) => return false,
    };
    match Signature::from_slice(&sig_bytes) {
        Ok(sig) => vk.verify(message, &sig).is_ok(),
        Err(_) => false,
    }
}

fn decode32(hex_str: &str) -> Option<[u8; 32]> {
    let v = hex::decode(hex_str.trim_start_matches("0x")).ok()?;
    if v.len() != 32 {
        return None;
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&v);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    // A genuine signature over the nonce verifies; a tampered message does not.
    #[test]
    fn verify_ed25519_accepts_genuine_rejects_tampered() {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pk_hex = hex::encode(sk.verifying_key().to_bytes());
        let nonce = b"server-nonce-123";
        let sig_hex = hex::encode(sk.sign(nonce).to_bytes());
        assert!(verify_ed25519(&pk_hex, nonce, &sig_hex));
        assert!(!verify_ed25519(&pk_hex, b"different-nonce", &sig_hex));
        assert!(!verify_ed25519("zz", nonce, &sig_hex), "garbage pubkey -> false");
    }
}
