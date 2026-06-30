/**
 * Battleship as a worker SELF-PLAY spec. Both bot seats play against each other using the
 * existing `nextMove` driver (commit-reveal, fleet placement, targeting). One funded tunnel
 * hosts one full game; `stepWith` drives the protocol until a winner emerges.
 *
 * HIDDEN-INFO: each seat's fleet secret stays in the worker (never crosses the bridge);
 * no moveCodec needed because self-play applies moves locally.
 */
import { defineSoloGame } from "@/engine/specs/defineGame";
import type {
  SoloGameSpec,
  SoloMultiGameState,
  SoloStepOutcome,
  SoloTakeIntent,
} from "@/engine/engineApi";
import {
  BattleshipProtocol,
  type BattleshipState,
  type BattleshipMove,
} from "./protocol/battleship";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import {
  randomFleetSecret,
  nextMove,
  type FleetSecret,
} from "./engine/selfPlay";
import { DEFAULT_BOT_DIFFICULTY } from "./engine/bot";

/** State wrapper: the engine reads `inner.winner` (as string) and `gamesPlayed`.
 *  Uses Omit to avoid conflicting with BattleshipState's numeric winner. */
interface BattleshipSoloState {
  gamesPlayed: number;
  maxGames: number;
  inner: Omit<BattleshipState, "winner"> & { winner: "A" | "B" | "draw" | null };
}

interface FleetSecrets {
  A: FleetSecret;
  B: FleetSecret;
}

function makeRng() {
  let seed = Date.now();
  return () => {
    seed = (seed * 1664525 + 1013904223) & 0xffffffff;
    return (seed >>> 0) / 0x100000000;
  };
}

function winnerStr(w: number): "A" | "B" | "draw" | null {
  return w === 1 ? "A" : w === 2 ? "B" : w === 3 ? "draw" : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeSoloProtocol(): any {
  const inner = new BattleshipProtocol();
  return {
    name: "battleship-solo",
    isTerminal: (s: BattleshipSoloState) => inner.isTerminal(s.inner as unknown as BattleshipState),
    initialState: (ctx: any) => ({
      inner: inner.initialState(ctx),
      gamesPlayed: 0,
      maxGames: 1,
    }),
    applyMove: (s: BattleshipSoloState, move: BattleshipMove, by: Party) => ({
      inner: inner.applyMove(s.inner as unknown as BattleshipState, move, by),
      gamesPlayed: s.gamesPlayed,
      maxGames: 1,
    }),
    encodeState: (s: BattleshipSoloState) => inner.encodeState(s.inner as unknown as BattleshipState),
  };
}

export const battleshipSoloSpec = defineSoloGame({
  game: "battleship",
  stake: 1n,
  makeProtocol: makeSoloProtocol,
  makeBots: (): FleetSecrets => {
    const rng = makeRng();
    return { A: randomFleetSecret(rng), B: randomFleetSecret(rng) };
  },
  deriveView: (state: BattleshipSoloState) => state.inner,
  sessionResult: (inner: BattleshipSoloState["inner"]) => inner.winner ?? "draw",
  stepWith: (proto: any, tunnel: any, secrets: FleetSecrets, _take: SoloTakeIntent<never> | null): SoloStepOutcome => {
    const state = tunnel.state as BattleshipSoloState;
    if (proto.isTerminal(state)) return "session-over";
    const rng = makeRng();
    const driven = nextMove(state.inner as unknown as BattleshipState, secrets, rng, DEFAULT_BOT_DIFFICULTY);
    if (!driven) return "session-over";
    tunnel.step(driven.move, driven.by);
    return "stepped";
  },
  kickoffNextGame: () => {},
});
