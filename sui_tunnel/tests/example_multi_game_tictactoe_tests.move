#[test_only]
module sui_tunnel::example_multi_game_tictactoe_tests;

use std::unit_test::assert_eq;
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario as ts;
use sui_tunnel::example_multi_game_tictactoe as mg;

// ============================================
// CONSTANTS
// ============================================

#[test]
fun status_constants() {
    assert_eq!(mg::session_active(), 0);
    assert_eq!(mg::session_settled(), 1);
    assert_eq!(mg::session_disputed(), 2);
    assert_eq!(mg::session_force_closed(), 3);
    assert_eq!(mg::cell_empty(), 0);
    assert_eq!(mg::cell_x(), 1);
    assert_eq!(mg::cell_o(), 2);
    assert_eq!(mg::outcome_none(), 0);
    assert_eq!(mg::outcome_player_a(), 1);
    assert_eq!(mg::outcome_player_b(), 2);
    assert_eq!(mg::outcome_draw(), 3);
}

// ============================================
// TEST FIXTURE
// ============================================

/// Open a fully-active session by running the REAL deposit flow: party A
/// (@0xA) creates + stakes, then a second transaction as party B (@0xB) joins +
/// stakes. Returns the scenario so callers can drive further transactions.
#[test_only]
fun open_session(
    stake: u64,
    wager: u64,
    target_games: u64,
): (ts::Scenario, mg::MultiGameTicTacToe<SUI>, clock::Clock) {
    let pk_a = x"0000000000000000000000000000000000000000000000000000000000000001";
    let pk_b = x"0000000000000000000000000000000000000000000000000000000000000002";

    let mut sc = ts::begin(@0xA);
    let clock = clock::create_for_testing(sc.ctx());

    let stake_a = coin::mint_for_testing<SUI>(stake, sc.ctx());
    let mut session = mg::create_session<SUI>(
        @0xA,
        pk_a,
        @0xB,
        pk_b,
        wager,
        target_games,
        0, // penalty_amount
        stake_a,
        &clock,
        sc.ctx(),
    );

    sc.next_tx(@0xB);
    let stake_b = coin::mint_for_testing<SUI>(stake, sc.ctx());
    session.join_session(stake_b, &clock, sc.ctx());

    (sc, session, clock)
}

#[test_only]
fun close_fixture(sc: ts::Scenario, session: mg::MultiGameTicTacToe<SUI>, clock: clock::Clock) {
    session.destroy_session_for_testing();
    clock::destroy_for_testing(clock);
    sc.end();
}

// ============================================
// LIFECYCLE / INITIAL STATE
// ============================================

#[test]
fun create_and_join_seeds_even_ledger() {
    let (sc, session, clock) = open_session(100, 10, 0);

    assert_eq!(session.session_status(), mg::session_active());
    assert_eq!(session.session_total_pot(), 200);
    assert_eq!(session.stake_per_player(), 100);
    assert_eq!(session.wager_per_game(), 10);
    assert_eq!(session.session_balance_a(), 100);
    assert_eq!(session.session_balance_b(), 100);
    assert_eq!(session.games_played(), 0);
    assert_eq!(session.session_nonce(), 0);

    close_fixture(sc, session, clock);
}

// ============================================
// MULTI-GAME ACCOUNTING (the core behavior)
// ============================================

/// Play three games in ONE session (A, B, A win) and verify the cumulative
/// scoreboard and running balances. All updates are off-chain (empty sigs).
/// A move that completes a game folds the result; a non-winning move does not
/// touch balances.
#[test]
fun three_games_accumulate_in_one_session() {
    let (sc, mut session, clock) = open_session(100, 10, 0);

    // --- Game 1: an in-progress move first (no money moves), then A wins ---
    let mid = vector[1, 0, 0, 0, 2, 0, 0, 0, 0];
    session.record_move(mid, 2, 1, 0, vector[], vector[], &clock);
    assert_eq!(session.games_played(), 0);
    assert_eq!(session.session_balance_a(), 100);
    assert_eq!(session.session_balance_b(), 100);

    let a_wins = vector[1, 1, 1, 2, 2, 0, 0, 0, 0];
    session.record_move(a_wins, 5, 2, 0, vector[], vector[], &clock);
    assert_eq!(session.games_played(), 1);
    assert_eq!(session.wins_a(), 1);
    assert_eq!(session.session_balance_a(), 110);
    assert_eq!(session.session_balance_b(), 90);
    // Board reset for next game.
    assert_eq!(session.session_moves_count(), 0);

    // --- Game 2: B wins (top row of O) ---
    let b_wins = vector[2, 2, 2, 1, 1, 0, 0, 0, 0];
    session.record_move(b_wins, 5, 3, 0, vector[], vector[], &clock);
    assert_eq!(session.games_played(), 2);
    assert_eq!(session.wins_b(), 1);
    assert_eq!(session.session_balance_a(), 100);
    assert_eq!(session.session_balance_b(), 100);

    // --- Game 3: A wins again ---
    let a_wins_2 = vector[1, 1, 1, 2, 2, 0, 0, 0, 0];
    session.record_move(a_wins_2, 5, 4, 0, vector[], vector[], &clock);

    // Final cumulative state.
    assert_eq!(session.games_played(), 3);
    assert_eq!(session.wins_a(), 2);
    assert_eq!(session.wins_b(), 1);
    assert_eq!(session.draws(), 0);
    assert_eq!(session.session_balance_a(), 110);
    assert_eq!(session.session_balance_b(), 90);
    assert_eq!(session.session_nonce(), 4);
    // Pot is conserved across all games.
    assert_eq!(
        session.session_balance_a() + session.session_balance_b(),
        session.session_total_pot(),
    );

    close_fixture(sc, session, clock);
}

/// A draw leaves balances unchanged but increments the games + draws counters.
#[test]
fun draw_game_keeps_balances() {
    let (sc, mut session, clock) = open_session(100, 10, 0);

    // Full board, no line: X O X / X O O / O X X
    let draw = vector[1, 2, 1, 1, 2, 2, 2, 1, 1];
    session.record_move(draw, 9, 1, 0, vector[], vector[], &clock);

    assert_eq!(session.games_played(), 1);
    assert_eq!(session.draws(), 1);
    assert_eq!(session.wins_a(), 0);
    assert_eq!(session.wins_b(), 0);
    assert_eq!(session.session_balance_a(), 100);
    assert_eq!(session.session_balance_b(), 100);

    close_fixture(sc, session, clock);
}

// ============================================
// PURE OUTCOME APPLICATION
// ============================================

#[test]
fun apply_outcome_player_a() {
    let (games, wa, wb, dr, ba, bb) = mg::apply_game_outcome(0, 0, 0, 0, 100, 100, 10, 1);
    assert_eq!(games, 1);
    assert_eq!(wa, 1);
    assert_eq!(wb, 0);
    assert_eq!(dr, 0);
    assert_eq!(ba, 110);
    assert_eq!(bb, 90);
}

#[test]
fun apply_outcome_player_b() {
    let (games, wa, wb, dr, ba, bb) = mg::apply_game_outcome(5, 2, 3, 0, 100, 100, 25, 2);
    assert_eq!(games, 6);
    assert_eq!(wa, 2);
    assert_eq!(wb, 4);
    assert_eq!(dr, 0);
    assert_eq!(ba, 75);
    assert_eq!(bb, 125);
}

#[test]
fun apply_outcome_draw() {
    let (games, wa, wb, dr, ba, bb) = mg::apply_game_outcome(1, 1, 0, 0, 110, 90, 10, 3);
    assert_eq!(games, 2);
    assert_eq!(wa, 1);
    assert_eq!(wb, 0);
    assert_eq!(dr, 1);
    assert_eq!(ba, 110);
    assert_eq!(bb, 90);
}

/// The wager is clamped to the loser's remaining balance, so a balance can never
/// underflow even if a player is nearly broke.
#[test]
fun apply_outcome_clamps_wager() {
    // B has only 5 left but wager is 10; A can win at most 5.
    let (_g, _wa, _wb, _dr, ba, bb) = mg::apply_game_outcome(9, 9, 0, 0, 195, 5, 10, 1);
    assert_eq!(ba, 200);
    assert_eq!(bb, 0);
}

// ============================================
// WINNER DETECTION (self-contained copy)
// ============================================

#[test]
fun winner_row_and_draw_and_none() {
    assert_eq!(mg::check_winner(&vector[1, 1, 1, 0, 2, 2, 0, 0, 0], 5), 1);
    assert_eq!(mg::check_winner(&vector[2, 2, 2, 1, 1, 0, 0, 0, 0], 5), 2);
    assert_eq!(mg::check_winner(&vector[1, 2, 1, 1, 2, 2, 2, 1, 1], 9), 3);
    assert_eq!(mg::check_winner(&vector[1, 0, 0, 0, 2, 0, 0, 0, 0], 2), 0);
}

// ============================================
// HASHING
// ============================================

#[test]
fun session_hash_deterministic_and_bound() {
    let (sc, session, clock) = open_session(100, 10, 0);

    let board = vector[1, 0, 0, 0, 2, 0, 0, 0, 0];
    let h1 = session.compute_session_hash(&board, 2, 0, 0, 0, 0, 100, 100);
    let h2 = session.compute_session_hash(&board, 2, 0, 0, 0, 0, 100, 100);
    assert_eq!(h1, h2);
    assert_eq!(h1.length(), 32);

    // Different running balance -> different hash.
    let h3 = session.compute_session_hash(&board, 2, 0, 0, 0, 0, 110, 90);
    assert!(h1 != h3);
    // Different scoreboard (games_played) -> different hash.
    let h4 = session.compute_session_hash(&board, 2, 1, 1, 0, 0, 100, 100);
    assert!(h1 != h4);

    close_fixture(sc, session, clock);
}

// ============================================
// NEGATIVE / INVARIANT TESTS
// ============================================

#[test, expected_failure(abort_code = mg::EInvalidNonce, location = mg)]
fun record_move_rejects_stale_nonce() {
    let (sc, mut session, clock) = open_session(100, 10, 0);

    let a_wins = vector[1, 1, 1, 2, 2, 0, 0, 0, 0];
    session.record_move(a_wins, 5, 5, 0, vector[], vector[], &clock);
    // nonce 5 already committed; a second update at nonce 5 is stale (not greater).
    let mid = vector[1, 0, 0, 0, 2, 0, 0, 0, 0];
    session.record_move(mid, 2, 5, 0, vector[], vector[], &clock);

    close_fixture(sc, session, clock);
}

#[test, expected_failure(abort_code = mg::ESessionComplete, location = mg)]
fun record_move_rejects_play_over_target() {
    // target_games = 1
    let (sc, mut session, clock) = open_session(100, 10, 1);

    let a_wins = vector[1, 1, 1, 2, 2, 0, 0, 0, 0];
    session.record_move(a_wins, 5, 1, 0, vector[], vector[], &clock);
    assert!(session.is_session_complete());

    // The session is complete; any further move must abort.
    let a_wins_2 = vector[1, 1, 1, 2, 2, 0, 0, 0, 0];
    session.record_move(a_wins_2, 5, 2, 0, vector[], vector[], &clock);

    close_fixture(sc, session, clock);
}

#[test, expected_failure(abort_code = mg::EInvalidParameter, location = mg)]
fun record_move_rejects_bad_board_size() {
    let (sc, mut session, clock) = open_session(100, 10, 0);

    let bad = vector[1, 1, 1, 2, 2, 0, 0, 0]; // 8 cells
    session.record_move(bad, 5, 1, 0, vector[], vector[], &clock);

    close_fixture(sc, session, clock);
}

#[test, expected_failure(abort_code = mg::EBalanceMismatch, location = mg)]
fun settle_rejects_ledger_mismatch() {
    let (mut sc, mut session, clock) = open_session(100, 10, 0);

    // Running ledger is 100/100; claiming 150/50 must abort before any close.
    session.settle_session(
        150,
        50,
        vector[1],
        vector[1],
        0,
        &clock,
        sc.ctx(),
    );

    close_fixture(sc, session, clock);
}

#[test, expected_failure(abort_code = mg::EInvalidState, location = mg)]
fun cannot_record_after_settled_status() {
    let (sc, mut session, clock) = open_session(100, 10, 0);

    session.set_status_for_testing(mg::session_settled());

    let a_wins = vector[1, 1, 1, 2, 2, 0, 0, 0, 0];
    session.record_move(a_wins, 5, 1, 0, vector[], vector[], &clock);

    close_fixture(sc, session, clock);
}
