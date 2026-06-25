#[test_only]
module sui_tunnel::example_coin_flip_tests;

use std::unit_test::assert_eq;
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario;
use sui_tunnel::example_coin_flip;
use sui_tunnel::randomness;

const PLAYER_1: address = @0xA11CE;
const PLAYER_2: address = @0xB0B;
const OUTSIDER: address = @0xCAFE;
const BET: u64 = 1000;
const START_TIME: u64 = 1000;

#[test]
fun status_constants() {
    assert_eq!(example_coin_flip::status_awaiting_commits(), 0);
    assert_eq!(example_coin_flip::status_awaiting_reveals(), 1);
    assert_eq!(example_coin_flip::status_completed(), 2);
    assert_eq!(example_coin_flip::status_cancelled(), 3);
}

#[test]
fun choice_constants() {
    assert_eq!(example_coin_flip::choice_heads(), 0);
    assert_eq!(example_coin_flip::choice_tails(), 1);
}

#[test]
fun result_to_string() {
    assert_eq!(example_coin_flip::result_to_string(0), b"heads");
    assert_eq!(example_coin_flip::result_to_string(1), b"tails");
}

#[test]
fun create_player_commitment() {
    let value = b"my_random_value";
    let salt = b"my_salt_at_least_16_bytes";
    let player = @0x1234;

    let commitment1 = example_coin_flip::create_player_commitment(&value, &salt, player);
    let commitment2 = example_coin_flip::create_player_commitment(&value, &salt, player);

    // Same inputs produce same commitment
    assert_eq!(commitment1, commitment2);

    // Commitment is 32 bytes
    assert_eq!(commitment1.length(), 32);

    // Different value produces different commitment
    let commitment3 = example_coin_flip::create_player_commitment(
        &b"different_value",
        &salt,
        player,
    );
    assert!(commitment1 != commitment3);
}

#[test]
fun fair_randomness_simulation() {
    // Simulate the randomness combination
    let value_1 = b"player_1_random";
    let salt_1 = b"player_1_salt_at_least_16";
    let value_2 = b"player_2_random";
    let salt_2 = b"player_2_salt_at_least_16";

    let reveal_1 = randomness::create_reveal(value_1, salt_1);
    let reveal_2 = randomness::create_reveal(value_2, salt_2);

    let seed = randomness::combine_reveals(&reveal_1, &reveal_2);

    // Get flip result
    let (result, _) = randomness::next_u8_in_range(&seed, 0, 2);

    // Result should be 0 or 1
    assert!(result < 2);

    // Same inputs should give same result (deterministic)
    let reveal_1b = randomness::create_reveal(value_1, salt_1);
    let reveal_2b = randomness::create_reveal(value_2, salt_2);
    let seed2 = randomness::combine_reveals(&reveal_1b, &reveal_2b);
    let (result2, _) = randomness::next_u8_in_range(&seed2, 0, 2);

    assert_eq!(result, result2);
}

/// Test: Player 1 cannot be the same as player 2
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_coin_flip::EInvalidParties,
        location = sui_tunnel::example_coin_flip,
    ),
]
fun create_game_same_players() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = sui::clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let commitment = vector::tabulate!(32, |_| 0u8);

    let stake = sui::coin::mint_for_testing<SUI>(1000, &mut ctx);
    // sender is @0x0 (player_1), player_2 is also @0x0 -> invalid_parties
    example_coin_flip::create_game<SUI>(@0x0, 0, commitment, stake, &clock, &mut ctx);

    clock.destroy_for_testing();
}

/// Test: Cannot create game with zero bet amount
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_coin_flip::EInvalidDepositAmount,
        location = sui_tunnel::example_coin_flip,
    ),
]
fun create_game_zero_bet() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = sui::clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let commitment = vector::tabulate!(32, |_| 0u8);

    let stake = sui::coin::mint_for_testing<SUI>(0, &mut ctx);
    // Zero bet -> invalid_deposit_amount
    example_coin_flip::create_game<SUI>(@0xBBBB, 0, commitment, stake, &clock, &mut ctx);

    clock.destroy_for_testing();
}

/// Test: Cannot create game with invalid choice (not heads or tails)
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_coin_flip::EInvalidParameter,
        location = sui_tunnel::example_coin_flip,
    ),
]
fun create_game_invalid_choice() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = sui::clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let commitment = vector::tabulate!(32, |_| 0u8);

    let stake = sui::coin::mint_for_testing<SUI>(1000, &mut ctx);
    // Choice 5 is neither HEADS (0) nor TAILS (1) -> invalid_parameter
    example_coin_flip::create_game<SUI>(@0xBBBB, 5, commitment, stake, &clock, &mut ctx);

    clock.destroy_for_testing();
}

/// Test: Wrong player cannot join the game
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_coin_flip::ENotAuthorized,
        location = sui_tunnel::example_coin_flip,
    ),
]
fun wrong_player_joins_game() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = sui::clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let commitment = vector::tabulate!(32, |_| 0u8);

    let stake = sui::coin::mint_for_testing<SUI>(1000, &mut ctx);
    // Player 1 is @0x0, Player 2 is @0xBBBB
    let mut game = example_coin_flip::create_game_for_testing<SUI>(
        @0xBBBB,
        0,
        commitment,
        stake,
        &clock,
        &mut ctx,
    );

    let mut commitment2 = vector<u8>[];
    let mut j = 0u64;
    while (j < 32) { commitment2.push_back(1); j = j + 1u64; };

    let stake2 = sui::coin::mint_for_testing<SUI>(1000, &mut ctx);
    // sender is @0x0 (player_1), but join_game requires sender == player_2 (@0xBBBB) -> not_authorized
    example_coin_flip::join_game<SUI>(&mut game, commitment2, stake2, &ctx);

    std::unit_test::destroy(game);
    clock.destroy_for_testing();
}

/// Builds a game in STATUS_AWAITING_REVEALS where neither player has revealed.
fun joined_game(
    scenario: &mut test_scenario::Scenario,
    clock: &clock::Clock,
): example_coin_flip::CoinFlipGame<SUI> {
    let commitment_1 = example_coin_flip::create_player_commitment(
        &b"p1_value",
        &b"p1_salt_at_least_16_bytes",
        PLAYER_1,
    );
    let stake_1 = coin::mint_for_testing<SUI>(BET, scenario.ctx());
    let mut game = example_coin_flip::create_game_for_testing<SUI>(
        PLAYER_2,
        example_coin_flip::choice_heads(),
        commitment_1,
        stake_1,
        clock,
        scenario.ctx(),
    );

    scenario.next_tx(PLAYER_2);
    let commitment_2 = example_coin_flip::create_player_commitment(
        &b"p2_value",
        &b"p2_salt_at_least_16_bytes",
        PLAYER_2,
    );
    let stake_2 = coin::mint_for_testing<SUI>(BET, scenario.ctx());
    example_coin_flip::join_game<SUI>(&mut game, commitment_2, stake_2, scenario.ctx());

    game
}

/// Both-silent refund path: if neither player reveals before the timeout, either
/// player can call cancel_no_reveal to refund each player their own stake so the
/// pot is never trapped.
#[test]
fun cancel_no_reveal_refunds_both_stakes() {
    let mut scenario = test_scenario::begin(PLAYER_1);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(START_TIME);

    let mut game = joined_game(&mut scenario, &clock);
    assert_eq!(example_coin_flip::game_status(&game), example_coin_flip::status_awaiting_reveals());

    clock.set_for_testing(START_TIME + example_coin_flip::timeout_ms() + 1);

    scenario.next_tx(PLAYER_1);
    example_coin_flip::cancel_no_reveal<SUI>(&mut game, &clock, scenario.ctx());
    assert_eq!(example_coin_flip::game_status(&game), example_coin_flip::status_cancelled());

    scenario.next_tx(PLAYER_1);
    let refund_1 = scenario.take_from_address<coin::Coin<SUI>>(PLAYER_1);
    assert_eq!(refund_1.value(), BET);
    refund_1.burn_for_testing();

    let refund_2 = scenario.take_from_address<coin::Coin<SUI>>(PLAYER_2);
    assert_eq!(refund_2.value(), BET);
    refund_2.burn_for_testing();

    std::unit_test::destroy(game);
    clock.destroy_for_testing();
    scenario.end();
}

/// Test: cancel_no_reveal cannot run before the timeout is reached.
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_coin_flip::ETimeoutNotReached,
        location = sui_tunnel::example_coin_flip,
    ),
]
fun cancel_no_reveal_before_timeout() {
    let mut scenario = test_scenario::begin(PLAYER_1);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(START_TIME);

    let mut game = joined_game(&mut scenario, &clock);

    scenario.next_tx(PLAYER_1);
    example_coin_flip::cancel_no_reveal<SUI>(&mut game, &clock, scenario.ctx());

    std::unit_test::destroy(game);
    clock.destroy_for_testing();
    scenario.end();
}

/// Test: an outsider cannot call cancel_no_reveal.
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_coin_flip::ENotAuthorized,
        location = sui_tunnel::example_coin_flip,
    ),
]
fun cancel_no_reveal_outsider() {
    let mut scenario = test_scenario::begin(PLAYER_1);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(START_TIME);

    let mut game = joined_game(&mut scenario, &clock);
    clock.set_for_testing(START_TIME + example_coin_flip::timeout_ms() + 1);

    scenario.next_tx(OUTSIDER);
    example_coin_flip::cancel_no_reveal<SUI>(&mut game, &clock, scenario.ctx());

    std::unit_test::destroy(game);
    clock.destroy_for_testing();
    scenario.end();
}

/// Test: cancel_no_reveal is rejected once a player has revealed (use claim_no_reveal instead).
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_coin_flip::EInvalidState,
        location = sui_tunnel::example_coin_flip,
    ),
]
fun cancel_no_reveal_after_one_revealed() {
    let mut scenario = test_scenario::begin(PLAYER_1);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(START_TIME);

    let mut game = joined_game(&mut scenario, &clock);

    scenario.next_tx(PLAYER_1);
    example_coin_flip::reveal_player_1<SUI>(
        &mut game,
        b"p1_value",
        b"p1_salt_at_least_16_bytes",
        scenario.ctx(),
    );

    clock.set_for_testing(START_TIME + example_coin_flip::timeout_ms() + 1);

    scenario.next_tx(PLAYER_1);
    example_coin_flip::cancel_no_reveal<SUI>(&mut game, &clock, scenario.ctx());

    std::unit_test::destroy(game);
    clock.destroy_for_testing();
    scenario.end();
}

/// Test: Cannot create game with wrong commitment length (requires 32 bytes)
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_coin_flip::EInvalidParameter,
        location = sui_tunnel::example_coin_flip,
    ),
]
fun create_game_wrong_commitment_length() {
    let mut ctx = sui::tx_context::dummy();
    let mut clock = sui::clock::create_for_testing(&mut ctx);
    clock.set_for_testing(1000);

    let stake = sui::coin::mint_for_testing<SUI>(1000, &mut ctx);
    // Commitment is only 3 bytes, not 32 -> invalid_parameter
    example_coin_flip::create_game<SUI>(
        @0xBBBB,
        0,
        vector[1u8, 2, 3],
        stake,
        &clock,
        &mut ctx,
    );

    clock.destroy_for_testing();
}
