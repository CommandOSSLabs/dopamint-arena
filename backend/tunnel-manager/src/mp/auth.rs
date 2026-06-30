//! Connect-handshake signature verification. The client proves key control by signing the
//! server nonce and proves wallet ownership by presenting the Ed25519 public key that derives
//! to the claimed Sui address.

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use sui_sdk_types::{Address, Ed25519PublicKey};

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

/// True iff `pubkey_hex` derives to the claimed Sui `wallet` address.
/// All inputs are malformed-as-false and accept `0x`-optional hex.
pub fn ed25519_pubkey_matches_wallet(pubkey_hex: &str, wallet: &str) -> bool {
    let Some(pk) = decode32(pubkey_hex) else {
        return false;
    };
    let Ok(wallet) = Address::from_hex(wallet) else {
        return false;
    };
    Ed25519PublicKey::new(pk).derive_address() == wallet
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
        assert!(
            !verify_ed25519("zz", nonce, &sig_hex),
            "garbage pubkey -> false"
        );
    }

    // The WebSocket `wallet` claim must be the Sui address derived from the signing key.
    #[test]
    fn ed25519_pubkey_matches_wallet_binds_sui_address() {
        let sk = SigningKey::from_bytes(&[7u8; 32]);
        let pk = sk.verifying_key().to_bytes();
        let pk_hex = hex::encode(pk);
        let wallet = Ed25519PublicKey::new(pk).derive_address().to_string();

        assert!(ed25519_pubkey_matches_wallet(&pk_hex, &wallet));
        assert!(ed25519_pubkey_matches_wallet(
            &format!("0x{pk_hex}"),
            &wallet
        ));
        assert!(!ed25519_pubkey_matches_wallet(
            &pk_hex,
            &Address::ZERO.to_string()
        ));
        assert!(!ed25519_pubkey_matches_wallet("zz", &wallet));
        assert!(!ed25519_pubkey_matches_wallet(&pk_hex, "not-an-address"));
    }
}
