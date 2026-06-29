//! Two-party commit-reveal, byte-identical to `commitment.ts` / `randomness.move`.
//!
//!   commitment = blake2b256(DOMAIN || lp(value) || lp(salt))
//!   seed       = blake2b256(DOMAIN || lp(value_a) || lp(salt_a) || lp(value_b) || lp(salt_b))
//! where lp(x) = u64be(len(x)) || x.

use crate::codec::u64_to_be_bytes;
use crate::crypto::blake2b256;

pub const DOMAIN_COMMIT_REVEAL: &[u8] = b"sui_tunnel::randomness::commit_reveal";
pub const MIN_SALT_LEN: usize = 16;

fn push_length_prefixed(out: &mut Vec<u8>, x: &[u8]) {
    out.extend_from_slice(&u64_to_be_bytes(x.len() as u64));
    out.extend_from_slice(x);
}

fn hash_commitment(value: &[u8], salt: &[u8]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(DOMAIN_COMMIT_REVEAL.len() + 2 * 8 + value.len() + salt.len());
    buf.extend_from_slice(DOMAIN_COMMIT_REVEAL);
    push_length_prefixed(&mut buf, value);
    push_length_prefixed(&mut buf, salt);
    blake2b256(&buf)
}

/// Commit path. Enforces the >= 16-byte salt, mirroring `create_commitment`.
pub fn compute_commitment(value: &[u8], salt: &[u8]) -> Result<[u8; 32], String> {
    if salt.len() < MIN_SALT_LEN {
        return Err(format!(
            "salt must be >= {MIN_SALT_LEN} bytes, got {}",
            salt.len()
        ));
    }
    Ok(hash_commitment(value, salt))
}

/// Verify path. Never errors on short salt — returns false, mirroring
/// `verify_commitment`, which never aborts.
pub fn verify_commitment(commitment: &[u8; 32], value: &[u8], salt: &[u8]) -> bool {
    &hash_commitment(value, salt) == commitment
}

/// Combine two reveals into a 32-byte joint seed neither party can bias.
pub fn combine_reveals(value_a: &[u8], salt_a: &[u8], value_b: &[u8], salt_b: &[u8]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(
        DOMAIN_COMMIT_REVEAL.len()
            + 4 * 8
            + value_a.len()
            + salt_a.len()
            + value_b.len()
            + salt_b.len(),
    );
    buf.extend_from_slice(DOMAIN_COMMIT_REVEAL);
    push_length_prefixed(&mut buf, value_a);
    push_length_prefixed(&mut buf, salt_a);
    push_length_prefixed(&mut buf, value_b);
    push_length_prefixed(&mut buf, salt_b);
    blake2b256(&buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn commitment_matches_golden() {
        // valueA = [7], saltA = 1..16
        let salt_a: Vec<u8> = (1u8..=16).collect();
        let got = compute_commitment(&[7], &salt_a).unwrap();
        assert_eq!(
            hex::encode(got),
            "9c5d7de7c93e176f232424794b460112bbc1e3edad6af9da200a121e7033f9f9"
        );
        assert!(verify_commitment(&got, &[7], &salt_a));
    }

    #[test]
    fn short_salt_is_rejected_on_commit() {
        assert!(compute_commitment(&[7], &[0u8; 15]).is_err());
    }

    #[test]
    fn combine_reveals_matches_golden_seed() {
        let salt_a: Vec<u8> = (1u8..=16).collect();
        let salt_b: Vec<u8> = (17u8..=32).collect();
        let seed = combine_reveals(&[7], &salt_a, &[42], &salt_b);
        assert_eq!(
            hex::encode(seed),
            "3783060fbc9a59b74485cbd081355de0b78609fb6db3b76d0c97f937dac4b795"
        );
    }
}
