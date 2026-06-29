//! Sync, sans-IO core for the wallet-pool Rust rewrite.

pub mod blob;
pub mod crypto;
pub mod envelope;
pub mod error;
pub mod filter;
pub mod select;

#[cfg(test)]
mod tests {
    use crate::blob::{aad_for, create_blob, parse_blob, serialize_blob, Network, SealedMembers};
    use crate::crypto::{ed25519_address, keypair_from_secret};
    use crate::envelope::{seal, unseal, AccessMode};
    use crate::error::Error;

    #[test]
    fn create_seal_unseal_round_trip() {
        let master_seed: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let created = create_blob(Network::Testnet, 2, Some(master_seed), None).unwrap();

        let members = SealedMembers::with_master_secret(
            created.master_secret,
            created
                .member_secrets
                .iter()
                .enumerate()
                .map(|(i, secret)| crate::blob::MemberSecret::new((i + 1) as u32, *secret))
                .collect(),
        );

        let plaintext = serde_json::to_vec(&members).unwrap();
        let access = crate::envelope::generate_access_value();
        let aad = aad_for(&created.blob);

        let sealed = seal(&plaintext, &access, AccessMode::Generated, &aad).unwrap();
        let mut blob = created.blob.clone();
        blob.crypto = sealed;

        let json = serialize_blob(&blob).unwrap();
        let parsed = parse_blob(&json).unwrap();

        let opened = unseal(&parsed.crypto, &access, &aad_for(&parsed)).unwrap();
        let decoded: SealedMembers = serde_json::from_slice(&opened).unwrap();

        assert_eq!(decoded.decoded_master_secret().unwrap(), master_seed);
        assert_eq!(decoded.members.len(), 2);
        assert_eq!(
            decoded.members[0].decoded_secret().unwrap(),
            created.member_secrets[0]
        );
        assert_eq!(
            decoded.members[1].decoded_secret().unwrap(),
            created.member_secrets[1]
        );

        // The public index addresses must match the secrets we unsealed.
        let master_kp = keypair_from_secret(&decoded.decoded_master_secret().unwrap());
        assert_eq!(
            parsed.index[0].address,
            ed25519_address(&master_kp.public_key())
        );
    }

    #[test]
    fn aad_tamper_detection() {
        let created = create_blob(Network::Mainnet, 1, None, None).unwrap();
        let members = SealedMembers::with_master_secret(
            created.master_secret,
            created
                .member_secrets
                .iter()
                .enumerate()
                .map(|(i, secret)| crate::blob::MemberSecret::new((i + 1) as u32, *secret))
                .collect(),
        );

        let plaintext = serde_json::to_vec(&members).unwrap();
        let access = crate::envelope::generate_access_value();
        let aad = aad_for(&created.blob);
        let sealed = seal(&plaintext, &access, AccessMode::Generated, &aad).unwrap();

        assert_eq!(
            unseal(&sealed, &access, b"wallet-pool:1:wp_other:mainnet"),
            Err(Error::WrongAccessValue)
        );
    }

    #[test]
    fn address_derivation_matches_sui_ts() {
        // Deterministic secret seed used by the TS golden vector: [1..=32].
        let secret: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let kp = keypair_from_secret(&secret);
        let address = ed25519_address(&kp.public_key());

        assert_eq!(
            address,
            "0x7573c697fa68450f04fa0dee2d39dcdc8a5ccf5db547f3e47638a6f8eeeec110"
        );
    }

    #[test]
    fn pool_blob_json_keys_are_camel_case() {
        use crate::blob::{PoolBlob, WalletEntry, WalletRole};
        use crate::envelope::SealedEnvelope;
        use std::collections::HashMap;

        let blob = PoolBlob {
            version: 1,
            wallet_pool_id: "wp_camel".into(),
            network: Network::Testnet,
            label: Some("camel".into()),
            created_at: 1,
            coin_types: vec!["0x2::sui::SUI".into()],
            crypto: SealedEnvelope {
                mode: AccessMode::Generated,
                kdf: None,
                nonce: "AAAAAAAAAAAAAAAA".into(),
                tag: "AAAAAAAAAAAAAAAAAAAAAA==".into(),
                ciphertext: "AAAAAA==".into(),
            },
            index: vec![WalletEntry {
                role: WalletRole::Master,
                address: "0xabc".into(),
                ordinal: 0,
                label: None,
                created_at: 1,
                enabled: true,
                use_count: 2,
                last_used_at: 3,
                last_funded_at: Some(4),
                funded_amounts: Some(HashMap::from([("0x2::sui::SUI".into(), "1000".into())])),
            }],
        };

        let json = String::from_utf8(serialize_blob(&blob).unwrap()).unwrap();

        assert!(
            json.contains("\"walletPoolId\":"),
            "expected camelCase walletPoolId"
        );
        assert!(
            json.contains("\"createdAt\":"),
            "expected camelCase createdAt"
        );
        assert!(
            json.contains("\"coinTypes\":"),
            "expected camelCase coinTypes"
        );
        assert!(
            json.contains("\"lastUsedAt\":"),
            "expected camelCase lastUsedAt"
        );
        assert!(
            json.contains("\"lastFundedAt\":"),
            "expected camelCase lastFundedAt"
        );
        assert!(
            json.contains("\"fundedAmounts\":"),
            "expected camelCase fundedAmounts"
        );
        assert!(
            json.contains("\"useCount\":"),
            "expected camelCase useCount"
        );

        assert!(
            !json.contains("wallet_pool_id"),
            "snake_case wallet_pool_id leaked into JSON"
        );
        assert!(
            !json.contains("created_at"),
            "snake_case created_at leaked into JSON"
        );
        assert!(
            !json.contains("coin_types"),
            "snake_case coin_types leaked into JSON"
        );
    }
}
