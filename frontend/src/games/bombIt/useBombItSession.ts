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
import { engineEnabled } from "@/engine/flag";
import { engineClient } from "@/engine/engineClient";
import { useGameSolo } from "@/engine/react/useGameSolo";
import type { MatchSnapshot } from "@/engine/engineApi";

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

/** Main-thread path (default): the out-of-React self-play session on the main thread. */
function useLegacyBombItSession(windowId: string): BombItSession {
  const { queueIntent, ...rest } = useSoloSession(windowId);
  return { ...rest, queueAction: queueIntent };
}

/** Worker path (`?engine=worker`): the funded tunnel + per-duel loop run in a dedicated Web Worker
 *  (`SoloEngine`); this hook only renders snapshots and forwards commands via `engineClient`. */
function useWorkerBombItSession(windowId: string): BombItSession {
  const snap = useGameSolo(windowId) as MatchSnapshot<BombItView>;
  // The solo lane never emits "matching" (a PvP-only state); fold it into "funding" so the status
  // narrows to the legacy `SessionStatus` the window/board expect.
  const status: SessionStatus =
    snap.status === "matching" ? "funding" : snap.status;
  return {
    status,
    view: snap.view,
    result: (snap.result ?? null) as BombItResult | null,
    stake: snap.stake,
    error: snap.error,
    auto: snap.auto,
    score: snap.score ?? { you: 0, foe: 0 },
    gamesPlayed: snap.gamesPlayed ?? 0,
    start: (stake) => engineClient.findSolo(windowId, "bomb-it", stake),
    reset: () => engineClient.reset(windowId),
    queueAction: (a) => engineClient.submitInput(windowId, a),
    toggleAuto: () => engineClient.setAuto(windowId, !snap.auto),
    // On-demand cash-out: close the funded tunnel now at the current co-signed state (same settle
    // path the engine runs at bank exhaustion), so the cash-out button works under the worker flag.
    settleNow: () => engineClient.settleSolo(windowId),
    // Cabinet hover-freeze pauses BOTH the self-play loop and its snapshot flush in the worker, so
    // the bank stops draining while hovered (independent of the tab-visibility driver in useGameSolo).
    pause: () => engineClient.setPaused(windowId, true),
    resume: () => engineClient.setPaused(windowId, false),
  };
}

/** `?engine=worker` selects the worker path; default keeps the main-thread path unchanged. Bound
 *  once at module load so the hook identity is stable per session (rules-of-hooks). */
export const useBombItSession: (windowId: string) => BombItSession =
  engineEnabled() ? useWorkerBombItSession : useLegacyBombItSession;
