#[test_only]
module sui_tunnel::example_agent_allowance_tests;

use std::unit_test::{assert_eq, destroy};
use sui::clock;
use sui::coin::{Self, Coin};
use sui::sui::SUI;
use sui::test_scenario;
use sui_tunnel::example_agent_allowance as allow;
use sui_tunnel::signature;

const PRINCIPAL: address = @0xA11CE;
const PAYEE: address = @0xB0B;
const DELEGATE: address = @0xDE1E;
const STRANGER: address = @0xBAD;

// A valid-length but non-curve ed25519 public key, used to drive the voucher
// signature-verification failure path. (An all-zero key + all-zero signature is a
// known ed25519 low-order forgery that verifies, so the bytes must be non-trivial.)
const BOGUS_PK: vector<u8> = x"0101010101010101010101010101010101010101010101010101010101010101";

// ============================================
// CONSTANT GETTERS
// ============================================

#[test]
fun status_constants() {
    assert_eq!(allow::status_active(), 0);
    assert_eq!(allow::status_paused(), 1);
    assert_eq!(allow::status_revoked(), 2);
    assert_eq!(allow::current_version(), 1);
}

// ============================================
// ACCRUAL CURVE (rate-based vesting)
// ============================================

/// Rate accrual is linear in elapsed seconds, clamped to the cap, and the
/// claimable amount is additionally bounded by escrow. Values are read from the
/// module's own `entitled_at` / `available_to_claim`, not recomputed inline.
#[test]
fun rate_accrual_curve() {
    let mut ctx = sui::tx_context::dummy();
    let mut c = clock::create_for_testing(&mut ctx);
    c.set_for_testing(0);

    // 100 base units/sec, cap 10_000, escrow 10_000, open-ended.
    let a = allow::create_for_testing<SUI>(
        PRINCIPAL,
        PAYEE,
        option::none(),
        10_000,
        100,
        10_000,
        0,
        &c,
        &mut ctx,
    );

    // t=0 -> nothing vested.
    assert_eq!(allow::entitled_at(&a, 0), 0);
    assert_eq!(allow::available_to_claim(&a, &c), 0);

    // t=5s -> 500 vested and claimable.
    c.set_for_testing(5_000);
    assert_eq!(allow::entitled_at(&a, 5_000), 500);
    assert_eq!(allow::available_to_claim(&a, &c), 500);

    // Past the cap horizon -> clamped at the cap (also fully escrowed).
    c.set_for_testing(200_000);
    assert_eq!(allow::entitled_at(&a, 200_000), 10_000);
    assert_eq!(allow::available_to_claim(&a, &c), 10_000);

    destroy(a);
    c.destroy_for_testing();
}

/// When escrow is smaller than vested entitlement, the claimable amount is capped
/// at the escrowed balance (underfunded stream).
#[test]
fun available_is_bounded_by_escrow() {
    let mut ctx = sui::tx_context::dummy();
    let mut c = clock::create_for_testing(&mut ctx);
    c.set_for_testing(0);

    let a = allow::create_for_testing<SUI>(
        PRINCIPAL,
        PAYEE,
        option::none(),
        300, // escrow underfunds the rate
        100,
        10_000,
        0,
        &c,
        &mut ctx,
    );

    c.set_for_testing(5_000); // 500 vested by rate, but only 300 escrowed
    assert_eq!(allow::entitled_at(&a, 5_000), 500);
    assert_eq!(allow::available_to_claim(&a, &c), 300);

    destroy(a);
    c.destroy_for_testing();
}

/// An expiry stops rate accrual at the deadline regardless of later time.
#[test]
fun expiry_caps_accrual() {
    let mut ctx = sui::tx_context::dummy();
    let mut c = clock::create_for_testing(&mut ctx);
    c.set_for_testing(0);

    let a = allow::create_for_testing<SUI>(
        PRINCIPAL,
        PAYEE,
        option::none(),
        10_000,
        100,
        10_000,
        3_000, // expires at t=3s -> max 300 accrues
        &c,
        &mut ctx,
    );

    c.set_for_testing(5_000);
    assert_eq!(allow::entitled_at(&a, 5_000), 300);

    destroy(a);
    c.destroy_for_testing();
}

// ============================================
// VOUCHER ENTITLEMENT (usage-metered)
// ============================================

/// With no rate, a recorded voucher authorizes spend up to its cumulative total
/// (bounded by the cap); entitlement is the greater of rate-vested and voucher.
#[test]
fun voucher_entitlement_and_max_with_rate() {
    let mut ctx = sui::tx_context::dummy();
    let mut c = clock::create_for_testing(&mut ctx);
    c.set_for_testing(0);

    // Rate 100/sec so we can show max(rate, voucher).
    let mut a = allow::create_for_testing<SUI>(
        PRINCIPAL,
        PAYEE,
        option::none(),
        10_000,
        100,
        10_000,
        0,
        &c,
        &mut ctx,
    );

    c.set_for_testing(5_000); // rate-vested = 500

    // Voucher below the rate floor does not reduce entitlement.
    allow::authorize_spend_no_sig_for_testing(&mut a, 300);
    assert_eq!(allow::entitled_at(&a, 5_000), 500);

    // Voucher above the rate floor raises entitlement.
    allow::authorize_spend_no_sig_for_testing(&mut a, 900);
    assert_eq!(allow::entitled_at(&a, 5_000), 900);
    assert_eq!(allow::authorized_total(&a), 900);

    destroy(a);
    c.destroy_for_testing();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_agent_allowance::EStaleAuthorization,
        location = sui_tunnel::example_agent_allowance,
    ),
]
fun voucher_must_increase() {
    let mut ctx = sui::tx_context::dummy();
    let c = clock::create_for_testing(&mut ctx);
    let mut a = allow::create_for_testing<SUI>(
        PRINCIPAL,
        PAYEE,
        option::none(),
        10_000,
        0,
        10_000,
        0,
        &c,
        &mut ctx,
    );
    allow::authorize_spend_no_sig_for_testing(&mut a, 500);
    // Not strictly greater than the current 500 -> aborts.
    allow::authorize_spend_no_sig_for_testing(&mut a, 500);
    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_agent_allowance::ESpendCapExceeded,
        location = sui_tunnel::example_agent_allowance,
    ),
]
fun voucher_cannot_exceed_cap() {
    let mut ctx = sui::tx_context::dummy();
    let c = clock::create_for_testing(&mut ctx);
    let mut a = allow::create_for_testing<SUI>(
        PRINCIPAL,
        PAYEE,
        option::none(),
        10_000,
        0,
        1_000, // cap
        0,
        &c,
        &mut ctx,
    );
    allow::authorize_spend_no_sig_for_testing(&mut a, 1_001);
    abort
}

// ============================================
// PAUSED / REVOKED views
// ============================================

#[test]
fun no_claimable_when_not_active() {
    let mut ctx = sui::tx_context::dummy();
    let mut c = clock::create_for_testing(&mut ctx);
    c.set_for_testing(0);
    let mut a = allow::create_for_testing<SUI>(
        PRINCIPAL,
        PAYEE,
        option::none(),
        10_000,
        100,
        10_000,
        0,
        &c,
        &mut ctx,
    );
    c.set_for_testing(5_000);
    assert_eq!(allow::available_to_claim(&a, &c), 500);

    // Pausing (principal) freezes claims.
    let mut scenario = test_scenario::begin(PRINCIPAL);
    allow::pause(&mut a, &c, scenario.ctx());
    assert_eq!(allow::status(&a), allow::status_paused());
    assert_eq!(allow::available_to_claim(&a, &c), 0);

    destroy(a);
    c.destroy_for_testing();
    scenario.end();
}

// ============================================
// CLAIMING (pull-based) + authorization
// ============================================

/// The payee pulls the rate-vested amount; the exact amount is transferred to the
/// payee, `spent` advances, and escrow shrinks.
#[test]
fun payee_claims_vested_amount() {
    let mut scenario = test_scenario::begin(PRINCIPAL);
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(0);

    let mut a = allow::create_for_testing<SUI>(
        PRINCIPAL,
        PAYEE,
        option::none(),
        10_000,
        100,
        10_000,
        0,
        &c,
        scenario.ctx(),
    );

    c.set_for_testing(5_000); // 500 vested
    scenario.next_tx(PAYEE);
    {
        let avail = allow::available_to_claim(&a, &c);
        assert_eq!(avail, 500);
        allow::claim(&mut a, 500, &c, scenario.ctx());
        assert_eq!(allow::spent(&a), 500);
        assert_eq!(allow::escrow_balance(&a), 9_500);
    };

    scenario.next_tx(PAYEE);
    {
        let coin = scenario.take_from_address<Coin<SUI>>(PAYEE);
        assert_eq!(coin.value(), 500);
        destroy(coin);
    };

    destroy(a);
    c.destroy_for_testing();
    scenario.end();
}

/// A delegate session key may trigger a claim, and funds still flow to the payee.
#[test]
fun delegate_claims_to_payee() {
    let mut scenario = test_scenario::begin(PRINCIPAL);
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(0);

    let mut a = allow::create_for_testing<SUI>(
        PRINCIPAL,
        PAYEE,
        option::some(DELEGATE),
        10_000,
        100,
        10_000,
        0,
        &c,
        scenario.ctx(),
    );

    c.set_for_testing(10_000); // 1000 vested
    scenario.next_tx(DELEGATE);
    allow::claim(&mut a, 1_000, &c, scenario.ctx());

    scenario.next_tx(PAYEE);
    {
        let coin = scenario.take_from_address<Coin<SUI>>(PAYEE);
        assert_eq!(coin.value(), 1_000);
        destroy(coin);
    };

    destroy(a);
    c.destroy_for_testing();
    scenario.end();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_agent_allowance::ENotAuthorized,
        location = sui_tunnel::example_agent_allowance,
    ),
]
fun stranger_cannot_claim() {
    let mut scenario = test_scenario::begin(PRINCIPAL);
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(0);
    let mut a = allow::create_for_testing<SUI>(
        PRINCIPAL,
        PAYEE,
        option::none(),
        10_000,
        100,
        10_000,
        0,
        &c,
        scenario.ctx(),
    );
    c.set_for_testing(5_000);
    scenario.next_tx(STRANGER);
    allow::claim(&mut a, 100, &c, scenario.ctx());
    abort
}

/// Claiming above the vested/cap entitlement (while escrow is ample) reports the
/// entitlement cause, not an escrow shortfall.
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_agent_allowance::ENotYetVested,
        location = sui_tunnel::example_agent_allowance,
    ),
]
fun cannot_claim_more_than_vested() {
    let mut scenario = test_scenario::begin(PRINCIPAL);
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(0);
    let mut a = allow::create_for_testing<SUI>(
        PRINCIPAL,
        PAYEE,
        option::none(),
        10_000,
        100,
        10_000,
        0,
        &c,
        scenario.ctx(),
    );
    c.set_for_testing(5_000); // only 500 vested, escrow 10_000 is ample
    scenario.next_tx(PAYEE);
    allow::claim(&mut a, 501, &c, scenario.ctx());
    abort
}

/// Claiming past the lifetime cap (even with funds fully vested and escrowed)
/// aborts with the cap error, distinct from the vesting shortfall above.
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_agent_allowance::ESpendCapExceeded,
        location = sui_tunnel::example_agent_allowance,
    ),
]
fun cannot_claim_more_than_cap() {
    let mut scenario = test_scenario::begin(PRINCIPAL);
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(0);
    let mut a = allow::create_for_testing<SUI>(
        PRINCIPAL,
        PAYEE,
        option::none(),
        10_000, // ample escrow
        1_000, // fast rate so vesting is not the binding limit
        500, // hard lifetime cap binds the entitlement
        0,
        &c,
        scenario.ctx(),
    );
    c.set_for_testing(5_000); // rate would vest 5_000, but the 500 cap holds
    scenario.next_tx(PAYEE);
    allow::claim(&mut a, 501, &c, scenario.ctx());
    abort
}

/// A zero-amount claim is rejected as an invalid parameter.
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_agent_allowance::EInvalidParameter,
        location = sui_tunnel::example_agent_allowance,
    ),
]
fun cannot_claim_zero() {
    let mut scenario = test_scenario::begin(PRINCIPAL);
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(0);
    let mut a = allow::create_for_testing<SUI>(
        PRINCIPAL,
        PAYEE,
        option::none(),
        10_000,
        100,
        10_000,
        0,
        &c,
        scenario.ctx(),
    );
    c.set_for_testing(5_000);
    scenario.next_tx(PAYEE);
    allow::claim(&mut a, 0, &c, scenario.ctx());
    abort
}

/// When entitlement exceeds escrow, a claim above the escrowed balance reports the
/// escrow shortfall rather than the entitlement.
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_agent_allowance::EInsufficientBalance,
        location = sui_tunnel::example_agent_allowance,
    ),
]
fun cannot_claim_more_than_escrow() {
    let mut scenario = test_scenario::begin(PRINCIPAL);
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(0);
    let mut a = allow::create_for_testing<SUI>(
        PRINCIPAL,
        PAYEE,
        option::none(),
        300, // escrow underfunds the vested entitlement
        100,
        10_000,
        0,
        &c,
        scenario.ctx(),
    );
    c.set_for_testing(5_000); // 500 vested, but only 300 escrowed
    scenario.next_tx(PAYEE);
    allow::claim(&mut a, 400, &c, scenario.ctx());
    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_agent_allowance::EInvalidState,
        location = sui_tunnel::example_agent_allowance,
    ),
]
fun cannot_claim_when_paused() {
    let mut scenario = test_scenario::begin(PRINCIPAL);
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(0);
    let mut a = allow::create_for_testing<SUI>(
        PRINCIPAL,
        PAYEE,
        option::none(),
        10_000,
        100,
        10_000,
        0,
        &c,
        scenario.ctx(),
    );
    c.set_for_testing(5_000);
    allow::pause(&mut a, &c, scenario.ctx());
    scenario.next_tx(PAYEE);
    allow::claim(&mut a, 100, &c, scenario.ctx());
    abort
}

// ============================================
// PRINCIPAL CONTROLS
// ============================================

/// Top-up adds escrow while the allowance is active (unlike the tunnel deposit path).
#[test]
fun top_up_adds_escrow_while_active() {
    let mut scenario = test_scenario::begin(PRINCIPAL);
    let c = clock::create_for_testing(scenario.ctx());
    let mut a = allow::create_for_testing<SUI>(
        PRINCIPAL,
        PAYEE,
        option::none(),
        1_000,
        100,
        100_000,
        0,
        &c,
        scenario.ctx(),
    );
    let extra = coin::mint_for_testing<SUI>(5_000, scenario.ctx());
    allow::top_up(&mut a, extra, scenario.ctx());
    assert_eq!(allow::escrow_balance(&a), 6_000);

    destroy(a);
    c.destroy_for_testing();
    scenario.end();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_agent_allowance::ENotAuthorized,
        location = sui_tunnel::example_agent_allowance,
    ),
]
fun top_up_by_non_principal_fails() {
    let mut scenario = test_scenario::begin(PRINCIPAL);
    let c = clock::create_for_testing(scenario.ctx());
    let mut a = allow::create_for_testing<SUI>(
        PRINCIPAL,
        PAYEE,
        option::none(),
        1_000,
        100,
        100_000,
        0,
        &c,
        scenario.ctx(),
    );
    scenario.next_tx(STRANGER);
    let extra = coin::mint_for_testing<SUI>(5_000, scenario.ctx());
    allow::top_up(&mut a, extra, scenario.ctx());
    abort
}

/// Changing the rate folds accrual-to-date into the floor; subsequent accrual uses
/// the new rate from the change point.
#[test]
fun set_rate_folds_and_changes_forward() {
    let mut scenario = test_scenario::begin(PRINCIPAL);
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(0);
    let mut a = allow::create_for_testing<SUI>(
        PRINCIPAL,
        PAYEE,
        option::none(),
        100_000,
        100,
        100_000,
        0,
        &c,
        scenario.ctx(),
    );
    // 5s at 100/sec -> 500 folded.
    c.set_for_testing(5_000);
    allow::set_rate(&mut a, 200, &c, scenario.ctx());
    assert_eq!(allow::entitled_at(&a, 5_000), 500);
    // 5 more seconds at 200/sec -> 500 + 1000 = 1500.
    assert_eq!(allow::entitled_at(&a, 10_000), 1_500);

    destroy(a);
    c.destroy_for_testing();
    scenario.end();
}

#[test]
fun increase_cap_raises_ceiling() {
    let mut scenario = test_scenario::begin(PRINCIPAL);
    let c = clock::create_for_testing(scenario.ctx());
    let mut a = allow::create_for_testing<SUI>(
        PRINCIPAL,
        PAYEE,
        option::none(),
        10_000,
        100,
        1_000,
        0,
        &c,
        scenario.ctx(),
    );
    allow::increase_cap(&mut a, 5_000, scenario.ctx());
    assert_eq!(allow::spend_cap(&a), 5_000);

    destroy(a);
    c.destroy_for_testing();
    scenario.end();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_agent_allowance::EInvalidParameter,
        location = sui_tunnel::example_agent_allowance,
    ),
]
fun cap_cannot_decrease() {
    let mut scenario = test_scenario::begin(PRINCIPAL);
    let c = clock::create_for_testing(scenario.ctx());
    let mut a = allow::create_for_testing<SUI>(
        PRINCIPAL,
        PAYEE,
        option::none(),
        10_000,
        100,
        1_000,
        0,
        &c,
        scenario.ctx(),
    );
    allow::increase_cap(&mut a, 999, scenario.ctx());
    abort
}

/// The paused interval does not accrue: resume re-anchors so only active time counts.
#[test]
fun pause_resume_skips_idle_interval() {
    let mut scenario = test_scenario::begin(PRINCIPAL);
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(0);
    let mut a = allow::create_for_testing<SUI>(
        PRINCIPAL,
        PAYEE,
        option::none(),
        100_000,
        100,
        100_000,
        0,
        &c,
        scenario.ctx(),
    );
    c.set_for_testing(5_000); // 500 vested
    allow::pause(&mut a, &c, scenario.ctx());
    c.set_for_testing(105_000); // 100s paused — must NOT accrue
    allow::resume(&mut a, &c, scenario.ctx());
    assert_eq!(allow::entitled_at(&a, 105_000), 500);
    // 5 more active seconds -> 1000.
    assert_eq!(allow::entitled_at(&a, 110_000), 1_000);

    destroy(a);
    c.destroy_for_testing();
    scenario.end();
}

/// Delegate can be rotated and cleared by the principal.
#[test]
fun set_delegate_rotates_and_clears() {
    let mut scenario = test_scenario::begin(PRINCIPAL);
    let c = clock::create_for_testing(scenario.ctx());
    let mut a = allow::create_for_testing<SUI>(
        PRINCIPAL,
        PAYEE,
        option::none(),
        10_000,
        100,
        10_000,
        0,
        &c,
        scenario.ctx(),
    );
    let d = DELEGATE;
    allow::set_delegate(&mut a, option::some(d), scenario.ctx());
    assert!(allow::delegate(&a).contains(&d));
    allow::set_delegate(&mut a, option::none(), scenario.ctx());
    assert!(allow::delegate(&a).is_none());

    destroy(a);
    c.destroy_for_testing();
    scenario.end();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_agent_allowance::ENotAuthorized,
        location = sui_tunnel::example_agent_allowance,
    ),
]
fun set_delegate_by_non_principal_fails() {
    let mut scenario = test_scenario::begin(PRINCIPAL);
    let c = clock::create_for_testing(scenario.ctx());
    let mut a = allow::create_for_testing<SUI>(
        PRINCIPAL,
        PAYEE,
        option::none(),
        10_000,
        100,
        10_000,
        0,
        &c,
        scenario.ctx(),
    );
    scenario.next_tx(STRANGER);
    allow::set_delegate(&mut a, option::some(DELEGATE), scenario.ctx());
    abort
}

// ============================================
// REVOCATION
// ============================================

/// Revoke settles the payee's earned-but-unclaimed amount first, then refunds the
/// remainder to the principal, and marks the allowance terminal.
#[test]
fun revoke_settles_payee_then_refunds_principal() {
    let mut scenario = test_scenario::begin(PRINCIPAL);
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(0);
    let mut a = allow::create_for_testing<SUI>(
        PRINCIPAL,
        PAYEE,
        option::none(),
        10_000,
        100,
        10_000,
        0,
        &c,
        scenario.ctx(),
    );
    c.set_for_testing(5_000); // 500 earned by the payee
    allow::revoke(&mut a, &c, scenario.ctx());
    assert_eq!(allow::status(&a), allow::status_revoked());
    assert_eq!(allow::escrow_balance(&a), 0);

    // Payee received the 500 earned.
    scenario.next_tx(PAYEE);
    {
        let coin = scenario.take_from_address<Coin<SUI>>(PAYEE);
        assert_eq!(coin.value(), 500);
        destroy(coin);
    };
    // Principal received the 9_500 refund.
    scenario.next_tx(PRINCIPAL);
    {
        let coin = scenario.take_from_address<Coin<SUI>>(PRINCIPAL);
        assert_eq!(coin.value(), 9_500);
        destroy(coin);
    };

    destroy(a);
    c.destroy_for_testing();
    scenario.end();
}

/// Revoking a PAUSED allowance must settle only the amount earned BEFORE the
/// pause; the paused interval does not accrue even though revoke bypasses the
/// active claim guard.
#[test]
fun revoke_while_paused_excludes_idle_interval() {
    let mut scenario = test_scenario::begin(PRINCIPAL);
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(0);
    let mut a = allow::create_for_testing<SUI>(
        PRINCIPAL,
        PAYEE,
        option::none(),
        10_000,
        100,
        10_000,
        0,
        &c,
        scenario.ctx(),
    );
    c.set_for_testing(5_000); // 500 earned
    allow::pause(&mut a, &c, scenario.ctx());
    c.set_for_testing(105_000); // 100s paused — must NOT accrue
    allow::revoke(&mut a, &c, scenario.ctx());

    scenario.next_tx(PAYEE);
    {
        let coin = scenario.take_from_address<Coin<SUI>>(PAYEE);
        assert_eq!(coin.value(), 500); // only the pre-pause earning, not paused time
        destroy(coin);
    };
    scenario.next_tx(PRINCIPAL);
    {
        let coin = scenario.take_from_address<Coin<SUI>>(PRINCIPAL);
        assert_eq!(coin.value(), 9_500);
        destroy(coin);
    };

    destroy(a);
    c.destroy_for_testing();
    scenario.end();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_agent_allowance::EInvalidState,
        location = sui_tunnel::example_agent_allowance,
    ),
]
fun cannot_revoke_twice() {
    let mut scenario = test_scenario::begin(PRINCIPAL);
    let c = clock::create_for_testing(scenario.ctx());
    let mut a = allow::create_for_testing<SUI>(
        PRINCIPAL,
        PAYEE,
        option::none(),
        10_000,
        100,
        10_000,
        0,
        &c,
        scenario.ctx(),
    );
    allow::revoke(&mut a, &c, scenario.ctx());
    allow::revoke(&mut a, &c, scenario.ctx());
    abort
}

// ============================================
// CREATE VALIDATION
// ============================================

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_agent_allowance::EInvalidParties,
        location = sui_tunnel::example_agent_allowance,
    ),
]
fun create_rejects_self_payee() {
    let mut scenario = test_scenario::begin(PRINCIPAL);
    let c = clock::create_for_testing(scenario.ctx());
    let funds = coin::mint_for_testing<SUI>(1_000, scenario.ctx());
    let a = allow::create_allowance<SUI>(
        PRINCIPAL, // payee == principal
        option::none(),
        b"",
        signature::ed25519(),
        funds,
        100,
        1_000,
        0,
        &c,
        scenario.ctx(),
    );
    destroy(a);
    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_agent_allowance::EInvalidParameter,
        location = sui_tunnel::example_agent_allowance,
    ),
]
fun create_rejects_zero_cap() {
    let mut scenario = test_scenario::begin(PRINCIPAL);
    let c = clock::create_for_testing(scenario.ctx());
    let funds = coin::mint_for_testing<SUI>(1_000, scenario.ctx());
    let a = allow::create_allowance<SUI>(
        PAYEE,
        option::none(),
        b"",
        signature::ed25519(),
        funds,
        100,
        0, // zero cap
        0,
        &c,
        scenario.ctx(),
    );
    destroy(a);
    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_agent_allowance::EInvalidParameter,
        location = sui_tunnel::example_agent_allowance,
    ),
]
fun create_rejects_expired_deadline() {
    let mut scenario = test_scenario::begin(PRINCIPAL);
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(10_000);
    let funds = coin::mint_for_testing<SUI>(1_000, scenario.ctx());
    let a = allow::create_allowance<SUI>(
        PAYEE,
        option::none(),
        b"",
        signature::ed25519(),
        funds,
        100,
        1_000,
        5_000, // expiry already in the past
        &c,
        scenario.ctx(),
    );
    destroy(a);
    abort
}

// ============================================
// VOUCHER SIGNATURE PATH
// ============================================

/// An empty principal public key cannot verify a voucher.
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_agent_allowance::EInvalidPublicKey,
        location = sui_tunnel::example_agent_allowance,
    ),
]
fun authorize_spend_rejects_empty_pubkey() {
    let mut ctx = sui::tx_context::dummy();
    let c = clock::create_for_testing(&mut ctx);
    let mut a = allow::create_for_testing<SUI>(
        PRINCIPAL,
        PAYEE,
        option::none(),
        10_000,
        0,
        10_000,
        0,
        &c,
        &mut ctx,
    );
    // create_for_testing leaves the principal public key empty.
    allow::authorize_spend(&mut a, 500, x"00");
    abort
}

/// A bogus signature against a valid-length key fails verification.
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_agent_allowance::EInvalidSignature,
        location = sui_tunnel::example_agent_allowance,
    ),
]
fun authorize_spend_rejects_bad_signature() {
    let mut scenario = test_scenario::begin(PRINCIPAL);
    let c = clock::create_for_testing(scenario.ctx());
    let funds = coin::mint_for_testing<SUI>(10_000, scenario.ctx());
    let mut a = allow::create_allowance<SUI>(
        PAYEE,
        option::none(),
        BOGUS_PK,
        signature::ed25519(),
        funds,
        0,
        10_000,
        0,
        &c,
        scenario.ctx(),
    );
    // A well-formed-length but invalid ed25519 signature that cannot verify.
    let bad_sig =
        x"02020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202020202";
    allow::authorize_spend(&mut a, 500, bad_sig);
    destroy(a);
    abort
}

// ============================================
// WIRE FORMAT
// ============================================

/// The voucher message is domain-separated and bound to the allowance id, so it
/// cannot be replayed across allowances. Prefix + 32-byte id + 8-byte total.
#[test]
fun spend_authorization_wire_format() {
    // Asserts the Move-side serialization against an inline golden. The SDK's
    // `serializeSpendAuthorization` (core/wire.ts) carries the byte-identical
    // `G_SPEND_AUTH` golden (core/wire.test.ts), cross-checking cross-language parity.
    let id = object::id_from_address(@0xab);
    let msg = allow::serialize_spend_authorization(id, 1_000);
    let golden =
        x"7375695f74756e6e656c3a3a7370656e645f617574686f72697a6174696f6e00000000000000000000000000000000000000000000000000000000000000ab00000000000003e8";
    assert_eq!(msg, golden);
}

// ============================================
// VOUCHER-DRIVEN CLAIM + REMAINING EDGES
// ============================================

/// With no rate, a recorded voucher is the sole entitlement source and the payee
/// can pull exactly the authorized amount. (Uses the no-sig helper; real signature
/// verification is covered by `authorize_spend_rejects_bad_signature` and the
/// signature suites — the signed message binds a fresh object id, so a positive
/// signature vector cannot be precomputed for a unit test.)
#[test]
fun voucher_authorizes_then_payee_claims() {
    let mut scenario = test_scenario::begin(PRINCIPAL);
    let c = clock::create_for_testing(scenario.ctx());
    let mut a = allow::create_for_testing<SUI>(
        PRINCIPAL,
        PAYEE,
        option::none(),
        1_000,
        0, // no rate: voucher is the only entitlement
        1_000,
        0,
        &c,
        scenario.ctx(),
    );
    allow::authorize_spend_no_sig_for_testing(&mut a, 700);
    assert_eq!(allow::available_to_claim(&a, &c), 700);

    scenario.next_tx(PAYEE);
    allow::claim(&mut a, 700, &c, scenario.ctx());
    assert_eq!(allow::spent(&a), 700);

    scenario.next_tx(PAYEE);
    {
        let coin = scenario.take_from_address<Coin<SUI>>(PAYEE);
        assert_eq!(coin.value(), 700);
        destroy(coin);
    };

    destroy(a);
    c.destroy_for_testing();
    scenario.end();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_agent_allowance::EInvalidParties,
        location = sui_tunnel::example_agent_allowance,
    ),
]
fun set_delegate_rejects_payee() {
    let mut scenario = test_scenario::begin(PRINCIPAL);
    let c = clock::create_for_testing(scenario.ctx());
    let mut a = allow::create_for_testing<SUI>(
        PRINCIPAL,
        PAYEE,
        option::none(),
        10_000,
        100,
        10_000,
        0,
        &c,
        scenario.ctx(),
    );
    allow::set_delegate(&mut a, option::some(PAYEE), scenario.ctx());
    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_agent_allowance::EInvalidParties,
        location = sui_tunnel::example_agent_allowance,
    ),
]
fun set_delegate_rejects_principal() {
    let mut scenario = test_scenario::begin(PRINCIPAL);
    let c = clock::create_for_testing(scenario.ctx());
    let mut a = allow::create_for_testing<SUI>(
        PRINCIPAL,
        PAYEE,
        option::none(),
        10_000,
        100,
        10_000,
        0,
        &c,
        scenario.ctx(),
    );
    allow::set_delegate(&mut a, option::some(PRINCIPAL), scenario.ctx());
    abort
}

/// Resuming after the expiry deadline credits no further accrual: entitlement
/// stays frozen at the amount earned before expiry.
#[test]
fun resume_after_expiry_does_not_accrue() {
    let mut scenario = test_scenario::begin(PRINCIPAL);
    let mut c = clock::create_for_testing(scenario.ctx());
    c.set_for_testing(0);
    let mut a = allow::create_for_testing<SUI>(
        PRINCIPAL,
        PAYEE,
        option::none(),
        10_000,
        100,
        10_000,
        3_000, // expires at t=3s
        &c,
        scenario.ctx(),
    );
    c.set_for_testing(2_000); // 200 earned
    allow::pause(&mut a, &c, scenario.ctx());
    c.set_for_testing(10_000); // resume well past expiry
    allow::resume(&mut a, &c, scenario.ctx());
    assert_eq!(allow::entitled_at(&a, 10_000), 200);
    assert_eq!(allow::entitled_at(&a, 50_000), 200);

    destroy(a);
    c.destroy_for_testing();
    scenario.end();
}
