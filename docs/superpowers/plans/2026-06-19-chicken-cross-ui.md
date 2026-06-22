# Chicken Cross original-look UI port — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the arena Chicken Cross emoji-grid renderer with the original game's low-poly Three.js scene, fed by a pure `CrossView → snapshot` adapter, fluid at any size, with the original's 6 sounds.

**Architecture:** A pure adapter converts the arena's flat `CrossView` into the scene's `CrossSnapshot`; the ported `CrossScene` (procedural geometry, no asset files) renders it; a `CrossCanvas` React component owns the canvas lifecycle (RAF, ResizeObserver, sounds, full teardown). `CrossBoard` keeps its exact props so nothing above it changes.

**Tech Stack:** React + Vite + TypeScript (pnpm), Three.js `^0.184`, `node:test` via `tsx`.

## Global Constraints

- **Presentation-only.** No edits to `CrossView`, `deriveView`/`stepSession`/`sessionResult`, the two hooks, `sui-tunnel-ts`, backend, or Move.
- **`CrossBoard` prop signature stays identical:** `{ view:CrossView; winner:"A"|"B"|null; role:"A"|"B"|null; onDir:(d:CrossDir)=>void; onPlayAgain:()=>void; seed:number }`.
- **`setDir` stays a thin write** (auto-forward, default `"north"`, resets after each propose). Input must not debounce/batch/hold it.
- **`STEP_MS=300`** untouched (protocol pacing).
- Geometry SSoT imported, never re-hardcoded: `hazardsAt`, `laneKind`, `COLUMN_COUNT=9`, `SPAWN_COL=4`, `WIN_LANE=20` from `sui-tunnel-ts/src/protocol/cross.ts`.
- Terminal/win decisions come from the hook (`winner` prop), never re-derived from `view`.
- Commits: Conventional Commits, subject ≤50 chars, imperative, lowercase after type, **no AI attribution**.
- Gate after each code task where it applies: `cd frontend && pnpm typecheck && pnpm build` stays green.
- Repo root for all paths below: `/Users/realestzan/Projects/code/dopamint-arena/.worktrees/chicken-cross-ui`.
- Original game source (read-only, for copying): `/Users/realestzan/Projects/code/dopamint/games/chicken-cross`.

## File map

```
frontend/
  public/sounds/                         NEW  hop|splat|splash|win|room-join|click .mp3
  package.json                           EDIT add three + @types/three
  src/games/chickenCross/
    scene/
      crossSceneTypes.ts                 NEW  scene wire types (decoupled from OG repo)
      crossSounds.ts                     NEW  tiny Audio wrapper (silent-on-missing)
      crossViewToSnapshot.ts             NEW  pure adapter + sound-event derivation
      crossViewToSnapshot.test.ts        NEW  node:test
      crossInput.ts                      NEW  pure key/swipe → screen dir (+ canvas binding)
      crossInput.test.ts                 NEW  node:test
      CrossScene.ts                      PORT from OG + scoped resize + full dispose
      facing.ts                          PORT from OG
      screenInput.ts                     PORT from OG screen-input.ts
    components/
      CrossCanvas.tsx                    NEW  canvas + scene lifecycle + D-pad overlay
      CrossBoard.tsx                     EDIT shell: HUD header + <CrossCanvas/> + result overlay
      CrossLobby.tsx                     EDIT click sound on create/join
    cross.css                            EDIT drop 9-col grid; keep HUD/overlay/D-pad chrome
```

---

### Task 1: Dependencies, sound assets, and sound module

**Files:**
- Modify: `frontend/package.json`
- Create: `frontend/public/sounds/{hop,splat,splash,win,room-join,click}.mp3`
- Create: `frontend/src/games/chickenCross/scene/crossSounds.ts`

**Interfaces:**
- Produces: `class CrossSounds { play(name: CrossSoundName): void; setMuted(b:boolean): void }`, `type CrossSoundName = "hop"|"splat"|"splash"|"win"|"room-join"|"click"`.

- [ ] **Step 1: Add Three.js dependency**

Run:
```bash
cd frontend && pnpm add three@^0.184.0 && pnpm add -D @types/three@^0.184.1
```
Expected: `package.json` gains `three` (deps) and `@types/three` (devDeps); `pnpm-lock.yaml` updates.

- [ ] **Step 2: Copy the 6 sound files**

Run:
```bash
mkdir -p frontend/public/sounds
SRC=/Users/realestzan/Projects/code/dopamint/games/chicken-cross/ui/public/sounds
cp "$SRC/hop.mp3" "$SRC/splat.mp3" "$SRC/splash.mp3" "$SRC/win.mp3" "$SRC/room-join.mp3" "$SRC/click.mp3" frontend/public/sounds/
ls -1 frontend/public/sounds
```
Expected: 6 files listed. (Original `toast.mp3` is intentionally absent — unused.)

- [ ] **Step 3: Write `crossSounds.ts`**

```ts
export type CrossSoundName = "hop" | "splat" | "splash" | "win" | "room-join" | "click";

const FILES: Record<CrossSoundName, string> = {
  hop: "/sounds/hop.mp3",
  splat: "/sounds/splat.mp3",
  splash: "/sounds/splash.mp3",
  win: "/sounds/win.mp3",
  "room-join": "/sounds/room-join.mp3",
  click: "/sounds/click.mp3",
};

/** Plays the ported game sounds. Silent on missing files, blocked autoplay, or non-browser env. */
export class CrossSounds {
  private cache = new Map<CrossSoundName, HTMLAudioElement>();
  private muted = false;

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  play(name: CrossSoundName): void {
    if (this.muted || typeof Audio === "undefined") return;
    try {
      let audio = this.cache.get(name);
      if (!audio) {
        audio = new Audio(FILES[name]);
        this.cache.set(name, audio);
      }
      audio.currentTime = 0;
      void audio.play().catch(() => {});
    } catch {
      /* silent — sound is non-essential */
    }
  }
}
```

- [ ] **Step 4: Typecheck**

Run: `cd frontend && pnpm typecheck`
Expected: PASS (no errors). `three` types now resolve.

- [ ] **Step 5: Commit**

```bash
git add frontend/package.json frontend/pnpm-lock.yaml frontend/public/sounds frontend/src/games/chickenCross/scene/crossSounds.ts
git commit -m "build(web): add three + chicken-cross sound assets"
```

---

### Task 2: Scene wire types + pure adapter (`crossViewToSnapshot`)

**Files:**
- Create: `frontend/src/games/chickenCross/scene/crossSceneTypes.ts`
- Create: `frontend/src/games/chickenCross/scene/crossViewToSnapshot.ts`
- Test: `frontend/src/games/chickenCross/scene/crossViewToSnapshot.test.ts`

**Interfaces:**
- Consumes: `CrossView` from `../session-core.ts`; `hazardsAt, laneKind, COLUMN_COUNT, SPAWN_COL, WIN_LANE` from `../../../../../sui-tunnel-ts/src/protocol/cross.ts`.
- Produces:
  - `crossViewToSnapshot(view, prev, role, feeder) => { snapshot: CrossSnapshot; feeder: FeederState; events: SoundEvents }`
  - `initialFeeder(): FeederState`
  - types `CrossSnapshot`, `CrossPlayerState`, `CrossHazardSnapshot`, `CrossLaneSnapshot`, `CrossWorldSnapshot`, `CrossDirection`, `CrossLaneType` (in `crossSceneTypes.ts`)
  - `type FeederState = { deaths:[number,number]; facing:[CrossDirection,CrossDirection] }`
  - `type SoundEvents = { hop: boolean; deaths: Array<"splat"|"splash"> }`

- [ ] **Step 1: Write `crossSceneTypes.ts`**

These mirror the original scene's wire shape exactly (verified against `shared/cross-protocol.ts` + `cross-sim.ts`), kept local so the port does not import from the OG repo.

```ts
export type CrossDirection = "north" | "south" | "east" | "west";
export type CrossLaneType = "grass" | "road" | "water" | "rails";

export type CrossHazardSnapshot = {
  id: string;
  laneIndex: number;
  x: number;
  width: number;
  vx: number;
  kind: "car" | "log" | "train";
};

export type CrossLaneSnapshot = {
  index: number;
  kind: CrossLaneType;
  hazards: CrossHazardSnapshot[];
};

export type CrossWorldSnapshot = {
  minLane: number;
  maxLane: number;
  lanes: CrossLaneSnapshot[];
};

export type CrossPlayerState = {
  id: string;
  name: string;
  column: number;
  laneIndex: number;
  score: number;
  deaths: number;
  alive: boolean;
  connected: boolean;
  facing: CrossDirection;
};

export type CrossSnapshot = {
  type: "cross:snapshot";
  protocol: number;
  roomCode: string;
  phase: string;
  serverTime: number;
  world: CrossWorldSnapshot;
  players: CrossPlayerState[];
  winnerId: string | null;
};
```

- [ ] **Step 2: Write the failing adapter test**

`crossViewToSnapshot.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { COLUMN_COUNT, SPAWN_COL, WIN_LANE, laneKind } from "../../../../../sui-tunnel-ts/src/protocol/cross.ts";
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
  const { snapshot } = crossViewToSnapshot(view({}), null, "A", initialFeeder());
  assert.equal(snapshot.world.minLane, 0);
  assert.equal(snapshot.world.maxLane, WIN_LANE);
  assert.equal(snapshot.world.lanes.length, WIN_LANE + 1);
  for (const lane of snapshot.world.lanes) {
    assert.equal(lane.kind, laneKind(lane.index));
  }
});

test("grass lanes carry no hazards; non-grass map kind to mesh kind", () => {
  const { snapshot } = crossViewToSnapshot(view({}), null, "A", initialFeeder());
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
  const v = view({ players: [
    { lane: 3, col: 2, score: 3 },
    { lane: 1, col: 6, score: 1 },
  ]});
  const { snapshot } = crossViewToSnapshot(v, null, "A", initialFeeder());
  assert.equal(snapshot.players[0].id, "A");
  assert.equal(snapshot.players[0].laneIndex, 3);
  assert.equal(snapshot.players[1].id, "B");
  assert.equal(snapshot.players[1].column, 6);
});

test("hop event fires when a player advances a lane", () => {
  const prev = view({ tick: 1, players: [{ lane: 2, col: 4, score: 2 }, { lane: 1, col: 4, score: 1 }] });
  const next = view({ tick: 2, players: [{ lane: 3, col: 4, score: 3 }, { lane: 1, col: 4, score: 1 }] });
  const { events } = crossViewToSnapshot(next, prev, "A", initialFeeder());
  assert.equal(events.hop, true);
});

test("death increments deaths, resets facing north, emits splat/splash by lane kind", () => {
  // find a water lane and a road lane to test both branches
  let waterLane = -1, roadLane = -1;
  for (let l = 2; l <= WIN_LANE; l++) {
    if (laneKind(l) === "water" && waterLane < 0) waterLane = l;
    if (laneKind(l) === "road" && roadLane < 0) roadLane = l;
  }
  // water death -> splash
  const prevW = view({ tick: 1, players: [{ lane: waterLane, col: 4, score: waterLane }, { lane: 0, col: 4, score: 0 }] });
  const nextW = view({ tick: 2, players: [{ lane: 0, col: SPAWN_COL, score: waterLane }, { lane: 0, col: 4, score: 0 }] });
  const rW = crossViewToSnapshot(nextW, prevW, "A", initialFeeder());
  assert.deepEqual(rW.events.deaths, ["splash"]);
  assert.equal(rW.feeder.deaths[0], 1);
  assert.equal(rW.snapshot.players[0].deaths, 1);
  assert.equal(rW.snapshot.players[0].facing, "north");
  // road death -> splat
  const prevR = view({ tick: 1, players: [{ lane: roadLane, col: 4, score: roadLane }, { lane: 0, col: 4, score: 0 }] });
  const nextR = view({ tick: 2, players: [{ lane: 0, col: SPAWN_COL, score: roadLane }, { lane: 0, col: 4, score: 0 }] });
  const rR = crossViewToSnapshot(nextR, prevR, "A", initialFeeder());
  assert.deepEqual(rR.events.deaths, ["splat"]);
});

test("facing derives from movement delta", () => {
  const prev = view({ tick: 1, players: [{ lane: 2, col: 4, score: 2 }, { lane: 0, col: 4, score: 0 }] });
  const east = crossViewToSnapshot(
    view({ tick: 2, players: [{ lane: 2, col: 5, score: 2 }, { lane: 0, col: 4, score: 0 }] }),
    prev, "A", initialFeeder());
  assert.equal(east.snapshot.players[0].facing, "east");
});

test("winner passes through to winnerId", () => {
  const { snapshot } = crossViewToSnapshot(view({ winner: "B" }), null, "A", initialFeeder());
  assert.equal(snapshot.winnerId, "B");
});
```

- [ ] **Step 3: Run the test, verify it fails**

Run: `cd frontend && node --import tsx --test "src/games/chickenCross/scene/crossViewToSnapshot.test.ts"`
Expected: FAIL — `crossViewToSnapshot` not found / module missing.

- [ ] **Step 4: Write `crossViewToSnapshot.ts`**

```ts
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

const HAZARD_KIND: Record<string, "car" | "log" | "train"> = {
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
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `cd frontend && node --import tsx --test "src/games/chickenCross/scene/crossViewToSnapshot.test.ts"`
Expected: PASS (8 tests). If a hazard-kind test fails because a chosen lane has 0 hazards at tick 0, it still passes (loops skip empty); the id-stability test relies on count being tick-independent — if it fails, STOP: the stable-id assumption is wrong and the adapter needs a position-matched id scheme (see spec risk).

- [ ] **Step 6: Typecheck + commit**

Run: `cd frontend && pnpm typecheck`
Expected: PASS.
```bash
git add frontend/src/games/chickenCross/scene/crossSceneTypes.ts frontend/src/games/chickenCross/scene/crossViewToSnapshot.ts frontend/src/games/chickenCross/scene/crossViewToSnapshot.test.ts
git commit -m "feat(web): add chicken-cross view-to-scene adapter"
```

---

### Task 3: Pure input mapping + canvas binding

**Files:**
- Create: `frontend/src/games/chickenCross/scene/crossInput.ts`
- Test: `frontend/src/games/chickenCross/scene/crossInput.test.ts`

**Interfaces:**
- Produces:
  - `keyToScreenDir(code: string): CrossDirection | null`
  - `swipeToScreenDir(dx: number, dy: number, threshold?: number): CrossDirection | null`
  - `bindCrossInput(target: HTMLElement, onScreenDir: (dir: CrossDirection) => void): () => void`

These return a *screen-relative* direction (expressed in the `CrossDirection` union: up=`north`, down=`south`, left=`west`, right=`east`). `CrossCanvas` passes it through `scene.worldDirectionFromScreenInput` to get the actual world direction before calling `onDir`.

- [ ] **Step 1: Write the failing test**

`crossInput.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { keyToScreenDir, swipeToScreenDir } from "./crossInput.ts";

test("arrow + WASD keys map to screen directions", () => {
  assert.equal(keyToScreenDir("ArrowUp"), "north");
  assert.equal(keyToScreenDir("KeyW"), "north");
  assert.equal(keyToScreenDir("ArrowDown"), "south");
  assert.equal(keyToScreenDir("KeyS"), "south");
  assert.equal(keyToScreenDir("ArrowLeft"), "west");
  assert.equal(keyToScreenDir("KeyA"), "west");
  assert.equal(keyToScreenDir("ArrowRight"), "east");
  assert.equal(keyToScreenDir("KeyD"), "east");
  assert.equal(keyToScreenDir("Space"), null);
});

test("swipe resolves dominant axis past the threshold", () => {
  assert.equal(swipeToScreenDir(40, 5), "east");
  assert.equal(swipeToScreenDir(-40, 5), "west");
  assert.equal(swipeToScreenDir(5, 40), "south");
  assert.equal(swipeToScreenDir(5, -40), "north");
});

test("swipe below threshold is ignored", () => {
  assert.equal(swipeToScreenDir(10, 10), null);
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd frontend && node --import tsx --test "src/games/chickenCross/scene/crossInput.test.ts"`
Expected: FAIL — module missing.

- [ ] **Step 3: Write `crossInput.ts`**

```ts
import type { CrossDirection } from "./crossSceneTypes.ts";

const KEY_DIRS: Record<string, CrossDirection> = {
  ArrowUp: "north",
  KeyW: "north",
  ArrowDown: "south",
  KeyS: "south",
  ArrowLeft: "west",
  KeyA: "west",
  ArrowRight: "east",
  KeyD: "east",
};

/** Keyboard code → screen-relative direction (null for unhandled keys). */
export function keyToScreenDir(code: string): CrossDirection | null {
  return KEY_DIRS[code] ?? null;
}

/** Swipe vector → screen-relative direction; null if neither axis clears `threshold`. */
export function swipeToScreenDir(dx: number, dy: number, threshold = 28): CrossDirection | null {
  if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) return null;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? "east" : "west";
  return dy > 0 ? "south" : "north";
}

/**
 * Binds keyboard + touch-swipe input scoped to `target` (never `window`).
 * Returns an unbind function that removes every listener — call it on teardown.
 */
export function bindCrossInput(
  target: HTMLElement,
  onScreenDir: (dir: CrossDirection) => void,
): () => void {
  const onKey = (e: KeyboardEvent) => {
    const dir = keyToScreenDir(e.code);
    if (dir) {
      e.preventDefault();
      onScreenDir(dir);
    }
  };
  let startX = 0;
  let startY = 0;
  const onTouchStart = (e: TouchEvent) => {
    const t = e.changedTouches[0];
    startX = t.clientX;
    startY = t.clientY;
  };
  const onTouchEnd = (e: TouchEvent) => {
    const t = e.changedTouches[0];
    const dir = swipeToScreenDir(t.clientX - startX, t.clientY - startY);
    if (dir) onScreenDir(dir);
  };

  target.tabIndex = target.tabIndex >= 0 ? target.tabIndex : 0; // focusable for keydown
  target.addEventListener("keydown", onKey);
  target.addEventListener("touchstart", onTouchStart, { passive: true });
  target.addEventListener("touchend", onTouchEnd);

  return () => {
    target.removeEventListener("keydown", onKey);
    target.removeEventListener("touchstart", onTouchStart);
    target.removeEventListener("touchend", onTouchEnd);
  };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `cd frontend && node --import tsx --test "src/games/chickenCross/scene/crossInput.test.ts"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/chickenCross/scene/crossInput.ts frontend/src/games/chickenCross/scene/crossInput.test.ts
git commit -m "feat(web): add scoped chicken-cross input mapping"
```

---

### Task 4: Port the Three.js scene (scoped resize + full dispose)

**Files:**
- Create (copy + edit): `frontend/src/games/chickenCross/scene/CrossScene.ts`, `facing.ts`, `screenInput.ts`
- Reference (read-only): OG `ui/src/cross/CrossScene.ts`, `facing.ts`, `screen-input.ts`

The original scene is all procedural geometry — no model/image files to move. Three edits matter: container-scoped resize, a real `dispose()`, and snap-on-wrap for hazards.

- [ ] **Step 1: Copy the three source files**

Run:
```bash
SRC=/Users/realestzan/Projects/code/dopamint/games/chicken-cross/ui/src/cross
DEST=frontend/src/games/chickenCross/scene
cp "$SRC/CrossScene.ts" "$DEST/CrossScene.ts"
cp "$SRC/facing.ts" "$DEST/facing.ts"
cp "$SRC/screen-input.ts" "$DEST/screenInput.ts"
```

- [ ] **Step 2: Read the copied `CrossScene.ts` and list its imports**

Read `frontend/src/games/chickenCross/scene/CrossScene.ts`. Note every `import` line. Expect: `three`, `./facing`, `./screen-input`, and snapshot/sim types (e.g. `../../shared/cross-protocol`, `./cross-sim`) plus possibly a constants/config module.

- [ ] **Step 3: Rewire type + sibling imports**

In `CrossScene.ts`:
- Change the snapshot/sim type import(s) to: `import type { CrossSnapshot, CrossPlayerState, CrossDirection, CrossLaneType } from "./crossSceneTypes.ts";` (add only the names actually referenced).
- Change `from "./screen-input"` to `from "./screenInput.ts"`.
- Ensure `./facing` import resolves (`./facing.ts`).
- For any remaining unresolved import (color palette / visual constants / sim helpers used by the renderer): if it is pure constants or a small pure helper, copy it into a new `frontend/src/games/chickenCross/scene/crossSceneConstants.ts` and import from there; if it is a type, add it to `crossSceneTypes.ts`. Do NOT import anything from the OG repo path.

Run after each change: `cd frontend && pnpm typecheck` and resolve errors until only intentional ones (resize/dispose, next steps) remain.

- [ ] **Step 4: Make sizing container-scoped**

In `CrossScene.ts`:
- Find the constructor's initial size + the `window.addEventListener("resize", ...)` registration and the `resize()` method that reads `window.innerWidth/innerHeight`.
- **Remove** the `window.addEventListener("resize", ...)` line entirely (the container drives resize now).
- Change the `resize` method signature to accept explicit dimensions and use them:

```ts
resize(width: number, height: number): void {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const dpr = Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, 2);
  this.renderer.setPixelRatio(dpr);
  this.renderer.setSize(w, h, false);
  const aspect = w / h;
  // CAMERA_FRUSTUM is the existing scene constant; keep its name.
  this.camera.left = (-CAMERA_FRUSTUM * aspect) / 2;
  this.camera.right = (CAMERA_FRUSTUM * aspect) / 2;
  this.camera.top = CAMERA_FRUSTUM / 2;
  this.camera.bottom = -CAMERA_FRUSTUM / 2;
  this.camera.updateProjectionMatrix();
}
```
(Match the exact field names already in the file — `this.renderer`, `this.camera`, `CAMERA_FRUSTUM`. If the original `resize()` already recomputes the frustum, keep that formula and only swap `window.innerWidth/Height` for the `width`/`height` params.)
- In the constructor, replace the initial `this.renderer.setSize(window.innerWidth, window.innerHeight)` with `this.renderer.setSize(1, 1, false)` (CrossCanvas calls `resize()` immediately after construction via its ResizeObserver).

- [ ] **Step 5: Add full disposal**

Replace the body of `dispose()` so it frees the whole graph, not just `grassTexture` + `renderer`:

```ts
dispose(): void {
  this.scene.traverse((obj) => {
    const mesh = obj as unknown as {
      geometry?: { dispose?: () => void };
      material?: { dispose?: () => void } | Array<{ dispose?: () => void }>;
    };
    mesh.geometry?.dispose?.();
    if (Array.isArray(mesh.material)) {
      for (const m of mesh.material) m?.dispose?.();
    } else {
      mesh.material?.dispose?.();
    }
  });
  this.laneMeshes.clear();
  this.hazardMeshes.clear();
  this.playerVisuals.clear();
  this.grassTexture.dispose();
  this.renderer.dispose();
}
```
(Match the actual Map field names in the file — they may be `laneMeshes`/`hazardMeshes`/`playerVisuals` or similar; clear each Map the scene holds. Also dispose any other CanvasTexture fields besides `grassTexture` — e.g. a sand/dim-grass texture if stored as a field.)

- [ ] **Step 6: Snap hazards on column wrap**

Find where a hazard mesh's target X is applied each frame (the lerp toward `hazard.x * TILE`). Guard it so a mod-wrap teleports instead of sliding across:

```ts
const targetX = hazard.x * TILE;
if (Math.abs(targetX - mesh.position.x) > (COLUMN_COUNT * TILE) / 2) {
  mesh.position.x = targetX; // wrap: snap, don't lerp
} else {
  mesh.position.x += (targetX - mesh.position.x) * HAZARD_LERP; // keep existing lerp factor/name
}
```
(Use the file's existing `TILE` and lerp constant; import `COLUMN_COUNT` from the protocol — `import { COLUMN_COUNT } from "../../../../../sui-tunnel-ts/src/protocol/cross.ts";` — or reuse the scene's own column count if it already defines one with the same value 9.)

- [ ] **Step 7: Typecheck**

Run: `cd frontend && pnpm typecheck`
Expected: PASS. The scene now compiles with no `window` resize listener and a complete `dispose()`.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/games/chickenCross/scene/CrossScene.ts frontend/src/games/chickenCross/scene/facing.ts frontend/src/games/chickenCross/scene/screenInput.ts
# include crossSceneConstants.ts if created
git add frontend/src/games/chickenCross/scene/crossSceneConstants.ts 2>/dev/null || true
git commit -m "feat(web): port chicken-cross 3d scene, scoped + disposable"
```

---

### Task 5: `CrossCanvas` — canvas lifecycle, feeding, sounds, teardown

**Files:**
- Create: `frontend/src/games/chickenCross/components/CrossCanvas.tsx`

**Interfaces:**
- Consumes: `CrossScene` (`new CrossScene(canvas)`, `applySnapshot(snapshot, localPlayerId)`, `render()`, `setCameraMode`, `setLocalPlayerId`, `worldDirectionFromScreenInput`, `resize(w,h)`, `dispose()`); `crossViewToSnapshot`/`initialFeeder`/`FeederState`; `bindCrossInput`; `CrossSounds`; `CrossView`, `CrossDir`.
- Produces: `function CrossCanvas(props: { view: CrossView; role: "A"|"B"|null; winner: "A"|"B"|null; onDir: (d: CrossDir) => void }): JSX.Element`

- [ ] **Step 1: Write `CrossCanvas.tsx`**

```tsx
import { useEffect, useRef } from "react";
import type { CrossView } from "../session-core.ts";
import type { CrossDir } from "../../../../../sui-tunnel-ts/src/protocol/cross.ts";
import { CrossScene } from "../scene/CrossScene.ts";
import { crossViewToSnapshot, initialFeeder, type FeederState } from "../scene/crossViewToSnapshot.ts";
import { bindCrossInput } from "../scene/crossInput.ts";
import { CrossSounds } from "../scene/crossSounds.ts";
import type { CrossDirection } from "../scene/crossSceneTypes.ts";

type CrossCanvasProps = {
  view: CrossView;
  role: "A" | "B" | null;
  winner: "A" | "B" | null;
  onDir: (dir: CrossDir) => void;
};

const SCREEN_DIRS: Array<{ dir: CrossDirection; glyph: string; col: string; row: string }> = [
  { dir: "north", glyph: "▲", col: "2", row: "1" },
  { dir: "west", glyph: "◀", col: "1", row: "2" },
  { dir: "east", glyph: "▶", col: "3", row: "2" },
  { dir: "south", glyph: "▼", col: "2", row: "3" },
];

export function CrossCanvas({ view, role, winner, onDir }: CrossCanvasProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<CrossScene | null>(null);
  const soundsRef = useRef<CrossSounds | null>(null);
  const prevViewRef = useRef<CrossView | null>(null);
  const feederRef = useRef<FeederState>(initialFeeder());
  const prevWinnerRef = useRef<"A" | "B" | null>(null);
  const onDirRef = useRef(onDir);
  onDirRef.current = onDir;

  // Mount once: scene, sounds, input, resize observer, render loop.
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;

    const scene = new CrossScene(canvas);
    const sounds = new CrossSounds();
    sceneRef.current = scene;
    soundsRef.current = sounds;
    scene.setCameraMode("3d");

    // screen dir -> world dir (iso-aware) -> setDir
    const emit = (screenDir: CrossDirection) => {
      const world = scene.worldDirectionFromScreenInput(screenDir);
      onDirRef.current(world as CrossDir);
    };
    const unbindInput = bindCrossInput(canvas, emit);
    (canvas as HTMLCanvasElement & { __emit?: typeof emit }).__emit = emit; // used by D-pad buttons

    const ro = new ResizeObserver((entries) => {
      const box = entries[0].contentRect;
      scene.resize(box.width, box.height);
    });
    ro.observe(wrap);
    scene.resize(wrap.clientWidth, wrap.clientHeight);

    sounds.play("room-join"); // match has started (CrossBoard only mounts during play)

    let raf = 0;
    const frame = () => {
      scene.render();
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      unbindInput();
      scene.dispose();
      sceneRef.current = null;
      soundsRef.current = null;
      prevViewRef.current = null;
      feederRef.current = initialFeeder();
      prevWinnerRef.current = null;
    };
  }, []);

  // Keep the local-player focus in sync with role.
  useEffect(() => {
    sceneRef.current?.setLocalPlayerId(role);
  }, [role]);

  // Feed each tick + fire transition sounds.
  useEffect(() => {
    const scene = sceneRef.current;
    const sounds = soundsRef.current;
    if (!scene || !sounds) return;
    const { snapshot, feeder, events } = crossViewToSnapshot(
      view, prevViewRef.current, role, feederRef.current,
    );
    scene.applySnapshot(snapshot, role);
    feederRef.current = feeder;
    prevViewRef.current = view;
    if (events.hop) sounds.play("hop");
    for (const d of events.deaths) sounds.play(d);
  }, [view, role]);

  // Win sound on null -> winner transition.
  useEffect(() => {
    if (winner && !prevWinnerRef.current) soundsRef.current?.play("win");
    prevWinnerRef.current = winner;
  }, [winner]);

  const press = (dir: CrossDirection) => {
    const canvas = canvasRef.current as (HTMLCanvasElement & { __emit?: (d: CrossDirection) => void }) | null;
    soundsRef.current?.play("click");
    canvas?.__emit?.(dir);
  };

  return (
    <div ref={wrapRef} className="cross-canvas-wrap">
      <canvas ref={canvasRef} className="cross-canvas" />
      <div className="cross-dpad" role="group" aria-label="move">
        {SCREEN_DIRS.map((b) => (
          <button
            key={b.dir}
            type="button"
            className="cross-dpad-btn"
            style={{ gridColumn: b.col, gridRow: b.row }}
            aria-label={b.dir}
            onClick={() => press(b.dir)}
          >
            {b.glyph}
          </button>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && pnpm typecheck`
Expected: PASS. (If `worldDirectionFromScreenInput` returns the `CrossDirection` union, the `as CrossDir` cast is structurally safe — both are `"north"|"south"|"east"|"west"`.)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/games/chickenCross/components/CrossCanvas.tsx
git commit -m "feat(web): add chicken-cross canvas lifecycle component"
```

---

### Task 6: Swap `CrossBoard` internals, trim CSS, lobby click sound

**Files:**
- Modify: `frontend/src/games/chickenCross/components/CrossBoard.tsx`
- Modify: `frontend/src/games/chickenCross/cross.css`
- Modify: `frontend/src/games/chickenCross/components/CrossLobby.tsx`

**Interfaces:**
- Consumes: `CrossCanvas` from `./CrossCanvas.tsx`.
- `CrossBoard` keeps its exact prop signature (Global Constraints).

- [ ] **Step 1: Read the current `CrossBoard.tsx`**

Note the prop destructuring (`view, winner, role, onDir, onPlayAgain, seed`), the header/HUD markup (balances), the lane-grid block (to remove), and the result/play-again overlay (to keep).

- [ ] **Step 2: Replace the lane grid with `CrossCanvas`**

Keep the prop signature, the HUD header (balanceA/balanceB), and the result overlay + "Play again" (`onPlayAgain`) exactly as they are. Replace ONLY the emoji lane-grid block (the `cross-grid` / `cross-lane` / `cross-cell` JSX) with:

```tsx
<CrossCanvas view={view} role={role} winner={winner} onDir={onDir} />
```
Add the import at the top: `import { CrossCanvas } from "./CrossCanvas.tsx";`
Remove now-unused imports (`hazardsAt`, `laneKind`, emoji/lane helpers, `seed` usage inside the grid). `seed` stays in the prop list (still passed by `ChickenCrossWindow`); if it becomes unused, prefix `_seed` is NOT allowed since the prop name is fixed — instead keep destructuring it and add a `void seed;` is unnecessary; simply leave it destructured and unreferenced (TS `noUnusedLocals` is off for props in this codebase — confirm via typecheck; if it errors, reference it harmlessly or drop it from destructuring while keeping the type).

- [ ] **Step 3: Trim `cross.css`**

Remove the `.cross-grid`, `.cross-lane`, `.cross-cell` rules (emoji grid is gone). Add canvas + D-pad chrome:

```css
.cross-canvas-wrap {
  position: relative;
  flex: 1 1 0;
  min-height: 0;
  width: 100%;
  overflow: hidden;
  border-radius: 0.5rem;
}
.cross-canvas {
  display: block;
  width: 100%;
  height: 100%;
}
.cross-dpad {
  position: absolute;
  right: 0.5rem;
  bottom: 0.5rem;
  display: grid;
  grid-template-columns: repeat(3, 1.75rem);
  grid-template-rows: repeat(3, 1.75rem);
  gap: 0.15rem;
  opacity: 0.85;
}
.cross-dpad-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 0.3rem;
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
  font-size: 0.8rem;
  cursor: pointer;
}
.cross-dpad-btn:active {
  background: rgba(0, 0, 0, 0.7);
}
```
(Keep any existing HUD/header/overlay rules in the file untouched.)

- [ ] **Step 4: Add the lobby click sound**

In `CrossLobby.tsx`, import the sound module and play `click` on the create/join button handlers:
```tsx
import { CrossSounds } from "../scene/crossSounds.ts";
const lobbySounds = new CrossSounds();
```
At the top of each button's `onClick` (create and join), add: `lobbySounds.play("click");` before calling the existing `onCreate`/`onJoin` handler. Do not change the existing handler logic.

- [ ] **Step 5: Typecheck + build**

Run: `cd frontend && pnpm typecheck && pnpm build`
Expected: PASS. Build now bundles `three`.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/games/chickenCross/components/CrossBoard.tsx frontend/src/games/chickenCross/cross.css frontend/src/games/chickenCross/components/CrossLobby.tsx
git commit -m "feat(web): render chicken-cross with ported 3d scene"
```

---

### Task 7: Full gate + manual verification

**Files:** none (verification).

- [ ] **Step 1: Run unit tests + gate**

Run:
```bash
cd frontend && node --import tsx --test "src/games/chickenCross/scene/*.test.ts" && pnpm typecheck && pnpm build
```
Expected: all adapter + input tests PASS; typecheck + build green.

- [ ] **Step 2: Manual E2E (browser)**

Run `cd frontend && pnpm dev`, open the app, launch Chicken Cross PvP (two sessions or the existing lobby flow). Verify:
- the original low-poly 3D scene renders inside the desktop tile (chicken, lanes, cars/logs/train, scenery, shadows);
- it scales cleanly when the window/viewport changes (looks right at the ~256 px tile and when enlarged toward 400×400+) — no stretching, no clipping of the play area;
- **hop** on advance, **splat/splash** on death (road vs water), **win** on game end, **room-join** on entering play, **click** on D-pad/lobby buttons;
- D-pad + arrow keys + swipe steer correctly (screen-up moves the chicken away from camera);
- closing and reopening the window (or a PvP re-match) leaves no console errors, no doubled audio, no WebGL context warnings (teardown is clean);
- both players (A and B) render with correct positions; the local seat has its focus ring/highlight.

- [ ] **Step 3: Confirm no contract drift**

Run: `cd frontend && node --import tsx --test "src/games/chickenCross/session-core.test.ts"`
Expected: PASS (CrossView/deriveView unchanged). Confirm `git diff --stat main..` touches only `frontend/` UI files + `docs/` + lockfile — no `sui-tunnel-ts/`, backend, or Move changes.

- [ ] **Step 4: Final state**

Working tree clean, branch pushed:
```bash
git -C . status --short   # expect empty
git push -u origin feat/chicken-cross-ui
```

---

## Self-review notes

- **Spec coverage:** adapter (Task 2), scene port w/ scoped resize + full dispose + wrap-snap (Task 4), fluid-fit via ResizeObserver (Task 5), 6 sounds w/ exact triggers (Tasks 1/5/6), `three` dep (Task 1), CrossBoard prop-preserving swap (Task 6), teardown (Tasks 4/5), tests + gate (Tasks 2/3/7). All spec sections map to a task.
- **Invariants:** no task edits `CrossView`/hooks/SDK/backend/Move; `setDir` path is a thin pass-through (Task 5 `emit`); Task 7 Step 3 verifies no drift.
- **Type consistency:** `crossViewToSnapshot` return `{snapshot,feeder,events}`, `FeederState`, `SoundEvents`, `CrossSounds.play(CrossSoundName)`, `keyToScreenDir`/`swipeToScreenDir`/`bindCrossInput`, `CrossScene.resize(w,h)` are referenced identically across tasks.
- **Open risk carried from spec:** if Task 2 Step 5's id-stability test fails, the wholesale-port assumption needs the position-matched hazard-id fallback before proceeding to Task 4.
