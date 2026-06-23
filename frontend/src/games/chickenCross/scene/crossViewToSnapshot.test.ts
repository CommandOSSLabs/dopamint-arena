import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SPAWN_COL,
  WIN_LANE,
  laneKind,
} from "../../../../../sui-tunnel-ts/src/protocol/cross.ts";
import { crossViewToSnapshot, initialFeeder } from "./crossViewToSnapshot.ts";
import type { CrossView } from "../session-core.ts";

function view(partial: Partial<CrossView>): CrossView {
  return {
    tick: 0,
    seed: 123,
    players: [
      { lane: 0, col: SPAWN_COL, score: 0 },
      { lane: 0, col: SPAWN_COL, score: 0 },
    ],
    winner: null,
    balanceA: 1000,
    balanceB: 1000,
    ...partial,
  };
}

test("lanes cover 0..WIN_LANE with arena lane kinds", () => {
  const { snapshot } = crossViewToSnapshot(
    view({}),
    null,
    "A",
    initialFeeder(),
  );
  assert.equal(snapshot.world.minLane, 0);
  assert.equal(snapshot.world.maxLane, WIN_LANE);
  assert.equal(snapshot.world.lanes.length, WIN_LANE + 1);
  for (const lane of snapshot.world.lanes) {
    assert.equal(lane.kind, laneKind(lane.index));
  }
});

test("grass lanes carry no hazards; non-grass map kind to mesh kind", () => {
  const { snapshot } = crossViewToSnapshot(
    view({}),
    null,
    "A",
    initialFeeder(),
  );
  const kindOf = { road: "car", water: "log", rails: "train" } as const;
  for (const lane of snapshot.world.lanes) {
    if (lane.kind === "grass") {
      assert.equal(lane.hazards.length, 0);
    } else {
      for (const h of lane.hazards) {
        assert.equal(h.kind, kindOf[lane.kind]);
        assert.equal(h.id, `${lane.index}:${lane.hazards.indexOf(h)}`);
        assert.ok(h.width > 0);
        assert.equal(h.laneIndex, lane.index);
      }
    }
  }
});

test("hazard ids are stable across consecutive ticks", () => {
  const a = crossViewToSnapshot(view({ tick: 5 }), null, "A", initialFeeder());
  const b = crossViewToSnapshot(view({ tick: 6 }), null, "A", initialFeeder());
  const idsAt = (s: typeof a) =>
    s.snapshot.world.lanes.flatMap((l) => l.hazards.map((h) => h.id)).sort();
  assert.deepEqual(idsAt(a), idsAt(b));
});

test("players keep A/B positional identity", () => {
  const v = view({
    players: [
      { lane: 3, col: 2, score: 3 },
      { lane: 1, col: 6, score: 1 },
    ],
  });
  const { snapshot } = crossViewToSnapshot(v, null, "A", initialFeeder());
  assert.equal(snapshot.players[0].id, "A");
  assert.equal(snapshot.players[0].laneIndex, 3);
  assert.equal(snapshot.players[1].id, "B");
  assert.equal(snapshot.players[1].column, 6);
});

test("hop event fires when a player advances a lane", () => {
  const prev = view({
    tick: 1,
    players: [
      { lane: 2, col: 4, score: 2 },
      { lane: 1, col: 4, score: 1 },
    ],
  });
  const next = view({
    tick: 2,
    players: [
      { lane: 3, col: 4, score: 3 },
      { lane: 1, col: 4, score: 1 },
    ],
  });
  const { events } = crossViewToSnapshot(next, prev, "A", initialFeeder());
  assert.equal(events.hop, true);
});

test("death increments deaths, resets facing north, emits splat/splash by lane kind", () => {
  // find a water lane and a road lane to test both branches
  let waterLane = -1,
    roadLane = -1;
  for (let l = 2; l <= WIN_LANE; l++) {
    if (laneKind(l) === "water" && waterLane < 0) waterLane = l;
    if (laneKind(l) === "road" && roadLane < 0) roadLane = l;
  }
  // water death -> splash
  const prevW = view({
    tick: 1,
    players: [
      { lane: waterLane, col: 4, score: waterLane },
      { lane: 0, col: 4, score: 0 },
    ],
  });
  const nextW = view({
    tick: 2,
    players: [
      { lane: 0, col: SPAWN_COL, score: waterLane },
      { lane: 0, col: 4, score: 0 },
    ],
  });
  const rW = crossViewToSnapshot(nextW, prevW, "A", initialFeeder());
  assert.deepEqual(rW.events.deaths, ["splash"]);
  assert.equal(rW.feeder.deaths[0], 1);
  assert.equal(rW.snapshot.players[0].deaths, 1);
  assert.equal(rW.snapshot.players[0].facing, "north");
  // road death -> splat
  const prevR = view({
    tick: 1,
    players: [
      { lane: roadLane, col: 4, score: roadLane },
      { lane: 0, col: 4, score: 0 },
    ],
  });
  const nextR = view({
    tick: 2,
    players: [
      { lane: 0, col: SPAWN_COL, score: roadLane },
      { lane: 0, col: 4, score: 0 },
    ],
  });
  const rR = crossViewToSnapshot(nextR, prevR, "A", initialFeeder());
  assert.deepEqual(rR.events.deaths, ["splat"]);
});

test("facing derives from movement delta", () => {
  const prev = view({
    tick: 1,
    players: [
      { lane: 2, col: 4, score: 2 },
      { lane: 0, col: 4, score: 0 },
    ],
  });
  const east = crossViewToSnapshot(
    view({
      tick: 2,
      players: [
        { lane: 2, col: 5, score: 2 },
        { lane: 0, col: 4, score: 0 },
      ],
    }),
    prev,
    "A",
    initialFeeder(),
  );
  assert.equal(east.snapshot.players[0].facing, "east");
});

test("winner passes through to winnerId", () => {
  const { snapshot } = crossViewToSnapshot(
    view({ winner: "B" }),
    null,
    "A",
    initialFeeder(),
  );
  assert.equal(snapshot.winnerId, "B");
});
