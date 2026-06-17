/// Example: Multi-Game Tic-Tac-Toe (Session Channel)
///
/// Demonstrates playing MANY games inside a SINGLE tunnel, maintaining an
/// ongoing balance between the two parties across games, and settling +
/// closing the tunnel exactly ONCE at the end.
///
/// This is the multi-game counterpart of `example_tic_tac_toe` (one tunnel =
/// one game). It requires NO changes to `sui_tunnel::tunnel`: the core tunnel is
/// a generic two-party state channel whose `state_hash` is opaque app data, whose
/// `nonce` is a single strictly-increasing per-tunnel counter, and whose signed
/// per-state balances (`party_a_balance`/`party_b_balance`) can carry an arbitrary
/// running split. A session is therefore just an application-level interpretation
/// of those primitives:
///
///   - `state_hash`   commits to (scoreboard || current board || running balances || nonce)
///   - `nonce`        is a SESSION-WIDE monotonic counter spanning every move of every game
///   - balances       are the RUNNING ledger, shifted by `wager_per_game` after each decisive game
///
/// ## Flow
/// ```
/// create_session(A stakes) -> join_session(B stakes)
///   loop N times:
///     [off-chain moves: record_move ...]          // instant, balances unchanged
///     record_game_result()                         // scoreboard++, running balances shift
///   settle_session()                               // ONE cooperative close, cumulative split
/// ```
///
/// ## Settlement
/// The final running balances ARE the cumulative outcome of all games. Example:
/// A and B each stake 100, `wager_per_game = 1`, they play 100 games, A wins 60 /
/// B wins 40 -> running balances end at A=120, B=80, settled in a single
/// `close_cooperative` transferring 120 to A and 80 to B.
///
/// ## Dispute safety (inherited unchanged from the core tunnel)
/// Every running-balance state is dual-signed with a monotonically increasing
/// session nonce, so the LATEST co-signed state (highest nonce = most games
/// accounted) always wins a dispute via `raise_dispute` / `resolve_dispute`, and
/// `force_close_after_timeout` distributes those latest signed running balances.
/// An old, more-favorable state (e.g. from when the cheater was ahead) is rejected
/// because its nonce is not greater than the current committed nonce.
module sui_tunnel::example_multi_game_tictactoe;

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

#[error]
const ESessionComplete: vector<u8> = b"The session has already played its target number of games.";

// ============================================
// CONSTANTS
// ============================================

const SESSION_ACTIVE: u8 = 0;
const SESSION_SETTLED: u8 = 1;
const SESSION_DISPUTED: u8 = 2;
const SESSION_FORCE_CLOSED: u8 = 3;

/// Board cell values
const CELL_EMPTY: u8 = 0;
const CELL_X: u8 = 1; // Player A
const CELL_O: u8 = 2; // Player B

/// Game outcomes (per single game)
const OUTCOME_NONE: u8 = 0;
const OUTCOME_PLAYER_A: u8 = 1;
const OUTCOME_PLAYER_B: u8 = 2;
const OUTCOME_DRAW: u8 = 3;

/// Default dispute timeout. Sessions are long-lived (many games), so this is
/// larger than the single-game example's 10 minutes. Either party can extend it
/// further with `tunnel::extend_timeout`.
const DEFAULT_TIMEOUT_MS: u64 = 86_400_000; // 24 hours

// ============================================
// STRUCTS
// ============================================

/// Cumulative results across every game played in the session.
public struct Scoreboard has copy, drop, store {
    /// Number of completed (decisive or drawn) games.
    games_played: u64,
    /// Games won by player A.
    wins_a: u64,
    /// Games won by player B.
    wins_b: u64,
    /// Drawn games.
    draws: u64,
}

/// Full off-chain session state. This is what the `state_hash` commits to and
/// what both parties co-sign on every update.
public struct SessionState has copy, drop, store {
    /// Current game's 9-cell board: 0=empty, 1=X (A), 2=O (B).
    board: vector<u8>,
    /// Number of moves played in the CURRENT game (reset to 0 after each game).
    moves_count: u8,
    /// Cumulative scoreboard across all games.
    scoreboard: Scoreboard,
    /// Running balance currently allocated to party A (net of all completed games).
    balance_a: u64,
    /// Running balance currently allocated to party B (net of all completed games).
    balance_b: u64,
    /// Session-wide monotonic nonce spanning every move of every game.
    nonce: u64,
}

/// A multi-game tic-tac-toe session wrapping a single `Tunnel`.
/// Both players stake equal amounts; `wager_per_game` shifts between them on each
/// decisive game. Funds are distributed once, at the end, by the running balances.
public struct MultiGameTicTacToe<phantom T> has key, store {
    id: UID,
    /// The underlying two-party state channel.
    tunnel: Tunnel<T>,
    /// Session status.
    status: u8,
    /// Latest known session state.
    state: SessionState,
    /// Stake each player locks at open.
    stake_per_player: u64,
    /// Amount shifted from loser to winner on each decisive game (clamped to the
    /// loser's remaining balance so a balance can never go negative).
    wager_per_game: u64,
    /// Target number of games (0 = open-ended: settle whenever both agree).
    target_games: u64,
}

// ============================================
// EVENTS
// ============================================

public struct SessionCreated has copy, drop {
    player_a: address,
    player_b: address,
    stake_per_player: u64,
    wager_per_game: u64,
    target_games: u64,
}

public struct GameResultRecorded has copy, drop {
    outcome: u8,
    games_played: u64,
    wins_a: u64,
    wins_b: u64,
    draws: u64,
    balance_a: u64,
    balance_b: u64,
    nonce: u64,
}

public struct SessionSettled has copy, drop {
    games_played: u64,
    wins_a: u64,
    wins_b: u64,
    draws: u64,
    balance_a: u64,
    balance_b: u64,
}

// ============================================
// CONSTANT GETTERS
// ============================================

public fun session_active(): u8 { SESSION_ACTIVE }

public fun session_settled(): u8 { SESSION_SETTLED }

public fun session_disputed(): u8 { SESSION_DISPUTED }

public fun session_force_closed(): u8 { SESSION_FORCE_CLOSED }

public fun cell_empty(): u8 { CELL_EMPTY }

public fun cell_x(): u8 { CELL_X }

public fun cell_o(): u8 { CELL_O }

public fun outcome_none(): u8 { OUTCOME_NONE }

public fun outcome_player_a(): u8 { OUTCOME_PLAYER_A }

public fun outcome_player_b(): u8 { OUTCOME_PLAYER_B }

public fun outcome_draw(): u8 { OUTCOME_DRAW }

// ============================================
// SESSION LIFECYCLE
// ============================================

/// Player A creates a session and stakes funds. Player B joins with a matching
/// stake. `wager_per_game` is the amount shifted on each decisive game;
/// `target_games` bounds the session (0 = open-ended).
///
/// `penalty_amount` is forwarded to the underlying tunnel and is the recommended
/// anti-griefing / liveness defense for a LONG (many-game) session: it
/// compensates the dispute raiser out of a non-responding counterparty's balance
/// on `force_close_after_timeout`, making frivolous disputes costly. Pass 0 to
/// match the single-game example's behavior.
public fun create_session<T>(
    player_a_address: address,
    player_a_pk: vector<u8>,
    player_b_address: address,
    player_b_pk: vector<u8>,
    wager_per_game: u64,
    target_games: u64,
    penalty_amount: u64,
    stake: Coin<T>,
    clock: &Clock,
    ctx: &mut TxContext,
): MultiGameTicTacToe<T> {
    let stake_amount = stake.value();
    // A single game can shift at most `wager_per_game`; requiring it to be no
    // larger than a stake keeps the running ledger intuitive (clamping below is
    // still the hard safety net against underflow over many games).
    assert!(wager_per_game <= stake_amount, EInvalidParameter);

    let mut tun = tunnel::create<T>(
        player_a_address,
        player_a_pk,
        signature::ed25519(),
        player_b_address,
        player_b_pk,
        signature::ed25519(),
        DEFAULT_TIMEOUT_MS,
        penalty_amount,
        clock,
        ctx,
    );

    tun.deposit_party_a(stake, clock, ctx);

    event::emit(SessionCreated {
        player_a: player_a_address,
        player_b: player_b_address,
        stake_per_player: stake_amount,
        wager_per_game,
        target_games,
    });

    MultiGameTicTacToe {
        id: object::new(ctx),
        tunnel: tun,
        status: SESSION_ACTIVE,
        state: SessionState {
            board: vector[0, 0, 0, 0, 0, 0, 0, 0, 0],
            moves_count: 0,
            scoreboard: Scoreboard { games_played: 0, wins_a: 0, wins_b: 0, draws: 0 },
            // B has not deposited yet; running balances are seeded on join.
            balance_a: stake_amount,
            balance_b: 0,
            nonce: 0,
        },
        stake_per_player: stake_amount,
        wager_per_game,
        target_games,
    }
}

/// Player B joins with a matching stake. This activates the underlying tunnel and
/// seeds the running balances to the equal deposits.
public fun join_session<T>(
    session: &mut MultiGameTicTacToe<T>,
    stake: Coin<T>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(session.status == SESSION_ACTIVE, EInvalidState);
    assert!(stake.value() == session.stake_per_player, EBalanceMismatch);
    session.tunnel.deposit_party_b(stake, clock, ctx);
    // Both deposits equal; running ledger starts even.
    session.state.balance_b = session.stake_per_player;
}

// ============================================
// STATE HASHING (off-chain signed commitment)
// ============================================

/// Compute the session state hash that both parties sign on every update.
/// Domain-separated and bound to the tunnel id so a signature can never be
/// replayed onto a different tunnel.
///
/// IMPORTANT (cross-layer wire compatibility): this layout is the CANONICAL
/// session-state encoding and MUST be reproduced byte-for-byte by any off-chain
/// signer (e.g. the TypeScript SDK's `MultiGameTicTacToeProtocol.encodeState`),
/// because this hash becomes the opaque 32-byte `state_hash` field of the CORE
/// `sui_tunnel::state_update` message that `tunnel::update_state` /
/// `tunnel::raise_dispute` actually verify. The `nonce` is deliberately EXCLUDED
/// here: it is already bound (and checked monotonic) by the core state-update
/// message, and the off-chain engine computes this hash before it knows the
/// nonce — including it here would make on-chain and off-chain hashes diverge.
public fun compute_session_hash<T>(
    session: &MultiGameTicTacToe<T>,
    board: &vector<u8>,
    moves_count: u8,
    games_played: u64,
    wins_a: u64,
    wins_b: u64,
    draws: u64,
    balance_a: u64,
    balance_b: u64,
): vector<u8> {
    compute_session_hash_with_id(
        tunnel::id(&session.tunnel),
        board,
        moves_count,
        games_played,
        wins_a,
        wins_b,
        draws,
        balance_a,
        balance_b,
    )
}

/// Compute the session hash from a raw tunnel id (avoids double-borrow).
/// Layout: `b"multi_tic_tac_toe::session" || tunnel_id(32) || board(9) ||
/// moves_count(1) || u64be(games_played) || u64be(wins_a) || u64be(wins_b) ||
/// u64be(draws) || u64be(balance_a) || u64be(balance_b)`, then blake2b256.
public fun compute_session_hash_with_id(
    tunnel_id: ID,
    board: &vector<u8>,
    moves_count: u8,
    games_played: u64,
    wins_a: u64,
    wins_b: u64,
    draws: u64,
    balance_a: u64,
    balance_b: u64,
): vector<u8> {
    let mut data = b"multi_tic_tac_toe::session";
    data.append(tunnel_id.to_bytes());
    data.append(*board);
    data.push_back(moves_count);
    data.append(signature::u64_to_be_bytes(games_played));
    data.append(signature::u64_to_be_bytes(wins_a));
    data.append(signature::u64_to_be_bytes(wins_b));
    data.append(signature::u64_to_be_bytes(draws));
    data.append(signature::u64_to_be_bytes(balance_a));
    data.append(signature::u64_to_be_bytes(balance_b));
    hash::blake2b256(&data)
}

// ============================================
// MOVE TRACKING + GAME RESULT ACCOUNTING
// ============================================

/// Record a single move. `new_board` is the position AFTER the move.
///
/// If the move COMPLETES the current game (a winning line, or a full board =
/// draw), the result is folded immediately and atomically in this one dual-signed
/// state: the scoreboard is updated, the running balances shift by
/// `wager_per_game` (clamped to the loser's balance so neither can go negative),
/// and the board resets to empty for the next game. If the move does NOT end the
/// game, only the board advances and balances/scoreboard are unchanged.
///
/// Folding result + reset into the SAME state (one nonce) is deliberate: it keeps
/// this on-chain wrapper and the off-chain TypeScript signer producing an
/// IDENTICAL `(state_hash, nonce, balances)` sequence, which is what makes an
/// off-chain-signed update enforceable on-chain in a dispute.
///
/// Empty signatures record the move off-chain only (the instant-move hot path);
/// passing both signatures additionally checkpoints the state on-chain via
/// `tunnel::update_state`.
public fun record_move<T>(
    session: &mut MultiGameTicTacToe<T>,
    new_board: vector<u8>,
    moves_count: u8,
    nonce: u64,
    timestamp: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    clock: &Clock,
) {
    assert!(session.status == SESSION_ACTIVE, EInvalidState);
    assert!(nonce > session.state.nonce, EInvalidNonce);
    assert!(new_board.length() == 9, EInvalidParameter);
    assert!((moves_count as u64) <= 9, EInvalidParameter);
    // No further play once the session has reached its target number of games.
    if (session.target_games > 0) {
        assert!(session.state.scoreboard.games_played < session.target_games, ESessionComplete);
    };
    validate_board(&new_board);

    let outcome = check_winner(&new_board, moves_count);
    let sb = session.state.scoreboard;

    // The committed board/scoreboard/balances depend on whether the game ended.
    let (board, mc, games_played, wins_a, wins_b, draws, balance_a, balance_b) = if (
        outcome == OUTCOME_NONE
    ) {
        (
            new_board,
            moves_count,
            sb.games_played,
            sb.wins_a,
            sb.wins_b,
            sb.draws,
            session.state.balance_a,
            session.state.balance_b,
        )
    } else {
        let (g, wa, wb, dr, ba, bb) = apply_game_outcome(
            sb.games_played,
            sb.wins_a,
            sb.wins_b,
            sb.draws,
            session.state.balance_a,
            session.state.balance_b,
            session.wager_per_game,
            outcome,
        );
        (vector<u8>[0, 0, 0, 0, 0, 0, 0, 0, 0], 0, g, wa, wb, dr, ba, bb)
    };

    let state_hash = compute_session_hash_with_id(
        tunnel::id(&session.tunnel),
        &board,
        mc,
        games_played,
        wins_a,
        wins_b,
        draws,
        balance_a,
        balance_b,
    );

    session.state.board = board;
    session.state.moves_count = mc;
    session.state.scoreboard = Scoreboard { games_played, wins_a, wins_b, draws };
    session.state.balance_a = balance_a;
    session.state.balance_b = balance_b;
    session.state.nonce = nonce;

    if (outcome != OUTCOME_NONE) {
        event::emit(GameResultRecorded {
            outcome,
            games_played,
            wins_a,
            wins_b,
            draws,
            balance_a,
            balance_b,
            nonce,
        });
    };

    maybe_checkpoint(session, state_hash, nonce, timestamp, sig_a, sig_b, clock);
}

/// Pure outcome application: given the current scoreboard + running balances and
/// a per-game `wager`, return the updated `(games_played, wins_a, wins_b, draws,
/// balance_a, balance_b)` after a game with `outcome`. The wager is clamped to the
/// loser's balance so neither balance can go negative; the sum is invariant.
public fun apply_game_outcome(
    games_played: u64,
    wins_a: u64,
    wins_b: u64,
    draws: u64,
    balance_a: u64,
    balance_b: u64,
    wager: u64,
    outcome: u8,
): (u64, u64, u64, u64, u64, u64) {
    if (outcome == OUTCOME_PLAYER_A) {
        let shift = wager.min(balance_b);
        (games_played + 1, wins_a + 1, wins_b, draws, balance_a + shift, balance_b - shift)
    } else if (outcome == OUTCOME_PLAYER_B) {
        let shift = wager.min(balance_a);
        (games_played + 1, wins_a, wins_b + 1, draws, balance_a - shift, balance_b + shift)
    } else {
        // Draw: balances unchanged.
        (games_played + 1, wins_a, wins_b, draws + 1, balance_a, balance_b)
    }
}

/// Internal: if both signatures are present, checkpoint the running state on-chain
/// via the tunnel; if both are empty, the update stays purely off-chain. Mixed
/// (one empty) is rejected.
fun maybe_checkpoint<T>(
    session: &mut MultiGameTicTacToe<T>,
    state_hash: vector<u8>,
    nonce: u64,
    timestamp: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    clock: &Clock,
) {
    assert!(
        (sig_a.is_empty() && sig_b.is_empty()) || (!sig_a.is_empty() && !sig_b.is_empty()),
        EInvalidSignature,
    );
    if (!sig_a.is_empty()) {
        session
            .tunnel
            .update_state(
                state_hash,
                nonce,
                session.state.balance_a,
                session.state.balance_b,
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
/// Returns: 0=none, 1=player A (X), 2=player B (O), 3=draw.
/// (Self-contained copy of the single-game `check_winner` so this example
/// depends only on core tunnel APIs.)
public fun check_winner(board: &vector<u8>, moves_count: u8): u8 {
    // Rows
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

    // Columns
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

    // Diagonals
    if (board[0] != CELL_EMPTY && board[0] == board[4] && board[0] == board[8]) {
        return board[0]
    };
    if (board[2] != CELL_EMPTY && board[2] == board[4] && board[2] == board[6]) {
        return board[2]
    };

    // Draw: all cells filled with no line.
    if ((moves_count as u64) == 9) {
        return OUTCOME_DRAW
    };

    OUTCOME_NONE
}

/// Validate that all board cells contain valid values.
fun validate_board(board: &vector<u8>) {
    9u64.do!(|i| {
        let cell = board[i];
        assert!(cell == CELL_EMPTY || cell == CELL_X || cell == CELL_O, EInvalidParameter);
    });
}

// ============================================
// SETTLEMENT (single cooperative close at the end)
// ============================================

/// Settle the whole session in ONE cooperative close. `player_a_balance` /
/// `player_b_balance` are the agreed FINAL (cumulative) balances and must equal
/// the session's running balances; both players sign the settlement separately
/// (the tunnel's `serialize_settlement` domain). This is the only fund-moving
/// on-chain transaction of the entire session.
public fun settle_session<T>(
    session: &mut MultiGameTicTacToe<T>,
    player_a_balance: u64,
    player_b_balance: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    timestamp: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(session.status == SESSION_ACTIVE, EInvalidState);
    // Defense in depth: the settlement must match the agreed running ledger.
    assert!(player_a_balance == session.state.balance_a, EBalanceMismatch);
    assert!(player_b_balance == session.state.balance_b, EBalanceMismatch);

    session
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

    session.status = SESSION_SETTLED;

    let sb = session.state.scoreboard;
    event::emit(SessionSettled {
        games_played: sb.games_played,
        wins_a: sb.wins_a,
        wins_b: sb.wins_b,
        draws: sb.draws,
        balance_a: player_a_balance,
        balance_b: player_b_balance,
    });
}

// ============================================
// DISPUTE PATH (inherited from the core tunnel)
// ============================================

/// Raise a dispute with the latest co-signed running state. The submitted
/// `(state_hash, nonce, balances)` must be the highest-nonce state the
/// counterparty signed; higher nonce = more games accounted, so the cumulative
/// result is what settles.
public fun raise_dispute<T>(
    session: &mut MultiGameTicTacToe<T>,
    state_hash: vector<u8>,
    nonce: u64,
    party_a_balance: u64,
    party_b_balance: u64,
    timestamp: u64,
    other_party_sig: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(session.status == SESSION_ACTIVE, EInvalidState);
    session
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
    session.status = SESSION_DISPUTED;
}

/// Defend against a stale-state dispute by submitting a newer co-signed running
/// state (higher nonce). Returns the session to active.
public fun resolve_dispute<T>(
    session: &mut MultiGameTicTacToe<T>,
    state_hash: vector<u8>,
    nonce: u64,
    party_a_balance: u64,
    party_b_balance: u64,
    timestamp: u64,
    sig_a: vector<u8>,
    sig_b: vector<u8>,
    clock: &Clock,
) {
    assert!(session.status == SESSION_DISPUTED, ENoActiveDispute);
    session
        .tunnel
        .resolve_dispute(
            state_hash,
            nonce,
            party_a_balance,
            party_b_balance,
            timestamp,
            sig_a,
            sig_b,
            clock,
        );
    session.status = SESSION_ACTIVE;
}

/// Counterparty agrees to the disputed running state, settling immediately
/// without waiting out the timeout.
public fun agree_to_dispute<T>(
    session: &mut MultiGameTicTacToe<T>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(session.status == SESSION_DISPUTED, ENoActiveDispute);
    session.tunnel.agree_to_dispute(clock, ctx);
    session.status = SESSION_SETTLED;
}

/// Force-close after the dispute timeout, distributing the latest signed running
/// balances. Only the dispute raiser can call this once the timeout elapses.
public fun force_close<T>(session: &mut MultiGameTicTacToe<T>, clock: &Clock, ctx: &mut TxContext) {
    assert!(session.status == SESSION_DISPUTED, ENoActiveDispute);
    session.tunnel.force_close_after_timeout(clock, ctx);
    session.status = SESSION_FORCE_CLOSED;
}

// ============================================
// ACCESSORS
// ============================================

public fun session_status<T>(s: &MultiGameTicTacToe<T>): u8 { s.status }

public fun session_tunnel<T>(s: &MultiGameTicTacToe<T>): &Tunnel<T> { &s.tunnel }

public fun session_state<T>(s: &MultiGameTicTacToe<T>): &SessionState { &s.state }

public fun session_total_pot<T>(s: &MultiGameTicTacToe<T>): u64 {
    tunnel::total_balance(&s.tunnel)
}

public fun stake_per_player<T>(s: &MultiGameTicTacToe<T>): u64 { s.stake_per_player }

public fun wager_per_game<T>(s: &MultiGameTicTacToe<T>): u64 { s.wager_per_game }

public fun target_games<T>(s: &MultiGameTicTacToe<T>): u64 { s.target_games }

/// True once the session has played its target number of games (always false for
/// an open-ended session with `target_games == 0`).
public fun is_session_complete<T>(s: &MultiGameTicTacToe<T>): bool {
    s.target_games > 0 && s.state.scoreboard.games_played >= s.target_games
}

public fun session_nonce<T>(s: &MultiGameTicTacToe<T>): u64 { s.state.nonce }

public fun session_balance_a<T>(s: &MultiGameTicTacToe<T>): u64 { s.state.balance_a }

public fun session_balance_b<T>(s: &MultiGameTicTacToe<T>): u64 { s.state.balance_b }

public fun session_board<T>(s: &MultiGameTicTacToe<T>): &vector<u8> { &s.state.board }

public fun session_moves_count<T>(s: &MultiGameTicTacToe<T>): u8 { s.state.moves_count }

public fun games_played<T>(s: &MultiGameTicTacToe<T>): u64 { s.state.scoreboard.games_played }

public fun wins_a<T>(s: &MultiGameTicTacToe<T>): u64 { s.state.scoreboard.wins_a }

public fun wins_b<T>(s: &MultiGameTicTacToe<T>): u64 { s.state.scoreboard.wins_b }

public fun draws<T>(s: &MultiGameTicTacToe<T>): u64 { s.state.scoreboard.draws }

// State accessors
public fun state_board(s: &SessionState): &vector<u8> { &s.board }

public fun state_moves_count(s: &SessionState): u8 { s.moves_count }

public fun state_nonce(s: &SessionState): u64 { s.nonce }

public fun state_balance_a(s: &SessionState): u64 { s.balance_a }

public fun state_balance_b(s: &SessionState): u64 { s.balance_b }

public fun state_scoreboard(s: &SessionState): &Scoreboard { &s.scoreboard }

public fun scoreboard_games_played(s: &Scoreboard): u64 { s.games_played }

public fun scoreboard_wins_a(s: &Scoreboard): u64 { s.wins_a }

public fun scoreboard_wins_b(s: &Scoreboard): u64 { s.wins_b }

public fun scoreboard_draws(s: &Scoreboard): u64 { s.draws }

// ============================================
// TEST HELPERS
// ============================================

#[test_only]
public fun destroy_session_for_testing<T>(session: MultiGameTicTacToe<T>) {
    let MultiGameTicTacToe { id, tunnel, .. } = session;
    id.delete();
    tunnel.destroy_for_testing();
}

#[test_only]
public fun set_status_for_testing<T>(session: &mut MultiGameTicTacToe<T>, status: u8) {
    session.status = status;
}
