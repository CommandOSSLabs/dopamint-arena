/**
 * Pure, React-free helpers for the Caro worker SELF-PLAY spec — the caro sibling of `tttSoloCore`.
 * Only TYPE imports from the SDK / game packages, and the bot is INJECTED (a cell-picker per seat),
 * so this module stays free of value imports and is unit-testable on its own; the wrapper PROTOCOL
 * (a value import of `MultiGameCaroProtocol`) and the real `pickCaroMove` bot live in `caroSoloSpec`.
 *
 * WINNER ENCODING. The SDK's `CaroProtocol` encodes the per-game winner as `0|1|2|3`
 * (none / A / B / draw); the generic `SoloEngine` reads `state.inner.winner` as
 * `"A"|"B"|"draw"|null` (engineApi `SoloMultiGameState`). This converts at the boundary while the
 * protocol keeps running on the numeric form, so `encodeState`/`balances`/the on-chain state hash
 * stay byte-identical to the canonical protocol (see `caroSoloSpec`'s wrapper).
 */
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import type { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import type {
  CaroState,
  MultiGameCaroState,
  MultiGameCaroMove,
} from "@ttt/shared";

/** Per-game winner in the engine's contract form (X≙A, O≙B). */
export type CaroWinner = "A" | "B" | "draw" | null;

/** The inner single-game state with `winner` widened to the engine's string form. */
export type SoloCaroInner = Omit<CaroState, "winner"> & { winner: CaroWinner };

/** The multi-game state the `SoloEngine` reads (`gamesPlayed` + string `inner.winner`). */
export interface SoloCaroState {
  inner: SoloCaroInner;
  gamesPlayed: number;
  maxGames: number;
}

/** A duel-advance outcome: one tick stepped, the inner game ended, or the session is over. */
export type StepOutcome = "stepped" | "game-over" | "session-over";

/** Who took the session (or a push). */
export type CaroResult = "A" | "B" | "draw";

/** Render-ready snapshot the `CaroBoard` consumes (bigints → numbers, winner as the string form). */
export interface CaroView {
  board: number[]; // size*size cells, row-major: 0 empty, 1 A, 2 B
  size: number;
  turn: Party;
  winner: CaroWinner;
  lastMove: number;
  gamesPlayed: number;
  maxGames: number;
  balanceA: number;
  balanceB: number;
}

/**
 * A seat's bot, injected by the spec: given the NUMERIC inner state and an rng, return the cell to
 * play. The spec closes over the seat + strength (`pickCaroMove`), keeping value imports out of here.
 */
export type CaroBot = (inner: CaroState, rng: () => number) => number;

/** When a human takes over a seat, the loop supplies its next cell (undefined ⇒ autopilot). */
export interface CaroHumanSeat {
  seat: Party;
  getCell: () => number | undefined;
}

// --- winner bijection + state conversion -----------------------------------

export function numToWinner(w: number): CaroWinner {
  return w === 1 ? "A" : w === 2 ? "B" : w === 3 ? "draw" : null;
}

export function winnerToNum(w: CaroWinner): number {
  return w === "A" ? 1 : w === "B" ? 2 : w === "draw" ? 3 : 0;
}

/** Numeric protocol state → engine-facing state (inner.winner as a string). */
export function toSolo(s: MultiGameCaroState): SoloCaroState {
  return { ...s, inner: { ...s.inner, winner: numToWinner(s.inner.winner) } };
}

/** Engine-facing state → numeric protocol state (what the SDK protocol + bot read). */
export function toRaw(s: SoloCaroState): MultiGameCaroState {
  return {
    ...s,
    inner: { ...s.inner, winner: winnerToNum(s.inner.winner) },
  } as MultiGameCaroState;
}

// --- view / result ----------------------------------------------------------

export function deriveCaroView(state: SoloCaroState): CaroView {
  return {
    board: [...state.inner.board],
    size: state.inner.size,
    turn: state.inner.turn,
    winner: state.inner.winner,
    lastMove: state.inner.lastMove,
    gamesPlayed: state.gamesPlayed,
    maxGames: state.maxGames,
    balanceA: Number(state.inner.balanceA),
    balanceB: Number(state.inner.balanceB),
  };
}

export function caroSessionResult(inner: SoloCaroState["inner"]): CaroResult {
  if (inner.winner === "A") return "A";
  if (inner.winner === "B") return "B";
  return "draw"; // "draw" OR null (in-progress) → neutral draw.
}

/** A fresh 16-byte commit-reveal salt (the SDK `CaroMove` requires one — `encode` hashes it). */
function freshSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16));
}

// --- per-tick stepper -------------------------------------------------------

/**
 * Advance a multi-game Caro self-play duel by one tick:
 *  - "stepped"      one inner move co-signed;
 *  - "game-over"    the inner game decided but the session can fund another (caller records the
 *                   score, then `kickoffNextGameCaro` to rematch on the same tunnel);
 *  - "session-over" max games reached or a side can't fund the next stake — caller settles.
 *
 * Caro is TURN-BASED (the mover is `inner.turn`). The auto move comes from the seat's injected bot,
 * which reads the NUMERIC inner state — so we hand it `toRaw(s).inner`. A human take-over seat
 * overrides its own move with the queued cell (falling back to its bot when nothing is queued).
 */
export function stepMultiGameCaro(
  protocol: { isTerminal: (s: SoloCaroState) => boolean },
  tunnel: OffchainTunnel<SoloCaroState, MultiGameCaroMove>,
  bots: Record<Party, CaroBot>,
  human?: CaroHumanSeat | null,
): StepOutcome {
  const s = tunnel.state;
  if (protocol.isTerminal(s)) return "session-over";
  if (s.inner.winner !== null) return "game-over";

  const by: Party = s.inner.turn;
  const rawInner = toRaw(s).inner;
  let cell: number;
  if (human && human.seat === by) {
    const queued = human.getCell();
    cell = queued !== undefined ? queued : bots[by](rawInner, Math.random);
  } else {
    cell = bots[by](rawInner, Math.random);
  }
  tunnel.step({ cell, salt: freshSalt() }, by);
  return "stepped";
}

/**
 * Start the next game on the SAME tunnel. The inner game is terminal, so any move is an "advance"
 * trigger; the protocol resets to a fresh board carrying balances forward, alternating the opener.
 * Only seat A drives the advance (the protocol's `randomMove` convention).
 */
export function kickoffNextGameCaro(
  tunnel: OffchainTunnel<SoloCaroState, MultiGameCaroMove>,
): void {
  tunnel.step({ cell: 0, salt: freshSalt() }, "A");
}
