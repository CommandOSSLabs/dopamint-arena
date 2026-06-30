import {
  createPvpMatchHook,
  type PvpMatch,
  type PvpStatus,
} from "@/pvp/pvpMatchHook";
import type { Role } from "@/pvp/mpClient";
import {
  CrossProtocol,
  type CrossState,
  type CrossMove,
  type CrossDir,
} from "sui-tunnel-ts/protocol/cross";
import { deriveView, type CrossView } from "./session-core";
import { makeCrossResumeAdapter } from "./crossResumeAdapter";
import { engineEnabled } from "@/engine/flag";
import { engineClient } from "@/engine/engineClient";
import { useGameMatch } from "@/engine/react/useGameMatch";
import type { MatchSnapshot } from "@/engine/engineApi";

export type { PvpStatus };

export interface PvpChickenCross extends Omit<
  PvpMatch<CrossState, CrossDir | undefined, CrossView>,
  "setIntent"
> {
  setDir: (dir: CrossDir) => void;
}

/** Main-thread path (default): per-seat input is a hop direction wrapped into the acting seat's field. */
const useLegacyMatch = createPvpMatchHook<
  CrossState,
  CrossMove,
  CrossDir | undefined,
  CrossView
>({
  game: "chicken-cross",
  stepMs: 300,
  stake: 10n, // per-seat MTPS (must match chickenCrossSpec.ts)
  makeProtocol: () => new CrossProtocol(),
  deriveView,
  makeResumeAdapter: makeCrossResumeAdapter,
  idleIntent: undefined,
  intentToMove: (role: Role, dir) =>
    role === "A" ? { dirA: dir } : { dirB: dir },
  readIntent: (role: Role, move) => (role === "A" ? move?.dirA : move?.dirB),
});

function useLegacyChickenCross(windowId: string): PvpChickenCross {
  const { setIntent, ...rest } = useLegacyMatch(windowId);
  return { ...rest, setDir: setIntent };
}

/** Worker path (`?engine=worker`): the tunnel client runs in a dedicated Web Worker. */
function useWorkerChickenCross(windowId: string): PvpChickenCross {
  const snap = useGameMatch(windowId, "chicken-cross") as MatchSnapshot<
    CrossView,
    CrossState["winner"]
  >;
  return {
    status: snap.status,
    role: snap.role,
    stake: snap.stake,
    auto: snap.auto,
    view: snap.view,
    winner: snap.winner,
    error: snap.error,
    findMatch: () => engineClient.findMatch(windowId, "chicken-cross"),
    toggleAuto: () => engineClient.setAuto(windowId, !snap.auto),
    reset: () => engineClient.reset(windowId),
    setDir: (dir) => engineClient.submitInput(windowId, dir),
  };
}

/** `?engine=worker` selects the worker path; default keeps the main-thread path. Bound once
 *  at module load so the hook identity is stable per session (rules-of-hooks). */
export const usePvpChickenCross: (windowId: string) => PvpChickenCross =
  engineEnabled() ? useWorkerChickenCross : useLegacyChickenCross;
