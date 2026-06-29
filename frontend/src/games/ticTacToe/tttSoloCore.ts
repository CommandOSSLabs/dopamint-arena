/**
 * Pure, React-free helpers for the Tic-Tac-Toe worker SELF-PLAY spec (parallel to bomb-it's
 * `session-core.ts`). Only TYPE imports from the SDK / game packages so it runs under tsx (the
 * vite alias is not resolved at runtime). The wrapper PROTOCOL (a value import of
 * `MultiGameTicTacToeProtocol`) lives in `tttSoloSpec.ts`; everything here is pure data + the
 * per-tick stepper, threaded the protocol/tunnel/bots as params.
 *
 * WINNER ENCODING. The SDK's `TicTacToeProtocol` encodes the per-game winner as `0|1|2|3`
 * (none / X / O / draw). The generic `SoloEngine` reads `state.inner.winner` as
 * `"A"|"B"|"draw"|null` to tally the session (engineApi `SoloMultiGameState`). X≙A, O≙B, so the
 * map is a bijection: this module converts at the boundary (engine sees strings) while the
 * protocol keeps running on the numeric form (so `encodeState`/`balances`/the on-chain state
 * hash stay byte-identical to the canonical protocol — see `tttSoloSpec`'s wrapper).
 */
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import type { TicTacToeState, Winner } from "sui-tunnel-ts/protocol/ticTacToe";
import type { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import type {
  MultiGameTicTacToeState,
  MultiGameTicTacToeMove,
} from "@ttt/shared/ttt/multiGameProtocol";
import type { GameBot } from "@/agent/gameKit";

/** Per-game winner in the engine's contract form (X≙A, O≙B). */
export type TttWinner = "A" | "B" | "draw" | null;

/** The inner single-game state with `winner` widened to the engine's string form. */
export type SoloTttInner = Omit<TicTacToeState, "winner"> & { winner: TttWinner };

/**
 * The multi-game state the `SoloEngine` reads: `gamesPlayed` + `inner.winner` (string) satisfy
 * `SoloMultiGameState`; the rest is the carried board/balances the view flattens.
 */
export interface SoloTttState {
  inner: SoloTttInner;
  gamesPlayed: number;
  maxGames: number;
}

/** A duel-advance outcome: one tick stepped, the inner game ended, or the bank is exhausted. */
export type StepOutcome = "stepped" | "game-over" | "session-over";

/** Who took the session (or a push). */
export type TttResult = "A" | "B" | "draw";

/** Render-ready snapshot the board consumes (bigints → numbers, winner as the string form). */
export interface TttView {
  board: number[]; // 9 cells, row-major: 0 empty, 1 X/A, 2 O/B
  turn: Party;
  winner: TttWinner; // the running inner game's winner (null while it plays)
  gamesPlayed: number;
  maxGames: number;
  balanceA: number;
  balanceB: number;
}

/** When a human takes over a seat, the loop supplies its next cell (undefined ⇒ autopilot). */
export interface TttHumanSeat {
  seat: Party;
  getCell: () => number | undefined;
}

// --- winner bijection + state conversion -----------------------------------

export function numToWinner(w: Winner): TttWinner {
  return w === 1 ? "A" : w === 2 ? "B" : w === 3 ? "draw" : null;
}

export function winnerToNum(w: TttWinner): Winner {
  return (w === "A" ? 1 : w === "B" ? 2 : w === "draw" ? 3 : 0) as Winner;
}

/** Numeric protocol state → engine-facing state (inner.winner as a string). */
export function toSolo(s: MultiGameTicTacToeState): SoloTttState {
  return { ...s, inner: { ...s.inner, winner: numToWinner(s.inner.winner) } };
}

/** Engine-facing state → numeric protocol state (what the SDK protocol + bots read). */
export function toRaw(s: SoloTttState): MultiGameTicTacToeState {
  return {
    ...s,
    inner: { ...s.inner, winner: winnerToNum(s.inner.winner) },
  } as MultiGameTicTacToeState;
}

// --- view / result ----------------------------------------------------------

export function deriveTttView(state: SoloTttState): TttView {
  return {
    board: [...state.inner.board],
    turn: state.inner.turn,
    winner: state.inner.winner,
    gamesPlayed: state.gamesPlayed,
    maxGames: state.maxGames,
    balanceA: Number(state.inner.balanceA),
    balanceB: Number(state.inner.balanceB),
  };
}

export function tttSessionResult(inner: SoloTttState["inner"]): TttResult {
  if (inner.winner === "A") return "A";
  if (inner.winner === "B") return "B";
  // "draw" OR null (in-progress) → neutral draw.
  return "draw";
}

// --- per-tick stepper -------------------------------------------------------

/**
 * Advance a multi-game self-play duel by one tick. Returns:
 *  - "stepped"      one inner move co-signed;
 *  - "game-over"    the inner game decided but the session can fund another (caller records the
 *                   score, then `kickoffNextGameTtt` to rematch on the same tunnel);
 *  - "session-over" max games reached or a side can't fund the next stake — caller settles.
 *
 * Tic-Tac-Toe is TURN-BASED (the mover is `inner.turn`, not tick parity). Auto moves come from the
 * seat's kit bot (`bots[by].plan`), which reads the NUMERIC state — so we hand it `toRaw(state)`.
 * A human take-over seat overrides its own move with the queued cell (falling back to its bot when
 * nothing is queued, per the `take() ⇒ undefined means autopilot` contract).
 */
export function stepMultiGameTtt(
  protocol: { isTerminal: (s: SoloTttState) => boolean },
  tunnel: OffchainTunnel<SoloTttState, MultiGameTicTacToeMove>,
  bots: Record<Party, GameBot<MultiGameTicTacToeState, MultiGameTicTacToeMove>>,
  human?: TttHumanSeat | null,
): StepOutcome {
  const s = tunnel.state;
  if (protocol.isTerminal(s)) return "session-over";
  // Inner game decided (and the session is NOT terminal, checked above) → time to advance.
  if (s.inner.winner !== null) return "game-over";

  const by: Party = s.inner.turn;
  const raw = toRaw(s);
  let move: MultiGameTicTacToeMove | null;
  if (human && human.seat === by) {
    const cell = human.getCell();
    move = cell !== undefined ? { cell } : bots[by].plan(raw);
  } else {
    move = bots[by].plan(raw);
  }
  if (!move) return "game-over"; // defensive: no legal move mid-game shouldn't happen
  tunnel.step(move, by);
  return "stepped";
}

/**
 * Start the next game on the SAME tunnel. The inner game is terminal, so any move is an "advance"
 * trigger; the protocol resets to a fresh board carrying balances forward. Only seat A drives it
 * (the protocol's convention), and `{ cell: 0 }` is always a legal advance.
 */
export function kickoffNextGameTtt(
  tunnel: OffchainTunnel<SoloTttState, MultiGameTicTacToeMove>,
): void {
  tunnel.step({ cell: 0 }, "A");
}
