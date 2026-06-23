import {
  createPvpMatchHook,
  type PvpMatch,
  type PvpStatus,
} from "@/pvp/pvpMatchHook";
import type { Role } from "@/pvp/mpClient";
import {
  BombItProtocol,
  type BombItState,
  type BombItMove,
  type BombItAction,
} from "sui-tunnel-ts/protocol/bombIt";
import { deriveView, type BombItView } from "./session-core";
import { makeBombItResumeAdapter } from "./bombItResumeAdapter";

export type { PvpStatus };

/** Bomb It's per-seat input is a single action; the engine wraps it into the acting seat's field. */
const usePvpMatch = createPvpMatchHook<
  BombItState,
  BombItMove,
  BombItAction,
  BombItView
>({
  game: "bomb-it",
  stepMs: 250,
  stake: 500n, // per-seat MIST
  makeProtocol: () => new BombItProtocol(),
  deriveView,
  makeResumeAdapter: makeBombItResumeAdapter,
  idleIntent: "stay",
  intentToMove: (role: Role, action) =>
    role === "A" ? { a: action } : { b: action },
  readIntent: (role: Role, move) => (role === "A" ? move?.a : move?.b),
});

export interface PvpBombIt
  extends Omit<PvpMatch<BombItState, BombItAction, BombItView>, "setIntent"> {
  queueAction: (a: BombItAction) => void;
}

export function usePvpBombIt(windowId: string): PvpBombIt {
  const { setIntent, ...rest } = usePvpMatch(windowId);
  return { ...rest, queueAction: setIntent };
}
