/// Example: Rock Paper Scissors
///
/// A fair two-player game using commit-reveal for moves.
/// Demonstrates randomness for tie-breaking.
///
/// ## Flow:
/// 1. Both players commit to their moves (hash of move + salt)
/// 2. Both players reveal their moves
/// 3. Winner is determined, ties broken by randomness
/// 4. Stakes are distributed
///
/// ## Key Features:
/// - Commit-reveal prevents cheating
/// - Randomness-based tie-breaking
/// - Timeout protection
module sui_tunnel::example_rock_paper_scissors;

use sui::balance::Balance;
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;
use sui::hash;
use sui_tunnel::randomness;

// === Error definitions (see sui_tunnel::errors for the canonical registry) ===

#[error]
const ENotAuthorized: vector<u8> = b"The caller is not authorized to perform this action.";

#[error]
const EInvalidState: vector<u8> = b"The operation is not allowed in the current state.";

#[error]
const EAlreadyCommitted: vector<u8> = b"A value has already been committed and cannot be committed again.";

#[error]
const EAlreadyRevealed: vector<u8> = b"The value has already been revealed and cannot be revealed again.";

#[error]
const ENotRevealed: vector<u8> = b"The value has not been revealed yet.";

#[error]
const ECommitmentMismatch: vector<u8> = b"The revealed value does not match the original commitment.";

#[error]
const EInvalidCommitment: vector<u8> = b"The commitment is invalid or has the wrong format.";

#[error]
const EInvalidParties: vector<u8> = b"The tunnel parties are invalid (for example, both parties share the same address).";

#[error]
const ETimeoutNotReached: vector<u8> = b"The timeout has not been reached yet.";

#[error]
const EInvalidDepositAmount: vector<u8> = b"The deposit amount is invalid.";

#[error]
const ENotJoined: vector<u8> = b"A required participant has not joined yet.";

#[error]
const EInvalidMove: vector<u8> = b"The submitted move is invalid or out of range.";

#[error]
const EPotMismatch: vector<u8> = b"The staked pot does not equal the expected total.";

// ============================================
// CONSTANTS
// ============================================

/// Move: Rock
const MOVE_ROCK: u8 = 0;

/// Move: Paper
const MOVE_PAPER: u8 = 1;

/// Move: Scissors
const MOVE_SCISSORS: u8 = 2;

/// Game status: Waiting for commits
const STATUS_WAITING_COMMITS: u8 = 0;

/// Game status: Waiting for reveals
const STATUS_WAITING_REVEALS: u8 = 1;

/// Game status: Complete
const STATUS_COMPLETE: u8 = 2;

/// Game status: Cancelled
const STATUS_CANCELLED: u8 = 3;

/// Commit timeout: 5 minutes
const COMMIT_TIMEOUT_MS: u64 = 300000;

/// Reveal timeout: 5 minutes
const REVEAL_TIMEOUT_MS: u64 = 300000;

// ============================================
// STRUCTS
// ============================================

/// A Rock Paper Scissors game between two players
public struct RPSGame<phantom T> has key, store {
    id: UID,
    /// Player 1 address
    player1: address,
    /// Player 2 address
    player2: address,
    /// Stake per player
    stake_amount: u64,
    /// Combined stakes
    pot: Balance<T>,
    /// Player 2 has staked via `join_game`
    player2_joined: bool,
    /// Player 1's commit (hash of move + salt)
    player1_commit: vector<u8>,
    /// Player 2's commit
    player2_commit: vector<u8>,
    /// Player 1's revealed move
    player1_move: u8,
    /// Player 2's revealed move
    player2_move: u8,
    /// Player 1 revealed?
    player1_revealed: bool,
    /// Player 2 revealed?
    player2_revealed: bool,
    /// Game status
    status: u8,
    /// Creation timestamp
    created_at: u64,
    /// Commits complete timestamp
    commits_at: u64,
    /// Player 1's revealed salt, used as commitment-bound tie-break entropy
    player1_salt: vector<u8>,
    /// Player 2's revealed salt, used as commitment-bound tie-break entropy
    player2_salt: vector<u8>,
}

/// Result of the game
public struct GameResult has copy, drop, store {
    /// Winner address (or @0x0 for tie refund)
    winner: address,
    /// Player 1's move
    player1_move: u8,
    /// Player 2's move
    player2_move: u8,
    /// Was tie broken by randomness?
    was_tiebreaker: bool,
}

// ============================================
// EVENTS
// ============================================

/// Emitted when a game is created
public struct RPSGameCreated has copy, drop {
    player1: address,
    player2: address,
    stake_amount: u64,
    created_at: u64,
}

/// Emitted when a player commits
public struct RPSCommitSubmitted has copy, drop {
    player: address,
}

/// Emitted when a player reveals
public struct RPSRevealSubmitted has copy, drop {
    player: address,
    move_choice: u8,
}

/// Emitted when game is settled
public struct RPSGameSettled has copy, drop {
    winner: address,
    player1_move: u8,
    player2_move: u8,
    was_tiebreaker: bool,
}

/// Emitted when a game is cancelled
public struct RPSGameCancelled has copy, drop {
    player1: address,
    player2: address,
}

// ============================================
// PUBLIC GETTER FUNCTIONS
// ============================================

public fun move_rock(): u8 { MOVE_ROCK }

public fun move_paper(): u8 { MOVE_PAPER }

public fun move_scissors(): u8 { MOVE_SCISSORS }

public fun status_waiting_commits(): u8 { STATUS_WAITING_COMMITS }

public fun status_waiting_reveals(): u8 { STATUS_WAITING_REVEALS }

public fun status_complete(): u8 { STATUS_COMPLETE }

public fun status_cancelled(): u8 { STATUS_CANCELLED }

// ============================================
// GAME LIFECYCLE
// ============================================

/// Create a new game and share it so both players can interact with it.
public fun create_game<T>(player2: address, stake: Coin<T>, clock: &Clock, ctx: &mut TxContext) {
    let player1 = ctx.sender();
    assert!(player1 != player2, EInvalidParties);

    let stake_amount = stake.value();
    assert!(stake_amount > 0, EInvalidDepositAmount);

    let now = clock.timestamp_ms();

    let game = RPSGame {
        id: object::new(ctx),
        player1,
        player2,
        stake_amount,
        pot: stake.into_balance(),
        player2_joined: false,
        player1_commit: vector[],
        player2_commit: vector[],
        player1_move: 255, // Invalid placeholder
        player2_move: 255,
        player1_revealed: false,
        player2_revealed: false,
        status: STATUS_WAITING_COMMITS,
        created_at: now,
        commits_at: 0,
        player1_salt: vector[],
        player2_salt: vector[],
    };

    event::emit(RPSGameCreated { player1, player2, stake_amount, created_at: now });

    transfer::share_object(game)
}

/// Player 2 joins and deposits stake
public fun join_game<T>(game: &mut RPSGame<T>, stake: Coin<T>, ctx: &TxContext) {
    assert!(ctx.sender() == game.player2, ENotAuthorized);
    assert!(game.status == STATUS_WAITING_COMMITS, EInvalidState);
    assert!(stake.value() == game.stake_amount, EInvalidDepositAmount);

    game.pot.join(stake.into_balance());
    game.player2_joined = true;
}

/// Player commits their move (hash of move byte + salt bytes)
public fun commit_move<T>(
    game: &mut RPSGame<T>,
    commitment: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    let sender = ctx.sender();
    assert!(game.status == STATUS_WAITING_COMMITS, EInvalidState);
    assert!(commitment.length() == 32, EInvalidCommitment);

    if (sender == game.player1) {
        assert!(game.player1_commit.is_empty(), EAlreadyCommitted);
        game.player1_commit = commitment;
    } else if (sender == game.player2) {
        assert!(game.player2_joined, ENotJoined);
        assert!(game.player2_commit.is_empty(), EAlreadyCommitted);
        game.player2_commit = commitment;
    } else {
        abort ENotAuthorized
    };

    // If both committed, move to reveal phase
    if (!game.player1_commit.is_empty() && !game.player2_commit.is_empty()) {
        let now = clock.timestamp_ms();
        game.status = STATUS_WAITING_REVEALS;
        game.commits_at = now;
    };

    event::emit(RPSCommitSubmitted { player: sender });
}

/// Player reveals their move
public fun reveal_move<T>(
    game: &mut RPSGame<T>,
    move_choice: u8,
    salt: vector<u8>,
    ctx: &TxContext,
) {
    let sender = ctx.sender();
    assert!(game.status == STATUS_WAITING_REVEALS, EInvalidState);
    assert!(move_choice <= MOVE_SCISSORS, EInvalidMove);

    let computed_hash = move_commitment(move_choice, &salt);

    if (sender == game.player1) {
        assert!(!game.player1_revealed, EAlreadyRevealed);
        assert!(computed_hash == game.player1_commit, ECommitmentMismatch);
        game.player1_move = move_choice;
        game.player1_salt = salt;
        game.player1_revealed = true;
    } else if (sender == game.player2) {
        assert!(!game.player2_revealed, EAlreadyRevealed);
        assert!(computed_hash == game.player2_commit, ECommitmentMismatch);
        game.player2_move = move_choice;
        game.player2_salt = salt;
        game.player2_revealed = true;
    } else {
        abort ENotAuthorized
    };

    event::emit(RPSRevealSubmitted { player: sender, move_choice });
}

/// Determine winner and distribute stakes.
/// Only a player can settle. Funds are transferred directly to the winner.
public fun settle_game<T>(game: &mut RPSGame<T>, ctx: &mut TxContext): GameResult {
    let sender = ctx.sender();
    assert!(sender == game.player1 || sender == game.player2, ENotAuthorized);
    assert!(game.status == STATUS_WAITING_REVEALS, EInvalidState);
    assert!(game.player1_revealed && game.player2_revealed, ENotRevealed);
    // No player can win the pot unless both stakes are present.
    assert!(game.pot.value() == 2 * game.stake_amount, EPotMismatch);

    let (winner, was_tiebreaker) = determine_winner(game);

    game.status = STATUS_COMPLETE;

    let pot_value = game.pot.value();
    let prize = coin::from_balance(game.pot.split(pot_value), ctx);
    transfer::public_transfer(prize, winner);

    let result = GameResult {
        winner,
        player1_move: game.player1_move,
        player2_move: game.player2_move,
        was_tiebreaker,
    };

    event::emit(RPSGameSettled {
        winner,
        player1_move: game.player1_move,
        player2_move: game.player2_move,
        was_tiebreaker,
    });

    result
}

/// Cancel game if opponent doesn't commit in time.
/// Refunds each player their stake proportionally to prevent theft.
public fun cancel_commit_timeout<T>(game: &mut RPSGame<T>, clock: &Clock, ctx: &mut TxContext) {
    let sender = ctx.sender();
    assert!(sender == game.player1 || sender == game.player2, ENotAuthorized);
    assert!(game.status == STATUS_WAITING_COMMITS, EInvalidState);

    let now = clock.timestamp_ms();
    assert!(now > game.created_at + COMMIT_TIMEOUT_MS, ETimeoutNotReached);

    game.status = STATUS_CANCELLED;

    event::emit(RPSGameCancelled { player1: game.player1, player2: game.player2 });

    let pot_value = game.pot.value();
    if (pot_value > game.stake_amount) {
        // Both players deposited — refund each their stake
        let coin_p1 = coin::from_balance(game.pot.split(game.stake_amount), ctx);
        transfer::public_transfer(coin_p1, game.player1);
        let remaining = game.pot.value();
        let coin_p2 = coin::from_balance(game.pot.split(remaining), ctx);
        transfer::public_transfer(coin_p2, game.player2);
    } else {
        // Only player 1 deposited — refund to player 1
        let coin_p1 = coin::from_balance(game.pot.split(pot_value), ctx);
        transfer::public_transfer(coin_p1, game.player1);
    };
}

/// Claim win if opponent doesn't reveal in time.
/// Funds are transferred directly to the claimer to prevent PTB interception.
#[allow(lint(self_transfer))]
public fun claim_reveal_timeout<T>(game: &mut RPSGame<T>, clock: &Clock, ctx: &mut TxContext) {
    let sender = ctx.sender();
    assert!(game.status == STATUS_WAITING_REVEALS, EInvalidState);

    let now = clock.timestamp_ms();
    assert!(now > game.commits_at + REVEAL_TIMEOUT_MS, ETimeoutNotReached);

    // The player who revealed wins
    if (sender == game.player1 && game.player1_revealed && !game.player2_revealed) {
        game.status = STATUS_COMPLETE;
        event::emit(RPSGameCancelled { player1: game.player1, player2: game.player2 });
        let pot_value = game.pot.value();
        let coins = coin::from_balance(game.pot.split(pot_value), ctx);
        transfer::public_transfer(coins, sender);
    } else if (sender == game.player2 && game.player2_revealed && !game.player1_revealed) {
        game.status = STATUS_COMPLETE;
        event::emit(RPSGameCancelled { player1: game.player1, player2: game.player2 });
        let pot_value = game.pot.value();
        let coins = coin::from_balance(game.pot.split(pot_value), ctx);
        transfer::public_transfer(coins, sender);
    } else {
        abort ENotAuthorized
    };
}

// ============================================
// INTERNAL HELPERS
// ============================================

/// Recompute a move commitment `blake2b256(move_byte || salt)` without consuming `salt`.
fun move_commitment(move_choice: u8, salt: &vector<u8>): vector<u8> {
    let mut data = vector[move_choice];
    salt.do_ref!(|b| data.push_back(*b));
    hash::blake2b256(&data)
}

/// Derive the tie-break seed from both players' revealed salts.
///
/// Each salt is bound by that player's move commitment, which is fixed during the
/// commit phase before any salt is revealed. Neither player can therefore choose a salt
/// after observing the other's, so the seed (and thus the tie-break parity) is not
/// grindable by the last revealer. `combine_reveals` length-prefixes both fields.
fun tiebreak_seed<T>(game: &RPSGame<T>): randomness::Seed {
    let reveal_1 = randomness::create_reveal(
        vector[game.player1_move],
        clone_bytes(&game.player1_salt),
    );
    let reveal_2 = randomness::create_reveal(
        vector[game.player2_move],
        clone_bytes(&game.player2_salt),
    );
    randomness::combine_reveals(&reveal_1, &reveal_2)
}

/// Copy a byte vector behind a reference (Move vectors are not `copy`).
fun clone_bytes(bytes: &vector<u8>): vector<u8> {
    let mut out = vector[];
    bytes.do_ref!(|b| out.push_back(*b));
    out
}

/// Determine the winner based on moves. Ties are broken by `tiebreak_seed`.
fun determine_winner<T>(game: &RPSGame<T>): (address, bool) {
    let p1 = game.player1_move;
    let p2 = game.player2_move;

    if (p1 == p2) {
        let seed = tiebreak_seed(game);
        let random_byte = randomness::seed_bytes(&seed)[0];
        if (random_byte % 2 == 0) {
            (game.player1, true)
        } else {
            (game.player2, true)
        }
    } else if (beats(p1, p2)) {
        (game.player1, false)
    } else {
        (game.player2, false)
    }
}

/// Check if move1 beats move2
fun beats(move1: u8, move2: u8): bool {
    (move1 == MOVE_ROCK && move2 == MOVE_SCISSORS) ||
    (move1 == MOVE_PAPER && move2 == MOVE_ROCK) ||
    (move1 == MOVE_SCISSORS && move2 == MOVE_PAPER)
}

// ============================================
// ACCESSORS
// ============================================

public fun game_player1<T>(game: &RPSGame<T>): address { game.player1 }

public fun game_player2<T>(game: &RPSGame<T>): address { game.player2 }

public fun game_stake_amount<T>(game: &RPSGame<T>): u64 { game.stake_amount }

public fun game_status<T>(game: &RPSGame<T>): u8 { game.status }

public fun game_player1_revealed<T>(game: &RPSGame<T>): bool { game.player1_revealed }

public fun game_player2_revealed<T>(game: &RPSGame<T>): bool { game.player2_revealed }

public fun result_winner(result: &GameResult): address { result.winner }

public fun result_player1_move(result: &GameResult): u8 { result.player1_move }

public fun result_player2_move(result: &GameResult): u8 { result.player2_move }

public fun result_was_tiebreaker(result: &GameResult): bool { result.was_tiebreaker }

#[test_only]
public fun beats_for_testing(move1: u8, move2: u8): bool { beats(move1, move2) }
