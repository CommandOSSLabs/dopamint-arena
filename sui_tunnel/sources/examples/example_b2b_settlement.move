/// Example: B2B Settlement
///
/// Conditional business-to-business settlement where a buyer and seller lock funds
/// in a real `Tunnel<T>` and a neutral arbiter (the tunnel's referee) attests a typed
/// result that deterministically maps to the on-chain payout.
///
/// ## Flow:
/// 1. `create_settlement` — buyer funds party A and assigns the arbiter as referee.
/// 2. `seller_join` — seller funds party B, activating the tunnel.
/// 3. Either `settle_cooperatively` (both signed) or `open_dispute` then
///    `arbiter_resolve` (the arbiter attests a result and moves the funds).
/// 4. `force_close` — trust-minimized fallback if the arbiter never resolves.
///
/// ## Key Features:
/// - Held funds live inside a real funded tunnel, so a neutral arbiter can actually move them.
/// - The arbiter's typed result code deterministically maps to the buyer/seller split.
/// - All fund-movement security (balance-sum invariant, referee authorization, timeout exit)
///   is enforced inside the tunnel, not re-implemented here.
module sui_tunnel::example_b2b_settlement;

use sui::clock::Clock;
use sui::coin::Coin;
use sui::event;
use sui_tunnel::signature;
use sui_tunnel::tunnel::{Self, Tunnel};

// === Error definitions (see sui_tunnel::errors for the canonical registry) ===

#[error]
const EInvalidState: vector<u8> = b"The operation is not allowed in the current state.";

#[error]
const EInvalidParameter: vector<u8> = b"A required parameter is missing or invalid.";

#[error]
const EInvalidHash: vector<u8> = b"The hash value is invalid or has the wrong format.";

#[error]
const EInvalidParties: vector<u8> = b"The tunnel parties are invalid (for example, both parties share the same address).";

#[error]
const EInvalidPublicKey: vector<u8> = b"The public key is invalid or has the wrong length for its scheme.";

#[error]
const EInvalidDepositAmount: vector<u8> = b"The deposit amount is invalid.";

#[error]
const EBalanceSumMismatch: vector<u8> = b"The party balances do not sum to the total tunnel balance.";

// ============================================
// CONSTANTS
// ============================================

/// Settlement status: buyer funded, awaiting the seller.
const STATUS_FUNDED: u8 = 0;

/// Settlement status: both parties funded, tunnel active.
const STATUS_ACTIVE: u8 = 1;

/// Settlement status: escalated on-chain, awaiting arbiter.
const STATUS_DISPUTED: u8 = 2;

/// Settlement status: settled and funds transferred.
const STATUS_RESOLVED: u8 = 3;

/// Settlement status: closed via the tunnel timeout fallback.
const STATUS_FORCE_CLOSED: u8 = 4;

/// Settlement status: buyer reclaimed the deposit before the seller funded.
const STATUS_CANCELLED: u8 = 5;

/// Result code: pay the full balance to the seller.
const RESULT_PAY_SELLER: u8 = 0;

/// Result code: refund the full balance to the buyer.
const RESULT_REFUND_BUYER: u8 = 1;

/// Result code: split the balance per the arbiter's seller share.
const RESULT_SPLIT: u8 = 2;

/// Expected length of every 32-byte hash.
const HASH_LENGTH: u64 = 32;

/// Default arbiter response window in milliseconds (1 hour).
const SETTLEMENT_TIMEOUT_MS: u64 = 3600000;

// ============================================
// STRUCTS
// ============================================

/// A B2B settlement wrapping a real funded tunnel. The buyer is party A, the seller
/// is party B, and the arbiter is the tunnel's referee. The tunnel custodies the funds.
public struct B2BSettlement<phantom T> has key, store {
    id: UID,
    /// The two-party tunnel custodying the settled funds.
    tunnel: Tunnel<T>,
    /// Buyer address (tunnel party A).
    buyer: address,
    /// Seller address (tunnel party B).
    seller: address,
    /// Neutral arbiter address (tunnel referee).
    arbiter: address,
    /// Hash of the off-chain settlement terms (32 bytes).
    terms_hash: vector<u8>,
    /// Settlement status (`STATUS_*`).
    status: u8,
}

// ============================================
// EVENTS
// ============================================

/// Emitted when a settlement is created and the buyer funds party A.
public struct SettlementCreated has copy, drop {
    tunnel_id: ID,
    buyer: address,
    seller: address,
    arbiter: address,
    buyer_deposit: u64,
}

/// Emitted when the seller funds party B and the tunnel activates.
public struct SettlementActivated has copy, drop {
    tunnel_id: ID,
    seller_deposit: u64,
}

/// Emitted when a party escalates the settlement on-chain.
public struct DisputeOpened has copy, drop {
    tunnel_id: ID,
    raised_by: address,
}

/// Emitted when the settlement is resolved and funds are transferred.
public struct SettlementResolved has copy, drop {
    tunnel_id: ID,
    result_code: u8,
    buyer_amount: u64,
    seller_amount: u64,
}

/// Emitted when the settlement is closed via the tunnel timeout fallback.
public struct SettlementForceClosed has copy, drop {
    tunnel_id: ID,
}

// ============================================
// PUBLIC GETTER FUNCTIONS FOR CONSTANTS
// ============================================

/// Status code for a buyer-funded settlement awaiting the seller.
public fun status_funded(): u8 { STATUS_FUNDED }

/// Status code for an active, fully funded tunnel.
public fun status_active(): u8 { STATUS_ACTIVE }

/// Status code for a settlement escalated on-chain.
public fun status_disputed(): u8 { STATUS_DISPUTED }

/// Status code for a settled settlement with funds transferred.
public fun status_resolved(): u8 { STATUS_RESOLVED }

/// Status code for a settlement closed via the tunnel timeout fallback.
public fun status_force_closed(): u8 { STATUS_FORCE_CLOSED }

/// Status code for a settlement the buyer cancelled before the seller funded.
public fun status_cancelled(): u8 { STATUS_CANCELLED }

/// Result code that pays the full balance to the seller.
public fun result_pay_seller(): u8 { RESULT_PAY_SELLER }

/// Result code that refunds the full balance to the buyer.
public fun result_refund_buyer(): u8 { RESULT_REFUND_BUYER }

/// Result code that splits the balance per the arbiter's seller share.
public fun result_split(): u8 { RESULT_SPLIT }

/// Default arbiter response window in milliseconds.
public fun settlement_timeout_ms(): u64 { SETTLEMENT_TIMEOUT_MS }

// ============================================
// LIFECYCLE
// ============================================

/// Buyer (the sender) creates the settlement: an ed25519 two-party tunnel with the
/// buyer as party A and the seller as party B, assigns `arbiter` as the referee, and
/// deposits the buyer's funds. Aborts if `terms_hash` is not 32 bytes (`EInvalidHash`),
/// any two of buyer/seller/arbiter share an address (`EInvalidParties`), either public
/// key is empty (`EInvalidPublicKey`), or the deposit is empty (`EInvalidDepositAmount`).
public fun create_settlement<T>(
    seller: address,
    arbiter: address,
    buyer_pk: vector<u8>,
    seller_pk: vector<u8>,
    terms_hash: vector<u8>,
    deposit: Coin<T>,
    timeout_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): B2BSettlement<T> {
    let buyer = ctx.sender();
    assert!(terms_hash.length() == HASH_LENGTH, EInvalidHash);
    assert!(buyer != seller && buyer != arbiter && seller != arbiter, EInvalidParties);
    assert!(!buyer_pk.is_empty() && !seller_pk.is_empty(), EInvalidPublicKey);
    assert!(deposit.value() > 0, EInvalidDepositAmount);

    let buyer_deposit = deposit.value();

    let mut tun = tunnel::create<T>(
        buyer,
        buyer_pk,
        signature::ed25519(),
        seller,
        seller_pk,
        signature::ed25519(),
        timeout_ms,
        0,
        clock,
        ctx,
    );
    tun.set_referee(arbiter, ctx);
    tun.deposit_party_a(deposit, clock, ctx);

    let tunnel_id = tun.id();

    event::emit(SettlementCreated {
        tunnel_id,
        buyer,
        seller,
        arbiter,
        buyer_deposit,
    });

    B2BSettlement {
        id: object::new(ctx),
        tunnel: tun,
        buyer,
        seller,
        arbiter,
        terms_hash,
        status: STATUS_FUNDED,
    }
}

/// Seller funds party B, activating the tunnel. The collateral must be at least the
/// tunnel minimum (1); a 0 collateral aborts `EMinimumDepositNotMet` in the tunnel.
/// Aborts (`EInvalidState`) if the settlement is not in `STATUS_FUNDED`, or
/// (`ENotAuthorized` in the tunnel) if the caller is not the seller.
public fun seller_join<T>(
    settlement: &mut B2BSettlement<T>,
    collateral: Coin<T>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(settlement.status == STATUS_FUNDED, EInvalidState);
    let seller_deposit = collateral.value();
    settlement.tunnel.deposit_party_b(collateral, clock, ctx);
    settlement.status = STATUS_ACTIVE;

    event::emit(SettlementActivated {
        tunnel_id: settlement.tunnel.id(),
        seller_deposit,
    });
}

/// Refunds the buyer's deposit before the seller funds, returning the coin so the buyer can
/// route it in a PTB. Reuses the tunnel's pre-activation withdrawal, so only the buyer (the
/// sole depositor) can reclaim. Aborts `EInvalidState` if the settlement is not awaiting the
/// seller (`STATUS_FUNDED`).
public fun cancel_settlement<T>(
    settlement: &mut B2BSettlement<T>,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<T> {
    assert!(settlement.status == STATUS_FUNDED, EInvalidState);
    settlement.status = STATUS_CANCELLED;
    settlement.tunnel.withdraw_before_active(clock, ctx)
}

// ============================================
// SETTLEMENT
// ============================================

/// Cooperative happy path: both parties signed off on the split, so the funds settle
/// without arbitration. The tunnel verifies the dual signatures and enforces the
/// balance-sum invariant (`tunnel::EBalanceSumMismatch`) via its overflow-safe split check.
public fun settle_cooperatively<T>(
    settlement: &mut B2BSettlement<T>,
    buyer_amount: u64,
    seller_amount: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    timestamp: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(settlement.status == STATUS_ACTIVE, EInvalidState);

    settlement
        .tunnel
        .close_cooperative_and_transfer(
            buyer_amount,
            seller_amount,
            sig_a,
            sig_b,
            timestamp,
            clock,
            ctx,
        );
    settlement.status = STATUS_RESOLVED;

    event::emit(SettlementResolved {
        tunnel_id: settlement.tunnel.id(),
        result_code: RESULT_SPLIT,
        buyer_amount,
        seller_amount,
    });
}

// ============================================
// DISPUTE
// ============================================

/// A party escalates the settlement on-chain by disputing over the tunnel's current
/// balances, which is the precondition for arbiter settlement. Either party may call it.
public fun open_dispute<T>(settlement: &mut B2BSettlement<T>, clock: &Clock, ctx: &TxContext) {
    assert!(settlement.status == STATUS_ACTIVE, EInvalidState);
    settlement.tunnel.raise_dispute_current_state(clock, ctx);
    settlement.status = STATUS_DISPUTED;

    event::emit(DisputeOpened {
        tunnel_id: settlement.tunnel.id(),
        raised_by: ctx.sender(),
    });
}

/// Maps a typed result code to the on-chain (buyer, seller) split for a given balance.
/// Aborts (`EBalanceSumMismatch`) on a split with `seller_share` above `total`, or
/// (`EInvalidParameter`) on an unknown code.
fun payout_for_result(result_code: u8, seller_share: u64, total: u64): (u64, u64) {
    if (result_code == RESULT_PAY_SELLER) {
        (0, total)
    } else if (result_code == RESULT_REFUND_BUYER) {
        (total, 0)
    } else if (result_code == RESULT_SPLIT) {
        assert!(seller_share <= total, EBalanceSumMismatch);
        (total - seller_share, seller_share)
    } else {
        abort EInvalidParameter
    }
}

/// The arbiter (referee) attests a typed result code that deterministically maps to the
/// payout, then moves the funds via the tunnel's referee resolution. Aborts
/// (`ERefereeNotAuthorized` in the tunnel) if the caller is not the assigned arbiter; the
/// tunnel also enforces the balance-sum invariant.
public fun arbiter_resolve<T>(
    settlement: &mut B2BSettlement<T>,
    result_code: u8,
    seller_share: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(settlement.status == STATUS_DISPUTED, EInvalidState);

    let total = settlement.tunnel.total_balance();
    let (buyer_amount, seller_amount) = payout_for_result(result_code, seller_share, total);

    settlement.tunnel.resolve_dispute_external(buyer_amount, seller_amount, clock, ctx);
    settlement.status = STATUS_RESOLVED;

    event::emit(SettlementResolved {
        tunnel_id: settlement.tunnel.id(),
        result_code,
        buyer_amount,
        seller_amount,
    });
}

/// Trust-minimized fallback: if the arbiter never resolves, the dispute raiser can
/// force-close the tunnel after its timeout, distributing the disputed-state balances.
/// Reuses the tunnel's own timeout exit, so funds are never trapped.
public fun force_close<T>(settlement: &mut B2BSettlement<T>, clock: &Clock, ctx: &mut TxContext) {
    assert!(settlement.status == STATUS_DISPUTED, EInvalidState);
    settlement.tunnel.force_close_after_timeout(clock, ctx);
    settlement.status = STATUS_FORCE_CLOSED;

    event::emit(SettlementForceClosed {
        tunnel_id: settlement.tunnel.id(),
    });
}

// ============================================
// ACCESSORS
// ============================================

/// The buyer (tunnel party A) address.
public fun settlement_buyer<T>(settlement: &B2BSettlement<T>): address { settlement.buyer }

/// The seller (tunnel party B) address.
public fun settlement_seller<T>(settlement: &B2BSettlement<T>): address { settlement.seller }

/// The arbiter (tunnel referee) address.
public fun settlement_arbiter<T>(settlement: &B2BSettlement<T>): address { settlement.arbiter }

/// The settlement status (`STATUS_*`).
public fun settlement_status<T>(settlement: &B2BSettlement<T>): u8 { settlement.status }

/// The off-chain terms hash.
public fun settlement_terms_hash<T>(settlement: &B2BSettlement<T>): &vector<u8> {
    &settlement.terms_hash
}

/// The funds currently custodied by the tunnel.
public fun settlement_total_balance<T>(settlement: &B2BSettlement<T>): u64 {
    settlement.tunnel.total_balance()
}

/// Read-only access to the underlying tunnel.
public fun settlement_tunnel<T>(settlement: &B2BSettlement<T>): &Tunnel<T> { &settlement.tunnel }

/// True when the tunnel is active and ready for cooperative settlement.
public fun is_active<T>(settlement: &B2BSettlement<T>): bool { settlement.tunnel.is_active() }

/// True when the settlement has been escalated on-chain.
public fun is_disputed<T>(settlement: &B2BSettlement<T>): bool { settlement.tunnel.is_disputed() }

/// True when the dispute raiser can force-close (tunnel disputed and past timeout).
public fun can_force_close<T>(settlement: &B2BSettlement<T>, clock: &Clock): bool {
    settlement.tunnel.is_disputed() && settlement.tunnel.can_claim_timeout(clock)
}

// ============================================
// TEST HELPERS
// ============================================

#[test_only]
public fun destroy_settlement_for_testing<T>(settlement: B2BSettlement<T>) {
    let B2BSettlement { id, tunnel, .. } = settlement;
    id.delete();
    tunnel.destroy_for_testing();
}

#[test_only]
public fun set_status_for_testing<T>(settlement: &mut B2BSettlement<T>, status: u8) {
    settlement.status = status;
}

#[test_only]
public fun settle_cooperatively_no_sig_for_testing<T>(
    settlement: &mut B2BSettlement<T>,
    buyer_amount: u64,
    seller_amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(settlement.status == STATUS_ACTIVE, EInvalidState);
    settlement.tunnel.close_cooperative_no_sig_for_testing(buyer_amount, seller_amount, clock, ctx);
    settlement.status = STATUS_RESOLVED;
}
