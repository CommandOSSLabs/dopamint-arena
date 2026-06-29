//! Pool blob data model and serde.
//!
//! `PoolBlob` is the public, plaintext header of a wallet pool. The secret
//! member keys live inside [`SealedEnvelope`] and are never exposed in this
//! structure. The plaintext format of the encrypted payload is [`SealedMembers`].

use crate::crypto::{ed25519_address, generate_keypair, keypair_from_secret, random_bytes};
use crate::envelope::{AccessMode, SealedEnvelope};
use crate::error::{Error, Result};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::str::FromStr;

/// Current on-disk format version for pool blobs.
pub const BLOB_VERSION: u32 = 1;

/// Network a pool is bound to. Serialized as lowercase in JSON.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Network {
    Mainnet,
    Testnet,
}

impl std::fmt::Display for Network {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Network::Mainnet => write!(f, "mainnet"),
            Network::Testnet => write!(f, "testnet"),
        }
    }
}

impl FromStr for Network {
    type Err = Error;

    fn from_str(s: &str) -> Result<Self> {
        match s {
            "mainnet" => Ok(Network::Mainnet),
            "testnet" => Ok(Network::Testnet),
            _ => Err(Error::InvalidInput(format!("unknown network: {s}"))),
        }
    }
}

/// Role of a wallet entry in the pool. Serialized as lowercase in JSON.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WalletRole {
    Master,
    Member,
}

/// One entry in the public pool index. Contains no secret material.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WalletEntry {
    pub role: WalletRole,
    pub address: String,
    pub ordinal: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub created_at: u64,
    pub enabled: bool,
    pub use_count: u64,
    pub last_used_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_funded_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub funded_amounts: Option<HashMap<String, String>>,
}

/// Top-level pool blob. The `crypto` field holds the encrypted secrets.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PoolBlob {
    pub version: u32,
    pub wallet_pool_id: String,
    pub network: Network,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub created_at: u64,
    pub coin_types: Vec<String>,
    pub crypto: SealedEnvelope,
    pub index: Vec<WalletEntry>,
}

/// Plaintext payload stored inside the sealed envelope.
///
/// Matches the TypeScript wire format: field names are camelCase and each
/// secret is a standard base64-encoded string.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SealedMembers {
    pub master_secret: String,
    pub members: Vec<MemberSecret>,
}

/// One member secret inside [`SealedMembers`].
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemberSecret {
    pub ordinal: u32,
    pub secret: String,
}

impl SealedMembers {
    /// Encode a 32-byte master secret into the wire-compatible base64 string.
    pub fn with_master_secret(master_secret: [u8; 32], members: Vec<MemberSecret>) -> Self {
        Self {
            master_secret: STANDARD.encode(master_secret),
            members,
        }
    }

    /// Decode the base64 master secret back into raw bytes.
    pub fn decoded_master_secret(&self) -> Result<[u8; 32]> {
        decode_32_bytes(&self.master_secret)
    }
}

impl MemberSecret {
    /// Encode a 32-byte member secret into the wire-compatible base64 string.
    pub fn new(ordinal: u32, secret: [u8; 32]) -> Self {
        Self {
            ordinal,
            secret: STANDARD.encode(secret),
        }
    }

    /// Decode the base64 member secret back into raw bytes.
    pub fn decoded_secret(&self) -> Result<[u8; 32]> {
        decode_32_bytes(&self.secret)
    }
}

fn decode_32_bytes(value: &str) -> Result<[u8; 32]> {
    let decoded = STANDARD
        .decode(value)
        .map_err(|e| Error::InvalidBlob(format!("invalid base64: {e}")))?;
    decoded
        .try_into()
        .map_err(|_| Error::InvalidBlob("expected 32-byte secret".into()))
}

/// Serialize a [`PoolBlob`] to pretty-printed JSON bytes.
pub fn serialize_blob(blob: &PoolBlob) -> Result<Vec<u8>> {
    serde_json::to_vec_pretty(blob)
        .map_err(|e| Error::InvalidBlob(format!("serialize failed: {e}")))
}

/// Parse and validate a [`PoolBlob`] from JSON bytes.
pub fn parse_blob(bytes: &[u8]) -> Result<PoolBlob> {
    let blob: PoolBlob = serde_json::from_slice(bytes)
        .map_err(|e| Error::InvalidBlob(format!("parse failed: {e}")))?;
    if blob.version != BLOB_VERSION {
        return Err(Error::InvalidBlob(format!(
            "unsupported blob version {} (expected {})",
            blob.version, BLOB_VERSION
        )));
    }
    Ok(blob)
}

/// Additional authenticated data binding the immutable identity fields of a pool.
///
/// The AAD intentionally excludes mutable fields such as the public `index` so
/// the index can be updated without re-sealing the secret payload.
pub fn aad_for(blob: &PoolBlob) -> Vec<u8> {
    format!(
        "wallet-pool:{}:{}:{}",
        blob.version, blob.wallet_pool_id, blob.network
    )
    .into_bytes()
}

/// Generates a fresh wallet pool identifier.
///
/// Format: `wp_` followed by 16 random bytes encoded as URL-safe base64
/// without padding.
pub fn generate_wallet_pool_id() -> String {
    format!("wp_{}", URL_SAFE_NO_PAD.encode(random_bytes(16)))
}

/// Result of creating a new pool blob, including the unsealed secrets.
///
/// The returned [`PoolBlob`] has a placeholder [`SealedEnvelope`] that the
/// caller must seal with the desired access value. The secrets are returned as
/// raw 32-byte ed25519 seeds so the caller can build the plaintext payload.
#[derive(Debug, PartialEq)]
pub struct CreateBlobResult {
    pub blob: PoolBlob,
    pub master_secret: [u8; 32],
    pub member_secrets: Vec<[u8; 32]>,
}

/// Creates a new pool blob with the requested number of member wallets.
///
/// # Errors
///
/// Returns [`Error::InvalidInput`] if `member_count` is zero or greater than
/// 10_000.
pub fn create_blob(
    network: Network,
    member_count: u32,
    master_seed: Option<[u8; 32]>,
    label: Option<String>,
) -> Result<CreateBlobResult> {
    if member_count == 0 || member_count > 10_000 {
        return Err(Error::InvalidInput(format!(
            "member_count must be between 1 and 10000, got {member_count}"
        )));
    }

    let master_kp = master_seed
        .map(|seed| keypair_from_secret(&seed))
        .unwrap_or_else(generate_keypair);
    let member_kps: Vec<_> = (0..member_count).map(|_| generate_keypair()).collect();
    let created_at = 0; // caller can replace with now_millis

    let mut index = Vec::with_capacity(1 + member_count as usize);
    index.push(WalletEntry {
        role: WalletRole::Master,
        address: ed25519_address(&master_kp.public_key()),
        ordinal: 0,
        label: None,
        created_at,
        enabled: true,
        use_count: 0,
        last_used_at: 0,
        last_funded_at: None,
        funded_amounts: None,
    });

    for (i, kp) in member_kps.iter().enumerate() {
        index.push(WalletEntry {
            role: WalletRole::Member,
            address: ed25519_address(&kp.public_key()),
            ordinal: (i + 1) as u32,
            label: None,
            created_at,
            enabled: true,
            use_count: 0,
            last_used_at: 0,
            last_funded_at: None,
            funded_amounts: None,
        });
    }

    let master_secret = master_kp.secret_key();
    let member_secrets: Vec<_> = member_kps.iter().map(|kp| kp.secret_key()).collect();

    let blob = PoolBlob {
        version: BLOB_VERSION,
        wallet_pool_id: generate_wallet_pool_id(),
        network,
        label,
        created_at,
        coin_types: vec!["0x2::sui::SUI".into()],
        crypto: SealedEnvelope {
            mode: AccessMode::Generated,
            kdf: None,
            nonce: String::new(),
            tag: String::new(),
            ciphertext: String::new(),
        },
        index,
    };

    Ok(CreateBlobResult {
        blob,
        master_secret,
        member_secrets,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::{AccessMode, SealedEnvelope};

    fn sample_envelope() -> SealedEnvelope {
        SealedEnvelope {
            mode: AccessMode::Generated,
            kdf: None,
            nonce: "AAAAAAAAAAAAAAAA".into(),
            tag: "AAAAAAAAAAAAAAAAAAAAAA==".into(),
            ciphertext: "AAAAAA==".into(),
        }
    }

    #[test]
    fn blob_round_trip() {
        let blob = PoolBlob {
            version: 1,
            wallet_pool_id: "wp_test".into(),
            network: Network::Mainnet,
            label: Some("test".into()),
            created_at: 1_234_567_890,
            coin_types: vec!["0x2::sui::SUI".into()],
            crypto: sample_envelope(),
            index: vec![WalletEntry {
                role: WalletRole::Master,
                address: "0xabc".into(),
                ordinal: 0,
                label: None,
                created_at: 1_234_567_890,
                enabled: true,
                use_count: 5,
                last_used_at: 1_700_000_000,
                last_funded_at: Some(1_700_000_001),
                funded_amounts: Some(HashMap::from([(
                    "0x2::sui::SUI".into(),
                    "1000000000".into(),
                )])),
            }],
        };

        let bytes = serialize_blob(&blob).unwrap();
        let json = String::from_utf8(bytes.clone()).unwrap();
        assert!(json.contains("\"walletPoolId\": \"wp_test\""));
        assert!(json.contains("\"useCount\": 5"));
        assert!(json.contains("\"lastUsedAt\": 1700000000"));
        assert!(json.contains("\"fundedAmounts\""));

        let parsed = parse_blob(&bytes).unwrap();
        assert_eq!(parsed, blob);
    }

    #[test]
    fn sealed_members_ts_wire_format() {
        let master = [0u8; 32];
        let member_secret = [1u8; 32];
        let members =
            SealedMembers::with_master_secret(master, vec![MemberSecret::new(0, member_secret)]);

        let json = serde_json::to_string(&members).unwrap();
        assert!(
            json.contains("\"masterSecret\":"),
            "expected camelCase masterSecret: {json}"
        );
        assert!(
            json.contains("\"secret\":"),
            "expected camelCase secret: {json}"
        );
        assert!(
            !json.contains("master_secret"),
            "snake_case leaked into JSON: {json}"
        );

        let parsed: SealedMembers = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.decoded_master_secret().unwrap(), master);
        assert_eq!(parsed.members.len(), 1);
        assert_eq!(parsed.members[0].ordinal, 0);
        assert_eq!(parsed.members[0].decoded_secret().unwrap(), member_secret);

        // Verify the raw JSON shape uses base64 strings, not byte arrays.
        let raw: serde_json::Value = serde_json::from_str(&json).unwrap();
        let master_b64 = raw["masterSecret"].as_str().unwrap();
        assert_eq!(STANDARD.decode(master_b64).unwrap(), master.as_slice());
    }

    #[test]
    fn sealed_members_rejects_bad_base64_or_length() {
        let members = SealedMembers {
            master_secret: "not-base64!!!".into(),
            members: vec![],
        };
        assert!(members.decoded_master_secret().is_err());

        let members = SealedMembers {
            master_secret: STANDARD.encode([0u8; 16]),
            members: vec![],
        };
        assert!(members.decoded_master_secret().is_err());
    }

    #[test]
    fn parses_ts_shaped_blob() {
        let json = br#"{
            "version": 1,
            "walletPoolId": "wp_abc123",
            "network": "mainnet",
            "createdAt": 0,
            "coinTypes": ["0x2::sui::SUI"],
            "crypto": {
                "mode": "generated",
                "nonce": "AAAAAAAAAAAAAAAA",
                "tag": "AAAAAAAAAAAAAAAAAAAAAA==",
                "ciphertext": "AAAAAA=="
            },
            "index": [
                {
                    "role": "master",
                    "address": "0x1234",
                    "ordinal": 0,
                    "createdAt": 0,
                    "enabled": true,
                    "useCount": 0,
                    "lastUsedAt": 0,
                    "lastFundedAt": 42,
                    "fundedAmounts": {"0x2::sui::SUI":"1000"}
                }
            ]
        }"#;

        let blob = parse_blob(json).unwrap();
        assert_eq!(blob.wallet_pool_id, "wp_abc123");
        assert_eq!(blob.network, Network::Mainnet);
        assert_eq!(blob.index.len(), 1);
        let entry = &blob.index[0];
        assert_eq!(entry.role, WalletRole::Master);
        assert_eq!(entry.address, "0x1234");
        assert_eq!(entry.use_count, 0);
        assert_eq!(entry.last_funded_at, Some(42));
        assert_eq!(
            entry.funded_amounts,
            Some(HashMap::from([("0x2::sui::SUI".into(), "1000".into())]))
        );
    }

    #[test]
    fn aad_format() {
        let blob = PoolBlob {
            version: 1,
            wallet_pool_id: "wp_abc123".into(),
            network: Network::Testnet,
            label: None,
            created_at: 0,
            coin_types: vec![],
            crypto: sample_envelope(),
            index: vec![],
        };
        assert_eq!(aad_for(&blob), b"wallet-pool:1:wp_abc123:testnet");
    }

    #[test]
    fn parse_rejects_wrong_version() {
        let json = br#"{
            "version": 99,
            "walletPoolId": "wp_abc123",
            "network": "mainnet",
            "createdAt": 0,
            "coinTypes": [],
            "crypto": {
                "mode": "generated",
                "nonce": "AAAAAAAAAAAAAAAA",
                "tag": "AAAAAAAAAAAAAAAAAAAAAA==",
                "ciphertext": "AAAAAA=="
            },
            "index": []
        }"#;
        let err = parse_blob(json).unwrap_err();
        assert!(matches!(err, Error::InvalidBlob(_)));
        assert!(err.to_string().contains("unsupported blob version 99"));
    }

    #[test]
    fn network_display_and_from_str() {
        assert_eq!(Network::Mainnet.to_string(), "mainnet");
        assert_eq!(Network::Testnet.to_string(), "testnet");
        assert_eq!(Network::from_str("mainnet").unwrap(), Network::Mainnet);
        assert_eq!(Network::from_str("testnet").unwrap(), Network::Testnet);
        assert!(Network::from_str("devnet").is_err());
    }

    #[test]
    fn create_blob_smoke() {
        let result = create_blob(Network::Testnet, 3, None, Some("smoke".into())).unwrap();

        assert!(result.blob.wallet_pool_id.starts_with("wp_"));
        assert_eq!(result.blob.network, Network::Testnet);
        assert_eq!(result.blob.label, Some("smoke".into()));
        assert_eq!(result.blob.coin_types, vec!["0x2::sui::SUI"]);
        assert_eq!(result.blob.index.len(), 4);

        let master = &result.blob.index[0];
        assert_eq!(master.role, WalletRole::Master);
        assert_eq!(master.ordinal, 0);
        assert!(master.address.starts_with("0x"));
        assert!(master.enabled);

        for (i, entry) in result.blob.index.iter().skip(1).enumerate() {
            assert_eq!(entry.role, WalletRole::Member);
            assert_eq!(entry.ordinal, (i + 1) as u32);
            assert!(entry.address.starts_with("0x"));
            assert!(entry.enabled);
        }

        assert_eq!(result.member_secrets.len(), 3);
        for member_secret in &result.member_secrets {
            assert_ne!(*member_secret, result.master_secret);
        }
    }

    #[test]
    fn create_blob_member_bounds() {
        assert!(matches!(
            create_blob(Network::Testnet, 0, None, None),
            Err(Error::InvalidInput(_))
        ));
        assert!(matches!(
            create_blob(Network::Testnet, 10_001, None, None),
            Err(Error::InvalidInput(_))
        ));
        assert!(create_blob(Network::Testnet, 1, None, None).is_ok());
        assert!(create_blob(Network::Testnet, 10_000, None, None).is_ok());
    }
}
