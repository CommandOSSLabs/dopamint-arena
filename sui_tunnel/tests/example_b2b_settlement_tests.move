#[test_only]
module sui_tunnel::example_b2b_settlement_tests;

use std::unit_test::assert_eq;
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario;
use sui_tunnel::example_b2b_settlement;
use sui_tunnel::tunnel;

const BUYER: address = @0xB1;
const SELLER: address = @0x5E;
const ARBITER: address = @0xA2;
const PK_A: vector<u8> = x"1111111111111111111111111111111111111111111111111111111111111111";
const PK_B: vector<u8> = x"2222222222222222222222222222222222222222222222222222222222222222";
const TERMS_HASH: vector<u8> = x"3333333333333333333333333333333333333333333333333333333333333333";
const TIMEOUT_MS: u64 = 3600000;
const FUND_START_MS: u64 = 1000;

/// Creates a settlement (BUYER funds party A), then joins SELLER so the tunnel
/// activates. Leaves the sender as SELLER.
fun create_and_join(
    scenario: &mut test_scenario::Scenario,
    clock: &clock::Clock,
    deposit_buyer: u64,
    deposit_seller: u64,
): example_b2b_settlement::B2BSettlement<SUI> {
    let coin_a = coin::mint_for_testing<SUI>(deposit_buyer, scenario.ctx());
    let mut settlement = example_b2b_settlement::create_settlement<SUI>(
        SELLER,
        ARBITER,
        PK_A,
        PK_B,
        TERMS_HASH,
        coin_a,
        TIMEOUT_MS,
        clock,
        scenario.ctx(),
    );

    scenario.next_tx(SELLER);
    let coin_b = coin::mint_for_testing<SUI>(deposit_seller, scenario.ctx());
    example_b2b_settlement::seller_join<SUI>(&mut settlement, coin_b, clock, scenario.ctx());
    settlement
}

#[test]
fun status_constants() {
    assert_eq!(example_b2b_settlement::status_funded(), 0);
    assert_eq!(example_b2b_settlement::status_active(), 1);
    assert_eq!(example_b2b_settlement::status_disputed(), 2);
    assert_eq!(example_b2b_settlement::status_resolved(), 3);
    assert_eq!(example_b2b_settlement::status_force_closed(), 4);
    assert_eq!(example_b2b_settlement::status_cancelled(), 5);
    assert_eq!(example_b2b_settlement::result_pay_seller(), 0);
    assert_eq!(example_b2b_settlement::result_refund_buyer(), 1);
    assert_eq!(example_b2b_settlement::result_split(), 2);
    assert_eq!(example_b2b_settlement::settlement_timeout_ms(), TIMEOUT_MS);
}

#[test]
fun create_and_join_custodies_real_funds() {
    let mut scenario = test_scenario::begin(BUYER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(FUND_START_MS);

    let settlement = create_and_join(&mut scenario, &clock, 1000, 1000);

    assert_eq!(example_b2b_settlement::settlement_total_balance(&settlement), 2000);
    assert_eq!(
        example_b2b_settlement::settlement_status(&settlement),
        example_b2b_settlement::status_active(),
    );
    assert_eq!(example_b2b_settlement::settlement_buyer(&settlement), BUYER);
    assert_eq!(example_b2b_settlement::settlement_seller(&settlement), SELLER);
    assert_eq!(example_b2b_settlement::settlement_arbiter(&settlement), ARBITER);
    assert_eq!(*example_b2b_settlement::settlement_terms_hash(&settlement), TERMS_HASH);
    assert!(example_b2b_settlement::is_active(&settlement));

    let tun = example_b2b_settlement::settlement_tunnel(&settlement);
    assert!(tunnel::is_active(tun));
    assert!(tunnel::has_referee(tun));
    assert_eq!(tunnel::get_referee(tun), ARBITER);

    example_b2b_settlement::destroy_settlement_for_testing(settlement);
    clock.destroy_for_testing();
    scenario.end();
}

#[test]
fun cancel_settlement_refunds_buyer_before_seller_funds() {
    let mut scenario = test_scenario::begin(BUYER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(FUND_START_MS);

    // Buyer funds party A but the seller never joins, so the settlement is STATUS_FUNDED.
    let deposit = coin::mint_for_testing<SUI>(1000, scenario.ctx());
    let mut settlement = example_b2b_settlement::create_settlement<SUI>(
        SELLER,
        ARBITER,
        PK_A,
        PK_B,
        TERMS_HASH,
        deposit,
        TIMEOUT_MS,
        &clock,
        scenario.ctx(),
    );

    let refund = example_b2b_settlement::cancel_settlement(&mut settlement, &clock, scenario.ctx());
    assert_eq!(refund.value(), 1000);
    refund.burn_for_testing();

    assert_eq!(
        example_b2b_settlement::settlement_status(&settlement),
        example_b2b_settlement::status_cancelled(),
    );
    assert_eq!(example_b2b_settlement::settlement_total_balance(&settlement), 0);

    example_b2b_settlement::destroy_settlement_for_testing(settlement);
    clock.destroy_for_testing();
    scenario.end();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_b2b_settlement::EInvalidState,
        location = sui_tunnel::example_b2b_settlement,
    ),
]
fun cancel_settlement_after_active_aborts() {
    let mut scenario = test_scenario::begin(BUYER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(FUND_START_MS);

    let mut settlement = create_and_join(&mut scenario, &clock, 1000, 1000);

    // STATUS_ACTIVE, so the pre-activation cancel is rejected.
    scenario.next_tx(BUYER);
    let refund = example_b2b_settlement::cancel_settlement(&mut settlement, &clock, scenario.ctx());
    refund.burn_for_testing();

    abort
}

#[test]
fun arbiter_resolve_pay_seller_transfers_full_balance() {
    let mut scenario = test_scenario::begin(BUYER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(FUND_START_MS);

    let mut settlement = create_and_join(&mut scenario, &clock, 1000, 1000);
    example_b2b_settlement::open_dispute(&mut settlement, &clock, scenario.ctx());

    scenario.next_tx(ARBITER);
    example_b2b_settlement::arbiter_resolve(
        &mut settlement,
        example_b2b_settlement::result_pay_seller(),
        0,
        &clock,
        scenario.ctx(),
    );
    assert_eq!(
        example_b2b_settlement::settlement_status(&settlement),
        example_b2b_settlement::status_resolved(),
    );
    assert!(tunnel::is_closed(example_b2b_settlement::settlement_tunnel(&settlement)));

    scenario.next_tx(SELLER);
    let to_seller = scenario.take_from_address<coin::Coin<SUI>>(SELLER);
    assert_eq!(to_seller.value(), 2000);
    to_seller.burn_for_testing();

    scenario.next_tx(BUYER);
    let to_buyer = scenario.take_from_address<coin::Coin<SUI>>(BUYER);
    assert_eq!(to_buyer.value(), 0);
    to_buyer.burn_for_testing();

    example_b2b_settlement::destroy_settlement_for_testing(settlement);
    clock.destroy_for_testing();
    scenario.end();
}

#[test]
fun arbiter_resolve_refund_buyer_returns_full_balance() {
    let mut scenario = test_scenario::begin(BUYER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(FUND_START_MS);

    let mut settlement = create_and_join(&mut scenario, &clock, 1500, 500);
    example_b2b_settlement::open_dispute(&mut settlement, &clock, scenario.ctx());

    scenario.next_tx(ARBITER);
    example_b2b_settlement::arbiter_resolve(
        &mut settlement,
        example_b2b_settlement::result_refund_buyer(),
        0,
        &clock,
        scenario.ctx(),
    );

    scenario.next_tx(BUYER);
    let to_buyer = scenario.take_from_address<coin::Coin<SUI>>(BUYER);
    assert_eq!(to_buyer.value(), 2000);
    to_buyer.burn_for_testing();

    example_b2b_settlement::destroy_settlement_for_testing(settlement);
    clock.destroy_for_testing();
    scenario.end();
}

#[test]
fun arbiter_resolve_split_pays_agreed_share() {
    let mut scenario = test_scenario::begin(BUYER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(FUND_START_MS);

    let mut settlement = create_and_join(&mut scenario, &clock, 1000, 1000);
    example_b2b_settlement::open_dispute(&mut settlement, &clock, scenario.ctx());

    scenario.next_tx(ARBITER);
    example_b2b_settlement::arbiter_resolve(
        &mut settlement,
        example_b2b_settlement::result_split(),
        800,
        &clock,
        scenario.ctx(),
    );

    scenario.next_tx(BUYER);
    let to_buyer = scenario.take_from_address<coin::Coin<SUI>>(BUYER);
    assert_eq!(to_buyer.value(), 1200);
    to_buyer.burn_for_testing();

    scenario.next_tx(SELLER);
    let to_seller = scenario.take_from_address<coin::Coin<SUI>>(SELLER);
    assert_eq!(to_seller.value(), 800);
    to_seller.burn_for_testing();

    example_b2b_settlement::destroy_settlement_for_testing(settlement);
    clock.destroy_for_testing();
    scenario.end();
}

#[test]
fun settle_cooperatively_pays_split() {
    let mut scenario = test_scenario::begin(BUYER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(FUND_START_MS);

    let mut settlement = create_and_join(&mut scenario, &clock, 1000, 1000);

    scenario.next_tx(BUYER);
    example_b2b_settlement::settle_cooperatively_no_sig_for_testing(
        &mut settlement,
        700,
        1300,
        &clock,
        scenario.ctx(),
    );
    assert_eq!(
        example_b2b_settlement::settlement_status(&settlement),
        example_b2b_settlement::status_resolved(),
    );

    scenario.next_tx(BUYER);
    let to_buyer = scenario.take_from_address<coin::Coin<SUI>>(BUYER);
    assert_eq!(to_buyer.value(), 700);
    to_buyer.burn_for_testing();

    scenario.next_tx(SELLER);
    let to_seller = scenario.take_from_address<coin::Coin<SUI>>(SELLER);
    assert_eq!(to_seller.value(), 1300);
    to_seller.burn_for_testing();

    example_b2b_settlement::destroy_settlement_for_testing(settlement);
    clock.destroy_for_testing();
    scenario.end();
}

#[test]
fun force_close_fallback_returns_disputed_balances() {
    let mut scenario = test_scenario::begin(BUYER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(FUND_START_MS);

    let mut settlement = create_and_join(&mut scenario, &clock, 1000, 1000);

    // BUYER escalates so BUYER becomes the tunnel dispute_raiser.
    scenario.next_tx(BUYER);
    example_b2b_settlement::open_dispute(&mut settlement, &clock, scenario.ctx());
    assert!(!example_b2b_settlement::can_force_close(&settlement, &clock));

    clock.set_for_testing(FUND_START_MS + TIMEOUT_MS + 1);
    assert!(example_b2b_settlement::can_force_close(&settlement, &clock));

    example_b2b_settlement::force_close(&mut settlement, &clock, scenario.ctx());
    assert_eq!(
        example_b2b_settlement::settlement_status(&settlement),
        example_b2b_settlement::status_force_closed(),
    );

    scenario.next_tx(BUYER);
    let to_buyer = scenario.take_from_address<coin::Coin<SUI>>(BUYER);
    assert_eq!(to_buyer.value(), 1000);
    to_buyer.burn_for_testing();

    scenario.next_tx(SELLER);
    let to_seller = scenario.take_from_address<coin::Coin<SUI>>(SELLER);
    assert_eq!(to_seller.value(), 1000);
    to_seller.burn_for_testing();

    example_b2b_settlement::destroy_settlement_for_testing(settlement);
    clock.destroy_for_testing();
    scenario.end();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::tunnel::ERefereeNotAuthorized,
        location = sui_tunnel::tunnel,
    ),
]
fun non_arbiter_cannot_resolve() {
    let mut scenario = test_scenario::begin(BUYER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(FUND_START_MS);

    let mut settlement = create_and_join(&mut scenario, &clock, 1000, 1000);
    example_b2b_settlement::open_dispute(&mut settlement, &clock, scenario.ctx());

    // BUYER is a tunnel party but not the assigned arbiter.
    scenario.next_tx(BUYER);
    example_b2b_settlement::arbiter_resolve(
        &mut settlement,
        example_b2b_settlement::result_pay_seller(),
        0,
        &clock,
        scenario.ctx(),
    );

    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_b2b_settlement::EBalanceSumMismatch,
        location = sui_tunnel::example_b2b_settlement,
    ),
]
fun split_share_exceeding_total_aborts() {
    let mut scenario = test_scenario::begin(BUYER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(FUND_START_MS);

    let mut settlement = create_and_join(&mut scenario, &clock, 1000, 1000);
    example_b2b_settlement::open_dispute(&mut settlement, &clock, scenario.ctx());

    scenario.next_tx(ARBITER);
    example_b2b_settlement::arbiter_resolve(
        &mut settlement,
        example_b2b_settlement::result_split(),
        2001,
        &clock,
        scenario.ctx(),
    );

    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_b2b_settlement::EInvalidState,
        location = sui_tunnel::example_b2b_settlement,
    ),
]
fun cannot_resolve_before_dispute() {
    let mut scenario = test_scenario::begin(BUYER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(FUND_START_MS);

    let mut settlement = create_and_join(&mut scenario, &clock, 1000, 1000);

    scenario.next_tx(ARBITER);
    example_b2b_settlement::arbiter_resolve(
        &mut settlement,
        example_b2b_settlement::result_pay_seller(),
        0,
        &clock,
        scenario.ctx(),
    );

    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_b2b_settlement::EInvalidParameter,
        location = sui_tunnel::example_b2b_settlement,
    ),
]
fun unknown_result_code_aborts() {
    let mut scenario = test_scenario::begin(BUYER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(FUND_START_MS);

    let mut settlement = create_and_join(&mut scenario, &clock, 1000, 1000);
    example_b2b_settlement::open_dispute(&mut settlement, &clock, scenario.ctx());

    scenario.next_tx(ARBITER);
    example_b2b_settlement::arbiter_resolve(
        &mut settlement,
        99,
        0,
        &clock,
        scenario.ctx(),
    );

    abort
}

// The wrapper delegates the balance-sum invariant to the tunnel core, so a
// cooperative split whose amounts do not sum to the balance aborts inside the
// tunnel with its canonical EBalanceSumMismatch (not a wrapper-local code).
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::tunnel::EBalanceSumMismatch,
        location = sui_tunnel::tunnel,
    ),
]
fun cooperative_non_summing_amounts_aborts() {
    let mut scenario = test_scenario::begin(BUYER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(FUND_START_MS);

    let mut settlement = create_and_join(&mut scenario, &clock, 1000, 1000);

    scenario.next_tx(BUYER);
    example_b2b_settlement::settle_cooperatively_no_sig_for_testing(
        &mut settlement,
        1000,
        1001,
        &clock,
        scenario.ctx(),
    );

    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_b2b_settlement::EInvalidHash,
        location = sui_tunnel::example_b2b_settlement,
    ),
]
fun create_settlement_bad_terms_hash() {
    let mut scenario = test_scenario::begin(BUYER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(FUND_START_MS);

    let deposit = coin::mint_for_testing<SUI>(1000, scenario.ctx());
    let _settlement = example_b2b_settlement::create_settlement<SUI>(
        SELLER,
        ARBITER,
        PK_A,
        PK_B,
        b"too_short",
        deposit,
        TIMEOUT_MS,
        &clock,
        scenario.ctx(),
    );

    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_b2b_settlement::EInvalidParties,
        location = sui_tunnel::example_b2b_settlement,
    ),
]
fun create_settlement_same_party() {
    let mut scenario = test_scenario::begin(BUYER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(FUND_START_MS);

    let deposit = coin::mint_for_testing<SUI>(1000, scenario.ctx());
    // Buyer (the sender) is also named as the seller.
    let _settlement = example_b2b_settlement::create_settlement<SUI>(
        BUYER,
        ARBITER,
        PK_A,
        PK_B,
        TERMS_HASH,
        deposit,
        TIMEOUT_MS,
        &clock,
        scenario.ctx(),
    );

    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_b2b_settlement::EInvalidPublicKey,
        location = sui_tunnel::example_b2b_settlement,
    ),
]
fun create_settlement_empty_pk() {
    let mut scenario = test_scenario::begin(BUYER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(FUND_START_MS);

    let deposit = coin::mint_for_testing<SUI>(1000, scenario.ctx());
    let _settlement = example_b2b_settlement::create_settlement<SUI>(
        SELLER,
        ARBITER,
        b"",
        PK_B,
        TERMS_HASH,
        deposit,
        TIMEOUT_MS,
        &clock,
        scenario.ctx(),
    );

    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_b2b_settlement::EInvalidDepositAmount,
        location = sui_tunnel::example_b2b_settlement,
    ),
]
fun create_settlement_zero_deposit() {
    let mut scenario = test_scenario::begin(BUYER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(FUND_START_MS);

    let deposit = coin::mint_for_testing<SUI>(0, scenario.ctx());
    let _settlement = example_b2b_settlement::create_settlement<SUI>(
        SELLER,
        ARBITER,
        PK_A,
        PK_B,
        TERMS_HASH,
        deposit,
        TIMEOUT_MS,
        &clock,
        scenario.ctx(),
    );

    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_b2b_settlement::EInvalidState,
        location = sui_tunnel::example_b2b_settlement,
    ),
]
fun seller_join_when_active_aborts() {
    let mut scenario = test_scenario::begin(BUYER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(FUND_START_MS);

    let mut settlement = create_and_join(&mut scenario, &clock, 1000, 1000);

    // Already STATUS_ACTIVE, so a second seller_join is rejected.
    scenario.next_tx(SELLER);
    let more = coin::mint_for_testing<SUI>(100, scenario.ctx());
    example_b2b_settlement::seller_join<SUI>(&mut settlement, more, &clock, scenario.ctx());

    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_b2b_settlement::EInvalidState,
        location = sui_tunnel::example_b2b_settlement,
    ),
]
fun open_dispute_before_active_aborts() {
    let mut scenario = test_scenario::begin(BUYER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(FUND_START_MS);

    // Buyer funded but the seller has not joined, so the settlement is STATUS_FUNDED.
    let deposit = coin::mint_for_testing<SUI>(1000, scenario.ctx());
    let mut settlement = example_b2b_settlement::create_settlement<SUI>(
        SELLER,
        ARBITER,
        PK_A,
        PK_B,
        TERMS_HASH,
        deposit,
        TIMEOUT_MS,
        &clock,
        scenario.ctx(),
    );

    example_b2b_settlement::open_dispute(&mut settlement, &clock, scenario.ctx());

    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_b2b_settlement::EInvalidState,
        location = sui_tunnel::example_b2b_settlement,
    ),
]
fun force_close_before_dispute_aborts() {
    let mut scenario = test_scenario::begin(BUYER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(FUND_START_MS);

    let mut settlement = create_and_join(&mut scenario, &clock, 1000, 1000);

    // STATUS_ACTIVE, never disputed, so force_close is rejected.
    scenario.next_tx(BUYER);
    example_b2b_settlement::force_close(&mut settlement, &clock, scenario.ctx());

    abort
}
