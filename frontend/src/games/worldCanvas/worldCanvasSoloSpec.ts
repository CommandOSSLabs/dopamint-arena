/**
 * World Canvas as a worker SELF-PLAY spec. Both bot seats paint on a shared canvas; the
 * session runs for a fixed number of rounds (ticks) then settles. Public-state game — no
 * commit-reveal, no moveCodec.
 */
import { defineSoloGame } from "@/engine/specs/defineGame";
import type {
  SoloGameSpec,
  SoloMultiGameState,
  SoloStepOutcome,
  SoloTakeIntent,
} from "@/engine/engineApi";
import {
  WorldCanvasProtocol,
  type WorldCanvasState,
  type WorldCanvasMove,
} from "sui-tunnel-ts/protocol/worldCanvas";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";

interface CanvasSoloState extends SoloMultiGameState {
  maxGames: number;
  inner: WorldCanvasState & { winner: "A" | "B" | "draw" | null; turn: Party };
}

const GRID_SIZE = 20;
const MAX_ROUNDS = 50;

function randomPaintMove(): WorldCanvasMove {
  const cx = 0n;
  const cy = 0n;
  const x = Math.floor(Math.random() * GRID_SIZE);
  const y = Math.floor(Math.random() * GRID_SIZE);
  const color = Math.floor(Math.random() * 6);
  return { cx, cy, x, y, color };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeSoloProtocol(): any {
  const inner = new WorldCanvasProtocol();
  return {
    name: "world-canvas-solo",
    isTerminal: (s: CanvasSoloState) =>
      s.gamesPlayed >= MAX_ROUNDS || inner.isTerminal(s.inner),
    initialState: (ctx: any) => {
      const base = inner.initialState(ctx);
      return {
        inner: { ...base, winner: null, turn: "A" as Party },
        gamesPlayed: 0,
        maxGames: 1,
      };
    },
    applyMove: (s: CanvasSoloState, move: WorldCanvasMove, by: Party) => {
      const next = inner.applyMove(s.inner, move, by);
      const nextTurn: Party = by === "A" ? "B" : "A";
      return {
        inner: { ...next, winner: null, turn: nextTurn },
        gamesPlayed: s.gamesPlayed + (inner.isTerminal(next) ? 1 : 0),
        maxGames: 1,
      };
    },
    encodeState: (s: CanvasSoloState) => inner.encodeState(s.inner),
  };
}

export const worldCanvasSoloSpec = defineSoloGame({
  game: "world-canvas",
  stake: 1n,
  makeProtocol: makeSoloProtocol,
  makeBots: () => ({}),
  deriveView: (state: CanvasSoloState) => state.inner,
  sessionResult: (inner: CanvasSoloState["inner"]) => inner.winner ?? ("draw" as const),
  stepWith: (_proto: any, tunnel: any, _bots: unknown, take: SoloTakeIntent<WorldCanvasMove> | null): SoloStepOutcome => {
    const state = tunnel.state as CanvasSoloState;
    if (state.inner.winner !== null || state.gamesPlayed >= MAX_ROUNDS) return "session-over";
    const by: Party = state.inner.turn ?? "A";
    const move = take?.() ?? randomPaintMove();
    tunnel.step(move, by);
    return "stepped";
  },
  kickoffNextGame: () => {},
});
