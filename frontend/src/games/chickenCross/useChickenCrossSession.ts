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
import { engineEnabled } from "@/engine/flag";
import { engineClient } from "@/engine/engineClient";
import { useGameSolo } from "@/engine/react/useGameSolo";
import type { MatchSnapshot } from "@/engine/engineApi";

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

/** Main-thread path (default): the out-of-React self-play session on the main thread. */
function useLegacyChickenCrossSession(windowId: string): ChickenCrossSession {
  const { queueIntent, ...rest } = useSoloSession(windowId);
  return { ...rest, setDir: queueIntent };
}

/** Worker path (`?engine=worker`): the funded tunnel + per-duel loop run in a dedicated Web Worker
 *  (`SoloEngine`); this hook only renders snapshots and forwards commands via `engineClient`. */
function useWorkerChickenCrossSession(windowId: string): ChickenCrossSession {
  const snap = useGameSolo(windowId) as MatchSnapshot<CrossView>;
  // The solo lane never emits "matching" (a PvP-only state); fold it into "funding" so the status
  // narrows to the legacy `SessionStatus` the window/board expect.
  const status: SessionStatus =
    snap.status === "matching" ? "funding" : snap.status;
  return {
    status,
    view: snap.view,
    result: (snap.result ?? null) as SessionResult | null,
    stake: snap.stake,
    error: snap.error,
    auto: snap.auto,
    score: snap.score ?? { you: 0, foe: 0 },
    gamesPlayed: snap.gamesPlayed ?? 0,
    start: (stake) => engineClient.findSolo(windowId, "chicken-cross", stake),
    reset: () => engineClient.reset(windowId),
    setDir: (dir) => engineClient.submitInput(windowId, dir),
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
export const useChickenCrossSession: (windowId: string) => ChickenCrossSession =
  engineEnabled() ? useWorkerChickenCrossSession : useLegacyChickenCrossSession;
