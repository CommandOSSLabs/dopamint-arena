/**
 * Multi-game Battleship: play MANY battleship games inside ONE tunnel and settle
 * ONCE on-chain (whenever the player chooses). Mirrors the Tic-Tac-Toe multi-game
 * wrapper — it COMPOSES the single-game {@link BattleshipProtocol} rather than
 * duplicating its commit-reveal rules: each in-game move is delegated to the inner
 * protocol, and the per-game stake swap accumulates in the inner balances, carried
 * forward across games. One cooperative close pays out the net result.
 *
 * ===== STATE MACHINE =====
 *
 *   gamesPlayed = number of games STARTED-AND-FINISHED behind the current one; the
 *   running game is number `gamesPlayed + 1`.
 *
 *   applyMove(state, move, by):
 *     - inner NOT over -> delegate to inner.applyMove (commit / shoot / reveal).
 *     - inner IS over  -> the move STARTS the next game. Reset to a fresh
 *       `awaitingCommits` board (carrying inner balances forward), bump gamesPlayed,
 *       and apply the move to it. A fresh board only accepts a `commit`, so any
 *       other move throws — only a real rematch-commit advances the session.
 *
 *   isTerminal(state): the session is NEVER auto-terminal during normal play — the
 *   player settles on demand (a cooperative close works at any co-signed state).
 *   It reports terminal only between games when a side can no longer fund the next
 *   stake, a natural exhaustion stop.
 *
 * ===== BALANCE CONSERVATION =====
 *
 * Money moves only via the inner protocol's clamped stake swap; a reset carries
 * inner.balanceA/balanceB forward verbatim. So balances(state).a + .b === the
 * locked total for every reachable state, exactly as single-game.
 *
 * ===== encodeState DETERMINISM =====
 *
 * encodeState = domain || lengthPrefixedConcat([inner.encodeState(inner),
 * u64be(gamesPlayed)]). A distinct domain tag plus length-delimiting makes the
 * multi-game state canonical and collision-free against the inner encoding, so both
 * parties and an on-chain replay agree on the state hash.
 */

import {
  Protocol,
  Party,
  Balances,
  ProtocolContext,
  protocolDomain,
  lengthPrefixedConcat,
} from "sui-tunnel-ts/protocol/Protocol";
import { concatBytes } from "sui-tunnel-ts/core/bytes";
import { u64ToBeBytes } from "sui-tunnel-ts/core/wire";
import {
  BattleshipProtocol,
  type BattleshipState,
  type BattleshipMove,
} from "./battleship";

export interface MultiGameBattleshipState {
  /** The current single battleship game (commits, shots, hits, carried balances, stake). */
  inner: BattleshipState;
  /** Completed games behind the current one; the running game is `gamesPlayed + 1`. */
  gamesPlayed: number;
}

/** A move is a normal inner move; the first `commit` after a game ends starts the next. */
export type MultiGameBattleshipMove = BattleshipMove;

/**
 * Plays an unbounded series of Battleship games over one tunnel by composing the
 * single-game {@link BattleshipProtocol}. A distinct domain tag keeps the
 * multi-game state hash from ever colliding with a single-game one.
 */
export class MultiGameBattleshipProtocol implements Protocol<
  MultiGameBattleshipState,
  MultiGameBattleshipMove
> {
  readonly name = "battleship.multi.v1";

  private readonly domain = protocolDomain("battleship.multi.v1");
  private readonly inner: BattleshipProtocol;

  /** @param stake per-game amount shifted loser -> winner, passed to the inner protocol. */
  constructor(stake: bigint = 100n) {
    this.inner = new BattleshipProtocol(stake);
  }

  initialState(ctx: ProtocolContext): MultiGameBattleshipState {
    return { inner: this.inner.initialState(ctx), gamesPlayed: 0 };
  }

  applyMove(
    state: MultiGameBattleshipState,
    move: MultiGameBattleshipMove,
    by: Party,
  ): MultiGameBattleshipState {
    // Mid-game: a normal commit / shoot / reveal, delegated to the inner protocol
    // (which throws on illegal moves and shifts the stake loser->winner at game end).
    if (!this.inner.isTerminal(state.inner)) {
      return { ...state, inner: this.inner.applyMove(state.inner, move, by) };
    }

    // A game just finished. If neither side can fund the next stake, the session is
    // terminal — nothing more can be played, only settled.
    if (this.isTerminal(state)) {
      throw new Error("session over: insufficient balance for another game");
    }

    // Otherwise this move starts the NEXT game. Reset to a fresh awaitingCommits
    // board, carrying balances forward, and apply the move to it. initialState
    // re-caps the stake to what each side can now afford — identical to re-opening a
    // single tunnel, but with no on-chain round-trip. A non-commit move throws here
    // (a fresh board only accepts commits), so only a real rematch-commit advances.
    const fresh = this.inner.initialState({
      tunnelId: "",
      initialBalances: { a: state.inner.balanceA, b: state.inner.balanceB },
    });
    return {
      inner: this.inner.applyMove(fresh, move, by),
      gamesPlayed: state.gamesPlayed + 1,
    };
  }

  encodeState(state: MultiGameBattleshipState): Uint8Array {
    return concatBytes([
      this.domain,
      lengthPrefixedConcat([
        this.inner.encodeState(state.inner),
        u64ToBeBytes(BigInt(state.gamesPlayed)),
      ]),
    ]);
  }

  balances(state: MultiGameBattleshipState): Balances {
    return this.inner.balances(state.inner);
  }

  isTerminal(state: MultiGameBattleshipState): boolean {
    // During a game the session is never terminal — settlement is player-driven and
    // a cooperative close works at any co-signed state.
    if (!this.inner.isTerminal(state.inner)) return false;
    // Between games: terminal only when a side can no longer fund the next stake.
    return !this.canFundNextGame(state.inner);
  }

  randomMove(
    state: MultiGameBattleshipState,
    by: Party,
    rng: () => number,
  ): MultiGameBattleshipMove | null {
    // Mid-game, defer to the inner picker (only secret-free shoots are producible).
    if (!this.inner.isTerminal(state.inner)) {
      return this.inner.randomMove(state.inner, by, rng);
    }
    // Between games the next move is a commit, which needs a fleet secret the
    // protocol doesn't hold — the session drives it, not the simulator.
    return null;
  }

  /** Whether both sides can still cover the per-game stake for another game. */
  private canFundNextGame(inner: BattleshipState): boolean {
    if (inner.stake === 0n) return true;
    return inner.balanceA >= inner.stake && inner.balanceB >= inner.stake;
  }
}
