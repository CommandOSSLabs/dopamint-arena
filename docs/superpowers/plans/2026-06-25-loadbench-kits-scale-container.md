# loadbench: Kit-Driven Bench + Max-Scale Parallelism + Container — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evolve `tools/loadbench/` so it (1) drives each game through its canonical frontend **game kit** (settlements byte-identical to the shipped game), (2) saturates all allocated cores via a `worker_threads` fleet with memory-capped `auto` defaults, (3) reports avg/peak CPU + memory, and (4) runs as a resource-limited Docker compose service.

**Architecture:** Phase A swaps the move engine: `playMatch` takes a `GameKit` and drives moves via per-seat `bot.plan(state)` instead of `protocol.randomMove`. Phase B wraps the kit-driven match in a worker-thread fleet (`swarm` spawns N workers, each running its slice), adds a process-API resource monitor, and ships a `Dockerfile` + compose `loadbench` service. Phase A lands first (it changes the engine and playable set); Phase B builds on it.

**Tech Stack:** bun + TypeScript; `frontend/src/agent` game kits (`GAME_KITS`); `sui-tunnel-ts/src` engine; `node:worker_threads`; `@mysten/sui`; Docker Compose.

## Global Constraints

- **Toolchain:** `tools/loadbench/` is a bun package — `bun test`, co-located `*.test.ts`. Do NOT convert `sui-tunnel-ts/` or `frontend/` off their toolchains; both are import-only here.
- **Kit fidelity:** the bench MUST drive each game through `GAME_KITS` (`frontend/src/agent/gameKit.ts`) — the same FE protocol class the human `usePvp*` hook uses — not `createBehaviorProtocol`. The 6 playable games are `ticTacToe, blackjack, battleship, quantumPoker, bombIt, cross`. `payments`/`chat` are removed.
- **Alias:** the frontend kits import `sui-tunnel-ts` via bare specifiers; resolve them with a tsconfig `paths` map in loadbench (bun honors tsconfig paths). Existing loadbench files keep their relative `../../../sui-tunnel-ts/src/...` imports. The tic-tac-toe kit also pulls in the nested `@ttt/shared` package, whose own `tsconfig.json` gets a minimal committed `paths` entry for `sui-tunnel-ts` (bun resolves paths per-file from the nearest config). Editing that one config is permitted as the install-free portable fix; no other `frontend/` source is touched.
- **Do NOT revert** the `sui-tunnel-ts/src/agents/behaviors.ts` `bombIt`/`cross` edit — the kits import `sui-tunnel-ts/agents/behaviors`.
- **auto/max:** `--workers auto` = all cores; `--concurrency auto` = pushed high but **memory-capped** (`workers × concurrency` bounded by a memory budget, default 70% of `os.totalmem()`), so a 192-vCPU box maxes throughput instead of OOM-ing.
- **Resource metrics:** process APIs only (`process.cpuUsage()`, `process.memoryUsage().rss`); report avg + peak CPU and RSS.
- **Container:** `--channel local` only (offchain + onchain); `--channel relay` stays host-side. RPC URL is env-driven (`SUI_RPC_URL`).
- **Commits:** Conventional Commits, subject ≤ 50 chars, no AI attribution.

**Verified interfaces (against the live source):**

```ts
// frontend/src/agent/gameKit.ts
type GameId = "tictactoe"|"blackjack"|"battleship"|"quantum-poker"|"bomb-it"|"chicken-cross";
interface BotContext { rngForSeat(seat: Party): () => number }
interface GameKit<S,M> { id: GameId; protocol: Protocol<S,M>; stateHash(s:S): StateHash;
  createBot(seat: Party, ctx: BotContext): GameBot<S,M>; defaultStake: bigint }
interface GameBot<S,M> { plan(state:S): M|null; confirm(state:S, move:M): void; abort(): void }
const GAME_KITS: Record<GameId, GameKit<unknown,unknown>>;   // 6 games, pre-constructed
// sui-tunnel-ts/src/protocol/Protocol.ts -> type Party = "A"|"B"; Protocol.isTerminal(state)
// tools/loadbench/src/match.ts (current) -> playMatch(protocol, seats, transports, opts); makeSeats; bigintSafeCodec; mulberry32; proposeAndAwait
```

From `tools/loadbench/src/`, the frontend kit path is `../../../frontend/src/agent/gameKit`; the sui-tunnel-ts path is `../../../sui-tunnel-ts/src/...`.

---

## Phase A — Kit-driven match engine

### Task 1 (A1): Resolve the `sui-tunnel-ts` alias + kit-import gate

**Files:**
- Modify: `tools/loadbench/tsconfig.json`
- Modify: `frontend/src/games/ticTacToe/packages/shared/tsconfig.json` (add `baseUrl`+`paths` so the ttt shared package resolves its own `sui-tunnel-ts` `file:` dep from source — `sui-tunnel-ts`'s `package.json main` points at an unbuilt `dist/`, and bun applies tsconfig `paths` per-file from the nearest config; this is the portable, install-free fix, no node_modules wrapper)
- Test: `tools/loadbench/src/kitImport.test.ts`

**Interfaces:**
- Produces: a working bun import of `../../../frontend/src/agent/gameKit` (`GAME_KITS`, types).

- [ ] **Step 1: Add tsconfig paths**

Edit `tools/loadbench/tsconfig.json` `compilerOptions` to add `baseUrl` + `paths` (keep the existing options):

```jsonc
{
  "compilerOptions": {
    "target": "ESNext", "module": "ESNext", "moduleResolution": "bundler",
    "strict": true, "skipLibCheck": true, "types": ["bun-types"], "allowJs": false,
    "baseUrl": ".",
    "paths": {
      "sui-tunnel-ts": ["../../sui-tunnel-ts/src/index.ts"],
      "sui-tunnel-ts/*": ["../../sui-tunnel-ts/src/*"],
      "@/*": ["../../frontend/src/*"],
      "@ttt/shared": ["../../frontend/src/games/ticTacToe/packages/shared/src/index.ts"],
      "@ttt/shared/*": ["../../frontend/src/games/ticTacToe/packages/shared/src/*"]
    }
  },
  "include": ["src"]
}
```

The frontend kits import via three alias families: `sui-tunnel-ts/*`, `@/*` (→ `frontend/src`), and `@ttt/shared` (the tic-tac-toe shared package). All three are mapped above. The Step 2 import gate is the backstop: if a kit pulls in a further alias or a browser-only shim (the frontend's vite config stubs `node:crypto` and falls back to `@noble` in-browser — under bun the real `node:crypto` is present, so this should resolve natively), the gate fails loudly and the missing `paths` entry is added (or the offending game is escalated, not stubbed).

- [ ] **Step 2: Write the failing test (kit import gate)**

`tools/loadbench/src/kitImport.test.ts`:
```ts
import { test, expect } from "bun:test";
import { GAME_KITS } from "../../../frontend/src/agent/gameKit";

test("all 6 game kits import under bun with no browser coupling", () => {
  const ids = Object.keys(GAME_KITS).sort();
  expect(ids).toEqual(
    ["blackjack", "bomb-it", "battleship", "chicken-cross", "quantum-poker", "tictactoe"].sort(),
  );
  for (const id of ids) {
    const kit = (GAME_KITS as Record<string, { protocol: unknown; defaultStake: bigint; createBot: unknown }>)[id];
    expect(typeof kit.protocol).toBe("object");
    expect(typeof kit.createBot).toBe("function");
    expect(typeof kit.defaultStake).toBe("bigint");
  }
});
```

- [ ] **Step 3: Run test to verify it fails (then passes once paths resolve)**

Run: `cd tools/loadbench && bun test src/kitImport.test.ts`
Expected first run BEFORE Step 1's paths are in place: FAIL — cannot resolve `sui-tunnel-ts`. After Step 1: PASS.
If it fails because a kit transitively imports browser-only code (`window`/`document`/React), STOP and report which kit — that game is fixed in `frontend/` or dropped (escalate); do not stub it out here.

- [ ] **Step 4: Commit**

```bash
git add tools/loadbench/tsconfig.json tools/loadbench/src/kitImport.test.ts
git commit -m "feat(loadbench): resolve kit alias + import gate"
```

---

### Task 2 (A2): Kit registry (`games.ts` rewrite)

**Files:**
- Modify (rewrite): `tools/loadbench/src/games.ts`
- Modify (rewrite): `tools/loadbench/src/games.test.ts`

**Interfaces:**
- Consumes: `GAME_KITS`, `GameKit`, `GameId` from `../../../frontend/src/agent/gameKit`.
- Produces: `PLAYABLE: readonly string[]`; `isPlayable(game: string): boolean`; `kitFor(game: string): GameKit<unknown, unknown>`; `gameStake(game: string): bigint`.

- [ ] **Step 1: Write the failing test**

`tools/loadbench/src/games.test.ts` (replace the whole file):
```ts
import { test, expect } from "bun:test";
import { PLAYABLE, isPlayable, kitFor, gameStake } from "./games";

test("the 6 real games are playable; removed/unknown ones are not", () => {
  expect([...PLAYABLE].sort()).toEqual(
    ["ticTacToe", "blackjack", "battleship", "quantumPoker", "bombIt", "cross"].sort(),
  );
  expect(isPlayable("blackjack")).toBe(true);
  expect(isPlayable("battleship")).toBe(true);
  expect(isPlayable("payments")).toBe(false);
  expect(isPlayable("chat")).toBe(false);
  expect(isPlayable("slots")).toBe(false);
});

test("kitFor returns the canonical kit; gameStake returns its defaultStake", () => {
  const kit = kitFor("blackjack");
  expect(kit.id).toBe("blackjack");
  expect(gameStake("blackjack")).toBe(kit.defaultStake);
});

test("kitFor throws for an unplayable game", () => {
  expect(() => kitFor("payments")).toThrow(/no kit/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/loadbench && bun test src/games.test.ts`
Expected: FAIL — `kitFor`/`gameStake`/new `PLAYABLE` not present.

- [ ] **Step 3: Rewrite `games.ts`**

```ts
import { GAME_KITS, type GameKit, type GameId } from "../../../frontend/src/agent/gameKit";

/** Bench id -> canonical kit id. The bench drives the real FE protocol class. */
const GAME_TO_KIT: Record<string, GameId> = {
  ticTacToe: "tictactoe",
  blackjack: "blackjack",
  battleship: "battleship",
  quantumPoker: "quantum-poker",
  bombIt: "bomb-it",
  cross: "chicken-cross",
};

export const PLAYABLE = ["ticTacToe", "blackjack", "battleship", "quantumPoker", "bombIt", "cross"] as const;

export function isPlayable(game: string): boolean {
  return game in GAME_TO_KIT;
}

export function kitFor(game: string): GameKit<unknown, unknown> {
  const id = GAME_TO_KIT[game];
  if (!id) throw new Error(`game "${game}" has no kit (playable: ${PLAYABLE.join(", ")})`);
  return GAME_KITS[id];
}

/** Per-seat stake = the kit's default stake; balances are { a: stake, b: stake }. */
export function gameStake(game: string): bigint {
  return kitFor(game).defaultStake;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/loadbench && bun test src/games.test.ts`
Expected: PASS (3 tests). (The all-6-settlement test lands in Task A4, once the driver is kit-based.)

- [ ] **Step 5: Commit**

```bash
git add tools/loadbench/src/games.ts tools/loadbench/src/games.test.ts
git commit -m "feat(loadbench): kit registry for the 6 real games"
```

---

### Task 3 (A3): Bot-driven `playMatch` (`match.ts`)

**Files:**
- Modify: `tools/loadbench/src/match.ts`
- Modify: `tools/loadbench/src/match.test.ts`

**Interfaces:**
- Consumes: `GameKit`, `GameBot`, `BotContext` from `../../../frontend/src/agent/gameKit`; `kitFor` from `./games`; existing `Seats`, `MatchResult`, `makeSeats`, `bigintSafeCodec`, `proposeAndAwait`, `mulberry32`.
- Produces: `playMatch(kit: GameKit<unknown, unknown>, seats: Seats, transports: [Transport, Transport], opts?: { seed?: number; maxMoves?: number }): Promise<MatchResult>` — drives moves via per-seat bots.

- [ ] **Step 1: Update the failing test to a kit**

`tools/loadbench/src/match.test.ts` (replace the body; keep `makeSeats`/`pairLocalChannel` imports):
```ts
import { test, expect } from "bun:test";
import { pairLocalChannel } from "./channels/localChannel";
import { makeSeats, playMatch } from "./match";
import { kitFor, gameStake } from "./games";

test("a blackjack match plays to terminal over the local channel and settles", async () => {
  const stake = gameStake("blackjack");
  const seats = makeSeats("t-1", { a: stake, b: stake }, 1234n);
  const res = await playMatch(kitFor("blackjack"), seats, pairLocalChannel(), { seed: 7, maxMoves: 200 });
  expect(res.moves).toBeGreaterThan(0);
  expect(res.bytes).toBeGreaterThan(0);
  expect(res.latenciesMs.length).toBe(res.moves);
  const s = res.settlement.settlement;
  expect(s.partyABalance + s.partyBBalance).toBe(stake * 2n);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/loadbench && bun test src/match.test.ts`
Expected: FAIL — `playMatch` still takes a `Protocol`, not a `GameKit` (type/usage mismatch or wrong moves).

- [ ] **Step 3: Rewrite the imports and `playMatch` in `match.ts`**

Add near the top (alongside the existing imports):
```ts
import type { GameKit, GameBot, BotContext } from "../../../frontend/src/agent/gameKit";
```
Keep the existing `mulberry32` import (now used for `rngForSeat`). Replace the whole `playMatch` function with:
```ts
export async function playMatch(
  kit: GameKit<unknown, unknown>,
  seats: Seats,
  transports: [Transport, Transport],
  opts: { seed?: number; maxMoves?: number } = {},
): Promise<MatchResult> {
  const protocol = kit.protocol;
  const backend = defaultBackend();
  const aEnd = makeEndpoint(backend, seats.partyA.address, seats.partyA.keyPair, true);
  const aOpp = makeEndpoint(backend, seats.partyB.address, seats.partyB.keyPair, false);
  const bEnd = makeEndpoint(backend, seats.partyB.address, seats.partyB.keyPair, true);
  const bOpp = makeEndpoint(backend, seats.partyA.address, seats.partyA.keyPair, false);
  let bytes = 0;
  const tA = countingTransport(transports[0], (n) => (bytes += n));
  const tB = countingTransport(transports[1], (n) => (bytes += n));
  const dtA = new DistributedTunnel(protocol, { tunnelId: seats.tunnelId, self: aEnd, opponent: aOpp, selfParty: "A", moveCodec: bigintSafeCodec }, tA, seats.balances);
  const dtB = new DistributedTunnel(protocol, { tunnelId: seats.tunnelId, self: bEnd, opponent: bOpp, selfParty: "B", moveCodec: bigintSafeCodec }, tB, seats.balances);
  const seatOf: Record<Party, DistributedTunnel<unknown, unknown>> = { A: dtA, B: dtB };

  const seed = opts.seed ?? 1;
  const ctx: BotContext = {
    rngForSeat: (seat) => mulberry32(seed ^ (seat === "A" ? 0x9e3779b9 : 0x85ebca77)),
  };
  const botOf: Record<Party, GameBot<unknown, unknown>> = {
    A: kit.createBot("A", ctx),
    B: kit.createBot("B", ctx),
  };

  const maxMoves = opts.maxMoves ?? 1000;
  const latenciesMs: number[] = [];
  let moves = 0;
  let ts = seats.createdAt;
  const order: Party[] = ["A", "B"];
  try {
    while (moves < maxMoves && !protocol.isTerminal(dtA.state)) {
      let progressed = false;
      for (const p of order) {
        if (protocol.isTerminal(dtA.state)) break;
        const dt = seatOf[p];
        const move = botOf[p].plan(dt.state);
        if (move === null) continue;
        ts += 1n;
        latenciesMs.push(await proposeAndAwait(dt, move, ts));
        botOf[p].confirm(dt.state, move);
        moves++;
        progressed = true;
        if (moves >= maxMoves) break;
      }
      if (!progressed) break;
    }
  } catch (e) {
    botOf.A.abort();
    botOf.B.abort();
    throw e;
  }

  const root = blake2b256(new TextEncoder().encode(`dopamint:${seats.tunnelId}`));
  const halfA = dtA.buildSettlementHalfWithRoot(seats.createdAt, root, 0n);
  const halfB = dtB.buildSettlementHalfWithRoot(seats.createdAt, root, 0n);
  const settlement = dtA.combineSettlementWithRoot(halfA.settlement, halfA.sigSelf, halfB.sigSelf);
  return { moves, bytes, latenciesMs, settlement };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/loadbench && bun test src/match.test.ts`
Expected: PASS. If a kit move carries a field the `bigintSafeCodec` can't serialize, extend that codec the same way the `__bigint__`/`__bytes__` sentinels already handle bigint/Uint8Array, and note it.

- [ ] **Step 5: Commit**

```bash
git add tools/loadbench/src/match.ts tools/loadbench/src/match.test.ts
git commit -m "feat(loadbench): drive matches via game-kit bots"
```

---

### Task 4 (A4): Wire `runMatch` + all-6 settlement + smoke

**Files:**
- Modify: `tools/loadbench/src/runMatch.ts`
- Modify: `tools/loadbench/src/games.test.ts` (add the all-6 settlement case)
- Modify: `tools/loadbench/src/smoke.test.ts`

**Interfaces:**
- Consumes: `kitFor`, `gameStake` (A2); `playMatch` (A3).

- [ ] **Step 1: Add the all-6 settlement test**

Append to `tools/loadbench/src/games.test.ts`:
```ts
import { makeSeats, playMatch } from "./match";
import { pairLocalChannel } from "./channels/localChannel";

test.each([...PLAYABLE])("%s plays to a settlement over the local channel", async (game) => {
  const stake = gameStake(game);
  const seats = makeSeats(`t-${game}`, { a: stake, b: stake }, 100n);
  const res = await playMatch(kitFor(game), seats, pairLocalChannel(), { seed: 3, maxMoves: 500 });
  const s = res.settlement.settlement;
  expect(s.partyABalance + s.partyBBalance).toBe(stake * 2n);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd tools/loadbench && bun test src/games.test.ts`
Expected: FAIL only if `runMatch.ts` still references the removed `protocolFor`/`gameBalances` and breaks the build graph; otherwise the new case should drive each kit. If a specific game never makes progress (both bots return `null` from the start), STOP and report that game — its bot/protocol pairing needs a look, don't loosen the assertion.

- [ ] **Step 3: Update `runMatch.ts`**

Change the games import and the two call sites:
```ts
// was: import { protocolFor, gameBalances } from "./games";
import { kitFor, gameStake } from "./games";
```
```ts
// was: const seats = makeSeats(id, gameBalances(game), 0n);
const seats = makeSeats(id, { a: gameStake(game), b: gameStake(game) }, 0n);
```
```ts
// was: const res = await playMatch(protocolFor(game), seats, transports, { maxMoves: 1000 });
const res = await playMatch(kitFor(game), seats, transports, { maxMoves: 1000 });
```

- [ ] **Step 4: Update `smoke.test.ts` to a kit game**

In `tools/loadbench/src/smoke.test.ts`, change the two `runFullMatch("payments", ...)` calls to `runFullMatch("blackjack", ...)` (gated onchain + always-on offchain). The assertions (`moves>0`, `settleMs>0` onchain; `openMs===0`/`settleMs===0` offchain) are unchanged.

- [ ] **Step 5: Run the full suite**

Run: `cd tools/loadbench && bun test`
Expected: PASS — including the 6 kit-settlement cases and the offchain smoke; the gated onchain smoke runs if `.env.local` is present (re-run `bun run stack` first if needed).

- [ ] **Step 6: Commit**

```bash
git add tools/loadbench/src/runMatch.ts tools/loadbench/src/games.test.ts tools/loadbench/src/smoke.test.ts
git commit -m "feat(loadbench): wire kit driver through runMatch + smoke"
```

---

## Phase B — Max-scale parallelism, metrics, container

### Task 5 (B1): Resource monitor

**Files:**
- Create: `tools/loadbench/src/resourceMonitor.ts`
- Test: `tools/loadbench/src/resourceMonitor.test.ts`

**Interfaces:**
- Produces:
  - `interface ResourceSummary { cpu: { avgPct: number; peakPct: number; avgCores: number; peakCores: number }; mem: { avgRssMb: number; peakRssMb: number }; samples: number }`
  - `summarizeResources(startCpuUs: number, endCpuUs: number, elapsedMs: number, intervalPcts: number[], rssBytes: number[]): ResourceSummary` (pure)
  - `startResourceMonitor(opts?: { intervalMs?: number }): { stop(): ResourceSummary }`
  - `formatResources(s: ResourceSummary): string`

- [ ] **Step 1: Write the failing test**

`tools/loadbench/src/resourceMonitor.test.ts`:
```ts
import { test, expect } from "bun:test";
import { summarizeResources } from "./resourceMonitor";

test("summarizeResources computes avg from total cpu-time and peak from intervals", () => {
  // 4 cpu-seconds over 1 wall-second => 400% avg => 4 cores.
  const s = summarizeResources(0, 4_000_000, 1000, [150, 400, 250], [100 * 1048576, 200 * 1048576]);
  expect(s.cpu.avgPct).toBeCloseTo(400, 5);
  expect(s.cpu.avgCores).toBeCloseTo(4, 5);
  expect(s.cpu.peakPct).toBe(400);
  expect(s.cpu.peakCores).toBeCloseTo(4, 5);
  expect(s.mem.avgRssMb).toBeCloseTo(150, 5);
  expect(s.mem.peakRssMb).toBeCloseTo(200, 5);
  expect(s.samples).toBe(2);
});

test("summarizeResources is safe with no samples", () => {
  const s = summarizeResources(0, 0, 0, [], []);
  expect(s.cpu.avgPct).toBe(0);
  expect(s.mem.peakRssMb).toBe(0);
  expect(s.samples).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/loadbench && bun test src/resourceMonitor.test.ts`
Expected: FAIL — `./resourceMonitor` not found.

- [ ] **Step 3: Implement `resourceMonitor.ts`**

```ts
export interface ResourceSummary {
  cpu: { avgPct: number; peakPct: number; avgCores: number; peakCores: number };
  mem: { avgRssMb: number; peakRssMb: number };
  samples: number;
}

/** Pure aggregation. CPU% = cpu-time / wall-time * 100; cores = pct / 100. */
export function summarizeResources(
  startCpuUs: number,
  endCpuUs: number,
  elapsedMs: number,
  intervalPcts: number[],
  rssBytes: number[],
): ResourceSummary {
  const avgPct = elapsedMs > 0 ? ((endCpuUs - startCpuUs) / 1000 / elapsedMs) * 100 : 0;
  const peakPct = intervalPcts.length ? Math.max(...intervalPcts) : avgPct;
  const avgRss = rssBytes.length ? rssBytes.reduce((a, b) => a + b, 0) / rssBytes.length : 0;
  const peakRss = rssBytes.length ? Math.max(...rssBytes) : 0;
  return {
    cpu: { avgPct, peakPct, avgCores: avgPct / 100, peakCores: peakPct / 100 },
    mem: { avgRssMb: avgRss / 1048576, peakRssMb: peakRss / 1048576 },
    samples: rssBytes.length,
  };
}

const cpuUs = () => {
  const u = process.cpuUsage();
  return u.user + u.system; // microseconds, cumulative since process start (all threads)
};

/** Samples process-wide CPU + RSS on a timer until stop(). */
export function startResourceMonitor(opts: { intervalMs?: number } = {}): { stop(): ResourceSummary } {
  const intervalMs = opts.intervalMs ?? 500;
  const startCpu = cpuUs();
  const startT = performance.now();
  let lastCpu = startCpu;
  let lastT = startT;
  const intervalPcts: number[] = [];
  const rssBytes: number[] = [];
  const timer = setInterval(() => {
    const t = performance.now();
    const c = cpuUs();
    const dtMs = t - lastT;
    if (dtMs > 0) intervalPcts.push(((c - lastCpu) / 1000 / dtMs) * 100);
    rssBytes.push(process.memoryUsage().rss);
    lastT = t;
    lastCpu = c;
  }, intervalMs);
  return {
    stop(): ResourceSummary {
      clearInterval(timer);
      return summarizeResources(startCpu, cpuUs(), performance.now() - startT, intervalPcts, rssBytes);
    },
  };
}

export function formatResources(s: ResourceSummary): string {
  return `cpu avg=${s.cpu.avgCores.toFixed(1)} cores (${s.cpu.avgPct.toFixed(0)}%) peak=${s.cpu.peakCores.toFixed(1)} cores (${s.cpu.peakPct.toFixed(0)}%), rss avg=${s.mem.avgRssMb.toFixed(0)}MB peak=${s.mem.peakRssMb.toFixed(0)}MB, samples=${s.samples}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/loadbench && bun test src/resourceMonitor.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/loadbench/src/resourceMonitor.ts tools/loadbench/src/resourceMonitor.test.ts
git commit -m "feat(loadbench): process-api resource monitor"
```

---

### Task 6 (B2): Fleet arg parsing + auto resolver + slice math

**Files:**
- Modify: `tools/loadbench/src/swarm.ts` (arg parsing + two pure exported helpers; `main()` rewrite is Task B3)
- Modify: `tools/loadbench/src/swarm.test.ts`

**Interfaces:**
- Produces (additions to `parseSwarmArgs` return): `workers: number | "auto"`, `concurrency: number | "auto"`, `memBudgetMb: number | null`, `perMatchKb: number | null`.
- Produces: `resolveFleet(args: { workers: number | "auto"; concurrency: number | "auto"; memBudgetMb: number | null; perMatchKb: number | null }, sys: { cores: number; totalMem: number }): { workers: number; concurrency: number }`
- Produces: `sliceMatches(total: number, workers: number): number[]` (sums to `total`, length `workers`, entries may be 0).

- [ ] **Step 1: Write the failing tests**

Replace the `parseSwarmArgs` defaults test in `tools/loadbench/src/swarm.test.ts` and add the helpers' tests:
```ts
import { test, expect } from "bun:test";
import { parseSwarmArgs, runSwarm, resolveFleet, sliceMatches } from "./swarm";

test("parseSwarmArgs defaults: relay/onchain, workers+concurrency auto, all games", () => {
  const a = parseSwarmArgs([]);
  expect(a.channel).toBe("relay");
  expect(a.anchor).toBe("onchain");
  expect(a.workers).toBe("auto");
  expect(a.concurrency).toBe("auto");
});

test("parseSwarmArgs reads explicit workers/concurrency and budgets", () => {
  const a = parseSwarmArgs(["--workers", "8", "--concurrency", "32", "--mem-budget-mb", "4096", "--per-match-kb", "256"]);
  expect(a.workers).toBe(8);
  expect(a.concurrency).toBe(32);
  expect(a.memBudgetMb).toBe(4096);
  expect(a.perMatchKb).toBe(256);
});

test("resolveFleet: workers auto = all cores; concurrency auto is memory-capped", () => {
  // 8 cores, 8 GiB total -> budget 70% = ~5.7 GiB; per-match 512 KiB default.
  const r = resolveFleet(
    { workers: "auto", concurrency: "auto", memBudgetMb: null, perMatchKb: null },
    { cores: 8, totalMem: 8 * 1024 * 1024 * 1024 },
  );
  expect(r.workers).toBe(8);
  expect(r.concurrency).toBeGreaterThan(0);
  // maxInFlight = floor(0.7*8GiB / 512KiB) ; per-worker = that / 8.
  const maxInFlight = Math.floor((0.7 * 8 * 1024 * 1024 * 1024) / (512 * 1024));
  expect(r.concurrency).toBe(Math.max(1, Math.floor(maxInFlight / 8)));
});

test("resolveFleet respects explicit values", () => {
  const r = resolveFleet(
    { workers: 4, concurrency: 10, memBudgetMb: null, perMatchKb: null },
    { cores: 64, totalMem: 999 },
  );
  expect(r).toEqual({ workers: 4, concurrency: 10 });
});

test("sliceMatches distributes a cap across workers and sums to the total", () => {
  expect(sliceMatches(20, 4)).toEqual([5, 5, 5, 5]);
  expect(sliceMatches(21, 4)).toEqual([6, 6, 6, 3]);
  const s = sliceMatches(3, 4);
  expect(s.reduce((a, b) => a + b, 0)).toBe(3);
  expect(s.length).toBe(4);
});
```
(Keep the existing `runSwarm` stop-condition tests; they still pass.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tools/loadbench && bun test src/swarm.test.ts`
Expected: FAIL — `resolveFleet`/`sliceMatches` not exported; `workers` not parsed.

- [ ] **Step 3: Update `parseSwarmArgs` and add the helpers in `swarm.ts`**

In `parseSwarmArgs`, extend the `out` object and the flag loop:
```ts
const out = {
  channel: "relay" as "local" | "relay",
  anchor: "onchain" as "onchain" | "offchain",
  workers: "auto" as number | "auto",
  concurrency: "auto" as number | "auto",
  matches: null as number | null,
  durationS: null as number | null,
  memBudgetMb: null as number | null,
  perMatchKb: null as number | null,
  games: [...PLAYABLE] as string[],
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--channel") out.channel = argv[++i] as "local" | "relay";
  else if (a === "--offchain") out.anchor = "offchain";
  else if (a === "--anchor") out.anchor = argv[++i] as "onchain" | "offchain";
  else if (a === "--workers") out.workers = argv[i + 1] === "auto" ? "auto" : Number(argv[++i]);
  else if (a === "--concurrency") out.concurrency = argv[i + 1] === "auto" ? "auto" : Number(argv[++i]);
  else if (a === "--matches") out.matches = Number(argv[++i]);
  else if (a === "--duration") out.durationS = Number(argv[++i]);
  else if (a === "--mem-budget-mb") out.memBudgetMb = Number(argv[++i]);
  else if (a === "--per-match-kb") out.perMatchKb = Number(argv[++i]);
  else if (a === "--games") out.games = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
}
return out;
```
Note: the `--workers auto` / `--concurrency auto` branch consumes the next arg only when it is a number (`Number(argv[++i])`); when it is the literal `auto` it leaves the index so the loop reads `auto` correctly — handle by checking `argv[i + 1]` and advancing `i` in both branches:
```ts
else if (a === "--workers") { i++; out.workers = argv[i] === "auto" ? "auto" : Number(argv[i]); }
else if (a === "--concurrency") { i++; out.concurrency = argv[i] === "auto" ? "auto" : Number(argv[i]); }
```
Add the two pure helpers (top-level exports):
```ts
const DEFAULT_PER_MATCH_KB = 512;

export function resolveFleet(
  args: { workers: number | "auto"; concurrency: number | "auto"; memBudgetMb: number | null; perMatchKb: number | null },
  sys: { cores: number; totalMem: number },
): { workers: number; concurrency: number } {
  const workers = args.workers === "auto" ? Math.max(1, sys.cores) : args.workers;
  let concurrency: number;
  if (args.concurrency === "auto") {
    const budgetBytes = (args.memBudgetMb ?? Math.floor((sys.totalMem * 0.7) / 1_048_576)) * 1_048_576;
    const perMatchBytes = (args.perMatchKb ?? DEFAULT_PER_MATCH_KB) * 1024;
    const maxInFlight = Math.max(workers, Math.floor(budgetBytes / perMatchBytes));
    concurrency = Math.max(1, Math.floor(maxInFlight / workers));
  } else {
    concurrency = args.concurrency;
  }
  return { workers, concurrency };
}

/** Split `total` matches across `workers`; sums to total, length = workers. */
export function sliceMatches(total: number, workers: number): number[] {
  const base = Math.ceil(total / workers);
  const out: number[] = [];
  let rem = total;
  for (let i = 0; i < workers; i++) {
    const n = Math.min(base, Math.max(0, rem));
    out.push(n);
    rem -= n;
  }
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tools/loadbench && bun test src/swarm.test.ts`
Expected: PASS (new + existing `runSwarm` tests).

- [ ] **Step 5: Commit**

```bash
git add tools/loadbench/src/swarm.ts tools/loadbench/src/swarm.test.ts
git commit -m "feat(loadbench): fleet arg parsing + auto resolver"
```

---

### Task 7 (B3): Worker thread + `swarm` fleet `main()`

**Files:**
- Create: `tools/loadbench/src/worker.ts`
- Modify: `tools/loadbench/src/swarm.ts` (`main()` rewrite)

**Interfaces:**
- Consumes: `resolveFleet`, `sliceMatches`, `runSwarm`, `parseSwarmArgs` (B2); `runFullMatch` (existing); `ensureRelay`, `relayWsUrl` (existing); `readEnvLocal` (existing); `ratePerSec` (existing); `startResourceMonitor`, `formatResources` (B1).
- Produces: `worker.ts` reads `workerData`, runs its swarm slice, posts `{ ok: true, moves, matches } | { ok: false, error }`.

- [ ] **Step 1: Implement `worker.ts`**

```ts
import { parentPort, workerData } from "node:worker_threads";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { runSwarm } from "./swarm";
import { runFullMatch } from "./runMatch";

interface WorkerInput {
  workerId: number;
  channel: "local" | "relay";
  anchor: "onchain" | "offchain";
  games: string[];
  concurrency: number;
  matches: number | null;
  durationMs: number | null;
  env: Record<string, string>;
}

async function run() {
  const d = workerData as WorkerInput;
  const ctx: { client?: SuiClient; funder?: Ed25519Keypair } = {};
  if (d.anchor === "onchain") {
    process.env.PACKAGE_ID = d.env.PACKAGE_ID;
    process.env.SUI_NETWORK = d.env.SUI_NETWORK;
    ctx.client = new SuiClient({ url: d.env.SUI_RPC_URL || getFullnodeUrl("localnet") });
    const { secretKey } = decodeSuiPrivateKey(d.env.SUI_SETTLER_KEY);
    ctx.funder = Ed25519Keypair.fromSecretKey(secretKey);
  }
  let g = 0;
  const nextGame = () => d.games[g++ % d.games.length];
  const res = await runSwarm(() => runFullMatch(nextGame(), d.channel, d.anchor, ctx), {
    concurrency: d.concurrency,
    matches: d.matches,
    durationMs: d.durationMs,
    now: () => performance.now(),
  });
  parentPort!.postMessage({ ok: true, moves: res.moves, matches: res.matches });
}

run().catch((e) => parentPort!.postMessage({ ok: false, error: String(e?.stack ?? e) }));
```

- [ ] **Step 2: Rewrite `main()` in `swarm.ts`**

Add imports at the top of `swarm.ts`:
```ts
import os from "node:os";
import { Worker } from "node:worker_threads";
import { startResourceMonitor, formatResources } from "./resourceMonitor";
```
Replace the existing `main()` with:
```ts
function runWorker(input: Record<string, unknown>): Promise<{ ok: boolean; moves?: number; matches?: number; error?: string }> {
  return new Promise((resolve) => {
    const w = new Worker(new URL("./worker.ts", import.meta.url), { workerData: input });
    w.once("message", (m) => resolve(m));
    w.once("error", (e) => resolve({ ok: false, error: String(e?.stack ?? e) }));
  });
}

async function main() {
  const args = parseSwarmArgs(process.argv.slice(2));
  if (args.matches === null && args.durationS === null) args.durationS = 15;

  const sys = { cores: os.availableParallelism?.() ?? os.cpus().length, totalMem: os.totalmem() };
  const { workers, concurrency } = resolveFleet(args, sys);

  const env: Record<string, string> = {};
  if (args.anchor === "onchain") {
    const e = readEnvLocal();
    if (!e.TUNNEL_PACKAGE_ID) throw new Error("run `bun run stack` first");
    env.PACKAGE_ID = e.TUNNEL_PACKAGE_ID;
    env.SUI_NETWORK = e.SUI_NETWORK ?? "";
    env.SUI_RPC_URL = e.SUI_RPC_URL ?? "";
    env.SUI_SETTLER_KEY = e.SUI_SETTLER_KEY;
  }

  const relay = args.channel === "relay" ? await ensureRelay() : null;
  const slices = args.matches !== null ? sliceMatches(args.matches, workers) : null;
  const durationMs = args.durationS !== null ? args.durationS * 1000 : null;
  const tag = `${args.channel}/${args.anchor}`;

  const monitor = startResourceMonitor();
  const start = performance.now();
  try {
    const inputs = Array.from({ length: workers }, (_, i) => ({
      workerId: i,
      channel: args.channel,
      anchor: args.anchor,
      games: args.games,
      concurrency,
      matches: slices ? slices[i] : null,
      durationMs,
      env,
    })).filter((inp) => inp.matches === null || inp.matches > 0);

    const results = await Promise.all(inputs.map(runWorker));
    const elapsedMs = performance.now() - start;
    const ok = results.filter((r) => r.ok);
    const failed = results.length - ok.length;
    const moves = ok.reduce((a, r) => a + (r.moves ?? 0), 0);
    const matches = ok.reduce((a, r) => a + (r.matches ?? 0), 0);
    const res = monitor.stop();

    console.log(`[${tag}] fleet: workers=${workers} concurrency=${concurrency}${args.workers === "auto" || args.concurrency === "auto" ? " (auto)" : ""}${failed ? ` (${failed} worker(s) failed)` : ""}`);
    console.log(`[${tag}] swarm: ${moves} moves over ${matches} matches in ${(elapsedMs / 1000).toFixed(1)}s`);
    console.log(`[${tag}] aggregate move-TPS: ${ratePerSec(moves, elapsedMs).toFixed(1)}`);
    if (args.anchor === "onchain") {
      console.log(`[${tag}] tunnels settled/s: ${ratePerSec(matches, elapsedMs).toFixed(2)} (on-chain-finality-bound)`);
    }
    console.log(`[${tag}] resources: ${formatResources(res)}`);
    for (const r of results.filter((x) => !x.ok)) console.error(`[${tag}] worker error: ${r.error}`);
  } finally {
    relay?.stop();
  }
}

if (import.meta.main) main().catch((e) => { console.error(e); process.exit(1); });
```
Remove the old single-process `main()` body and its now-unused single-process `nextGame`/`ctx` setup (the worker owns that now). Keep `parseSwarmArgs`, `runSwarm`, `resolveFleet`, `sliceMatches` exports.

- [ ] **Step 3: Run the unit suite (no regressions)**

Run: `cd tools/loadbench && bun test src/swarm.test.ts`
Expected: PASS (the pure helpers + `runSwarm` are unchanged; `main()` is guarded by `import.meta.main`).

- [ ] **Step 4: Integration verify — multi-core offchain burst**

Run: `cd tools/loadbench && bun run swarm --offchain --channel local --workers auto --duration 10`
Expected: prints `[local/offchain] fleet: workers=<cores> concurrency=<n> (auto)`, an aggregate move-TPS higher than a single-worker run, and a `resources:` line whose `peak` cores approach the worker count (proving multi-core use). No errors.

- [ ] **Step 5: Commit**

```bash
git add tools/loadbench/src/worker.ts tools/loadbench/src/swarm.ts
git commit -m "feat(loadbench): worker-thread fleet for swarm"
```

---

### Task 8 (B4): `bench:game` resource report + env-driven RPC

**Files:**
- Modify: `tools/loadbench/src/benchGame.ts`
- Modify: `tools/loadbench/src/swarm.ts` (RPC URL already env-driven via worker; nothing here) — no change
- Test: covered by existing `benchGame.test.ts` (arg parsing unchanged) + manual

**Interfaces:**
- Consumes: `startResourceMonitor`, `formatResources` (B1).

- [ ] **Step 1: Make the RPC URL env-driven in `benchGame.ts`**

In `benchGame.ts` `main()`, change the client construction:
```ts
// was: ctx.client = new SuiClient({ url: getFullnodeUrl("localnet") });
ctx.client = new SuiClient({ url: env.SUI_RPC_URL || getFullnodeUrl("localnet") });
```
(`env` is the `readEnvLocal()` result already in scope; `getFullnodeUrl` is already imported.)

- [ ] **Step 2: Wrap the bench run in the resource monitor**

Add the import:
```ts
import { startResourceMonitor, formatResources } from "./resourceMonitor";
```
In `main()`, wrap the per-game loop:
```ts
const monitor = startResourceMonitor();
try {
  for (const g of games) await benchOne(g, args, ctx);
} finally {
  relay?.stop();
  console.log(`resources: ${formatResources(monitor.stop())}`);
}
```
(Replace the existing `try { for ... } finally { relay?.stop(); }` block.)

- [ ] **Step 3: Run the arg-parse suite (no regressions)**

Run: `cd tools/loadbench && bun test src/benchGame.test.ts`
Expected: PASS (arg parsing unchanged).

- [ ] **Step 4: Integration verify**

Run: `cd tools/loadbench && bun run bench:game blackjack --channel local --offchain --matches 20 --concurrency 4`
Expected: the `[local/offchain] blackjack: …` line followed by a `resources: cpu avg=… peak=… rss …` line. No errors.

- [ ] **Step 5: Commit**

```bash
git add tools/loadbench/src/benchGame.ts
git commit -m "feat(loadbench): resource report + env RPC for bench:game"
```

---

### Task 9 (B5): Container — Dockerfile + compose service

**Files:**
- Create: `tools/loadbench/Dockerfile`
- Create: `tools/loadbench/.dockerignore`
- Modify: `tools/loadbench/docker-compose.yml`

**Interfaces:**
- Consumes: the `swarm`/`bench:game` entrypoints; `SUI_RPC_URL` env (B3/B4).

- [ ] **Step 1: Author the Dockerfile**

`tools/loadbench/Dockerfile` (build context = repo root, so all three trees are present):
```dockerfile
FROM oven/bun:1
WORKDIR /app
# Bring the three source trees the bench imports.
COPY tools/loadbench/package.json tools/loadbench/tsconfig.json tools/loadbench/
COPY tools/loadbench/src tools/loadbench/src
COPY sui-tunnel-ts/src sui-tunnel-ts/src
COPY sui-tunnel-ts/package.json sui-tunnel-ts/
COPY frontend/src/agent frontend/src/agent
COPY frontend/package.json frontend/
WORKDIR /app/tools/loadbench
RUN bun install
ENTRYPOINT ["bun", "run", "src/swarm.ts"]
```

- [ ] **Step 2: Author `.dockerignore`**

`tools/loadbench/.dockerignore`:
```
node_modules
.env.local
keys.json
```
(Secrets are mounted at runtime, not baked into the image.)

- [ ] **Step 3: Add the compose service**

Append to `tools/loadbench/docker-compose.yml` `services:`:
```yaml
  loadbench:
    profiles: ["bench"]
    build:
      context: ../..
      dockerfile: tools/loadbench/Dockerfile
    environment:
      SUI_RPC_URL: "http://sui-localnet:9000"
    volumes:
      - ./.env.local:/app/tools/loadbench/.env.local:ro
      - ./keys.json:/app/tools/loadbench/keys.json:ro
    networks:
      default: {}
    deploy:
      resources:
        limits:
          cpus: "4"
          memory: 4g
    # default command runs an offchain burst; override per run.
    command: ["--offchain", "--channel", "local", "--workers", "auto", "--duration", "10"]
```
(The localnet service is reachable as `sui-localnet` on the compose default network. `--channel relay` is unsupported in-container.)

- [ ] **Step 4: Integration verify (offchain burst, capped)**

Run (stack already up via `bun run stack`):
```bash
cd tools/loadbench
docker compose --profile bench run --rm loadbench --offchain --channel local --workers 4 --duration 10
```
Expected: builds the image, runs a 4-worker offchain burst inside the container, prints the `[local/offchain] fleet/swarm/aggregate move-TPS/resources` lines; `resources` peak cores ≤ the `cpus: "4"` limit. No errors.

- [ ] **Step 5: Integration verify (onchain over the compose network)**

Run:
```bash
docker compose --profile bench run --rm -e SUI_RPC_URL=http://sui-localnet:9000 loadbench --channel local --anchor onchain --workers 2 --matches 8
```
Expected: opens + settles real tunnels on the localnet from inside the container (reaching `sui-localnet:9000`), prints a `tunnels settled/s` line. No errors. (If `.env.local`/`keys.json` aren't mounted, it errors clearly — run `bun run stack` first.)

- [ ] **Step 6: Commit**

```bash
git add tools/loadbench/Dockerfile tools/loadbench/.dockerignore tools/loadbench/docker-compose.yml
git commit -m "feat(loadbench): containerized bench service"
```

---

### Task 10 (B6): Update README

**Files:**
- Modify: `tools/loadbench/README.md`

- [ ] **Step 1: Document the new surface**

Update `tools/loadbench/README.md`:
- Replace the playable-games list with the 6 kit games (`ticTacToe, blackjack, battleship, quantumPoker, bombIt, cross`); note `payments`/`chat` are gone and that the bench now drives the real frontend protocol classes (settlements byte-identical to shipped games).
- Document `--workers <n|auto>`, `--concurrency <n|auto>`, `--mem-budget-mb`, `--per-match-kb`; explain workers = OS threads (multi-core), concurrency = async in-flight per worker, and that `auto` maxes both, memory-capped.
- Document the `resources:` report line (avg/peak CPU cores + RSS).
- Add a "Container" section: `docker compose --profile bench run --rm loadbench …`, the `cpus`/`memory` limits, `SUI_RPC_URL=http://sui-localnet:9000`, mounted `.env.local`/`keys.json`, and that `--channel relay` is host-only.

- [ ] **Step 2: Commit**

```bash
git add tools/loadbench/README.md
git commit -m "docs(loadbench): document kits, fleet, container"
```

---

## Self-Review

**Spec coverage:**
- Kit alias resolution + import gate → A1. ✓
- Kit registry, 6 games, payments/chat removed → A2. ✓
- Bot-driven `playMatch` (plan/confirm/abort, rngForSeat) → A3. ✓
- runMatch wiring + all-6 settlement + smoke → A4. ✓
- behaviors.ts kept → Global Constraints + A2/A3 (no revert step). ✓
- Resource monitor (process APIs, avg/peak CPU+RSS) → B1, surfaced in B3/B4. ✓
- Worker fleet, `--workers/--concurrency auto`, memory cap, slice math → B2 (pure) + B3 (wiring). ✓
- Multi-core proof → B3 Step 4. ✓
- env-driven RPC → B3 (worker) + B4 (bench:game). ✓
- Container compose service, resource limits, local-only → B5. ✓
- Docs → B6. ✓

**Placeholder scan:** every code step has complete code; verification commands have expected output. ✓

**Type consistency:** `kitFor`/`gameStake`/`PLAYABLE` (A2) used identically in A3/A4/B3 worker; `resolveFleet`/`sliceMatches` signatures match B2 tests and B3 caller; `ResourceSummary`/`startResourceMonitor`/`formatResources` consistent across B1/B3/B4; `playMatch(kit, …)` signature consistent A3↔A4↔runMatch↔worker. ✓

**Known verification points (named):** kit purity under bun (A1 gate); per-game move-codec gaps (A3/A4 settlement tests); a game whose bots never progress (A4 Step 2); multi-core actually used (B3 Step 4); container reaches `sui-localnet:9000` (B5 Step 5).
