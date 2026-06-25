#[test_only]
module sui_tunnel::example_agent_micropayments_tests;

use std::unit_test::assert_eq;
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario;
use sui_tunnel::example_agent_micropayments;

const CONSUMER: address = @0xC0;
const PROVIDER: address = @0xB0B;
const STRANGER: address = @0x5EED;
const PK_A: vector<u8> = x"0000000000000000000000000000000000000000000000000000000000000001";
const PK_B: vector<u8> = x"0000000000000000000000000000000000000000000000000000000000000002";

#[test]
fun status_constants() {
    assert_eq!(example_agent_micropayments::channel_active(), 0);
    assert_eq!(example_agent_micropayments::channel_closed(), 1);
    assert_eq!(example_agent_micropayments::channel_disputed(), 2);
    assert_eq!(example_agent_micropayments::channel_force_closed(), 3);
    assert_eq!(example_agent_micropayments::default_timeout_ms(), 3600000);
}

#[test]
fun open_channel() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let channel = example_agent_micropayments::open_channel<SUI>(
        @0x0,
        PK_A,
        @0x2,
        PK_B,
        budget,
        10, // 10 per request
        0, // unlimited requests
        500, // settle threshold
        &clock,
        &mut ctx,
    );

    assert_eq!(example_agent_micropayments::channel_status<SUI>(&channel), 0);
    assert_eq!(example_agent_micropayments::channel_total_requests<SUI>(&channel), 0);
    assert_eq!(example_agent_micropayments::channel_total_cost<SUI>(&channel), 0);
    assert_eq!(example_agent_micropayments::channel_price_per_request<SUI>(&channel), 10);
    assert_eq!(example_agent_micropayments::channel_max_requests<SUI>(&channel), 0);
    assert_eq!(example_agent_micropayments::channel_settle_threshold<SUI>(&channel), 500);
    assert_eq!(example_agent_micropayments::channel_nonce<SUI>(&channel), 0);

    example_agent_micropayments::destroy_channel_for_testing<SUI>(channel);
    clock::destroy_for_testing(clock);
}

#[test]
fun channel_balance_after_open() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let channel = example_agent_micropayments::open_channel<SUI>(
        @0x0,
        PK_A,
        @0x2,
        PK_B,
        budget,
        10,
        0,
        0,
        &clock,
        &mut ctx,
    );

    assert_eq!(example_agent_micropayments::channel_total_balance<SUI>(&channel), 10000);

    example_agent_micropayments::destroy_channel_for_testing<SUI>(channel);
    clock::destroy_for_testing(clock);
}

#[test]
fun record_usage() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let mut channel = example_agent_micropayments::open_channel<SUI>(
        @0x0,
        PK_A,
        @0x2,
        PK_B,
        budget,
        10,
        0,
        0,
        &clock,
        &mut ctx,
    );

    // Record 5 requests (cost = 5 * 10 = 50)
    example_agent_micropayments::record_usage<SUI>(
        &mut channel,
        5, // total_requests
        50, // total_cost
        1, // nonce
        9950, // party_a_balance (10000 - 50)
        50, // party_b_balance
        0, // timestamp
        vector[],
        vector[],
        &clock,
        &ctx,
    );

    assert_eq!(example_agent_micropayments::channel_total_requests<SUI>(&channel), 5);
    assert_eq!(example_agent_micropayments::channel_total_cost<SUI>(&channel), 50);
    assert_eq!(example_agent_micropayments::channel_nonce<SUI>(&channel), 1);

    // Record 15 more requests (total 20, cost = 200)
    example_agent_micropayments::record_usage<SUI>(
        &mut channel,
        20,
        200,
        2,
        9800, // party_a_balance (10000 - 200)
        200, // party_b_balance
        0, // timestamp
        vector[],
        vector[],
        &clock,
        &ctx,
    );

    assert_eq!(example_agent_micropayments::channel_total_requests<SUI>(&channel), 20);
    assert_eq!(example_agent_micropayments::channel_total_cost<SUI>(&channel), 200);

    example_agent_micropayments::destroy_channel_for_testing<SUI>(channel);
    clock::destroy_for_testing(clock);
}

#[test]
fun record_usage_with_max_requests() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let mut channel = example_agent_micropayments::open_channel<SUI>(
        @0x0,
        PK_A,
        @0x2,
        PK_B,
        budget,
        10,
        100, // max 100 requests
        0,
        &clock,
        &mut ctx,
    );

    // Record 100 requests (at the limit)
    example_agent_micropayments::record_usage<SUI>(
        &mut channel,
        100,
        1000,
        1,
        9000, // party_a_balance (10000 - 1000)
        1000, // party_b_balance
        0, // timestamp
        vector[],
        vector[],
        &clock,
        &ctx,
    );

    assert_eq!(example_agent_micropayments::channel_total_requests<SUI>(&channel), 100);

    example_agent_micropayments::destroy_channel_for_testing<SUI>(channel);
    clock::destroy_for_testing(clock);
}

#[test]
fun should_settle_threshold() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let mut channel = example_agent_micropayments::open_channel<SUI>(
        @0x0,
        PK_A,
        @0x2,
        PK_B,
        budget,
        10,
        0,
        500, // settle threshold
        &clock,
        &mut ctx,
    );

    // Below threshold: cost 490 < 500
    example_agent_micropayments::record_usage<SUI>(
        &mut channel,
        49,
        490,
        1,
        9510,
        490,
        0,
        vector[],
        vector[],
        &clock,
        &ctx,
    );
    assert!(!example_agent_micropayments::should_settle<SUI>(&channel));

    // At/after threshold: cost 500 >= 500
    example_agent_micropayments::record_usage<SUI>(
        &mut channel,
        50,
        500,
        2,
        9500,
        500,
        0,
        vector[],
        vector[],
        &clock,
        &ctx,
    );
    assert!(example_agent_micropayments::should_settle<SUI>(&channel));

    example_agent_micropayments::destroy_channel_for_testing<SUI>(channel);
    clock::destroy_for_testing(clock);
}

#[test]
fun top_up_budget_grows_balance() {
    let mut scenario = test_scenario::begin(CONSUMER);
    let clock = clock::create_for_testing(scenario.ctx());
    let budget = coin::mint_for_testing<SUI>(10000, scenario.ctx());

    let mut channel = example_agent_micropayments::open_channel<SUI>(
        CONSUMER,
        PK_A,
        PROVIDER,
        PK_B,
        budget,
        10,
        0,
        0,
        &clock,
        scenario.ctx(),
    );

    assert_eq!(example_agent_micropayments::channel_total_balance<SUI>(&channel), 10000);

    let extra = coin::mint_for_testing<SUI>(5000, scenario.ctx());
    example_agent_micropayments::top_up_budget<SUI>(&mut channel, extra, &clock, scenario.ctx());

    assert_eq!(example_agent_micropayments::channel_total_balance<SUI>(&channel), 15000);

    example_agent_micropayments::destroy_channel_for_testing<SUI>(channel);
    clock::destroy_for_testing(clock);
    scenario.end();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_agent_micropayments::ENotAuthorized,
        location = sui_tunnel::example_agent_micropayments,
    ),
]
fun top_up_budget_by_non_consumer() {
    let mut scenario = test_scenario::begin(CONSUMER);
    let clock = clock::create_for_testing(scenario.ctx());
    let budget = coin::mint_for_testing<SUI>(10000, scenario.ctx());

    let mut channel = example_agent_micropayments::open_channel<SUI>(
        CONSUMER,
        PK_A,
        PROVIDER,
        PK_B,
        budget,
        10,
        0,
        0,
        &clock,
        scenario.ctx(),
    );

    scenario.next_tx(STRANGER);
    let extra = coin::mint_for_testing<SUI>(5000, scenario.ctx());
    example_agent_micropayments::top_up_budget<SUI>(&mut channel, extra, &clock, scenario.ctx());

    let _channel = channel;
    abort
}

#[test]
fun provider_joins_and_balance_grows() {
    let mut scenario = test_scenario::begin(CONSUMER);
    let clock = clock::create_for_testing(scenario.ctx());
    let budget = coin::mint_for_testing<SUI>(10000, scenario.ctx());

    let mut channel = example_agent_micropayments::open_channel<SUI>(
        CONSUMER,
        PK_A,
        PROVIDER,
        PK_B,
        budget,
        10,
        0,
        0,
        &clock,
        scenario.ctx(),
    );

    scenario.next_tx(PROVIDER);
    let collateral = coin::mint_for_testing<SUI>(2000, scenario.ctx());
    example_agent_micropayments::join_as_provider<SUI>(
        &mut channel,
        collateral,
        &clock,
        scenario.ctx(),
    );

    assert_eq!(example_agent_micropayments::channel_total_balance<SUI>(&channel), 12000);

    example_agent_micropayments::destroy_channel_for_testing<SUI>(channel);
    clock::destroy_for_testing(clock);
    scenario.end();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_agent_micropayments::EMaxRequestsExceeded,
        location = sui_tunnel::example_agent_micropayments,
    ),
]
fun record_usage_exceeds_max_requests() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let mut channel = example_agent_micropayments::open_channel<SUI>(
        @0x0,
        PK_A,
        @0x2,
        PK_B,
        budget,
        10,
        50, // max 50 requests
        0,
        &clock,
        &mut ctx,
    );

    // Try to record 51 requests (exceeds max)
    example_agent_micropayments::record_usage<SUI>(
        &mut channel,
        51,
        510,
        1,
        9490, // party_a_balance (10000 - 510)
        510, // party_b_balance
        0, // timestamp
        vector[],
        vector[],
        &clock,
        &ctx,
    );

    let _channel = channel;
    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_agent_micropayments::EBalanceMismatch,
        location = sui_tunnel::example_agent_micropayments,
    ),
]
fun record_usage_wrong_cost() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let mut channel = example_agent_micropayments::open_channel<SUI>(
        @0x0,
        PK_A,
        @0x2,
        PK_B,
        budget,
        10,
        0,
        0,
        &clock,
        &mut ctx,
    );

    // Wrong cost: 5 requests at 10 each should be 50, not 100
    example_agent_micropayments::record_usage<SUI>(
        &mut channel,
        5,
        100, // wrong!
        1,
        9900, // party_a_balance (10000 - 100)
        100, // party_b_balance
        0, // timestamp
        vector[],
        vector[],
        &clock,
        &ctx,
    );

    let _channel = channel;
    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_agent_micropayments::EInsufficientBalance,
        location = sui_tunnel::example_agent_micropayments,
    ),
]
fun record_usage_exceeds_budget() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let budget = coin::mint_for_testing<SUI>(100, &mut ctx);

    let mut channel = example_agent_micropayments::open_channel<SUI>(
        @0x0,
        PK_A,
        @0x2,
        PK_B,
        budget,
        10,
        0,
        0,
        &clock,
        &mut ctx,
    );

    // 20 requests * 10 = 200, but budget is only 100
    example_agent_micropayments::record_usage<SUI>(
        &mut channel,
        20,
        200,
        1,
        0, // party_a_balance (budget exhausted)
        200, // party_b_balance
        0, // timestamp
        vector[],
        vector[],
        &clock,
        &ctx,
    );

    let _channel = channel;
    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_agent_micropayments::EStaleState,
        location = sui_tunnel::example_agent_micropayments,
    ),
]
fun record_usage_regressing_total_aborts() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let mut channel = example_agent_micropayments::open_channel<SUI>(
        @0x0,
        PK_A,
        @0x2,
        PK_B,
        budget,
        10,
        0,
        0,
        &clock,
        &mut ctx,
    );

    example_agent_micropayments::record_usage<SUI>(
        &mut channel,
        5,
        50,
        1,
        9950,
        50,
        0,
        vector[],
        vector[],
        &clock,
        &ctx,
    );

    // A higher nonce but a regressed running total is a stale snapshot: reject it.
    example_agent_micropayments::record_usage<SUI>(
        &mut channel,
        3,
        30,
        2,
        9970,
        30,
        0,
        vector[],
        vector[],
        &clock,
        &ctx,
    );

    let _channel = channel;
    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_agent_micropayments::EInvalidNonce,
        location = sui_tunnel::example_agent_micropayments,
    ),
]
fun record_usage_stale_nonce() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let mut channel = example_agent_micropayments::open_channel<SUI>(
        @0x0,
        PK_A,
        @0x2,
        PK_B,
        budget,
        10,
        0,
        0,
        &clock,
        &mut ctx,
    );

    example_agent_micropayments::record_usage<SUI>(
        &mut channel,
        5,
        50,
        1,
        9950, // party_a_balance (10000 - 50)
        50, // party_b_balance
        0, // timestamp
        vector[],
        vector[],
        &clock,
        &ctx,
    );

    // Stale nonce (0 <= 1)
    example_agent_micropayments::record_usage<SUI>(
        &mut channel,
        10,
        100,
        0,
        9900, // party_a_balance (10000 - 100)
        100, // party_b_balance
        0, // timestamp
        vector[],
        vector[],
        &clock,
        &ctx,
    );

    let _channel = channel;
    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_agent_micropayments::EInvalidState,
        location = sui_tunnel::example_agent_micropayments,
    ),
]
fun cannot_record_usage_when_closed() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let mut channel = example_agent_micropayments::open_channel<SUI>(
        @0x0,
        PK_A,
        @0x2,
        PK_B,
        budget,
        10,
        0,
        0,
        &clock,
        &mut ctx,
    );

    example_agent_micropayments::set_status_for_testing<SUI>(
        &mut channel,
        example_agent_micropayments::channel_closed(),
    );

    example_agent_micropayments::record_usage<SUI>(
        &mut channel,
        5,
        50,
        1,
        9950, // party_a_balance (10000 - 50)
        50, // party_b_balance
        0, // timestamp
        vector[],
        vector[],
        &clock,
        &ctx,
    );

    let _channel = channel;
    abort
}

#[test]
fun calculate_settlement() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let mut channel = example_agent_micropayments::open_channel<SUI>(
        @0x0,
        PK_A,
        @0x2,
        PK_B,
        budget,
        10,
        0,
        0,
        &clock,
        &mut ctx,
    );

    example_agent_micropayments::record_usage<SUI>(
        &mut channel,
        50,
        500,
        1,
        9500, // party_a_balance (10000 - 500)
        500, // party_b_balance
        0, // timestamp
        vector[],
        vector[],
        &clock,
        &ctx,
    );

    let (consumer_refund, provider_earned) = example_agent_micropayments::calculate_settlement<SUI>(
        &channel,
    );
    assert_eq!(consumer_refund, 9500);
    assert_eq!(provider_earned, 500);

    example_agent_micropayments::destroy_channel_for_testing<SUI>(channel);
    clock::destroy_for_testing(clock);
}

#[test]
fun close_channel_transfers_funds() {
    let mut scenario = test_scenario::begin(CONSUMER);
    let clock = clock::create_for_testing(scenario.ctx());
    let budget = coin::mint_for_testing<SUI>(10000, scenario.ctx());

    let mut channel = example_agent_micropayments::open_channel<SUI>(
        CONSUMER,
        PK_A,
        PROVIDER,
        PK_B,
        budget,
        10,
        0,
        0,
        &clock,
        scenario.ctx(),
    );

    scenario.next_tx(PROVIDER);
    let collateral = coin::mint_for_testing<SUI>(100, scenario.ctx());
    example_agent_micropayments::join_as_provider<SUI>(
        &mut channel,
        collateral,
        &clock,
        scenario.ctx(),
    );

    example_agent_micropayments::record_usage<SUI>(
        &mut channel,
        50,
        500,
        1,
        9500,
        600,
        0,
        vector[],
        vector[],
        &clock,
        scenario.ctx(),
    );

    // total = 10000 + 100 collateral; provider earns 500 + 100 collateral = 600
    example_agent_micropayments::close_channel_no_sig_for_testing<SUI>(
        &mut channel,
        9500,
        600,
        &clock,
        scenario.ctx(),
    );

    assert_eq!(
        example_agent_micropayments::channel_status<SUI>(&channel),
        example_agent_micropayments::channel_closed(),
    );

    scenario.next_tx(CONSUMER);
    let to_consumer = scenario.take_from_address<coin::Coin<SUI>>(CONSUMER);
    assert_eq!(to_consumer.value(), 9500);
    to_consumer.burn_for_testing();

    scenario.next_tx(PROVIDER);
    let to_provider = scenario.take_from_address<coin::Coin<SUI>>(PROVIDER);
    assert_eq!(to_provider.value(), 600);
    to_provider.burn_for_testing();

    example_agent_micropayments::destroy_channel_for_testing<SUI>(channel);
    clock::destroy_for_testing(clock);
    scenario.end();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_agent_micropayments::EBalanceMismatch,
        location = sui_tunnel::example_agent_micropayments,
    ),
]
fun close_channel_wrong_split() {
    let mut scenario = test_scenario::begin(CONSUMER);
    let clock = clock::create_for_testing(scenario.ctx());
    let budget = coin::mint_for_testing<SUI>(10000, scenario.ctx());

    let mut channel = example_agent_micropayments::open_channel<SUI>(
        CONSUMER,
        PK_A,
        PROVIDER,
        PK_B,
        budget,
        10,
        0,
        0,
        &clock,
        scenario.ctx(),
    );

    scenario.next_tx(PROVIDER);
    let collateral = coin::mint_for_testing<SUI>(100, scenario.ctx());
    example_agent_micropayments::join_as_provider<SUI>(
        &mut channel,
        collateral,
        &clock,
        scenario.ctx(),
    );

    example_agent_micropayments::record_usage<SUI>(
        &mut channel,
        50,
        500,
        1,
        9500,
        600,
        0,
        vector[],
        vector[],
        &clock,
        scenario.ctx(),
    );

    // Wrong split: consumer should get 9500, not 9000
    example_agent_micropayments::close_channel_no_sig_for_testing<SUI>(
        &mut channel,
        9000,
        1100,
        &clock,
        scenario.ctx(),
    );

    let _channel = channel;
    abort
}

#[test]
fun compute_usage_hash_deterministic() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let channel = example_agent_micropayments::open_channel<SUI>(
        @0x0,
        PK_A,
        @0x2,
        PK_B,
        budget,
        10,
        0,
        0,
        &clock,
        &mut ctx,
    );

    let hash1 = example_agent_micropayments::compute_usage_hash<SUI>(&channel, 5, 50, 1);
    let hash2 = example_agent_micropayments::compute_usage_hash<SUI>(&channel, 5, 50, 1);
    assert_eq!(hash1, hash2);

    let hash3 = example_agent_micropayments::compute_usage_hash<SUI>(&channel, 10, 100, 1);
    assert!(hash1 != hash3);
    assert_eq!(hash1.length(), 32);

    example_agent_micropayments::destroy_channel_for_testing<SUI>(channel);
    clock::destroy_for_testing(clock);
}

#[test]
fun usage_state_accessors() {
    let state = example_agent_micropayments::create_usage_state_for_testing(42, 420, 7);
    assert_eq!(example_agent_micropayments::usage_total_requests(&state), 42);
    assert_eq!(example_agent_micropayments::usage_total_cost(&state), 420);
    assert_eq!(example_agent_micropayments::usage_nonce(&state), 7);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_agent_micropayments::EInvalidParameter,
        location = sui_tunnel::example_agent_micropayments,
    ),
]
fun open_channel_zero_price() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let channel = example_agent_micropayments::open_channel<SUI>(
        @0x0,
        PK_A,
        @0x2,
        PK_B,
        budget,
        0,
        0,
        0,
        &clock,
        &mut ctx,
    );

    let _channel = channel;
    abort
}

#[test]
fun should_settle_zero_threshold_disabled() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    // A settle_threshold of 0 disables the auto-settle watermark entirely.
    let mut channel = example_agent_micropayments::open_channel<SUI>(
        @0x0,
        PK_A,
        @0x2,
        PK_B,
        budget,
        10,
        0,
        0,
        &clock,
        &mut ctx,
    );

    example_agent_micropayments::record_usage<SUI>(
        &mut channel,
        50,
        500,
        1,
        9500,
        500,
        0,
        vector[],
        vector[],
        &clock,
        &ctx,
    );
    // Cost has accrued but the watermark is disabled, so settlement is never auto-triggered.
    assert!(!example_agent_micropayments::should_settle<SUI>(&channel));

    example_agent_micropayments::destroy_channel_for_testing<SUI>(channel);
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_agent_micropayments::EInvalidState,
        location = sui_tunnel::example_agent_micropayments,
    ),
]
fun raise_dispute_when_closed_aborts() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);
    let mut channel = example_agent_micropayments::open_channel<SUI>(
        @0x0,
        PK_A,
        @0x2,
        PK_B,
        budget,
        10,
        0,
        0,
        &clock,
        &mut ctx,
    );

    example_agent_micropayments::set_status_for_testing<SUI>(
        &mut channel,
        example_agent_micropayments::channel_closed(),
    );
    // raise_dispute requires CHANNEL_ACTIVE; the status guard fires before the tunnel call.
    example_agent_micropayments::raise_dispute<SUI>(
        &mut channel,
        b"state_hash_placeholder_32_bytes!",
        1,
        5000,
        5000,
        0,
        vector[],
        &clock,
        &ctx,
    );

    abort
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_agent_micropayments::ENoActiveDispute,
        location = sui_tunnel::example_agent_micropayments,
    ),
]
fun force_close_without_dispute_aborts() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);
    let mut channel = example_agent_micropayments::open_channel<SUI>(
        @0x0,
        PK_A,
        @0x2,
        PK_B,
        budget,
        10,
        0,
        0,
        &clock,
        &mut ctx,
    );

    // Channel is CHANNEL_ACTIVE, never disputed, so force_close is rejected.
    example_agent_micropayments::force_close<SUI>(&mut channel, &clock, &mut ctx);

    abort
}

#[test]
fun dispute_then_force_close_lifecycle() {
    let mut scenario = test_scenario::begin(CONSUMER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    let budget = coin::mint_for_testing<SUI>(10000, scenario.ctx());

    let mut channel = example_agent_micropayments::open_channel<SUI>(
        CONSUMER,
        PK_A,
        PROVIDER,
        PK_B,
        budget,
        10,
        0,
        0,
        &clock,
        scenario.ctx(),
    );

    scenario.next_tx(PROVIDER);
    let collateral = coin::mint_for_testing<SUI>(2000, scenario.ctx());
    example_agent_micropayments::join_as_provider<SUI>(
        &mut channel,
        collateral,
        &clock,
        scenario.ctx(),
    );

    scenario.next_tx(CONSUMER);
    example_agent_micropayments::raise_dispute_current_state_for_testing<SUI>(
        &mut channel,
        &clock,
        scenario.ctx(),
    );
    assert_eq!(
        example_agent_micropayments::channel_status<SUI>(&channel),
        example_agent_micropayments::channel_disputed(),
    );

    clock.increment_for_testing(example_agent_micropayments::default_timeout_ms() + 1);

    scenario.next_tx(CONSUMER);
    example_agent_micropayments::force_close<SUI>(&mut channel, &clock, scenario.ctx());
    assert_eq!(
        example_agent_micropayments::channel_status<SUI>(&channel),
        example_agent_micropayments::channel_force_closed(),
    );

    example_agent_micropayments::destroy_channel_for_testing<SUI>(channel);
    clock::destroy_for_testing(clock);
    scenario.end();
}

#[test]
fun settlement_returns_provider_collateral() {
    let mut scenario = test_scenario::begin(CONSUMER);
    let clock = clock::create_for_testing(scenario.ctx());
    let budget = coin::mint_for_testing<SUI>(10000, scenario.ctx());

    let mut channel = example_agent_micropayments::open_channel<SUI>(
        CONSUMER,
        PK_A,
        PROVIDER,
        PK_B,
        budget,
        10,
        0,
        0,
        &clock,
        scenario.ctx(),
    );

    scenario.next_tx(PROVIDER);
    let collateral = coin::mint_for_testing<SUI>(2000, scenario.ctx());
    example_agent_micropayments::join_as_provider<SUI>(
        &mut channel,
        collateral,
        &clock,
        scenario.ctx(),
    );

    example_agent_micropayments::record_usage<SUI>(
        &mut channel,
        50,
        500,
        1,
        9500,
        2500,
        0,
        vector[],
        vector[],
        &clock,
        scenario.ctx(),
    );

    // Provider keeps its 2000 collateral on top of the 500 it earned; consumer
    // gets only its own unspent budget, never the provider's collateral.
    let (consumer_refund, provider_earned) = example_agent_micropayments::calculate_settlement<SUI>(
        &channel,
    );
    assert_eq!(consumer_refund, 9500);
    assert_eq!(provider_earned, 2500);
    assert_eq!(
        consumer_refund + provider_earned,
        example_agent_micropayments::channel_total_balance<SUI>(&channel),
    );

    example_agent_micropayments::destroy_channel_for_testing<SUI>(channel);
    clock::destroy_for_testing(clock);
    scenario.end();
}

#[test]
fun cancel_channel_refunds_consumer_before_provider_joins() {
    let mut scenario = test_scenario::begin(CONSUMER);
    let clock = clock::create_for_testing(scenario.ctx());
    let budget = coin::mint_for_testing<SUI>(10000, scenario.ctx());

    let mut channel = example_agent_micropayments::open_channel<SUI>(
        CONSUMER,
        PK_A,
        PROVIDER,
        PK_B,
        budget,
        10,
        0,
        0,
        &clock,
        scenario.ctx(),
    );

    let refund = example_agent_micropayments::cancel_channel<SUI>(
        &mut channel,
        &clock,
        scenario.ctx(),
    );
    assert_eq!(refund.value(), 10000);
    assert_eq!(
        example_agent_micropayments::channel_status<SUI>(&channel),
        example_agent_micropayments::channel_closed(),
    );
    refund.burn_for_testing();

    example_agent_micropayments::destroy_channel_for_testing<SUI>(channel);
    clock::destroy_for_testing(clock);
    scenario.end();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_agent_micropayments::ENotAuthorized,
        location = sui_tunnel::example_agent_micropayments,
    ),
]
fun record_usage_by_non_party_aborts() {
    let mut scenario = test_scenario::begin(CONSUMER);
    let clock = clock::create_for_testing(scenario.ctx());
    let budget = coin::mint_for_testing<SUI>(10000, scenario.ctx());

    let mut channel = example_agent_micropayments::open_channel<SUI>(
        CONSUMER,
        PK_A,
        PROVIDER,
        PK_B,
        budget,
        10,
        0,
        0,
        &clock,
        scenario.ctx(),
    );

    scenario.next_tx(STRANGER);
    example_agent_micropayments::record_usage<SUI>(
        &mut channel,
        5,
        50,
        1,
        9950,
        50,
        0,
        vector[],
        vector[],
        &clock,
        scenario.ctx(),
    );

    let _channel = channel;
    abort
}
