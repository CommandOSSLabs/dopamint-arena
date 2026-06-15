#[test_only]
module sui_tunnel::randomness_tests;

use std::unit_test::assert_eq;
use sui_tunnel::randomness;

#[test]
fun from_bytes() {
    let seed1 = randomness::from_bytes(b"test seed 1");
    let seed2 = randomness::from_bytes(b"test seed 1");
    let seed3 = randomness::from_bytes(b"test seed 2");

    // Same input should produce same seed
    assert_eq!(*randomness::seed_bytes(&seed1), *randomness::seed_bytes(&seed2));

    // Different input should produce different seed
    assert!(*randomness::seed_bytes(&seed1) != *randomness::seed_bytes(&seed3));

    // Seed should be 32 bytes
    assert_eq!(randomness::seed_bytes(&seed1).length(), 32);

    // Counter should start at 0
    assert_eq!(randomness::seed_counter(&seed1), 0);
}

#[test]
fun next_seed_deterministic() {
    let seed = randomness::from_bytes(b"initial seed");

    let next1 = randomness::next_seed(&seed);
    let next2 = randomness::next_seed(&seed);

    // Same seed should produce same next seed
    assert_eq!(*randomness::seed_bytes(&next1), *randomness::seed_bytes(&next2));
}

#[test]
fun next_u64() {
    let seed = randomness::from_bytes(b"test seed");

    let (value1, seed1) = randomness::next_u64(&seed);
    let (value2, seed2) = randomness::next_u64(&seed);

    // Same seed should produce same value
    assert_eq!(value1, value2);

    // But the returned seeds should be same too (deterministic)
    assert_eq!(*randomness::seed_bytes(&seed1), *randomness::seed_bytes(&seed2));
}

/// Strengthened: prove the seed actually ADVANCES across consecutive draws.
/// A no-op next_seed would pass the determinism check above but fail here.
#[test]
fun next_u64_advances() {
    let seed = randomness::from_bytes(b"advance seed");

    // The input seed starts at counter 0.
    assert_eq!(randomness::seed_counter(&seed), 0);

    // Each draw derives a fresh chained seed via `next_seed` (which rehashes
    // and resets the counter), so the returned seed always carries counter == 1.
    let (value1, seed1) = randomness::next_u64(&seed);
    assert_eq!(randomness::seed_counter(&seed1), 1);

    // Second CONSECUTIVE draw (feeding the returned seed back in).
    let (value2, seed2) = randomness::next_u64(&seed1);
    assert_eq!(randomness::seed_counter(&seed2), 1);

    // The genuine advancement is in the seed BYTES: each draw rehashes the
    // prior seed, so the bytes move forward and never repeat the previous state.
    assert!(*randomness::seed_bytes(&seed1) != *randomness::seed_bytes(&seed));
    assert!(*randomness::seed_bytes(&seed2) != *randomness::seed_bytes(&seed1));

    // Consequently a second consecutive draw yields a DIFFERENT value than the
    // first; otherwise the seed would not really be advancing between draws.
    assert!(value1 != value2);
}

#[test]
fun next_u8_in_range() {
    let seed = randomness::from_bytes(b"test seed");

    // Test range [0, 52) for card game
    let (value, _) = randomness::next_u8_in_range(&seed, 0, 52);
    assert!(value < 52);

    // Test range [1, 7) for dice
    let (value2, _) = randomness::next_u8_in_range(&seed, 1, 7);
    assert!(value2 >= 1 && value2 < 7);
}

#[test]
fun next_u64_in_range() {
    let seed = randomness::from_bytes(b"test seed");

    let (value, _) = randomness::next_u64_in_range(&seed, 100, 200);
    assert!(value >= 100 && value < 200);

    let (value2, _) = randomness::next_u64_in_range(&seed, 0, 1);
    assert_eq!(value2, 0);
}

/// Strengthened rejection-sampling coverage for next_u64_in_range:
/// always-in-range, determinism, boundary ranges, full range, and a
/// non-power-of-2 range that makes the rejection branch reachable.
#[test]
fun next_u64_in_range_properties() {
    let seed = randomness::from_bytes(b"range props");

    // --- Always within [min, max) ---
    let (v, _) = randomness::next_u64_in_range(&seed, 100, 200);
    assert!(v >= 100 && v < 200);

    // --- Determinism: same seed + same range -> same value AND same seed bytes ---
    let (v_a, s_a) = randomness::next_u64_in_range(&seed, 100, 200);
    let (v_b, s_b) = randomness::next_u64_in_range(&seed, 100, 200);
    assert_eq!(v_a, v_b);
    assert_eq!(*randomness::seed_bytes(&s_a), *randomness::seed_bytes(&s_b));
    // Seed advances exactly one step (counter back to 1 after the internal draw).
    assert_eq!(randomness::seed_counter(&s_a), 1);

    // --- Boundary: range of 1 ([min, min+1)) always returns min ---
    let (one, one_seed) = randomness::next_u64_in_range(&seed, 42, 43);
    assert_eq!(one, 42);
    // Even the trivial range still advances the seed.
    assert_eq!(randomness::seed_counter(&one_seed), 1);

    // Range of 1 at a different min.
    let (one2, _) = randomness::next_u64_in_range(&seed, 0, 1);
    assert_eq!(one2, 0);

    // --- Full u64 range [0, MAX_U64): power-of-2-ish span; must stay in range ---
    let max_u64 = 18446744073709551615u64;
    let (full, _) = randomness::next_u64_in_range(&seed, 0, max_u64);
    assert!(full < max_u64);

    // --- Non-power-of-2 range: threshold != 0, so the rejection branch is
    // reachable. Whatever path is taken (accept first draw or resample), the
    // call must terminate and return an in-range value. Exercise several
    // distinct seeds to cover different raw draws against the threshold. ---
    let r_min = 0u64;
    let r_max = 1000u64; // 1000 is not a power of two -> nonzero rejection threshold
    let mut i = 0u64;
    while (i < 32) {
        let s = randomness::from_bytes(i_to_bytes(i));
        let (rv, _) = randomness::next_u64_in_range(&s, r_min, r_max);
        assert!(rv >= r_min && rv < r_max);
        i = i + 1;
    };

    // --- Chaining through a range many times stays in range and keeps moving ---
    let mut chain_seed = seed;
    let mut k = 0u64;
    while (k < 16) {
        let (cv, ns) = randomness::next_u64_in_range(&chain_seed, 10, 1234);
        assert!(cv >= 10 && cv < 1234);
        // The returned seed's bytes must differ from the input each step, so
        // the chain genuinely advances rather than restating the same state.
        assert!(*randomness::seed_bytes(&ns) != *randomness::seed_bytes(&chain_seed));
        chain_seed = ns;
        k = k + 1;
    };
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::randomness::EInvalidRandomnessRange,
        location = sui_tunnel::randomness,
    ),
] // EInvalidRandomnessRange
fun next_u8_in_range_invalid() {
    let seed = randomness::from_bytes(b"test seed");
    // min >= max should fail
    let (_, _) = randomness::next_u8_in_range(&seed, 10, 5);
}

#[test]
fun select_index() {
    let seed = randomness::from_bytes(b"test seed");

    let (index, _) = randomness::select_index(&seed, 10);
    assert!(index < 10);

    let (index2, _) = randomness::select_index(&seed, 1);
    assert_eq!(index2, 0);
}

#[test]
fun draw_from_vector() {
    let seed = randomness::from_bytes(b"test seed");
    let mut vec = vector[1u8, 2, 3, 4, 5];

    let original_len = vec.length();
    let (_, new_seed) = randomness::draw_from_vector(&seed, &mut vec);

    // Vector should be one element shorter
    assert_eq!(vec.length(), original_len - 1);

    // New seed should be different
    assert!(randomness::seed_counter(&new_seed) > randomness::seed_counter(&seed));
}

/// Insertion-sort a copy of a u8 vector, ascending. Used to compare two
/// vectors as multisets (a sorted-equality check proves a true permutation).
fun sorted_u8(v: &vector<u8>): vector<u8> {
    let mut out = *v;
    let n = out.length();
    let mut i = 1;
    while (i < n) {
        let mut j = i;
        while (j > 0 && *out.borrow(j - 1) > *out.borrow(j)) {
            out.swap(j - 1, j);
            j = j - 1;
        };
        i = i + 1;
    };
    out
}

/// Encode a u64 index into a byte vector, used to derive distinct seeds.
fun i_to_bytes(mut x: u64): vector<u8> {
    let mut out = vector<u8>[];
    let mut k: u64 = 0;
    while (k < 8) {
        out.push_back(((x & 0xff) as u8));
        x = x >> 8;
        k = k + 1;
    };
    out
}

#[test]
fun shuffle() {
    let seed = randomness::from_bytes(b"test seed");
    let mut vec = vector[1u8, 2, 3, 4, 5, 6, 7, 8, 9, 10];

    let original_vec = vec; // Copy
    let _ = randomness::shuffle(&seed, &mut vec);

    // Length should be preserved.
    assert_eq!(vec.length(), original_vec.length());

    // Strengthened: assert MULTISET equality by comparing the sorted vectors.
    // A sum-only check passes for many non-permutations (e.g. [1,1,...] with the
    // right total); sorted-equality proves the shuffle is a true permutation:
    // every original element is present exactly as many times as before.
    assert_eq!(sorted_u8(&vec), sorted_u8(&original_vec));

    // The shuffle must actually reorder for a seed where a real permutation
    // occurs. A single fixed seed could (vanishingly rarely) land on the
    // identity, so we scan a handful of distinct seeds and require that at
    // least one produces a result differing from the input ordering, while
    // every result remains a true permutation (sorted-equal to the original).
    let mut reordered = false;
    let mut s = 0u64;
    while (s < 16) {
        let seed_s = randomness::from_bytes(i_to_bytes(s));
        let mut v = original_vec; // fresh copy each iteration
        let _ = randomness::shuffle(&seed_s, &mut v);
        // Always a true permutation regardless of the seed.
        assert_eq!(sorted_u8(&v), sorted_u8(&original_vec));
        if (v != original_vec) {
            reordered = true;
        };
        s = s + 1;
    };
    assert!(reordered);
}

/// Extra robustness for shuffle: a longer distinct-element vector must remain a
/// true permutation (sorted equality) and be deterministic for a fixed seed.
#[test]
fun shuffle_multiset_and_deterministic() {
    let seed = randomness::from_bytes(b"shuffle seed 2");

    let mut a = vector[10u8, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160];
    let mut b = a; // identical copy
    let original = a;

    let _ = randomness::shuffle(&seed, &mut a);
    let _ = randomness::shuffle(&seed, &mut b);

    // True permutation: sorted equal to the original.
    assert_eq!(sorted_u8(&a), sorted_u8(&original));

    // Deterministic: same seed shuffles identical inputs identically.
    assert_eq!(a, b);

    // Reordering actually happened.
    assert!(a != original);
}

/// shuffle must no-op (return the seed unchanged behavior) for length <= 1.
#[test]
fun shuffle_short_vectors() {
    let seed = randomness::from_bytes(b"short");

    // Empty vector: unchanged, returned seed bytes equal the input seed bytes.
    let mut empty = vector<u8>[];
    let s_empty = randomness::shuffle(&seed, &mut empty);
    assert_eq!(empty.length(), 0);
    assert_eq!(*randomness::seed_bytes(&s_empty), *randomness::seed_bytes(&seed));
    assert_eq!(randomness::seed_counter(&s_empty), randomness::seed_counter(&seed));

    // Single-element vector: unchanged.
    let mut one = vector[99u8];
    let s_one = randomness::shuffle(&seed, &mut one);
    assert_eq!(one, vector[99u8]);
    assert_eq!(*randomness::seed_bytes(&s_one), *randomness::seed_bytes(&seed));
}

#[test]
fun commitment_and_reveal() {
    let value = b"my secret value";
    let salt = b"random_salt_at_least_16_bytes!!";

    let commitment = randomness::create_commitment(&value, &salt, @0x1234, 1000);
    let reveal = randomness::create_reveal(value, salt);

    // Correct reveal should verify
    assert!(randomness::verify_commitment(&commitment, &reveal));

    // Wrong value should not verify
    let wrong_reveal = randomness::create_reveal(b"wrong value", salt);
    assert!(!randomness::verify_commitment(&commitment, &wrong_reveal));

    // Wrong salt should not verify
    let wrong_salt_reveal = randomness::create_reveal(value, b"wrong_salt_wrong_salt_wrong");
    assert!(!randomness::verify_commitment(&commitment, &wrong_salt_reveal));
}

#[test]
fun combine_reveals() {
    let reveal_a = randomness::create_reveal(b"value_a", b"salt_a_at_least_16chars");
    let reveal_b = randomness::create_reveal(b"value_b", b"salt_b_at_least_16chars");

    let seed = randomness::combine_reveals(&reveal_a, &reveal_b);

    // Should produce valid seed
    assert_eq!(randomness::seed_bytes(&seed).length(), 32);
    assert_eq!(randomness::seed_counter(&seed), 0);

    // Same reveals should produce same seed
    let seed2 = randomness::combine_reveals(&reveal_a, &reveal_b);
    assert_eq!(*randomness::seed_bytes(&seed), *randomness::seed_bytes(&seed2));

    // Different order should produce different seed
    let seed3 = randomness::combine_reveals(&reveal_b, &reveal_a);
    assert!(*randomness::seed_bytes(&seed) != *randomness::seed_bytes(&seed3));
}

#[test]
fun combined_randomness_flow() {
    let value_a = b"alice_secret";
    let salt_a = b"alice_salt_32bytes_minimum!!";
    let value_b = b"bob_secret";
    let salt_b = b"bob_salt_32bytes_minimum!!!";

    // Phase 1: Create commitments
    let commitment_a = randomness::create_commitment(&value_a, &salt_a, @0xA, 1000);
    let commitment_b = randomness::create_commitment(&value_b, &salt_b, @0xB, 1001);

    // Create combined randomness
    let mut combined = randomness::create_combined_randomness(commitment_a, commitment_b);
    assert!(!randomness::is_finalized(&combined));

    // Phase 2: Reveal
    let reveal_a = randomness::create_reveal(value_a, salt_a);
    let reveal_b = randomness::create_reveal(value_b, salt_b);

    randomness::finalize_combined_randomness(&mut combined, &reveal_a, &reveal_b);
    assert!(randomness::is_finalized(&combined));

    // Can now use the seed
    let seed = randomness::combined_seed(&combined);
    assert_eq!(randomness::seed_bytes(seed).length(), 32);
}

#[test]
fun bytes_to_u64() {
    let bytes = vector[
        0u8,
        0,
        0,
        0,
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
    ];
    let value = randomness::bytes_to_u64(&bytes);
    assert_eq!(value, 1);

    let bytes2 = vector[
        0u8,
        0,
        0,
        0,
        0,
        0,
        1,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
    ];
    let value2 = randomness::bytes_to_u64(&bytes2);
    assert_eq!(value2, 256);
}

#[test]
fun seed_accessors() {
    let seed = randomness::from_bytes(b"test");

    assert_eq!(randomness::seed_bytes(&seed).length(), 32);
    assert_eq!(randomness::seed_counter(&seed), 0);

    let (_, new_seed) = randomness::next_u64(&seed);
    assert_eq!(randomness::seed_counter(&new_seed), 1);
}

#[test]
fun commitment_accessors() {
    let commitment = randomness::create_commitment(
        &b"value",
        &b"salt_at_least_16_chars",
        @0x1234,
        5000,
    );

    assert_eq!(randomness::commitment_hash(&commitment).length(), 32);
    assert_eq!(randomness::commitment_committer(&commitment), @0x1234);
    assert_eq!(randomness::commitment_timestamp(&commitment), 5000);
}

#[test]
fun reveal_accessors() {
    let reveal = randomness::create_reveal(b"my value", b"my salt");

    assert_eq!(*randomness::reveal_value(&reveal), b"my value");
    assert_eq!(*randomness::reveal_salt(&reveal), b"my salt");
}

#[test]
fun chained_randomness() {
    // Simulate drawing multiple cards
    let initial_seed = randomness::from_bytes(b"game_seed");

    let (card1, seed1) = randomness::next_u8_in_range(&initial_seed, 0, 52);
    let (card2, seed2) = randomness::next_u8_in_range(&seed1, 0, 52);
    let (card3, _seed3) = randomness::next_u8_in_range(&seed2, 0, 52);

    // All cards should be in valid range
    assert!(card1 < 52);
    assert!(card2 < 52);
    assert!(card3 < 52);

    // Verify determinism - same sequence from same seed
    let (card1_again, seed1_again) = randomness::next_u8_in_range(&initial_seed, 0, 52);
    let (card2_again, _) = randomness::next_u8_in_range(&seed1_again, 0, 52);

    assert_eq!(card1, card1_again);
    assert_eq!(card2, card2_again);
}

// ============================================
// EDGE CASES / ROBUSTNESS
// ============================================

/// select_index over an empty vector (length 0) must abort with empty_input().
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::randomness::EEmptyInput,
        location = sui_tunnel::randomness,
    ),
]
fun select_index_empty() {
    let seed = randomness::from_bytes(b"test seed");
    let (_, _) = randomness::select_index(&seed, 0);
}

/// draw_from_vector on an empty vector must abort with empty_input().
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::randomness::EEmptyInput,
        location = sui_tunnel::randomness,
    ),
]
fun draw_from_empty_vector() {
    let seed = randomness::from_bytes(b"test seed");
    let mut empty = vector<u8>[];
    let (_, _) = randomness::draw_from_vector(&seed, &mut empty);
}

/// create_commitment with a salt shorter than 16 bytes must abort with
/// invalid_parameter(). Salts of exactly 16 bytes are accepted (boundary).
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::randomness::EInvalidParameter,
        location = sui_tunnel::randomness,
    ),
]
fun create_commitment_short_salt() {
    // 15-byte salt: one below the minimum length guard.
    let _ = randomness::create_commitment(&b"value", &b"short_salt_15ch", @0x1, 0);
}

/// Boundary: a salt of exactly 16 bytes is accepted by create_commitment.
#[test]
fun create_commitment_min_salt_ok() {
    // Exactly 16 bytes.
    let salt = b"0123456789abcdef";
    assert_eq!(salt.length(), 16);
    let c = randomness::create_commitment(&b"value", &salt, @0x1, 0);
    assert_eq!(randomness::commitment_hash(&c).length(), 32);
}

/// Different commitment inputs must yield different commitment hashes; identical
/// inputs must yield identical hashes (binding/determinism of the commitment).
#[test]
fun commitment_distinct_and_deterministic() {
    let salt_a = b"salt_at_least_16_bytes_aaaa";
    let salt_b = b"salt_at_least_16_bytes_bbbb";

    let c1 = randomness::create_commitment(&b"value1", &salt_a, @0x1, 0);
    let c1_again = randomness::create_commitment(&b"value1", &salt_a, @0x1, 0);
    let c_diff_value = randomness::create_commitment(&b"value2", &salt_a, @0x1, 0);
    let c_diff_salt = randomness::create_commitment(&b"value1", &salt_b, @0x1, 0);

    // Determinism: identical (value, salt) -> identical hash.
    assert_eq!(*randomness::commitment_hash(&c1), *randomness::commitment_hash(&c1_again));

    // Different value -> different hash.
    assert!(*randomness::commitment_hash(&c1) != *randomness::commitment_hash(&c_diff_value));

    // Different salt -> different hash.
    assert!(*randomness::commitment_hash(&c1) != *randomness::commitment_hash(&c_diff_salt));
}

/// combine_reveals is deterministic for identical inputs and order-sensitive,
/// and different reveal contents produce different seeds.
#[test]
fun combine_reveals_distinct_and_deterministic() {
    let a = randomness::create_reveal(b"value_a", b"salt_a_at_least_16chars");
    let b = randomness::create_reveal(b"value_b", b"salt_b_at_least_16chars");
    let c = randomness::create_reveal(b"value_c", b"salt_c_at_least_16chars");

    let s_ab = randomness::combine_reveals(&a, &b);
    let s_ab2 = randomness::combine_reveals(&a, &b);
    let s_ac = randomness::combine_reveals(&a, &c);

    // Determinism.
    assert_eq!(*randomness::seed_bytes(&s_ab), *randomness::seed_bytes(&s_ab2));
    // Different second reveal -> different combined seed.
    assert!(*randomness::seed_bytes(&s_ab) != *randomness::seed_bytes(&s_ac));
}

/// from_bls_signature does NOT verify on-chain, so we can test its determinism
/// (same message + signature bytes -> same seed; different bytes -> different
/// seed) without a valid BLS signature/precomputed vector.
#[test]
fun from_bls_signature_deterministic() {
    let msg = b"randomness message";
    let sig = b"these_are_not_a_valid_bls_signature_just_bytes!!";

    let s1 = randomness::from_bls_signature(&msg, &sig);
    let s2 = randomness::from_bls_signature(&msg, &sig);

    // Determinism: identical inputs -> identical seed bytes, counter at 0.
    assert_eq!(*randomness::seed_bytes(&s1), *randomness::seed_bytes(&s2));
    assert_eq!(randomness::seed_bytes(&s1).length(), 32);
    assert_eq!(randomness::seed_counter(&s1), 0);

    // Different message -> different seed.
    let s_msg = randomness::from_bls_signature(&b"different message", &sig);
    assert!(*randomness::seed_bytes(&s1) != *randomness::seed_bytes(&s_msg));

    // Different signature bytes -> different seed.
    let s_sig = randomness::from_bls_signature(&msg, &b"another_distinct_signature_byte_string!!");
    assert!(*randomness::seed_bytes(&s1) != *randomness::seed_bytes(&s_sig));
}

/// bytes_to_u64 reads exactly the first 8 bytes (big-endian) and ignores the
/// rest: trailing bytes beyond index 7 must not affect the result.
#[test]
fun bytes_to_u64_ignores_trailing() {
    // First 8 bytes encode 1 big-endian; trailing bytes differ between inputs.
    let a = vector[0u8, 0, 0, 0, 0, 0, 0, 1, 9, 9, 9];
    let b = vector[0u8, 0, 0, 0, 0, 0, 0, 1, 0];
    assert_eq!(randomness::bytes_to_u64(&a), 1);
    assert_eq!(randomness::bytes_to_u64(&b), 1);
    assert_eq!(randomness::bytes_to_u64(&a), randomness::bytes_to_u64(&b));

    // All 0xff in the top 8 bytes -> MAX_U64.
    let max = vector[0xffu8, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
    assert_eq!(randomness::bytes_to_u64(&max), 18446744073709551615u64);
}

/// bytes_to_u64 indexes the first 8 bytes directly; a vector shorter than 8
/// bytes is out of the public guard's surface and aborts on a native vector
/// bounds check. This documents that short input is rejected (by abort), even
/// though the abort is a native runtime check, not a framework #[error].
#[test, expected_failure]
fun bytes_to_u64_short_input_aborts() {
    let short = vector[0u8, 1, 2]; // only 3 bytes; bytes_to_u64 needs 8
    let _ = randomness::bytes_to_u64(&short);
}
