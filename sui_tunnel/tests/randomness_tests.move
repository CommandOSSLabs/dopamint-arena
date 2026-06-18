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
    assert_eq!(*seed1.seed_bytes(), *seed2.seed_bytes());

    // Different input should produce different seed
    assert!(*seed1.seed_bytes() != *seed3.seed_bytes());

    // Seed should be 32 bytes
    assert_eq!(seed1.seed_bytes().length(), 32);

    // Counter should start at 0
    assert_eq!(seed1.seed_counter(), 0);
}

#[test]
fun next_seed_deterministic() {
    let seed = randomness::from_bytes(b"initial seed");

    let next1 = seed.next_seed();
    let next2 = seed.next_seed();

    // Same seed should produce same next seed
    assert_eq!(*next1.seed_bytes(), *next2.seed_bytes());
}

#[test]
fun next_u64() {
    let seed = randomness::from_bytes(b"test seed");

    let (value1, seed1) = seed.next_u64();
    let (value2, seed2) = seed.next_u64();

    // Same seed should produce same value
    assert_eq!(value1, value2);

    // But the returned seeds should be same too (deterministic)
    assert_eq!(*seed1.seed_bytes(), *seed2.seed_bytes());
}

#[test]
fun next_u128_deterministic_and_distinct() {
    let seed = randomness::from_bytes(b"u128 seed");

    // Determinism: same seed -> same value and same returned-seed bytes.
    let (value1, seed1) = seed.next_u128();
    let (value2, seed2) = seed.next_u128();
    assert_eq!(value1, value2);
    assert_eq!(*seed1.seed_bytes(), *seed2.seed_bytes());
    // The draw advances the seed exactly one step.
    assert_eq!(seed1.seed_counter(), 1);

    // Distinct seeds -> distinct values.
    let other = randomness::from_bytes(b"u128 seed other");
    let (value_other, _) = other.next_u128();
    assert!(value1 != value_other);
}

#[test]
fun next_u256_deterministic_and_distinct() {
    let seed = randomness::from_bytes(b"u256 seed");

    // Determinism: same seed -> same value and same returned-seed bytes.
    let (value1, seed1) = seed.next_u256();
    let (value2, seed2) = seed.next_u256();
    assert_eq!(value1, value2);
    assert_eq!(*seed1.seed_bytes(), *seed2.seed_bytes());
    // The draw advances the seed exactly one step.
    assert_eq!(seed1.seed_counter(), 1);

    // Distinct seeds -> distinct values.
    let other = randomness::from_bytes(b"u256 seed other");
    let (value_other, _) = other.next_u256();
    assert!(value1 != value_other);
}

/// Strengthened: prove the seed actually ADVANCES across consecutive draws.
/// A no-op next_seed would pass the determinism check above but fail here.
#[test]
fun next_u64_advances() {
    let seed = randomness::from_bytes(b"advance seed");

    // The input seed starts at counter 0.
    assert_eq!(seed.seed_counter(), 0);

    // Each draw derives a fresh chained seed via `next_seed` (which rehashes
    // and resets the counter), so the returned seed always carries counter == 1.
    let (value1, seed1) = seed.next_u64();
    assert_eq!(seed1.seed_counter(), 1);

    // Second CONSECUTIVE draw (feeding the returned seed back in).
    let (value2, seed2) = seed1.next_u64();
    assert_eq!(seed2.seed_counter(), 1);

    // The genuine advancement is in the seed BYTES: each draw rehashes the
    // prior seed, so the bytes move forward and never repeat the previous state.
    assert!(*seed1.seed_bytes() != *seed.seed_bytes());
    assert!(*seed2.seed_bytes() != *seed1.seed_bytes());

    // Consequently a second consecutive draw yields a DIFFERENT value than the
    // first; otherwise the seed would not really be advancing between draws.
    assert!(value1 != value2);
}

#[test]
fun next_u8_in_range() {
    let seed = randomness::from_bytes(b"test seed");

    // Test range [0, 52) for card game
    let (value, _) = seed.next_u8_in_range(0, 52);
    assert!(value < 52);

    // Test range [1, 7) for dice
    let (value2, _) = seed.next_u8_in_range(1, 7);
    assert!(value2 >= 1 && value2 < 7);
}

#[test]
fun next_u64_in_range() {
    let seed = randomness::from_bytes(b"test seed");

    let (value, _) = seed.next_u64_in_range(100, 200);
    assert!(value >= 100 && value < 200);

    let (value2, _) = seed.next_u64_in_range(0, 1);
    assert_eq!(value2, 0);
}

/// Strengthened rejection-sampling coverage for next_u64_in_range:
/// always-in-range, determinism, boundary ranges, full range, and a
/// non-power-of-2 range that makes the rejection branch reachable.
#[test]
fun next_u64_in_range_properties() {
    let seed = randomness::from_bytes(b"range props");

    // --- Always within [min, max) ---
    let (v, _) = seed.next_u64_in_range(100, 200);
    assert!(v >= 100 && v < 200);

    // --- Determinism: same seed + same range -> same value AND same seed bytes ---
    let (v_a, s_a) = seed.next_u64_in_range(100, 200);
    let (v_b, s_b) = seed.next_u64_in_range(100, 200);
    assert_eq!(v_a, v_b);
    assert_eq!(*s_a.seed_bytes(), *s_b.seed_bytes());
    // Seed advances exactly one step (counter back to 1 after the internal draw).
    assert_eq!(s_a.seed_counter(), 1);

    // --- Boundary: range of 1 ([min, min+1)) always returns min ---
    let (one, one_seed) = seed.next_u64_in_range(42, 43);
    assert_eq!(one, 42);
    // Even the trivial range still advances the seed.
    assert_eq!(one_seed.seed_counter(), 1);

    // Range of 1 at a different min.
    let (one2, _) = seed.next_u64_in_range(0, 1);
    assert_eq!(one2, 0);

    // --- Full u64 range [0, MAX_U64): power-of-2-ish span; must stay in range ---
    let max_u64 = 18446744073709551615u64;
    let (full, _) = seed.next_u64_in_range(0, max_u64);
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
        let (rv, _) = s.next_u64_in_range(r_min, r_max);
        assert!(rv >= r_min && rv < r_max);
        i = i + 1;
    };

    // --- Chaining through a range many times stays in range and keeps moving ---
    let mut chain_seed = seed;
    let mut k = 0u64;
    while (k < 16) {
        let (cv, ns) = chain_seed.next_u64_in_range(10, 1234);
        assert!(cv >= 10 && cv < 1234);
        // The returned seed's bytes must differ from the input each step, so
        // the chain genuinely advances rather than restating the same state.
        assert!(*ns.seed_bytes() != *chain_seed.seed_bytes());
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
    let (_, _) = seed.next_u8_in_range(10, 5);
}

#[test]
fun select_index() {
    let seed = randomness::from_bytes(b"test seed");

    let (index, _) = seed.select_index(10);
    assert!(index < 10);

    let (index2, _) = seed.select_index(1);
    assert_eq!(index2, 0);
}

#[test]
fun draw_from_vector() {
    let seed = randomness::from_bytes(b"test seed");
    let mut vec = vector[1u8, 2, 3, 4, 5];

    let original_len = vec.length();
    let (_, new_seed) = seed.draw_from_vector(&mut vec);

    // Vector should be one element shorter
    assert_eq!(vec.length(), original_len - 1);

    // New seed should be different
    assert!(new_seed.seed_counter() > seed.seed_counter());
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
    let _ = seed.shuffle(&mut vec);

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
        let _ = seed_s.shuffle(&mut v);
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

    let _ = seed.shuffle(&mut a);
    let _ = seed.shuffle(&mut b);

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
    let s_empty = seed.shuffle(&mut empty);
    assert_eq!(empty.length(), 0);
    assert_eq!(*s_empty.seed_bytes(), *seed.seed_bytes());
    assert_eq!(s_empty.seed_counter(), seed.seed_counter());

    // Single-element vector: unchanged.
    let mut one = vector[99u8];
    let s_one = seed.shuffle(&mut one);
    assert_eq!(one, vector[99u8]);
    assert_eq!(*s_one.seed_bytes(), *seed.seed_bytes());
}

#[test]
fun commitment_and_reveal() {
    let value = b"my secret value";
    let salt = b"random_salt_at_least_16_bytes!!";

    let commitment = randomness::create_commitment(&value, &salt, @0x1234, 1000);
    let reveal = randomness::create_reveal(value, salt);

    // Correct reveal should verify
    assert!(commitment.verify_commitment(&reveal));

    // Wrong value should not verify
    let wrong_reveal = randomness::create_reveal(b"wrong value", salt);
    assert!(!commitment.verify_commitment(&wrong_reveal));

    // Wrong salt should not verify
    let wrong_salt_reveal = randomness::create_reveal(value, b"wrong_salt_wrong_salt_wrong");
    assert!(!commitment.verify_commitment(&wrong_salt_reveal));
}

#[test]
fun combine_reveals() {
    let reveal_a = randomness::create_reveal(b"value_a", b"salt_a_at_least_16chars");
    let reveal_b = randomness::create_reveal(b"value_b", b"salt_b_at_least_16chars");

    let seed = reveal_a.combine_reveals(&reveal_b);

    // Should produce valid seed
    assert_eq!(seed.seed_bytes().length(), 32);
    assert_eq!(seed.seed_counter(), 0);

    // Same reveals should produce same seed
    let seed2 = reveal_a.combine_reveals(&reveal_b);
    assert_eq!(*seed.seed_bytes(), *seed2.seed_bytes());

    // Different order should produce different seed
    let seed3 = reveal_b.combine_reveals(&reveal_a);
    assert!(*seed.seed_bytes() != *seed3.seed_bytes());
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
    assert!(!combined.is_finalized());

    // Phase 2: Reveal
    let reveal_a = randomness::create_reveal(value_a, salt_a);
    let reveal_b = randomness::create_reveal(value_b, salt_b);

    combined.finalize_combined_randomness(&reveal_a, &reveal_b);
    assert!(combined.is_finalized());

    // Can now use the seed
    let seed = combined.combined_seed();
    assert_eq!(seed.seed_bytes().length(), 32);
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

    assert_eq!(seed.seed_bytes().length(), 32);
    assert_eq!(seed.seed_counter(), 0);

    let (_, new_seed) = seed.next_u64();
    assert_eq!(new_seed.seed_counter(), 1);
}

#[test]
fun commitment_accessors() {
    let commitment = randomness::create_commitment(
        &b"value",
        &b"salt_at_least_16_chars",
        @0x1234,
        5000,
    );

    assert_eq!(commitment.commitment_hash().length(), 32);
    assert_eq!(commitment.commitment_committer(), @0x1234);
    assert_eq!(commitment.commitment_timestamp(), 5000);
}

#[test]
fun reveal_accessors() {
    let reveal = randomness::create_reveal(b"my value", b"my salt");

    assert_eq!(*reveal.reveal_value(), b"my value");
    assert_eq!(*reveal.reveal_salt(), b"my salt");
}

#[test]
fun chained_randomness() {
    // Simulate drawing multiple cards
    let initial_seed = randomness::from_bytes(b"game_seed");

    let (card1, seed1) = initial_seed.next_u8_in_range(0, 52);
    let (card2, seed2) = seed1.next_u8_in_range(0, 52);
    let (card3, _seed3) = seed2.next_u8_in_range(0, 52);

    // All cards should be in valid range
    assert!(card1 < 52);
    assert!(card2 < 52);
    assert!(card3 < 52);

    // Verify determinism - same sequence from same seed
    let (card1_again, seed1_again) = initial_seed.next_u8_in_range(0, 52);
    let (card2_again, _) = seed1_again.next_u8_in_range(0, 52);

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
    let (_, _) = seed.select_index(0);
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
    let (_, _) = seed.draw_from_vector(&mut empty);
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
    assert_eq!(c.commitment_hash().length(), 32);
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
    assert_eq!(*c1.commitment_hash(), *c1_again.commitment_hash());

    // Different value -> different hash.
    assert!(*c1.commitment_hash() != *c_diff_value.commitment_hash());

    // Different salt -> different hash.
    assert!(*c1.commitment_hash() != *c_diff_salt.commitment_hash());
}

/// combine_reveals is deterministic for identical inputs and order-sensitive,
/// and different reveal contents produce different seeds.
#[test]
fun combine_reveals_distinct_and_deterministic() {
    let a = randomness::create_reveal(b"value_a", b"salt_a_at_least_16chars");
    let b = randomness::create_reveal(b"value_b", b"salt_b_at_least_16chars");
    let c = randomness::create_reveal(b"value_c", b"salt_c_at_least_16chars");

    let s_ab = a.combine_reveals(&b);
    let s_ab2 = a.combine_reveals(&b);
    let s_ac = a.combine_reveals(&c);

    // Determinism.
    assert_eq!(*s_ab.seed_bytes(), *s_ab2.seed_bytes());
    // Different second reveal -> different combined seed.
    assert!(*s_ab.seed_bytes() != *s_ac.seed_bytes());
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
    assert_eq!(*s1.seed_bytes(), *s2.seed_bytes());
    assert_eq!(s1.seed_bytes().length(), 32);
    assert_eq!(s1.seed_counter(), 0);

    // Different message -> different seed.
    let s_msg = randomness::from_bls_signature(&b"different message", &sig);
    assert!(*s1.seed_bytes() != *s_msg.seed_bytes());

    // Different signature bytes -> different seed.
    let s_sig = randomness::from_bls_signature(&msg, &b"another_distinct_signature_byte_string!!");
    assert!(*s1.seed_bytes() != *s_sig.seed_bytes());
}

/// H5 security property: from_bls_signature length-prefixes the message and the
/// signature before hashing, so two (message, signature) pairs whose naive
/// concatenations are identical no longer collide. Under the OLD layout
/// (DOMAIN || message || signature) the two pairs below both hash
/// DOMAIN || [0x01, 0x02, 0x03] and would produce the SAME seed; the new
/// length-prefixed layout (DOMAIN || be(len(msg)) || msg || be(len(sig)) || sig)
/// disambiguates the split, so the seeds must now DIFFER.
#[test]
fun from_bls_signature_no_concat_collision() {
    // Pair 1: 1-byte message, 2-byte signature.
    let msg1 = vector[0x01u8];
    let sig1 = vector[0x02u8, 0x03u8];

    // Pair 2: 2-byte message, 1-byte signature. Same concatenation as pair 1.
    let msg2 = vector[0x01u8, 0x02u8];
    let sig2 = vector[0x03u8];

    let s1 = randomness::from_bls_signature(&msg1, &sig1);
    let s2 = randomness::from_bls_signature(&msg2, &sig2);

    // Sanity: the two naive concatenations are indeed equal, which is exactly
    // the boundary the old layout could not distinguish.
    let mut cat1 = msg1;
    cat1.append(sig1);
    let mut cat2 = msg2;
    cat2.append(sig2);
    assert_eq!(cat1, cat2);

    // The length-prefixed layout must produce distinct seeds for these inputs.
    assert!(*s1.seed_bytes() != *s2.seed_bytes());
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

/// bytes_to_u64 requires at least 8 bytes; a shorter vector is rejected with the
/// attributable EInvalidParameter code rather than a native vector bounds abort.
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::randomness::EInvalidParameter,
        location = sui_tunnel::randomness,
    ),
]
fun bytes_to_u64_short_input_aborts() {
    let short = vector[0u8, 1, 2]; // only 3 bytes; bytes_to_u64 needs 8
    let _ = randomness::bytes_to_u64(&short);
}
