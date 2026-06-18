/// Example: Tic-Tac-Toe (Speed Benefit)
///
/// Demonstrates how tunnels enable instant game moves by moving gameplay
/// off-chain. Players exchange signed state updates for each move —
/// moves are instantaneous instead of waiting for block finality.
///
/// **Without tunnels:** Each move = on-chain tx = ~2-3s wait per move
/// **With tunnels:**    Each move = off-chain signature exchange = instant
///
/// The board state is tracked off-chain. Only 3 on-chain transactions
/// are needed for a complete game:
///
/// 1. Create game (player A stakes)
/// 2. Join game (player B stakes)
/// 3. Settle game (winner takes pot)
///
/// ## Flow:
/// ```
/// create_game() -> join_game() -> [off-chain moves: instant!] ->
///   settle_game()  OR  raise_dispute()
/// ```
module sui_tunnel::example_tic_tac_toe;

use sui::clock::Clock;
use sui::coin::Coin;
use sui::event;
use sui::hash;
use sui_tunnel::signature;
use sui_tunnel::tunnel::{Self, Tunnel};

// === Error definitions (see sui_tunnel::errors for the canonical registry) ===

#[error]
const EInvalidState: vector<u8> = b"The operation is not allowed in the current state.";

#[error]
const EInvalidParameter: vector<u8> = b"A required parameter is missing or invalid.";

#[error]
const EInvalidSignature: vector<u8> = b"Signature verification failed.";

#[error]
const EInvalidNonce: vector<u8> = b"The nonce is invalid; it must be strictly increasing.";

#[error]
const ENoActiveDispute: vector<u8> = b"There is no active dispute to act on.";

#[error]
const EBalanceMismatch: vector<u8> = b"The balance does not match the expected amount after the operation.";

// ============================================
// CONSTANTS
// ============================================

const GAME_ACTIVE: u8 = 0;
const GAME_SETTLED: u8 = 1;
const GAME_DISPUTED: u8 = 2;
const GAME_FORCE_CLOSED: u8 = 3;

/// Board cell values
const CELL_EMPTY: u8 = 0;
const CELL_X: u8 = 1; // Player A
const CELL_O: u8 = 2; // Player B

/// Game outcomes
const OUTCOME_NONE: u8 = 0;
const OUTCOME_PLAYER_A: u8 = 1;
const OUTCOME_PLAYER_B: u8 = 2;
const OUTCOME_DRAW: u8 = 3;

const DEFAULT_TIMEOUT_MS: u64 = 600000; // 10 minutes

// ============================================
// STRUCTS
// ============================================

/// Off-chain game state — the board and move count.
public struct GameState has copy, drop, store {
    /// 9-cell board: 0=empty, 1=X (player A), 2=O (player B)
    board: vector<u8>,
    /// Number of moves played so far
    moves_count: u8,
    /// State nonce (= moves_count for this game)
    nonce: u64,
}

/// A tic-tac-toe game wrapping a Tunnel.
/// Both players stake equal amounts. Winner takes all; draw splits evenly.
public struct TicTacToeGame<phantom T> has key, store {
    id: UID,
    /// The underlying tunnel
    tunnel: Tunnel<T>,
    /// Game status
    status: u8,
    /// Latest known game state
    latest_state: GameState,
    /// Stake amount per player
    stake_amount: u64,
}

// ============================================
// EVENTS
// ============================================

public struct GameCreated has copy, drop {
    player_a: address,
    player_b: address,
    stake_amount: u64,
}

public struct GameSettled has copy, drop {
    outcome: u8,
    winner_payout: u64,
    loser_payout: u64,
}

// ============================================
// CONSTANT GETTERS
// ============================================

public fun game_active(): u8 { GAME_ACTIVE }

public fun game_settled(): u8 { GAME_SETTLED }

public fun game_disputed(): u8 { GAME_DISPUTED }

public fun game_force_closed(): u8 { GAME_FORCE_CLOSED }

public fun cell_empty(): u8 { CELL_EMPTY }

public fun cell_x(): u8 { CELL_X }

public fun cell_o(): u8 { CELL_O }

public fun outcome_none(): u8 { OUTCOME_NONE }

public fun outcome_player_a(): u8 { OUTCOME_PLAYER_A }

public fun outcome_player_b(): u8 { OUTCOME_PLAYER_B }

public fun outcome_draw(): u8 { OUTCOME_DRAW }

// ============================================
// GAME LIFECYCLE
// ============================================

/// Player A creates a game and stakes funds.
/// Player B will join with a matching stake.
public fun create_game<T>(
    player_a_address: address,
    player_a_pk: vector<u8>,
    player_b_address: address,
    player_b_pk: vector<u8>,
    stake: Coin<T>,
    clock: &Clock,
    ctx: &mut TxContext,
): TicTacToeGame<T> {
    let stake_amount = stake.value();

    let mut tun = tunnel::create<T>(
        player_a_address,
        player_a_pk,
        signature::ed25519(),
        player_b_address,
        player_b_pk,
        signature::ed25519(),
        DEFAULT_TIMEOUT_MS,
        0,
        clock,
        ctx,
    );

    tun.deposit_party_a(stake, clock, ctx);

    event::emit(GameCreated {
        player_a: player_a_address,
        player_b: player_b_address,
        stake_amount,
    });

    TicTacToeGame {
        id: object::new(ctx),
        tunnel: tun,
        status: GAME_ACTIVE,
        latest_state: GameState {
            board: vector[0, 0, 0, 0, 0, 0, 0, 0, 0],
            moves_count: 0,
            nonce: 0,
        },
        stake_amount,
    }
}

/// Player B joins the game with a matching stake.
public fun join_game<T>(
    game: &mut TicTacToeGame<T>,
    stake: Coin<T>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(game.status == GAME_ACTIVE, EInvalidState);
    assert!(stake.value() == game.stake_amount, EBalanceMismatch);
    game.tunnel.deposit_party_b(stake, clock, ctx);
}

// ============================================
// MOVE TRACKING
// ============================================

/// Compute the state hash for off-chain signing after each move.
/// Players sign this hash to agree on the board state.
///
/// **Speed benefit:** This computation + signature exchange happens
/// instantly off-chain. No waiting for block finality.
public fun compute_board_hash<T>(
    game: &TicTacToeGame<T>,
    board: &vector<u8>,
    moves_count: u8,
    nonce: u64,
): vector<u8> {
    compute_board_hash_with_id(game.tunnel.id(), board, moves_count, nonce)
}

/// Compute board hash from tunnel ID (avoids double-borrow).
public fun compute_board_hash_with_id(
    tunnel_id: ID,
    board: &vector<u8>,
    moves_count: u8,
    nonce: u64,
): vector<u8> {
    let mut data = b"tic_tac_toe::board";
    data.append(tunnel_id.to_bytes());
    data.append(*board);
    data.push_back(moves_count);
    data.append(signature::u64_to_be_bytes(nonce));
    hash::blake2b256(&data)
}

/// Record a move on-chain (optional checkpoint for safety).
/// In practice, all moves happen off-chain for instant response.
public fun record_move<T>(
    game: &mut TicTacToeGame<T>,
    board: vector<u8>,
    moves_count: u8,
    nonce: u64,
    party_a_balance: u64,
    party_b_balance: u64,
    timestamp: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    clock: &Clock,
) {
    assert!(game.status == GAME_ACTIVE, EInvalidState);
    assert!(nonce > game.latest_state.nonce, EInvalidNonce);
    assert!(board.length() == 9, EInvalidParameter);
    assert!((moves_count as u64) > (game.latest_state.moves_count as u64), EInvalidParameter);
    assert!((moves_count as u64) <= 9, EInvalidParameter);

    validate_board(&board);

    let state_hash = compute_board_hash_with_id(
        game.tunnel.id(),
        &board,
        moves_count,
        nonce,
    );

    game.latest_state = GameState { board, moves_count, nonce };

    // Both signatures must be provided together, or both empty
    assert!(
        (sig_a.is_empty() && sig_b.is_empty()) || (!sig_a.is_empty() && !sig_b.is_empty()),
        EInvalidSignature,
    );

    if (!sig_a.is_empty()) {
        game
            .tunnel
            .update_state(
                state_hash,
                nonce,
                party_a_balance,
                party_b_balance,
                timestamp,
                sig_a,
                sig_b,
                clock,
            );
    };
}

// ============================================
// GAME LOGIC
// ============================================

/// Check if a board position has a winner.
/// Returns: 0=none, 1=player A (X), 2=player B (O), 3=draw
public fun check_winner(board: &vector<u8>, moves_count: u8): u8 {
    // Check rows
    let mut i = 0u64;
    while (i < 3) {
        let base = i * 3;
        if (
            board[base] != CELL_EMPTY &&
            board[base] == board[base + 1] &&
            board[base] == board[base + 2]
        ) {
            return board[base]
        };
        i = i + 1;
    };

    // Check columns
    i = 0;
    while (i < 3) {
        if (
            board[i] != CELL_EMPTY &&
            board[i] == board[i + 3] &&
            board[i] == board[i + 6]
        ) {
            return board[i]
        };
        i = i + 1;
    };

    // Check diagonals
    if (board[0] != CELL_EMPTY && board[0] == board[4] && board[0] == board[8]) {
        return board[0]
    };
    if (board[2] != CELL_EMPTY && board[2] == board[4] && board[2] == board[6]) {
        return board[2]
    };

    // Check draw (all cells filled)
    if ((moves_count as u64) == 9) {
        return OUTCOME_DRAW
    };

    OUTCOME_NONE
}

/// Calculate payouts based on game outcome.
/// Winner takes all; draw splits evenly.
public fun calculate_payouts(total_pot: u64, outcome: u8): (u64, u64) {
    if (outcome == OUTCOME_PLAYER_A) {
        (total_pot, 0)
    } else if (outcome == OUTCOME_PLAYER_B) {
        (0, total_pot)
    } else {
        // Draw: split evenly (remainder to player A)
        let half = total_pot / 2;
        (total_pot - half, half)
    }
}

/// Validate that all board cells contain valid values.
fun validate_board(board: &vector<u8>) {
    9u64.do!(|i| {
        let cell = board[i];
        assert!(cell == CELL_EMPTY || cell == CELL_X || cell == CELL_O, EInvalidParameter);
    });
}

// ============================================
// SETTLEMENT
// ============================================

/// Settle the game cooperatively. Both players agree on the outcome
/// and sign the final balance split.
///
/// **Speed benefit:** The entire game was played instantly off-chain.
/// This is the third and final on-chain transaction.
public fun settle_game<T>(
    game: &mut TicTacToeGame<T>,
    player_a_balance: u64,
    player_b_balance: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    timestamp: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(game.status == GAME_ACTIVE, EInvalidState);

    game
        .tunnel
        .close_cooperative_and_transfer(
            player_a_balance,
            player_b_balance,
            sig_a,
            sig_b,
            timestamp,
            clock,
            ctx,
        );

    game.status = GAME_SETTLED;

    let outcome = check_winner(&game.latest_state.board, game.latest_state.moves_count);
    event::emit(GameSettled {
        outcome,
        winner_payout: if (player_a_balance > player_b_balance) { player_a_balance } else {
            player_b_balance
        },
        loser_payout: if (player_a_balance > player_b_balance) { player_b_balance } else {
            player_a_balance
        },
    });
}

/// Raise a dispute if a player suspects cheating.
public fun raise_dispute<T>(
    game: &mut TicTacToeGame<T>,
    state_hash: vector<u8>,
    nonce: u64,
    party_a_balance: u64,
    party_b_balance: u64,
    timestamp: u64,
    other_party_sig: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(game.status == GAME_ACTIVE, EInvalidState);
    game
        .tunnel
        .raise_dispute(
            state_hash,
            nonce,
            party_a_balance,
            party_b_balance,
            timestamp,
            other_party_sig,
            clock,
            ctx,
        );
    game.status = GAME_DISPUTED;
}

/// Force close after dispute timeout.
public fun force_close<T>(game: &mut TicTacToeGame<T>, clock: &Clock, ctx: &mut TxContext) {
    assert!(game.status == GAME_DISPUTED, ENoActiveDispute);
    game
        .tunnel
        .force_close_after_timeout(
            clock,
            ctx,
        );
    game.status = GAME_FORCE_CLOSED;
}

// ============================================
// ACCESSORS
// ============================================

public fun game_status<T>(g: &TicTacToeGame<T>): u8 { g.status }

public fun game_board<T>(g: &TicTacToeGame<T>): &vector<u8> { &g.latest_state.board }

public fun game_moves_count<T>(g: &TicTacToeGame<T>): u8 { g.latest_state.moves_count }

public fun game_nonce<T>(g: &TicTacToeGame<T>): u64 { g.latest_state.nonce }

public fun game_stake_amount<T>(g: &TicTacToeGame<T>): u64 { g.stake_amount }

public fun game_tunnel<T>(g: &TicTacToeGame<T>): &Tunnel<T> { &g.tunnel }

public fun game_total_pot<T>(g: &TicTacToeGame<T>): u64 {
    g.tunnel.total_balance()
}

public fun game_latest_state<T>(g: &TicTacToeGame<T>): &GameState { &g.latest_state }

public fun state_board(s: &GameState): &vector<u8> { &s.board }

public fun state_moves_count(s: &GameState): u8 { s.moves_count }

public fun state_nonce(s: &GameState): u64 { s.nonce }

// ============================================
// TEST HELPERS
// ============================================

#[test_only]
public fun destroy_game_for_testing<T>(game: TicTacToeGame<T>) {
    let TicTacToeGame { id, tunnel, .. } = game;
    id.delete();
    tunnel.destroy_for_testing();
}

#[test_only]
public fun set_status_for_testing<T>(game: &mut TicTacToeGame<T>, status: u8) {
    game.status = status;
}

#[test_only]
public fun create_game_state_for_testing(
    board: vector<u8>,
    moves_count: u8,
    nonce: u64,
): GameState {
    GameState { board, moves_count, nonce }
}
