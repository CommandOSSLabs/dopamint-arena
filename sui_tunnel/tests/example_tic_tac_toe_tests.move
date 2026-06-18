#[test_only]
module sui_tunnel::example_tic_tac_toe_tests;

use std::unit_test::assert_eq;
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui_tunnel::example_tic_tac_toe;

#[test]
fun status_constants() {
    assert_eq!(example_tic_tac_toe::game_active(), 0);
    assert_eq!(example_tic_tac_toe::game_settled(), 1);
    assert_eq!(example_tic_tac_toe::game_disputed(), 2);
    assert_eq!(example_tic_tac_toe::game_force_closed(), 3);
    assert_eq!(example_tic_tac_toe::cell_empty(), 0);
    assert_eq!(example_tic_tac_toe::cell_x(), 1);
    assert_eq!(example_tic_tac_toe::cell_o(), 2);
    assert_eq!(example_tic_tac_toe::outcome_none(), 0);
    assert_eq!(example_tic_tac_toe::outcome_player_a(), 1);
    assert_eq!(example_tic_tac_toe::outcome_player_b(), 2);
    assert_eq!(example_tic_tac_toe::outcome_draw(), 3);
}

#[test]
fun create_game() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let stake = coin::mint_for_testing<SUI>(1000, &mut ctx);

    let game = example_tic_tac_toe::create_game<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        stake,
        &clock,
        &mut ctx,
    );

    assert_eq!(game.game_status<SUI>(), 0);
    assert_eq!(game.game_moves_count<SUI>(), 0);
    assert_eq!(game.game_stake_amount<SUI>(), 1000);
    assert_eq!(game.game_nonce<SUI>(), 0);

    let board = game.game_board<SUI>();
    assert_eq!(board.length(), 9);
    let mut i = 0u64;
    while (i < 9) {
        assert_eq!(board[i], 0);
        i = i + 1;
    };

    game.destroy_game_for_testing<SUI>();
    clock::destroy_for_testing(clock);
}

#[test]
fun game_pot_after_create() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let stake = coin::mint_for_testing<SUI>(1000, &mut ctx);

    let game = example_tic_tac_toe::create_game<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        stake,
        &clock,
        &mut ctx,
    );

    // Player A's stake is in the pot
    assert_eq!(game.game_total_pot<SUI>(), 1000);

    game.destroy_game_for_testing<SUI>();
    clock::destroy_for_testing(clock);
}

#[test]
fun record_move() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let stake = coin::mint_for_testing<SUI>(1000, &mut ctx);

    let mut game = example_tic_tac_toe::create_game<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        stake,
        &clock,
        &mut ctx,
    );

    // X plays center
    let board1 = vector[0, 0, 0, 0, 1, 0, 0, 0, 0];
    game.record_move<SUI>(
        board1,
        1,
        1,
        1000,
        1000,
        0,
        vector[],
        vector[],
        &clock,
    );
    assert_eq!(game.game_moves_count<SUI>(), 1);

    // O plays top-left
    let board2 = vector[2, 0, 0, 0, 1, 0, 0, 0, 0];
    game.record_move<SUI>(
        board2,
        2,
        2,
        1000,
        1000,
        0,
        vector[],
        vector[],
        &clock,
    );
    assert_eq!(game.game_moves_count<SUI>(), 2);
    assert_eq!(game.game_nonce<SUI>(), 2);

    game.destroy_game_for_testing<SUI>();
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_tic_tac_toe::EInvalidParameter,
        location = sui_tunnel::example_tic_tac_toe,
    ),
]
fun record_move_invalid_board_size() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let stake = coin::mint_for_testing<SUI>(1000, &mut ctx);

    let mut game = example_tic_tac_toe::create_game<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        stake,
        &clock,
        &mut ctx,
    );

    // Board with wrong size (8 cells instead of 9)
    let bad_board = vector[0, 0, 0, 0, 1, 0, 0, 0];
    game.record_move<SUI>(
        bad_board,
        1,
        1,
        1000,
        1000,
        0,
        vector[],
        vector[],
        &clock,
    );

    game.destroy_game_for_testing<SUI>();
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_tic_tac_toe::EInvalidParameter,
        location = sui_tunnel::example_tic_tac_toe,
    ),
]
fun record_move_invalid_cell_value() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let stake = coin::mint_for_testing<SUI>(1000, &mut ctx);

    let mut game = example_tic_tac_toe::create_game<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        stake,
        &clock,
        &mut ctx,
    );

    // Board with invalid cell value (3)
    let bad_board = vector[3, 0, 0, 0, 0, 0, 0, 0, 0];
    game.record_move<SUI>(
        bad_board,
        1,
        1,
        1000,
        1000,
        0,
        vector[],
        vector[],
        &clock,
    );

    game.destroy_game_for_testing<SUI>();
    clock::destroy_for_testing(clock);
}

// ============================================
// WINNER DETECTION TESTS
// ============================================

#[test]
fun check_winner_row_x() {
    // X wins top row
    let board = vector[1, 1, 1, 0, 2, 2, 0, 0, 0];
    assert_eq!(example_tic_tac_toe::check_winner(&board, 5), 1);
}

#[test]
fun check_winner_row_o() {
    // O wins middle row
    let board = vector[1, 0, 1, 2, 2, 2, 0, 0, 1];
    assert_eq!(example_tic_tac_toe::check_winner(&board, 6), 2);
}

#[test]
fun check_winner_column() {
    // X wins left column
    let board = vector[1, 2, 0, 1, 2, 0, 1, 0, 0];
    assert_eq!(example_tic_tac_toe::check_winner(&board, 5), 1);
}

#[test]
fun check_winner_diagonal() {
    // X wins main diagonal
    let board = vector[1, 2, 0, 0, 1, 2, 0, 0, 1];
    assert_eq!(example_tic_tac_toe::check_winner(&board, 5), 1);
}

#[test]
fun check_winner_anti_diagonal() {
    // O wins anti-diagonal
    let board = vector[1, 1, 2, 0, 2, 0, 2, 0, 1];
    assert_eq!(example_tic_tac_toe::check_winner(&board, 6), 2);
}

#[test]
fun check_winner_draw() {
    // Draw: all filled, no winner
    // X O X
    // X X O
    // O X O
    let board = vector[1, 2, 1, 1, 1, 2, 2, 1, 2];
    assert_eq!(example_tic_tac_toe::check_winner(&board, 9), 3);
}

#[test]
fun check_winner_no_winner_yet() {
    let board = vector[1, 0, 0, 0, 2, 0, 0, 0, 0];
    assert_eq!(example_tic_tac_toe::check_winner(&board, 2), 0);
}

#[test]
fun check_winner_empty_board() {
    let board = vector[0, 0, 0, 0, 0, 0, 0, 0, 0];
    assert_eq!(example_tic_tac_toe::check_winner(&board, 0), 0);
}

// ============================================
// PAYOUT TESTS
// ============================================

#[test]
fun calculate_payouts_player_a_wins() {
    let (a, b) = example_tic_tac_toe::calculate_payouts(2000, 1);
    assert_eq!(a, 2000);
    assert_eq!(b, 0);
}

#[test]
fun calculate_payouts_player_b_wins() {
    let (a, b) = example_tic_tac_toe::calculate_payouts(2000, 2);
    assert_eq!(a, 0);
    assert_eq!(b, 2000);
}

#[test]
fun calculate_payouts_draw_even() {
    let (a, b) = example_tic_tac_toe::calculate_payouts(2000, 3);
    assert_eq!(a, 1000);
    assert_eq!(b, 1000);
}

#[test]
fun calculate_payouts_draw_odd() {
    // Odd pot: remainder goes to player A
    let (a, b) = example_tic_tac_toe::calculate_payouts(2001, 3);
    assert_eq!(a, 1001);
    assert_eq!(b, 1000);
}

// ============================================
// HASH TESTS
// ============================================

#[test]
fun compute_board_hash_deterministic() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let stake = coin::mint_for_testing<SUI>(1000, &mut ctx);

    let game = example_tic_tac_toe::create_game<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        stake,
        &clock,
        &mut ctx,
    );

    let board = vector[1, 0, 0, 0, 2, 0, 0, 0, 0];
    let h1 = game.compute_board_hash<SUI>(&board, 2, 1);
    let h2 = game.compute_board_hash<SUI>(&board, 2, 1);
    assert_eq!(h1, h2);
    assert_eq!(h1.length(), 32);

    // Different board produces different hash
    let board2 = vector[1, 2, 0, 0, 0, 0, 0, 0, 0];
    let h3 = game.compute_board_hash<SUI>(&board2, 2, 1);
    assert!(h1 != h3);

    game.destroy_game_for_testing<SUI>();
    clock::destroy_for_testing(clock);
}

#[test]
fun game_state_accessors() {
    let state = example_tic_tac_toe::create_game_state_for_testing(
        vector[1, 2, 0, 0, 1, 0, 0, 0, 2],
        3,
        5,
    );

    let board = state.state_board();
    assert_eq!(board[0], 1);
    assert_eq!(board[1], 2);
    assert_eq!(state.state_moves_count(), 3);
    assert_eq!(state.state_nonce(), 5);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_tic_tac_toe::EInvalidNonce,
        location = sui_tunnel::example_tic_tac_toe,
    ),
]
fun record_move_stale_nonce() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let stake = coin::mint_for_testing<SUI>(1000, &mut ctx);

    let mut game = example_tic_tac_toe::create_game<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        stake,
        &clock,
        &mut ctx,
    );

    let board1 = vector[0, 0, 0, 0, 1, 0, 0, 0, 0];
    game.record_move<SUI>(
        board1,
        1,
        1,
        1000,
        1000,
        0,
        vector[],
        vector[],
        &clock,
    );

    let board2 = vector[2, 0, 0, 0, 1, 0, 0, 0, 0];
    game.record_move<SUI>(
        board2,
        2,
        0,
        1000,
        1000,
        0,
        vector[],
        vector[],
        &clock, // nonce 0 is stale
    );

    game.destroy_game_for_testing<SUI>();
    clock::destroy_for_testing(clock);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_tic_tac_toe::EInvalidState,
        location = sui_tunnel::example_tic_tac_toe,
    ),
]
fun cannot_record_move_when_settled() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";
    let stake = coin::mint_for_testing<SUI>(1000, &mut ctx);

    let mut game = example_tic_tac_toe::create_game<SUI>(
        @0x0,
        pk_a,
        @0x2,
        pk_b,
        stake,
        &clock,
        &mut ctx,
    );

    game.set_status_for_testing<SUI>(
        example_tic_tac_toe::game_settled(),
    );

    let board = vector[0, 0, 0, 0, 1, 0, 0, 0, 0];
    game.record_move<SUI>(
        board,
        1,
        1,
        1000,
        1000,
        0,
        vector[],
        vector[],
        &clock,
    );

    game.destroy_game_for_testing<SUI>();
    clock::destroy_for_testing(clock);
}
