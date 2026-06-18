#[test_only]
module sui_tunnel::example_private_negotiation_tests;

use std::unit_test::assert_eq;
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui_tunnel::example_private_negotiation;

#[test]
fun status_constants() {
    assert_eq!(example_private_negotiation::negotiation_active(), 0);
    assert_eq!(example_private_negotiation::negotiation_settled(), 1);
    assert_eq!(example_private_negotiation::negotiation_cancelled(), 2);
    assert_eq!(example_private_negotiation::negotiation_disputed(), 3);
    assert_eq!(example_private_negotiation::negotiation_force_closed(), 4);
}

#[test]
fun open_negotiation() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let deposit = coin::mint_for_testing<SUI>(5000, &mut ctx);

    let channel = example_private_negotiation::open_negotiation<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        deposit,
        b"Rare NFT collection",
        10000,
        &clock,
        &mut ctx,
    );

    assert_eq!(channel.channel_status<SUI>(), 0);
    assert_eq!(channel.channel_rounds<SUI>(), 0);
    assert_eq!(channel.channel_latest_price<SUI>(), 0);
    assert_eq!(channel.channel_deal_reached<SUI>(), false);
    assert_eq!(channel.channel_asking_price<SUI>(), 10000);
    assert_eq!(*channel.channel_item_description<SUI>(), b"Rare NFT collection");

    channel.destroy_channel_for_testing<SUI>();
    clock::destroy_for_testing(clock);
}

#[test]
fun channel_balance_after_open() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let deposit = coin::mint_for_testing<SUI>(5000, &mut ctx);

    let channel = example_private_negotiation::open_negotiation<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        deposit,
        b"Vintage guitar",
        8000,
        &clock,
        &mut ctx,
    );

    assert_eq!(channel.channel_total_balance<SUI>(), 5000);

    channel.destroy_channel_for_testing<SUI>();
    clock::destroy_for_testing(clock);
}

#[test]
fun record_negotiation_rounds() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let deposit = coin::mint_for_testing<SUI>(5000, &mut ctx);

    let mut channel = example_private_negotiation::open_negotiation<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        deposit,
        b"Domain name",
        10000,
        &clock,
        &mut ctx,
    );

    // Round 1: Buyer offers 6000 (private off-chain)
    // party_a_balance = 5000, party_b_balance = 0 (only buyer deposited)
    channel.record_round<SUI>(
        1,
        6000,
        false,
        1,
        5000,
        0,
        0,
        vector[],
        vector[],
        &clock,
    );
    assert_eq!(channel.channel_rounds<SUI>(), 1);
    assert_eq!(channel.channel_latest_price<SUI>(), 6000);
    assert_eq!(channel.channel_deal_reached<SUI>(), false);

    // Round 2: Seller counters with 9000 (private off-chain)
    channel.record_round<SUI>(
        2,
        9000,
        false,
        2,
        5000,
        0,
        0,
        vector[],
        vector[],
        &clock,
    );
    assert_eq!(channel.channel_rounds<SUI>(), 2);
    assert_eq!(channel.channel_latest_price<SUI>(), 9000);

    // Round 3: Buyer counters 7500 (private off-chain)
    channel.record_round<SUI>(
        3,
        7500,
        false,
        3,
        5000,
        0,
        0,
        vector[],
        vector[],
        &clock,
    );

    // Round 4: Both agree on 8000 (deal reached!)
    channel.record_round<SUI>(
        4,
        8000,
        true,
        4,
        5000,
        0,
        0,
        vector[],
        vector[],
        &clock,
    );
    assert_eq!(channel.channel_rounds<SUI>(), 4);
    assert_eq!(channel.channel_latest_price<SUI>(), 8000);
    assert_eq!(channel.channel_deal_reached<SUI>(), true);

    channel.destroy_channel_for_testing<SUI>();
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_private_negotiation::EInvalidNonce,
        location = sui_tunnel::example_private_negotiation,
    ),
]
fun record_round_stale_nonce() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let deposit = coin::mint_for_testing<SUI>(5000, &mut ctx);

    let mut channel = example_private_negotiation::open_negotiation<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        deposit,
        b"item",
        10000,
        &clock,
        &mut ctx,
    );

    channel.record_round<SUI>(
        1,
        5000,
        false,
        1,
        5000,
        0,
        0,
        vector[],
        vector[],
        &clock,
    );

    // Stale nonce
    channel.record_round<SUI>(
        2,
        6000,
        false,
        0,
        5000,
        0,
        0,
        vector[],
        vector[],
        &clock,
    );

    channel.destroy_channel_for_testing<SUI>();
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_private_negotiation::EInvalidState,
        location = sui_tunnel::example_private_negotiation,
    ),
]
fun cannot_record_round_when_settled() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let deposit = coin::mint_for_testing<SUI>(5000, &mut ctx);

    let mut channel = example_private_negotiation::open_negotiation<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        deposit,
        b"item",
        10000,
        &clock,
        &mut ctx,
    );

    channel.set_status_for_testing<SUI>(
        example_private_negotiation::negotiation_settled(),
    );

    channel.record_round<SUI>(
        1,
        5000,
        false,
        1,
        5000,
        0,
        0,
        vector[],
        vector[],
        &clock,
    );

    channel.destroy_channel_for_testing<SUI>();
    clock::destroy_for_testing(clock);
}

#[test]
fun compute_round_hash_deterministic() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let deposit = coin::mint_for_testing<SUI>(5000, &mut ctx);

    let channel = example_private_negotiation::open_negotiation<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        deposit,
        b"item",
        10000,
        &clock,
        &mut ctx,
    );

    let h1 = channel.compute_round_hash<SUI>(1, 5000, false, 1);
    let h2 = channel.compute_round_hash<SUI>(1, 5000, false, 1);
    assert_eq!(h1, h2);
    assert_eq!(h1.length(), 32);

    let h3 = channel.compute_round_hash<SUI>(2, 6000, false, 2);
    assert!(h1 != h3);

    // Same params but deal_reached differs
    let h4 = channel.compute_round_hash<SUI>(1, 5000, true, 1);
    assert!(h1 != h4);

    channel.destroy_channel_for_testing<SUI>();
    clock::destroy_for_testing(clock);
}

#[test]
fun negotiation_state_accessors() {
    let state = example_private_negotiation::create_negotiation_state_for_testing(
        5,
        8000,
        true,
        10,
    );

    assert_eq!(state.negotiation_rounds(), 5);
    assert_eq!(state.negotiation_latest_price(), 8000);
    assert_eq!(state.negotiation_deal_reached(), true);
    assert_eq!(state.negotiation_nonce(), 10);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_private_negotiation::EInvalidParameter,
        location = sui_tunnel::example_private_negotiation,
    ),
]
fun open_negotiation_zero_asking_price() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let deposit = coin::mint_for_testing<SUI>(5000, &mut ctx);

    let channel = example_private_negotiation::open_negotiation<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        deposit,
        b"item",
        0,
        &clock,
        &mut ctx,
    );

    channel.destroy_channel_for_testing<SUI>();
    clock::destroy_for_testing(clock);
}
