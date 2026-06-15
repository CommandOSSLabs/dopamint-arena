/// Module: zk_verifier
///
/// Zero-knowledge proof verification for the Sui Tunnel Framework.
/// Enables zkTunnels where tunnel logic can be private while still
/// being verifiable on-chain.
///
/// ## Supported Proof Systems
///
/// - **Groth16**: Most efficient for verification, requires trusted setup
///   - BLS12-381 curve
///   - BN254 curve (Ethereum compatible)
///
/// ## Architecture
///
/// ```
/// ┌─────────────────────────────────────────────────────┐
/// │                    zkTunnel                         │
/// │                                                     │
/// │  Off-chain:                                         │
/// │  ┌─────────────┐    ┌─────────────┐                 │
/// │  │   Circuit   │───►│   Prover    │───► Proof       │
/// │  │   (Logic)   │    └─────────────┘                 │
/// │  └─────────────┘                                    │
/// │                                                     │
/// │  On-chain:                                          │
/// │  ┌─────────────┐    ┌─────────────┐                 │
/// │  │  Verifier   │◄───│   Proof +    │                 │
/// │  │   (VK)      │    │   Inputs    │                 │
/// │  └─────────────┘    └─────────────┘                 │
/// │         │                                           │
/// │         ▼                                           │
/// │    Valid/Invalid                                    │
/// └─────────────────────────────────────────────────────┘
/// ```
///
/// ## Usage Example
///
/// ```move
/// use sui_tunnel::zk_verifier;
///
/// // Register a circuit (once per circuit type)
/// let circuit_id = zk_verifier::register_circuit(
///     b"payment_circuit",
///     zk_verifier::curve_bn254(),
///     prepared_vk,
///     2,  // 2 public inputs expected
/// );
///
/// // Verify a proof
/// let is_valid = zk_verifier::verify_circuit_proof(
///     &circuit_registry,
///     circuit_id,
///     &public_inputs,
///     &proof_bytes,
/// );
/// ```
///
/// ## Security Notes
///
/// - Circuit verification keys should be generated through a trusted setup
/// - Public inputs must be carefully validated before verification
/// - Proof verification is computationally expensive - design circuits carefully
module sui_tunnel::zk_verifier;

use sui::event;
use sui::groth16::{Self, Curve, PreparedVerifyingKey, ProofPoints, PublicProofInputs};
use sui::hash;

// === Error definitions (see sui_tunnel::errors for the canonical registry) ===

#[error]
const ENotAuthorized: vector<u8> = b"The caller is not authorized to perform this action.";

#[error]
const EInvalidParameter: vector<u8> = b"A required parameter is missing or invalid.";

#[error]
const EEmptyInput: vector<u8> = b"Input is empty where a non-empty value was required.";

#[error]
const EInvalidVersion: vector<u8> = b"The object version does not match the current module version.";

#[error]
const EInvalidPublicInputs: vector<u8> = b"The public inputs to the proof are invalid.";

#[error]
const ECircuitNotRegistered: vector<u8> = b"The circuit id is not registered.";

#[error]
const ECircuitAlreadyRegistered: vector<u8> = b"A circuit with this id is already registered.";

// ============================================
// CONSTANTS
// ============================================

/// Current struct version for upgrade compatibility
const CURRENT_VERSION: u64 = 1;

/// Maximum number of public inputs supported (Sui limit)
const MAX_PUBLIC_INPUTS: u64 = 8;

/// Size of each public input scalar in bytes
const SCALAR_SIZE: u64 = 32;

/// Curve type: BLS12-381
const CURVE_BLS12381: u8 = 0;

/// Curve type: BN254
const CURVE_BN254: u8 = 1;

// ============================================
// STRUCTS
// ============================================

/// Registered circuit with its verification key
public struct Circuit has copy, drop, store {
    /// Unique identifier (hash of name)
    id: vector<u8>,
    /// Human-readable name
    name: vector<u8>,
    /// Which curve this circuit uses
    curve: u8,
    /// Prepared verification key
    pvk: PreparedVerifyingKey,
    /// Expected number of public inputs
    num_public_inputs: u64,
    /// Schema hash for input validation
    input_schema_hash: vector<u8>,
    /// Whether circuit is active
    active: bool,
}

/// Registry of circuits for an application.
/// O(n) circuit lookup is acceptable for typical registry sizes (<100 circuits).
public struct CircuitRegistry has key, store {
    id: UID,
    /// Struct version for upgrade compatibility
    version: u64,
    /// List of registered circuits
    circuits: vector<Circuit>,
    /// Owner who can modify the registry
    owner: address,
}

/// Verification result with metadata
public struct VerificationResult has copy, drop, store {
    /// Whether the proof was valid
    valid: bool,
    /// Circuit ID that was verified
    circuit_id: vector<u8>,
    /// Hash of the public inputs
    inputs_hash: vector<u8>,
    /// Timestamp of verification
    timestamp: u64,
}

/// zkTunnel state proof data
public struct ZkStateProof has copy, drop, store {
    /// The circuit ID used
    circuit_id: vector<u8>,
    /// Public inputs as bytes
    public_inputs: vector<u8>,
    /// The proof bytes
    proof: vector<u8>,
    /// State version this proof attests to
    state_version: u64,
}

/// Prepared verification data for efficient verification
public struct PreparedProof has copy, drop, store {
    /// The curve to use
    curve: Curve,
    /// Public inputs wrapper
    inputs: PublicProofInputs,
    /// Proof points wrapper
    proof_points: ProofPoints,
}

// ============================================
// EVENTS
// ============================================

/// Emitted when a new circuit is registered
public struct CircuitRegistered has copy, drop {
    circuit_id: vector<u8>,
    num_public_inputs: u64,
    curve: u8,
}

/// Emitted when a circuit is deactivated
public struct CircuitDeactivated has copy, drop {
    circuit_id: vector<u8>,
}

/// Emitted when a proof is verified
public struct ProofVerified has copy, drop {
    circuit_id: vector<u8>,
    success: bool,
}

// ============================================
// PUBLIC GETTER FUNCTIONS FOR CONSTANTS
// ============================================

/// Returns the BLS12-381 curve constant
public fun curve_bls12381(): u8 { CURVE_BLS12381 }

/// Returns the BN254 curve constant
public fun curve_bn254(): u8 { CURVE_BN254 }

/// Returns the maximum number of public inputs
public fun max_public_inputs(): u64 { MAX_PUBLIC_INPUTS }

/// Returns the size of each scalar in bytes
public fun scalar_size(): u64 { SCALAR_SIZE }

// ============================================
// CURVE FUNCTIONS
// ============================================

/// Gets the Sui Curve object for a curve type
public fun get_curve(curve_type: u8): Curve {
    if (curve_type == CURVE_BLS12381) {
        groth16::bls12381()
    } else if (curve_type == CURVE_BN254) {
        groth16::bn254()
    } else {
        abort EInvalidParameter
    }
}

/// Checks if a curve type is valid
public fun is_valid_curve(curve_type: u8): bool {
    curve_type == CURVE_BLS12381 || curve_type == CURVE_BN254
}

// ============================================
// CIRCUIT CREATION FUNCTIONS
// ============================================

/// Creates a circuit ID from a name
public fun create_circuit_id(name: &vector<u8>): vector<u8> {
    hash::blake2b256(name)
}

/// Creates a new circuit with a raw verification key
///
/// ## Parameters
/// - `name`: Human-readable circuit name
/// - `curve_type`: Which curve to use (BLS12381 or BN254)
/// - `verifying_key`: Raw Arkworks serialized verification key
/// - `num_public_inputs`: Expected number of public inputs
/// - `input_schema_hash`: Hash of the input schema for validation
public fun create_circuit(
    name: vector<u8>,
    curve_type: u8,
    verifying_key: &vector<u8>,
    num_public_inputs: u64,
    input_schema_hash: vector<u8>,
): Circuit {
    assert!(is_valid_curve(curve_type), EInvalidParameter);
    assert!(num_public_inputs <= MAX_PUBLIC_INPUTS, EInvalidPublicInputs);
    assert!(name.length() > 0, EEmptyInput);

    let curve = get_curve(curve_type);
    let pvk = groth16::prepare_verifying_key(&curve, verifying_key);

    Circuit {
        id: create_circuit_id(&name),
        name,
        curve: curve_type,
        pvk,
        num_public_inputs,
        input_schema_hash,
        active: true,
    }
}

/// Creates a circuit with a pre-prepared verification key
public fun create_circuit_with_pvk(
    name: vector<u8>,
    curve_type: u8,
    pvk: PreparedVerifyingKey,
    num_public_inputs: u64,
    input_schema_hash: vector<u8>,
): Circuit {
    assert!(is_valid_curve(curve_type), EInvalidParameter);
    assert!(num_public_inputs <= MAX_PUBLIC_INPUTS, EInvalidPublicInputs);
    assert!(name.length() > 0, EEmptyInput);

    Circuit {
        id: create_circuit_id(&name),
        name,
        curve: curve_type,
        pvk,
        num_public_inputs,
        input_schema_hash,
        active: true,
    }
}

// ============================================
// REGISTRY FUNCTIONS
// ============================================

/// Creates a new circuit registry
public fun create_registry(owner: address, ctx: &mut TxContext): CircuitRegistry {
    CircuitRegistry {
        id: object::new(ctx),
        version: CURRENT_VERSION,
        circuits: vector[],
        owner,
    }
}

/// Get the current version constant
public fun current_version(): u64 { CURRENT_VERSION }

/// Get a registry's version
public fun registry_version(registry: &CircuitRegistry): u64 { registry.version }

/// Assert that a registry is at the current version
public fun assert_current_version(registry: &CircuitRegistry) {
    assert!(registry.version == CURRENT_VERSION, EInvalidVersion);
}

/// Registers a circuit in the registry
public fun register_circuit(registry: &mut CircuitRegistry, circuit: Circuit, ctx: &TxContext) {
    assert!(ctx.sender() == registry.owner, ENotAuthorized);

    // Check for duplicate IDs
    let len = registry.circuits.length();
    let mut i = 0;
    while (i < len) {
        let existing = &registry.circuits[i];
        assert!(existing.id != circuit.id, ECircuitAlreadyRegistered);
        i = i + 1;
    };

    registry.circuits.push_back(circuit);

    let registered = &registry.circuits[registry.circuits.length() - 1];
    event::emit(CircuitRegistered {
        circuit_id: registered.id,
        num_public_inputs: registered.num_public_inputs,
        curve: registered.curve,
    });
}

/// Deactivates a circuit (soft delete)
public fun deactivate_circuit(
    registry: &mut CircuitRegistry,
    circuit_id: &vector<u8>,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == registry.owner, ENotAuthorized);

    let len = registry.circuits.length();
    let mut i = 0;
    while (i < len) {
        let circuit = &mut registry.circuits[i];
        if (&circuit.id == circuit_id) {
            circuit.active = false;
            event::emit(CircuitDeactivated { circuit_id: *circuit_id });
            return
        };
        i = i + 1;
    };

    abort ECircuitNotRegistered
}

/// Reactivates a previously deactivated circuit
public fun reactivate_circuit(
    registry: &mut CircuitRegistry,
    circuit_id: &vector<u8>,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == registry.owner, ENotAuthorized);

    let len = registry.circuits.length();
    let mut i = 0;
    while (i < len) {
        let circuit = &mut registry.circuits[i];
        if (&circuit.id == circuit_id) {
            circuit.active = true;
            return
        };
        i = i + 1;
    };

    abort ECircuitNotRegistered
}

/// Gets a circuit from the registry by ID
public fun get_circuit(registry: &CircuitRegistry, circuit_id: &vector<u8>): &Circuit {
    let len = registry.circuits.length();
    let mut i = 0;
    while (i < len) {
        let circuit = &registry.circuits[i];
        if (&circuit.id == circuit_id) {
            return circuit
        };
        i = i + 1;
    };

    abort ECircuitNotRegistered
}

/// Checks if a circuit is registered and active
public fun is_circuit_active(registry: &CircuitRegistry, circuit_id: &vector<u8>): bool {
    let len = registry.circuits.length();
    let mut i = 0;
    while (i < len) {
        let circuit = &registry.circuits[i];
        if (&circuit.id == circuit_id) {
            return circuit.active
        };
        i = i + 1;
    };

    false
}

// ============================================
// VERIFICATION FUNCTIONS
// ============================================

/// Verifies a Groth16 proof against a registered circuit
///
/// ## Parameters
/// - `registry`: The circuit registry
/// - `circuit_id`: ID of the circuit to verify against
/// - `public_inputs`: Public inputs as concatenated 32-byte scalars
/// - `proof_bytes`: The Groth16 proof bytes
///
/// ## Returns
/// `true` if the proof is valid, `false` otherwise
public fun verify_circuit_proof(
    registry: &CircuitRegistry,
    circuit_id: &vector<u8>,
    public_inputs: &vector<u8>,
    proof_bytes: &vector<u8>,
): bool {
    let circuit = get_circuit(registry, circuit_id);
    assert!(circuit.active, ECircuitNotRegistered);

    // Validate input length
    let expected_input_bytes = circuit.num_public_inputs * SCALAR_SIZE;
    assert!(public_inputs.length() == expected_input_bytes, EInvalidPublicInputs);

    let result = verify_with_circuit(circuit, public_inputs, proof_bytes);
    event::emit(ProofVerified { circuit_id: *circuit_id, success: result });
    result
}

/// Verifies a proof directly against a circuit (without registry)
public fun verify_with_circuit(
    circuit: &Circuit,
    public_inputs: &vector<u8>,
    proof_bytes: &vector<u8>,
): bool {
    // Validate input length (parity with verify_circuit_proof)
    let expected_input_bytes = circuit.num_public_inputs * SCALAR_SIZE;
    assert!(public_inputs.length() == expected_input_bytes, EInvalidPublicInputs);

    let curve = get_curve(circuit.curve);
    let inputs = groth16::public_proof_inputs_from_bytes(*public_inputs);
    let proof = groth16::proof_points_from_bytes(*proof_bytes);

    groth16::verify_groth16_proof(&curve, &circuit.pvk, &inputs, &proof)
}

/// Verifies a proof with raw components (no circuit struct needed)
public fun verify_raw(
    curve_type: u8,
    pvk: &PreparedVerifyingKey,
    public_inputs: &vector<u8>,
    proof_bytes: &vector<u8>,
): bool {
    let curve = get_curve(curve_type);
    let inputs = groth16::public_proof_inputs_from_bytes(*public_inputs);
    let proof = groth16::proof_points_from_bytes(*proof_bytes);

    groth16::verify_groth16_proof(&curve, pvk, &inputs, &proof)
}

/// Prepares inputs and proof for verification
public fun prepare_proof(
    curve_type: u8,
    public_inputs: &vector<u8>,
    proof_bytes: &vector<u8>,
): PreparedProof {
    PreparedProof {
        curve: get_curve(curve_type),
        inputs: groth16::public_proof_inputs_from_bytes(*public_inputs),
        proof_points: groth16::proof_points_from_bytes(*proof_bytes),
    }
}

/// Verifies a prepared proof against a PVK
public fun verify_prepared(pvk: &PreparedVerifyingKey, prepared: &PreparedProof): bool {
    groth16::verify_groth16_proof(
        &prepared.curve,
        pvk,
        &prepared.inputs,
        &prepared.proof_points,
    )
}

// ============================================
// ZKTUNNEL STATE VERIFICATION
// ============================================

/// Creates a zkTunnel state proof
public fun create_zk_state_proof(
    circuit_id: vector<u8>,
    public_inputs: vector<u8>,
    proof: vector<u8>,
    state_version: u64,
): ZkStateProof {
    ZkStateProof {
        circuit_id,
        public_inputs,
        proof,
        state_version,
    }
}

/// Verifies a zkTunnel state proof
public fun verify_zk_state_proof(registry: &CircuitRegistry, state_proof: &ZkStateProof): bool {
    verify_circuit_proof(
        registry,
        &state_proof.circuit_id,
        &state_proof.public_inputs,
        &state_proof.proof,
    )
}

/// Extracts the state version from a zk state proof
public fun state_proof_version(proof: &ZkStateProof): u64 {
    proof.state_version
}

// ============================================
// VERIFICATION RESULT FUNCTIONS
// ============================================

/// Creates a verification result
public fun create_verification_result(
    valid: bool,
    circuit_id: vector<u8>,
    public_inputs: &vector<u8>,
    timestamp: u64,
): VerificationResult {
    VerificationResult {
        valid,
        circuit_id,
        inputs_hash: hash::blake2b256(public_inputs),
        timestamp,
    }
}

// ============================================
// PUBLIC INPUT HELPERS
// ============================================

/// Converts a u64 to a 32-byte scalar (little-endian, padded)
public fun u64_to_scalar(value: u64): vector<u8> {
    let mut bytes = vector<u8>[];

    // Little-endian encoding
    bytes.push_back((value & 0xFF) as u8);
    bytes.push_back(((value >> 8) & 0xFF) as u8);
    bytes.push_back(((value >> 16) & 0xFF) as u8);
    bytes.push_back(((value >> 24) & 0xFF) as u8);
    bytes.push_back(((value >> 32) & 0xFF) as u8);
    bytes.push_back(((value >> 40) & 0xFF) as u8);
    bytes.push_back(((value >> 48) & 0xFF) as u8);
    bytes.push_back(((value >> 56) & 0xFF) as u8);

    // Pad to 32 bytes
    while (bytes.length() < 32) {
        bytes.push_back(0);
    };

    bytes
}

/// Converts a u256 to a 32-byte scalar (little-endian).
///
/// WARNING: A `u256` may exceed the BN254/BLS12-381 scalar field modulus `r`
/// (~2^254 / ~2^255 < 2^256). Callers must ensure `value < r` before using the
/// result as a Groth16 public input, otherwise proof verification will fail or
/// abort.
public fun u256_to_scalar(value: u256): vector<u8> {
    let mut bytes = vector<u8>[];
    let mut remaining = value;

    let mut i = 0u64;
    while (i < 32) {
        bytes.push_back(((remaining & 0xFF) as u8));
        remaining = remaining >> 8;
        i = i + 1;
    };

    bytes
}

/// Converts an address to a 32-byte scalar.
///
/// WARNING: A Sui address is a full 32-byte (256-bit) value and may exceed the
/// BN254/BLS12-381 scalar field modulus `r` (~2^254 / ~2^255 < 2^256). Callers
/// must ensure the resulting value is `< r` before using it as a Groth16 public
/// input, otherwise proof verification will fail or abort.
public fun address_to_scalar(addr: address): vector<u8> {
    // Sui addresses are always exactly 32 bytes, so no padding is needed.
    addr.to_bytes()
}

/// Concatenates multiple scalars into public inputs
public fun concat_scalars(scalars: vector<vector<u8>>): vector<u8> {
    let mut result = vector<u8>[];
    let num_scalars = scalars.length();

    assert!(num_scalars <= MAX_PUBLIC_INPUTS, EInvalidPublicInputs);

    let mut i = 0;
    while (i < num_scalars) {
        let scalar = &scalars[i];
        assert!(scalar.length() == 32, EInvalidPublicInputs);
        result.append(*scalar);
        i = i + 1;
    };

    result
}

/// Hashes data to create a public input scalar
public fun hash_to_scalar(data: &vector<u8>): vector<u8> {
    hash::blake2b256(data)
}

// ============================================
// ACCESSOR FUNCTIONS
// ============================================

// Circuit accessors
public fun circuit_id(circuit: &Circuit): &vector<u8> { &circuit.id }

public fun circuit_name(circuit: &Circuit): &vector<u8> { &circuit.name }

public fun circuit_curve(circuit: &Circuit): u8 { circuit.curve }

public fun circuit_num_inputs(circuit: &Circuit): u64 { circuit.num_public_inputs }

public fun circuit_input_schema_hash(circuit: &Circuit): &vector<u8> { &circuit.input_schema_hash }

public fun circuit_is_active(circuit: &Circuit): bool { circuit.active }

public fun circuit_pvk(circuit: &Circuit): &PreparedVerifyingKey { &circuit.pvk }

// Registry accessors
public fun registry_owner(registry: &CircuitRegistry): address { registry.owner }

public fun registry_circuit_count(registry: &CircuitRegistry): u64 { registry.circuits.length() }

// VerificationResult accessors
public fun result_valid(result: &VerificationResult): bool { result.valid }

public fun result_circuit_id(result: &VerificationResult): &vector<u8> { &result.circuit_id }

public fun result_inputs_hash(result: &VerificationResult): &vector<u8> { &result.inputs_hash }

public fun result_timestamp(result: &VerificationResult): u64 { result.timestamp }

// ZkStateProof accessors
public fun zk_proof_circuit_id(proof: &ZkStateProof): &vector<u8> { &proof.circuit_id }

public fun zk_proof_public_inputs(proof: &ZkStateProof): &vector<u8> { &proof.public_inputs }

public fun zk_proof_proof(proof: &ZkStateProof): &vector<u8> { &proof.proof }

public fun zk_proof_state_version(proof: &ZkStateProof): u64 { proof.state_version }

#[test_only]
public fun destroy_registry_for_testing(registry: CircuitRegistry) {
    let CircuitRegistry { id, .. } = registry;
    id.delete();
}
