import {
  MultiGameBombItProtocol,
  type MultiGameBombItState,
  type MultiGameBombItMove,
} from "sui-tunnel-ts/protocol/multiGameBombIt";
import { BOMB_IT_MIN_STAKE } from "sui-tunnel-ts/protocol/bombIt";
import type { BombItMove, BombItAction } from "sui-tunnel-ts/protocol/bombIt";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import { createBombItKit } from "@/agent/games/bombIt/kit";
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
  SOLO_STEP_MS,
  type BombItView,
  type BombItResult,
} from "./session-core";

export type { SessionStatus };

type BombBots = Record<
  Party,
  GameBot<MultiGameBombItState, MultiGameBombItMove>
>;

/** Bomb It's per-seat input is a single action; the loop wraps it into the take-over seat's field. */
const useSoloSession = createSoloSessionHook<
  MultiGameBombItState,
  BombItMove,
  BombItAction,
  BombItView,
  BombItResult,
  MultiGameBombItProtocol,
  BombBots
>({
  game: "bomb-it",
  settleLabel: "bombIt",
  minStake: BOMB_IT_MIN_STAKE,
  participants: ["bomber-a", "bomber-b"],
  rematchMs: 700,
  usesAddressBalance: true, // ADR-0013: stake from the player's MTPS address balance.
  // Bomb It is a REACTION game: manual play co-signs one tick per SOLO_STEP_MS so the fuse stays
  // legible (fuse ≈ FUSE_TICKS * SOLO_STEP_MS ≈ 1s); at the batched autopilot rate it would burn in
  // ~50ms, unplayable by hand. Autopilot still batches — the ~500 TPS throughput benchmark.
  manualStepMs: SOLO_STEP_MS,
  makeProtocol: (tunnelId, stakePerGame) =>
    new MultiGameBombItProtocol(tunnelId, stakePerGame),
  makeBots: (stakePerGame) => {
    const kit = createBombItKit(stakePerGame);
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
      take ? { seat: "A", getAction: () => take() ?? "stay" } : null,
    ),
  kickoffNextGame,
});

export interface BombItSession extends Omit<
  SoloSession<BombItAction, BombItView, BombItResult>,
  "queueIntent"
> {
  /** Queue your seat-A action for the next manual tick (consumed once). */
  queueAction: (a: BombItAction) => void;
}

export function useBombItSession(windowId: string): BombItSession {
  const { queueIntent, ...rest } = useSoloSession(windowId);
  return { ...rest, queueAction: queueIntent };
}
