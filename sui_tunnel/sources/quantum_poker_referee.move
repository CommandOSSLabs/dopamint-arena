/// Module: quantum_poker_referee
///
/// Proof-gated dispute resolver for Quantum Poker. It builds the exact eight
/// Groth16 public inputs expected by ADR 0002, verifies through `zk_verifier`,
/// then calls the package-local tunnel resolver.
module sui_tunnel::quantum_poker_referee;

use sui::clock::Clock;
use sui::event;
use sui::hash;
use sui_tunnel::quantum_poker;
use sui_tunnel::tunnel;
use sui_tunnel::zk_verifier;

#[error]
const EInvalidHash: vector<u8> = b"The hash value is invalid or has the wrong format.";

#[error]
const EInvalidWinner: vector<u8> = b"The winner code is invalid.";

#[error]
const EWrongTunnel: vector<u8> = b"The poker session is bound to a different tunnel.";

#[error]
const EStateHashMismatch: vector<u8> = b"The proof state hash does not match the disputed tunnel state.";

#[error]
const EInvalidProof: vector<u8> = b"The Groth16 proof is invalid.";

const HASH_LEN: u64 = 32;

public struct QuantumPokerDisputeResolved has copy, drop {
    tunnel_id: ID,
    session_id: ID,
    hand_id: u64,
    winner: u64,
    party_a_balance: u64,
    party_b_balance: u64,
}

public fun field_safe_scalar(hash32: vector<u8>): vector<u8> {
    assert!(hash32.length() == HASH_LEN, EInvalidHash);
    let mut scalar = hash32;
    let last = scalar[31];
    *scalar.borrow_mut(31) = last & 0x1f;
    scalar
}

public fun tunnel_id_hash<T>(tunnel_obj: &tunnel::Tunnel<T>): vector<u8> {
    let id = tunnel::id(tunnel_obj);
    let id_bytes = id.to_bytes();
    hash::blake2b256(&id_bytes)
}

public fun build_public_inputs(
    rules_hash: vector<u8>,
    tunnel_id_hash: vector<u8>,
    state_hash: vector<u8>,
    hand_id: u64,
    winner: u64,
    party_a_balance: u64,
    party_b_balance: u64,
    result_hash: vector<u8>,
): vector<u8> {
    assert!(winner <= quantum_poker::winner_tie(), EInvalidWinner);
    zk_verifier::concat_scalars(vector[
        field_safe_scalar(rules_hash),
        field_safe_scalar(tunnel_id_hash),
        field_safe_scalar(state_hash),
        zk_verifier::u64_to_scalar(hand_id),
        zk_verifier::u64_to_scalar(winner),
        zk_verifier::u64_to_scalar(party_a_balance),
        zk_verifier::u64_to_scalar(party_b_balance),
        field_safe_scalar(result_hash),
    ])
}

public fun build_public_inputs_for_tunnel<T>(
    session: &quantum_poker::PokerSession,
    tunnel_obj: &tunnel::Tunnel<T>,
    state_hash: vector<u8>,
    hand_id: u64,
    winner: u64,
    party_a_balance: u64,
    party_b_balance: u64,
    result_hash: vector<u8>,
): vector<u8> {
    assert!(quantum_poker::session_tunnel_id(session) == tunnel::id(tunnel_obj), EWrongTunnel);
    build_public_inputs(
        *quantum_poker::session_rules_hash(session),
        tunnel_id_hash(tunnel_obj),
        state_hash,
        hand_id,
        winner,
        party_a_balance,
        party_b_balance,
        result_hash,
    )
}

public fun verify_result_proof<T>(
    session: &quantum_poker::PokerSession,
    registry: &zk_verifier::CircuitRegistry,
    tunnel_obj: &tunnel::Tunnel<T>,
    proof_bytes: vector<u8>,
    state_hash: vector<u8>,
    hand_id: u64,
    winner: u64,
    party_a_balance: u64,
    party_b_balance: u64,
    result_hash: vector<u8>,
): bool {
    let current_state_hash = tunnel::state_hash(tunnel::state(tunnel_obj));
    assert!(&state_hash == current_state_hash, EStateHashMismatch);
    let public_inputs = build_public_inputs_for_tunnel(
        session,
        tunnel_obj,
        state_hash,
        hand_id,
        winner,
        party_a_balance,
        party_b_balance,
        result_hash,
    );
    zk_verifier::verify_circuit_proof(
        registry,
        quantum_poker::session_circuit_id(session),
        &public_inputs,
        &proof_bytes,
    )
}

public fun resolve_with_proof<T>(
    session: &quantum_poker::PokerSession,
    registry: &zk_verifier::CircuitRegistry,
    tunnel_obj: &mut tunnel::Tunnel<T>,
    proof_bytes: vector<u8>,
    state_hash: vector<u8>,
    hand_id: u64,
    winner: u64,
    party_a_balance: u64,
    party_b_balance: u64,
    result_hash: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let verified = verify_result_proof(
        session,
        registry,
        tunnel_obj,
        proof_bytes,
        state_hash,
        hand_id,
        winner,
        party_a_balance,
        party_b_balance,
        result_hash,
    );
    assert!(verified, EInvalidProof);

    tunnel::resolve_dispute_verified(tunnel_obj, party_a_balance, party_b_balance, clock, ctx);

    event::emit(QuantumPokerDisputeResolved {
        tunnel_id: tunnel::id(tunnel_obj),
        session_id: object::id(session),
        hand_id,
        winner,
        party_a_balance,
        party_b_balance,
    });
}

entry fun entry_resolve_with_proof<T>(
    session: &quantum_poker::PokerSession,
    registry: &zk_verifier::CircuitRegistry,
    tunnel_obj: &mut tunnel::Tunnel<T>,
    proof_bytes: vector<u8>,
    state_hash: vector<u8>,
    hand_id: u64,
    winner: u64,
    party_a_balance: u64,
    party_b_balance: u64,
    result_hash: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    resolve_with_proof(
        session,
        registry,
        tunnel_obj,
        proof_bytes,
        state_hash,
        hand_id,
        winner,
        party_a_balance,
        party_b_balance,
        result_hash,
        clock,
        ctx,
    )
}
