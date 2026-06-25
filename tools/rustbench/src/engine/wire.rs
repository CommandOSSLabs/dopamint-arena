//! Canonical signed-message wire format. Byte-identical to `wire.ts` and the
//! Move serializers in `sui_tunnel/sources/tunnel.move`.
//!
//! Load-bearing: domain prefixes are inlined ASCII (no length prefix); all u64s
//! are 8-byte big-endian; `state_update` and `settlement` use DIFFERENT field
//! orderings. ed25519 verifies the RAW message — only `state_hash` is a digest.

use crate::engine::codec::{address_to_bytes32, u64_to_be_bytes};

pub const DOMAIN_STATE_UPDATE: &[u8] = b"sui_tunnel::state_update";
pub const DOMAIN_SETTLEMENT: &[u8] = b"sui_tunnel::settlement";
pub const DOMAIN_SETTLEMENT_V2: &[u8] = b"sui_tunnel::settlement_v2";
pub const DOMAIN_HTLC_LOCK: &[u8] = b"sui_tunnel::htlc_lock";

pub struct StateUpdate {
    pub tunnel_id: String,
    pub state_hash: [u8; 32],
    pub nonce: u64,
    pub timestamp: u64,
    pub party_a_balance: u64,
    pub party_b_balance: u64,
}

/// Mirrors `tunnel::serialize_state_update`.
/// Order: domain, id, state_hash, nonce, timestamp, balA, balB.
pub fn serialize_state_update(u: &StateUpdate) -> Vec<u8> {
    let id = address_to_bytes32(&u.tunnel_id).expect("valid tunnel id");
    let mut out = Vec::with_capacity(DOMAIN_STATE_UPDATE.len() + 32 + 32 + 4 * 8);
    out.extend_from_slice(DOMAIN_STATE_UPDATE);
    out.extend_from_slice(&id);
    out.extend_from_slice(&u.state_hash);
    out.extend_from_slice(&u64_to_be_bytes(u.nonce));
    out.extend_from_slice(&u64_to_be_bytes(u.timestamp));
    out.extend_from_slice(&u64_to_be_bytes(u.party_a_balance));
    out.extend_from_slice(&u64_to_be_bytes(u.party_b_balance));
    out
}

pub struct Settlement {
    pub tunnel_id: String,
    pub party_a_balance: u64,
    pub party_b_balance: u64,
    pub final_nonce: u64,
    pub timestamp: u64,
}

/// Mirrors `tunnel::serialize_settlement`.
/// Order: domain, id, balA, balB, final_nonce, timestamp.
pub fn serialize_settlement(s: &Settlement) -> Vec<u8> {
    let id = address_to_bytes32(&s.tunnel_id).expect("valid tunnel id");
    let mut out = Vec::with_capacity(DOMAIN_SETTLEMENT.len() + 32 + 4 * 8);
    out.extend_from_slice(DOMAIN_SETTLEMENT);
    out.extend_from_slice(&id);
    out.extend_from_slice(&u64_to_be_bytes(s.party_a_balance));
    out.extend_from_slice(&u64_to_be_bytes(s.party_b_balance));
    out.extend_from_slice(&u64_to_be_bytes(s.final_nonce));
    out.extend_from_slice(&u64_to_be_bytes(s.timestamp));
    out
}

/// Mirrors `tunnel::serialize_settlement_with_root`. Same fields as settlement
/// plus a trailing 32-byte transcript root, under the v2 domain.
pub fn serialize_settlement_with_root(s: &Settlement, transcript_root: &[u8; 32]) -> Vec<u8> {
    let id = address_to_bytes32(&s.tunnel_id).expect("valid tunnel id");
    let mut out = Vec::with_capacity(DOMAIN_SETTLEMENT_V2.len() + 32 + 4 * 8 + 32);
    out.extend_from_slice(DOMAIN_SETTLEMENT_V2);
    out.extend_from_slice(&id);
    out.extend_from_slice(&u64_to_be_bytes(s.party_a_balance));
    out.extend_from_slice(&u64_to_be_bytes(s.party_b_balance));
    out.extend_from_slice(&u64_to_be_bytes(s.final_nonce));
    out.extend_from_slice(&u64_to_be_bytes(s.timestamp));
    out.extend_from_slice(transcript_root);
    out
}

pub struct HtlcLock {
    pub tunnel_id: String,
    pub payment_hash: [u8; 32],
    pub amount: u64,
    pub sender: String,
    pub receiver: String,
    pub expiry_ms: u64,
}

/// Mirrors `tunnel::serialize_htlc_lock`.
/// Order: domain, id, payment_hash, amount, sender, receiver, expiry_ms.
pub fn serialize_htlc_lock(h: &HtlcLock) -> Vec<u8> {
    let id = address_to_bytes32(&h.tunnel_id).expect("valid tunnel id");
    let sender = address_to_bytes32(&h.sender).expect("valid sender");
    let receiver = address_to_bytes32(&h.receiver).expect("valid receiver");
    let mut out = Vec::with_capacity(DOMAIN_HTLC_LOCK.len() + 4 * 32 + 2 * 8);
    out.extend_from_slice(DOMAIN_HTLC_LOCK);
    out.extend_from_slice(&id);
    out.extend_from_slice(&h.payment_hash);
    out.extend_from_slice(&u64_to_be_bytes(h.amount));
    out.extend_from_slice(&sender);
    out.extend_from_slice(&receiver);
    out.extend_from_slice(&u64_to_be_bytes(h.expiry_ms));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state_hash_1_to_32() -> [u8; 32] {
        std::array::from_fn(|i| (i + 1) as u8)
    }

    #[test]
    fn state_update_matches_golden() {
        let u = StateUpdate {
            tunnel_id: "0xab".into(),
            state_hash: state_hash_1_to_32(),
            nonce: 42,
            timestamp: 1234567890,
            party_a_balance: 1000,
            party_b_balance: 2000,
        };
        assert_eq!(hex::encode(serialize_state_update(&u)),
            "7375695f74756e6e656c3a3a73746174655f75706461746500000000000000000000000000000000000000000000000000000000000000ab0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20000000000000002a00000000499602d200000000000003e800000000000007d0");
    }

    #[test]
    fn settlement_matches_golden() {
        let s = Settlement {
            tunnel_id: "0xab".into(),
            party_a_balance: 1000,
            party_b_balance: 2000,
            final_nonce: 43,
            timestamp: 1234567890,
        };
        assert_eq!(hex::encode(serialize_settlement(&s)),
            "7375695f74756e6e656c3a3a736574746c656d656e7400000000000000000000000000000000000000000000000000000000000000ab00000000000003e800000000000007d0000000000000002b00000000499602d2");
    }

    #[test]
    fn settlement_with_root_matches_golden() {
        let s = Settlement {
            tunnel_id: "0xab".into(),
            party_a_balance: 1000,
            party_b_balance: 2000,
            final_nonce: 43,
            timestamp: 1234567890,
        };
        assert_eq!(hex::encode(serialize_settlement_with_root(&s, &state_hash_1_to_32())),
            "7375695f74756e6e656c3a3a736574746c656d656e745f763200000000000000000000000000000000000000000000000000000000000000ab00000000000003e800000000000007d0000000000000002b00000000499602d20102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20");
    }

    #[test]
    fn htlc_lock_matches_golden() {
        let h = HtlcLock {
            tunnel_id: "0xab".into(),
            payment_hash: state_hash_1_to_32(),
            amount: 500,
            sender: "0xaa".into(),
            receiver: "0xbb".into(),
            expiry_ms: 9999999,
        };
        assert_eq!(hex::encode(serialize_htlc_lock(&h)),
            "7375695f74756e6e656c3a3a68746c635f6c6f636b00000000000000000000000000000000000000000000000000000000000000ab0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f2000000000000001f400000000000000000000000000000000000000000000000000000000000000aa00000000000000000000000000000000000000000000000000000000000000bb000000000098967f");
    }
}
