/// Module: randomness
///
/// BLS-based verifiable randomness for the Sui Tunnel Framework.
/// Provides cryptographically secure, verifiable random values for tunnel applications.
///
/// ## Randomness Sources
///
/// 1. **BLS Signature-based**: R = H(message || BLS_signature)
///    - Dealer signs a message, randomness derived from signature
///    - Verifiable: anyone can verify the signature and derive the same randomness
///    - Non-manipulable: dealer cannot predict randomness before signing
///
/// 2. **Commit-Reveal**: Two-phase randomness generation
///    - Phase 1: Both parties commit to random values (hash)
///    - Phase 2: Both parties reveal values
///    - Final randomness = H(reveal_a || reveal_b)
///
/// 3. **Chained Randomness**: Each random value derives the next seed
///    - Useful for games needing multiple random values
///    - Deterministic sequence from initial seed
///
/// ## Usage Example
///
/// ```move
/// use sui_tunnel::randomness;
///
/// // Create seed from BLS signature
/// let seed = randomness::from_bls_signature(&message, &signature);
///
/// // Derive random values
/// let (value, new_seed) = randomness::next_u64(&seed);
/// let (card, new_seed) = randomness::next_in_range(&new_seed, 0, 52);
/// ```
///
/// ## Security Notes
///
/// - BLS signatures must be verified before using for randomness
/// - Commit-reveal requires both parties to participate honestly
/// - Seeds should never be reused across different contexts
module sui_tunnel::randomness;

use sui::bls12381;
use sui::hash;
use sui_tunnel::signature;

// === Error definitions (see sui_tunnel::errors for the canonical registry) ===

#[error]
const EInvalidParameter: vector<u8> = b"A required parameter is missing or invalid.";

#[error]
const EEmptyInput: vector<u8> = b"Input is empty where a non-empty value was required.";

#[error]
const EInvalidBlsSignature: vector<u8> = b"BLS signature verification failed.";

#[error]
const ERandomnessAlreadyRevealed: vector<u8> = b"The randomness has already been revealed.";

#[error]
const ERandomnessCommitmentMismatch: vector<u8> = b"The revealed randomness does not match its commitment.";

#[error]
const ERandomnessNotAvailable: vector<u8> = b"The randomness is not available yet.";

#[error]
const EInvalidRandomnessRange: vector<u8> = b"The requested randomness range is invalid; min must be less than max.";

// ============================================
// CONSTANTS
// ============================================

/// Domain separator for BLS-based randomness
const DOMAIN_BLS_RANDOMNESS: vector<u8> = b"sui_tunnel::randomness::bls";

/// Domain separator for commit-reveal randomness
const DOMAIN_COMMIT_REVEAL: vector<u8> = b"sui_tunnel::randomness::commit_reveal";

/// Domain separator for chained randomness
const DOMAIN_CHAIN: vector<u8> = b"sui_tunnel::randomness::chain";

/// Domain separator for tunnel-context seeds
const DOMAIN_TUNNEL_CONTEXT: vector<u8> = b"sui_tunnel::randomness::tunnel_context";

// ============================================
// STRUCTS
// ============================================

/// A randomness seed that can be used to derive random values
public struct Seed has copy, drop, store {
    /// The seed bytes (32 bytes from Blake2b-256)
    bytes: vector<u8>,
    /// Counter for how many values have been derived from this seed
    counter: u64,
}

/// A commitment to a random value (for commit-reveal scheme)
public struct Commitment has copy, drop, store {
    /// Hash of the committed value: H(value || salt)
    hash: vector<u8>,
    /// Who made this commitment
    committer: address,
    /// When the commitment was made (for timeout purposes)
    timestamp: u64,
}

/// Revealed value in commit-reveal scheme
public struct Reveal has copy, drop, store {
    /// The revealed value
    value: vector<u8>,
    /// The salt used in commitment
    salt: vector<u8>,
}

/// Combined randomness from two-party commit-reveal
public struct CombinedRandomness has copy, drop, store {
    /// The combined seed
    seed: Seed,
    /// Commitment from party A
    commitment_a: Commitment,
    /// Commitment from party B
    commitment_b: Commitment,
    /// Whether randomness has been revealed and finalized
    finalized: bool,
}

// ============================================
// SEED CREATION FUNCTIONS
// ============================================

/// Creates a new seed from raw bytes.
/// The bytes are hashed to ensure uniform distribution.
public(package) fun from_bytes(bytes: vector<u8>): Seed {
    let hash_input = create_domain_message(DOMAIN_CHAIN, bytes);
    Seed {
        bytes: hash::blake2b256(&hash_input),
        counter: 0,
    }
}

/// Creates a seed from a BLS signature.
/// This provides verifiable randomness - anyone can verify the signature
/// and derive the same random seed.
///
/// ## Parameters
/// - `message`: The message that was signed
/// - `signature`: The BLS signature (48 bytes for min_sig, 96 bytes for min_pk)
///
/// ## Security
/// The signature MUST be verified before calling this function.
/// Use `signature::verify_bls12381_min_sig()` or `signature::verify_bls12381_min_pk()` first.
/// BLS signatures are unique per (key, message), so the result is non-grindable only when
/// the signed message is fixed in advance (e.g. bound to a tunnel id and nonce); otherwise
/// the signer could grind the message to bias the outcome.
public(package) fun from_bls_signature(message: &vector<u8>, bls_signature: &vector<u8>): Seed {
    let mut hash_input = DOMAIN_BLS_RANDOMNESS;
    hash_input.append(*message);
    hash_input.append(*bls_signature);

    Seed {
        bytes: hash::blake2b256(&hash_input),
        counter: 0,
    }
}

/// Creates a seed from a verified BLS signature.
/// Combines verification and seed creation in one step.
///
/// ## Parameters
/// - `public_key`: The BLS public key (96 bytes for min_sig scheme)
/// - `message`: The message that was signed
/// - `signature`: The BLS signature (48 bytes for min_sig scheme)
///
/// ## Aborts
/// If the signature verification fails
public fun from_verified_bls_min_sig(
    public_key: &vector<u8>,
    message: &vector<u8>,
    bls_signature: &vector<u8>,
): Seed {
    // Verify the signature first
    assert!(
        bls12381::bls12381_min_sig_verify(bls_signature, public_key, message),
        EInvalidBlsSignature,
    );

    from_bls_signature(message, bls_signature)
}

/// Creates a seed from a verified BLS signature (min_pk variant).
///
/// ## Parameters
/// - `public_key`: The BLS public key (48 bytes for min_pk scheme)
/// - `message`: The message that was signed
/// - `signature`: The BLS signature (96 bytes for min_pk scheme)
public fun from_verified_bls_min_pk(
    public_key: &vector<u8>,
    message: &vector<u8>,
    bls_signature: &vector<u8>,
): Seed {
    // Verify the signature first
    assert!(
        bls12381::bls12381_min_pk_verify(bls_signature, public_key, message),
        EInvalidBlsSignature,
    );

    from_bls_signature(message, bls_signature)
}

/// Creates a seed by combining multiple inputs.
/// Useful for deriving tunnel-specific randomness.
///
/// The variable-length fields are length-prefixed under a dedicated domain so
/// distinct inputs cannot collide or coincide with `from_bytes`/`next_seed` seeds.
///
/// ## Parameters
/// - `tunnel_id`: The tunnel's object ID bytes
/// - `nonce`: A unique nonce
/// - `extra_entropy`: Additional entropy (e.g., signatures)
public fun from_tunnel_context(tunnel_id: vector<u8>, nonce: u64, extra_entropy: vector<u8>): Seed {
    let mut hash_input = DOMAIN_TUNNEL_CONTEXT;
    hash_input.append(signature::u64_to_be_bytes(tunnel_id.length()));
    hash_input.append(tunnel_id);
    hash_input.append(signature::u64_to_be_bytes(nonce));
    hash_input.append(signature::u64_to_be_bytes(extra_entropy.length()));
    hash_input.append(extra_entropy);

    Seed {
        bytes: hash::blake2b256(&hash_input),
        counter: 0,
    }
}

// ============================================
// RANDOM VALUE DERIVATION FUNCTIONS
// ============================================

/// Derives the next random seed (for chaining).
/// Returns a new seed that can be used for further derivations.
public fun next_seed(seed: &Seed): Seed {
    let mut hash_input = DOMAIN_CHAIN;
    hash_input.append(seed.bytes);
    hash_input.append(signature::u64_to_be_bytes(seed.counter));

    Seed {
        bytes: hash::blake2b256(&hash_input),
        counter: 0,
    }
}

/// Derives a random u64 value and returns the new seed.
public fun next_u64(seed: &Seed): (u64, Seed) {
    let new_seed = next_seed(seed);

    // Take first 8 bytes as u64
    let value = bytes_to_u64(&new_seed.bytes);

    (value, Seed { bytes: new_seed.bytes, counter: new_seed.counter + 1 })
}

/// Derives a random u128 value and returns the new seed.
public fun next_u128(seed: &Seed): (u128, Seed) {
    let new_seed = next_seed(seed);

    // Take first 16 bytes as u128
    let value = bytes_to_u128(&new_seed.bytes);

    (value, Seed { bytes: new_seed.bytes, counter: new_seed.counter + 1 })
}

/// Derives a random u256 value and returns the new seed.
public fun next_u256(seed: &Seed): (u256, Seed) {
    let new_seed = next_seed(seed);

    // Use all 32 bytes as u256
    let value = bytes_to_u256(&new_seed.bytes);

    (value, Seed { bytes: new_seed.bytes, counter: new_seed.counter + 1 })
}

/// Derives a random u8 value in a range [min, max).
/// Returns the value and the new seed.
/// Delegates to next_u64_in_range and casts the result.
///
/// ## Parameters
/// - `seed`: The current seed
/// - `min`: Minimum value (inclusive)
/// - `max`: Maximum value (exclusive)
///
/// ## Aborts
/// If min >= max
public fun next_u8_in_range(seed: &Seed, min: u8, max: u8): (u8, Seed) {
    assert!(min < max, EInvalidRandomnessRange);

    let (value, new_seed) = next_u64_in_range(seed, (min as u64), (max as u64));
    ((value as u8), new_seed)
}

/// Derives a random u64 value in a range [min, max).
/// Uses rejection sampling to eliminate modulo bias.
public fun next_u64_in_range(seed: &Seed, min: u64, max: u64): (u64, Seed) {
    assert!(min < max, EInvalidRandomnessRange);

    let range = max - min;

    // If range is 1, the result is always min
    if (range == 1) {
        let new_seed = next_seed(seed);
        return (min, Seed { bytes: new_seed.bytes, counter: new_seed.counter + 1 })
    };

    // Rejection sampling: reject values >= threshold to eliminate modulo bias.
    // threshold = MAX_U64 - (MAX_U64 % range) wraps correctly for all range values.
    // For range that is a power of 2, threshold == 0 (no rejection needed since MAX_U64+1 is divisible).
    let max_u64 = 18446744073709551615u64;
    let remainder = ((max_u64 % range) + 1) % range;
    let threshold = if (remainder == 0) { 0 } else { max_u64 - remainder + 1 };

    let mut current_seed = *seed;
    loop {
        let new_seed = next_seed(&current_seed);
        let raw = bytes_to_u64(&new_seed.bytes);

        if (threshold == 0 || raw < threshold) {
            let value = (raw % range) + min;
            return (value, Seed { bytes: new_seed.bytes, counter: new_seed.counter + 1 })
        };

        // Rejected — advance seed and retry
        current_seed = new_seed;
    }
}

/// Selects a random element from a vector and returns the index.
public fun select_index(seed: &Seed, length: u64): (u64, Seed) {
    assert!(length > 0, EEmptyInput);
    next_u64_in_range(seed, 0, length)
}

/// Draws a random element from a mutable vector, removing it.
/// Useful for card games where cards are drawn from a deck.
///
/// ## Returns
/// - The drawn element
/// - The new seed
public fun draw_from_vector<T: drop>(seed: &Seed, vec: &mut vector<T>): (T, Seed) {
    let length = vec.length();
    assert!(length > 0, EEmptyInput);

    let (index, new_seed) = select_index(seed, length);
    let element = vec.swap_remove(index);

    (element, new_seed)
}

/// Shuffles a vector in place using Fisher-Yates algorithm.
/// Returns the final seed after shuffling.
public fun shuffle<T>(seed: &Seed, vec: &mut vector<T>): Seed {
    let length = vec.length();
    if (length <= 1) {
        return *seed
    };

    let mut current_seed = *seed;
    let mut i = length - 1;

    while (i > 0) {
        let (j, new_seed) = next_u64_in_range(&current_seed, 0, i + 1);
        current_seed = new_seed;

        if (i != j) {
            vec.swap(i, j);
        };

        i = i - 1;
    };

    current_seed
}

// ============================================
// COMMIT-REVEAL FUNCTIONS
// ============================================

/// Creates a commitment to a value.
/// The commitment is H(value || salt).
///
/// ## Parameters
/// - `value`: The value to commit to
/// - `salt`: Random salt (at least 16 bytes; 16 bytes gives 128 bits of hiding entropy)
/// - `committer`: Address of the committer
/// - `timestamp`: When the commitment was made
public fun create_commitment(
    value: &vector<u8>,
    salt: &vector<u8>,
    committer: address,
    timestamp: u64,
): Commitment {
    assert!(salt.length() >= 16, EInvalidParameter); // Minimum salt length

    // Length-prefix each field to prevent concatenation ambiguity.
    // Without lengths, value=[1,2]+salt=[3,4] hashes identically to
    // value=[1]+salt=[2,3,4], breaking the binding property.
    let mut hash_input = DOMAIN_COMMIT_REVEAL;
    hash_input.append(signature::u64_to_be_bytes(value.length()));
    hash_input.append(*value);
    hash_input.append(signature::u64_to_be_bytes(salt.length()));
    hash_input.append(*salt);

    Commitment {
        hash: hash::blake2b256(&hash_input),
        committer,
        timestamp,
    }
}

/// Creates a reveal for a commitment.
public fun create_reveal(value: vector<u8>, salt: vector<u8>): Reveal {
    Reveal { value, salt }
}

/// Verifies that a reveal matches a commitment.
public fun verify_commitment(commitment: &Commitment, reveal: &Reveal): bool {
    // Must match the length-prefixed encoding used in create_commitment
    let mut hash_input = DOMAIN_COMMIT_REVEAL;
    hash_input.append(signature::u64_to_be_bytes(reveal.value.length()));
    hash_input.append(reveal.value);
    hash_input.append(signature::u64_to_be_bytes(reveal.salt.length()));
    hash_input.append(reveal.salt);

    let computed_hash = hash::blake2b256(&hash_input);
    computed_hash == commitment.hash
}

/// Combines two reveals into a seed.
/// Used in two-party commit-reveal scheme.
///
/// ## Security
/// Both reveals should be verified against their commitments first.
public fun combine_reveals(reveal_a: &Reveal, reveal_b: &Reveal): Seed {
    // Length-prefix each field to prevent concatenation ambiguity
    // across the boundary between party A's salt and party B's value.
    let mut hash_input = DOMAIN_COMMIT_REVEAL;
    hash_input.append(signature::u64_to_be_bytes(reveal_a.value.length()));
    hash_input.append(reveal_a.value);
    hash_input.append(signature::u64_to_be_bytes(reveal_a.salt.length()));
    hash_input.append(reveal_a.salt);
    hash_input.append(signature::u64_to_be_bytes(reveal_b.value.length()));
    hash_input.append(reveal_b.value);
    hash_input.append(signature::u64_to_be_bytes(reveal_b.salt.length()));
    hash_input.append(reveal_b.salt);

    Seed {
        bytes: hash::blake2b256(&hash_input),
        counter: 0,
    }
}

/// Creates a combined randomness object for two-party commit-reveal.
public fun create_combined_randomness(
    commitment_a: Commitment,
    commitment_b: Commitment,
): CombinedRandomness {
    CombinedRandomness {
        seed: Seed { bytes: vector[], counter: 0 },
        commitment_a,
        commitment_b,
        finalized: false,
    }
}

/// Finalizes combined randomness with both reveals.
/// Verifies commitments and combines into final seed.
public fun finalize_combined_randomness(
    combined: &mut CombinedRandomness,
    reveal_a: &Reveal,
    reveal_b: &Reveal,
) {
    assert!(!combined.finalized, ERandomnessAlreadyRevealed);

    // Verify both reveals match their commitments
    assert!(verify_commitment(&combined.commitment_a, reveal_a), ERandomnessCommitmentMismatch);
    assert!(verify_commitment(&combined.commitment_b, reveal_b), ERandomnessCommitmentMismatch);

    // Combine reveals into seed
    combined.seed = combine_reveals(reveal_a, reveal_b);
    combined.finalized = true;
}

// ============================================
// ACCESSOR FUNCTIONS
// ============================================

/// Get the raw bytes of a seed
public fun seed_bytes(seed: &Seed): &vector<u8> {
    &seed.bytes
}

/// Get the counter of a seed
public fun seed_counter(seed: &Seed): u64 {
    seed.counter
}

/// Get the hash of a commitment
public fun commitment_hash(commitment: &Commitment): &vector<u8> {
    &commitment.hash
}

/// Get the committer address
public fun commitment_committer(commitment: &Commitment): address {
    commitment.committer
}

/// Get the commitment timestamp
public fun commitment_timestamp(commitment: &Commitment): u64 {
    commitment.timestamp
}

/// Get the revealed value
public fun reveal_value(reveal: &Reveal): &vector<u8> {
    &reveal.value
}

/// Get the reveal salt
public fun reveal_salt(reveal: &Reveal): &vector<u8> {
    &reveal.salt
}

/// Check if combined randomness is finalized
public fun is_finalized(combined: &CombinedRandomness): bool {
    combined.finalized
}

/// Get the seed from finalized combined randomness
public fun combined_seed(combined: &CombinedRandomness): &Seed {
    assert!(combined.finalized, ERandomnessNotAvailable);
    &combined.seed
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/// Creates a domain-separated message
fun create_domain_message(domain: vector<u8>, data: vector<u8>): vector<u8> {
    let mut result = domain;
    result.append(data);
    result
}

/// Converts first 8 bytes to u64 (big-endian).
/// Aborts with `EInvalidParameter` if fewer than 8 bytes are supplied.
public fun bytes_to_u64(bytes: &vector<u8>): u64 {
    assert!(bytes.length() >= 8, EInvalidParameter);
    let b0 = (bytes[0] as u64);
    let b1 = (bytes[1] as u64);
    let b2 = (bytes[2] as u64);
    let b3 = (bytes[3] as u64);
    let b4 = (bytes[4] as u64);
    let b5 = (bytes[5] as u64);
    let b6 = (bytes[6] as u64);
    let b7 = (bytes[7] as u64);

    (b0 << 56) | (b1 << 48) | (b2 << 40) | (b3 << 32) |
    (b4 << 24) | (b5 << 16) | (b6 << 8) | b7
}

/// Converts first 16 bytes to u128 (big-endian)
fun bytes_to_u128(bytes: &vector<u8>): u128 {
    let high = (bytes_to_u64(bytes) as u128);
    let low_bytes = vector::tabulate!(8, |i| bytes[i + 8]);
    let low = (bytes_to_u64(&low_bytes) as u128);

    (high << 64) | low
}

/// Converts 32 bytes to u256 (big-endian)
fun bytes_to_u256(bytes: &vector<u8>): u256 {
    let high = (bytes_to_u128(bytes) as u256);

    let low_bytes = vector::tabulate!(16, |i| bytes[i + 16]);

    // Need to compute low u128
    let low_high = bytes_to_u64(&low_bytes);
    let low_low_bytes = vector::tabulate!(8, |j| low_bytes[j + 8]);
    let low_low = bytes_to_u64(&low_low_bytes);
    let low = (((low_high as u128) << 64) | (low_low as u128) as u256);

    (high << 128) | low
}
