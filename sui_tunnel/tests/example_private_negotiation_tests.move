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

    assert_eq!(example_private_negotiation::channel_status<SUI>(&channel), 0);
    assert_eq!(example_private_negotiation::channel_rounds<SUI>(&channel), 0);
    assert_eq!(example_private_negotiation::channel_latest_price<SUI>(&channel), 0);
    assert!(!example_private_negotiation::channel_deal_reached<SUI>(&channel));
    assert_eq!(example_private_negotiation::channel_asking_price<SUI>(&channel), 10000);
    assert_eq!(
        *example_private_negotiation::channel_item_description<SUI>(&channel),
        b"Rare NFT collection",
    );

    example_private_negotiation::destroy_channel_for_testing<SUI>(channel);
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

    assert_eq!(example_private_negotiation::channel_total_balance<SUI>(&channel), 5000);

    example_private_negotiation::destroy_channel_for_testing<SUI>(channel);
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
    example_private_negotiation::record_round<SUI>(
        &mut channel,
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
    assert_eq!(example_private_negotiation::channel_rounds<SUI>(&channel), 1);
    assert_eq!(example_private_negotiation::channel_latest_price<SUI>(&channel), 6000);
    assert!(!example_private_negotiation::channel_deal_reached<SUI>(&channel));

    // Round 2: Seller counters with 9000 (private off-chain)
    example_private_negotiation::record_round<SUI>(
        &mut channel,
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
    assert_eq!(example_private_negotiation::channel_rounds<SUI>(&channel), 2);
    assert_eq!(example_private_negotiation::channel_latest_price<SUI>(&channel), 9000);

    // Round 3: Buyer counters 7500 (private off-chain)
    example_private_negotiation::record_round<SUI>(
        &mut channel,
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
    example_private_negotiation::record_round<SUI>(
        &mut channel,
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
    assert_eq!(example_private_negotiation::channel_rounds<SUI>(&channel), 4);
    assert_eq!(example_private_negotiation::channel_latest_price<SUI>(&channel), 8000);
    assert!(example_private_negotiation::channel_deal_reached<SUI>(&channel));

    example_private_negotiation::destroy_channel_for_testing<SUI>(channel);
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

    example_private_negotiation::record_round<SUI>(
        &mut channel,
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
    example_private_negotiation::record_round<SUI>(
        &mut channel,
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

    example_private_negotiation::destroy_channel_for_testing<SUI>(channel);
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

    example_private_negotiation::set_status_for_testing<SUI>(
        &mut channel,
        example_private_negotiation::negotiation_settled(),
    );

    example_private_negotiation::record_round<SUI>(
        &mut channel,
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

    example_private_negotiation::destroy_channel_for_testing<SUI>(channel);
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

    let h1 = example_private_negotiation::compute_round_hash<SUI>(&channel, 1, 5000, false, 1);
    let h2 = example_private_negotiation::compute_round_hash<SUI>(&channel, 1, 5000, false, 1);
    assert_eq!(h1, h2);
    assert_eq!(h1.length(), 32);

    let h3 = example_private_negotiation::compute_round_hash<SUI>(&channel, 2, 6000, false, 2);
    assert!(h1 != h3);

    // Same params but deal_reached differs
    let h4 = example_private_negotiation::compute_round_hash<SUI>(&channel, 1, 5000, true, 1);
    assert!(h1 != h4);

    example_private_negotiation::destroy_channel_for_testing<SUI>(channel);
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

    assert_eq!(example_private_negotiation::negotiation_rounds(&state), 5);
    assert_eq!(example_private_negotiation::negotiation_latest_price(&state), 8000);
    assert!(example_private_negotiation::negotiation_deal_reached(&state));
    assert_eq!(example_private_negotiation::negotiation_nonce(&state), 10);
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

    example_private_negotiation::destroy_channel_for_testing<SUI>(channel);
    clock::destroy_for_testing(clock);
}
