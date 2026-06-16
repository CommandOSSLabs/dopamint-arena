#[test_only]
module sui_tunnel::example_rock_paper_scissors_tests;

use std::unit_test::assert_eq;
use sui::test_utils::destroy;
use sui::clock;
use sui::coin::{Self, Coin};
use sui::hash;
use sui::sui::SUI;
use sui::test_scenario;
use sui_tunnel::example_rock_paper_scissors as rps;

// ============================================
// CONSTANTS / HELPERS
// ============================================

const PLAYER1: address = @0xA1;
const PLAYER2: address = @0xB2;
const OUTSIDER: address = @0xC3;

const STAKE: u64 = 1000;

/// Reproduce the module's commitment construction exactly:
/// `commit = blake2b256(move_byte ++ salt)` (see `reveal_move` in the source).
fun make_commitment(move_choice: u8, salt: vector<u8>): vector<u8> {
    let mut data = vector<u8>[];
    data.push_back(move_choice);
    data.append(salt);
    hash::blake2b256(&data)
}

fun salt_a(): vector<u8> { b"player1-secret-salt-abcdefghij01" }

fun salt_b(): vector<u8> { b"player2-secret-salt-abcdefghij02" }

// ============================================
// EXISTING PURE-PREDICATE TESTS (kept)
// ============================================

#[test]
fun move_constants() {
    assert_eq!(rps::move_rock(), 0);
    assert_eq!(rps::move_paper(), 1);
    assert_eq!(rps::move_scissors(), 2);
}

#[test]
fun beats_logic() {
    let rock = rps::move_rock();
    let paper = rps::move_paper();
    let scissors = rps::move_scissors();
    // Rock beats Scissors
    assert!(rps::beats_for_testing(rock, scissors));
    // Paper beats Rock
    assert!(rps::beats_for_testing(paper, rock));
    // Scissors beats Paper
    assert!(rps::beats_for_testing(scissors, paper));
    // Same move doesn't beat itself
    assert!(!rps::beats_for_testing(rock, rock));
    assert!(!rps::beats_for_testing(paper, paper));
    assert!(!rps::beats_for_testing(scissors, scissors));
}

#[test]
fun status_constants() {
    assert_eq!(rps::status_waiting_commits(), 0);
    assert_eq!(rps::status_waiting_reveals(), 1);
    assert_eq!(rps::status_complete(), 2);
    assert_eq!(rps::status_cancelled(), 3);
}

// ============================================
// FULL LIFECYCLE: DECISIVE WIN
// ============================================

/// Full round: create -> join -> commit (both) -> reveal (both) -> settle.
/// Player1 plays Rock, Player2 plays Scissors -> Player1 wins decisively.
/// The winner must receive the WHOLE pot (2 * STAKE) and was_tiebreaker == false.
#[test]
fun full_round_player1_wins() {
    let mut scenario = test_scenario::begin(PLAYER1);
    let clock = clock::create_for_testing(scenario.ctx());

    let rock = rps::move_rock();
    let scissors = rps::move_scissors();

    // --- Player1 creates the game with a stake ---
    {
        let stake = coin::mint_for_testing<SUI>(STAKE, scenario.ctx());
        rps::create_game<SUI>(PLAYER2, stake, &clock, scenario.ctx());
    };

    // --- Player2 joins with a matching stake ---
    scenario.next_tx(PLAYER2);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        let stake = coin::mint_for_testing<SUI>(STAKE, scenario.ctx());
        rps::join_game<SUI>(&mut game, stake, scenario.ctx());
        assert_eq!(rps::game_status(&game), rps::status_waiting_commits());
        assert_eq!(rps::game_stake_amount(&game), STAKE);
        test_scenario::return_shared(game);
    };

    // --- Player1 commits Rock ---
    scenario.next_tx(PLAYER1);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        rps::commit_move<SUI>(&mut game, make_commitment(rock, salt_a()), &clock, scenario.ctx());
        // Only one commit so far: still waiting for commits.
        assert_eq!(rps::game_status(&game), rps::status_waiting_commits());
        test_scenario::return_shared(game);
    };

    // --- Player2 commits Scissors -> moves to reveal phase ---
    scenario.next_tx(PLAYER2);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        rps::commit_move<SUI>(
            &mut game,
            make_commitment(scissors, salt_b()),
            &clock,
            scenario.ctx(),
        );
        assert_eq!(rps::game_status(&game), rps::status_waiting_reveals());
        test_scenario::return_shared(game);
    };

    // --- Player1 reveals Rock ---
    scenario.next_tx(PLAYER1);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        rps::reveal_move<SUI>(&mut game, rock, salt_a(), scenario.ctx());
        assert!(rps::game_player1_revealed(&game));
        assert!(!rps::game_player2_revealed(&game));
        test_scenario::return_shared(game);
    };

    // --- Player2 reveals Scissors ---
    scenario.next_tx(PLAYER2);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        rps::reveal_move<SUI>(&mut game, scissors, salt_b(), scenario.ctx());
        assert!(rps::game_player2_revealed(&game));
        test_scenario::return_shared(game);
    };

    // --- Player1 settles; Rock beats Scissors -> Player1 wins ---
    scenario.next_tx(PLAYER1);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        let result = rps::settle_game<SUI>(&mut game, scenario.ctx());
        assert_eq!(rps::result_winner(&result), PLAYER1);
        assert_eq!(rps::result_player1_move(&result), rock);
        assert_eq!(rps::result_player2_move(&result), scissors);
        assert!(!rps::result_was_tiebreaker(&result));
        assert_eq!(rps::game_status(&game), rps::status_complete());
        test_scenario::return_shared(game);
    };

    // --- Winner (Player1) must own a coin worth the entire pot (2 * STAKE) ---
    scenario.next_tx(PLAYER1);
    {
        let prize = scenario.take_from_address<Coin<SUI>>(PLAYER1);
        assert_eq!(coin::value(&prize), 2 * STAKE);
        coin::burn_for_testing(prize);
    };
    // Player2 must have received nothing.
    assert!(!test_scenario::has_most_recent_for_address<Coin<SUI>>(PLAYER2));

    clock.destroy_for_testing();
    scenario.end();
}

// ============================================
// FULL LIFECYCLE: PLAYER2 WINS (other direction)
// ============================================

/// Player1 plays Scissors, Player2 plays Rock -> Rock beats Scissors -> Player2 wins.
/// Player2 settles and receives the full pot.
#[test]
fun full_round_player2_wins() {
    let mut scenario = test_scenario::begin(PLAYER1);
    let clock = clock::create_for_testing(scenario.ctx());

    let rock = rps::move_rock();
    let scissors = rps::move_scissors();

    {
        let stake = coin::mint_for_testing<SUI>(STAKE, scenario.ctx());
        rps::create_game<SUI>(PLAYER2, stake, &clock, scenario.ctx());
    };

    scenario.next_tx(PLAYER2);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        let stake = coin::mint_for_testing<SUI>(STAKE, scenario.ctx());
        rps::join_game<SUI>(&mut game, stake, scenario.ctx());
        test_scenario::return_shared(game);
    };

    scenario.next_tx(PLAYER1);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        rps::commit_move<SUI>(
            &mut game,
            make_commitment(scissors, salt_a()),
            &clock,
            scenario.ctx(),
        );
        test_scenario::return_shared(game);
    };

    scenario.next_tx(PLAYER2);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        rps::commit_move<SUI>(&mut game, make_commitment(rock, salt_b()), &clock, scenario.ctx());
        test_scenario::return_shared(game);
    };

    scenario.next_tx(PLAYER1);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        rps::reveal_move<SUI>(&mut game, scissors, salt_a(), scenario.ctx());
        test_scenario::return_shared(game);
    };

    scenario.next_tx(PLAYER2);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        rps::reveal_move<SUI>(&mut game, rock, salt_b(), scenario.ctx());
        test_scenario::return_shared(game);
    };

    // Player2 settles the game.
    scenario.next_tx(PLAYER2);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        let result = rps::settle_game<SUI>(&mut game, scenario.ctx());
        assert_eq!(rps::result_winner(&result), PLAYER2);
        assert!(!rps::result_was_tiebreaker(&result));
        test_scenario::return_shared(game);
    };

    scenario.next_tx(PLAYER2);
    {
        let prize = scenario.take_from_address<Coin<SUI>>(PLAYER2);
        assert_eq!(coin::value(&prize), 2 * STAKE);
        coin::burn_for_testing(prize);
    };
    assert!(!test_scenario::has_most_recent_for_address<Coin<SUI>>(PLAYER1));

    clock.destroy_for_testing();
    scenario.end();
}

// ============================================
// TIE PATH WITH TIEBREAK ENTROPY
// ============================================

/// Both players play Rock -> tie. Both contribute tiebreak entropy, so the
/// randomness seed resolves the tie. The winner is determined by the derived
/// seed (one of the two players), receives the WHOLE pot, and was_tiebreaker
/// must be true.
#[test]
fun tie_resolved_by_tiebreak_entropy() {
    let mut scenario = test_scenario::begin(PLAYER1);
    let clock = clock::create_for_testing(scenario.ctx());

    let rock = rps::move_rock();

    {
        let stake = coin::mint_for_testing<SUI>(STAKE, scenario.ctx());
        rps::create_game<SUI>(PLAYER2, stake, &clock, scenario.ctx());
    };

    scenario.next_tx(PLAYER2);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        let stake = coin::mint_for_testing<SUI>(STAKE, scenario.ctx());
        rps::join_game<SUI>(&mut game, stake, scenario.ctx());
        test_scenario::return_shared(game);
    };

    // Both commit Rock (a tie).
    scenario.next_tx(PLAYER1);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        rps::commit_move<SUI>(&mut game, make_commitment(rock, salt_a()), &clock, scenario.ctx());
        test_scenario::return_shared(game);
    };
    scenario.next_tx(PLAYER2);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        rps::commit_move<SUI>(&mut game, make_commitment(rock, salt_b()), &clock, scenario.ctx());
        test_scenario::return_shared(game);
    };

    // Both reveal Rock.
    scenario.next_tx(PLAYER1);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        rps::reveal_move<SUI>(&mut game, rock, salt_a(), scenario.ctx());
        test_scenario::return_shared(game);
    };
    scenario.next_tx(PLAYER2);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        rps::reveal_move<SUI>(&mut game, rock, salt_b(), scenario.ctx());
        test_scenario::return_shared(game);
    };

    // Both contribute entropy so a tiebreak seed is created.
    scenario.next_tx(PLAYER1);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        rps::contribute_tiebreak_entropy<SUI>(
            &mut game,
            b"entropy-from-player-one",
            scenario.ctx(),
        );
        test_scenario::return_shared(game);
    };
    scenario.next_tx(PLAYER2);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        rps::contribute_tiebreak_entropy<SUI>(
            &mut game,
            b"entropy-from-player-two",
            scenario.ctx(),
        );
        test_scenario::return_shared(game);
    };

    // Settle: tie is broken by randomness; winner is one of the two players.
    scenario.next_tx(PLAYER1);
    let winner = {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        let result = rps::settle_game<SUI>(&mut game, scenario.ctx());
        let w = rps::result_winner(&result);
        assert!(w == PLAYER1 || w == PLAYER2);
        assert!(rps::result_was_tiebreaker(&result));
        assert_eq!(rps::result_player1_move(&result), rock);
        assert_eq!(rps::result_player2_move(&result), rock);
        assert_eq!(rps::game_status(&game), rps::status_complete());
        test_scenario::return_shared(game);
        w
    };

    // The tiebreak winner takes the entire pot.
    scenario.next_tx(winner);
    {
        let prize = scenario.take_from_address<Coin<SUI>>(winner);
        assert_eq!(coin::value(&prize), 2 * STAKE);
        coin::burn_for_testing(prize);
    };

    clock.destroy_for_testing();
    scenario.end();
}

// ============================================
// COMMIT-TIMEOUT CANCELLATION (both deposited -> refund each)
// ============================================

/// Player2 joins (both stakes in the pot) but nobody commits. After the commit
/// timeout, the game is cancelled and EACH player is refunded EXACTLY their
/// own stake.
#[test]
fun cancel_commit_timeout_refunds_both() {
    let mut scenario = test_scenario::begin(PLAYER1);
    let mut clock = clock::create_for_testing(scenario.ctx());

    {
        let stake = coin::mint_for_testing<SUI>(STAKE, scenario.ctx());
        rps::create_game<SUI>(PLAYER2, stake, &clock, scenario.ctx());
    };

    scenario.next_tx(PLAYER2);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        let stake = coin::mint_for_testing<SUI>(STAKE, scenario.ctx());
        rps::join_game<SUI>(&mut game, stake, scenario.ctx());
        test_scenario::return_shared(game);
    };

    // Advance the clock past the 5-minute commit timeout (created_at == 0).
    clock.set_for_testing(300_001);

    scenario.next_tx(PLAYER1);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        rps::cancel_commit_timeout<SUI>(&mut game, &clock, scenario.ctx());
        assert_eq!(rps::game_status(&game), rps::status_cancelled());
        test_scenario::return_shared(game);
    };

    // Each player gets exactly their own stake back.
    scenario.next_tx(PLAYER1);
    {
        let refund1 = scenario.take_from_address<Coin<SUI>>(PLAYER1);
        assert_eq!(coin::value(&refund1), STAKE);
        coin::burn_for_testing(refund1);

        let refund2 = scenario.take_from_address<Coin<SUI>>(PLAYER2);
        assert_eq!(coin::value(&refund2), STAKE);
        coin::burn_for_testing(refund2);
    };

    clock.destroy_for_testing();
    scenario.end();
}

// ============================================
// COMMIT-TIMEOUT CANCELLATION (only creator deposited -> refund creator)
// ============================================

/// Player2 never joins; only Player1's stake is in the pot. After the commit
/// timeout, Player1 cancels and is refunded the single stake.
#[test]
fun cancel_commit_timeout_refunds_creator_only() {
    let mut scenario = test_scenario::begin(PLAYER1);
    let mut clock = clock::create_for_testing(scenario.ctx());

    {
        let stake = coin::mint_for_testing<SUI>(STAKE, scenario.ctx());
        rps::create_game<SUI>(PLAYER2, stake, &clock, scenario.ctx());
    };

    clock.set_for_testing(300_001);

    scenario.next_tx(PLAYER1);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        rps::cancel_commit_timeout<SUI>(&mut game, &clock, scenario.ctx());
        assert_eq!(rps::game_status(&game), rps::status_cancelled());
        test_scenario::return_shared(game);
    };

    scenario.next_tx(PLAYER1);
    {
        let refund = scenario.take_from_address<Coin<SUI>>(PLAYER1);
        assert_eq!(coin::value(&refund), STAKE);
        coin::burn_for_testing(refund);
    };
    // Player2 never deposited, so it must receive nothing.
    assert!(!test_scenario::has_most_recent_for_address<Coin<SUI>>(PLAYER2));

    clock.destroy_for_testing();
    scenario.end();
}

// ============================================
// REVEAL-TIMEOUT FORFEIT (revealing player claims the pot)
// ============================================

/// Both commit -> only Player1 reveals -> Player2 never reveals. After the
/// reveal timeout, Player1 claims the entire pot.
#[test]
fun claim_reveal_timeout_revealer_wins() {
    let mut scenario = test_scenario::begin(PLAYER1);
    let mut clock = clock::create_for_testing(scenario.ctx());

    let rock = rps::move_rock();
    let paper = rps::move_paper();

    {
        let stake = coin::mint_for_testing<SUI>(STAKE, scenario.ctx());
        rps::create_game<SUI>(PLAYER2, stake, &clock, scenario.ctx());
    };

    scenario.next_tx(PLAYER2);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        let stake = coin::mint_for_testing<SUI>(STAKE, scenario.ctx());
        rps::join_game<SUI>(&mut game, stake, scenario.ctx());
        test_scenario::return_shared(game);
    };

    // Both commit (commits_at recorded at the current clock time == 0).
    scenario.next_tx(PLAYER1);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        rps::commit_move<SUI>(&mut game, make_commitment(rock, salt_a()), &clock, scenario.ctx());
        test_scenario::return_shared(game);
    };
    scenario.next_tx(PLAYER2);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        rps::commit_move<SUI>(&mut game, make_commitment(paper, salt_b()), &clock, scenario.ctx());
        test_scenario::return_shared(game);
    };

    // Only Player1 reveals.
    scenario.next_tx(PLAYER1);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        rps::reveal_move<SUI>(&mut game, rock, salt_a(), scenario.ctx());
        test_scenario::return_shared(game);
    };

    // Advance past the reveal timeout (commits_at == 0, REVEAL_TIMEOUT_MS = 300000).
    clock.set_for_testing(300_001);

    scenario.next_tx(PLAYER1);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        rps::claim_reveal_timeout<SUI>(&mut game, &clock, scenario.ctx());
        assert_eq!(rps::game_status(&game), rps::status_complete());
        test_scenario::return_shared(game);
    };

    // Player1 (the only revealer) takes the whole pot.
    scenario.next_tx(PLAYER1);
    {
        let prize = scenario.take_from_address<Coin<SUI>>(PLAYER1);
        assert_eq!(coin::value(&prize), 2 * STAKE);
        coin::burn_for_testing(prize);
    };
    assert!(!test_scenario::has_most_recent_for_address<Coin<SUI>>(PLAYER2));

    clock.destroy_for_testing();
    scenario.end();
}

// ============================================
// NEGATIVE PATHS
// ============================================

/// Reveal with a salt that does not match the commitment -> commitment_mismatch (13).
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_rock_paper_scissors::ECommitmentMismatch,
        location = sui_tunnel::example_rock_paper_scissors,
    ),
]
fun reveal_commitment_mismatch_aborts() {
    let mut scenario = test_scenario::begin(PLAYER1);
    let clock = clock::create_for_testing(scenario.ctx());

    let rock = rps::move_rock();
    let scissors = rps::move_scissors();

    {
        let stake = coin::mint_for_testing<SUI>(STAKE, scenario.ctx());
        rps::create_game<SUI>(PLAYER2, stake, &clock, scenario.ctx());
    };
    scenario.next_tx(PLAYER2);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        let stake = coin::mint_for_testing<SUI>(STAKE, scenario.ctx());
        rps::join_game<SUI>(&mut game, stake, scenario.ctx());
        test_scenario::return_shared(game);
    };
    scenario.next_tx(PLAYER1);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        rps::commit_move<SUI>(&mut game, make_commitment(rock, salt_a()), &clock, scenario.ctx());
        test_scenario::return_shared(game);
    };
    scenario.next_tx(PLAYER2);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        rps::commit_move<SUI>(
            &mut game,
            make_commitment(scissors, salt_b()),
            &clock,
            scenario.ctx(),
        );
        test_scenario::return_shared(game);
    };

    // Player1 committed Rock but reveals Scissors -> hash mismatch.
    scenario.next_tx(PLAYER1);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        rps::reveal_move<SUI>(&mut game, scissors, salt_a(), scenario.ctx());
        test_scenario::return_shared(game);
    };

    clock.destroy_for_testing();
    scenario.end();
}

/// Committing twice as the same player -> already_committed (10).
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_rock_paper_scissors::EAlreadyCommitted,
        location = sui_tunnel::example_rock_paper_scissors,
    ),
]
fun double_commit_aborts() {
    let mut scenario = test_scenario::begin(PLAYER1);
    let clock = clock::create_for_testing(scenario.ctx());

    let rock = rps::move_rock();
    let paper = rps::move_paper();

    {
        let stake = coin::mint_for_testing<SUI>(STAKE, scenario.ctx());
        rps::create_game<SUI>(PLAYER2, stake, &clock, scenario.ctx());
    };
    scenario.next_tx(PLAYER2);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        let stake = coin::mint_for_testing<SUI>(STAKE, scenario.ctx());
        rps::join_game<SUI>(&mut game, stake, scenario.ctx());
        test_scenario::return_shared(game);
    };

    scenario.next_tx(PLAYER1);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        rps::commit_move<SUI>(&mut game, make_commitment(rock, salt_a()), &clock, scenario.ctx());
        // Same player commits a second time -> already_committed.
        rps::commit_move<SUI>(&mut game, make_commitment(paper, salt_a()), &clock, scenario.ctx());
        test_scenario::return_shared(game);
    };

    clock.destroy_for_testing();
    scenario.end();
}

/// An address that is neither player tries to commit -> not_authorized (0).
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_rock_paper_scissors::ENotAuthorized,
        location = sui_tunnel::example_rock_paper_scissors,
    ),
]
fun unauthorized_commit_aborts() {
    let mut scenario = test_scenario::begin(PLAYER1);
    let clock = clock::create_for_testing(scenario.ctx());

    let rock = rps::move_rock();

    {
        let stake = coin::mint_for_testing<SUI>(STAKE, scenario.ctx());
        rps::create_game<SUI>(PLAYER2, stake, &clock, scenario.ctx());
    };

    scenario.next_tx(OUTSIDER);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        rps::commit_move<SUI>(&mut game, make_commitment(rock, salt_a()), &clock, scenario.ctx());
        test_scenario::return_shared(game);
    };

    clock.destroy_for_testing();
    scenario.end();
}

/// Player2 joins with the wrong stake amount -> invalid_deposit_amount (801).
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_rock_paper_scissors::EInvalidDepositAmount,
        location = sui_tunnel::example_rock_paper_scissors,
    ),
]
fun join_wrong_stake_aborts() {
    let mut scenario = test_scenario::begin(PLAYER1);
    let clock = clock::create_for_testing(scenario.ctx());

    {
        let stake = coin::mint_for_testing<SUI>(STAKE, scenario.ctx());
        rps::create_game<SUI>(PLAYER2, stake, &clock, scenario.ctx());
    };

    scenario.next_tx(PLAYER2);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        let stake = coin::mint_for_testing<SUI>(STAKE + 1, scenario.ctx());
        rps::join_game<SUI>(&mut game, stake, scenario.ctx());
        test_scenario::return_shared(game);
    };

    clock.destroy_for_testing();
    scenario.end();
}

/// Settling before both players have revealed -> not_revealed (12).
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_rock_paper_scissors::ENotRevealed,
        location = sui_tunnel::example_rock_paper_scissors,
    ),
]
fun settle_before_reveal_aborts() {
    let mut scenario = test_scenario::begin(PLAYER1);
    let clock = clock::create_for_testing(scenario.ctx());

    let rock = rps::move_rock();
    let scissors = rps::move_scissors();

    {
        let stake = coin::mint_for_testing<SUI>(STAKE, scenario.ctx());
        rps::create_game<SUI>(PLAYER2, stake, &clock, scenario.ctx());
    };
    scenario.next_tx(PLAYER2);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        let stake = coin::mint_for_testing<SUI>(STAKE, scenario.ctx());
        rps::join_game<SUI>(&mut game, stake, scenario.ctx());
        test_scenario::return_shared(game);
    };
    scenario.next_tx(PLAYER1);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        rps::commit_move<SUI>(&mut game, make_commitment(rock, salt_a()), &clock, scenario.ctx());
        test_scenario::return_shared(game);
    };
    scenario.next_tx(PLAYER2);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        rps::commit_move<SUI>(
            &mut game,
            make_commitment(scissors, salt_b()),
            &clock,
            scenario.ctx(),
        );
        test_scenario::return_shared(game);
    };

    // Only Player1 reveals; settling now must abort with not_revealed.
    scenario.next_tx(PLAYER1);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        rps::reveal_move<SUI>(&mut game, rock, salt_a(), scenario.ctx());
        let result = rps::settle_game<SUI>(&mut game, scenario.ctx());
        destroy(result);
        test_scenario::return_shared(game);
    };

    clock.destroy_for_testing();
    scenario.end();
}

/// Cancelling on the commit timeout before the timeout is reached -> timeout_not_reached (504).
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_rock_paper_scissors::ETimeoutNotReached,
        location = sui_tunnel::example_rock_paper_scissors,
    ),
]
fun cancel_commit_timeout_too_early_aborts() {
    let mut scenario = test_scenario::begin(PLAYER1);
    let clock = clock::create_for_testing(scenario.ctx());

    {
        let stake = coin::mint_for_testing<SUI>(STAKE, scenario.ctx());
        rps::create_game<SUI>(PLAYER2, stake, &clock, scenario.ctx());
    };

    // Clock is still at created_at (0); timeout has NOT elapsed.
    scenario.next_tx(PLAYER1);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        rps::cancel_commit_timeout<SUI>(&mut game, &clock, scenario.ctx());
        test_scenario::return_shared(game);
    };

    clock.destroy_for_testing();
    scenario.end();
}

/// Tie with NO tiebreak entropy contributed -> randomness_not_available (404) on settle.
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_rock_paper_scissors::ERandomnessNotAvailable,
        location = sui_tunnel::example_rock_paper_scissors,
    ),
]
fun tie_without_entropy_aborts() {
    let mut scenario = test_scenario::begin(PLAYER1);
    let clock = clock::create_for_testing(scenario.ctx());

    let rock = rps::move_rock();

    {
        let stake = coin::mint_for_testing<SUI>(STAKE, scenario.ctx());
        rps::create_game<SUI>(PLAYER2, stake, &clock, scenario.ctx());
    };
    scenario.next_tx(PLAYER2);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        let stake = coin::mint_for_testing<SUI>(STAKE, scenario.ctx());
        rps::join_game<SUI>(&mut game, stake, scenario.ctx());
        test_scenario::return_shared(game);
    };
    scenario.next_tx(PLAYER1);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        rps::commit_move<SUI>(&mut game, make_commitment(rock, salt_a()), &clock, scenario.ctx());
        test_scenario::return_shared(game);
    };
    scenario.next_tx(PLAYER2);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        rps::commit_move<SUI>(&mut game, make_commitment(rock, salt_b()), &clock, scenario.ctx());
        test_scenario::return_shared(game);
    };
    scenario.next_tx(PLAYER1);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        rps::reveal_move<SUI>(&mut game, rock, salt_a(), scenario.ctx());
        test_scenario::return_shared(game);
    };
    scenario.next_tx(PLAYER2);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        rps::reveal_move<SUI>(&mut game, rock, salt_b(), scenario.ctx());
        test_scenario::return_shared(game);
    };

    // Tie with no tiebreak seed -> settle aborts with randomness_not_available.
    scenario.next_tx(PLAYER1);
    {
        let mut game = scenario.take_shared<rps::RPSGame<SUI>>();
        let result = rps::settle_game<SUI>(&mut game, scenario.ctx());
        destroy(result);
        test_scenario::return_shared(game);
    };

    clock.destroy_for_testing();
    scenario.end();
}
