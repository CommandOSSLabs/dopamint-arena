#[test_only]
module sui_tunnel::example_freelance_milestone_tests;

use std::unit_test::assert_eq;
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui_tunnel::example_freelance_milestone;

#[test]
fun status_constants() {
    assert_eq!(example_freelance_milestone::contract_active(), 0);
    assert_eq!(example_freelance_milestone::contract_completed(), 1);
    assert_eq!(example_freelance_milestone::contract_disputed(), 2);
    assert_eq!(example_freelance_milestone::contract_force_closed(), 3);
    assert_eq!(example_freelance_milestone::contract_cancelled(), 4);
    assert_eq!(example_freelance_milestone::default_timeout_ms(), 604800000);
}

#[test]
fun create_contract() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let contract = example_freelance_milestone::create_contract<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        5, // 5 milestones
        2000, // 2000 per milestone
        b"Build a website",
        &clock,
        &mut ctx,
    );

    assert_eq!(example_freelance_milestone::contract_status<SUI>(&contract), 0);
    assert_eq!(example_freelance_milestone::contract_total_milestones<SUI>(&contract), 5);
    assert_eq!(example_freelance_milestone::contract_completed_milestones<SUI>(&contract), 0);
    assert_eq!(example_freelance_milestone::contract_amount_per_milestone<SUI>(&contract), 2000);
    assert_eq!(example_freelance_milestone::contract_total_earned<SUI>(&contract), 0);
    assert_eq!(example_freelance_milestone::contract_nonce<SUI>(&contract), 0);
    assert_eq!(
        *example_freelance_milestone::contract_project_description<SUI>(&contract),
        b"Build a website",
    );

    example_freelance_milestone::destroy_contract_for_testing<SUI>(contract);
    clock::destroy_for_testing(clock);
}

#[test]
fun contract_balance_after_create() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let contract = example_freelance_milestone::create_contract<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        5,
        2000,
        b"project",
        &clock,
        &mut ctx,
    );

    assert_eq!(example_freelance_milestone::contract_total_balance<SUI>(&contract), 10000);

    example_freelance_milestone::destroy_contract_for_testing<SUI>(contract);
    clock::destroy_for_testing(clock);
}

#[test]
fun record_milestones() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let mut contract = example_freelance_milestone::create_contract<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        5,
        2000,
        b"project",
        &clock,
        &mut ctx,
    );

    // Complete milestone 1
    // party_a_balance = 10000 - 1*2000 = 8000, party_b_balance = 1*2000 = 2000
    example_freelance_milestone::record_milestone<SUI>(
        &mut contract,
        1,
        1,
        8000,
        2000,
        0,
        vector[],
        vector[],
        &clock,
    );
    assert_eq!(example_freelance_milestone::contract_completed_milestones<SUI>(&contract), 1);
    assert_eq!(example_freelance_milestone::contract_total_earned<SUI>(&contract), 2000);

    // Complete milestones 2 and 3 in one update
    // party_a_balance = 10000 - 3*2000 = 4000, party_b_balance = 3*2000 = 6000
    example_freelance_milestone::record_milestone<SUI>(
        &mut contract,
        3,
        2,
        4000,
        6000,
        0,
        vector[],
        vector[],
        &clock,
    );
    assert_eq!(example_freelance_milestone::contract_completed_milestones<SUI>(&contract), 3);
    assert_eq!(example_freelance_milestone::contract_total_earned<SUI>(&contract), 6000);

    // Complete all 5 milestones
    // party_a_balance = 10000 - 5*2000 = 0, party_b_balance = 5*2000 = 10000
    example_freelance_milestone::record_milestone<SUI>(
        &mut contract,
        5,
        3,
        0,
        10000,
        0,
        vector[],
        vector[],
        &clock,
    );
    assert_eq!(example_freelance_milestone::contract_completed_milestones<SUI>(&contract), 5);
    assert_eq!(example_freelance_milestone::contract_total_earned<SUI>(&contract), 10000);

    example_freelance_milestone::destroy_contract_for_testing<SUI>(contract);
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_freelance_milestone::EInvalidParameter,
        location = sui_tunnel::example_freelance_milestone,
    ),
]
fun record_milestone_exceeds_total() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let mut contract = example_freelance_milestone::create_contract<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        5,
        2000,
        b"project",
        &clock,
        &mut ctx,
    );

    // Try to claim 6 milestones out of 5
    // party_a_balance = 10000 - 6*2000 would underflow, but validation catches it first
    example_freelance_milestone::record_milestone<SUI>(
        &mut contract,
        6,
        1,
        0,
        10000,
        0,
        vector[],
        vector[],
        &clock,
    );

    example_freelance_milestone::destroy_contract_for_testing<SUI>(contract);
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_freelance_milestone::EInvalidParameter,
        location = sui_tunnel::example_freelance_milestone,
    ),
]
fun record_milestone_not_increasing() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let mut contract = example_freelance_milestone::create_contract<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        5,
        2000,
        b"project",
        &clock,
        &mut ctx,
    );

    // party_a_balance = 10000 - 3*2000 = 4000, party_b_balance = 3*2000 = 6000
    example_freelance_milestone::record_milestone<SUI>(
        &mut contract,
        3,
        1,
        4000,
        6000,
        0,
        vector[],
        vector[],
        &clock,
    );

    // Trying to go back to 2 milestones
    // party_a_balance = 10000 - 2*2000 = 6000, party_b_balance = 2*2000 = 4000
    example_freelance_milestone::record_milestone<SUI>(
        &mut contract,
        2,
        2,
        6000,
        4000,
        0,
        vector[],
        vector[],
        &clock,
    );

    example_freelance_milestone::destroy_contract_for_testing<SUI>(contract);
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_freelance_milestone::EInvalidNonce,
        location = sui_tunnel::example_freelance_milestone,
    ),
]
fun record_milestone_stale_nonce() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let mut contract = example_freelance_milestone::create_contract<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        5,
        2000,
        b"project",
        &clock,
        &mut ctx,
    );

    // party_a_balance = 10000 - 1*2000 = 8000, party_b_balance = 1*2000 = 2000
    example_freelance_milestone::record_milestone<SUI>(
        &mut contract,
        1,
        1,
        8000,
        2000,
        0,
        vector[],
        vector[],
        &clock,
    );

    // Stale nonce
    // party_a_balance = 10000 - 2*2000 = 6000, party_b_balance = 2*2000 = 4000
    example_freelance_milestone::record_milestone<SUI>(
        &mut contract,
        2,
        0,
        6000,
        4000,
        0,
        vector[],
        vector[],
        &clock,
    );

    example_freelance_milestone::destroy_contract_for_testing<SUI>(contract);
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_freelance_milestone::EInsufficientBalance,
        location = sui_tunnel::example_freelance_milestone,
    ),
]
fun record_milestone_exceeds_balance() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    // Budget is only 5000 but 5 milestones * 2000 = 10000
    let budget = coin::mint_for_testing<SUI>(5000, &mut ctx);

    let mut contract = example_freelance_milestone::create_contract<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        5,
        2000,
        b"project",
        &clock,
        &mut ctx,
    );

    // 3 milestones * 2000 = 6000 > 5000 budget
    // party_a_balance = 5000 - 6000 would underflow; use 0/5000 since it aborts before checking
    example_freelance_milestone::record_milestone<SUI>(
        &mut contract,
        3,
        1,
        0,
        5000,
        0,
        vector[],
        vector[],
        &clock,
    );

    example_freelance_milestone::destroy_contract_for_testing<SUI>(contract);
    clock::destroy_for_testing(clock);
}

#[test]
fun calculate_settlement() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let mut contract = example_freelance_milestone::create_contract<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        5,
        2000,
        b"project",
        &clock,
        &mut ctx,
    );

    // Complete 3 of 5 milestones
    // party_a_balance = 10000 - 3*2000 = 4000, party_b_balance = 3*2000 = 6000
    example_freelance_milestone::record_milestone<SUI>(
        &mut contract,
        3,
        1,
        4000,
        6000,
        0,
        vector[],
        vector[],
        &clock,
    );

    let (client_refund, freelancer_earned) = example_freelance_milestone::calculate_settlement<SUI>(
        &contract,
    );
    assert_eq!(client_refund, 4000); // 10000 - 6000
    assert_eq!(freelancer_earned, 6000); // 3 * 2000

    example_freelance_milestone::destroy_contract_for_testing<SUI>(contract);
    clock::destroy_for_testing(clock);
}

#[test]
fun calculate_settlement_no_milestones() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let contract = example_freelance_milestone::create_contract<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        5,
        2000,
        b"project",
        &clock,
        &mut ctx,
    );

    let (client_refund, freelancer_earned) = example_freelance_milestone::calculate_settlement<SUI>(
        &contract,
    );
    assert_eq!(client_refund, 10000); // full refund
    assert_eq!(freelancer_earned, 0);

    example_freelance_milestone::destroy_contract_for_testing<SUI>(contract);
    clock::destroy_for_testing(clock);
}

#[test]
fun calculate_settlement_all_milestones() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let mut contract = example_freelance_milestone::create_contract<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        5,
        2000,
        b"project",
        &clock,
        &mut ctx,
    );

    // party_a_balance = 10000 - 5*2000 = 0, party_b_balance = 5*2000 = 10000
    example_freelance_milestone::record_milestone<SUI>(
        &mut contract,
        5,
        1,
        0,
        10000,
        0,
        vector[],
        vector[],
        &clock,
    );

    let (client_refund, freelancer_earned) = example_freelance_milestone::calculate_settlement<SUI>(
        &contract,
    );
    assert_eq!(client_refund, 0);
    assert_eq!(freelancer_earned, 10000);

    example_freelance_milestone::destroy_contract_for_testing<SUI>(contract);
    clock::destroy_for_testing(clock);
}

#[test]
fun compute_milestone_hash_deterministic() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let contract = example_freelance_milestone::create_contract<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        5,
        2000,
        b"project",
        &clock,
        &mut ctx,
    );

    let h1 = example_freelance_milestone::compute_milestone_hash<SUI>(&contract, 3, 6000, 1);
    let h2 = example_freelance_milestone::compute_milestone_hash<SUI>(&contract, 3, 6000, 1);
    assert_eq!(h1, h2);
    assert_eq!(h1.length(), 32);

    let h3 = example_freelance_milestone::compute_milestone_hash<SUI>(&contract, 4, 8000, 2);
    assert!(h1 != h3);

    example_freelance_milestone::destroy_contract_for_testing<SUI>(contract);
    clock::destroy_for_testing(clock);
}

#[test]
fun milestone_state_accessors() {
    let state = example_freelance_milestone::create_milestone_state_for_testing(
        10,
        7,
        500,
        3500,
        42,
    );

    assert_eq!(example_freelance_milestone::milestone_total(&state), 10);
    assert_eq!(example_freelance_milestone::milestone_completed(&state), 7);
    assert_eq!(example_freelance_milestone::milestone_amount_per(&state), 500);
    assert_eq!(example_freelance_milestone::milestone_total_earned(&state), 3500);
    assert_eq!(example_freelance_milestone::milestone_nonce(&state), 42);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_freelance_milestone::EInvalidParameter,
        location = sui_tunnel::example_freelance_milestone,
    ),
]
fun create_contract_zero_milestones() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let contract = example_freelance_milestone::create_contract<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        0,
        2000,
        b"project",
        &clock,
        &mut ctx,
    );

    example_freelance_milestone::destroy_contract_for_testing<SUI>(contract);
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_freelance_milestone::EInvalidParameter,
        location = sui_tunnel::example_freelance_milestone,
    ),
]
fun create_contract_zero_amount() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let contract = example_freelance_milestone::create_contract<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        5,
        0,
        b"project",
        &clock,
        &mut ctx,
    );

    example_freelance_milestone::destroy_contract_for_testing<SUI>(contract);
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_freelance_milestone::EInsufficientBalance,
        location = sui_tunnel::example_freelance_milestone,
    ),
]
fun create_contract_insufficient_budget() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    // Budget 5000 < required 10000 (5 * 2000)
    let budget = coin::mint_for_testing<SUI>(5000, &mut ctx);

    let contract = example_freelance_milestone::create_contract<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        5,
        2000,
        b"project",
        &clock,
        &mut ctx,
    );

    example_freelance_milestone::destroy_contract_for_testing<SUI>(contract);
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_freelance_milestone::EInvalidState,
        location = sui_tunnel::example_freelance_milestone,
    ),
]
fun cannot_record_milestone_when_completed() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let budget = coin::mint_for_testing<SUI>(10000, &mut ctx);

    let mut contract = example_freelance_milestone::create_contract<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        budget,
        5,
        2000,
        b"project",
        &clock,
        &mut ctx,
    );

    example_freelance_milestone::set_status_for_testing<SUI>(
        &mut contract,
        example_freelance_milestone::contract_completed(),
    );

    // party_a_balance = 10000 - 1*2000 = 8000, party_b_balance = 1*2000 = 2000
    example_freelance_milestone::record_milestone<SUI>(
        &mut contract,
        1,
        1,
        8000,
        2000,
        0,
        vector[],
        vector[],
        &clock,
    );

    example_freelance_milestone::destroy_contract_for_testing<SUI>(contract);
    clock::destroy_for_testing(clock);
}
