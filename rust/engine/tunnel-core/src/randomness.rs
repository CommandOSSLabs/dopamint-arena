//! Verifiable randomness helpers, byte-compatible with `sui-tunnel-ts/src/core/randomness.ts`.

use crate::codec::u64_to_be_bytes;
use crate::crypto::blake2b256;

const DOMAIN_CHAIN: &[u8] = b"sui_tunnel::randomness::chain";
const U64_MAX: u128 = u64::MAX as u128;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Seed {
    pub bytes: [u8; 32],
    pub counter: u64,
}

pub fn seed_from_bytes(bytes: [u8; 32]) -> Seed {
    Seed { bytes, counter: 0 }
}

pub fn next_seed(seed: Seed) -> Seed {
    let mut input = Vec::with_capacity(DOMAIN_CHAIN.len() + 32 + 8);
    input.extend_from_slice(DOMAIN_CHAIN);
    input.extend_from_slice(&seed.bytes);
    input.extend_from_slice(&u64_to_be_bytes(seed.counter));
    Seed {
        bytes: blake2b256(&input),
        counter: 0,
    }
}

fn bytes_to_u64_be(bytes: &[u8; 32]) -> u64 {
    let mut out = [0u8; 8];
    out.copy_from_slice(&bytes[..8]);
    u64::from_be_bytes(out)
}

pub fn next_u64(seed: Seed) -> (u64, Seed) {
    let ns = next_seed(seed);
    (
        bytes_to_u64_be(&ns.bytes),
        Seed {
            bytes: ns.bytes,
            counter: ns.counter + 1,
        },
    )
}

pub fn next_u64_in_range(seed: Seed, min: u64, max: u64) -> Result<(u64, Seed), String> {
    if min >= max {
        return Err("invalid randomness range".into());
    }
    let range = (max - min) as u128;
    if range == 1 {
        let ns = next_seed(seed);
        return Ok((
            min,
            Seed {
                bytes: ns.bytes,
                counter: ns.counter + 1,
            },
        ));
    }

    let remainder = ((U64_MAX % range) + 1) % range;
    let threshold = if remainder == 0 {
        0
    } else {
        U64_MAX - remainder + 1
    };
    let mut current = seed;
    loop {
        let ns = next_seed(current);
        let raw = bytes_to_u64_be(&ns.bytes) as u128;
        if threshold == 0 || raw < threshold {
            return Ok((
                (raw % range) as u64 + min,
                Seed {
                    bytes: ns.bytes,
                    counter: ns.counter + 1,
                },
            ));
        }
        current = ns;
    }
}
