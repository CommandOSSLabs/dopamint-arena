# Chicken Cross Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Chicken Cross as a fully-wired arena self-play game over a real Sui tunnel — two bot chickens race a lane grid, every tick is a dual-signed off-chain update, the winner is paid on-chain at cooperative close.

**Architecture:** One deterministic SDK protocol (`CrossProtocol`) drives the off-chain engine; a blackjack-shaped frontend folder (hook + pure session-core + 2D board) wires it to the wallet, the existing `onchain/tunnelTx.ts` builders, and the control-plane. Zero backend, zero Move changes. The reference Crossy-Road game supplies only the rules (lanes/hazards/collision/respawn/win); its continuous-time, server-authoritative architecture is reformulated into a discrete, per-tick, replayable model.

**Tech Stack:** TypeScript, `sui-tunnel-ts` SDK (`Protocol`, `OffchainTunnel`), React 19 + Vite, `@mysten/dapp-kit`, Tailwind, node:test via tsx.

## Global Constraints

- `OffchainTunnel.step(move, by)` asserts `balanceA + balanceB === total` for EVERY state — the protocol must conserve the locked total in every reachable state.
- Settlement pays from `protocol.balances(terminalState)`; the winner's terminal balance must be `(total, 0)` / `(0, total)`; a push leaves `(S, S)`.
- Self-play uses cooperative close only (no on-chain `update_state`): `buildSettlement(createdAt)` with default `onchainNonce = 0` ⇒ `finalNonce = 1`. Do NOT add an on-chain `update_state`.
- `encodeState` MUST be canonical: same state → same bytes (it is hashed into the tunnel `state_hash`).
- Reuse the shared `frontend/src/onchain/tunnelTx.ts` builders (they handle `PACKAGE_ID` injection + @mysten/sui version skew). Add no new on-chain glue.
- `session-core.ts` imports the SDK **type-only** (`import type`) so it runs under tsx with no Vite. Runtime SDK imports (`laneKind`, `hazardsAt`) belong in the Vite-only `CrossBoard.tsx`, never in the pure core or its test.
- All money/integers are `bigint`; `u64ToBeBytes` accepts `number | bigint`. Game ids are kebab-case; the game id is `chicken-cross`.

---

### Task 1: Hazard & collision core (deterministic)

**Files:**

- Create: `sui-tunnel-ts/src/protocol/cross.ts`
- Test: `sui-tunnel-ts/src/protocol/cross.test.ts`

**Interfaces:**

- Consumes: nothing (leaf module besides `./Protocol` helpers, used in Task 2).
- Produces: `COLUMN_COUNT`, `SPAWN_COL`, `WIN_LANE`, `TICK_CAP`, `RESPAWN_INVULN`, `MIN_STAKE` (constants); `CrossDir` (`"north"|"south"|"east"|"west"`); `CrossLaneKind` (`"grass"|"road"|"water"|"rails"`); `HazardSpan { center:number; half:number }`; `laneKind(lane:number):CrossLaneKind`; `hazardsAt(seed:bigint, lane:number, tick:bigint):HazardSpan[]`; `isLethal(seed:bigint, col:number, lane:number, tick:bigint):boolean`; `destOf(lane:number, col:number, dir:CrossDir):[number,number]`.

- [ ] **Step 1: Write the failing tests**

Create `sui-tunnel-ts/src/protocol/cross.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  laneKind,
  hazardsAt,
  isLethal,
  destOf,
  COLUMN_COUNT,
  SPAWN_COL,
} from "./cross.ts";

test("laneKind cycles grass,grass,road,road,water,rails,grass,grass after lane 2", () => {
  assert.equal(laneKind(0), "grass");
  assert.equal(laneKind(1), "grass");
  assert.equal(laneKind(2), "road");
  assert.equal(laneKind(3), "road");
  assert.equal(laneKind(4), "water");
  assert.equal(laneKind(5), "rails");
  assert.equal(laneKind(6), "grass");
  assert.equal(laneKind(7), "grass");
  assert.equal(laneKind(8), "road");
});

test("grass is never lethal", () => {
  for (let t = 0n; t < 50n; t++) {
    assert.equal(isLethal(123n, SPAWN_COL, 0, t), false);
    assert.equal(isLethal(123n, 0, 1, t), false);
  }
});

test("hazardsAt is deterministic for the same (seed,lane,tick)", () => {
  const a = hazardsAt(777n, 2, 9n);
  const b = hazardsAt(777n, 2, 9n);
  assert.deepEqual(a, b);
});

test("water is inverted: lethal exactly when NOT on a log span", () => {
  // For some tick, find a water cell and assert lethality == not(covered by a log).
  const seed = 999n;
  const lane = 4; // water
  const tick = 13n;
  const spans = hazardsAt(seed, lane, tick);
  for (let col = 0; col < COLUMN_COUNT; col++) {
    const c = col + 0.5;
    const onLog = spans.some((s) =>
      [c, c - COLUMN_COUNT, c + COLUMN_COUNT].some(
        (cc) => cc > s.center - s.half && cc < s.center + s.half,
      ),
    );
    assert.equal(isLethal(seed, col, lane, tick), !onLog);
  }
});

test("destOf clamps to the board", () => {
  assert.deepEqual(destOf(3, 4, "north"), [4, 4]);
  assert.deepEqual(destOf(3, 4, "south"), [2, 4]);
  assert.deepEqual(destOf(0, 4, "south"), [0, 4]); // lane clamps at 0
  assert.deepEqual(destOf(3, 8, "east"), [3, 8]); // col clamps at COLUMN_COUNT-1
  assert.deepEqual(destOf(3, 0, "west"), [3, 0]); // col clamps at 0
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd sui-tunnel-ts && node --import tsx --test src/protocol/cross.test.ts`
Expected: FAIL — `Cannot find module './cross.ts'` / exports undefined.

- [ ] **Step 3: Write the hazard & collision core**

Create `sui-tunnel-ts/src/protocol/cross.ts`:

```ts
/**
 * Chicken Cross protocol: a TWO-PARTY lane-hopper race over a tunnel.
 *
 * A discrete, deterministic reformulation of the standalone Crossy-Road reference
 * (which used a continuous 25 Hz server sim). Here every world advance is ONE tick =
 * one dual-signed state update; hazard positions are a pure function of
 * (seed, laneIndex, tick), so both parties — and an on-chain disputer replaying
 * encodeState — agree on every collision with no trusted server.
 *
 * Party A and Party B are two bot chickens (self-play). Both stake S; the locked
 * total is 2S. Balances stay (S, S) for the whole race and flip to (2S, 0) / (0, 2S)
 * only on the winning tick — so the invariant balanceA + balanceB === total holds for
 * every reachable state (required by OffchainTunnel.step).
 */

import {
  Protocol,
  Party,
  Balances,
  ProtocolContext,
  protocolDomain,
} from "./Protocol";
import { concatBytes } from "../core/bytes";
import { u64ToBeBytes } from "../core/wire";

// ============================================
// CONFIG
// ============================================

/** Columns 0..COLUMN_COUNT-1. */
export const COLUMN_COUNT = 9;
/** Spawn / respawn column (center). */
export const SPAWN_COL = 4;
/** First chicken to reach this lane wins the pot. */
export const WIN_LANE = 20;
/** Hard upper bound on ticks; on reaching it the higher score wins (tie ⇒ push). */
export const TICK_CAP = 600n;
/** Ticks of collision immunity after a respawn (also blocks moving, per the reference). */
export const RESPAWN_INVULN = 3;
/** Minimum fundable stake per seat (hook clamps to this). */
export const MIN_STAKE = 100n;

export type CrossDir = "north" | "south" | "east" | "west";
export type CrossLaneKind = "grass" | "road" | "water" | "rails";

/** A hazard's horizontal span on a lane: center column ± half-width. */
export interface HazardSpan {
  center: number;
  half: number;
}

// ============================================
// DETERMINISTIC HAZARD FIELD (pure)
// ============================================

/** Small, fast, fully deterministic PRNG (Mulberry32). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** True modulo (handles negatives), result in [0, m). */
function mod(x: number, m: number): number {
  return ((x % m) + m) % m;
}

/** Lane archetype, cycling grass,grass,road,road,water,rails from lane 2 (lanes 0,1 grass). */
export function laneKind(lane: number): CrossLaneKind {
  if (lane < 2) return "grass";
  const k = (lane - 2) % 6;
  if (k === 0 || k === 1) return "road";
  if (k === 2) return "water";
  if (k === 3) return "rails";
  return "grass"; // k === 4 || k === 5
}

/** Per-lane RNG, seeded deterministically from (seed, lane). */
function laneRng(seed: bigint, lane: number): () => number {
  const mixed = (seed ^ (BigInt(lane) * 0x9e3779b1n)) & 0xffffffffn;
  return mulberry32(Number(mixed));
}

/**
 * Hazard spans occupying a lane at `tick`, as a pure function of (seed, lane, tick).
 * Roads carry narrow cars, water carries wide logs (platforms), rails a very wide train.
 * Positions sweep across the columns at a seeded speed and wrap at COLUMN_COUNT.
 */
export function hazardsAt(
  seed: bigint,
  lane: number,
  tick: bigint,
): HazardSpan[] {
  const kind = laneKind(lane);
  if (kind === "grass") return [];
  const rng = laneRng(seed, lane);
  // Bound the tick for float stability across very long games (positions stay periodic).
  const t = Number(tick % 1048576n);
  const spans: HazardSpan[] = [];

  if (kind === "road") {
    const count = rng() < 0.5 ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const speed = 0.1 + rng() * 0.1;
      const dir = rng() < 0.5 ? 1 : -1;
      const phase = rng() * COLUMN_COUNT;
      spans.push({
        center: mod(phase + dir * speed * t, COLUMN_COUNT),
        half: 0.9,
      });
    }
  } else if (kind === "water") {
    const count = rng() < 0.5 ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const speed = 0.06 + rng() * 0.05;
      const dir = rng() < 0.5 ? 1 : -1;
      const phase = rng() * COLUMN_COUNT + i * 3;
      spans.push({
        center: mod(phase + dir * speed * t, COLUMN_COUNT),
        half: 1.4,
      });
    }
  } else {
    // rails
    const speed = 0.2 + rng() * 0.15;
    const dir = rng() < 0.5 ? 1 : -1;
    const phase = rng() * COLUMN_COUNT;
    spans.push({
      center: mod(phase + dir * speed * t, COLUMN_COUNT),
      half: 3.0,
    });
  }
  return spans;
}

/** Strict-exclusive overlap test (chicken center = col + 0.5), accounting for wrap. */
function spanCoversCol(span: HazardSpan, col: number): boolean {
  const c = col + 0.5;
  for (const cc of [c, c - COLUMN_COUNT, c + COLUMN_COUNT]) {
    if (cc > span.center - span.half && cc < span.center + span.half)
      return true;
  }
  return false;
}

/**
 * Is the cell (col, lane) lethal at `tick`? grass = safe; road/rails = lethal when a
 * hazard overlaps; water = INVERTED (open water kills; a log saves). Behind spawn = lethal.
 */
export function isLethal(
  seed: bigint,
  col: number,
  lane: number,
  tick: bigint,
): boolean {
  if (lane < 0) return true;
  const kind = laneKind(lane);
  if (kind === "grass") return false;
  const onHazard = hazardsAt(seed, lane, tick).some((s) =>
    spanCoversCol(s, col),
  );
  if (kind === "water") return !onHazard;
  return onHazard;
}

/** Destination cell for a hop, clamped to the board. */
export function destOf(
  lane: number,
  col: number,
  dir: CrossDir,
): [number, number] {
  if (dir === "north") return [lane + 1, col];
  if (dir === "south") return [Math.max(0, lane - 1), col];
  if (dir === "east") return [lane, Math.min(COLUMN_COUNT - 1, col + 1)];
  return [lane, Math.max(0, col - 1)]; // west
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd sui-tunnel-ts && node --import tsx --test src/protocol/cross.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/realestzan/Projects/code/dopamint-arena
git add sui-tunnel-ts/src/protocol/cross.ts sui-tunnel-ts/src/protocol/cross.test.ts
git commit -m "feat(sdk): chicken-cross hazard & collision core (deterministic)"
```

---

### Task 2: CrossProtocol (state machine, encoding, settlement)

**Files:**

- Modify: `sui-tunnel-ts/src/protocol/cross.ts` (append the protocol + helpers)
- Modify: `sui-tunnel-ts/src/protocol/index.ts:5-10` (add the export)
- Test: `sui-tunnel-ts/src/protocol/cross.test.ts` (append protocol tests)

**Interfaces:**

- Consumes: everything from Task 1; `Protocol`, `Party`, `Balances`, `ProtocolContext`, `protocolDomain` from `./Protocol`; `concatBytes`, `u64ToBeBytes`.
- Produces: `CrossPlayer { lane:number; col:number; score:number; invulnTicks:number }`; `CrossState { tick:bigint; seed:bigint; players:[CrossPlayer,CrossPlayer]; winner:Party|null; balanceA:bigint; balanceB:bigint; total:bigint }`; `CrossMove { dirA?:CrossDir; dirB?:CrossDir }`; `class CrossProtocol implements Protocol<CrossState, CrossMove>` with `name = "cross.v1"`.

- [ ] **Step 1: Write the failing tests**

Append to `sui-tunnel-ts/src/protocol/cross.test.ts`:

```ts
import { CrossProtocol, WIN_LANE, TICK_CAP, MIN_STAKE } from "./cross.ts";
import type { CrossState, CrossMove } from "./cross.ts";

const CTX = {
  tunnelId: "0xabc123",
  initialBalances: { a: MIN_STAKE, b: MIN_STAKE },
};

function playout(p: CrossProtocol, seedRng: () => number): CrossState {
  let s = p.initialState(CTX);
  let guard = 0;
  while (!p.isTerminal(s) && guard < Number(TICK_CAP) + 5) {
    const by = s.tick % 2n === 0n ? "A" : "B";
    const move = p.randomMove(s, by, seedRng);
    if (!move) break;
    s = p.applyMove(s, move, by);
    guard++;
  }
  return s;
}

test("initialState locks the total and starts at tick 0 with two spawned chickens", () => {
  const p = new CrossProtocol();
  const s = p.initialState(CTX);
  assert.equal(s.tick, 0n);
  assert.equal(s.total, MIN_STAKE * 2n);
  assert.equal(s.balanceA + s.balanceB, s.total);
  assert.equal(s.players.length, 2);
  assert.equal(s.winner, null);
});

test("encodeState is canonical: identical states encode to identical bytes", () => {
  const p = new CrossProtocol();
  const a = p.applyMove(
    p.initialState(CTX),
    { dirA: "north", dirB: "north" },
    "A",
  );
  const b = p.applyMove(
    p.initialState(CTX),
    { dirA: "north", dirB: "north" },
    "A",
  );
  assert.deepEqual(Array.from(p.encodeState(a)), Array.from(p.encodeState(b)));
});

test("different states encode to different bytes (tick advances)", () => {
  const p = new CrossProtocol();
  const s0 = p.initialState(CTX);
  const s1 = p.applyMove(s0, { dirA: "north" }, "A");
  assert.notDeepEqual(
    Array.from(p.encodeState(s0)),
    Array.from(p.encodeState(s1)),
  );
});

test("balances are conserved across a full random playout", () => {
  const p = new CrossProtocol();
  let s = p.initialState(CTX);
  const rng = mulberry32ForTest(42);
  for (let i = 0; i < 400 && !p.isTerminal(s); i++) {
    const by = s.tick % 2n === 0n ? "A" : "B";
    const m = p.randomMove(s, by, rng) as CrossMove;
    s = p.applyMove(s, m, by);
    assert.equal(s.balanceA + s.balanceB, s.total, `tick ${s.tick}`);
  }
});

test("every random playout terminates and pays the full pot (or pushes)", () => {
  const p = new CrossProtocol();
  for (let seed = 0; seed < 8; seed++) {
    const s = playout(p, mulberry32ForTest(seed));
    assert.equal(p.isTerminal(s), true, `seed ${seed} did not terminate`);
    const { a, b } = p.balances(s);
    assert.equal(a + b, s.total);
    if (s.winner === "A") assert.equal(a, s.total);
    else if (s.winner === "B") assert.equal(b, s.total);
    else {
      assert.equal(a, s.total / 2n); // push
      assert.equal(b, s.total / 2n);
    }
  }
});

test("applyMove throws once the game is terminal", () => {
  const p = new CrossProtocol();
  // Force a winner: drive A north repeatedly along a safe column path is non-trivial,
  // so instead assert the guard via a synthesized terminal state.
  const s = p.initialState(CTX);
  const terminal: CrossState = {
    ...s,
    winner: "A",
    balanceA: s.total,
    balanceB: 0n,
  };
  assert.throws(() => p.applyMove(terminal, { dirA: "north" }, "A"));
});

// Local deterministic RNG for tests (mirrors the protocol's internal one).
function mulberry32ForTest(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd sui-tunnel-ts && node --import tsx --test src/protocol/cross.test.ts`
Expected: FAIL — `CrossProtocol is not a constructor` / undefined exports.

- [ ] **Step 3: Append the protocol implementation to `cross.ts`**

Append to `sui-tunnel-ts/src/protocol/cross.ts`:

```ts
// ============================================
// PROTOCOL STATE
// ============================================

export interface CrossPlayer {
  /** 0 = spawn, increasing = forward. */
  lane: number;
  /** Integer column 0..COLUMN_COUNT-1. */
  col: number;
  /** Furthest lane reached this run (survives respawn). */
  score: number;
  /** Post-respawn immunity countdown (blocks both death and moving). */
  invulnTicks: number;
}

export interface CrossState {
  tick: bigint;
  /** Hazard-field seed; derived from tunnelId; part of encodeState for exact replay. */
  seed: bigint;
  players: [CrossPlayer, CrossPlayer]; // index 0 = A, 1 = B
  winner: Party | null;
  balanceA: bigint;
  balanceB: bigint;
  total: bigint;
}

/** One world tick: each side's intended hop (or undefined = stay). */
export interface CrossMove {
  dirA?: CrossDir;
  dirB?: CrossDir;
}

const DOMAIN = protocolDomain("cross.v1");

function spawnPlayer(): CrossPlayer {
  return { lane: 0, col: SPAWN_COL, score: 0, invulnTicks: 0 };
}

/** Deterministic 32-bit seed from a tunnel object id string. */
function seedFromTunnelId(tunnelId: string): bigint {
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < tunnelId.length; i++) {
    h ^= tunnelId.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return BigInt(h >>> 0);
}

/** Advance one player one tick: optional hop, log-rescue via inverted-water, then collision/respawn. */
function stepPlayer(
  seed: bigint,
  p: CrossPlayer,
  dir: CrossDir | undefined,
  tick: bigint,
): CrossPlayer {
  // Post-respawn immunity: no move, no death, just tick down.
  if (p.invulnTicks > 0) {
    return {
      lane: p.lane,
      col: p.col,
      score: p.score,
      invulnTicks: p.invulnTicks - 1,
    };
  }
  let lane = p.lane;
  let col = p.col;
  // You may NOT voluntarily hop into a known-lethal cell (reference rule).
  if (dir) {
    const [nl, nc] = destOf(lane, col, dir);
    if (!isLethal(seed, nc, nl, tick)) {
      lane = nl;
      col = nc;
    }
  }
  const score = Math.max(p.score, lane);
  // Standing-cell death: e.g. the log you stood on drifted away (water), or a car swept in.
  if (isLethal(seed, col, lane, tick)) {
    return { lane: 0, col: SPAWN_COL, score, invulnTicks: RESPAWN_INVULN };
  }
  return { lane, col, score, invulnTicks: 0 };
}

/** Greedy bot dir for player index `i`: prefer forward, dodge sideways, avoid back, else stay. */
function greedyDir(
  s: CrossState,
  i: number,
  rng: () => number,
): CrossDir | undefined {
  const p = s.players[i];
  if (p.invulnTicks > 0) return undefined;
  const tick = s.tick + 1n;
  const order: CrossDir[] =
    rng() < 0.5 ? ["north", "east", "west"] : ["north", "west", "east"];
  for (const d of order) {
    const [nl, nc] = destOf(p.lane, p.col, d);
    if (!isLethal(s.seed, nc, nl, tick)) return d;
  }
  // Staying put is fine if our current cell survives the next tick.
  if (!isLethal(s.seed, p.col, p.lane, tick)) return undefined;
  // Forced: accept any non-lethal cell, including backward.
  for (const d of ["north", "east", "west", "south"] as CrossDir[]) {
    const [nl, nc] = destOf(p.lane, p.col, d);
    if (!isLethal(s.seed, nc, nl, tick)) return d;
  }
  return undefined; // doomed this tick; will respawn
}

// ============================================
// PROTOCOL
// ============================================

export class CrossProtocol implements Protocol<CrossState, CrossMove> {
  readonly name = "cross.v1";

  initialState(ctx: ProtocolContext): CrossState {
    return {
      tick: 0n,
      seed: seedFromTunnelId(ctx.tunnelId),
      players: [spawnPlayer(), spawnPlayer()],
      winner: null,
      balanceA: ctx.initialBalances.a,
      balanceB: ctx.initialBalances.b,
      total: ctx.initialBalances.a + ctx.initialBalances.b,
    };
  }

  applyMove(state: CrossState, move: CrossMove, _by: Party): CrossState {
    if (this.isTerminal(state)) {
      throw new Error("game over: the race is already decided");
    }
    const tick = state.tick + 1n;
    const players: [CrossPlayer, CrossPlayer] = [
      stepPlayer(state.seed, state.players[0], move.dirA, tick),
      stepPlayer(state.seed, state.players[1], move.dirB, tick),
    ];

    let winner: Party | null = null;
    const aWon = players[0].lane >= WIN_LANE;
    const bWon = players[1].lane >= WIN_LANE;
    if (aWon && bWon) winner = players[0].score >= players[1].score ? "A" : "B";
    else if (aWon) winner = "A";
    else if (bWon) winner = "B";
    else if (tick >= TICK_CAP) {
      if (players[0].score > players[1].score) winner = "A";
      else if (players[1].score > players[0].score) winner = "B";
      else winner = null; // push at the cap
    }

    let balanceA = state.balanceA;
    let balanceB = state.balanceB;
    if (winner === "A") {
      balanceA = state.total;
      balanceB = 0n;
    } else if (winner === "B") {
      balanceA = 0n;
      balanceB = state.total;
    }
    return { ...state, tick, players, winner, balanceA, balanceB };
  }

  encodeState(s: CrossState): Uint8Array {
    const parts: Uint8Array[] = [
      DOMAIN,
      u64ToBeBytes(s.tick),
      u64ToBeBytes(s.seed),
      u64ToBeBytes(s.balanceA),
      u64ToBeBytes(s.balanceB),
    ];
    for (const p of s.players) {
      parts.push(
        u64ToBeBytes(p.lane),
        u64ToBeBytes(p.col),
        u64ToBeBytes(p.score),
        u64ToBeBytes(p.invulnTicks),
      );
    }
    parts.push(
      new Uint8Array([s.winner === "A" ? 1 : s.winner === "B" ? 2 : 0]),
    );
    return concatBytes(parts);
  }

  balances(s: CrossState): Balances {
    return { a: s.balanceA, b: s.balanceB };
  }

  isTerminal(s: CrossState): boolean {
    return s.winner !== null || s.tick >= TICK_CAP;
  }

  randomMove(s: CrossState, _by: Party, rng: () => number): CrossMove | null {
    if (this.isTerminal(s)) return null;
    return { dirA: greedyDir(s, 0, rng), dirB: greedyDir(s, 1, rng) };
  }
}
```

- [ ] **Step 4: Add the SDK export**

Modify `sui-tunnel-ts/src/protocol/index.ts` — add after the `quantumPoker` line:

```ts
export * from "./cross";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd sui-tunnel-ts && node --import tsx --test src/protocol/cross.test.ts`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 6: Commit**

```bash
cd /Users/realestzan/Projects/code/dopamint-arena
git add sui-tunnel-ts/src/protocol/cross.ts sui-tunnel-ts/src/protocol/cross.test.ts sui-tunnel-ts/src/protocol/index.ts
git commit -m "feat(sdk): CrossProtocol — deterministic lane-race over a tunnel"
```

---

### Task 3: Frontend pure session-core

**Files:**

- Create: `frontend/src/games/chickenCross/session-core.ts`
- Test: `frontend/src/games/chickenCross/session-core.test.ts`

**Interfaces:**

- Consumes (type-only): `Party` from `sui-tunnel-ts/protocol/Protocol`; `CrossProtocol`, `CrossState`, `CrossMove` from `sui-tunnel-ts/protocol/cross`; `OffchainTunnel` from `sui-tunnel-ts/core/tunnel`.
- Produces: `CrossView { tick:number; seed:number; players:{lane:number;col:number;score:number}[]; winner:"A"|"B"|null; balanceA:number; balanceB:number }`; `SessionResult = "A" | "B" | "push"`; `stepSession(protocol, tunnel, rng):boolean`; `deriveView(state):CrossView`; `sessionResult(state):SessionResult`. The `seed` field lets the Vite-only board render hazards aligned to the protocol's collisions.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/games/chickenCross/session-core.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
// Runtime SDK imports use RELATIVE .ts paths (tsx ignores the vite alias / tsconfig paths at
// runtime). This mirrors frontend/src/games/blackjack/session-core.test.ts exactly.
import {
  CrossProtocol,
  MIN_STAKE,
} from "../../../../sui-tunnel-ts/src/protocol/cross.ts";
import { OffchainTunnel } from "../../../../sui-tunnel-ts/src/core/tunnel.ts";
import { createParticipant } from "../../../../sui-tunnel-ts/src/core/keys.ts";
import { stepSession, deriveView, sessionResult } from "./session-core.ts";

function freshTunnel() {
  const a = createParticipant("a");
  const b = createParticipant("b");
  const protocol = new CrossProtocol();
  const tunnel = OffchainTunnel.selfPlay(
    protocol,
    "0xfeed",
    a.keyPair,
    b.keyPair,
    a.address,
    b.address,
    { a: MIN_STAKE, b: MIN_STAKE },
  );
  return { protocol, tunnel };
}

test("stepSession advances the tunnel and stops at terminal", () => {
  const { protocol, tunnel } = freshTunnel();
  let steps = 0;
  while (stepSession(protocol, tunnel, Math.random) && steps < 1000) steps++;
  assert.equal(protocol.isTerminal(tunnel.state), true);
});

test("deriveView flattens players and balances to numbers", () => {
  const { tunnel } = freshTunnel();
  const v = deriveView(tunnel.state);
  assert.equal(v.players.length, 2);
  assert.equal(typeof v.players[0].lane, "number");
  assert.equal(typeof v.balanceA, "number");
});

test("sessionResult maps a terminal state to A | B | push", () => {
  const { protocol, tunnel } = freshTunnel();
  while (stepSession(protocol, tunnel, Math.random)) {
    /* run to terminal */
  }
  const r = sessionResult(tunnel.state);
  assert.ok(r === "A" || r === "B" || r === "push");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && node --import tsx --test "src/games/chickenCross/session-core.test.ts"`
Expected: FAIL — `Cannot find module './session-core.ts'`.

> Note: the test imports the runtime-safe SDK engine (`OffchainTunnel`, `CrossProtocol`, `createParticipant`) via **relative `.ts` paths** — exactly like `frontend/src/games/blackjack/session-core.test.ts` does (`../../../../sui-tunnel-ts/src/...`). tsx does NOT honor the vite alias or tsconfig `paths` at runtime, so the bare `sui-tunnel-ts/...` specifier only works for `import type` (erased at runtime, resolved by tsconfig `paths` during `tsc`). Never import a Vite-only module here.

- [ ] **Step 3: Write the session-core**

Create `frontend/src/games/chickenCross/session-core.ts`:

```ts
/**
 * Pure driver for a bot-vs-bot Chicken Cross tunnel session. No React, no timers, no
 * Vite-only imports — only the SDK engine (erased types + the runtime-safe OffchainTunnel),
 * so it is trivially unit-tested under tsx. The React hook owns keypairs, the timer, the
 * on-chain open/close, and telemetry. CrossBoard.tsx (Vite-only) owns hazard rendering.
 */
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import type {
  CrossProtocol,
  CrossState,
  CrossMove,
} from "sui-tunnel-ts/protocol/cross";
import type { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";

/** Flat, render-friendly snapshot of a CrossState (bigints -> numbers). */
export interface CrossView {
  tick: number;
  /** Hazard-field seed (same value the protocol uses) so the board renders aligned hazards. */
  seed: number;
  players: { lane: number; col: number; score: number }[];
  winner: "A" | "B" | null;
  balanceA: number;
  balanceB: number;
}

/** Which bot won the race (or a push at the tick cap). */
export type SessionResult = "A" | "B" | "push";

/**
 * Advance the session by one world tick. Returns false when the race is terminal (the
 * caller then stops the timer and settles). `by` alternates only for signing attribution;
 * the protocol advances the whole world from the move's dirA/dirB.
 */
export function stepSession(
  protocol: CrossProtocol,
  tunnel: OffchainTunnel<CrossState, CrossMove>,
  rng: () => number,
): boolean {
  const state = tunnel.state;
  if (protocol.isTerminal(state)) return false;
  const by: Party = state.tick % 2n === 0n ? "A" : "B";
  const move = protocol.randomMove(state, by, rng);
  if (!move) return false;
  tunnel.step(move, by);
  return true;
}

export function deriveView(state: CrossState): CrossView {
  return {
    tick: Number(state.tick),
    seed: Number(state.seed),
    players: state.players.map((p) => ({
      lane: p.lane,
      col: p.col,
      score: p.score,
    })),
    winner: state.winner,
    balanceA: Number(state.balanceA),
    balanceB: Number(state.balanceB),
  };
}

export function sessionResult(state: CrossState): SessionResult {
  if (state.winner === "A") return "A";
  if (state.winner === "B") return "B";
  return "push";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && node --import tsx --test "src/games/chickenCross/session-core.test.ts"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/realestzan/Projects/code/dopamint-arena
git add frontend/src/games/chickenCross/session-core.ts frontend/src/games/chickenCross/session-core.test.ts
git commit -m "feat(web): chicken-cross pure session-core + tests"
```

---

### Task 4: Frontend integration hook

**Files:**

- Create: `frontend/src/games/chickenCross/useChickenCrossSession.ts`

**Interfaces:**

- Consumes: `openAndFundSelfPlay`, `readCreatedAt`, `closeCooperative` from `../../onchain/tunnelTx`; `getControlPlaneClient`, `RegisterSessionResult` from `../../backend/controlPlane`; `useTelemetry` from `../../telemetry/TelemetryProvider`; `OffchainTunnel`, `createParticipant`; `CrossProtocol`, `MIN_STAKE`, `CrossState`, `CrossMove`; `deriveView`, `sessionResult`, `stepSession`, `CrossView`, `SessionResult` from `./session-core`.
- Produces: `useChickenCrossSession(): { status; view; result; stake; error; start; reset }` with `status: "idle"|"funding"|"playing"|"settling"|"settled"|"error"`.

- [ ] **Step 1: Write the hook**

Create `frontend/src/games/chickenCross/useChickenCrossSession.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { createParticipant } from "sui-tunnel-ts/core/keys";
import { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import { CrossProtocol, MIN_STAKE } from "sui-tunnel-ts/protocol/cross";
import type { CrossState, CrossMove } from "sui-tunnel-ts/protocol/cross";
import { useTelemetry } from "../../telemetry/TelemetryProvider";
import {
  getControlPlaneClient,
  type RegisterSessionResult,
} from "../../backend/controlPlane";
import {
  closeCooperative,
  openAndFundSelfPlay,
  readCreatedAt,
} from "../../onchain/tunnelTx";
import {
  deriveView,
  sessionResult,
  stepSession,
  type CrossView,
  type SessionResult,
} from "./session-core";

/** Milliseconds between world ticks (animation pacing). Faster than blackjack — hops are quick. */
const STEP_MS = 300;

export type SessionStatus =
  | "idle"
  | "funding"
  | "playing"
  | "settling"
  | "settled"
  | "error";

export interface ChickenCrossSession {
  status: SessionStatus;
  view: CrossView | null;
  result: SessionResult | null;
  stake: number;
  error: string | null;
  start: (stake: number) => void;
  reset: () => void;
}

export function useChickenCrossSession(): ChickenCrossSession {
  const { report } = useTelemetry();
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();

  const [status, setStatus] = useState<SessionStatus>("idle");
  const [view, setView] = useState<CrossView | null>(null);
  const [result, setResult] = useState<SessionResult | null>(null);
  const [stake, setStake] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  const protocolRef = useRef<CrossProtocol | null>(null);
  const tunnelRef = useRef<OffchainTunnel<CrossState, CrossMove> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stakeRef = useRef<bigint>(0n);

  // Control-plane session (ADR-0002): best-effort, off the per-move loop.
  const sessionRef = useRef<RegisterSessionResult | null>(null);
  const moveCountRef = useRef(0);
  const actionsRef = useRef(0);
  const lastHeartbeatRef = useRef(0);

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    stopTimer();
    protocolRef.current = null;
    tunnelRef.current = null;
    sessionRef.current = null;
    moveCountRef.current = 0;
    actionsRef.current = 0;
    lastHeartbeatRef.current = 0;
    report.setActive(0);
    setStatus("idle");
    setView(null);
    setResult(null);
    setStake(0);
    setError(null);
  }, [report, stopTimer]);

  const start = useCallback(
    (nextStake: number) => {
      stopTimer();
      const floored = Math.floor(nextStake);
      const stakeBig = BigInt(
        Math.max(Number(MIN_STAKE), Number.isFinite(floored) ? floored : 0),
      );
      stakeRef.current = stakeBig;
      setStake(Number(stakeBig));
      setResult(null);
      setError(null);

      if (!account) {
        setError("connect a wallet to stake the tunnel");
        setStatus("error");
        return;
      }
      const signExec = async (
        tx: Parameters<typeof signAndExecute>[0]["transaction"],
      ) => {
        const r = await signAndExecute({ transaction: tx });
        return { digest: r.digest };
      };
      const reads = client as unknown as Parameters<
        typeof openAndFundSelfPlay
      >[0]["reads"];

      (async () => {
        try {
          const a = createParticipant("chicken-a");
          const b = createParticipant("chicken-b");
          const protocol = new CrossProtocol();

          // Open + fund BOTH bot seats in ONE wallet signature (create_and_fund).
          setStatus("funding");
          const tunnelId = await openAndFundSelfPlay({
            reads,
            signExec,
            partyA: { address: a.address, publicKey: a.keyPair.publicKey },
            partyB: { address: b.address, publicKey: b.keyPair.publicKey },
            aAmount: stakeBig,
            bAmount: stakeBig,
          });
          const createdAt = await readCreatedAt(reads, tunnelId);

          const tunnel = OffchainTunnel.selfPlay(
            protocol,
            tunnelId,
            a.keyPair,
            b.keyPair,
            a.address,
            b.address,
            { a: stakeBig, b: stakeBig },
          );
          tunnel.onUpdate = (_u, bytes) =>
            report.bumpCounters({
              updates: 1,
              signatures: 2,
              verifications: 2,
              bytes,
            });

          protocolRef.current = protocol;
          tunnelRef.current = tunnel;
          report.bumpCounters({ tunnelsOpened: 1 });
          report.setActive(2);
          setView(deriveView(tunnel.state));
          setStatus("playing");

          sessionRef.current = null;
          moveCountRef.current = 0;
          actionsRef.current = 0;
          lastHeartbeatRef.current = Date.now();
          const cp = getControlPlaneClient();
          cp.registerSession({
            userAddress: account.address,
            game: "chicken-cross",
            tunnels: [{ tunnelId, partyA: a.address, partyB: b.address }],
          })
            .then((s) => {
              sessionRef.current = s;
            })
            .catch((e) =>
              console.error("[chicken-cross] registerSession failed:", e),
            );

          const flushHeartbeat = (force: boolean) => {
            const s = sessionRef.current;
            if (!s || actionsRef.current === 0) return;
            const now = Date.now();
            const windowMs = now - lastHeartbeatRef.current;
            if (!force && windowMs < 1000) return;
            const actionsDelta = actionsRef.current;
            actionsRef.current = 0;
            lastHeartbeatRef.current = now;
            cp.sendHeartbeat(s.sessionId, s.statsToken, {
              tunnelId,
              nonce: String(moveCountRef.current),
              actionsDelta,
              windowMs: Math.max(1, windowMs),
            }).catch((e) =>
              console.error("[chicken-cross] heartbeat failed:", e),
            );
          };

          const settleOnChain = async () => {
            setStatus("settling");
            report.bumpCounters({ tunnelsClosed: 1, settlements: 1 });
            report.setActive(0);
            const r = sessionResult(tunnel.state);
            setResult(r);
            try {
              const settlement = tunnel.buildSettlement(createdAt);
              await closeCooperative({ signExec, tunnelId, settlement });
              setStatus("settled");
            } catch (e) {
              console.error("[chicken-cross] on-chain close failed:", e);
              setError(String((e as Error)?.message ?? e));
              setStatus("error");
            }
          };

          timerRef.current = setInterval(() => {
            const p = protocolRef.current;
            const t = tunnelRef.current;
            if (!p || !t) return;
            const wasTerminal = p.isTerminal(t.state);
            const moved = stepSession(p, t, Math.random);
            if (moved) {
              moveCountRef.current += 1;
              actionsRef.current += 1;
            }
            setView(deriveView(t.state));

            // On the deciding tick, push a panel txn for the winner.
            if (
              moved &&
              !wasTerminal &&
              p.isTerminal(t.state) &&
              t.state.winner
            ) {
              report.pushTxn({
                time: new Date().toLocaleTimeString("en-GB"),
                bot: t.state.winner === "A" ? "Chicken A" : "Chicken B",
                type: "Chicken Cross Win",
                status: "Success",
                amount: `+$${Number(t.state.total).toFixed(2)}`,
              });
            }

            flushHeartbeat(false);

            if (!moved || p.isTerminal(t.state)) {
              stopTimer();
              flushHeartbeat(true);
              void settleOnChain();
            }
          }, STEP_MS);
        } catch (e) {
          stopTimer();
          report.setActive(0);
          setError(String((e as Error)?.message ?? e));
          setStatus("error");
        }
      })();
    },
    [account, client, signAndExecute, report, stopTimer],
  );

  useEffect(() => stopTimer, [stopTimer]);

  return { status, view, result, stake, error, start, reset };
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && pnpm typecheck`
Expected: PASS (no errors). If `report.pushTxn` field names mismatch, align them to `frontend/src/telemetry/TelemetryProvider.tsx` (open it and match the `pushTxn` row shape exactly — it is the same shape blackjack uses).

- [ ] **Step 3: Commit**

```bash
cd /Users/realestzan/Projects/code/dopamint-arena
git add frontend/src/games/chickenCross/useChickenCrossSession.ts
git commit -m "feat(web): chicken-cross self-play hook over a real tunnel"
```

---

### Task 5: Frontend UI (BetPanel, CrossBoard, Window, CSS)

**Files:**

- Create: `frontend/src/games/chickenCross/components/BetPanel.tsx`
- Create: `frontend/src/games/chickenCross/components/CrossBoard.tsx`
- Create: `frontend/src/games/chickenCross/cross.css`
- Create: `frontend/src/games/chickenCross/ChickenCrossWindow.tsx`

**Interfaces:**

- Consumes: `useChickenCrossSession` (Task 4); `CrossView` (Task 3); runtime `laneKind`, `hazardsAt`, `COLUMN_COUNT`, `WIN_LANE` from `sui-tunnel-ts/protocol/cross` (Vite-only, allowed in a `.tsx` component); `GameWindowProps` from `../types`.
- Produces: `ChickenCrossWindow: ComponentType<GameWindowProps>`.

- [ ] **Step 1: Write the BetPanel**

Create `frontend/src/games/chickenCross/components/BetPanel.tsx`:

```tsx
import { useState } from "react";
import { WIN_LANE } from "sui-tunnel-ts/protocol/cross";
import "../cross.css";

/** Idle-state control: the player sets a stake; two bot chickens race it out. */
export function BetPanel({ onStart }: { onStart: (stake: number) => void }) {
  const [stake, setStake] = useState<number>(500);
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-arena-bg p-4 text-center">
      <h2 className="text-gold text-lg font-extrabold uppercase tracking-widest">
        Chicken Cross
      </h2>
      <p className="text-sm text-arena-text">
        Set a stake — two bot chickens race across the lanes.
      </p>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wider text-arena-muted">
          Stake
        </span>
        <input
          id="chicken-cross-stake"
          name="stake"
          type="number"
          min={100}
          step={100}
          value={stake}
          onChange={(e) => setStake(Number(e.target.value) || 0)}
          className="w-40 rounded border border-arena-edge bg-arena-bg px-2 py-1.5 text-center font-mono text-arena-text"
        />
      </label>
      <button
        onClick={() => onStart(stake)}
        className="gold-glow-hover rounded border border-amber-500 bg-arena-accent px-6 py-2 font-bold uppercase tracking-widest text-arena-bg transition-all hover:opacity-90"
      >
        Race
      </button>
      <p className="max-w-xs text-[11px] text-arena-muted">
        Each tick is co-signed over a Sui tunnel; first chicken to lane{" "}
        {WIN_LANE} takes the pot.
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Write the CrossBoard**

Create `frontend/src/games/chickenCross/components/CrossBoard.tsx`:

```tsx
import {
  laneKind,
  hazardsAt,
  COLUMN_COUNT,
  WIN_LANE,
} from "sui-tunnel-ts/protocol/cross";
import "../cross.css";
import type { CrossView, SessionResult } from "../session-core";

const LANE_BG: Record<string, string> = {
  grass: "#1f3b1f",
  road: "#2b2b2b",
  water: "#16324a",
  rails: "#3a2f1a",
};

/** A small window of lanes around the leader, drawn top = forward. */
function visibleLanes(view: CrossView): number[] {
  const lead = Math.max(view.players[0]?.lane ?? 0, view.players[1]?.lane ?? 0);
  const min = Math.max(0, lead - 3);
  const max = Math.min(WIN_LANE, lead + 7);
  const out: number[] = [];
  for (let L = max; L >= min; L--) out.push(L); // forward at the top
  return out;
}

export function CrossBoard({
  view,
  result,
  settled,
  onPlayAgain,
  seed,
}: {
  view: CrossView;
  result: SessionResult | null;
  settled: boolean;
  onPlayAgain: () => void;
  seed: number;
}) {
  const lanes = visibleLanes(view);
  return (
    <div className="flex h-full w-full flex-col gap-2 bg-arena-bg p-3">
      <div className="flex items-center justify-between text-[11px] text-arena-muted">
        <span>
          🐔 A · lane {view.players[0]?.lane ?? 0} · ${view.balanceA}
        </span>
        <span>tick {view.tick}</span>
        <span>
          🐔 B · lane {view.players[1]?.lane ?? 0} · ${view.balanceB}
        </span>
      </div>

      <div className="cross-grid flex-1 overflow-hidden rounded border border-arena-edge">
        {lanes.map((L) => {
          const kind = laneKind(L);
          const hazards = hazardsAt(BigInt(seed), L, BigInt(view.tick));
          return (
            <div
              key={L}
              className="cross-lane"
              style={{ background: LANE_BG[kind] }}
            >
              {Array.from({ length: COLUMN_COUNT }).map((_, col) => {
                const onHaz = hazards.some((s) => {
                  const c = col + 0.5;
                  return [c, c - COLUMN_COUNT, c + COLUMN_COUNT].some(
                    (cc) => cc > s.center - s.half && cc < s.center + s.half,
                  );
                });
                const aHere =
                  view.players[0]?.lane === L && view.players[0]?.col === col;
                const bHere =
                  view.players[1]?.lane === L && view.players[1]?.col === col;
                const haz = onHaz
                  ? kind === "road"
                    ? "🚗"
                    : kind === "rails"
                      ? "🚆"
                      : "🪵"
                  : "";
                return (
                  <div key={col} className="cross-cell">
                    {aHere ? "🐔" : bHere ? "🐤" : haz}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {settled && (
        <div className="flex flex-col items-center gap-2 py-1">
          <p className="text-gold text-sm font-bold uppercase tracking-widest">
            {result === "push"
              ? "Push — stakes returned"
              : `Chicken ${result} wins the pot!`}
          </p>
          <button
            onClick={onPlayAgain}
            className="rounded border border-arena-edge px-3 py-1.5 text-sm text-arena-text hover:opacity-90"
          >
            Play Again
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Write the CSS**

Create `frontend/src/games/chickenCross/cross.css`:

```css
.cross-grid {
  display: flex;
  flex-direction: column;
}
.cross-lane {
  display: grid;
  grid-template-columns: repeat(9, 1fr);
  flex: 1 1 0;
  min-height: 26px;
}
.cross-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  line-height: 1;
  border-right: 1px solid rgba(255, 255, 255, 0.04);
  transition: background 120ms linear;
}
```

- [ ] **Step 4: Write the Window**

Create `frontend/src/games/chickenCross/ChickenCrossWindow.tsx`:

```tsx
import type { GameWindowProps } from "../types";
import { useChickenCrossSession } from "./useChickenCrossSession";
import { BetPanel } from "./components/BetPanel";
import { CrossBoard } from "./components/CrossBoard";

/** Bot-vs-bot Chicken Cross over a REAL Sui tunnel: the wallet opens+funds it (one signature),
 *  the bots co-sign each tick off-chain, and the winner settles back on-chain. */
export function ChickenCrossWindow(_props: GameWindowProps) {
  const { status, view, result, error, start, reset } =
    useChickenCrossSession();

  if (status === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
        <p className="text-sm text-red-400">
          {error ?? "something went wrong"}
        </p>
        <button
          onClick={reset}
          className="rounded border border-arena-edge px-3 py-1.5 text-sm"
        >
          Back
        </button>
      </div>
    );
  }

  if (status === "funding") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-arena-muted">
        Opening + funding the tunnel on-chain… approve in your wallet.
      </div>
    );
  }

  if (status === "idle" || !view) {
    return <BetPanel onStart={start} />;
  }

  // `view.seed` is the protocol's hazard-field seed, so the board's cosmetic hazards line up
  // exactly with the collisions the protocol computed.
  return (
    <CrossBoard
      view={view}
      result={result}
      settled={status === "settled"}
      onPlayAgain={reset}
      seed={view.seed}
    />
  );
}
```

- [ ] **Step 5: Typecheck**

Run: `cd frontend && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/realestzan/Projects/code/dopamint-arena
git add frontend/src/games/chickenCross/
git commit -m "feat(web): chicken-cross window, 2D board, bet panel, styles"
```

---

### Task 6: Register the game + full gate

**Files:**

- Create: `frontend/src/games/chickenCross/index.ts`
- Modify: `frontend/src/games/index.ts` (add one import line)

**Interfaces:**

- Consumes: `register` from `../registry`; `ChickenCrossWindow` from `./ChickenCrossWindow`.
- Produces: a registered `GameModule` with id `chicken-cross` (auto-discovered by `Desktop.tsx`).

- [ ] **Step 1: Write the registration**

Create `frontend/src/games/chickenCross/index.ts`:

```ts
import { register } from "../registry";
import { ChickenCrossWindow } from "./ChickenCrossWindow";

register({
  id: "chicken-cross",
  name: "Chicken Cross",
  icon: "🐔",
  Window: ChickenCrossWindow,
});
```

- [ ] **Step 2: Add the barrel import**

Modify `frontend/src/games/index.ts` — add a line (position decides tiling order; place after `./blackjack` so it tiles early):

```ts
import "./chickenCross";
```

- [ ] **Step 3: Full gate — SDK tests, typecheck, build**

```bash
cd /Users/realestzan/Projects/code/dopamint-arena/sui-tunnel-ts && node --import tsx --test src/protocol/cross.test.ts
cd /Users/realestzan/Projects/code/dopamint-arena/frontend && node --import tsx --test "src/games/chickenCross/session-core.test.ts"
cd /Users/realestzan/Projects/code/dopamint-arena/frontend && pnpm typecheck
cd /Users/realestzan/Projects/code/dopamint-arena/frontend && pnpm build
```

Expected: all PASS; `pnpm build` completes (the duplicate-id guard in `registry.ts` confirms `chicken-cross` registered exactly once).

- [ ] **Step 4: Commit**

```bash
cd /Users/realestzan/Projects/code/dopamint-arena
git add frontend/src/games/chickenCross/index.ts frontend/src/games/index.ts
git commit -m "feat(web): register chicken-cross in the arena desktop"
```

---

## Manual verification (testnet, after Task 6)

1. `cd frontend && pnpm dev`; open the app, connect a testnet wallet with SUI.
2. The Chicken Cross window appears on the desktop (🐔). Click **Race**, set a stake, approve the one funding popup.
3. Watch the two chickens hop; the live TPS panel ticks up (each hop = a co-signed update).
4. On a win, approve the close popup; confirm "Chicken A/B wins" and that the winning bot seat holds the pot on-chain (check the close tx digest).

## Self-review notes (coverage vs spec)

- Spec §5 CrossProtocol → Tasks 1–2 (hazards/collision + state machine/encode/balances/terminal/randomMove). ✓
- Spec §6 game→tunnel mapping → enforced by `balances` conservation + terminal payout (Task 2 tests). ✓
- Spec §7 self-play flow → Task 4 hook (mirrors `useBlackjackSession.ts`). ✓
- Spec §8 rendering → Task 5 `CrossBoard` (runtime SDK import isolated to the Vite component). ✓
- Spec §9 control-plane → Task 4 `registerSession`/`sendHeartbeat` with `game:"chicken-cross"`, best-effort. ✓
- Spec §10 testing → Tasks 1–3 unit tests; Task 6 full gate. ✓
- Spec §11 deferred PvP → not built (correct); no PvP files in this plan. ✓
- Known deferral: positional log-carry drift is simplified to inverted-water survival (a log under you keeps you alive; no sideways push). Collision faithfulness preserved; sideways drift is a future refinement. Flagged here so it isn't mistaken for a miss.

```

```
