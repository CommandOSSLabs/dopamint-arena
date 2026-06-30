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

export type { PvpStatus };

/** Backend arena/`profile_for` id (underscore form of the registry id). Single source of truth for
 *  both the engine's arena consumer (the spec below) and `GameModule.arenaGameId` (index.ts). */
export const CHICKEN_CROSS_ARENA_GAME_ID = "chicken_cross";

/** Chicken Cross's per-seat input is a hop direction; the engine wraps it into the acting seat's field. */
const usePvpMatch = createPvpMatchHook<
  CrossState,
  CrossMove,
  CrossDir | undefined,
  CrossView
>({
  game: "chicken-cross",
  arenaGameId: CHICKEN_CROSS_ARENA_GAME_ID,
  stepMs: 300,
  stake: 500n, // per-seat MIST
  makeProtocol: () => new CrossProtocol(),
  deriveView,
  makeResumeAdapter: makeCrossResumeAdapter,
  idleIntent: undefined,
  intentToMove: (role: Role, dir) =>
    role === "A" ? { dirA: dir } : { dirB: dir },
  readIntent: (role: Role, move) => (role === "A" ? move?.dirA : move?.dirB),
});

export interface PvpChickenCross extends Omit<
  PvpMatch<CrossState, CrossDir | undefined, CrossView>,
  "setIntent"
> {
  setDir: (dir: CrossDir) => void;
}

export function usePvpChickenCross(windowId: string): PvpChickenCross {
  const { setIntent, ...rest } = usePvpMatch(windowId);
  return { ...rest, setDir: setIntent };
}
