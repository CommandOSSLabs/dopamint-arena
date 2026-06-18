/// Example: Private Negotiation (Privacy Benefit)
///
/// Demonstrates how tunnels keep intermediate states private. A buyer and
/// seller negotiate a deal price through multiple rounds of offers and
/// counteroffers — all off-chain and invisible to anyone watching the
/// blockchain.
///
/// **Without tunnels:** Every offer/counteroffer = on-chain tx = publicly visible
/// **With tunnels:**    Only the final agreed price appears on-chain
///
/// Intermediate negotiation rounds (offers, rejections, counteroffers) stay
/// completely private between the two parties.
///
/// ## Flow:
/// ```
/// open_negotiation() -> join_negotiation() ->
///   [off-chain: private offers/counteroffers] ->
///   settle_deal()  OR  cancel_negotiation()
/// ```
module sui_tunnel::example_private_negotiation;

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

// ============================================
// CONSTANTS
// ============================================

const NEGOTIATION_ACTIVE: u8 = 0;
const NEGOTIATION_SETTLED: u8 = 1;
const NEGOTIATION_CANCELLED: u8 = 2;
const NEGOTIATION_DISPUTED: u8 = 3;
const NEGOTIATION_FORCE_CLOSED: u8 = 4;

const DEFAULT_TIMEOUT_MS: u64 = 86400000; // 24 hours

// ============================================
// STRUCTS
// ============================================

/// Off-chain negotiation state — tracks rounds and agreement status.
/// All intermediate offers stay private; only the final state is settled.
public struct NegotiationState has copy, drop, store {
    /// Number of negotiation rounds completed
    rounds: u64,
    /// The last agreed/proposed price (0 = no agreement yet)
    latest_price: u64,
    /// Whether both parties have agreed (true = deal reached)
    deal_reached: bool,
    /// State nonce
    nonce: u64,
}

/// A private negotiation channel wrapping a Tunnel.
/// Buyer (party A) deposits earnest money.
/// Seller (party B) deposits collateral.
/// Negotiation happens off-chain (private).
public struct NegotiationChannel<phantom T> has key, store {
    id: UID,
    /// The underlying tunnel
    tunnel: Tunnel<T>,
    /// Negotiation status
    status: u8,
    /// Latest negotiation state
    latest_state: NegotiationState,
    /// Item being negotiated
    item_description: vector<u8>,
    /// Seller's asking price (public starting point)
    asking_price: u64,
}

// ============================================
// EVENTS
// ============================================

public struct NegotiationOpened has copy, drop {
    buyer: address,
    seller: address,
    asking_price: u64,
    buyer_deposit: u64,
}

/// Only the final deal price is visible on-chain — not intermediate offers.
public struct DealSettled has copy, drop {
    final_price: u64,
    negotiation_rounds: u64,
    buyer_payout: u64,
    seller_payout: u64,
}

public struct NegotiationCancelled has copy, drop {
    rounds_completed: u64,
}

// ============================================
// CONSTANT GETTERS
// ============================================

public fun negotiation_active(): u8 { NEGOTIATION_ACTIVE }

public fun negotiation_settled(): u8 { NEGOTIATION_SETTLED }

public fun negotiation_cancelled(): u8 { NEGOTIATION_CANCELLED }

public fun negotiation_disputed(): u8 { NEGOTIATION_DISPUTED }

public fun negotiation_force_closed(): u8 { NEGOTIATION_FORCE_CLOSED }

// ============================================
// NEGOTIATION LIFECYCLE
// ============================================

/// Buyer opens a negotiation channel with an earnest money deposit.
/// The asking price is public, but all subsequent negotiation is private.
public fun open_negotiation<T>(
    buyer_address: address,
    buyer_pk: vector<u8>,
    seller_address: address,
    seller_pk: vector<u8>,
    earnest_deposit: Coin<T>,
    item_description: vector<u8>,
    asking_price: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): NegotiationChannel<T> {
    assert!(asking_price > 0, EInvalidParameter);

    let deposit_amount = earnest_deposit.value();

    let mut tun = tunnel::create<T>(
        buyer_address,
        buyer_pk,
        signature::ed25519(),
        seller_address,
        seller_pk,
        signature::ed25519(),
        DEFAULT_TIMEOUT_MS,
        0,
        clock,
        ctx,
    );

    tun.deposit_party_a(earnest_deposit, clock, ctx);

    event::emit(NegotiationOpened {
        buyer: buyer_address,
        seller: seller_address,
        asking_price,
        buyer_deposit: deposit_amount,
    });

    NegotiationChannel {
        id: object::new(ctx),
        tunnel: tun,
        status: NEGOTIATION_ACTIVE,
        latest_state: NegotiationState {
            rounds: 0,
            latest_price: 0,
            deal_reached: false,
            nonce: 0,
        },
        item_description,
        asking_price,
    }
}

/// Seller joins the negotiation with collateral.
public fun join_negotiation<T>(
    channel: &mut NegotiationChannel<T>,
    collateral: Coin<T>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(channel.status == NEGOTIATION_ACTIVE, EInvalidState);
    channel.tunnel.deposit_party_b(collateral, clock, ctx);
}

// ============================================
// NEGOTIATION ROUNDS (OFF-CHAIN)
// ============================================

/// Compute the state hash for a negotiation round.
/// Both parties sign this after each offer/counteroffer.
///
/// **Privacy benefit:** This hash reveals nothing about the actual offers.
/// The offers themselves are only known to the two parties.
public fun compute_round_hash<T>(
    channel: &NegotiationChannel<T>,
    rounds: u64,
    latest_price: u64,
    deal_reached: bool,
    nonce: u64,
): vector<u8> {
    compute_round_hash_with_id(
        channel.tunnel.id(),
        rounds,
        latest_price,
        deal_reached,
        nonce,
    )
}

/// Compute round hash from tunnel ID (avoids double-borrow).
public fun compute_round_hash_with_id(
    tunnel_id: ID,
    rounds: u64,
    latest_price: u64,
    deal_reached: bool,
    nonce: u64,
): vector<u8> {
    let mut data = b"negotiation::round";
    data.append(tunnel_id.to_bytes());
    data.append(signature::u64_to_be_bytes(rounds));
    data.append(signature::u64_to_be_bytes(latest_price));
    data.push_back(if (deal_reached) { 1 } else { 0 });
    data.append(signature::u64_to_be_bytes(nonce));
    hash::blake2b256(&data)
}

/// Record a negotiation round on-chain (optional checkpoint).
/// In practice, all offers/counteroffers happen off-chain (privately).
///
/// **Privacy benefit:** When used, this only reveals a hash — not the
/// actual offer amount. The price is embedded in the hash but not
/// readable by observers.
public fun record_round<T>(
    channel: &mut NegotiationChannel<T>,
    rounds: u64,
    latest_price: u64,
    deal_reached: bool,
    nonce: u64,
    party_a_balance: u64,
    party_b_balance: u64,
    timestamp: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    clock: &Clock,
) {
    assert!(channel.status == NEGOTIATION_ACTIVE, EInvalidState);
    assert!(nonce > channel.latest_state.nonce, EInvalidNonce);
    assert!(rounds >= channel.latest_state.rounds, EInvalidParameter);

    let state_hash = compute_round_hash_with_id(
        channel.tunnel.id(),
        rounds,
        latest_price,
        deal_reached,
        nonce,
    );

    channel.latest_state =
        NegotiationState {
            rounds,
            latest_price,
            deal_reached,
            nonce,
        };

    // Both signatures must be provided together, or both empty
    assert!(
        (sig_a.is_empty() && sig_b.is_empty()) || (!sig_a.is_empty() && !sig_b.is_empty()),
        EInvalidSignature,
    );

    if (!sig_a.is_empty()) {
        channel
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

/// Settle the deal at the agreed price.
/// Only the final price appears on-chain — not the negotiation history.
///
/// **Privacy benefit:** An observer sees "Deal settled at X" but has
/// no visibility into how many rounds it took, what the initial offers
/// were, or how the parties negotiated.
public fun settle_deal<T>(
    channel: &mut NegotiationChannel<T>,
    buyer_balance: u64,
    seller_balance: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    timestamp: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(channel.status == NEGOTIATION_ACTIVE, EInvalidState);

    channel
        .tunnel
        .close_cooperative_and_transfer(
            buyer_balance,
            seller_balance,
            sig_a,
            sig_b,
            timestamp,
            clock,
            ctx,
        );

    channel.status = NEGOTIATION_SETTLED;

    event::emit(DealSettled {
        final_price: channel.latest_state.latest_price,
        negotiation_rounds: channel.latest_state.rounds,
        buyer_payout: buyer_balance,
        seller_payout: seller_balance,
    });
}

/// Cancel the negotiation — both parties get their deposits back.
public fun cancel_negotiation<T>(
    channel: &mut NegotiationChannel<T>,
    buyer_balance: u64,
    seller_balance: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    timestamp: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(channel.status == NEGOTIATION_ACTIVE, EInvalidState);

    channel
        .tunnel
        .close_cooperative_and_transfer(
            buyer_balance,
            seller_balance,
            sig_a,
            sig_b,
            timestamp,
            clock,
            ctx,
        );

    channel.status = NEGOTIATION_CANCELLED;

    event::emit(NegotiationCancelled {
        rounds_completed: channel.latest_state.rounds,
    });
}

/// Raise a dispute.
public fun raise_dispute<T>(
    channel: &mut NegotiationChannel<T>,
    state_hash: vector<u8>,
    nonce: u64,
    party_a_balance: u64,
    party_b_balance: u64,
    timestamp: u64,
    other_party_sig: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(channel.status == NEGOTIATION_ACTIVE, EInvalidState);
    channel
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
    channel.status = NEGOTIATION_DISPUTED;
}

/// Force close after dispute timeout.
public fun force_close<T>(channel: &mut NegotiationChannel<T>, clock: &Clock, ctx: &mut TxContext) {
    assert!(channel.status == NEGOTIATION_DISPUTED, ENoActiveDispute);
    channel
        .tunnel
        .force_close_after_timeout(
            clock,
            ctx,
        );
    channel.status = NEGOTIATION_FORCE_CLOSED;
}

// ============================================
// ACCESSORS
// ============================================

public fun channel_status<T>(c: &NegotiationChannel<T>): u8 { c.status }

public fun channel_rounds<T>(c: &NegotiationChannel<T>): u64 { c.latest_state.rounds }

public fun channel_latest_price<T>(c: &NegotiationChannel<T>): u64 { c.latest_state.latest_price }

public fun channel_deal_reached<T>(c: &NegotiationChannel<T>): bool { c.latest_state.deal_reached }

public fun channel_nonce<T>(c: &NegotiationChannel<T>): u64 { c.latest_state.nonce }

public fun channel_item_description<T>(c: &NegotiationChannel<T>): &vector<u8> {
    &c.item_description
}

public fun channel_asking_price<T>(c: &NegotiationChannel<T>): u64 { c.asking_price }

public fun channel_tunnel<T>(c: &NegotiationChannel<T>): &Tunnel<T> { &c.tunnel }

public fun channel_total_balance<T>(c: &NegotiationChannel<T>): u64 {
    c.tunnel.total_balance()
}

public fun channel_latest_state<T>(c: &NegotiationChannel<T>): &NegotiationState {
    &c.latest_state
}

public fun negotiation_rounds(s: &NegotiationState): u64 { s.rounds }

public fun negotiation_latest_price(s: &NegotiationState): u64 { s.latest_price }

public fun negotiation_deal_reached(s: &NegotiationState): bool { s.deal_reached }

public fun negotiation_nonce(s: &NegotiationState): u64 { s.nonce }

// ============================================
// TEST HELPERS
// ============================================

#[test_only]
public fun destroy_channel_for_testing<T>(channel: NegotiationChannel<T>) {
    let NegotiationChannel { id, tunnel, .. } = channel;
    id.delete();
    tunnel.destroy_for_testing();
}

#[test_only]
public fun set_status_for_testing<T>(channel: &mut NegotiationChannel<T>, status: u8) {
    channel.status = status;
}

#[test_only]
public fun create_negotiation_state_for_testing(
    rounds: u64,
    latest_price: u64,
    deal_reached: bool,
    nonce: u64,
): NegotiationState {
    NegotiationState { rounds, latest_price, deal_reached, nonce }
}
