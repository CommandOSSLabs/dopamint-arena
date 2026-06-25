/// Example: Merchant Tab
///
/// A point-of-sale tab between a customer and a merchant: one channel, many
/// gas-free "taps" that move funds from customer to merchant off-chain, settled
/// once at checkout. Every tap may only drain the customer's balance toward the
/// merchant, mirroring a running bar tab.
///
/// ## Flow:
/// 1. Customer opens a tab, pre-funding their side with a deposit
/// 2. Merchant joins (registers a key; funds nothing)
/// 3. Each purchase is a signed off-chain tap moving funds customer -> merchant
/// 4. At checkout either party settles with the latest signed tap state
///
/// ## Key Features:
/// - Gas-free taps (no on-chain tx per purchase)
/// - Monotonic drain: taps can only move funds toward the merchant
/// - Cooperative checkout or settle-with-dispute-window fallback
module sui_tunnel::example_merchant_tab;

use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;
use sui::hash;
use sui_tunnel::signature;

// === Error definitions (see sui_tunnel::errors for the canonical registry) ===

#[error]
const ENotAuthorized: vector<u8> = b"The caller is not authorized to perform this action.";

#[error]
const EInvalidState: vector<u8> = b"The operation is not allowed in the current state.";

#[error]
const EAlreadyExists: vector<u8> = b"The resource already exists and cannot be created again.";

#[error]
const EInvalidSignature: vector<u8> = b"Signature verification failed.";

#[error]
const EInvalidPublicKey: vector<u8> = b"The public key is invalid or has the wrong length for its scheme.";

#[error]
const ETunnelClosed: vector<u8> = b"The tunnel is closed or not in the required state for this operation.";

#[error]
const EInvalidParties: vector<u8> = b"The tunnel parties are invalid (for example, both parties share the same address).";

#[error]
const EInvalidNonce: vector<u8> = b"The nonce is invalid; it must be strictly increasing.";

#[error]
const EInvalidStateTransition: vector<u8> = b"The requested state transition is not allowed.";

#[error]
const EDisputePeriodEnded: vector<u8> = b"The dispute period has already ended.";

#[error]
const ETimeoutNotReached: vector<u8> = b"The timeout has not been reached yet.";

#[error]
const EBalanceMismatch: vector<u8> = b"The balance does not match the expected amount after the operation.";

// ============================================
// CONSTANTS
// ============================================

/// Tab status: Open for taps
const TAB_OPEN: u8 = 0;

/// Tab status: Settling (dispute window)
const TAB_SETTLING: u8 = 1;

/// Tab status: Settled
const TAB_SETTLED: u8 = 2;

/// Tab status: Refunded to the customer after timeout
const TAB_REFUNDED: u8 = 3;

/// Settle dispute window: 10 minutes
const SETTLE_DISPUTE_MS: u64 = 600000;

/// Refund timeout: 24 hours
const REFUND_TIMEOUT_MS: u64 = 86400000;

// ============================================
// STRUCTS
// ============================================

/// A point-of-sale tab between a customer and a merchant.
public struct MerchantTab<phantom T> has key, store {
    id: UID,
    /// Customer (tab opener and sole funder)
    customer: address,
    /// Merchant (tab responder)
    merchant: address,
    /// Customer's balance in the tab
    customer_balance: Balance<T>,
    /// Merchant's balance in the tab
    merchant_balance: Balance<T>,
    /// Current tab status
    status: u8,
    /// Latest agreed state nonce
    nonce: u64,
    /// Hash of latest tap state (balances at nonce)
    state_hash: vector<u8>,
    /// Settlement initiated timestamp (for the dispute window)
    settling_started_at: u64,
    /// Proposed final balance for the customer (during settling)
    proposed_customer: u64,
    /// Proposed final balance for the merchant (during settling)
    proposed_merchant: u64,
    /// Customer's public key for signature verification
    customer_pk: vector<u8>,
    /// Merchant's public key for signature verification
    merchant_pk: vector<u8>,
    /// Timestamp after which the customer may reclaim an unsettled prepayment
    refund_after_ms: u64,
}

/// Off-chain tap state (signed by both parties)
public struct TabState has copy, drop, store {
    /// Tab ID
    tab_id: vector<u8>,
    /// State nonce (must be increasing)
    nonce: u64,
    /// Balance for the customer
    customer_balance: u64,
    /// Balance for the merchant
    merchant_balance: u64,
}

/// A signed tap state update
public struct SignedTabState has copy, drop, store {
    /// The tap state
    state: TabState,
    /// Signature from the customer
    sig_a: vector<u8>,
    /// Signature from the merchant
    sig_b: vector<u8>,
}

// ============================================
// EVENTS
// ============================================

/// Emitted when a tab is opened
public struct TabOpened has copy, drop {
    customer: address,
    merchant: address,
    initial_balance: u64,
}

/// Emitted when the merchant joins the tab
public struct TabActivated has copy, drop {
    customer: address,
    merchant: address,
    total_balance: u64,
}

/// Emitted when settlement is initiated
public struct SettleInitiated has copy, drop {
    initiated_by: address,
    nonce: u64,
    proposed_customer: u64,
    proposed_merchant: u64,
}

/// Emitted when the tab is settled
public struct TabSettled has copy, drop {
    customer: address,
    merchant: address,
    final_customer: u64,
    final_merchant: u64,
}

/// Emitted when the customer tops up the tab
public struct TabToppedUp has copy, drop {
    party: address,
    amount: u64,
}

/// Emitted when a settlement is challenged
public struct SettleChallenged has copy, drop {
    challenger: address,
    new_nonce: u64,
}

/// Emitted when an unsettled tab is refunded to the customer after timeout
public struct TabRefunded has copy, drop {
    customer: address,
    amount: u64,
}

// ============================================
// PUBLIC GETTER FUNCTIONS
// ============================================

public fun tab_open(): u8 { TAB_OPEN }

public fun tab_settling(): u8 { TAB_SETTLING }

public fun tab_settled(): u8 { TAB_SETTLED }

public fun tab_refunded(): u8 { TAB_REFUNDED }

public fun settle_dispute_ms(): u64 { SETTLE_DISPUTE_MS }

public fun refund_timeout_ms(): u64 { REFUND_TIMEOUT_MS }

// ============================================
// TAB LIFECYCLE
// ============================================

/// Opens a new merchant tab, pre-funding the customer's side.
/// The refund window starts now so a never-funded prepayment cannot be trapped.
public fun open_tab<T>(
    merchant: address,
    initial_deposit: Coin<T>,
    customer_pk: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
): MerchantTab<T> {
    let customer = ctx.sender();
    assert!(customer != merchant, EInvalidParties);
    assert!(customer_pk.length() > 0, EInvalidPublicKey);

    let balance = initial_deposit.into_balance();
    let initial_amount = balance.value();

    let id = object::new(ctx);

    // Initial state: all funds belong to the customer, hashed over the real tab id
    let initial_state = build_tap_state_bytes(
        &id.uid_to_bytes(),
        0,
        initial_amount,
        0,
    );

    event::emit(TabOpened { customer, merchant, initial_balance: initial_amount });

    MerchantTab {
        id,
        customer,
        merchant,
        customer_balance: balance,
        merchant_balance: balance::zero(),
        status: TAB_OPEN,
        nonce: 0,
        state_hash: hash::blake2b256(&initial_state),
        settling_started_at: 0,
        proposed_customer: initial_amount,
        proposed_merchant: 0,
        customer_pk,
        merchant_pk: vector[],
        refund_after_ms: clock.timestamp_ms() + REFUND_TIMEOUT_MS,
    }
}

/// Merchant joins the tab, registering their public key.
/// The merchant funds nothing, so a zero deposit is accepted here.
public fun merchant_join<T>(
    tab: &mut MerchantTab<T>,
    deposit: Coin<T>,
    merchant_pk: vector<u8>,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == tab.merchant, ENotAuthorized);
    assert!(tab.status == TAB_OPEN, ETunnelClosed);
    assert!(tab.merchant_pk.length() == 0, EAlreadyExists);
    assert!(merchant_pk.length() > 0, EInvalidPublicKey);

    let deposit_balance = deposit.into_balance();
    tab.merchant_balance.join(deposit_balance);

    // Store the merchant's public key
    tab.merchant_pk = merchant_pk;

    // Update proposed balances
    tab.proposed_merchant = tab.merchant_balance.value();

    event::emit(TabActivated {
        customer: tab.customer,
        merchant: tab.merchant,
        total_balance: tab.customer_balance.value() + tab.merchant_balance.value(),
    });
}

/// Customer adds more funds to their side of the tab.
public fun top_up_tab<T>(tab: &mut MerchantTab<T>, deposit: Coin<T>, ctx: &TxContext) {
    assert!(ctx.sender() == tab.customer, ENotAuthorized);
    assert!(tab.status == TAB_OPEN, ETunnelClosed);

    let deposit_balance = deposit.into_balance();
    let amount = deposit_balance.value();
    tab.customer_balance.join(deposit_balance);

    event::emit(TabToppedUp { party: tab.customer, amount });
}

/// Refunds an unsettled tab to the customer after the refund window.
/// Only the customer may call this, the tab must still be open, and the timeout
/// must have elapsed. This is the trust-minimized exit when the merchant never
/// joins or never co-signs a checkout, so the prepayment cannot be trapped. Any
/// merchant collateral is returned to the merchant.
/// Transfers coins directly to the parties to prevent fund redirection in PTBs.
public fun refund_tab<T>(tab: &mut MerchantTab<T>, clock: &Clock, ctx: &mut TxContext) {
    assert!(ctx.sender() == tab.customer, ENotAuthorized);
    assert!(tab.status == TAB_OPEN, ETunnelClosed);
    assert!(clock.timestamp_ms() >= tab.refund_after_ms, ETimeoutNotReached);

    tab.status = TAB_REFUNDED;

    let amount = tab.customer_balance.value();

    event::emit(TabRefunded { customer: tab.customer, amount });

    let customer_coin = coin::from_balance(tab.customer_balance.withdraw_all(), ctx);
    let merchant_coin = coin::from_balance(tab.merchant_balance.withdraw_all(), ctx);

    transfer::public_transfer(customer_coin, tab.customer);
    transfer::public_transfer(merchant_coin, tab.merchant);
}

// ============================================
// STATE UPDATES (OFF-CHAIN COORDINATION)
// ============================================

/// Builds tap state bytes for signing.
public fun build_tap_state_bytes(
    tab_id: &vector<u8>,
    nonce: u64,
    customer_balance: u64,
    merchant_balance: u64,
): vector<u8> {
    let mut data = b"merchant_tab::tap";

    // Add tab ID
    data.append(*tab_id);

    // Add nonce
    data.append(signature::u64_to_be_bytes(nonce));

    // Add balances
    data.append(signature::u64_to_be_bytes(customer_balance));

    data.append(signature::u64_to_be_bytes(merchant_balance));

    data
}

/// Creates a tab state struct.
public fun create_tab_state(
    tab_id: vector<u8>,
    nonce: u64,
    customer_balance: u64,
    merchant_balance: u64,
): TabState {
    TabState {
        tab_id,
        nonce,
        customer_balance,
        merchant_balance,
    }
}

/// Wraps a tab state with signatures.
public fun create_signed_tab_state(
    state: TabState,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
): SignedTabState {
    SignedTabState {
        state,
        sig_a,
        sig_b,
    }
}

// ============================================
// TAB SETTLEMENT
// ============================================

/// Initiates settlement with the latest signed tap state, starting a dispute
/// window where the other party can challenge with a higher-nonce state. This
/// first on-chain checkpoint is bounded by the deposit via the balance-sum
/// invariant; the monotonic-drain rule (the customer's balance may only fall)
/// is enforced on `challenge_settle` against this proposed split.
public fun initiate_settle<T>(
    tab: &mut MerchantTab<T>,
    nonce: u64,
    customer_balance: u64,
    merchant_balance: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    let sender = ctx.sender();
    assert!(sender == tab.customer || sender == tab.merchant, ENotAuthorized);
    assert!(tab.status == TAB_OPEN, ETunnelClosed);

    // Verify total balances match
    let total = tab.customer_balance.value() + tab.merchant_balance.value();
    assert!(customer_balance + merchant_balance == total, EBalanceMismatch);

    // Reject replay of a stale tap state; the checkpoint nonce must strictly advance
    assert!(nonce > tab.nonce, EInvalidNonce);

    // Create state bytes for verification
    let tab_id = tab.id.uid_to_bytes();
    let state_bytes = build_tap_state_bytes(&tab_id, nonce, customer_balance, merchant_balance);

    // Verify signatures using stored public keys
    assert!(signature::verify_ed25519(&tab.customer_pk, &state_bytes, &sig_a), EInvalidSignature);
    assert!(signature::verify_ed25519(&tab.merchant_pk, &state_bytes, &sig_b), EInvalidSignature);

    let now = clock.timestamp_ms();

    // Start settling
    tab.status = TAB_SETTLING;
    tab.nonce = nonce;
    tab.state_hash = hash::blake2b256(&state_bytes);
    tab.settling_started_at = now;
    tab.proposed_customer = customer_balance;
    tab.proposed_merchant = merchant_balance;

    event::emit(SettleInitiated {
        initiated_by: sender,
        nonce,
        proposed_customer: customer_balance,
        proposed_merchant: merchant_balance,
    });
}

/// Challenge with a newer tap state during the dispute window.
/// The proposed customer balance must remain non-increasing.
public fun challenge_settle<T>(
    tab: &mut MerchantTab<T>,
    nonce: u64,
    customer_balance: u64,
    merchant_balance: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    let sender = ctx.sender();
    assert!(sender == tab.customer || sender == tab.merchant, ENotAuthorized);
    assert!(tab.status == TAB_SETTLING, EInvalidState);

    let now = clock.timestamp_ms();

    // Must be within the dispute window
    assert!(now < tab.settling_started_at + SETTLE_DISPUTE_MS, EDisputePeriodEnded);

    // Must have a higher nonce
    assert!(nonce > tab.nonce, EInvalidNonce);

    // Verify total balances match
    let total = tab.customer_balance.value() + tab.merchant_balance.value();
    assert!(customer_balance + merchant_balance == total, EBalanceMismatch);

    // Monotonic drain: a later tap may only move funds further toward the
    // merchant, so the customer's balance cannot rise above the prior checkpoint
    assert!(customer_balance <= tab.proposed_customer, EInvalidStateTransition);

    // Create state bytes for verification
    let tab_id = tab.id.uid_to_bytes();
    let state_bytes = build_tap_state_bytes(&tab_id, nonce, customer_balance, merchant_balance);

    // Verify signatures using stored public keys
    assert!(signature::verify_ed25519(&tab.customer_pk, &state_bytes, &sig_a), EInvalidSignature);
    assert!(signature::verify_ed25519(&tab.merchant_pk, &state_bytes, &sig_b), EInvalidSignature);

    // Update to the newer state
    tab.nonce = nonce;
    tab.state_hash = hash::blake2b256(&state_bytes);
    tab.proposed_customer = customer_balance;
    tab.proposed_merchant = merchant_balance;
    // Restart the dispute window
    tab.settling_started_at = now;

    event::emit(SettleChallenged { challenger: sender, new_nonce: nonce });
}

/// Finalize settlement after the dispute window.
/// Transfers coins directly to the parties to prevent fund redirection in PTBs.
public fun finalize_settle<T>(tab: &mut MerchantTab<T>, clock: &Clock, ctx: &mut TxContext) {
    let sender = ctx.sender();
    assert!(sender == tab.customer || sender == tab.merchant, ENotAuthorized);
    assert!(tab.status == TAB_SETTLING, EInvalidState);

    let now = clock.timestamp_ms();

    // Dispute window must have passed
    assert!(now >= tab.settling_started_at + SETTLE_DISPUTE_MS, ETimeoutNotReached);

    tab.status = TAB_SETTLED;

    event::emit(TabSettled {
        customer: tab.customer,
        merchant: tab.merchant,
        final_customer: tab.proposed_customer,
        final_merchant: tab.proposed_merchant,
    });

    let final_customer = tab.proposed_customer;
    let final_merchant = tab.proposed_merchant;
    payout(tab, final_customer, final_merchant, ctx);
}

/// Checkout cooperatively — both parties agree, no dispute window needed.
/// Transfers coins directly to the parties to prevent fund redirection in PTBs.
///
/// `nonce` is the tap-state nonce both parties signed; it must be strictly
/// higher than `tab.nonce` so a stale checkout split cannot be replayed. The
/// instant payout trusts that both signed the latest tap; the
/// `initiate_settle` / `challenge_settle` path is the windowed defense.
public fun checkout<T>(
    tab: &mut MerchantTab<T>,
    nonce: u64,
    customer_balance: u64,
    merchant_balance: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    ctx: &mut TxContext,
) {
    assert!(tab.status == TAB_OPEN, ETunnelClosed);

    // Verify total balances match
    let total = tab.customer_balance.value() + tab.merchant_balance.value();
    assert!(customer_balance + merchant_balance == total, EBalanceMismatch);

    // Reject replay of a stale checkout split
    assert!(nonce > tab.nonce, EInvalidNonce);

    // Create checkout message
    let tab_id = tab.id.uid_to_bytes();
    let mut checkout_msg = b"merchant_tab::checkout";
    checkout_msg.append(tab_id);

    checkout_msg.append(signature::u64_to_be_bytes(customer_balance));

    checkout_msg.append(signature::u64_to_be_bytes(merchant_balance));

    // Bind the signed tap-state nonce to prevent signature replay
    checkout_msg.append(signature::u64_to_be_bytes(nonce));

    // Verify signatures using stored public keys
    assert!(signature::verify_ed25519(&tab.customer_pk, &checkout_msg, &sig_a), EInvalidSignature);
    assert!(signature::verify_ed25519(&tab.merchant_pk, &checkout_msg, &sig_b), EInvalidSignature);

    tab.nonce = nonce;
    tab.status = TAB_SETTLED;

    event::emit(TabSettled {
        customer: tab.customer,
        merchant: tab.merchant,
        final_customer: customer_balance,
        final_merchant: merchant_balance,
    });

    payout(tab, customer_balance, merchant_balance, ctx);
}

/// Merges both pools, then pays each party its agreed amount so a co-signed split
/// that returns merchant collateral to the customer is payable regardless of which
/// pool the funds sit in.
fun payout<T>(
    tab: &mut MerchantTab<T>,
    customer_balance: u64,
    merchant_balance: u64,
    ctx: &mut TxContext,
) {
    let mut combined = tab.customer_balance.withdraw_all();
    combined.join(tab.merchant_balance.withdraw_all());

    let coin_a = coin::from_balance(combined.split(customer_balance), ctx);
    let coin_b = coin::from_balance(combined.split(merchant_balance), ctx);
    combined.destroy_zero();

    // Transfer directly to parties to prevent interception
    transfer::public_transfer(coin_a, tab.customer);
    transfer::public_transfer(coin_b, tab.merchant);
}

// ============================================
// ACCESSORS
// ============================================

public fun tab_id<T>(tab: &MerchantTab<T>): vector<u8> {
    tab.id.uid_to_bytes()
}

public fun tab_customer<T>(tab: &MerchantTab<T>): address { tab.customer }

public fun tab_merchant<T>(tab: &MerchantTab<T>): address { tab.merchant }

public fun tab_customer_balance<T>(tab: &MerchantTab<T>): u64 { tab.customer_balance.value() }

public fun tab_merchant_balance<T>(tab: &MerchantTab<T>): u64 { tab.merchant_balance.value() }

public fun tab_total_balance<T>(tab: &MerchantTab<T>): u64 {
    tab.customer_balance.value() + tab.merchant_balance.value()
}

public fun tab_status<T>(tab: &MerchantTab<T>): u8 { tab.status }

public fun tab_nonce<T>(tab: &MerchantTab<T>): u64 { tab.nonce }

public fun tab_state_hash<T>(tab: &MerchantTab<T>): &vector<u8> { &tab.state_hash }

public fun tab_customer_pk<T>(tab: &MerchantTab<T>): &vector<u8> { &tab.customer_pk }

public fun tab_merchant_pk<T>(tab: &MerchantTab<T>): &vector<u8> { &tab.merchant_pk }

public fun tab_refund_after<T>(tab: &MerchantTab<T>): u64 { tab.refund_after_ms }

public fun can_refund<T>(tab: &MerchantTab<T>, clock: &Clock): bool {
    tab.status == TAB_OPEN && clock.timestamp_ms() >= tab.refund_after_ms
}

// TabState accessors
public fun state_tab_id(state: &TabState): &vector<u8> { &state.tab_id }

public fun state_nonce(state: &TabState): u64 { state.nonce }

public fun state_customer_balance(state: &TabState): u64 { state.customer_balance }

public fun state_merchant_balance(state: &TabState): u64 { state.merchant_balance }

// SignedTabState accessors
public fun signed_state(ss: &SignedTabState): &TabState { &ss.state }

public fun signed_sig_a(ss: &SignedTabState): &vector<u8> { &ss.sig_a }

public fun signed_sig_b(ss: &SignedTabState): &vector<u8> { &ss.sig_b }

// ============================================
// TEST HELPERS
// ============================================

#[test_only]
public fun destroy_merchant_tab_for_testing<T>(tab: MerchantTab<T>) {
    let MerchantTab {
        id,
        customer_balance,
        merchant_balance,
        ..,
    } = tab;
    id.delete();
    customer_balance.destroy_for_testing();
    merchant_balance.destroy_for_testing();
}

#[test_only]
public fun set_status_for_testing<T>(tab: &mut MerchantTab<T>, status: u8) {
    tab.status = status;
}

#[test_only]
public fun set_nonce_for_testing<T>(tab: &mut MerchantTab<T>, nonce: u64) {
    tab.nonce = nonce;
}

/// Mirrors `initiate_settle` but skips ed25519 verification so the settle path
/// and the monotonic-drain abort are reachable in unit tests.
#[test_only]
public fun initiate_settle_no_sig_for_testing<T>(
    tab: &mut MerchantTab<T>,
    nonce: u64,
    customer_balance: u64,
    merchant_balance: u64,
    clock: &Clock,
    ctx: &TxContext,
) {
    let sender = ctx.sender();
    assert!(sender == tab.customer || sender == tab.merchant, ENotAuthorized);
    assert!(tab.status == TAB_OPEN, ETunnelClosed);

    let total = tab.customer_balance.value() + tab.merchant_balance.value();
    assert!(customer_balance + merchant_balance == total, EBalanceMismatch);
    assert!(nonce > tab.nonce, EInvalidNonce);

    let tab_id = tab.id.uid_to_bytes();
    let state_bytes = build_tap_state_bytes(&tab_id, nonce, customer_balance, merchant_balance);

    let now = clock.timestamp_ms();

    tab.status = TAB_SETTLING;
    tab.nonce = nonce;
    tab.state_hash = hash::blake2b256(&state_bytes);
    tab.settling_started_at = now;
    tab.proposed_customer = customer_balance;
    tab.proposed_merchant = merchant_balance;

    event::emit(SettleInitiated {
        initiated_by: sender,
        nonce,
        proposed_customer: customer_balance,
        proposed_merchant: merchant_balance,
    });
}

/// Mirrors `challenge_settle` but skips ed25519 verification so the higher-nonce
/// override (advancing nonce, updated balance snapshot, restarted window) is
/// reachable in unit tests.
#[test_only]
public fun challenge_settle_no_sig_for_testing<T>(
    tab: &mut MerchantTab<T>,
    nonce: u64,
    customer_balance: u64,
    merchant_balance: u64,
    clock: &Clock,
    ctx: &TxContext,
) {
    let sender = ctx.sender();
    assert!(sender == tab.customer || sender == tab.merchant, ENotAuthorized);
    assert!(tab.status == TAB_SETTLING, EInvalidState);

    let now = clock.timestamp_ms();
    assert!(now < tab.settling_started_at + SETTLE_DISPUTE_MS, EDisputePeriodEnded);
    assert!(nonce > tab.nonce, EInvalidNonce);

    let total = tab.customer_balance.value() + tab.merchant_balance.value();
    assert!(customer_balance + merchant_balance == total, EBalanceMismatch);
    assert!(customer_balance <= tab.proposed_customer, EInvalidStateTransition);

    let tab_id = tab.id.uid_to_bytes();
    let state_bytes = build_tap_state_bytes(&tab_id, nonce, customer_balance, merchant_balance);

    tab.nonce = nonce;
    tab.state_hash = hash::blake2b256(&state_bytes);
    tab.proposed_customer = customer_balance;
    tab.proposed_merchant = merchant_balance;
    tab.settling_started_at = now;

    event::emit(SettleChallenged { challenger: sender, new_nonce: nonce });
}

/// Mirrors `checkout` but skips ed25519 verification so the cooperative payout
/// is reachable in unit tests.
#[test_only]
public fun checkout_no_sig_for_testing<T>(
    tab: &mut MerchantTab<T>,
    nonce: u64,
    customer_balance: u64,
    merchant_balance: u64,
    ctx: &mut TxContext,
) {
    assert!(tab.status == TAB_OPEN, ETunnelClosed);

    let total = tab.customer_balance.value() + tab.merchant_balance.value();
    assert!(customer_balance + merchant_balance == total, EBalanceMismatch);
    assert!(nonce > tab.nonce, EInvalidNonce);

    tab.nonce = nonce;
    tab.status = TAB_SETTLED;

    event::emit(TabSettled {
        customer: tab.customer,
        merchant: tab.merchant,
        final_customer: customer_balance,
        final_merchant: merchant_balance,
    });

    payout(tab, customer_balance, merchant_balance, ctx);
}
