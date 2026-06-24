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

    assert_eq!(example_tic_tac_toe::game_status<SUI>(&game), 0);
    assert_eq!(example_tic_tac_toe::game_moves_count<SUI>(&game), 0);
    assert_eq!(example_tic_tac_toe::game_stake_amount<SUI>(&game), 1000);
    assert_eq!(example_tic_tac_toe::game_nonce<SUI>(&game), 0);

    let board = example_tic_tac_toe::game_board<SUI>(&game);
    assert_eq!(board.length(), 9);
    9u64.do!(|i| assert_eq!(board[i], 0));

    example_tic_tac_toe::destroy_game_for_testing<SUI>(game);
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
    assert_eq!(example_tic_tac_toe::game_total_pot<SUI>(&game), 1000);

    example_tic_tac_toe::destroy_game_for_testing<SUI>(game);
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
    example_tic_tac_toe::record_move<SUI>(
        &mut game,
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
    assert_eq!(example_tic_tac_toe::game_moves_count<SUI>(&game), 1);

    // O plays top-left
    let board2 = vector[2, 0, 0, 0, 1, 0, 0, 0, 0];
    example_tic_tac_toe::record_move<SUI>(
        &mut game,
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
    assert_eq!(example_tic_tac_toe::game_moves_count<SUI>(&game), 2);
    assert_eq!(example_tic_tac_toe::game_nonce<SUI>(&game), 2);

    example_tic_tac_toe::destroy_game_for_testing<SUI>(game);
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
    example_tic_tac_toe::record_move<SUI>(
        &mut game,
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

    example_tic_tac_toe::destroy_game_for_testing<SUI>(game);
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
    example_tic_tac_toe::record_move<SUI>(
        &mut game,
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

    example_tic_tac_toe::destroy_game_for_testing<SUI>(game);
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

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_tic_tac_toe::EInvalidParameter,
        location = sui_tunnel::example_tic_tac_toe,
    ),
]
fun check_winner_short_board() {
    let board = vector[1, 1, 1, 0, 2, 2];
    example_tic_tac_toe::check_winner(&board, 5);
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
    let h1 = example_tic_tac_toe::compute_board_hash<SUI>(&game, &board, 2, 1);
    let h2 = example_tic_tac_toe::compute_board_hash<SUI>(&game, &board, 2, 1);
    assert_eq!(h1, h2);
    assert_eq!(h1.length(), 32);

    // Different board produces different hash
    let board2 = vector[1, 2, 0, 0, 0, 0, 0, 0, 0];
    let h3 = example_tic_tac_toe::compute_board_hash<SUI>(&game, &board2, 2, 1);
    assert!(h1 != h3);

    example_tic_tac_toe::destroy_game_for_testing<SUI>(game);
    clock::destroy_for_testing(clock);
}

#[test]
fun game_state_accessors() {
    let state = example_tic_tac_toe::create_game_state_for_testing(
        vector[1, 2, 0, 0, 1, 0, 0, 0, 2],
        3,
        5,
    );

    let board = example_tic_tac_toe::state_board(&state);
    assert_eq!(board[0], 1);
    assert_eq!(board[1], 2);
    assert_eq!(example_tic_tac_toe::state_moves_count(&state), 3);
    assert_eq!(example_tic_tac_toe::state_nonce(&state), 5);
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
    example_tic_tac_toe::record_move<SUI>(
        &mut game,
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
    example_tic_tac_toe::record_move<SUI>(
        &mut game,
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

    example_tic_tac_toe::destroy_game_for_testing<SUI>(game);
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

    example_tic_tac_toe::set_status_for_testing<SUI>(
        &mut game,
        example_tic_tac_toe::game_settled(),
    );

    let board = vector[0, 0, 0, 0, 1, 0, 0, 0, 0];
    example_tic_tac_toe::record_move<SUI>(
        &mut game,
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

    example_tic_tac_toe::destroy_game_for_testing<SUI>(game);
    clock::destroy_for_testing(clock);
}
