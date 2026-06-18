/// Example: Coin Flip Game
///
/// A fair coin flip game using commit-reveal randomness.
/// Demonstrates the randomness module for provably fair games.
///
/// ## Flow:
/// 1. Both players commit to random values
/// 2. Both players reveal their values
/// 3. Combined randomness determines winner
/// 4. Loser pays winner
///
/// ## Key Features:
/// - Provably fair (neither party can cheat)
/// - Uses commit-reveal for joint randomness
/// - Atomic settlement
module sui_tunnel::example_coin_flip;

use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;
use sui_tunnel::randomness;

// === Error definitions (see sui_tunnel::errors for the canonical registry) ===

#[error]
const ENotAuthorized: vector<u8> = b"The caller is not authorized to perform this action.";

#[error]
const EInvalidState: vector<u8> = b"The operation is not allowed in the current state.";

#[error]
const EInvalidParameter: vector<u8> = b"A required parameter is missing or invalid.";

#[error]
const EAlreadyExists: vector<u8> = b"The resource already exists and cannot be created again.";

#[error]
const ENotFound: vector<u8> = b"The requested resource was not found.";

#[error]
const EInvalidParties: vector<u8> = b"The tunnel parties are invalid (for example, both parties share the same address).";

#[error]
const ERandomnessCommitmentMismatch: vector<u8> = b"The revealed randomness does not match its commitment.";

#[error]
const ETimeoutNotReached: vector<u8> = b"The timeout has not been reached yet.";

#[error]
const EInvalidDepositAmount: vector<u8> = b"The deposit amount is invalid.";

// ============================================
// CONSTANTS
// ============================================

/// Game status: Waiting for commits
const STATUS_AWAITING_COMMITS: u8 = 0;

/// Game status: Waiting for reveals
const STATUS_AWAITING_REVEALS: u8 = 1;

/// Game status: Completed
const STATUS_COMPLETED: u8 = 2;

/// Game status: Cancelled
const STATUS_CANCELLED: u8 = 3;

/// Choice: Heads (0)
const CHOICE_HEADS: u8 = 0;

/// Choice: Tails (1)
const CHOICE_TAILS: u8 = 1;

/// Timeout: 10 minutes for commits/reveals
const TIMEOUT_MS: u64 = 600000;

// ============================================
// STRUCTS
// ============================================

/// A coin flip game between two players
public struct CoinFlipGame<phantom T> has key, store {
    id: UID,
    /// Player 1 (game creator, chooses heads or tails)
    player_1: address,
    /// Player 2 (challenger)
    player_2: address,
    /// Player 1's choice (heads=0, tails=1)
    player_1_choice: u8,
    /// Bet amount (each player stakes this)
    bet_amount: u64,
    /// Player 1's stake
    stake_1: Balance<T>,
    /// Player 2's stake (once joined)
    stake_2: Balance<T>,
    /// Player 1's commitment hash
    commitment_1: vector<u8>,
    /// Player 2's commitment hash
    commitment_2: vector<u8>,
    /// Player 1's reveal
    reveal_1: Option<randomness::Reveal>,
    /// Player 2's reveal
    reveal_2: Option<randomness::Reveal>,
    /// Current game status
    status: u8,
    /// Game creation timestamp
    created_at: u64,
    /// Winner address (once determined)
    winner: Option<address>,
    /// The flip result (0=heads, 1=tails)
    result: Option<u8>,
}

// ============================================
// EVENTS
// ============================================

/// Emitted when a game is created
public struct GameCreated has copy, drop {
    player_1: address,
    player_2: address,
    bet_amount: u64,
    created_at: u64,
}

/// Emitted when player 2 joins
public struct GameJoined has copy, drop {
    player_1: address,
    player_2: address,
    bet_amount: u64,
}

/// Emitted when a player reveals
public struct RevealSubmitted has copy, drop {
    player: address,
}

/// Emitted when game is settled
public struct GameSettled has copy, drop {
    winner: address,
    result: u8,
    bet_amount: u64,
}

/// Emitted when a game is cancelled
public struct GameCancelled has copy, drop {
    player1: address,
    player2: address,
}

// ============================================
// PUBLIC GETTER FUNCTIONS
// ============================================

public fun status_awaiting_commits(): u8 { STATUS_AWAITING_COMMITS }

public fun status_awaiting_reveals(): u8 { STATUS_AWAITING_REVEALS }

public fun status_completed(): u8 { STATUS_COMPLETED }

public fun status_cancelled(): u8 { STATUS_CANCELLED }

public fun choice_heads(): u8 { CHOICE_HEADS }

public fun choice_tails(): u8 { CHOICE_TAILS }

public fun timeout_ms(): u64 { TIMEOUT_MS }

// ============================================
// GAME LIFECYCLE
// ============================================

/// Creates a new coin flip game and shares it so both players can interact with it.
/// Player 1 commits their random value and chooses heads or tails.
public fun create_game<T>(
    player_2: address,
    choice: u8,
    commitment: vector<u8>,
    stake: Coin<T>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let player_1 = ctx.sender();
    assert!(player_1 != player_2, EInvalidParties);
    assert!(choice == CHOICE_HEADS || choice == CHOICE_TAILS, EInvalidParameter);
    assert!(commitment.length() == 32, EInvalidParameter);

    let bet_amount = stake.value();
    assert!(bet_amount > 0, EInvalidDepositAmount);

    let now = clock.timestamp_ms();

    let game = CoinFlipGame {
        id: object::new(ctx),
        player_1,
        player_2,
        player_1_choice: choice,
        bet_amount,
        stake_1: stake.into_balance(),
        stake_2: balance::zero(),
        commitment_1: commitment,
        commitment_2: vector[],
        reveal_1: option::none(),
        reveal_2: option::none(),
        status: STATUS_AWAITING_COMMITS,
        created_at: now,
        winner: option::none(),
        result: option::none(),
    };

    event::emit(GameCreated { player_1, player_2, bet_amount, created_at: now });

    transfer::share_object(game)
}

/// Player 2 joins the game with their commitment and stake
public fun join_game<T>(
    game: &mut CoinFlipGame<T>,
    commitment: vector<u8>,
    stake: Coin<T>,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == game.player_2, ENotAuthorized);
    assert!(game.status == STATUS_AWAITING_COMMITS, EInvalidState);
    assert!(game.stake_2.value() == 0, EAlreadyExists);
    assert!(commitment.length() == 32, EInvalidParameter);

    let stake_amount = stake.value();
    assert!(stake_amount == game.bet_amount, EInvalidDepositAmount);

    game.commitment_2 = commitment;
    game.stake_2.join(stake.into_balance());
    game.status = STATUS_AWAITING_REVEALS;

    event::emit(GameJoined {
        player_1: game.player_1,
        player_2: game.player_2,
        bet_amount: game.bet_amount,
    });
}

/// Player 1 reveals their random value
public fun reveal_player_1<T>(
    game: &mut CoinFlipGame<T>,
    value: vector<u8>,
    salt: vector<u8>,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == game.player_1, ENotAuthorized);
    assert!(game.status == STATUS_AWAITING_REVEALS, EInvalidState);
    assert!(game.reveal_1.is_none(), EAlreadyExists);

    // Verify commitment
    let commitment = randomness::create_commitment(&value, &salt, game.player_1, 0);
    let computed_hash = commitment.commitment_hash();
    assert!(*computed_hash == game.commitment_1, ERandomnessCommitmentMismatch);

    let reveal = randomness::create_reveal(value, salt);
    game.reveal_1.fill(reveal);

    event::emit(RevealSubmitted { player: game.player_1 });

    // If both revealed, determine winner
    if (game.reveal_2.is_some()) {
        game.determine_winner();
    };
}

/// Player 2 reveals their random value
public fun reveal_player_2<T>(
    game: &mut CoinFlipGame<T>,
    value: vector<u8>,
    salt: vector<u8>,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == game.player_2, ENotAuthorized);
    assert!(game.status == STATUS_AWAITING_REVEALS, EInvalidState);
    assert!(game.reveal_2.is_none(), EAlreadyExists);

    // Verify commitment
    let commitment = randomness::create_commitment(&value, &salt, game.player_2, 0);
    let computed_hash = commitment.commitment_hash();
    assert!(*computed_hash == game.commitment_2, ERandomnessCommitmentMismatch);

    let reveal = randomness::create_reveal(value, salt);
    game.reveal_2.fill(reveal);

    event::emit(RevealSubmitted { player: game.player_2 });

    // If both revealed, determine winner
    if (game.reveal_1.is_some()) {
        game.determine_winner();
    };
}

/// Internal: Determines the winner based on combined randomness
fun determine_winner<T>(game: &mut CoinFlipGame<T>) {
    // Combine both reveals to get fair randomness
    let reveal_1 = game.reveal_1.borrow();
    let reveal_2 = game.reveal_2.borrow();
    let seed = reveal_1.combine_reveals(reveal_2);

    // Get a random bit (0 or 1) for heads/tails
    let (flip_result, _) = seed.next_u8_in_range(0, 2);

    game.result.fill(flip_result);

    // Determine winner based on player 1's choice
    let winner = if (flip_result == game.player_1_choice) {
        game.player_1
    } else {
        game.player_2
    };

    game.winner.fill(winner);
    game.status = STATUS_COMPLETED;

    event::emit(GameSettled { winner, result: flip_result, bet_amount: game.bet_amount });
}

/// Claim winnings after game is completed.
/// Funds are transferred directly to the winner to prevent PTB interception.
public fun claim_winnings<T>(game: &mut CoinFlipGame<T>, ctx: &mut TxContext) {
    assert!(game.status == STATUS_COMPLETED, EInvalidState);
    assert!(game.winner.is_some(), ENotFound);

    let winner = *game.winner.borrow();
    assert!(ctx.sender() == winner, ENotAuthorized);

    // Combine both stakes
    let stake_1_amount = game.stake_1.value();
    let stake_2_amount = game.stake_2.value();

    let mut total = game.stake_1.split(stake_1_amount);
    total.join(game.stake_2.split(stake_2_amount));

    let coins = coin::from_balance(total, ctx);
    transfer::public_transfer(coins, winner);
}

/// Cancel game if player 2 never joined (after timeout).
/// Only player 1 can cancel. Funds transferred directly to prevent PTB interception.
public fun cancel_timeout<T>(game: &mut CoinFlipGame<T>, clock: &Clock, ctx: &mut TxContext) {
    assert!(ctx.sender() == game.player_1, ENotAuthorized);
    let now = clock.timestamp_ms();

    assert!(game.status == STATUS_AWAITING_COMMITS, EInvalidState);
    assert!(now > game.created_at + TIMEOUT_MS, ETimeoutNotReached);

    game.status = STATUS_CANCELLED;

    event::emit(GameCancelled { player1: game.player_1, player2: game.player_2 });

    // Return stake to player 1
    let stake_amount = game.stake_1.value();
    let coins = coin::from_balance(game.stake_1.split(stake_amount), ctx);
    transfer::public_transfer(coins, game.player_1);
}

/// Claim if opponent didn't reveal (after timeout).
/// Funds are transferred directly to the claimer to prevent PTB interception.
#[allow(lint(self_transfer))]
public fun claim_no_reveal<T>(game: &mut CoinFlipGame<T>, clock: &Clock, ctx: &mut TxContext) {
    let now = clock.timestamp_ms();

    assert!(game.status == STATUS_AWAITING_REVEALS, EInvalidState);
    assert!(now > game.created_at + TIMEOUT_MS, ETimeoutNotReached);

    let sender = ctx.sender();
    let claimer_revealed: bool;
    let opponent_revealed: bool;

    if (sender == game.player_1) {
        claimer_revealed = game.reveal_1.is_some();
        opponent_revealed = game.reveal_2.is_some();
    } else if (sender == game.player_2) {
        claimer_revealed = game.reveal_2.is_some();
        opponent_revealed = game.reveal_1.is_some();
    } else {
        abort ENotAuthorized
    };

    // Claimer must have revealed, opponent must not have
    assert!(claimer_revealed && !opponent_revealed, EInvalidState);

    game.status = STATUS_COMPLETED;
    game.winner.fill(sender);

    event::emit(GameCancelled { player1: game.player_1, player2: game.player_2 });

    // Combine stakes
    let stake_1_amount = game.stake_1.value();
    let stake_2_amount = game.stake_2.value();

    let mut total = game.stake_1.split(stake_1_amount);
    total.join(game.stake_2.split(stake_2_amount));

    let coins = coin::from_balance(total, ctx);
    transfer::public_transfer(coins, sender);
}

// ============================================
// ACCESSORS
// ============================================

public fun game_player_1<T>(game: &CoinFlipGame<T>): address { game.player_1 }

public fun game_player_2<T>(game: &CoinFlipGame<T>): address { game.player_2 }

public fun game_bet_amount<T>(game: &CoinFlipGame<T>): u64 { game.bet_amount }

public fun game_status<T>(game: &CoinFlipGame<T>): u8 { game.status }

public fun game_winner<T>(game: &CoinFlipGame<T>): &Option<address> { &game.winner }

public fun game_result<T>(game: &CoinFlipGame<T>): &Option<u8> { &game.result }

public fun game_player_1_choice<T>(game: &CoinFlipGame<T>): u8 { game.player_1_choice }

/// Returns "heads" or "tails" as a string based on result
public fun result_to_string(result: u8): vector<u8> {
    if (result == CHOICE_HEADS) {
        b"heads"
    } else {
        b"tails"
    }
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/// Creates a commitment hash for a player
public fun create_player_commitment(
    value: &vector<u8>,
    salt: &vector<u8>,
    player: address,
): vector<u8> {
    let commitment = randomness::create_commitment(value, salt, player, 0);
    *commitment.commitment_hash()
}

// ============================================
// TEST HELPERS
// ============================================

#[test_only]
/// Creates a game without sharing it (for unit tests that need a mutable reference).
public fun create_game_for_testing<T>(
    player_2: address,
    choice: u8,
    commitment: vector<u8>,
    stake: Coin<T>,
    clock: &Clock,
    ctx: &mut TxContext,
): CoinFlipGame<T> {
    let player_1 = ctx.sender();
    assert!(player_1 != player_2, EInvalidParties);
    assert!(choice == CHOICE_HEADS || choice == CHOICE_TAILS, EInvalidParameter);
    assert!(commitment.length() == 32, EInvalidParameter);

    let bet_amount = stake.value();
    assert!(bet_amount > 0, EInvalidDepositAmount);

    let now = clock.timestamp_ms();

    CoinFlipGame {
        id: object::new(ctx),
        player_1,
        player_2,
        player_1_choice: choice,
        bet_amount,
        stake_1: stake.into_balance(),
        stake_2: balance::zero(),
        commitment_1: commitment,
        commitment_2: vector[],
        reveal_1: option::none(),
        reveal_2: option::none(),
        status: STATUS_AWAITING_COMMITS,
        created_at: now,
        winner: option::none(),
        result: option::none(),
    }
}
