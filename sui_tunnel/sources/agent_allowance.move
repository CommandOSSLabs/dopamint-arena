/// Example: Agent Spending Allowance
///
/// A delegated, capped, rate-limited, pull-based payment authorization designed
/// for autonomous AI agents. A `principal` (payer) escrows funds once and grants
/// a spending mandate to a fixed `payee` (a service or counterparty agent). The
/// payee — or a `delegate` session key acting on the principal's behalf — can then
/// PULL what is owed without a counterparty signature on every charge, bounded by:
///
/// - a hard lifetime `spend_cap` (the maximum that can ever be pulled), and
/// - an optional `rate_per_second` time accrual (continuous streaming, à la
///   Stripe Tempo / Sablier), and/or
/// - principal-signed cumulative spend vouchers (usage-metered authorization, à la
///   Cloudflare x402 `upto` / Tempo Sessions vouchers).
///
/// The entitlement at any instant is `min(spend_cap, max(rate_vested, voucher))`,
/// and a claim can never exceed the escrowed balance, so settlement is guaranteed
/// without trusting the payer to stay online (unlike the dual-signed tunnel path).
/// The principal can top up, retune the rate/cap, pause, rotate the delegate, and
/// revoke — revocation always settles the payee's earned-but-unclaimed amount first,
/// then refunds the remainder.
///
/// ## Why this exists
/// The tunnel state channel and `example_agent_micropayments` require BOTH parties
/// to co-sign every settlement, and `example_streaming_payment` is a fixed-recipient,
/// fully-prepaid vesting object with no delegation. Neither offers the "authorize a
/// spending cap once, then stream/pull micropayments" mandate that autonomous agents
/// need. This module fills that gap. It uses no off-chain coordination for the
/// rate-based path (pure on-chain accrual + sender checks), so there is no fragile
/// cross-language wire format to keep in lockstep — only the optional voucher path
/// signs a message (`serialize_spend_authorization`).
///
/// ## Authorization model
/// Consistent with the rest of the package: address + signature, no capability
/// objects. `principal`/`payee`/`delegate` are stored addresses checked against
/// `ctx.sender()`; vouchers are verified against the principal's stored public key.
module sui_tunnel::agent_allowance;

use sui::balance::Balance;
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;
use sui_tunnel::signature;

// === Error definitions (see sui_tunnel::errors for the canonical registry) ===

#[error]
const ENotAuthorized: vector<u8> = b"The caller is not authorized to perform this action.";

#[error]
const EInvalidParameter: vector<u8> = b"A required parameter is missing or invalid.";

#[error]
const EInvalidState: vector<u8> = b"The operation is not allowed in the current state.";

#[error]
const EInvalidParties: vector<u8> = b"The tunnel parties are invalid (for example, both parties share the same address).";

#[error]
const EInvalidVersion: vector<u8> = b"The object version does not match the current module version.";

#[error]
const EInvalidSignature: vector<u8> = b"Signature verification failed.";

#[error]
const EInvalidPublicKey: vector<u8> = b"The public key is invalid or has the wrong length for its scheme.";

#[error]
const EInsufficientBalance: vector<u8> = b"Insufficient balance for this operation.";

#[error]
const ESpendCapExceeded: vector<u8> = b"The spend would exceed the authorized cap.";

#[error]
const ENotYetVested: vector<u8> = b"The amount exceeds the funds vested so far; wait for accrual or submit a higher voucher.";

#[error]
const EStaleAuthorization: vector<u8> = b"The spend authorization is not newer than the current one.";

// ============================================
// CONSTANTS
// ============================================

/// Current struct version for upgrade compatibility.
const CURRENT_VERSION: u64 = 1;

/// Allowance status: accruing and claimable.
const STATUS_ACTIVE: u8 = 0;

/// Allowance status: accrual frozen (no time vesting, no claims) until resumed.
const STATUS_PAUSED: u8 = 1;

/// Allowance status: revoked and settled (terminal).
const STATUS_REVOKED: u8 = 2;

// ============================================
// STRUCTS
// ============================================

/// A spending mandate from a principal to a fixed payee, backed by escrow.
/// Shared so the payee or delegate can pull against it; only the principal can
/// retune or revoke it.
public struct Allowance<phantom T> has key, store {
    id: UID,
    /// Struct version for upgrade compatibility.
    version: u64,
    /// Funder who owns the escrow and may retune / revoke / reclaim.
    principal: address,
    /// The sole recipient of every claim.
    payee: address,
    /// Optional session-key agent allowed to trigger claims for the principal
    /// (`none` = only the payee or principal may pull).
    delegate: Option<address>,
    /// Principal's public key, used to verify cumulative spend vouchers
    /// (empty when the voucher path is unused).
    principal_public_key: vector<u8>,
    /// Signature scheme of `principal_public_key`.
    principal_signature_type: u8,
    /// Escrowed funds backing every claim (settlement guarantee).
    escrow: Balance<T>,
    /// Continuous accrual rate in base units per second (0 = no time vesting).
    rate_per_second: u64,
    /// Hard lifetime ceiling on cumulative spend.
    spend_cap: u64,
    /// Cumulative amount already pulled by the payee.
    spent: u64,
    /// Rate accrual locked in at the last re-anchor (folds rate/pause changes).
    vested_floor: u64,
    /// Timestamp the current accrual segment started from.
    anchor_ms: u64,
    /// Highest cumulative amount authorized by a principal-signed voucher.
    authorized_total: u64,
    /// Absolute time (ms) at which rate accrual stops (0 = open-ended).
    expiry_ms: u64,
    /// Lifecycle status.
    status: u8,
    /// Creation timestamp (ms).
    created_at: u64,
}

// ============================================
// EVENTS
// ============================================

/// Emitted when an allowance is created.
public struct AllowanceCreated has copy, drop {
    allowance_id: ID,
    principal: address,
    payee: address,
    rate_per_second: u64,
    spend_cap: u64,
    expiry_ms: u64,
}

/// Emitted when the payee pulls funds.
public struct AllowanceClaimed has copy, drop {
    allowance_id: ID,
    claimed_by: address,
    amount: u64,
    total_spent: u64,
}

/// Emitted when the principal adds escrow.
public struct AllowanceToppedUp has copy, drop {
    allowance_id: ID,
    amount: u64,
    new_escrow: u64,
}

/// Emitted when the principal changes the accrual rate.
public struct AllowanceRateChanged has copy, drop {
    allowance_id: ID,
    new_rate_per_second: u64,
    vested_floor: u64,
}

/// Emitted when the principal raises the spend cap.
public struct AllowanceCapIncreased has copy, drop {
    allowance_id: ID,
    new_spend_cap: u64,
}

/// Emitted when accrual is paused.
public struct AllowancePaused has copy, drop {
    allowance_id: ID,
    vested_floor: u64,
}

/// Emitted when accrual resumes.
public struct AllowanceResumed has copy, drop {
    allowance_id: ID,
    rate_per_second: u64,
}

/// Emitted when the delegate session key is set, rotated, or cleared.
public struct DelegateUpdated has copy, drop {
    allowance_id: ID,
    delegate: Option<address>,
}

/// Emitted when a principal-signed cumulative voucher raises the authorization.
public struct SpendAuthorized has copy, drop {
    allowance_id: ID,
    authorized_total: u64,
}

/// Emitted when the principal revokes the allowance (after settling the payee).
public struct AllowanceRevoked has copy, drop {
    allowance_id: ID,
    paid_to_payee: u64,
    refunded_to_principal: u64,
}

// ============================================
// CONSTANT GETTERS
// ============================================

/// Status code for an active, claimable allowance.
public fun status_active(): u8 { STATUS_ACTIVE }

/// Status code for a paused allowance (accrual frozen, claims blocked).
public fun status_paused(): u8 { STATUS_PAUSED }

/// Status code for a revoked, settled allowance (terminal).
public fun status_revoked(): u8 { STATUS_REVOKED }

/// The struct version this module reads and writes.
public fun current_version(): u64 { CURRENT_VERSION }

// ============================================
// LIFECYCLE
// ============================================

/// Create a spending allowance escrowing `funds`, payable only to `payee`.
/// `ctx.sender()` becomes the principal. `rate_per_second` enables continuous
/// streaming (0 disables it); `spend_cap` is the hard lifetime ceiling;
/// `expiry_ms` stops rate accrual at an absolute time (0 = open-ended).
/// `principal_public_key`/`principal_signature_type` are only needed if the
/// caller intends to use the voucher path; pass an empty key otherwise.
/// Returns the object; share it (e.g. via `entry_create_and_share`) so the payee
/// or delegate can pull against it.
public fun create_allowance<T>(
    payee: address,
    delegate: Option<address>,
    principal_public_key: vector<u8>,
    principal_signature_type: u8,
    funds: Coin<T>,
    rate_per_second: u64,
    spend_cap: u64,
    expiry_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): Allowance<T> {
    let principal = ctx.sender();
    assert!(principal != payee, EInvalidParties);
    assert!(spend_cap > 0, EInvalidParameter);
    assert!(funds.value() > 0, EInvalidParameter);

    let now = clock.timestamp_ms();
    // An expiry, if set, must be in the future or rate accrual is dead on arrival.
    assert!(expiry_ms == 0 || expiry_ms > now, EInvalidParameter);
    // A delegate that is the payee or principal adds no meaningful separation.
    delegate.do_ref!(|d| assert!(*d != principal && *d != payee, EInvalidParties));

    let id = object::new(ctx);
    let allowance_id = id.to_inner();

    event::emit(AllowanceCreated {
        allowance_id,
        principal,
        payee,
        rate_per_second,
        spend_cap,
        expiry_ms,
    });

    Allowance<T> {
        id,
        version: CURRENT_VERSION,
        principal,
        payee,
        delegate,
        principal_public_key,
        principal_signature_type,
        escrow: funds.into_balance(),
        rate_per_second,
        spend_cap,
        spent: 0,
        vested_floor: 0,
        anchor_ms: now,
        authorized_total: 0,
        expiry_ms,
        status: STATUS_ACTIVE,
        created_at: now,
    }
}

/// Create an allowance and share it in one call, so the payee/delegate can pull.
#[allow(lint(share_owned))]
public fun create_and_share_allowance<T>(
    payee: address,
    delegate: Option<address>,
    principal_public_key: vector<u8>,
    principal_signature_type: u8,
    funds: Coin<T>,
    rate_per_second: u64,
    spend_cap: u64,
    expiry_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let allowance = create_allowance<T>(
        payee,
        delegate,
        principal_public_key,
        principal_signature_type,
        funds,
        rate_per_second,
        spend_cap,
        expiry_ms,
        clock,
        ctx,
    );
    transfer::share_object(allowance);
}

// ============================================
// ACCRUAL (internal)
// ============================================

/// Rate-based vested amount at `now`, folding the locked-in floor with accrual
/// since the last anchor, clamped to the spend cap. Accrual stops at `expiry_ms`.
/// Uses u128 intermediate math so `rate * elapsed` cannot overflow before the cap clamp.
///
/// Accrual only advances while ACTIVE: when paused or revoked it freezes at the
/// folded `vested_floor`, so the paused interval is never credited (relied on by
/// `revoke` and the `entitled_at` view, which are not behind the active guard).
fun rate_vested<T>(allowance: &Allowance<T>, now: u64): u64 {
    if (allowance.status != STATUS_ACTIVE) {
        return allowance.vested_floor.min(allowance.spend_cap)
    };
    let deadline = if (allowance.expiry_ms == 0) {
        now
    } else {
        allowance.expiry_ms.min(now)
    };
    let elapsed_secs = if (deadline > allowance.anchor_ms) {
        (deadline - allowance.anchor_ms) / 1000
    } else {
        0
    };
    let accrued =
        (allowance.vested_floor as u128) +
        (allowance.rate_per_second as u128) * (elapsed_secs as u128);
    accrued.min(allowance.spend_cap as u128) as u64
}

/// Total amount the payee is entitled to have pulled by `now`: the greater of the
/// rate-vested floor and the signed-voucher authorization, capped by `spend_cap`.
fun entitled<T>(allowance: &Allowance<T>, now: u64): u64 {
    rate_vested(allowance, now).max(allowance.authorized_total).min(allowance.spend_cap)
}

/// Fold accrual up to `now` into `vested_floor` and reset the anchor, so a
/// subsequent rate change or pause does not retroactively alter past accrual.
fun reanchor<T>(allowance: &mut Allowance<T>, now: u64) {
    allowance.vested_floor = rate_vested(allowance, now);
    allowance.anchor_ms = now;
}

/// Internal pull: move `amount` of escrow to the payee, bumping `spent`.
fun pull_internal<T>(allowance: &mut Allowance<T>, amount: u64, ctx: &mut TxContext) {
    allowance.spent = allowance.spent + amount;
    let coin = coin::from_balance(allowance.escrow.split(amount), ctx);
    transfer::public_transfer(coin, allowance.payee);

    event::emit(AllowanceClaimed {
        allowance_id: object::id(allowance),
        claimed_by: ctx.sender(),
        amount,
        total_spent: allowance.spent,
    });
}

fun assert_claimer<T>(allowance: &Allowance<T>, ctx: &TxContext) {
    let sender = ctx.sender();
    let ok =
        sender == allowance.payee ||
        sender == allowance.principal ||
        allowance.delegate.contains(&sender);
    assert!(ok, ENotAuthorized);
}

// ============================================
// CLAIMING (pull-based settlement)
// ============================================

/// Pull `amount` to the payee. Callable by the payee, the delegate, or the
/// principal. `amount` may not exceed the currently claimable amount
/// (`available_to_claim`), so it is bounded by entitlement, cap, and escrow.
/// Funds are transferred directly to the payee to prevent PTB interception.
public fun claim<T>(allowance: &mut Allowance<T>, amount: u64, clock: &Clock, ctx: &mut TxContext) {
    assert!(allowance.version == CURRENT_VERSION, EInvalidVersion);
    assert!(allowance.status == STATUS_ACTIVE, EInvalidState);
    assert_claimer(allowance, ctx);

    assert!(amount > 0, EInvalidParameter);
    let earned = entitled(allowance, clock.timestamp_ms());
    let unspent = if (earned > allowance.spent) { earned - allowance.spent } else { 0 };
    // Separate the terminal lifetime-cap limit from the transient rate-vesting
    // shortfall so a caller can tell "wait for accrual" from "cap reached".
    assert!(amount <= allowance.spend_cap - allowance.spent, ESpendCapExceeded);
    assert!(amount <= unspent, ENotYetVested);
    assert!(amount <= allowance.escrow.value(), EInsufficientBalance);

    pull_internal(allowance, amount, ctx);
}

/// Record a principal-signed cumulative spend voucher, raising the authorized
/// total. The signature alone authorizes this (anyone holding a valid voucher,
/// typically the payee, may submit it), mirroring Stripe Tempo's "submit the
/// highest voucher" model. The new total must strictly exceed the current one
/// and may not exceed the spend cap.
public fun authorize_spend<T>(
    allowance: &mut Allowance<T>,
    authorized_total: u64,
    voucher_signature: vector<u8>,
) {
    assert!(allowance.version == CURRENT_VERSION, EInvalidVersion);
    assert!(allowance.status == STATUS_ACTIVE, EInvalidState);
    assert!(authorized_total > allowance.authorized_total, EStaleAuthorization);
    assert!(authorized_total <= allowance.spend_cap, ESpendCapExceeded);
    assert!(
        signature::is_valid_public_key_length(
            allowance.principal_signature_type,
            &allowance.principal_public_key,
        ),
        EInvalidPublicKey,
    );

    let message = serialize_spend_authorization(object::id(allowance), authorized_total);
    assert!(
        signature::verify(
            allowance.principal_signature_type,
            &allowance.principal_public_key,
            &message,
            &voucher_signature,
        ),
        EInvalidSignature,
    );

    allowance.authorized_total = authorized_total;

    event::emit(SpendAuthorized {
        allowance_id: object::id(allowance),
        authorized_total,
    });
}

/// Convenience: record a voucher and immediately pull `amount`, in one call.
public fun claim_with_voucher<T>(
    allowance: &mut Allowance<T>,
    authorized_total: u64,
    voucher_signature: vector<u8>,
    amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    authorize_spend(allowance, authorized_total, voucher_signature);
    claim(allowance, amount, clock, ctx);
}

// ============================================
// PRINCIPAL CONTROLS
// ============================================

/// Add escrow to a live allowance. Unlike the tunnel deposit path, this works
/// while the allowance is active, so a long-running agent stream can be refueled
/// without reopening. Principal only.
public fun top_up<T>(allowance: &mut Allowance<T>, funds: Coin<T>, ctx: &TxContext) {
    assert!(allowance.version == CURRENT_VERSION, EInvalidVersion);
    assert!(allowance.status != STATUS_REVOKED, EInvalidState);
    assert!(ctx.sender() == allowance.principal, ENotAuthorized);
    assert!(funds.value() > 0, EInvalidParameter);

    let amount = funds.value();
    allowance.escrow.join(funds.into_balance());

    event::emit(AllowanceToppedUp {
        allowance_id: object::id(allowance),
        amount,
        new_escrow: allowance.escrow.value(),
    });
}

/// Change the streaming rate. Accrual to date is folded into the floor first, so
/// the change is purely forward-looking. Principal only.
public fun set_rate<T>(
    allowance: &mut Allowance<T>,
    new_rate_per_second: u64,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(allowance.version == CURRENT_VERSION, EInvalidVersion);
    assert!(allowance.status == STATUS_ACTIVE, EInvalidState);
    assert!(ctx.sender() == allowance.principal, ENotAuthorized);

    reanchor(allowance, clock.timestamp_ms());
    allowance.rate_per_second = new_rate_per_second;

    event::emit(AllowanceRateChanged {
        allowance_id: object::id(allowance),
        new_rate_per_second,
        vested_floor: allowance.vested_floor,
    });
}

/// Raise the lifetime spend cap. The cap can only increase; to reduce exposure
/// the principal revokes (which settles the payee fairly). Principal only.
public fun increase_cap<T>(allowance: &mut Allowance<T>, new_spend_cap: u64, ctx: &TxContext) {
    assert!(allowance.version == CURRENT_VERSION, EInvalidVersion);
    assert!(allowance.status != STATUS_REVOKED, EInvalidState);
    assert!(ctx.sender() == allowance.principal, ENotAuthorized);
    assert!(new_spend_cap > allowance.spend_cap, EInvalidParameter);

    allowance.spend_cap = new_spend_cap;

    event::emit(AllowanceCapIncreased {
        allowance_id: object::id(allowance),
        new_spend_cap,
    });
}

/// Freeze accrual and block claims until resumed. The interval spent paused does
/// not accrue. Principal only.
public fun pause<T>(allowance: &mut Allowance<T>, clock: &Clock, ctx: &TxContext) {
    assert!(allowance.version == CURRENT_VERSION, EInvalidVersion);
    assert!(allowance.status == STATUS_ACTIVE, EInvalidState);
    assert!(ctx.sender() == allowance.principal, ENotAuthorized);

    reanchor(allowance, clock.timestamp_ms());
    allowance.status = STATUS_PAUSED;

    event::emit(AllowancePaused {
        allowance_id: object::id(allowance),
        vested_floor: allowance.vested_floor,
    });
}

/// Resume a paused allowance. The anchor is reset to now, so the paused gap is
/// skipped rather than credited. Principal only.
public fun resume<T>(allowance: &mut Allowance<T>, clock: &Clock, ctx: &TxContext) {
    assert!(allowance.version == CURRENT_VERSION, EInvalidVersion);
    assert!(allowance.status == STATUS_PAUSED, EInvalidState);
    assert!(ctx.sender() == allowance.principal, ENotAuthorized);

    allowance.anchor_ms = clock.timestamp_ms();
    allowance.status = STATUS_ACTIVE;

    event::emit(AllowanceResumed {
        allowance_id: object::id(allowance),
        rate_per_second: allowance.rate_per_second,
    });
}

/// Set, rotate, or clear the delegate session key. Principal only.
public fun set_delegate<T>(
    allowance: &mut Allowance<T>,
    delegate: Option<address>,
    ctx: &TxContext,
) {
    assert!(allowance.version == CURRENT_VERSION, EInvalidVersion);
    assert!(allowance.status != STATUS_REVOKED, EInvalidState);
    assert!(ctx.sender() == allowance.principal, ENotAuthorized);
    delegate.do_ref!(
        |d| assert!(*d != allowance.principal && *d != allowance.payee, EInvalidParties),
    );

    allowance.delegate = delegate;

    event::emit(DelegateUpdated {
        allowance_id: object::id(allowance),
        delegate,
    });
}

/// Revoke the allowance. Settles the payee's earned-but-unclaimed amount first
/// (bounded by escrow), refunds the remainder to the principal, and marks the
/// allowance terminal. Principal only. Funds go out via direct transfer.
public fun revoke<T>(allowance: &mut Allowance<T>, clock: &Clock, ctx: &mut TxContext) {
    assert!(allowance.version == CURRENT_VERSION, EInvalidVersion);
    assert!(allowance.status != STATUS_REVOKED, EInvalidState);
    assert!(ctx.sender() == allowance.principal, ENotAuthorized);

    // Earned-but-unclaimed entitlement, independent of the ACTIVE/PAUSED gate.
    let earned = entitled(allowance, clock.timestamp_ms());
    let owed = if (earned > allowance.spent) { earned - allowance.spent } else { 0 };
    let payable = owed.min(allowance.escrow.value());

    if (payable > 0) {
        allowance.spent = allowance.spent + payable;
        let coin = coin::from_balance(allowance.escrow.split(payable), ctx);
        transfer::public_transfer(coin, allowance.payee);
    };

    let refund = allowance.escrow.value();
    if (refund > 0) {
        let coin = coin::from_balance(allowance.escrow.split(refund), ctx);
        transfer::public_transfer(coin, allowance.principal);
    };

    allowance.status = STATUS_REVOKED;

    event::emit(AllowanceRevoked {
        allowance_id: object::id(allowance),
        paid_to_payee: payable,
        refunded_to_principal: refund,
    });
}

// ============================================
// SERIALIZATION
// ============================================

/// Wire format a principal signs to authorize cumulative spend up to
/// `authorized_total`. Domain-separated and bound to the allowance id so a
/// voucher cannot be replayed across allowances. Must be reproduced byte-for-byte
/// by any off-chain signer (SDK).
public fun serialize_spend_authorization(allowance_id: ID, authorized_total: u64): vector<u8> {
    let mut result = b"sui_tunnel::spend_authorization";
    result.append(allowance_id.to_bytes());
    result.append(signature::u64_to_be_bytes(authorized_total));
    result
}

// ============================================
// VIEWS
// ============================================

/// Amount the payee can pull right now: `min(entitled - spent, escrow)`, or 0 if
/// the allowance is not active.
public fun available_to_claim<T>(allowance: &Allowance<T>, clock: &Clock): u64 {
    if (allowance.status != STATUS_ACTIVE) {
        return 0
    };
    let earned = entitled(allowance, clock.timestamp_ms());
    let unspent = if (earned > allowance.spent) { earned - allowance.spent } else { 0 };
    unspent.min(allowance.escrow.value())
}

/// Total entitlement accrued by `current_time_ms` (rate floor vs. voucher, capped).
public fun entitled_at<T>(allowance: &Allowance<T>, current_time_ms: u64): u64 {
    entitled(allowance, current_time_ms)
}

// ============================================
// ACCESSORS
// ============================================

/// The allowance's stored struct version.
public fun version<T>(allowance: &Allowance<T>): u64 { allowance.version }

public fun is_current_version<T>(allowance: &Allowance<T>): bool {
    allowance.version == CURRENT_VERSION
}

/// The funder who owns the escrow and may retune or revoke.
public fun principal<T>(allowance: &Allowance<T>): address { allowance.principal }

/// The sole recipient of every claim.
public fun payee<T>(allowance: &Allowance<T>): address { allowance.payee }

/// The optional session-key agent allowed to trigger claims.
public fun delegate<T>(allowance: &Allowance<T>): Option<address> { allowance.delegate }

/// The escrowed balance backing every claim.
public fun escrow_balance<T>(allowance: &Allowance<T>): u64 { allowance.escrow.value() }

/// The continuous accrual rate in base units per second.
public fun rate_per_second<T>(allowance: &Allowance<T>): u64 { allowance.rate_per_second }

/// The hard lifetime ceiling on cumulative spend.
public fun spend_cap<T>(allowance: &Allowance<T>): u64 { allowance.spend_cap }

/// The cumulative amount already pulled by the payee.
public fun spent<T>(allowance: &Allowance<T>): u64 { allowance.spent }

/// The highest cumulative amount authorized by a principal-signed voucher.
public fun authorized_total<T>(allowance: &Allowance<T>): u64 { allowance.authorized_total }

/// The absolute time (ms) at which rate accrual stops (0 = open-ended).
public fun expiry_ms<T>(allowance: &Allowance<T>): u64 { allowance.expiry_ms }

/// The lifecycle status code (see `status_active` / `status_paused` / `status_revoked`).
public fun status<T>(allowance: &Allowance<T>): u8 { allowance.status }

/// Whether the allowance is currently active.
public fun is_active<T>(allowance: &Allowance<T>): bool { allowance.status == STATUS_ACTIVE }

/// The creation timestamp (ms).
public fun created_at<T>(allowance: &Allowance<T>): u64 { allowance.created_at }

// ============================================
// ENTRY WRAPPERS
// ============================================

/// Entry wrapper for `create_and_share_allowance`.
entry fun entry_create_and_share<T>(
    payee: address,
    delegate: Option<address>,
    principal_public_key: vector<u8>,
    principal_signature_type: u8,
    funds: Coin<T>,
    rate_per_second: u64,
    spend_cap: u64,
    expiry_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    create_and_share_allowance<T>(
        payee,
        delegate,
        principal_public_key,
        principal_signature_type,
        funds,
        rate_per_second,
        spend_cap,
        expiry_ms,
        clock,
        ctx,
    );
}

/// Entry wrapper for `claim`.
entry fun entry_claim<T>(
    allowance: &mut Allowance<T>,
    amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    claim(allowance, amount, clock, ctx);
}

/// Entry wrapper for `claim_with_voucher`.
entry fun entry_claim_with_voucher<T>(
    allowance: &mut Allowance<T>,
    authorized_total: u64,
    voucher_signature: vector<u8>,
    amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    claim_with_voucher(allowance, authorized_total, voucher_signature, amount, clock, ctx);
}

/// Entry wrapper for `top_up`.
entry fun entry_top_up<T>(allowance: &mut Allowance<T>, funds: Coin<T>, ctx: &TxContext) {
    top_up(allowance, funds, ctx);
}

/// Entry wrapper for `revoke`.
entry fun entry_revoke<T>(allowance: &mut Allowance<T>, clock: &Clock, ctx: &mut TxContext) {
    revoke(allowance, clock, ctx);
}

// ============================================
// TEST HELPERS
// ============================================

#[test_only]
public fun destroy_for_testing<T>(allowance: Allowance<T>) {
    let Allowance { id, escrow, .. } = allowance;
    id.delete();
    escrow.destroy_for_testing();
}

#[test_only]
/// Build an allowance directly with a minted escrow, bypassing `create_allowance`
/// (which is sender-gated). The principal/payee/delegate are set verbatim.
public fun create_for_testing<T>(
    principal: address,
    payee: address,
    delegate: Option<address>,
    escrow_amount: u64,
    rate_per_second: u64,
    spend_cap: u64,
    expiry_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): Allowance<T> {
    let now = clock.timestamp_ms();
    Allowance<T> {
        id: object::new(ctx),
        version: CURRENT_VERSION,
        principal,
        payee,
        delegate,
        principal_public_key: vector[],
        principal_signature_type: signature::ed25519(),
        escrow: sui::balance::create_for_testing<T>(escrow_amount),
        rate_per_second,
        spend_cap,
        spent: 0,
        vested_floor: 0,
        anchor_ms: now,
        authorized_total: 0,
        expiry_ms,
        status: STATUS_ACTIVE,
        created_at: now,
    }
}

#[test_only]
/// Raise the authorized total without verifying a voucher signature, exercising
/// the voucher accounting (monotonic + cap bound) in isolation. Signature
/// verification is covered by the signature suites.
public fun authorize_spend_no_sig_for_testing<T>(
    allowance: &mut Allowance<T>,
    authorized_total: u64,
) {
    assert!(allowance.status == STATUS_ACTIVE, EInvalidState);
    assert!(authorized_total > allowance.authorized_total, EStaleAuthorization);
    assert!(authorized_total <= allowance.spend_cap, ESpendCapExceeded);
    allowance.authorized_total = authorized_total;
}
