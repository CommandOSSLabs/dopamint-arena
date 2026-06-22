/// Module: quantum_poker
///
/// Package-local metadata for heads-up Quantum Poker sessions that settle through
/// a Sui Tunnel. The live game state remains off-chain; this object binds a poker
/// session to one tunnel and to the Groth16 circuit/schema used by the referee.
module sui_tunnel::quantum_poker;

use sui::event;
use sui_tunnel::tunnel;

#[error]
const EInvalidHash: vector<u8> = b"The hash value is invalid or has the wrong format.";

#[error]
const EInvalidCircuit: vector<u8> = b"The circuit identifier is invalid.";

#[error]
const ENotParty: vector<u8> = b"Only a tunnel party can create a poker session.";

const PROTOCOL_VERSION: u64 = 1;
const HASH_LEN: u64 = 32;

const WINNER_A: u64 = 0;
const WINNER_B: u64 = 1;
const WINNER_TIE: u64 = 2;

public struct PokerSession has key, store {
    id: UID,
    tunnel_id: ID,
    rules_hash: vector<u8>,
    protocol_version: u64,
    circuit_id: vector<u8>,
    input_schema_hash: vector<u8>,
    five_of_a_kind_enabled: bool,
    created_by: address,
}

public struct PokerSessionCreated has copy, drop {
    session_id: ID,
    tunnel_id: ID,
    circuit_id: vector<u8>,
    input_schema_hash: vector<u8>,
    created_by: address,
}

public fun protocol_version(): u64 { PROTOCOL_VERSION }

public fun winner_a(): u64 { WINNER_A }

public fun winner_b(): u64 { WINNER_B }

public fun winner_tie(): u64 { WINNER_TIE }

public fun create_session<T>(
    tunnel_obj: &tunnel::Tunnel<T>,
    rules_hash: vector<u8>,
    circuit_id: vector<u8>,
    input_schema_hash: vector<u8>,
    ctx: &mut TxContext,
): PokerSession {
    assert!(rules_hash.length() == HASH_LEN, EInvalidHash);
    assert!(input_schema_hash.length() == HASH_LEN, EInvalidHash);
    assert!(circuit_id.length() == HASH_LEN, EInvalidCircuit);

    let sender = ctx.sender();
    let party_a = tunnel::party_address(tunnel::party_a(tunnel_obj));
    let party_b = tunnel::party_address(tunnel::party_b(tunnel_obj));
    assert!(sender == party_a || sender == party_b, ENotParty);

    let session = PokerSession {
        id: object::new(ctx),
        tunnel_id: tunnel::id(tunnel_obj),
        rules_hash,
        protocol_version: PROTOCOL_VERSION,
        circuit_id,
        input_schema_hash,
        five_of_a_kind_enabled: true,
        created_by: sender,
    };

    event::emit(PokerSessionCreated {
        session_id: object::id(&session),
        tunnel_id: session.tunnel_id,
        circuit_id: session.circuit_id,
        input_schema_hash: session.input_schema_hash,
        created_by: sender,
    });

    session
}

#[allow(lint(share_owned))]
entry fun entry_create_session<T>(
    tunnel_obj: &tunnel::Tunnel<T>,
    rules_hash: vector<u8>,
    circuit_id: vector<u8>,
    input_schema_hash: vector<u8>,
    ctx: &mut TxContext,
) {
    let session = create_session(tunnel_obj, rules_hash, circuit_id, input_schema_hash, ctx);
    transfer::share_object(session);
}

public fun session_tunnel_id(session: &PokerSession): ID { session.tunnel_id }

public fun session_rules_hash(session: &PokerSession): &vector<u8> {
    &session.rules_hash
}

public fun session_protocol_version(session: &PokerSession): u64 {
    session.protocol_version
}

public fun session_circuit_id(session: &PokerSession): &vector<u8> {
    &session.circuit_id
}

public fun session_input_schema_hash(session: &PokerSession): &vector<u8> {
    &session.input_schema_hash
}

public fun session_five_of_a_kind_enabled(session: &PokerSession): bool {
    session.five_of_a_kind_enabled
}

public fun session_created_by(session: &PokerSession): address {
    session.created_by
}

#[test_only]
public fun destroy_for_testing(session: PokerSession) {
    let PokerSession { id, .. } = session;
    id.delete();
}
