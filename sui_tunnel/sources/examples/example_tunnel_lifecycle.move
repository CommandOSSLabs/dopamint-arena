/// Example: Tunnel Lifecycle
///
/// Demonstrates the full lifecycle of the core `tunnel` module through a
/// micropayment session scenario. This example directly uses the tunnel
/// primitives to show how to:
///
/// 1. Create and fund a tunnel
/// 2. Build state commitments for off-chain updates
/// 3. Close cooperatively (happy path)
/// 4. Raise disputes and force-close (unhappy path)
///
/// ## Flow:
/// ```
/// open_session() -> deposit -> update_payment() (off-chain) ->
///   close_cooperative()  OR  raise_dispute() -> force_close()
/// ```
module sui_tunnel::example_tunnel_lifecycle;

use sui::clock::Clock;
use sui::coin::Coin;
use sui::event;
use sui::hash;
use sui_tunnel::signature;
use sui_tunnel::tunnel::{Self, Tunnel};

// === Error definitions (see sui_tunnel::errors for the canonical registry) ===

#[error]
const EInvalidState: vector<u8> = b"The operation is not allowed in the current state.";

#[error]
const EInvalidSignature: vector<u8> = b"Signature verification failed.";

#[error]
const EInvalidNonce: vector<u8> = b"The nonce is invalid; it must be strictly increasing.";

#[error]
const ENoActiveDispute: vector<u8> = b"There is no active dispute to act on.";

#[error]
const EInsufficientBalance: vector<u8> = b"Insufficient balance for this operation.";

// ============================================
// CONSTANTS
// ============================================

/// Session status: Active
const SESSION_ACTIVE: u8 = 0;

/// Session status: Closed cooperatively
const SESSION_CLOSED: u8 = 1;

/// Session status: Disputed
const SESSION_DISPUTED: u8 = 2;

/// Session status: Force-closed after timeout
const SESSION_FORCE_CLOSED: u8 = 3;

/// Default timeout for disputes: 1 hour
const DEFAULT_TIMEOUT_MS: u64 = 3600000;

// ============================================
// STRUCTS
// ============================================

/// Represents the off-chain micropayment state between two parties.
/// This is what gets hashed and committed to the tunnel.
public struct MicropaymentState has copy, drop, store {
    /// Running total paid from party A to party B
    total_a_to_b: u64,
    /// Running total paid from party B to party A
    total_b_to_a: u64,
    /// State nonce (monotonically increasing)
    nonce: u64,
    /// Arbitrary metadata (e.g. service description)
    memo: vector<u8>,
}

/// A micropayment session that wraps a Tunnel.
/// Tracks application-level state on top of the core tunnel.
public struct MicropaymentSession<phantom T> has key, store {
    id: UID,
    /// The underlying tunnel
    tunnel: Tunnel<T>,
    /// Current session status
    status: u8,
    /// Latest known micropayment state
    latest_state: MicropaymentState,
    /// Rate limit: minimum milliseconds between on-chain updates
    min_update_interval_ms: u64,
    /// Last on-chain update timestamp
    last_update_at: u64,
}

/// Receipt issued after a session closes
public struct SessionReceipt has key, store {
    id: UID,
    /// Final amount party A received
    party_a_received: u64,
    /// Final amount party B received
    party_b_received: u64,
    /// Final nonce at close
    final_nonce: u64,
    /// How the session ended
    close_method: u8,
}

// ============================================
// EVENTS
// ============================================

/// Emitted when a micropayment session is opened
public struct SessionOpened has copy, drop {
    party_a: address,
    party_b: address,
    timeout_ms: u64,
}

/// Emitted when party B joins a session
public struct SessionJoined has copy, drop {
    party_b: address,
    deposit_amount: u64,
}

/// Emitted when a session is closed cooperatively
public struct SessionClosed has copy, drop {
    party_a_received: u64,
    party_b_received: u64,
    final_nonce: u64,
}

/// Emitted when a dispute is raised on a session
public struct SessionDisputed has copy, drop {
    raised_by: address,
    nonce: u64,
}

// ============================================
// PUBLIC GETTER FUNCTIONS FOR CONSTANTS
// ============================================

public fun session_active(): u8 { SESSION_ACTIVE }

public fun session_closed(): u8 { SESSION_CLOSED }

public fun session_disputed(): u8 { SESSION_DISPUTED }

public fun session_force_closed(): u8 { SESSION_FORCE_CLOSED }

public fun default_timeout_ms(): u64 { DEFAULT_TIMEOUT_MS }

// ============================================
// SESSION LIFECYCLE FUNCTIONS
// ============================================

/// Opens a new micropayment session by creating a tunnel and depositing
/// funds for party A. Party B joins later with `join_session`.
///
/// ## Parameters
/// - `party_a_address`: Address of party A (the session initiator)
/// - `party_a_pk`: Public key of party A
/// - `party_b_address`: Address of party B
/// - `party_b_pk`: Public key of party B
/// - `deposit_a`: Coin deposited by party A
/// - `memo`: Session description
/// - `min_update_interval_ms`: Rate limit for on-chain updates
/// - `clock`: Clock for timestamps
/// - `ctx`: Transaction context
public fun open_session<T>(
    party_a_address: address,
    party_a_pk: vector<u8>,
    party_b_address: address,
    party_b_pk: vector<u8>,
    deposit_a: Coin<T>,
    memo: vector<u8>,
    min_update_interval_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): MicropaymentSession<T> {
    // Create the underlying tunnel using ED25519 for both parties
    let mut tun = tunnel::create<T>(
        party_a_address,
        party_a_pk,
        signature::ed25519(),
        party_b_address,
        party_b_pk,
        signature::ed25519(),
        DEFAULT_TIMEOUT_MS,
        0, // no penalty
        clock,
        ctx,
    );

    // Deposit for party A
    tun.deposit_party_a(deposit_a, clock, ctx);

    let now = clock.timestamp_ms();
    let initial_state = MicropaymentState {
        total_a_to_b: 0,
        total_b_to_a: 0,
        nonce: 0,
        memo,
    };

    event::emit(SessionOpened {
        party_a: party_a_address,
        party_b: party_b_address,
        timeout_ms: DEFAULT_TIMEOUT_MS,
    });

    MicropaymentSession {
        id: object::new(ctx),
        tunnel: tun,
        status: SESSION_ACTIVE,
        latest_state: initial_state,
        min_update_interval_ms,
        last_update_at: now,
    }
}

/// Creates a simple session with just party A's deposit (party B deposits later).
public fun create_session<T>(
    party_a_address: address,
    party_a_pk: vector<u8>,
    party_b_address: address,
    party_b_pk: vector<u8>,
    deposit_a: Coin<T>,
    memo: vector<u8>,
    timeout_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): MicropaymentSession<T> {
    let mut tun = tunnel::create<T>(
        party_a_address,
        party_a_pk,
        signature::ed25519(),
        party_b_address,
        party_b_pk,
        signature::ed25519(),
        timeout_ms,
        0,
        clock,
        ctx,
    );

    tun.deposit_party_a(deposit_a, clock, ctx);

    let now = clock.timestamp_ms();

    event::emit(SessionOpened {
        party_a: party_a_address,
        party_b: party_b_address,
        timeout_ms,
    });

    MicropaymentSession {
        id: object::new(ctx),
        tunnel: tun,
        status: SESSION_ACTIVE,
        latest_state: MicropaymentState {
            total_a_to_b: 0,
            total_b_to_a: 0,
            nonce: 0,
            memo,
        },
        min_update_interval_ms: 0,
        last_update_at: now,
    }
}

/// Party B joins by depositing into the session's tunnel.
public fun join_session<T>(
    session: &mut MicropaymentSession<T>,
    deposit_b: Coin<T>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(session.status == SESSION_ACTIVE, EInvalidState);
    let deposit_amount = deposit_b.value();
    session.tunnel.deposit_party_b(deposit_b, clock, ctx);

    event::emit(SessionJoined {
        party_b: session.tunnel.party_b().party_address(),
        deposit_amount,
    });
}

// ============================================
// STATE UPDATE FUNCTIONS
// ============================================

/// Builds a state commitment hash for an off-chain micropayment update.
/// Both parties sign this hash off-chain and exchange signatures.
///
/// ## Parameters
/// - `session`: The micropayment session
/// - `total_a_to_b`: Running total paid from A to B
/// - `total_b_to_a`: Running total paid from B to A
/// - `nonce`: New nonce (must be > current)
///
/// ## Returns
/// The state hash (blake2b256) to be signed by both parties
public fun build_state_commitment<T>(
    session: &MicropaymentSession<T>,
    total_a_to_b: u64,
    total_b_to_a: u64,
    nonce: u64,
): vector<u8> {
    assert!(session.status == SESSION_ACTIVE, EInvalidState);
    assert!(nonce > session.latest_state.nonce, EInvalidNonce);

    compute_state_hash(session.tunnel.id(), total_a_to_b, total_b_to_a, nonce)
}

/// Computes the state hash for a given tunnel ID and state parameters.
/// Extracted to avoid double-borrow on session when also updating the tunnel.
public fun compute_state_hash(
    tunnel_id: ID,
    total_a_to_b: u64,
    total_b_to_a: u64,
    nonce: u64,
): vector<u8> {
    let mut data = b"micropayment::state";
    data.append(tunnel_id.to_bytes());
    data.append(signature::u64_to_be_bytes(total_a_to_b));
    data.append(signature::u64_to_be_bytes(total_b_to_a));
    data.append(signature::u64_to_be_bytes(nonce));
    hash::blake2b256(&data)
}

/// Records a verified off-chain state update on-chain.
/// Also syncs the state to the underlying tunnel with dual signatures.
public fun record_state_update<T>(
    session: &mut MicropaymentSession<T>,
    total_a_to_b: u64,
    total_b_to_a: u64,
    nonce: u64,
    party_a_balance: u64,
    party_b_balance: u64,
    timestamp: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    clock: &Clock,
) {
    assert!(session.status == SESSION_ACTIVE, EInvalidState);
    assert!(nonce > session.latest_state.nonce, EInvalidNonce);

    let now = clock.timestamp_ms();

    // Enforce rate limiting
    if (session.min_update_interval_ms > 0) {
        assert!(now >= session.last_update_at + session.min_update_interval_ms, EInvalidState);
    };

    // Compute state hash before mutating session
    let state_hash = compute_state_hash(
        session.tunnel.id(),
        total_a_to_b,
        total_b_to_a,
        nonce,
    );

    session.latest_state =
        MicropaymentState {
            total_a_to_b,
            total_b_to_a,
            nonce,
            memo: session.latest_state.memo,
        };
    session.last_update_at = now;

    // Both signatures must be provided together, or both must be empty.
    // Partial signatures (one empty, one non-empty) are rejected to prevent
    // silently accepting unverified state updates.
    assert!(
        (sig_a.is_empty() && sig_b.is_empty()) || (!sig_a.is_empty() && !sig_b.is_empty()),
        EInvalidSignature,
    );

    // Sync state to the underlying tunnel when dual signatures are provided
    if (!sig_a.is_empty()) {
        session
            .tunnel
            .update_state(
                state_hash,
                nonce,
                party_a_balance,
                party_b_balance,
                timestamp,
                sig_a,
                sig_b,
                clock,
            );
    };
}

// ============================================
// SETTLEMENT FUNCTIONS
// ============================================

/// Closes the session cooperatively. Both parties agree on final balances
/// and sign the settlement.
///
/// This is the happy path: both parties agree, no dispute needed.
/// Closes the session cooperatively using the safe transfer variant.
/// Funds are transferred directly to each party via the underlying tunnel.
public fun close_cooperative<T>(
    session: &mut MicropaymentSession<T>,
    final_balance_a: u64,
    final_balance_b: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    timestamp: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): SessionReceipt {
    assert!(session.status == SESSION_ACTIVE, EInvalidState);

    session
        .tunnel
        .close_cooperative_and_transfer(
            final_balance_a,
            final_balance_b,
            sig_a,
            sig_b,
            timestamp,
            clock,
            ctx,
        );

    session.status = SESSION_CLOSED;

    event::emit(SessionClosed {
        party_a_received: final_balance_a,
        party_b_received: final_balance_b,
        final_nonce: session.latest_state.nonce,
    });

    SessionReceipt {
        id: object::new(ctx),
        party_a_received: final_balance_a,
        party_b_received: final_balance_b,
        final_nonce: session.latest_state.nonce,
        close_method: SESSION_CLOSED,
    }
}

/// Raises a dispute on the session. One party submits a signed state
/// that the other party signed, proving disagreement.
public fun raise_dispute<T>(
    session: &mut MicropaymentSession<T>,
    state_hash: vector<u8>,
    nonce: u64,
    party_a_balance: u64,
    party_b_balance: u64,
    timestamp: u64,
    other_party_sig: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(session.status == SESSION_ACTIVE, EInvalidState);

    session
        .tunnel
        .raise_dispute(
            state_hash,
            nonce,
            party_a_balance,
            party_b_balance,
            timestamp,
            other_party_sig,
            clock,
            ctx,
        );

    session.status = SESSION_DISPUTED;

    event::emit(SessionDisputed {
        raised_by: ctx.sender(),
        nonce,
    });
}

/// Force-closes the session after the dispute timeout has passed.
/// Funds are transferred directly to each party to prevent PTB interception.
public fun force_close<T>(
    session: &mut MicropaymentSession<T>,
    clock: &Clock,
    ctx: &mut TxContext,
): SessionReceipt {
    assert!(session.status == SESSION_DISPUTED, ENoActiveDispute);

    // Read stored balances before force_close transfers them
    let party_a_received = session.tunnel.state().state_party_a_balance();
    let party_b_received = session.tunnel.state().state_party_b_balance();
    let final_nonce = session.tunnel.state().state_nonce();

    // force_close_after_timeout uses stored state balances for distribution
    session
        .tunnel
        .force_close_after_timeout(
            clock,
            ctx,
        );

    session.status = SESSION_FORCE_CLOSED;

    SessionReceipt {
        id: object::new(ctx),
        party_a_received,
        party_b_received,
        final_nonce,
        close_method: SESSION_FORCE_CLOSED,
    }
}

/// Calculates the final balances based on deposits and payment totals.
/// party_a_final = deposit_a + total_b_to_a - total_a_to_b
/// party_b_final = deposit_b + total_a_to_b - total_b_to_a
public fun calculate_final_balances(
    deposit_a: u64,
    deposit_b: u64,
    total_a_to_b: u64,
    total_b_to_a: u64,
): (u64, u64) {
    // Ensure payments don't exceed deposits
    assert!(total_a_to_b <= deposit_a + total_b_to_a, EInsufficientBalance);
    assert!(total_b_to_a <= deposit_b + total_a_to_b, EInsufficientBalance);

    let final_a = deposit_a + total_b_to_a - total_a_to_b;
    let final_b = deposit_b + total_a_to_b - total_b_to_a;

    (final_a, final_b)
}

// ============================================
// ACCESSOR FUNCTIONS
// ============================================

/// Get the session status
public fun session_status<T>(session: &MicropaymentSession<T>): u8 {
    session.status
}

/// Get a reference to the underlying tunnel
public fun session_tunnel<T>(session: &MicropaymentSession<T>): &Tunnel<T> {
    &session.tunnel
}

/// Get the tunnel status through the session
public fun tunnel_status<T>(session: &MicropaymentSession<T>): u8 {
    session.tunnel.status()
}

/// Get the total balance locked in the session
public fun session_total_balance<T>(session: &MicropaymentSession<T>): u64 {
    session.tunnel.total_balance()
}

/// Get the latest micropayment state
public fun session_latest_state<T>(session: &MicropaymentSession<T>): &MicropaymentState {
    &session.latest_state
}

/// Get the latest nonce
public fun session_nonce<T>(session: &MicropaymentSession<T>): u64 {
    session.latest_state.nonce
}

/// Get the total paid from A to B
public fun state_total_a_to_b(state: &MicropaymentState): u64 {
    state.total_a_to_b
}

/// Get the total paid from B to A
public fun state_total_b_to_a(state: &MicropaymentState): u64 {
    state.total_b_to_a
}

/// Get the state nonce
public fun state_nonce(state: &MicropaymentState): u64 {
    state.nonce
}

/// Get the state memo
public fun state_memo(state: &MicropaymentState): &vector<u8> {
    &state.memo
}

/// Get receipt party A amount
public fun receipt_party_a_received(receipt: &SessionReceipt): u64 {
    receipt.party_a_received
}

/// Get receipt party B amount
public fun receipt_party_b_received(receipt: &SessionReceipt): u64 {
    receipt.party_b_received
}

/// Get receipt final nonce
public fun receipt_final_nonce(receipt: &SessionReceipt): u64 {
    receipt.final_nonce
}

/// Get receipt close method
public fun receipt_close_method(receipt: &SessionReceipt): u8 {
    receipt.close_method
}

/// Check if the tunnel is active
public fun is_tunnel_active<T>(session: &MicropaymentSession<T>): bool {
    session.tunnel.is_active()
}

/// Check if the tunnel is disputed
public fun is_tunnel_disputed<T>(session: &MicropaymentSession<T>): bool {
    session.tunnel.is_disputed()
}

/// Check if the tunnel can be force-closed
public fun can_force_close<T>(session: &MicropaymentSession<T>, clock: &Clock): bool {
    session.tunnel.is_disputed() &&
        session.tunnel.can_claim_timeout(clock)
}

// ============================================
// TEST HELPERS
// ============================================

#[test_only]
public fun destroy_session_for_testing<T>(session: MicropaymentSession<T>) {
    let MicropaymentSession {
        id,
        tunnel,
        ..,
    } = session;
    id.delete();
    tunnel.destroy_for_testing();
}

#[test_only]
public fun destroy_receipt_for_testing(receipt: SessionReceipt) {
    let SessionReceipt {
        id,
        ..,
    } = receipt;
    id.delete();
}

#[test_only]
public fun create_micropayment_state_for_testing(
    total_a_to_b: u64,
    total_b_to_a: u64,
    nonce: u64,
    memo: vector<u8>,
): MicropaymentState {
    MicropaymentState { total_a_to_b, total_b_to_a, nonce, memo }
}

#[test_only]
public fun create_session_receipt_for_testing(
    party_a_received: u64,
    party_b_received: u64,
    final_nonce: u64,
    close_method: u8,
    ctx: &mut TxContext,
): SessionReceipt {
    SessionReceipt {
        id: object::new(ctx),
        party_a_received,
        party_b_received,
        final_nonce,
        close_method,
    }
}

#[test_only]
public fun create_session_with_rate_limit_for_testing<T>(
    party_a_address: address,
    party_a_public_key: vector<u8>,
    party_b_address: address,
    party_b_public_key: vector<u8>,
    deposit: sui::coin::Coin<T>,
    memo: vector<u8>,
    timeout_ms: u64,
    min_update_interval_ms: u64,
    clock: &sui::clock::Clock,
    ctx: &mut TxContext,
): MicropaymentSession<T> {
    let mut tun = tunnel::create<T>(
        party_a_address,
        party_a_public_key,
        signature::ed25519(),
        party_b_address,
        party_b_public_key,
        signature::ed25519(),
        timeout_ms,
        0,
        clock,
        ctx,
    );
    tun.deposit_party_a(deposit, clock, ctx);
    MicropaymentSession {
        id: object::new(ctx),
        tunnel: tun,
        status: SESSION_ACTIVE,
        latest_state: MicropaymentState {
            total_a_to_b: 0,
            total_b_to_a: 0,
            nonce: 0,
            memo,
        },
        min_update_interval_ms,
        last_update_at: 0,
    }
}

#[test_only]
public fun set_status_for_testing<T>(session: &mut MicropaymentSession<T>, status: u8) {
    session.status = status;
}
