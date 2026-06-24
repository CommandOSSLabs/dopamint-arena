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
  createSoloSessionHook,
  type SoloSession,
  type SessionStatus,
} from "../_shared/soloSessionHook";
import {
  deriveMultiView,
  kickoffNextGame,
  sessionResult,
  stepMultiGame,
  type CrossView,
  type SessionResult,
} from "./session-core";

export type { SessionStatus };

type CrossBots = Record<
  Party,
  GameBot<MultiGameCrossState, MultiGameCrossMove>
>;

/** Chicken Cross's per-seat input is a hop direction; the loop wraps it into the take-over seat's field. */
const useSoloSession = createSoloSessionHook<
  MultiGameCrossState,
  CrossMove,
  CrossDir,
  CrossView,
  SessionResult,
  MultiGameCrossProtocol,
  CrossBots
>({
  game: "chicken-cross",
  settleLabel: "chickenCross",
  minStake: MIN_STAKE,
  participants: ["chicken-a", "chicken-b"],
  rematchMs: 600,
  // No manualStepMs: chicken-cross is a throughput showcase, so manual play batches at the autopilot
  // rate too (the per-tick intent is read once, the rest of the frame holds position).
  usesAddressBalance: true, // ADR-0013: stake from the player's MTPS address balance.
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
  stepWith: (protocol, tunnel, bots, take) =>
    stepMultiGame(
      protocol,
      tunnel,
      bots,
      take ? { seat: "A", getDir: () => take() } : null,
    ),
  kickoffNextGame,
});

export interface ChickenCrossSession extends Omit<
  SoloSession<CrossDir, CrossView, SessionResult>,
  "queueIntent"
> {
  /** Queue your chicken's next hop direction for the next manual tick (consumed once). */
  setDir: (dir: CrossDir) => void;
}

export function useChickenCrossSession(windowId: string): ChickenCrossSession {
  const { queueIntent, ...rest } = useSoloSession(windowId);
  return { ...rest, setDir: queueIntent };
}
