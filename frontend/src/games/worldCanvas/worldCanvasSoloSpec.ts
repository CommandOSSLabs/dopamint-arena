/**
 * World Canvas as a worker SELF-PLAY spec — the RICH wall, not a placeholder grid.
 *
 * Runs self-play over the PvP protocol ({@link WorldCanvasPvpProtocol}) so the worker emits the
 * SAME ordered `PvpCell[]` render stream the online-PvP board already renders: global-pixel cells
 * with a painter seat + monotonic seq. Both seats are bot-driven (the protocol's `randomMove` walks
 * a flowing stroke per co-sign); when the player takes the wheel (Auto off) a queued seat-A run is
 * co-signed instead of the seat-A bot's paint. Free/draw — balances never shift — so the funded
 * bank stays tiny (1/seat) and the wall is effectively endless (settle on demand via settleNow).
 *
 * The rich renderer ({@link ./ui/WorldCanvas WorldCanvas}) is fed from this view by
 * {@link ./ui/SoloCanvasView SoloCanvasView}; the old bare 20×20 grid is gone.
 */
import { defineSoloGame } from "@/engine/specs/defineGame";
import type {
  SoloMultiGameState,
  SoloStepOutcome,
  SoloTakeIntent,
} from "@/engine/engineApi";
import {
  WorldCanvasPvpProtocol,
  type PvpCanvasState,
  type PvpPaintMove,
} from "sui-tunnel-ts/protocol/worldCanvasPvp";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";

/** Meta-state: the PvP protocol's canvas state under `inner` (so the SoloEngine can read
 *  `inner.winner`, always null here), plus the multi-duel bookkeeping the engine expects and a
 *  turn cursor that alternates the two bot seats for a visually balanced wall. */
interface CanvasSoloState extends SoloMultiGameState {
  maxGames: number;
  turn: Party;
  inner: PvpCanvasState;
}

/** Stateless — reused for both the wrapped protocol and the bot move generator (all state rides
 *  in the passed-in `PvpCanvasState`, so one shared instance is safe). */
const pvpProto = new WorldCanvasPvpProtocol();

/* eslint-disable @typescript-eslint/no-explicit-any */
function makeSoloProtocol(): any {
  return {
    name: "world-canvas-solo",
    // Endless collaborative wall — close on demand (settleNow), never auto-terminal.
    isTerminal: () => false,
    initialState: (ctx: any): CanvasSoloState => ({
      inner: pvpProto.initialState(ctx),
      gamesPlayed: 0,
      maxGames: 1,
      turn: "A",
    }),
    applyMove: (
      s: CanvasSoloState,
      move: PvpPaintMove,
      by: Party,
    ): CanvasSoloState => ({
      inner: pvpProto.applyMove(s.inner, move, by),
      gamesPlayed: s.gamesPlayed,
      maxGames: 1,
      turn: by === "A" ? "B" : "A",
    }),
    encodeState: (s: CanvasSoloState) => pvpProto.encodeState(s.inner),
    // OffchainTunnel.selfPlay reads balances on every co-sign + at settle.
    balances: (s: CanvasSoloState) => pvpProto.balances(s.inner),
  };
}

export const worldCanvasSoloSpec = defineSoloGame({
  game: "world-canvas",
  stake: 1n,
  // Free/draw (money-neutral), so a tiny bank keeps the open cheap (~PvP parity), not 100/seat.
  lockedPerSeat: 1n,
  makeProtocol: makeSoloProtocol,
  makeBots: () => ({}),
  deriveView: (state: CanvasSoloState) => state.inner.cells,
  sessionResult: () => "draw" as const,
  stepWith: (
    _proto: any,
    tunnel: any,
    _bots: unknown,
    take: SoloTakeIntent<PvpPaintMove> | null,
  ): SoloStepOutcome => {
    const state = tunnel.state as CanvasSoloState;
    const by: Party = state.turn;
    // Take-the-wheel: in manual mode (take != null), on seat A's turn co-sign the player's queued
    // run if present, else an idle tick (you hold seat A — it paints nothing). Pull the intent only
    // on A's turn so it is never applied to B or silently discarded. Every other case is bot paint.
    if (take && by === "A") {
      const human = take();
      tunnel.step(human ?? { cells: [] }, by);
      return "stepped";
    }
    tunnel.step(pvpProto.randomMove(state.inner, by, Math.random), by);
    return "stepped";
  },
  kickoffNextGame: () => {},
});
