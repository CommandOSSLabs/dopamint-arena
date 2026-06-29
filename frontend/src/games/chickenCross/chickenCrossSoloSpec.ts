/**
 * Chicken Cross as a worker SELF-PLAY spec (the solo-lane sibling of `chickenCrossSpec.ts`, parallel
 * to the legacy `useChickenCrossSession`'s `createSoloSessionHook` declaration). Reuses chicken-cross's
 * existing PURE multi-game logic from `session-core.ts` (deriveMultiView / sessionResult /
 * stepMultiGame / kickoffNextGame) and the canonical kit bots — no game rules are reimplemented here.
 * The generic `SoloEngine` owns the rest: the one-signature open+fund of both ephemeral seats, the
 * per-duel `OffchainTunnel.selfPlay` loop, the autopilot/manual cadence, multi-duel rematch, and the
 * cooperative settle.
 */
import { defineSoloGame } from "@/engine/specs/defineGame";
import type { SoloGameSpec } from "@/engine/engineApi";
import {
  MultiGameCrossProtocol,
  type MultiGameCrossState,
  type MultiGameCrossMove,
} from "sui-tunnel-ts/protocol/multiGameCross";
import { MIN_STAKE } from "sui-tunnel-ts/protocol/cross";
import type { CrossMove, CrossDir } from "sui-tunnel-ts/protocol/cross";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import { createChickenCrossKit } from "@/agent/games/chickenCross/kit";
import type { GameBot } from "@/agent/gameKit";
import {
  deriveMultiView,
  kickoffNextGame,
  sessionResult,
  stepMultiGame,
  type CrossView,
  type SessionResult,
} from "./session-core";

/** Per-seat kit bots threaded into `stepWith`; opaque to the engine (same shape the legacy hook uses). */
type CrossBots = Record<
  Party,
  GameBot<MultiGameCrossState, MultiGameCrossMove>
>;

// Annotated as the interface (not the object literal) so `defineSoloGame`'s `S extends AnySoloSpec`
// constraint is checked against method signatures (bivariant) rather than the literal's arrow-property
// signatures (contravariant), which would reject the narrowed `Bots`/`Proto` generics.
const chickenCrossSolo: SoloGameSpec<
  MultiGameCrossState,
  CrossMove,
  CrossDir,
  CrossView,
  SessionResult,
  CrossBots,
  MultiGameCrossProtocol
> = {
  game: "chicken-cross",
  stake: MIN_STAKE, // per-DUEL stake (the small swap); the engine funds the large per-seat bank
  rematchMs: 600,
  // No manualStepMs: chicken-cross is a throughput showcase, so manual play batches at the autopilot
  // rate too (the per-tick hop is read once, the rest of the frame holds position).
  makeProtocol: (tunnelId, stakePerGame) =>
    new MultiGameCrossProtocol(tunnelId, stakePerGame),
  makeBots: (stakePerGame) => {
    const kit = createChickenCrossKit(stakePerGame);
    return {
      A: kit.createBot("A", { rngForSeat: () => Math.random }),
      B: kit.createBot("B", { rngForSeat: () => Math.random }),
    };
  },
  deriveView: deriveMultiView,
  sessionResult,
  // The take-over seat is always seat A; its queued hop direction defaults to `undefined` (no hop
  // this tick — a legal stay), supplied each tick from the player's queued intent.
  stepWith: (protocol, tunnel, bots, take) =>
    stepMultiGame(
      protocol,
      tunnel,
      bots,
      take ? { seat: "A", getDir: () => take() } : null,
    ),
  kickoffNextGame,
};

export const chickenCrossSoloSpec = defineSoloGame(chickenCrossSolo);
