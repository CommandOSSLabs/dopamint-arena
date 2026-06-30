/**
 * Caro (gomoku / five-in-a-row) as a worker SELF-PLAY spec — the caro sibling of `tttSoloSpec`,
 * and the worker port of `useCaroBotGame`'s bot-vs-bot mode. Reuses caro's canonical pieces
 * verbatim: `MultiGameCaroProtocol` for the rules and `pickCaroMove` for the heuristic bot — no
 * game logic is reimplemented. The generic `SoloEngine` owns the rest (the one-signature open+fund
 * of both ephemeral seats, the `OffchainTunnel.selfPlay` loop, autopilot/manual cadence, multi-duel
 * rematch, transcript, and cooperative settle).
 *
 * Money-neutral, matching the legacy caro bot game: the protocol's per-game stake shift is `0n`, so
 * balances never move and the funded bank settles back unchanged — caro is free to play. WRAPPER:
 * `SoloMultiGameState` needs `inner.winner` as "A"|"B"|"draw"|null, but the SDK protocol encodes it
 * as 0|1|2|3; {@link SoloCaroProtocol} converts at the boundary while delegating EVERY rule to the
 * numeric inner protocol, so the co-signed state hash + on-chain settle bytes stay identical.
 */
import { defineSoloGame } from "@/engine/specs/defineGame";
import type { SoloGameSpec } from "@/engine/engineApi";
import {
  MultiGameCaroProtocol,
  type MultiGameCaroState,
  type MultiGameCaroMove,
  pickCaroMove,
} from "@ttt/shared";
import type {
  Party,
  ProtocolContext,
  Balances,
} from "sui-tunnel-ts/protocol/Protocol";
import {
  toSolo,
  toRaw,
  deriveCaroView,
  caroSessionResult,
  stepMultiGameCaro,
  kickoffNextGameCaro,
  type SoloCaroState,
  type CaroBot,
  type CaroView,
  type CaroResult,
} from "./caroSoloCore";

/** Games per funded tunnel: amortize one settle across many duels (the TPS showcase). Caro games
 *  are longer than ttt, so this is a smaller cap than ttt's 1000. */
export const CARO_GAMES_PER_TUNNEL = 30;
/** Board edge length — mirrors the legacy caro bot game's default (the client clamps to 9–29). */
export const CARO_BOARD_SIZE = 15;
/** Per-duel display stake; the protocol shift is 0n (money-neutral, matching the legacy game). */
export const CARO_STAKE = 1n;
/** Turn-based: manual play co-signs one tick per this many ms so a takeover move is readable. */
export const CARO_MANUAL_STEP_MS = 400;
/** Per-game beat so the result + score register before the next game (ms). */
export const CARO_REMATCH_MS = 500;

export type CaroBots = Record<Party, CaroBot>;

/** Both seats play the strong heuristic; the rng only breaks ties, so games still diversify. */
export function makeCaroBots(): CaroBots {
  return {
    A: (inner, rng) => pickCaroMove(inner, "A", rng, "strong"),
    B: (inner, rng) => pickCaroMove(inner, "B", rng, "strong"),
  };
}

/**
 * `MultiGameCaroProtocol` widened so `inner.winner` is the engine's "A"|"B"|"draw"|null. It
 * reimplements NO rules — every method delegates to the numeric protocol via `toRaw`/`toSolo`, so
 * the state hash + settleable balances match the plain protocol exactly.
 */
export class SoloCaroProtocol {
  readonly name = "caro.series.v2";
  private readonly mg: MultiGameCaroProtocol;

  constructor(maxGames: number, boardSize: number, stake: bigint) {
    this.mg = new MultiGameCaroProtocol(maxGames, boardSize, stake);
  }

  initialState(ctx: ProtocolContext): SoloCaroState {
    return toSolo(this.mg.initialState(ctx));
  }
  applyMove(
    state: SoloCaroState,
    move: MultiGameCaroMove,
    by: Party,
  ): SoloCaroState {
    return toSolo(this.mg.applyMove(toRaw(state), move, by));
  }
  encodeState(state: SoloCaroState): Uint8Array {
    return this.mg.encodeState(toRaw(state));
  }
  balances(state: SoloCaroState): Balances {
    return this.mg.balances(toRaw(state));
  }
  isTerminal(state: SoloCaroState): boolean {
    return this.mg.isTerminal(toRaw(state));
  }
}

// Annotated as the interface (not the object literal) so `defineSoloGame`'s `S extends AnySoloSpec`
// constraint checks method signatures bivariantly (matches `tttSoloSpec`/`quantumPokerSoloSpec`).
const caroSolo: SoloGameSpec<
  SoloCaroState,
  MultiGameCaroMove,
  number,
  CaroView,
  CaroResult,
  CaroBots,
  SoloCaroProtocol
> = {
  game: "caro",
  stake: CARO_STAKE,
  rematchMs: CARO_REMATCH_MS,
  manualStepMs: CARO_MANUAL_STEP_MS,
  // Fixed config (board size + game cap); money-neutral (stake shift 0n).
  makeProtocol: () =>
    new SoloCaroProtocol(CARO_GAMES_PER_TUNNEL, CARO_BOARD_SIZE, 0n),
  makeBots: makeCaroBots,
  deriveView: deriveCaroView,
  sessionResult: caroSessionResult,
  // One co-signed tick per call (engine batches in autopilot, paces in manual). The take-over seat
  // is always seat A; its queued cell drives A's move, else A's bot fills in.
  stepWith: (protocol, tunnel, bots, take) =>
    stepMultiGameCaro(
      protocol,
      tunnel,
      bots,
      take ? { seat: "A", getCell: () => take() } : null,
    ),
  kickoffNextGame: kickoffNextGameCaro,
};

export const caroSoloSpec = defineSoloGame(caroSolo);
