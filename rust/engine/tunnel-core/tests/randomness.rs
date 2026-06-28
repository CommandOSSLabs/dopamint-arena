use tunnel_core::commitment::combine_reveals;
use tunnel_core::randomness::{next_u64_in_range, seed_from_bytes};

#[test]
fn next_u64_in_range_is_deterministic_and_bounded() {
    let seed_bytes = combine_reveals(&[7], &[1u8; 16], &[42], &[2u8; 16]);
    let seed = seed_from_bytes(seed_bytes);
    let (a, next) = next_u64_in_range(seed, 0, 13).unwrap();
    let (b, _) = next_u64_in_range(seed_from_bytes(seed_bytes), 0, 13).unwrap();
    assert_eq!(a, b);
    assert!(a < 13);
    assert_eq!(next.counter, 1);
}

#[test]
fn single_value_range_still_advances_seed_counter() {
    let seed = seed_from_bytes([9u8; 32]);
    let (value, next) = next_u64_in_range(seed, 5, 6).unwrap();
    assert_eq!(value, 5);
    assert_eq!(next.counter, 1);
}

#[test]
fn invalid_range_is_rejected() {
    assert!(next_u64_in_range(seed_from_bytes([0u8; 32]), 2, 2).is_err());
}
