/// Module: signature
///
/// Unified signature verification utilities for the Sui Tunnel Framework.
/// Supports multiple signature schemes with a consistent interface.
///
/// ## Supported Signature Schemes
///
/// | Type | Constant | Signature Size | Public Key Size | Use Case |
/// |------|----------|----------------|-----------------|----------|
/// | ED25519 | 0 | 64 bytes | 32 bytes | General purpose, fast |
/// | BLS12381_MIN_SIG | 1 | 48 bytes | 96 bytes | Aggregatable, randomness |
/// | BLS12381_MIN_PK | 2 | 96 bytes | 48 bytes | Smaller public keys |
/// | SECP256K1 | 3 | 64 bytes | 33/65 bytes | Ethereum compatible |
///
/// ## Usage Example
///
/// ```move
/// use sui_tunnel::signature;
///
/// // Verify an ED25519 signature
/// let is_valid = signature::verify(
///     signature::ed25519(),
///     &public_key,
///     &message,
///     &signature_bytes
/// );
///
/// // Or use type-specific function
/// let is_valid = signature::verify_ed25519(&public_key, &message, &signature_bytes);
/// ```
///
/// ## Security Notes
///
/// - Always validate public key length before verification
/// - Never reuse nonces across different messages
/// - Use domain separation in message construction
module sui_tunnel::signature;

use sui::bls12381;
use sui::ecdsa_k1;
use sui::ed25519;
use sui::hash;

// === Error definitions (see sui_tunnel::errors for the canonical registry) ===

#[error]
const EInvalidParameter: vector<u8> = b"A required parameter is missing or invalid.";

#[error]
const EInvalidSignature: vector<u8> = b"Signature verification failed.";

#[error]
const EInvalidPublicKey: vector<u8> = b"The public key is invalid or has the wrong length for its scheme.";

#[error]
const EUnsupportedSignatureType: vector<u8> = b"The signature scheme is not supported.";

// ============================================
// SIGNATURE TYPE CONSTANTS
// ============================================

/// ED25519 signature scheme (64-byte sig, 32-byte pubkey)
const SIG_TYPE_ED25519: u8 = 0;

/// BLS12381 with minimal signature size (48-byte sig, 96-byte pubkey)
const SIG_TYPE_BLS12381_MIN_SIG: u8 = 1;

/// BLS12381 with minimal public key size (96-byte sig, 48-byte pubkey)
const SIG_TYPE_BLS12381_MIN_PK: u8 = 2;

/// Secp256k1 signature scheme (64-byte sig, 33/65-byte pubkey)
const SIG_TYPE_SECP256K1: u8 = 3;

// ============================================
// SIZE CONSTANTS
// ============================================

/// ED25519 signature size in bytes
const ED25519_SIG_SIZE: u64 = 64;

/// ED25519 public key size in bytes
const ED25519_PK_SIZE: u64 = 32;

/// BLS12381 G1 point size (used as signature in min_sig scheme)
const BLS12381_G1_SIZE: u64 = 48;

/// BLS12381 G2 point size (used as public key in min_sig scheme)
const BLS12381_G2_SIZE: u64 = 96;

/// Secp256k1 signature size (r, s without recovery id)
const SECP256K1_SIG_SIZE: u64 = 64;

/// Secp256k1 compressed public key size
const SECP256K1_COMPRESSED_PK_SIZE: u64 = 33;

/// Secp256k1 uncompressed public key size
const SECP256K1_UNCOMPRESSED_PK_SIZE: u64 = 65;

/// Maximum domain length encodable in the single length prefix byte
const MAX_DOMAIN_LEN: u64 = 255;

// ============================================
// HASH TYPE CONSTANTS (for Secp256k1)
// ============================================

/// Keccak256 hash function (Ethereum compatible)
const HASH_KECCAK256: u8 = 0;

/// SHA256 hash function
const HASH_SHA256: u8 = 1;

// ============================================
// PUBLIC GETTER FUNCTIONS FOR CONSTANTS
// ============================================

/// Returns the ED25519 signature type constant
public fun ed25519(): u8 { SIG_TYPE_ED25519 }

/// Returns the BLS12381 minimal signature type constant
public fun bls12381_min_sig(): u8 { SIG_TYPE_BLS12381_MIN_SIG }

/// Returns the BLS12381 minimal public key type constant
public fun bls12381_min_pk(): u8 { SIG_TYPE_BLS12381_MIN_PK }

/// Returns the Secp256k1 signature type constant
public fun secp256k1(): u8 { SIG_TYPE_SECP256K1 }

/// Returns the Keccak256 hash type constant
public fun hash_keccak256(): u8 { HASH_KECCAK256 }

/// Returns the SHA256 hash type constant
public fun hash_sha256(): u8 { HASH_SHA256 }

// ============================================
// SIZE GETTER FUNCTIONS
// ============================================

/// Returns expected signature size for a given signature type
public fun signature_size(sig_type: u8): u64 {
    if (sig_type == SIG_TYPE_ED25519) {
        ED25519_SIG_SIZE
    } else if (sig_type == SIG_TYPE_BLS12381_MIN_SIG) {
        BLS12381_G1_SIZE
    } else if (sig_type == SIG_TYPE_BLS12381_MIN_PK) {
        BLS12381_G2_SIZE
    } else if (sig_type == SIG_TYPE_SECP256K1) {
        SECP256K1_SIG_SIZE
    } else {
        abort EUnsupportedSignatureType
    }
}

/// Returns expected public key size for a given signature type
/// For Secp256k1, returns the compressed size (33 bytes)
public fun public_key_size(sig_type: u8): u64 {
    if (sig_type == SIG_TYPE_ED25519) {
        ED25519_PK_SIZE
    } else if (sig_type == SIG_TYPE_BLS12381_MIN_SIG) {
        BLS12381_G2_SIZE
    } else if (sig_type == SIG_TYPE_BLS12381_MIN_PK) {
        BLS12381_G1_SIZE
    } else if (sig_type == SIG_TYPE_SECP256K1) {
        SECP256K1_COMPRESSED_PK_SIZE
    } else {
        abort EUnsupportedSignatureType
    }
}

// ============================================
// VALIDATION FUNCTIONS
// ============================================

/// Validates that a signature type is supported
public fun is_valid_signature_type(sig_type: u8): bool {
    sig_type == SIG_TYPE_ED25519 ||
    sig_type == SIG_TYPE_BLS12381_MIN_SIG ||
    sig_type == SIG_TYPE_BLS12381_MIN_PK ||
    sig_type == SIG_TYPE_SECP256K1
}

/// Validates that a public key has the correct length for the given signature type
public fun is_valid_public_key_length(sig_type: u8, public_key: &vector<u8>): bool {
    let pk_len = public_key.length();

    if (sig_type == SIG_TYPE_ED25519) {
        pk_len == ED25519_PK_SIZE
    } else if (sig_type == SIG_TYPE_BLS12381_MIN_SIG) {
        pk_len == BLS12381_G2_SIZE
    } else if (sig_type == SIG_TYPE_BLS12381_MIN_PK) {
        pk_len == BLS12381_G1_SIZE
    } else if (sig_type == SIG_TYPE_SECP256K1) {
        pk_len == SECP256K1_COMPRESSED_PK_SIZE ||
        pk_len == SECP256K1_UNCOMPRESSED_PK_SIZE
    } else {
        false
    }
}

/// Validates that a signature has the correct length for the given signature type
public fun is_valid_signature_length(sig_type: u8, signature: &vector<u8>): bool {
    let sig_len = signature.length();

    if (sig_type == SIG_TYPE_ED25519) {
        sig_len == ED25519_SIG_SIZE
    } else if (sig_type == SIG_TYPE_BLS12381_MIN_SIG) {
        sig_len == BLS12381_G1_SIZE
    } else if (sig_type == SIG_TYPE_BLS12381_MIN_PK) {
        sig_len == BLS12381_G2_SIZE
    } else if (sig_type == SIG_TYPE_SECP256K1) {
        // Only the 64-byte non-recoverable (r, s) form is accepted.
        // Sui's native `ecdsa_k1::secp256k1_verify` rejects 65-byte
        // (recovery-id) signatures, so they can never verify.
        sig_len == SECP256K1_SIG_SIZE
    } else {
        false
    }
}

// ============================================
// UNIFIED VERIFICATION INTERFACE
// ============================================

/// Unified signature verification function.
/// Verifies a signature against a message using the specified signature scheme.
///
/// ## Parameters
/// - `sig_type`: The signature scheme type (use constants like `ed25519()`)
/// - `public_key`: The signer's public key
/// - `message`: The message that was signed
/// - `signature`: The signature to verify
///
/// ## Returns
/// - `true` if the signature is valid
/// - `false` if the signature is invalid
///
/// ## Aborts
/// - If the signature type is not supported
/// - If the public key or signature length is invalid
///
/// ## Hashing
/// For Secp256k1, the message is hashed with SHA256 before ECDSA verification
/// (matching the SDK's signing). Signers that hash with Keccak256 must use
/// `verify_with_hash` with HASH_KECCAK256 instead.
public fun verify(
    sig_type: u8,
    public_key: &vector<u8>,
    message: &vector<u8>,
    signature: &vector<u8>,
): bool {
    // Validate signature type
    assert!(is_valid_signature_type(sig_type), EUnsupportedSignatureType);

    // Validate lengths
    assert!(is_valid_public_key_length(sig_type, public_key), EInvalidPublicKey);
    assert!(is_valid_signature_length(sig_type, signature), EInvalidSignature);

    // Dispatch to type-specific verification
    if (sig_type == SIG_TYPE_ED25519) {
        verify_ed25519_internal(public_key, message, signature)
    } else if (sig_type == SIG_TYPE_BLS12381_MIN_SIG) {
        verify_bls12381_min_sig_internal(public_key, message, signature)
    } else if (sig_type == SIG_TYPE_BLS12381_MIN_PK) {
        verify_bls12381_min_pk_internal(public_key, message, signature)
    } else if (sig_type == SIG_TYPE_SECP256K1) {
        // Default to SHA256 hash for secp256k1
        verify_secp256k1_internal(public_key, message, signature, HASH_SHA256)
    } else {
        // unreachable: sig_type validated above
        false
    }
}

/// Unified verification with an explicit hash type, for Secp256k1 callers that
/// hash with Keccak256 (e.g. Ethereum) rather than the SHA256 default of `verify`.
/// For non-Secp256k1 schemes `hash_type` is ignored and this delegates to `verify`.
/// Returns false on a bad signature; aborts on an unsupported type or invalid
/// public-key/signature length.
public fun verify_with_hash(
    sig_type: u8,
    public_key: &vector<u8>,
    message: &vector<u8>,
    signature: &vector<u8>,
    hash_type: u8,
): bool {
    // For non-secp256k1, ignore hash_type and use standard verify
    if (sig_type != SIG_TYPE_SECP256K1) {
        return verify(sig_type, public_key, message, signature)
    };

    // Validate inputs
    assert!(is_valid_signature_type(sig_type), EUnsupportedSignatureType);
    assert!(is_valid_public_key_length(sig_type, public_key), EInvalidPublicKey);
    assert!(is_valid_signature_length(sig_type, signature), EInvalidSignature);

    verify_secp256k1_internal(public_key, message, signature, hash_type)
}

// ============================================
// TYPE-SPECIFIC VERIFICATION FUNCTIONS
// ============================================

/// Verifies an ED25519 signature
///
/// ## Parameters
/// - `public_key`: 32-byte ED25519 public key
/// - `message`: The message that was signed
/// - `signature`: 64-byte ED25519 signature
public fun verify_ed25519(
    public_key: &vector<u8>,
    message: &vector<u8>,
    signature: &vector<u8>,
): bool {
    assert!(public_key.length() == ED25519_PK_SIZE, EInvalidPublicKey);
    assert!(signature.length() == ED25519_SIG_SIZE, EInvalidSignature);

    verify_ed25519_internal(public_key, message, signature)
}

/// Verifies a BLS12381 signature with minimal signature size
///
/// ## Parameters
/// - `public_key`: 96-byte BLS12381 G2 public key
/// - `message`: The message that was signed
/// - `signature`: 48-byte BLS12381 G1 signature
public fun verify_bls12381_min_sig(
    public_key: &vector<u8>,
    message: &vector<u8>,
    signature: &vector<u8>,
): bool {
    assert!(public_key.length() == BLS12381_G2_SIZE, EInvalidPublicKey);
    assert!(signature.length() == BLS12381_G1_SIZE, EInvalidSignature);

    verify_bls12381_min_sig_internal(public_key, message, signature)
}

/// Verifies a BLS12381 signature with minimal public key size
///
/// ## Parameters
/// - `public_key`: 48-byte BLS12381 G1 public key
/// - `message`: The message that was signed
/// - `signature`: 96-byte BLS12381 G2 signature
public fun verify_bls12381_min_pk(
    public_key: &vector<u8>,
    message: &vector<u8>,
    signature: &vector<u8>,
): bool {
    assert!(public_key.length() == BLS12381_G1_SIZE, EInvalidPublicKey);
    assert!(signature.length() == BLS12381_G2_SIZE, EInvalidSignature);

    verify_bls12381_min_pk_internal(public_key, message, signature)
}

/// Verifies a Secp256k1 signature with specified hash function
///
/// ## Parameters
/// - `public_key`: 33-byte (compressed) or 65-byte (uncompressed) Secp256k1 public key
/// - `message`: The raw message (will be hashed with specified hash function)
/// - `signature`: 64-byte non-recoverable Secp256k1 signature (r, s).
///   65-byte recoverable signatures (with recovery id) are NOT accepted, as
///   Sui's native `ecdsa_k1::secp256k1_verify` rejects them.
/// - `hash_type`: Hash function to use (HASH_KECCAK256 or HASH_SHA256)
public fun verify_secp256k1(
    public_key: &vector<u8>,
    message: &vector<u8>,
    signature: &vector<u8>,
    hash_type: u8,
): bool {
    let pk_len = public_key.length();
    assert!(
        pk_len == SECP256K1_COMPRESSED_PK_SIZE || pk_len == SECP256K1_UNCOMPRESSED_PK_SIZE,
        EInvalidPublicKey,
    );

    let sig_len = signature.length();
    assert!(sig_len == SECP256K1_SIG_SIZE, EInvalidSignature);

    verify_secp256k1_internal(public_key, message, signature, hash_type)
}

// ============================================
// INTERNAL VERIFICATION FUNCTIONS
// ============================================

fun verify_ed25519_internal(
    public_key: &vector<u8>,
    message: &vector<u8>,
    signature: &vector<u8>,
): bool {
    ed25519::ed25519_verify(signature, public_key, message)
}

fun verify_bls12381_min_sig_internal(
    public_key: &vector<u8>,
    message: &vector<u8>,
    signature: &vector<u8>,
): bool {
    bls12381::bls12381_min_sig_verify(signature, public_key, message)
}

fun verify_bls12381_min_pk_internal(
    public_key: &vector<u8>,
    message: &vector<u8>,
    signature: &vector<u8>,
): bool {
    bls12381::bls12381_min_pk_verify(signature, public_key, message)
}

fun verify_secp256k1_internal(
    public_key: &vector<u8>,
    message: &vector<u8>,
    signature: &vector<u8>,
    hash_type: u8,
): bool {
    ecdsa_k1::secp256k1_verify(signature, public_key, message, hash_type)
}

// ============================================
// MESSAGE CONSTRUCTION HELPERS
// ============================================

/// Creates a domain-separated message for signing.
/// This prevents signature reuse across different contexts.
///
/// ## Parameters
/// - `domain`: A unique domain identifier (e.g., "sui_tunnel::payment")
/// - `message`: The actual message content
///
/// ## Returns
/// A new vector containing: domain_length (1 byte) || domain || message
public fun create_domain_separated_message(domain: vector<u8>, message: vector<u8>): vector<u8> {
    let domain_len = domain.length();
    assert!(domain_len <= MAX_DOMAIN_LEN, EInvalidParameter);

    let mut result = vector<u8>[];
    result.push_back((domain_len as u8));
    result.append(domain);
    result.append(message);
    result
}

/// Generic domain-separated message helper.
/// NOTE: not used by the tunnel protocol's signed messages, which are
/// constructed in the `tunnel` module (with the `state_update` / `settlement` /
/// `settlement_v2` / `htlc_lock` separators); provided as a standalone utility.
///
/// ## Parameters
/// - `tunnel_id`: The tunnel's object ID bytes
/// - `nonce`: A unique nonce for this message
/// - `data`: The actual data to sign
///
/// ## Returns
/// A new vector containing: the literal `b"sui_tunnel::signature::message"` prefix
/// (this helper's own separator, distinct from the protocol's live separators) ||
/// tunnel_id || nonce (8 bytes BE) || data
public fun create_tunnel_message(tunnel_id: vector<u8>, nonce: u64, data: vector<u8>): vector<u8> {
    let mut result = b"sui_tunnel::signature::message";
    result.append(tunnel_id);

    // Append nonce as 8-byte big-endian
    let nonce_bytes = u64_to_be_bytes(nonce);
    result.append(nonce_bytes);

    result.append(data);
    result
}

/// Hashes a message using Blake2b-256.
/// Useful for creating fixed-size message digests before signing.
public fun hash_message(message: &vector<u8>): vector<u8> {
    hash::blake2b256(message)
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

/// Converts a u64 to 8-byte big-endian representation
public fun u64_to_be_bytes(value: u64): vector<u8> {
    let mut bytes = vector<u8>[];
    bytes.push_back(((value >> 56) & 0xFF) as u8);
    bytes.push_back(((value >> 48) & 0xFF) as u8);
    bytes.push_back(((value >> 40) & 0xFF) as u8);
    bytes.push_back(((value >> 32) & 0xFF) as u8);
    bytes.push_back(((value >> 24) & 0xFF) as u8);
    bytes.push_back(((value >> 16) & 0xFF) as u8);
    bytes.push_back(((value >> 8) & 0xFF) as u8);
    bytes.push_back((value & 0xFF) as u8);
    bytes
}

/// Converts 8-byte big-endian representation to u64
public fun be_bytes_to_u64(bytes: &vector<u8>): u64 {
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

/// Concatenates multiple byte vectors into one, in order.
public fun concat_bytes(vectors: vector<vector<u8>>): vector<u8> {
    let mut result = vector<u8>[];
    vectors.do!(|v| result.append(v));
    result
}
