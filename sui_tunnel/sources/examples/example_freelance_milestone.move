/// Example: Freelance Milestones (Safety Benefit)
///
/// Demonstrates how the tunnel's dispute mechanism protects both parties
/// in a freelance contract. The client deposits the full project budget
/// into a tunnel. As the freelancer completes milestones, both parties
/// sign state updates acknowledging the work. If the client tries to
/// settle with an outdated state (before milestones were completed),
/// the freelancer can raise a dispute with a newer signed state.
///
/// **Without tunnels:** Trust required — client could refuse to pay,
///   or freelancer could claim unearned payment
/// **With tunnels:** Cryptographic safety — disputes are resolved by
///   submitting the most recent mutually-signed state
///
/// ## Safety Guarantees:
/// - Freelancer can always prove completed work via signed state updates
/// - Client can't retroactively deny milestone completion
/// - Dispute mechanism enforces the latest agreed-upon state
///
/// ## Flow:
/// ```
/// create_contract() -> join_as_freelancer() ->
///   [off-chain: milestone completions, both sign] ->
///   close_contract()  OR  raise_dispute() -> force_close()
/// ```
module sui_tunnel::example_freelance_milestone;

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
const EInvalidParameter: vector<u8> = b"A required parameter is missing or invalid.";

#[error]
const EInvalidSignature: vector<u8> = b"Signature verification failed.";

#[error]
const EInvalidNonce: vector<u8> = b"The nonce is invalid; it must be strictly increasing.";

#[error]
const ENoActiveDispute: vector<u8> = b"There is no active dispute to act on.";

#[error]
const EInsufficientBalance: vector<u8> = b"Insufficient balance for this operation.";

#[error]
const EOverflow: vector<u8> = b"The operation would cause an arithmetic overflow.";

// ============================================
// CONSTANTS
// ============================================

const CONTRACT_ACTIVE: u8 = 0;
const CONTRACT_COMPLETED: u8 = 1;
const CONTRACT_DISPUTED: u8 = 2;
const CONTRACT_FORCE_CLOSED: u8 = 3;
const CONTRACT_CANCELLED: u8 = 4;

const DEFAULT_TIMEOUT_MS: u64 = 604800000; // 7 days

// ============================================
// STRUCTS
// ============================================

/// Off-chain milestone tracking state.
/// Both parties sign this after each milestone is verified.
public struct MilestoneState has copy, drop, store {
    /// Total number of milestones in the contract
    total_milestones: u64,
    /// Number of milestones completed and verified
    completed_milestones: u64,
    /// Payment amount per milestone
    amount_per_milestone: u64,
    /// Total amount earned so far
    total_earned: u64,
    /// State nonce
    nonce: u64,
}

/// A freelance contract wrapping a Tunnel.
/// Client (party A) deposits the full project budget.
/// Freelancer (party B) earns payment per completed milestone.
///
/// **Safety benefit:** The freelancer's completed work is protected
/// by signed state updates. If the client tries to cheat, the
/// freelancer can dispute with cryptographic proof.
public struct FreelanceContract<phantom T> has key, store {
    id: UID,
    /// The underlying tunnel
    tunnel: Tunnel<T>,
    /// Contract status
    status: u8,
    /// Latest milestone state
    latest_state: MilestoneState,
    /// Project description
    project_description: vector<u8>,
}

// ============================================
// EVENTS
// ============================================

public struct ContractCreated has copy, drop {
    client: address,
    freelancer: address,
    total_milestones: u64,
    amount_per_milestone: u64,
    total_budget: u64,
}

public struct ContractCompleted has copy, drop {
    milestones_completed: u64,
    total_earned: u64,
    freelancer_payout: u64,
    client_refund: u64,
}

public struct ContractDisputed has copy, drop {
    raised_by: address,
    at_milestone: u64,
}

// ============================================
// CONSTANT GETTERS
// ============================================

public fun contract_active(): u8 { CONTRACT_ACTIVE }

public fun contract_completed(): u8 { CONTRACT_COMPLETED }

public fun contract_disputed(): u8 { CONTRACT_DISPUTED }

public fun contract_force_closed(): u8 { CONTRACT_FORCE_CLOSED }

public fun contract_cancelled(): u8 { CONTRACT_CANCELLED }

public fun default_timeout_ms(): u64 { DEFAULT_TIMEOUT_MS }

// ============================================
// CONTRACT LIFECYCLE
// ============================================

/// Client creates a freelance contract and deposits the full project budget.
/// The budget is divided into equal milestone payments.
///
/// ## Parameters
/// - `total_milestones`: Number of milestones in the project
/// - `amount_per_milestone`: Payment for each completed milestone
/// - `budget`: Full project budget (must equal total_milestones * amount_per_milestone)
public fun create_contract<T>(
    client_address: address,
    client_pk: vector<u8>,
    freelancer_address: address,
    freelancer_pk: vector<u8>,
    budget: Coin<T>,
    total_milestones: u64,
    amount_per_milestone: u64,
    project_description: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
): FreelanceContract<T> {
    assert!(total_milestones > 0, EInvalidParameter);
    assert!(amount_per_milestone > 0, EInvalidParameter);

    let budget_amount = budget.value();
    let required_budget = (total_milestones as u128) * (amount_per_milestone as u128);
    assert!(required_budget <= std::u64::max_value!() as u128, EOverflow);
    assert!(budget_amount >= (required_budget as u64), EInsufficientBalance);

    let mut tun = tunnel::create<T>(
        client_address,
        client_pk,
        signature::ed25519(),
        freelancer_address,
        freelancer_pk,
        signature::ed25519(),
        DEFAULT_TIMEOUT_MS,
        0,
        clock,
        ctx,
    );

    tun.deposit_party_a(budget, clock, ctx);

    event::emit(ContractCreated {
        client: client_address,
        freelancer: freelancer_address,
        total_milestones,
        amount_per_milestone,
        total_budget: budget_amount,
    });

    FreelanceContract {
        id: object::new(ctx),
        tunnel: tun,
        status: CONTRACT_ACTIVE,
        latest_state: MilestoneState {
            total_milestones,
            completed_milestones: 0,
            amount_per_milestone,
            total_earned: 0,
            nonce: 0,
        },
        project_description,
    }
}

/// Freelancer joins the contract with a small good-faith deposit.
public fun join_as_freelancer<T>(
    contract: &mut FreelanceContract<T>,
    deposit: Coin<T>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(contract.status == CONTRACT_ACTIVE, EInvalidState);
    contract.tunnel.deposit_party_b(deposit, clock, ctx);
}

// ============================================
// MILESTONE TRACKING
// ============================================

/// Compute the state hash for a milestone completion.
/// Both parties sign this after verifying each milestone.
///
/// **Safety benefit:** This signed hash is the freelancer's proof of
/// completed work. Even if the client becomes unresponsive, the
/// freelancer can use this to dispute and claim earned payment.
public fun compute_milestone_hash<T>(
    contract: &FreelanceContract<T>,
    completed_milestones: u64,
    total_earned: u64,
    nonce: u64,
): vector<u8> {
    compute_milestone_hash_with_id(
        contract.tunnel.id(),
        contract.latest_state.total_milestones,
        completed_milestones,
        contract.latest_state.amount_per_milestone,
        total_earned,
        nonce,
    )
}

/// Compute milestone hash from tunnel ID (avoids double-borrow).
public fun compute_milestone_hash_with_id(
    tunnel_id: ID,
    total_milestones: u64,
    completed_milestones: u64,
    amount_per_milestone: u64,
    total_earned: u64,
    nonce: u64,
): vector<u8> {
    let expected_earned = (completed_milestones as u128) * (amount_per_milestone as u128);
    assert!(expected_earned == (total_earned as u128), EInvalidParameter);

    let mut data = b"freelance::milestone";
    data.append(tunnel_id.to_bytes());
    data.append(signature::u64_to_be_bytes(total_milestones));
    data.append(signature::u64_to_be_bytes(completed_milestones));
    data.append(signature::u64_to_be_bytes(amount_per_milestone));
    data.append(signature::u64_to_be_bytes(total_earned));
    data.append(signature::u64_to_be_bytes(nonce));
    hash::blake2b256(&data)
}

/// Record a milestone completion on-chain (optional checkpoint).
/// The freelancer should checkpoint periodically for safety.
///
/// **Safety benefit:** Each checkpoint anchors the freelancer's
/// earnings on-chain. If the client disappears, the freelancer
/// can dispute from the last checkpoint.
public fun record_milestone<T>(
    contract: &mut FreelanceContract<T>,
    completed_milestones: u64,
    nonce: u64,
    party_a_balance: u64,
    party_b_balance: u64,
    timestamp: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    clock: &Clock,
) {
    assert!(contract.status == CONTRACT_ACTIVE, EInvalidState);
    assert!(nonce > contract.latest_state.nonce, EInvalidNonce);
    assert!(completed_milestones > contract.latest_state.completed_milestones, EInvalidParameter);
    assert!(completed_milestones <= contract.latest_state.total_milestones, EInvalidParameter);

    let earned =
        (completed_milestones as u128) * (contract.latest_state.amount_per_milestone as u128);
    assert!(earned <= std::u64::max_value!() as u128, EOverflow);
    let total_earned = earned as u64;

    // Ensure earned amount doesn't exceed available funds
    assert!(total_earned <= contract.tunnel.total_balance(), EInsufficientBalance);

    let state_hash = compute_milestone_hash_with_id(
        contract.tunnel.id(),
        contract.latest_state.total_milestones,
        completed_milestones,
        contract.latest_state.amount_per_milestone,
        total_earned,
        nonce,
    );

    contract.latest_state.completed_milestones = completed_milestones;
    contract.latest_state.total_earned = total_earned;
    contract.latest_state.nonce = nonce;

    // Both signatures must be provided together, or both empty
    assert!(
        (sig_a.is_empty() && sig_b.is_empty()) || (!sig_a.is_empty() && !sig_b.is_empty()),
        EInvalidSignature,
    );

    if (!sig_a.is_empty()) {
        contract
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
// SETTLEMENT
// ============================================

/// Calculate final payment split based on completed milestones.
/// Client gets back unearned budget + their share.
/// Freelancer gets earned milestone payments.
public fun calculate_settlement<T>(contract: &FreelanceContract<T>): (u64, u64) {
    let total = contract.tunnel.total_balance();
    let freelancer_earned = contract.latest_state.total_earned;
    assert!(freelancer_earned <= total, EInsufficientBalance);
    let client_refund = total - freelancer_earned;
    (client_refund, freelancer_earned)
}

/// Close the contract cooperatively.
/// Both parties agree on the final milestone count and payment split.
public fun close_contract<T>(
    contract: &mut FreelanceContract<T>,
    client_balance: u64,
    freelancer_balance: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    timestamp: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(contract.status == CONTRACT_ACTIVE, EInvalidState);

    contract
        .tunnel
        .close_cooperative_and_transfer(
            client_balance,
            freelancer_balance,
            sig_a,
            sig_b,
            timestamp,
            clock,
            ctx,
        );

    contract.status = CONTRACT_COMPLETED;

    event::emit(ContractCompleted {
        milestones_completed: contract.latest_state.completed_milestones,
        total_earned: contract.latest_state.total_earned,
        freelancer_payout: freelancer_balance,
        client_refund: client_balance,
    });
}

/// Cancel the contract — both parties get deposits back.
public fun cancel_contract<T>(
    contract: &mut FreelanceContract<T>,
    client_balance: u64,
    freelancer_balance: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    timestamp: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(contract.status == CONTRACT_ACTIVE, EInvalidState);

    contract
        .tunnel
        .close_cooperative_and_transfer(
            client_balance,
            freelancer_balance,
            sig_a,
            sig_b,
            timestamp,
            clock,
            ctx,
        );

    contract.status = CONTRACT_CANCELLED;
}

/// Reclaim the full budget to the client before the freelancer joins. Returns the coin so
/// the client can route it in a PTB. Reuses the tunnel's pre-activation withdrawal, so only
/// the client (the sole depositor) can reclaim and only while the freelancer's deposit is
/// still zero. Aborts `EInvalidState` if the contract is no longer active.
public fun reclaim_budget_before_join<T>(
    contract: &mut FreelanceContract<T>,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<T> {
    assert!(contract.status == CONTRACT_ACTIVE, EInvalidState);
    contract.status = CONTRACT_CANCELLED;
    contract.tunnel.withdraw_before_active(clock, ctx)
}

/// Raise a dispute — the freelancer proves completed work.
///
/// **Safety benefit:** If the client tries to close the contract
/// with a stale state (claiming fewer milestones were completed),
/// the freelancer submits a newer state signed by the client,
/// proving the milestones were actually completed and acknowledged.
public fun raise_dispute<T>(
    contract: &mut FreelanceContract<T>,
    state_hash: vector<u8>,
    nonce: u64,
    party_a_balance: u64,
    party_b_balance: u64,
    timestamp: u64,
    other_party_sig: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(contract.status == CONTRACT_ACTIVE, EInvalidState);

    let sender = ctx.sender();
    contract
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

    contract.status = CONTRACT_DISPUTED;

    event::emit(ContractDisputed {
        raised_by: sender,
        at_milestone: contract.latest_state.completed_milestones,
    });
}

/// Force close after dispute timeout.
/// The dispute raiser sets the final balance split, ensuring the
/// freelancer gets paid for completed work.
public fun force_close<T>(contract: &mut FreelanceContract<T>, clock: &Clock, ctx: &mut TxContext) {
    assert!(contract.status == CONTRACT_DISPUTED, ENoActiveDispute);
    contract
        .tunnel
        .force_close_after_timeout(
            clock,
            ctx,
        );
    contract.status = CONTRACT_FORCE_CLOSED;
}

// ============================================
// ACCESSORS
// ============================================

public fun contract_status<T>(c: &FreelanceContract<T>): u8 { c.status }

public fun contract_total_milestones<T>(c: &FreelanceContract<T>): u64 {
    c.latest_state.total_milestones
}

public fun contract_completed_milestones<T>(c: &FreelanceContract<T>): u64 {
    c.latest_state.completed_milestones
}

public fun contract_amount_per_milestone<T>(c: &FreelanceContract<T>): u64 {
    c.latest_state.amount_per_milestone
}

public fun contract_total_earned<T>(c: &FreelanceContract<T>): u64 {
    c.latest_state.total_earned
}

public fun contract_nonce<T>(c: &FreelanceContract<T>): u64 { c.latest_state.nonce }

public fun contract_project_description<T>(c: &FreelanceContract<T>): &vector<u8> {
    &c.project_description
}

public fun contract_tunnel<T>(c: &FreelanceContract<T>): &Tunnel<T> { &c.tunnel }

public fun contract_total_balance<T>(c: &FreelanceContract<T>): u64 {
    c.tunnel.total_balance()
}

public fun contract_latest_state<T>(c: &FreelanceContract<T>): &MilestoneState {
    &c.latest_state
}

public fun milestone_total(s: &MilestoneState): u64 { s.total_milestones }

public fun milestone_completed(s: &MilestoneState): u64 { s.completed_milestones }

public fun milestone_amount_per(s: &MilestoneState): u64 { s.amount_per_milestone }

public fun milestone_total_earned(s: &MilestoneState): u64 { s.total_earned }

public fun milestone_nonce(s: &MilestoneState): u64 { s.nonce }

// ============================================
// TEST HELPERS
// ============================================

#[test_only]
public fun destroy_contract_for_testing<T>(contract: FreelanceContract<T>) {
    let FreelanceContract {
        id,
        tunnel,
        ..,
    } = contract;
    id.delete();
    tunnel.destroy_for_testing();
}

#[test_only]
public fun set_status_for_testing<T>(contract: &mut FreelanceContract<T>, status: u8) {
    contract.status = status;
}

#[test_only]
public fun create_milestone_state_for_testing(
    total_milestones: u64,
    completed_milestones: u64,
    amount_per_milestone: u64,
    total_earned: u64,
    nonce: u64,
): MilestoneState {
    MilestoneState {
        total_milestones,
        completed_milestones,
        amount_per_milestone,
        total_earned,
        nonce,
    }
}
