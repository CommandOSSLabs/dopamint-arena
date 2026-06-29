//! Sealed envelope: AES-256-GCM with key derivation via HKDF or scrypt.
//!
//! Matches the TypeScript wallet-pool JSON envelope shape.

use crate::crypto::random_bytes;
use crate::error::{Error, Result};
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use hkdf::Hkdf;
use serde::{Deserialize, Serialize};
use sha2::Sha256;

/// How an envelope's AES key is derived from the access value.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AccessMode {
    /// Access value is a base64url-encoded 32-byte secret; key is HKDF-SHA256.
    Generated,
    /// Access value is a user passphrase; key is scrypt.
    Passphrase,
}

/// scrypt parameters stored alongside a passphrase-sealed envelope.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[allow(non_snake_case)]
pub struct ScryptKdf {
    pub name: String,
    pub salt: String,
    pub N: u32,
    pub r: u32,
    pub p: u32,
}

/// A sealed payload: AES-256-GCM ciphertext plus everything needed to reopen it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SealedEnvelope {
    pub mode: AccessMode,
    pub kdf: Option<ScryptKdf>,
    pub nonce: String,
    pub tag: String,
    pub ciphertext: String,
}

const NONCE_LEN: usize = 12;
const TAG_LEN: usize = 16;
const KEY_LEN: usize = 32;
const SCRYPT_SALT_LEN: usize = 16;
const SCRYPT_N: u32 = 16384;
const SCRYPT_R: u32 = 8;
const SCRYPT_P: u32 = 1;
const SCRYPT_LOG_N: u8 = 14;

/// Generates a fresh access value for [`AccessMode::Generated`].
///
/// Returns 32 random bytes encoded as URL-safe base64 without padding.
pub fn generate_access_value() -> String {
    URL_SAFE_NO_PAD.encode(random_bytes(KEY_LEN))
}

/// Seals `plaintext` with an access value and optional additional authenticated data.
pub fn seal(
    plaintext: &[u8],
    access_value: &str,
    mode: AccessMode,
    aad: &[u8],
) -> Result<SealedEnvelope> {
    let nonce_bytes = random_bytes(NONCE_LEN);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let (key, kdf) = match mode {
        AccessMode::Generated => (derive_generated_key(access_value)?, None),
        AccessMode::Passphrase => {
            let salt = random_bytes(SCRYPT_SALT_LEN);
            let key = derive_passphrase_key(access_value, &salt)?;
            let kdf = ScryptKdf {
                name: "scrypt".into(),
                salt: STANDARD.encode(&salt),
                N: SCRYPT_N,
                r: SCRYPT_R,
                p: SCRYPT_P,
            };
            (key, Some(kdf))
        }
    };

    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| Error::WrongAccessValue)?;
    let encrypted = cipher
        .encrypt(nonce, Payload { msg: plaintext, aad })
        .map_err(|_| Error::WrongAccessValue)?;

    let (ciphertext, tag) = encrypted
        .split_last_chunk::<TAG_LEN>()
        .ok_or(Error::WrongAccessValue)?;

    Ok(SealedEnvelope {
        mode,
        kdf,
        nonce: STANDARD.encode(nonce_bytes),
        tag: STANDARD.encode(tag),
        ciphertext: STANDARD.encode(ciphertext),
    })
}

/// Opens a [`SealedEnvelope`] using the access value and matching AAD.
pub fn unseal(envelope: &SealedEnvelope, access_value: &str, aad: &[u8]) -> Result<Vec<u8>> {
    let key = match envelope.mode {
        AccessMode::Generated => derive_generated_key(access_value)?,
        AccessMode::Passphrase => {
            let kdf = envelope.kdf.as_ref().ok_or(Error::WrongAccessValue)?;
            if kdf.N != SCRYPT_N || kdf.r != SCRYPT_R || kdf.p != SCRYPT_P {
                return Err(Error::WrongAccessValue);
            }
            let salt = STANDARD.decode(&kdf.salt).map_err(|_| Error::WrongAccessValue)?;
            derive_passphrase_key(access_value, &salt)?
        }
    };

    let nonce_bytes = STANDARD.decode(&envelope.nonce).map_err(|_| Error::WrongAccessValue)?;
    if nonce_bytes.len() != NONCE_LEN {
        return Err(Error::WrongAccessValue);
    }
    let nonce = Nonce::from_slice(&nonce_bytes);

    let mut ct_with_tag =
        STANDARD.decode(&envelope.ciphertext).map_err(|_| Error::WrongAccessValue)?;
    let tag = STANDARD.decode(&envelope.tag).map_err(|_| Error::WrongAccessValue)?;
    if tag.len() != TAG_LEN {
        return Err(Error::WrongAccessValue);
    }
    ct_with_tag.extend_from_slice(&tag);

    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| Error::WrongAccessValue)?;
    cipher
        .decrypt(nonce, Payload { msg: &ct_with_tag, aad })
        .map_err(|_| Error::WrongAccessValue)
}

fn derive_generated_key(access_value: &str) -> Result<[u8; KEY_LEN]> {
    let ikm = URL_SAFE_NO_PAD
        .decode(access_value)
        .map_err(|_| Error::WrongAccessValue)?;
    if ikm.len() != KEY_LEN {
        return Err(Error::WrongAccessValue);
    }
    let hkdf = Hkdf::<Sha256>::new(None, &ikm);
    let mut key = [0u8; KEY_LEN];
    hkdf.expand(&[], &mut key)
        .map_err(|_| Error::WrongAccessValue)?;
    Ok(key)
}

fn derive_passphrase_key(access_value: &str, salt: &[u8]) -> Result<[u8; KEY_LEN]> {
    let params =
        scrypt::Params::new(SCRYPT_LOG_N, SCRYPT_R, SCRYPT_P, KEY_LEN)
            .map_err(|_| Error::WrongAccessValue)?;
    let mut key = [0u8; KEY_LEN];
    scrypt::scrypt(access_value.as_bytes(), salt, &params, &mut key)
        .map_err(|_| Error::WrongAccessValue)?;
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_mode_round_trip() {
        let access = generate_access_value();
        let plaintext = b"the quick brown fox";
        let aad = b"wallet-pool:1:wp_test:testnet";

        let envelope = seal(plaintext, &access, AccessMode::Generated, aad).unwrap();
        assert_eq!(envelope.mode, AccessMode::Generated);
        assert!(envelope.kdf.is_none());

        let opened = unseal(&envelope, &access, aad).unwrap();
        assert_eq!(opened, plaintext.as_slice());
    }

    #[test]
    fn passphrase_mode_round_trip() {
        let access = "correct horse battery staple";
        let plaintext = b"the quick brown fox";
        let aad = b"wallet-pool:1:wp_test:testnet";

        let envelope = seal(plaintext, access, AccessMode::Passphrase, aad).unwrap();
        assert_eq!(envelope.mode, AccessMode::Passphrase);
        assert!(envelope.kdf.is_some());

        let opened = unseal(&envelope, access, aad).unwrap();
        assert_eq!(opened, plaintext.as_slice());
    }

    #[test]
    fn wrong_access_value_returns_wrong_access_value() {
        let access = generate_access_value();
        let plaintext = b"secret";
        let aad = b"wallet-pool:1:wp_test:testnet";

        let envelope = seal(plaintext, &access, AccessMode::Generated, aad).unwrap();
        assert_eq!(
            unseal(&envelope, "not-the-right-value", aad),
            Err(Error::WrongAccessValue)
        );

        let envelope = seal(plaintext, "a passphrase", AccessMode::Passphrase, aad).unwrap();
        assert_eq!(
            unseal(&envelope, "wrong passphrase", aad),
            Err(Error::WrongAccessValue)
        );
    }

    #[test]
    fn tampered_aad_returns_wrong_access_value() {
        let access = generate_access_value();
        let plaintext = b"secret";
        let aad = b"wallet-pool:1:wp_test:testnet";

        let envelope = seal(plaintext, &access, AccessMode::Generated, aad).unwrap();
        assert_eq!(
            unseal(&envelope, &access, b"tampered-aad"),
            Err(Error::WrongAccessValue)
        );
    }

    #[test]
    fn tampered_ciphertext_returns_wrong_access_value() {
        let access = generate_access_value();
        let plaintext = b"secret";
        let aad = b"wallet-pool:1:wp_test:testnet";

        let mut envelope = seal(plaintext, &access, AccessMode::Generated, aad).unwrap();
        let mut ct = STANDARD
            .decode(&envelope.ciphertext)
            .expect("valid ciphertext");
        ct[0] ^= 0xff;
        envelope.ciphertext = STANDARD.encode(&ct);

        assert_eq!(
            unseal(&envelope, &access, aad),
            Err(Error::WrongAccessValue)
        );
    }
}
