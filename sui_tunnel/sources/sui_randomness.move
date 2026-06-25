/// Sui native randomness bridge for tunnel control-plane flows.
///
/// Quantum Poker keeps gameplay off-chain in the generic tunnel. This module
/// only emits a Sui-native randomness seed during session open/funding so the
/// bot server has a verifiable public entropy source for deriving private slot
/// secrets. The seed is public and must not replace poker commit-reveal.
module sui_tunnel::sui_randomness;

use sui::event;
use sui::hash;
use sui::random::{Self, Random};
use sui_tunnel::signature;

const DOMAIN_QUANTUM_POKER_SESSION_SEED: vector<u8> = b"sui_tunnel::quantum_poker::session_seed";

public struct QuantumPokerRandomnessSeed has copy, drop {
    tunnel_id: ID,
    session_nonce: u64,
    requester: address,
    seed: vector<u8>,
}

entry fun entry_emit_quantum_poker_seed(
    random: &Random,
    tunnel_id: ID,
    session_nonce: u64,
    context: vector<u8>,
    ctx: &mut sui::tx_context::TxContext,
) {
    let requester = ctx.sender();
    let mut generator = random::new_generator(random, ctx);
    let sui_random_bytes = random::generate_bytes(&mut generator, 32);
    let seed = derive_quantum_poker_seed(
        tunnel_id,
        session_nonce,
        requester,
        sui_random_bytes,
        context,
    );

    event::emit(QuantumPokerRandomnessSeed {
        tunnel_id,
        session_nonce,
        requester,
        seed,
    });
}

fun derive_quantum_poker_seed(
    tunnel_id: ID,
    session_nonce: u64,
    requester: address,
    sui_random_bytes: vector<u8>,
    context: vector<u8>,
): vector<u8> {
    let mut input = DOMAIN_QUANTUM_POKER_SESSION_SEED;
    input.append(tunnel_id.to_bytes());
    input.append(signature::u64_to_be_bytes(session_nonce));
    input.append(requester.to_bytes());
    input.append(sui_random_bytes);
    input.append(context);
    hash::blake2b256(&input)
}
