import type { CrossView } from "../session-core.ts";
import {
  COLUMN_COUNT,
  SPAWN_COL,
  WIN_LANE,
  hazardsAt,
  laneKind,
} from "../../../../../sui-tunnel-ts/src/protocol/cross.ts";
import type {
  CrossDirection,
  CrossHazardSnapshot,
  CrossLaneSnapshot,
  CrossPlayerState,
  CrossSnapshot,
} from "./crossSceneTypes.ts";

/** Running state the adapter threads across ticks (held by CrossCanvas in a ref). */
export type FeederState = {
  deaths: [number, number];
  facing: [CrossDirection, CrossDirection];
};

/** Sounds whose trigger is a CrossView-to-CrossView transition (others come from props/mount). */
export type SoundEvents = { hop: boolean; deaths: Array<"splat" | "splash"> };

export const initialFeeder = (): FeederState => ({
  deaths: [0, 0],
  facing: ["north", "north"],
});

const HAZARD_KIND: Record<"road" | "water" | "rails", "car" | "log" | "train"> = {
  road: "car",
  water: "log",
  rails: "train",
};

/** Smallest signed delta on the wrapped column ring, so a mod-wrap reads as ~0-ish, not full width. */
function ringDelta(from: number, to: number): number {
  let d = to - from;
  if (d > COLUMN_COUNT / 2) d -= COLUMN_COUNT;
  if (d < -COLUMN_COUNT / 2) d += COLUMN_COUNT;
  return d;
}

function lanesFor(seed: number, tick: number): CrossLaneSnapshot[] {
  const lanes: CrossLaneSnapshot[] = [];
  for (let L = 0; L <= WIN_LANE; L++) {
    const kind = laneKind(L);
    let hazards: CrossHazardSnapshot[] = [];
    if (kind !== "grass") {
      const now = hazardsAt(BigInt(seed), L, BigInt(tick));
      const next = hazardsAt(BigInt(seed), L, BigInt(tick + 1));
      hazards = now.map((span, i) => ({
        id: `${L}:${i}`,
        laneIndex: L,
        x: span.center,
        width: span.half * 2,
        // direction is private to hazardsAt; recover its sign from the next tick (orientation only).
        vx: Math.sign(ringDelta(span.center, next[i]?.center ?? span.center)),
        kind: HAZARD_KIND[kind],
      }));
    }
    lanes.push({ index: L, kind, hazards });
  }
  return lanes;
}

function facingFromDelta(
  prevLane: number,
  prevCol: number,
  lane: number,
  col: number,
  last: CrossDirection,
): CrossDirection {
  if (lane > prevLane) return "north";
  if (lane < prevLane) return "south";
  if (col > prevCol) return "east";
  if (col < prevCol) return "west";
  return last;
}

/**
 * Pure map from the arena's flat CrossView to the scene's CrossSnapshot.
 * `prev` is the previous view (null on first tick); `feeder` carries running
 * death counts and last facing. Returns the next feeder and the sound events
 * implied by the transition. Never mutates its inputs.
 */
export function crossViewToSnapshot(
  view: CrossView,
  prev: CrossView | null,
  _role: "A" | "B" | null,
  feeder: FeederState,
): { snapshot: CrossSnapshot; feeder: FeederState; events: SoundEvents } {
  const ids = ["A", "B"] as const;
  const deaths: [number, number] = [feeder.deaths[0], feeder.deaths[1]];
  const facing: [CrossDirection, CrossDirection] = [feeder.facing[0], feeder.facing[1]];
  const events: SoundEvents = { hop: false, deaths: [] };

  const players: CrossPlayerState[] = view.players.map((p, i) => {
    const pv = prev?.players[i];
    if (pv) {
      const died = pv.lane > 0 && p.lane === 0 && p.col === SPAWN_COL;
      if (died) {
        deaths[i] += 1;
        facing[i] = "north";
        events.deaths.push(laneKind(pv.lane) === "water" ? "splash" : "splat");
      } else {
        facing[i] = facingFromDelta(pv.lane, pv.col, p.lane, p.col, facing[i]);
        if (p.lane > pv.lane) events.hop = true;
      }
    }
    return {
      id: ids[i],
      name: ids[i],
      column: p.col,
      laneIndex: p.lane,
      score: p.score,
      deaths: deaths[i],
      alive: true,
      connected: true,
      facing: facing[i],
    };
  });

  const snapshot: CrossSnapshot = {
    type: "cross:snapshot",
    protocol: 1,
    roomCode: "",
    phase: "playing",
    serverTime: view.tick,
    world: { minLane: 0, maxLane: WIN_LANE, lanes: lanesFor(view.seed, view.tick) },
    players,
    winnerId: view.winner,
  };

  return { snapshot, feeder: { deaths, facing }, events };
}
