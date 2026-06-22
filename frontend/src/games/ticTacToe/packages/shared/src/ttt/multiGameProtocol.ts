/**
 * Multi-game Tic-Tac-Toe protocol: play a fixed number of TTT games inside ONE
 * tunnel and settle ONCE on-chain.
 *
 * This is a GAME-SIDE protocol (it lives in the ticTacToe game, not the SDK). It
 * COMPOSES the SDK's single-game `TicTacToeProtocol` rather than duplicating its
 * rules: each in-game cell move is delegated to the inner protocol, and balances
 * accumulate across games inside the inner state. The model mirrors Blackjack's
 * round loop — a stake shifts loser->winner per game, balances carry forward, and
 * after the last game one cooperative close pays out the net result.
 *
 * ===== STATE MACHINE =====
 *
 *   gamesPlayed = number of inner games that have been STARTED-AND-FINISHED and
 *   then advanced past (i.e. the count of completed games behind the current one).
 *   The currently-running inner game is game number `gamesPlayed + 1`.
 *
 *   applyMove(state, move, by):
 *     - inner NOT terminal  -> delegate to inner.applyMove (a normal cell move).
 *     - inner IS terminal   -> this is an "advance" move that resets to a fresh
 *                              empty board for the next game, carrying the inner
 *                              balances forward and bumping gamesPlayed. Only legal
 *                              while the whole session is NOT terminal.
 *
 *   isTerminal(state): the session is over (ready to settle) when the current inner
 *   game has finished AND either we have just completed the last game
 *   (gamesPlayed + 1 >= maxGames) or a side can no longer cover the next stake.
 *   A single finished game is NOT terminal unless it was the last one.
 *
 * ===== BALANCE CONSERVATION =====
 *
 * Money only ever moves between A and B via the inner protocol's clamped stake
 * swap, and a reset carries inner.balanceA/balanceB forward verbatim. So
 * balances(state).a + balances(state).b == the locked total for every reachable
 * state, exactly as for the single-game protocol.
 *
 * ===== encodeState DETERMINISM =====
 *
 * encodeState = domain || lengthPrefixedConcat([inner.encodeState(inner),
 * u64be(gamesPlayed)]), built from the SDK's own `protocolDomain` /
 * `lengthPrefixedConcat` / `u64ToBeBytes` helpers so the byte format matches the
 * framework exactly. The inner encoding already pins the board, balances and
 * stake; the wrapper domain + length-delimiting makes the multi-game state
 * canonical and collision-free, so both parties and an on-chain replay agree on
 * the state hash.
 */

import { core, protocols } from "sui-tunnel-ts";

type Protocol<State, Move> = protocols.Protocol<State, Move>;
type Party = protocols.Party;
type Balances = protocols.Balances;
type ProtocolContext = protocols.ProtocolContext;
type TicTacToeState = protocols.TicTacToeState;
type TicTacToeMove = protocols.TicTacToeMove;

export interface MultiGameTicTacToeState {
  /** Current single-game state (board, turn, winner, carried balances, stake). */
  inner: TicTacToeState;
  /** Completed games behind the current one; current game is `gamesPlayed + 1`. */
  gamesPlayed: number;
  /** Total games to play in this tunnel before settling once. */
  maxGames: number;
}

/** A move is either an inner cell move, or (when a game just ended) an advance trigger. */
export type MultiGameTicTacToeMove = TicTacToeMove;

/**
 * Plays `maxGames` Tic-Tac-Toe games over one tunnel, composing the SDK's
 * single-game `TicTacToeProtocol`. Domain tag is distinct from the inner protocol
 * so the two encodings can never collide on the wire.
 */
export class MultiGameTicTacToeProtocol implements Protocol<
  MultiGameTicTacToeState,
  MultiGameTicTacToeMove
> {
  readonly name = "tic_tac_toe.multi.v1";

  // Distinct domain tag so a multi-game state hash never collides with a
  // single-game one, even when the inner game state happens to match.
  private readonly domain = protocols.protocolDomain("tic_tac_toe.multi.v1");
  private readonly inner: protocols.TicTacToeProtocol;
  private readonly maxGames: number;

  /**
   * @param maxGames number of games to play in one tunnel (>= 1)
   * @param stake    per-game stake passed to the inner protocol
   */
  constructor(maxGames: number, stake: bigint = 0n) {
    if (!Number.isInteger(maxGames) || maxGames < 1) {
      throw new Error("maxGames must be a positive integer");
    }
    this.maxGames = maxGames;
    this.inner = new protocols.TicTacToeProtocol(stake);
  }

  initialState(ctx: ProtocolContext): MultiGameTicTacToeState {
    return {
      inner: this.inner.initialState(ctx),
      gamesPlayed: 0,
      maxGames: this.maxGames,
    };
  }

  applyMove(
    state: MultiGameTicTacToeState,
    move: MultiGameTicTacToeMove,
    by: Party,
  ): MultiGameTicTacToeState {
    // Mid-game: a normal cell move, delegated to the inner protocol (which throws
    // on illegal moves and shifts the stake loser->winner on a decisive result).
    if (!this.inner.isTerminal(state.inner)) {
      return {
        ...state,
        inner: this.inner.applyMove(state.inner, move, by),
      };
    }

    // A game just finished: this move advances to the next game. Illegal once the
    // whole session is terminal (nothing left to play).
    if (this.isTerminal(state)) {
      throw new Error("session over: no more games can be played");
    }

    // Reset to a fresh empty board for the next game, carrying balances forward.
    // We rebuild the inner game via the inner protocol's initialState so the stake
    // is re-capped to what each side can now afford — identical to how a single
    // tunnel would have re-opened, but without any on-chain round-trip.
    const carried = this.inner.initialState({
      tunnelId: "",
      initialBalances: { a: state.inner.balanceA, b: state.inner.balanceB },
    });
    return {
      inner: carried,
      gamesPlayed: state.gamesPlayed + 1,
      maxGames: state.maxGames,
    };
  }

  encodeState(state: MultiGameTicTacToeState): Uint8Array {
    // Length-prefix both parts so distinct (inner, gamesPlayed) pairs can't alias.
    return core.concatBytes([
      this.domain,
      protocols.lengthPrefixedConcat([
        this.inner.encodeState(state.inner),
        core.u64ToBeBytes(state.gamesPlayed),
      ]),
    ]);
  }

  balances(state: MultiGameTicTacToeState): Balances {
    return this.inner.balances(state.inner);
  }

  isTerminal(state: MultiGameTicTacToeState): boolean {
    // Only ever terminal between games (when the current inner game has resolved).
    if (!this.inner.isTerminal(state.inner)) return false;
    // The game that just finished is number `gamesPlayed + 1`.
    if (state.gamesPlayed + 1 >= state.maxGames) return true;
    // Stop early if the next game's stake can no longer be funded by both sides.
    return !this.canFundNextGame(state.inner);
  }

  randomMove(
    state: MultiGameTicTacToeState,
    by: Party,
    rng: () => number,
  ): MultiGameTicTacToeMove | null {
    // Mid-game: defer to the inner protocol's legal-move picker.
    if (!this.inner.isTerminal(state.inner)) {
      return this.inner.randomMove?.(state.inner, by, rng) ?? null;
    }
    // Between games: any cell on the fresh board is a legal advance trigger; the
    // reset ignores the cell, so just nominate cell 0 (and only let A drive it,
    // mirroring Blackjack's "A starts the next round" convention).
    if (this.isTerminal(state)) return null;
    if (by !== "A") return null;
    return { cell: 0 };
  }

  /** Whether both sides can still cover the per-game stake for another game. */
  private canFundNextGame(inner: TicTacToeState): boolean {
    // A zero stake is always fundable; otherwise both must cover it.
    if (inner.stake === 0n) return true;
    return inner.balanceA >= inner.stake && inner.balanceB >= inner.stake;
  }
}
