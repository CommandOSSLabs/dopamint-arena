/**
 * Tic-Tac-Toe as a worker SELF-PLAY spec (the solo-lane sibling of `usePvpTicTacToe`'s PvP path,
 * and the worker port of its bot-vs-bot mode). Reuses ttt's canonical pieces verbatim:
 * `MultiGameTicTacToeProtocol` for the rules and `createTicTacToeKit`'s bots — no game logic is
 * reimplemented. The generic `SoloEngine` owns the rest (the one-signature open+fund of both
 * ephemeral seats, the `OffchainTunnel.selfPlay` loop, the autopilot/manual cadence, multi-duel
 * rematch, transcript, and cooperative settle).
 *
 * WRAPPER: `SoloMultiGameState` requires `inner.winner` as "A"|"B"|"draw"|null, but the SDK ttt
 * protocol encodes it as 0|1|2|3. {@link SoloTicTacToeProtocol} converts at the boundary (engine
 * sees strings) while delegating EVERY rule to the inner numeric protocol — `encodeState` /
 * `balances` / `isTerminal` run on the numeric form so the co-signed state hash and on-chain
 * settle bytes are identical to the canonical protocol. No moveCodec: ttt has no hidden secret.
 */
import { defineSoloGame } from "@/engine/specs/defineGame";
import type { SoloGameSpec } from "@/engine/engineApi";
import {
  MultiGameTicTacToeProtocol,
  type MultiGameTicTacToeState,
  type MultiGameTicTacToeMove,
} from "@ttt/shared/ttt/multiGameProtocol";
import type {
  Party,
  ProtocolContext,
  Balances,
} from "sui-tunnel-ts/protocol/Protocol";
import { createTicTacToeKit } from "@/agent/games/ticTacToe/kit";
import type { GameBot } from "@/agent/gameKit";
import {
  toSolo,
  toRaw,
  deriveTttView,
  tttSessionResult,
  stepMultiGameTtt,
  kickoffNextGameTtt,
  type SoloTttState,
  type TttView,
  type TttResult,
} from "./tttSoloCore";

/** Games per funded tunnel: a high cap so the natural terminal is bank exhaustion (a side can no
 *  longer cover the per-game stake), amortizing one settle across many duels — the TPS showcase. */
export const TTT_GAMES_PER_TUNNEL = 1000;
/** Per-game stake (the small swap); mirrors the PvP `STAKE`. The large per-seat bank the engine
 *  funds (1 MTPS) survives many games. */
export const TTT_STAKE = 1n;
/** Turn-based: manual play co-signs one tick per this many ms so a takeover move is readable. */
export const TTT_MANUAL_STEP_MS = 400;
/** Per-game beat so the result + score register before the next game (ms). */
export const TTT_REMATCH_MS = 500;

export type TttBots = Record<
  Party,
  GameBot<MultiGameTicTacToeState, MultiGameTicTacToeMove>
>;

/** Build the per-seat kit bots for a stake — shared by the worker spec and the legacy session hook
 *  so both lanes drive identical bot behaviour (the kit is the single source of bot moves). */
export function makeTttBots(stakePerGame: bigint): TttBots {
  const kit = createTicTacToeKit(TTT_GAMES_PER_TUNNEL, stakePerGame, {
    difficulty: "fast",
  });
  return {
    A: kit.createBot("A", { rngForSeat: () => Math.random }),
    B: kit.createBot("B", { rngForSeat: () => Math.random }),
  };
}

/**
 * `MultiGameTicTacToeProtocol` widened so `inner.winner` is the engine's "A"|"B"|"draw"|null. It
 * reimplements NO rules — every method delegates to the inner numeric protocol via `toRaw`/`toSolo`,
 * so the state hash + settleable balances match the plain protocol exactly.
 */
export class SoloTicTacToeProtocol {
  readonly name = "tic_tac_toe.multi.v1";
  private readonly mg: MultiGameTicTacToeProtocol;

  constructor(maxGames: number, stake: bigint) {
    this.mg = new MultiGameTicTacToeProtocol(maxGames, stake);
  }

  initialState(ctx: ProtocolContext): SoloTttState {
    return toSolo(this.mg.initialState(ctx));
  }
  applyMove(
    state: SoloTttState,
    move: MultiGameTicTacToeMove,
    by: Party,
  ): SoloTttState {
    return toSolo(this.mg.applyMove(toRaw(state), move, by));
  }
  encodeState(state: SoloTttState): Uint8Array {
    return this.mg.encodeState(toRaw(state));
  }
  balances(state: SoloTttState): Balances {
    return this.mg.balances(toRaw(state));
  }
  isTerminal(state: SoloTttState): boolean {
    return this.mg.isTerminal(toRaw(state));
  }
  randomMove(
    state: SoloTttState,
    by: Party,
    rng: () => number,
  ): MultiGameTicTacToeMove | null {
    return this.mg.randomMove(toRaw(state), by, rng);
  }
}

// Annotated as the interface (not the object literal) so `defineSoloGame`'s `S extends AnySoloSpec`
// constraint checks method signatures bivariantly (matches `quantumPokerSoloSpec`'s rationale).
const ticTacToeSolo: SoloGameSpec<
  SoloTttState,
  MultiGameTicTacToeMove,
  number,
  TttView,
  TttResult,
  TttBots,
  SoloTicTacToeProtocol
> = {
  game: "tictactoe",
  stake: TTT_STAKE,
  rematchMs: TTT_REMATCH_MS,
  manualStepMs: TTT_MANUAL_STEP_MS,
  makeProtocol: (_tunnelId, stakePerGame) =>
    new SoloTicTacToeProtocol(TTT_GAMES_PER_TUNNEL, stakePerGame),
  makeBots: makeTttBots,
  deriveView: deriveTttView,
  sessionResult: tttSessionResult,
  // One co-signed tick per call (engine batches in autopilot, paces in manual). The take-over seat
  // is always seat A; its queued cell drives A's move, else A's bot fills in.
  stepWith: (protocol, tunnel, bots, take) =>
    stepMultiGameTtt(
      protocol,
      tunnel,
      bots,
      take ? { seat: "A", getCell: () => take() } : null,
    ),
  kickoffNextGame: kickoffNextGameTtt,
};

export const tttSoloSpec = defineSoloGame(ticTacToeSolo);
