#[test_only]
module sui_tunnel::example_coin_flip_tests;

use std::unit_test::assert_eq;
use sui::sui::SUI;
use sui_tunnel::example_coin_flip;
use sui_tunnel::randomness;

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

    let seed = reveal_1.combine_reveals(&reveal_2);

    // Get flip result
    let (result, _) = seed.next_u8_in_range(0, 2);

    // Result should be 0 or 1
    assert!(result < 2);

    // Same inputs should give same result (deterministic)
    let reveal_1b = randomness::create_reveal(value_1, salt_1);
    let reveal_2b = randomness::create_reveal(value_2, salt_2);
    let seed2 = reveal_1b.combine_reveals(&reveal_2b);
    let (result2, _) = seed2.next_u8_in_range(0, 2);

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

    let mut commitment = vector<u8>[];
    let mut i = 0u64;
    while (i < 32) { commitment.push_back(0); i = i + 1u64; };

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

    let mut commitment = vector<u8>[];
    let mut i = 0u64;
    while (i < 32) { commitment.push_back(0); i = i + 1u64; };

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

    let mut commitment = vector<u8>[];
    let mut i = 0u64;
    while (i < 32) { commitment.push_back(0); i = i + 1u64; };

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

    let mut commitment = vector<u8>[];
    let mut i = 0u64;
    while (i < 32) { commitment.push_back(0); i = i + 1u64; };

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
    game.join_game<SUI>(commitment2, stake2, &ctx);

    std::unit_test::destroy(game);
    clock.destroy_for_testing();
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
