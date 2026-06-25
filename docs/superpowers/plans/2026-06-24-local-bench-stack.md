# Local Benchmark Stack + Bun Load Tooling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a `tools/loadbench/` bun package that benchmarks real off-chain games — one per game, one agent swarm for TPS — against a standardized local stack, over either an in-process **local channel** or the **relay channel** (`tunnel-manager`).

**Architecture:** The `sui-tunnel-ts` engine drives a two-party game over a minimal `Transport` (`send(bytes)` / `onFrame(cb)`). We swap only the transport: a **local channel** (two transports paired in memory) measures the engine/signing ceiling; a **relay channel** (headless WS client to `tunnel-manager`) measures relay-served throughput. Each match opens and cooperatively settles a real tunnel on a Sui **localnet**; the many moves between those bookends are the throughput. Infra (localnet + valkey) runs in Docker Compose; the relay runs from source via `cargo run` with its in-memory store by default.

**Tech Stack:** bun + TypeScript; `sui-tunnel-ts` core/onchain/protocol/agents (imported from source via relative paths); `@mysten/sui` client + faucet; Docker Compose (Sui localnet, Valkey); the Rust `tunnel-manager` relay.

## Global Constraints

- **Toolchain:** `tools/loadbench/` is a bun package. Do NOT convert `sui-tunnel-ts/` or `frontend/` to bun — they stay pnpm. The ONLY edit to an upstream pnpm package in this plan is Task 5 (two-line behaviors wiring).
- **Imports:** `tools/loadbench` imports `sui-tunnel-ts` engine code from source via relative paths (e.g. `../../../sui-tunnel-ts/src/core/distributedTunnel`). Do not import from `frontend/`.
- **Anchor mode (per run):** `onchain` = real `create_and_fund` open + `close_cooperative_with_root` settle against a Sui localnet (full real game); `offchain` = no chain at all, synthetic tunnel id, just the move loop (pure-burst TPS). Moves stay off-chain in both. Default `onchain`. `offchain --channel local` needs no stack; `offchain --channel relay` needs only the relay.
- **Relay store:** in-memory by default (valkey out of the move path); `REDIS_*_URL` only set to benchmark the redis path.
- **Channel labelling:** every throughput number printed MUST be labelled `local` or `relay`; never conflate them.
- **Playable games (have an engine `randomMove`):** `payments, blackjack, ticTacToe, chat, quantumPoker, bombIt, cross`. Out of scope (no protocol): `battleship, coinFlip, dice, slots` — reject with a clear message.
- **Secrets:** `.env.local` and `keys.json` are gitignored; localnet faucet keys only.
- **Tests:** `bun test`, co-located `*.test.ts`. Treat flakes as bugs; gate on explicit health waits, never retry-loops.
- **Commits:** Conventional Commits, subject ≤ 50 chars, no AI attribution.

**Engine API the plan relies on (verified against `sui-tunnel-ts/src`):**

```ts
// core/distributedTunnel.ts
interface Transport { send(frame: Uint8Array): void; onFrame(cb: (f: Uint8Array) => void): void }
class DistributedTunnel<S, M> {
  constructor(protocol: Protocol<S, M>, cfg: { tunnelId: string; self: PartyEndpoint; opponent: PartyEndpoint; selfParty: "A"|"B"; moveCodec?: MoveCodec<M> }, transport: Transport, initialBalances: { a: bigint; b: bigint })
  readonly state: S; readonly nonce: bigint; onConfirmed?: (u: CoSignedUpdate) => void
  propose(move: M, timestamp: bigint): void
  buildSettlementHalfWithRoot(ts: bigint, root: Uint8Array, onchainNonce?: bigint): { settlement: SettlementWithRoot; sigSelf: Uint8Array }
  combineSettlementWithRoot(s: SettlementWithRoot, sigSelf: Uint8Array, sigOther: Uint8Array): CoSignedSettlementWithRoot
}
// core/tunnel.ts
function makeEndpoint(backend, address: string, keyPair: { publicKey; scheme; secretKey? }, controlled: boolean): PartyEndpoint
// core/crypto-native.ts ->  defaultBackend
// core/keys.ts        ->  createParticipant(seed: string): { address: string; keyPair: { publicKey; scheme; secretKey } }
// core/distributedFrame.ts -> wrapInnerFrameJson(innerJson: string): string   // {t:"frame",kind,data}
// protocol/Protocol.ts -> Protocol<S,M>: initialState, applyMove, balances, isTerminal, randomMove?(state, by, rng)=>M|null
// agents/behaviors.ts -> createBehaviorProtocol(name): Protocol<unknown,unknown>; BehaviorName
// onchain: buildOpenAndFundMany(tx, TunnelOpenSpec[]); buildCloseWithRootFromSettlement(tx, tunnelId, CoSignedSettlementWithRoot); execute(client, signer, tx, {waitForFinality})
// utils: createSuiClient(network); getNetwork(); getKeypairFromEnv(name); getCreatedObjectIds(objectChanges, "::tunnel::Tunnel<"); getObjects(client, ids)
```

**Relay WS protocol (`backend/tunnel-manager/src/mp/protocol.rs`):**
- server→client: `{type:"challenge",nonce}`, `{type:"match.found",matchId,role,opponentWallet,game}`, `{type:"relay",matchId,payload}`
- client→server: `{type:"connect",wallet,pubkey,sig,nonce}`, `{type:"queue.join",game}`, `{type:"relay",matchId,payload}`

---

### Task 1: Package scaffold + metrics

**Files:**
- Create: `tools/loadbench/package.json`
- Create: `tools/loadbench/tsconfig.json`
- Create: `tools/loadbench/src/metrics.ts`
- Test: `tools/loadbench/src/metrics.test.ts`
- Modify: `.gitignore` (repo root) — add `tools/loadbench/.env.local` and `tools/loadbench/keys.json`

**Interfaces:**
- Produces: `percentile(sorted: number[], p: number): number`; `summarize(latenciesMs: number[]): { p50: number; p99: number; count: number }`; `ratePerSec(count: number, elapsedMs: number): number`.

- [ ] **Step 1: Scaffold the package**

`tools/loadbench/package.json`:
```json
{
  "name": "loadbench",
  "private": true,
  "type": "module",
  "scripts": {
    "stack": "bun run src/stack.ts",
    "bench:game": "bun run src/benchGame.ts",
    "swarm": "bun run src/swarm.ts",
    "test": "bun test"
  },
  "dependencies": { "@mysten/sui": "1.28.1" }
}
```

`tools/loadbench/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ESNext", "module": "ESNext", "moduleResolution": "bundler",
    "strict": true, "skipLibCheck": true, "types": ["bun-types"], "allowJs": false
  },
  "include": ["src"]
}
```

Append to repo-root `.gitignore`:
```
tools/loadbench/.env.local
tools/loadbench/keys.json
```

- [ ] **Step 2: Write the failing test**

`tools/loadbench/src/metrics.test.ts`:
```ts
import { test, expect } from "bun:test";
import { percentile, summarize, ratePerSec } from "./metrics";

test("percentile picks the nearest-rank value", () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  expect(percentile(xs, 50)).toBe(5);
  expect(percentile(xs, 99)).toBe(10);
});

test("summarize reports p50/p99 and count from unsorted input", () => {
  const s = summarize([10, 1, 5, 2, 9, 3, 8, 4, 7, 6]);
  expect(s.count).toBe(10);
  expect(s.p50).toBe(5);
  expect(s.p99).toBe(10);
});

test("ratePerSec divides count by elapsed seconds", () => {
  expect(ratePerSec(300, 1500)).toBeCloseTo(200, 5);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd tools/loadbench && bun test src/metrics.test.ts`
Expected: FAIL — `Cannot find module './metrics'`.

- [ ] **Step 4: Implement `metrics.ts`**

```ts
/** Nearest-rank percentile over an UNSORTED copy. `p` in [0,100]. */
export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function summarize(latenciesMs: number[]): { p50: number; p99: number; count: number } {
  return { p50: percentile(latenciesMs, 50), p99: percentile(latenciesMs, 99), count: latenciesMs.length };
}

export function ratePerSec(count: number, elapsedMs: number): number {
  return elapsedMs <= 0 ? 0 : (count * 1000) / elapsedMs;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd tools/loadbench && bun test src/metrics.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add tools/loadbench/package.json tools/loadbench/tsconfig.json tools/loadbench/src/metrics.ts tools/loadbench/src/metrics.test.ts .gitignore
git commit -m "feat(loadbench): scaffold bun package + metrics"
```

---

### Task 2: Local channel (in-process transport pair)

**Files:**
- Create: `tools/loadbench/src/channels/localChannel.ts`
- Test: `tools/loadbench/src/channels/localChannel.test.ts`

**Interfaces:**
- Consumes: `Transport` from `sui-tunnel-ts/src/core/distributedTunnel`.
- Produces: `pairLocalChannel(): [Transport, Transport]` — two transports where each `send` delivers to the other's `onFrame` callback, asynchronously (via `queueMicrotask`) so re-entrancy matches the relay's async delivery.

- [ ] **Step 1: Write the failing test**

`tools/loadbench/src/channels/localChannel.test.ts`:
```ts
import { test, expect } from "bun:test";
import { pairLocalChannel } from "./localChannel";

test("frames sent on A arrive on B and vice-versa", async () => {
  const [a, b] = pairLocalChannel();
  const gotB: string[] = [];
  const gotA: string[] = [];
  b.onFrame((f) => gotB.push(new TextDecoder().decode(f)));
  a.onFrame((f) => gotA.push(new TextDecoder().decode(f)));
  a.send(new TextEncoder().encode("a->b"));
  b.send(new TextEncoder().encode("b->a"));
  await Promise.resolve();
  await new Promise((r) => queueMicrotask(() => r(null)));
  expect(gotB).toEqual(["a->b"]);
  expect(gotA).toEqual(["b->a"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/loadbench && bun test src/channels/localChannel.test.ts`
Expected: FAIL — `Cannot find module './localChannel'`.

- [ ] **Step 3: Implement `localChannel.ts`**

```ts
import type { Transport } from "../../../../sui-tunnel-ts/src/core/distributedTunnel";

/** Two transports wired back-to-back in memory. No server, no network.
 *  Delivery is deferred to a microtask so a `send` inside an `onFrame` does not
 *  recurse on the C stack — matching the relay's async delivery semantics. */
export function pairLocalChannel(): [Transport, Transport] {
  let cbA: ((f: Uint8Array) => void) | null = null;
  let cbB: ((f: Uint8Array) => void) | null = null;
  const a: Transport = {
    send: (f) => queueMicrotask(() => cbB?.(f)),
    onFrame: (cb) => { cbA = cb; },
  };
  const b: Transport = {
    send: (f) => queueMicrotask(() => cbA?.(f)),
    onFrame: (cb) => { cbB = cb; },
  };
  void cbA;
  return [a, b];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/loadbench && bun test src/channels/localChannel.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/loadbench/src/channels/localChannel.ts tools/loadbench/src/channels/localChannel.test.ts
git commit -m "feat(loadbench): in-process local channel transport"
```

---

### Task 3: Relay envelope wrapping

**Files:**
- Create: `tools/loadbench/src/channels/relayEnvelope.ts`
- Test: `tools/loadbench/src/channels/relayEnvelope.test.ts`

**Interfaces:**
- Consumes: `wrapInnerFrameJson` from `sui-tunnel-ts/src/core/distributedFrame`.
- Produces: `framePayload(frameBytes: Uint8Array): string` (engine bytes → relay `payload`); `payloadFrame(payload: string): Uint8Array | null` (relay `payload` → engine bytes, or null for non-frame peer messages).

- [ ] **Step 1: Write the failing test**

`tools/loadbench/src/channels/relayEnvelope.test.ts`:
```ts
import { test, expect } from "bun:test";
import { framePayload, payloadFrame } from "./relayEnvelope";

test("frame bytes round-trip through the relay payload envelope", () => {
  const inner = JSON.stringify({ kind: "ack", nonce: "1", sigResponder: "ab" });
  const bytes = new TextEncoder().encode(inner);
  const payload = framePayload(bytes);
  expect(JSON.parse(payload).t).toBe("frame");
  const back = payloadFrame(payload);
  expect(back && new TextDecoder().decode(back)).toBe(inner);
});

test("non-frame peer payloads decode to null", () => {
  expect(payloadFrame(JSON.stringify({ t: "hello" }))).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/loadbench && bun test src/channels/relayEnvelope.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `relayEnvelope.ts`**

```ts
import { wrapInnerFrameJson } from "../../../../sui-tunnel-ts/src/core/distributedFrame";

/** Engine frame bytes -> the relay `payload` string `{t:"frame",kind,data}`. */
export function framePayload(frameBytes: Uint8Array): string {
  return wrapInnerFrameJson(new TextDecoder().decode(frameBytes));
}

/** Relay `payload` -> engine frame bytes, or null if it is a non-frame peer message. */
export function payloadFrame(payload: string): Uint8Array | null {
  const env = JSON.parse(payload) as { t?: string; data?: string };
  if (env.t !== "frame" || typeof env.data !== "string") return null;
  return new TextEncoder().encode(env.data);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/loadbench && bun test src/channels/relayEnvelope.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/loadbench/src/channels/relayEnvelope.ts tools/loadbench/src/channels/relayEnvelope.test.ts
git commit -m "feat(loadbench): relay payload envelope helpers"
```

---

### Task 4: Match driver (channel-agnostic core)

**Files:**
- Create: `tools/loadbench/src/match.ts`
- Test: `tools/loadbench/src/match.test.ts`

**Interfaces:**
- Consumes: `pairLocalChannel` (Task 2); `DistributedTunnel`, `Transport`; `makeEndpoint`; `defaultBackend`; `createParticipant`; `blake2b256`; a `Protocol<unknown, unknown>`.
- Produces:
  - `type Seats = { tunnelId: string; balances: { a: bigint; b: bigint }; createdAt: bigint; partyA: ReturnType<typeof createParticipant>; partyB: ReturnType<typeof createParticipant> }`
  - `type MatchResult = { moves: number; bytes: number; latenciesMs: number[]; settlement: CoSignedSettlementWithRoot }`
  - `playMatch(protocol: Protocol<unknown, unknown>, seats: Seats, transports: [Transport, Transport], opts?: { seed?: number; maxMoves?: number }): Promise<MatchResult>` — drives alternating `randomMove` proposals until `protocol.isTerminal(state)` (or no legal move from either side, or `maxMoves`), then returns a co-signed root-anchored settlement.

Driver semantics: build `dtA` (selfParty `A`, self=controlled A endpoint, opponent=verify-only B) on `transports[0]` and `dtB` (mirror) on `transports[1]`. A proposal is `proposeAndAwait(dt, move, ts)`: install a one-shot resolver on `dt.onConfirmed` BEFORE calling `dt.propose` (local delivery may confirm synchronously), measure latency around the await. Count bytes via each transport `send` wrapper. The settlement uses `root = blake2b256("dopamint:"+tunnelId)`, `timestamp = createdAt`, `onchainNonce = 0n`; both seats build the half and `dtA.combineSettlementWithRoot(...)` yields the artifact.

- [ ] **Step 1: Write the failing test**

`tools/loadbench/src/match.test.ts`:
```ts
import { test, expect } from "bun:test";
import { pairLocalChannel } from "./channels/localChannel";
import { makeSeats, playMatch } from "./match";
import { PaymentsProtocol } from "../../../sui-tunnel-ts/src/protocol/payments";
import { verifyCoSignedUpdate } from "../../../sui-tunnel-ts/src/core/tunnel";

test("a payments match plays to terminal over the local channel and settles", async () => {
  const seats = makeSeats("t-1", { a: 1000n, b: 1000n }, 1234n);
  const res = await playMatch(new PaymentsProtocol() as any, seats, pairLocalChannel(), { seed: 7, maxMoves: 200 });
  expect(res.moves).toBeGreaterThan(0);
  expect(res.bytes).toBeGreaterThan(0);
  expect(res.latenciesMs.length).toBe(res.moves);
  // The settlement balances still sum to the locked total.
  const s = res.settlement.settlement;
  expect(s.partyABalance + s.partyBBalance).toBe(2000n);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/loadbench && bun test src/match.test.ts`
Expected: FAIL — `makeSeats`/`playMatch` not found.

- [ ] **Step 3: Implement `match.ts`**

```ts
import type { Transport } from "../../../sui-tunnel-ts/src/core/distributedTunnel";
import { DistributedTunnel } from "../../../sui-tunnel-ts/src/core/distributedTunnel";
import { makeEndpoint, type CoSignedSettlementWithRoot } from "../../../sui-tunnel-ts/src/core/tunnel";
import { defaultBackend } from "../../../sui-tunnel-ts/src/core/crypto-native";
import { createParticipant } from "../../../sui-tunnel-ts/src/core/keys";
import { blake2b256 } from "../../../sui-tunnel-ts/src/core/crypto";
import { mulberry32 } from "../../../sui-tunnel-ts/src/sim/rng";
import type { Protocol, Party } from "../../../sui-tunnel-ts/src/protocol/Protocol";

export type Participant = ReturnType<typeof createParticipant>;
export interface Seats {
  tunnelId: string;
  balances: { a: bigint; b: bigint };
  createdAt: bigint;
  partyA: Participant;
  partyB: Participant;
}
export interface MatchResult {
  moves: number;
  bytes: number;
  latenciesMs: number[];
  settlement: CoSignedSettlementWithRoot;
}

/** Deterministic seats with fresh ephemeral keys, for off-chain play (no chain). */
export function makeSeats(tunnelId: string, balances: { a: bigint; b: bigint }, createdAt: bigint): Seats {
  return {
    tunnelId,
    balances,
    createdAt,
    partyA: createParticipant(`${tunnelId}-A`),
    partyB: createParticipant(`${tunnelId}-B`),
  };
}

function countingTransport(t: Transport, onBytes: (n: number) => void): Transport {
  return { send: (f) => { onBytes(f.length); t.send(f); }, onFrame: (cb) => t.onFrame(cb) };
}

function proposeAndAwait(dt: DistributedTunnel<unknown, unknown>, move: unknown, ts: bigint): Promise<number> {
  const start = performance.now();
  return new Promise<number>((resolve, reject) => {
    let done = false;
    const prev = dt.onConfirmed;
    dt.onConfirmed = (u) => { prev?.(u); if (!done) { done = true; dt.onConfirmed = prev; resolve(performance.now() - start); } };
    try { dt.propose(move, ts); } catch (e) { dt.onConfirmed = prev; reject(e); }
  });
}

export async function playMatch(
  protocol: Protocol<unknown, unknown>,
  seats: Seats,
  transports: [Transport, Transport],
  opts: { seed?: number; maxMoves?: number } = {},
): Promise<MatchResult> {
  const backend = defaultBackend;
  const aEnd = makeEndpoint(backend, seats.partyA.address, seats.partyA.keyPair, true);
  const aOpp = makeEndpoint(backend, seats.partyB.address, seats.partyB.keyPair, false);
  const bEnd = makeEndpoint(backend, seats.partyB.address, seats.partyB.keyPair, true);
  const bOpp = makeEndpoint(backend, seats.partyA.address, seats.partyA.keyPair, false);
  let bytes = 0;
  const tA = countingTransport(transports[0], (n) => (bytes += n));
  const tB = countingTransport(transports[1], (n) => (bytes += n));
  const dtA = new DistributedTunnel(protocol, { tunnelId: seats.tunnelId, self: aEnd, opponent: aOpp, selfParty: "A" }, tA, seats.balances);
  const dtB = new DistributedTunnel(protocol, { tunnelId: seats.tunnelId, self: bEnd, opponent: bOpp, selfParty: "B" }, tB, seats.balances);
  const seatOf: Record<Party, DistributedTunnel<unknown, unknown>> = { A: dtA, B: dtB };

  const rng = mulberry32(opts.seed ?? 1);
  const maxMoves = opts.maxMoves ?? 1000;
  const latenciesMs: number[] = [];
  let moves = 0;
  let ts = seats.createdAt;
  const order: Party[] = ["A", "B"];
  while (moves < maxMoves && !protocol.isTerminal(dtA.state)) {
    let progressed = false;
    for (const p of order) {
      if (protocol.isTerminal(dtA.state)) break;
      const dt = seatOf[p];
      const move = protocol.randomMove?.(dt.state, p, rng) ?? null;
      if (move === null) continue;
      ts += 1n;
      latenciesMs.push(await proposeAndAwait(dt, move, ts));
      moves++;
      progressed = true;
      if (moves >= maxMoves) break;
    }
    if (!progressed) break;
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
Expected: PASS. If `mulberry32`/`createParticipant` import paths differ, fix to the actual export location (grep `export.*mulberry32` and `export.*createParticipant` under `sui-tunnel-ts/src`).

- [ ] **Step 5: Commit**

```bash
git add tools/loadbench/src/match.ts tools/loadbench/src/match.test.ts
git commit -m "feat(loadbench): channel-agnostic match driver"
```

---

### Task 5: Game registry + wire bombIt/cross behaviors

**Files:**
- Modify: `sui-tunnel-ts/src/agents/behaviors.ts` (add `bombIt`, `cross`)
- Create: `tools/loadbench/src/games.ts`
- Test: `tools/loadbench/src/games.test.ts`

**Interfaces:**
- Consumes: `createBehaviorProtocol`, `BehaviorName` (extended); `playMatch`, `makeSeats` (Task 4).
- Produces: `PLAYABLE: readonly string[]`; `isPlayable(game: string): boolean`; `protocolFor(game: string): Protocol<unknown, unknown>`; `gameBalances(game: string): { a: bigint; b: bigint }` (default `{a:1_000_000n,b:1_000_000n}`).

Game name → behavior mapping: `payments→payment`, `poker→poker` (quantumPoker), `blackjack/ticTacToe/chat/bombIt/cross` map to their own names. Reject `battleship/coinFlip/dice/slots`.

- [ ] **Step 1: Wire the two new behaviors**

In `sui-tunnel-ts/src/agents/behaviors.ts`: import `BombItProtocol` from `../protocol/bombIt` and `CrossProtocol` from `../protocol/cross` (confirm the exact exported class names with `grep -nE "export class" sui-tunnel-ts/src/protocol/bombIt.ts sui-tunnel-ts/src/protocol/cross.ts`). Add `"bombIt"` and `"cross"` to `BehaviorName` and `BEHAVIOR_NAMES`, and add the two `case` arms to `createBehaviorProtocol`.

- [ ] **Step 2: Write the failing test**

`tools/loadbench/src/games.test.ts`:
```ts
import { test, expect } from "bun:test";
import { PLAYABLE, isPlayable, protocolFor, gameBalances } from "./games";
import { makeSeats, playMatch } from "./match";
import { pairLocalChannel } from "./channels/localChannel";

test("battleship and friends are not playable", () => {
  expect(isPlayable("battleship")).toBe(false);
  expect(isPlayable("blackjack")).toBe(true);
});

test.each([...PLAYABLE])("%s plays to a settlement over the local channel", async (game) => {
  const seats = makeSeats(`t-${game}`, gameBalances(game), 100n);
  const res = await playMatch(protocolFor(game), seats, pairLocalChannel(), { seed: 3, maxMoves: 500 });
  const s = res.settlement.settlement;
  expect(s.partyABalance + s.partyBBalance).toBe(seats.balances.a + seats.balances.b);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd tools/loadbench && bun test src/games.test.ts`
Expected: FAIL — `./games` not found.

- [ ] **Step 4: Implement `games.ts`**

```ts
import { createBehaviorProtocol, type BehaviorName } from "../../../sui-tunnel-ts/src/agents/behaviors";
import type { Protocol } from "../../../sui-tunnel-ts/src/protocol/Protocol";

const GAME_TO_BEHAVIOR: Record<string, BehaviorName> = {
  payments: "payment",
  poker: "poker",
  quantumPoker: "poker",
  blackjack: "blackjack",
  ticTacToe: "tictactoe",
  chat: "chat",
  bombIt: "bombIt",
  cross: "cross",
};

export const PLAYABLE = ["payments", "blackjack", "ticTacToe", "chat", "quantumPoker", "bombIt", "cross"] as const;

export function isPlayable(game: string): boolean {
  return game in GAME_TO_BEHAVIOR;
}

export function protocolFor(game: string): Protocol<unknown, unknown> {
  const behavior = GAME_TO_BEHAVIOR[game];
  if (!behavior) {
    throw new Error(`game "${game}" has no engine protocol (playable: ${PLAYABLE.join(", ")})`);
  }
  return createBehaviorProtocol(behavior);
}

export function gameBalances(_game: string): { a: bigint; b: bigint } {
  return { a: 1_000_000n, b: 1_000_000n };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd tools/loadbench && bun test src/games.test.ts`
Expected: PASS for all 7 playable games. Then verify the upstream package still typechecks: `cd ../../sui-tunnel-ts && pnpm typecheck` → no errors.

If a game never terminates under `randomMove` (e.g. `chat` may be open-ended), the match driver still returns at `maxMoves`; the settlement assertion holds regardless. That is acceptable — `maxMoves` bounds non-terminal games.

- [ ] **Step 6: Commit**

```bash
git add sui-tunnel-ts/src/agents/behaviors.ts tools/loadbench/src/games.ts tools/loadbench/src/games.test.ts
git commit -m "feat(loadbench): game registry; wire bombIt/cross behaviors"
```

---

### Task 6: Relay channel (headless WS transport)

**Files:**
- Create: `tools/loadbench/src/channels/relayChannel.ts`
- Test: `tools/loadbench/src/channels/relayChannel.test.ts`

**Interfaces:**
- Consumes: `framePayload`/`payloadFrame` (Task 3); `Transport`; an injectable `WebSocket` ctor (default `globalThis.WebSocket`, present in bun); `Ed25519Keypair` from `@mysten/sui/keypairs/ed25519`.
- Produces: `connectRelaySeat(opts: { url: string; game: string; keypair: Ed25519Keypair; WebSocketCtor?: typeof WebSocket }): Promise<{ transport: Transport; matchId: string; role: "A"|"B"; close(): void }>` — completes challenge→connect→queue.join, resolves on `match.found`, and returns a `Transport` that maps engine frames to/from this match's `relay` payloads.

Pairing isolation: callers pass a UNIQUE `game` token per match (e.g. `bench-<uuid>`) so the relay queue pairs only the two intended seats, never across concurrent matches.

- [ ] **Step 1: Write the failing test (fake WebSocket, no real relay)**

`tools/loadbench/src/channels/relayChannel.test.ts`:
```ts
import { test, expect } from "bun:test";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { connectRelaySeat } from "./relayChannel";

// Minimal fake that scripts the server side: challenge -> expect connect+queue.join -> match.found.
class FakeWS {
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) { queueMicrotask(() => { this.onopen?.(); this.srv({ type: "challenge", nonce: "n1" }); }); }
  send(s: string) {
    this.sent.push(s);
    const m = JSON.parse(s);
    if (m.type === "queue.join") this.srv({ type: "match.found", matchId: "m1", role: "A", opponentWallet: "0xB", game: m.game });
  }
  srv(o: unknown) { this.onmessage?.({ data: JSON.stringify(o) }); }
  close() {}
}

test("handshake completes and resolves on match.found", async () => {
  const seat = await connectRelaySeat({ url: "ws://x/v1/mp", game: "bench-1", keypair: new Ed25519Keypair(), WebSocketCtor: FakeWS as any });
  expect(seat.matchId).toBe("m1");
  expect(seat.role).toBe("A");
});

test("inbound relay frame surfaces as engine bytes; outbound send wraps as relay payload", async () => {
  let captured: FakeWS | null = null;
  class Spy extends FakeWS { constructor(u: string) { super(u); captured = this; } }
  const seat = await connectRelaySeat({ url: "ws://x/v1/mp", game: "bench-2", keypair: new Ed25519Keypair(), WebSocketCtor: Spy as any });
  const got: string[] = [];
  seat.transport.onFrame((f) => got.push(new TextDecoder().decode(f)));
  const inner = JSON.stringify({ kind: "ack", nonce: "1", sigResponder: "ab" });
  captured!.srv({ type: "relay", matchId: "m1", payload: JSON.stringify({ t: "frame", kind: "ack", data: inner }) });
  expect(got).toEqual([inner]);
  seat.transport.send(new TextEncoder().encode(inner));
  const last = JSON.parse(captured!.sent.at(-1)!);
  expect(last.type).toBe("relay");
  expect(JSON.parse(last.payload).t).toBe("frame");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/loadbench && bun test src/channels/relayChannel.test.ts`
Expected: FAIL — `./relayChannel` not found.

- [ ] **Step 3: Implement `relayChannel.ts`**

```ts
import type { Transport } from "../../../../sui-tunnel-ts/src/core/distributedTunnel";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { framePayload, payloadFrame } from "./relayEnvelope";

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

export interface RelaySeat { transport: Transport; matchId: string; role: "A" | "B"; close(): void }

export function connectRelaySeat(opts: {
  url: string; game: string; keypair: Ed25519Keypair; WebSocketCtor?: typeof WebSocket;
}): Promise<RelaySeat> {
  const WS = opts.WebSocketCtor ?? globalThis.WebSocket;
  const wallet = opts.keypair.getPublicKey().toSuiAddress();
  const pubkey = toHex(opts.keypair.getPublicKey().toRawBytes());
  const ws: any = new WS(opts.url);
  let frameCb: ((f: Uint8Array) => void) | null = null;
  let matchId = "";

  const transport: Transport = {
    send: (f) => ws.send(JSON.stringify({ type: "relay", matchId, payload: framePayload(f) })),
    onFrame: (cb) => { frameCb = cb; },
  };

  return new Promise<RelaySeat>((resolve, reject) => {
    ws.onerror = () => reject(new Error("relay socket error"));
    ws.onmessage = async (ev: { data: string }) => {
      const m = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
      if (m.type === "challenge") {
        const sig = toHex(await opts.keypair.sign(new TextEncoder().encode(m.nonce)));
        ws.send(JSON.stringify({ type: "connect", wallet, pubkey, sig, nonce: m.nonce }));
        ws.send(JSON.stringify({ type: "queue.join", game: opts.game }));
      } else if (m.type === "match.found") {
        matchId = m.matchId;
        resolve({ transport, matchId, role: m.role, close: () => ws.close() });
      } else if (m.type === "relay" && m.matchId === matchId) {
        const bytes = payloadFrame(m.payload);
        if (bytes) frameCb?.(bytes);
      }
    };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/loadbench && bun test src/channels/relayChannel.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/loadbench/src/channels/relayChannel.ts tools/loadbench/src/channels/relayChannel.test.ts
git commit -m "feat(loadbench): headless relay-channel WS transport"
```

---

### Task 7: On-chain bookends

**Files:**
- Create: `tools/loadbench/src/onchain.ts`
- Test: `tools/loadbench/src/onchain.test.ts` (unit: spec construction only — execution is covered by the Task 10 smoke)

**Interfaces:**
- Consumes: `buildOpenAndFundMany`, `buildCloseWithRootFromSettlement`, `execute`, `getCreatedObjectIds`, `getObjects`, `createSuiClient`; `Seats`, `MatchResult` (Task 4).
- Produces:
  - `openSpec(seats: Seats): TunnelOpenSpec` — maps `Seats` to a `create_and_fund` spec.
  - `openTunnels(client, funder, specs: TunnelOpenSpec[]): Promise<string[]>` — one PTB, returns created tunnel ids in object order.
  - `settleTunnel(client, funder, tunnelId: string, settlement): Promise<string>` — close cooperatively, returns digest.

- [ ] **Step 1: Write the failing test (pure spec mapping, no chain)**

`tools/loadbench/src/onchain.test.ts`:
```ts
import { test, expect } from "bun:test";
import { makeSeats } from "./match";
import { openSpec } from "./onchain";

test("openSpec mirrors seat addresses and stakes into the funding spec", () => {
  const seats = makeSeats("t-9", { a: 5n, b: 7n }, 0n);
  const spec = openSpec(seats);
  expect(spec.partyA.address).toBe(seats.partyA.address);
  expect(spec.partyB.address).toBe(seats.partyB.address);
  expect(spec.aAmount).toBe(5n);
  expect(spec.bAmount).toBe(7n);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/loadbench && bun test src/onchain.test.ts`
Expected: FAIL — `./onchain` not found.

- [ ] **Step 3: Implement `onchain.ts`**

```ts
import { Transaction } from "@mysten/sui/transactions";
import type { SuiClient } from "@mysten/sui/client";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { buildOpenAndFundMany, type TunnelOpenSpec } from "../../../sui-tunnel-ts/src/onchain/createAndFund";
import { buildCloseWithRootFromSettlement } from "../../../sui-tunnel-ts/src/onchain/txbuilders";
import { execute } from "../../../sui-tunnel-ts/src/onchain/lifecycle";
import { getCreatedObjectIds } from "../../../sui-tunnel-ts/src/utils";
import type { Seats } from "./match";
import type { CoSignedSettlementWithRoot } from "../../../sui-tunnel-ts/src/core/tunnel";

export function openSpec(seats: Seats): TunnelOpenSpec {
  const ep = (p: Seats["partyA"]) => ({ address: p.address, publicKey: p.keyPair.publicKey, signatureType: p.keyPair.scheme });
  return { partyA: ep(seats.partyA), partyB: ep(seats.partyB), aAmount: seats.balances.a, bAmount: seats.balances.b, timeoutMs: 3_600_000n };
}

export async function openTunnels(client: SuiClient, funder: Ed25519Keypair, specs: TunnelOpenSpec[]): Promise<string[]> {
  const tx = new Transaction();
  buildOpenAndFundMany(tx, specs);
  const res = await execute(client, funder, tx, { waitForFinality: true });
  return getCreatedObjectIds(res.objectChanges as any[], "::tunnel::Tunnel<");
}

export async function settleTunnel(client: SuiClient, funder: Ed25519Keypair, tunnelId: string, settlement: CoSignedSettlementWithRoot): Promise<string> {
  const tx = new Transaction();
  buildCloseWithRootFromSettlement(tx, tunnelId, settlement);
  const res = await execute(client, funder, tx, { waitForFinality: true });
  return res.digest;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/loadbench && bun test src/onchain.test.ts`
Expected: PASS. (Confirm `TunnelOpenSpec` field names with `sed -n '108,118p' ../../sui-tunnel-ts/src/onchain/createAndFund.ts`; adjust `openSpec` if a field differs.)

- [ ] **Step 5: Commit**

```bash
git add tools/loadbench/src/onchain.ts tools/loadbench/src/onchain.test.ts
git commit -m "feat(loadbench): on-chain open/settle bookends"
```

---

### Task 8: Local stack — Docker Compose + setup

**Files:**
- Create: `tools/loadbench/docker-compose.yml`
- Create: `tools/loadbench/src/stack.ts`
- Create: `tools/loadbench/src/env.ts` (read/write `.env.local`)
- Test: `tools/loadbench/src/env.test.ts`

**Interfaces:**
- Produces: `readEnvLocal(): Record<string,string>`; `writeEnvLocal(vars: Record<string,string>): void` (file `tools/loadbench/.env.local`); `stack.ts` default-exported `main()` that brings up compose, waits for localnet RPC + faucet, publishes the package, funds keys, and writes `.env.local` + `keys.json`.

- [ ] **Step 1: Author the compose file**

`tools/loadbench/docker-compose.yml`:
```yaml
services:
  sui-localnet:
    image: mysten/sui-tools:devnet
    command: ["sui", "start", "--with-faucet", "--force-regenesis"]
    ports: ["9000:9000", "9123:9123"]
    healthcheck:
      test: ["CMD", "curl", "-fsS", "-X", "POST", "http://127.0.0.1:9000",
             "-H", "content-type: application/json",
             "-d", "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"sui_getChainIdentifier\",\"params\":[]}"]
      interval: 3s
      timeout: 3s
      retries: 40
  valkey:
    image: valkey/valkey:8-alpine
    ports: ["6379:6379"]
    healthcheck:
      test: ["CMD", "valkey-cli", "ping"]
      interval: 3s
      timeout: 3s
      retries: 10
```
(If the `mysten/sui-tools` tag/flags differ on this machine, adjust to the locally available Sui localnet image; the contract is RPC on :9000 and faucet on :9123.)

- [ ] **Step 2: Write the failing test for env round-trip**

`tools/loadbench/src/env.test.ts`:
```ts
import { test, expect } from "bun:test";
import { parseEnv, serializeEnv } from "./env";

test("env serialize/parse round-trips KEY=VALUE lines", () => {
  const vars = { PACKAGE_ID: "0xabc", SUI_RPC_URL: "http://127.0.0.1:9000" };
  expect(parseEnv(serializeEnv(vars))).toEqual(vars);
});

test("parseEnv ignores blanks and comments", () => {
  expect(parseEnv("# c\n\nA=1\n")).toEqual({ A: "1" });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd tools/loadbench && bun test src/env.test.ts`
Expected: FAIL — `./env` not found.

- [ ] **Step 4: Implement `env.ts`**

```ts
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const ENV_PATH = new URL("../.env.local", import.meta.url);

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i > 0) out[t.slice(0, i)] = t.slice(i + 1);
  }
  return out;
}

export function serializeEnv(vars: Record<string, string>): string {
  return Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
}

export function readEnvLocal(): Record<string, string> {
  return existsSync(ENV_PATH) ? parseEnv(readFileSync(ENV_PATH, "utf8")) : {};
}

export function writeEnvLocal(vars: Record<string, string>): void {
  writeFileSync(ENV_PATH, serializeEnv({ ...readEnvLocal(), ...vars }));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd tools/loadbench && bun test src/env.test.ts`
Expected: PASS.

- [ ] **Step 6: Implement `stack.ts` (orchestration; integration-verified)**

```ts
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { getFaucetHost, requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { writeEnvLocal } from "./env";

const RPC = "http://127.0.0.1:9000";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitRpc(client: SuiClient) {
  for (let i = 0; i < 60; i++) {
    try { await client.getChainIdentifier(); return; } catch { await sleep(2000); }
  }
  throw new Error("localnet RPC not healthy after 120s");
}

function publishPackage(): string {
  const out = spawnSync("sui", ["client", "publish", "--gas-budget", "200000000", "--json", "../../sui_tunnel"], { encoding: "utf8" });
  if (out.status !== 0) throw new Error(`publish failed: ${out.stderr || out.stdout}`);
  const changes = JSON.parse(out.stdout).objectChanges as any[];
  const pkg = changes.find((c) => c.type === "published");
  if (!pkg) throw new Error("no published package in objectChanges");
  return pkg.packageId as string;
}

async function fundKeys(client: SuiClient, n: number): Promise<{ secretKey: string; address: string }[]> {
  const keys: { secretKey: string; address: string }[] = [];
  for (let i = 0; i < n; i++) {
    const kp = new Ed25519Keypair();
    const address = kp.toSuiAddress();
    await requestSuiFromFaucetV2({ host: getFaucetHost("localnet"), recipient: address });
    keys.push({ secretKey: kp.getSecretKey(), address });
  }
  for (const k of keys) {
    for (let i = 0; i < 30; i++) {
      const { totalBalance } = await client.getBalance({ owner: k.address });
      if (BigInt(totalBalance) > 0n) break;
      await sleep(1000);
    }
  }
  return keys;
}

async function main() {
  const n = Number(process.env.N ?? "8");
  console.log("bringing up compose infra (localnet + valkey)…");
  const up = spawnSync("docker", ["compose", "-f", "docker-compose.yml", "up", "-d", "--wait"], { stdio: "inherit" });
  if (up.status !== 0) throw new Error("docker compose up failed");
  const client = new SuiClient({ url: getFullnodeUrl("localnet") ?? RPC });
  await waitRpc(client);
  console.log("publishing sui_tunnel package…");
  const packageId = publishPackage();
  console.log("funding settler + bench keys…");
  const settler = (await fundKeys(client, 1))[0];
  const keys = await fundKeys(client, n);
  writeFileSync(new URL("../keys.json", import.meta.url), JSON.stringify(keys, null, 2));
  writeEnvLocal({
    SUI_RPC_URL: RPC,
    SUI_NETWORK: RPC,
    TUNNEL_PACKAGE_ID: packageId,
    PACKAGE_ID: packageId,
    SUI_SETTLER_KEY: settler.secretKey,
  });
  console.log(`stack ready — PACKAGE_ID=${packageId}, ${n} funded keys in keys.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 7: Integration verify (manual, real Docker)**

Run: `cd tools/loadbench && bun run stack`
Expected output ends with: `stack ready — PACKAGE_ID=0x…, 8 funded keys in keys.json`, and `.env.local` + `keys.json` exist. Confirm: `docker compose ps` shows `sui-localnet` and `valkey` healthy.
(Adjust the publish path / faucet API names if the local SDK version differs — verify against `sui-tunnel-ts/src/examples/createAndFundBatch.ts`, which uses the same faucet calls.)

- [ ] **Step 8: Commit**

```bash
git add tools/loadbench/docker-compose.yml tools/loadbench/src/env.ts tools/loadbench/src/env.test.ts tools/loadbench/src/stack.ts
git commit -m "feat(loadbench): compose infra + stack setup"
```

---

### Task 9: Relay process spawn + health

**Files:**
- Create: `tools/loadbench/src/relayProcess.ts`
- Test: `tools/loadbench/src/relayProcess.test.ts` (unit: health-poll logic with an injected fetch)

**Interfaces:**
- Consumes: `readEnvLocal` (Task 8).
- Produces: `relayWsUrl(): string` (default `ws://127.0.0.1:8080/v1/mp`); `ensureRelay(opts?: { httpBase?: string; fetchImpl?: typeof fetch }): Promise<{ alreadyRunning: boolean; stop(): void }>` — if `GET <httpBase>/health` is already healthy, returns `alreadyRunning:true`; otherwise spawns `cargo run -p tunnel-manager` with env from `.env.local` (in-memory store: no `REDIS_*` set) and polls health.

- [ ] **Step 1: Write the failing test**

`tools/loadbench/src/relayProcess.test.ts`:
```ts
import { test, expect } from "bun:test";
import { waitHealthy } from "./relayProcess";

test("waitHealthy resolves once health returns ok", async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls++; return { ok: calls >= 3 } as Response; }) as unknown as typeof fetch;
  await waitHealthy("http://x", { fetchImpl, intervalMs: 1, tries: 10 });
  expect(calls).toBe(3);
});

test("waitHealthy throws after exhausting tries", async () => {
  const fetchImpl = (async () => ({ ok: false } as Response)) as unknown as typeof fetch;
  await expect(waitHealthy("http://x", { fetchImpl, intervalMs: 1, tries: 3 })).rejects.toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/loadbench && bun test src/relayProcess.test.ts`
Expected: FAIL — `./relayProcess` not found.

- [ ] **Step 3: Implement `relayProcess.ts`**

```ts
import { spawn, type ChildProcess } from "node:child_process";
import { readEnvLocal } from "./env";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function relayWsUrl(): string {
  return process.env.MP_WS_URL ?? "ws://127.0.0.1:8080/v1/mp";
}

export async function waitHealthy(httpBase: string, opts: { fetchImpl?: typeof fetch; intervalMs?: number; tries?: number } = {}): Promise<void> {
  const f = opts.fetchImpl ?? fetch;
  const tries = opts.tries ?? 60;
  for (let i = 0; i < tries; i++) {
    try { const r = await f(`${httpBase}/health`); if (r.ok) return; } catch { /* not up yet */ }
    await sleep(opts.intervalMs ?? 1000);
  }
  throw new Error(`relay not healthy at ${httpBase} after ${tries} tries`);
}

export async function ensureRelay(opts: { httpBase?: string; fetchImpl?: typeof fetch } = {}): Promise<{ alreadyRunning: boolean; stop(): void }> {
  const httpBase = opts.httpBase ?? "http://127.0.0.1:8080";
  const f = opts.fetchImpl ?? fetch;
  try { if ((await f(`${httpBase}/health`)).ok) return { alreadyRunning: true, stop() {} }; } catch { /* spawn below */ }
  const env = { ...process.env, ...readEnvLocal(), TUNNEL_MANAGER_ADDR: "127.0.0.1:8080" };
  delete (env as Record<string, string>).REDIS_CACHE_URL;
  delete (env as Record<string, string>).REDIS_PUBSUB_URL;
  const child: ChildProcess = spawn("cargo", ["run", "-q", "-p", "tunnel-manager"], { cwd: "../..", env, stdio: "inherit" });
  await waitHealthy(httpBase, { fetchImpl: f });
  return { alreadyRunning: false, stop: () => child.kill("SIGTERM") };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/loadbench && bun test src/relayProcess.test.ts`
Expected: PASS (2 tests). Confirm the relay exposes `GET /health` (`grep -n "health" backend/tunnel-manager/src/routes.rs backend/tunnel-manager/src/main.rs`); if the path differs, update `waitHealthy`/`ensureRelay`.

- [ ] **Step 5: Commit**

```bash
git add tools/loadbench/src/relayProcess.ts tools/loadbench/src/relayProcess.test.ts
git commit -m "feat(loadbench): spawn + health-gate the relay"
```

---

### Task 10: `bench:game` entrypoint + golden smoke

**Files:**
- Create: `tools/loadbench/src/runMatch.ts` (compose channel + on-chain bookends into one full match)
- Create: `tools/loadbench/src/benchGame.ts`
- Test: `tools/loadbench/src/benchGame.test.ts` (unit: arg parsing)
- Test: `tools/loadbench/src/smoke.test.ts` (integration: real local stack, gated)

**Interfaces:**
- Consumes: `openTunnels`/`settleTunnel`/`openSpec` (Task 7); `pairLocalChannel` (Task 2); `connectRelaySeat` (Task 6); `playMatch`/`makeSeats` (Task 4); `protocolFor`/`gameBalances`/`isPlayable` (Task 5); `ensureRelay`/`relayWsUrl` (Task 9); `readEnvLocal` (Task 8); `createSuiClient`/`getKeypairFromEnv`.
- Produces:
  - `parseBenchArgs(argv: string[]): { game: string; channel: "local"|"relay"; anchor: "onchain"|"offchain"; matches: number; concurrency: number; all: boolean }`
  - `runFullMatch(game: string, channel: "local"|"relay", anchor: "onchain"|"offchain", ctx: { client?: SuiClient; funder?: Ed25519Keypair }): Promise<MatchResult & { openMs: number; settleMs: number; playMs: number }>`

`runFullMatch`: when `anchor === "onchain"`, `openTunnels([openSpec(seats)])` → tunnelId (require `ctx.client`+`ctx.funder`); when `offchain`, keep the synthetic `seats.tunnelId` and skip the chain. Build transports (`local` → `pairLocalChannel()`; `relay` → two `connectRelaySeat` on a unique `bench-<uuid>` game, take `[A.transport, B.transport]` ordered by role); `playMatch`; then `settleTunnel` only when `onchain`. Times each phase (`openMs`/`settleMs` are `0` offchain).

- [ ] **Step 1: Write the failing arg-parse test**

`tools/loadbench/src/benchGame.test.ts`:
```ts
import { test, expect } from "bun:test";
import { parseBenchArgs } from "./benchGame";

test("defaults: relay channel, onchain anchor, 1 match, concurrency 1", () => {
  const a = parseBenchArgs(["blackjack"]);
  expect(a).toEqual({ game: "blackjack", channel: "relay", anchor: "onchain", matches: 1, concurrency: 1, all: false });
});

test("flags override defaults", () => {
  const a = parseBenchArgs(["payments", "--channel", "local", "--matches", "10", "--concurrency", "4"]);
  expect(a.channel).toBe("local");
  expect(a.matches).toBe(10);
  expect(a.concurrency).toBe(4);
});

test("--offchain selects the offchain anchor (no chain)", () => {
  expect(parseBenchArgs(["payments", "--offchain"]).anchor).toBe("offchain");
  expect(parseBenchArgs(["payments", "--anchor", "offchain"]).anchor).toBe("offchain");
});

test("--all sets the all flag", () => {
  expect(parseBenchArgs(["--all"]).all).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/loadbench && bun test src/benchGame.test.ts`
Expected: FAIL — `./benchGame` not found.

- [ ] **Step 3: Implement `runMatch.ts`**

```ts
import { randomUUID } from "node:crypto";
import type { SuiClient } from "@mysten/sui/client";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Ed25519Keypair as KP } from "@mysten/sui/keypairs/ed25519";
import { makeSeats, playMatch, type MatchResult } from "./match";
import { pairLocalChannel } from "./channels/localChannel";
import { connectRelaySeat } from "./channels/relayChannel";
import { protocolFor, gameBalances } from "./games";
import { openSpec, openTunnels, settleTunnel } from "./onchain";
import { relayWsUrl } from "./relayProcess";
import type { Transport } from "../../../sui-tunnel-ts/src/core/distributedTunnel";

export type Phased = MatchResult & { openMs: number; playMs: number; settleMs: number };

export async function runFullMatch(
  game: string,
  channel: "local" | "relay",
  anchor: "onchain" | "offchain",
  ctx: { client?: SuiClient; funder?: Ed25519Keypair },
): Promise<Phased> {
  const id = randomUUID();
  const seats = makeSeats(id, gameBalances(game), 0n);
  let openMs = 0;
  if (anchor === "onchain") {
    if (!ctx.client || !ctx.funder) throw new Error("onchain anchor requires client+funder");
    const t0 = performance.now();
    const [tunnelId] = await openTunnels(ctx.client, ctx.funder, [openSpec(seats)]);
    if (!tunnelId) throw new Error("open produced no tunnel id");
    seats.tunnelId = tunnelId;
    openMs = performance.now() - t0;
  }
  // offchain: keep the synthetic seats.tunnelId (= id); no chain touched.

  let transports: [Transport, Transport];
  const closers: Array<() => void> = [];
  if (channel === "local") {
    transports = pairLocalChannel();
  } else {
    const token = `bench-${id}`;
    const [sa, sb] = await Promise.all([
      connectRelaySeat({ url: relayWsUrl(), game: token, keypair: new KP() }),
      connectRelaySeat({ url: relayWsUrl(), game: token, keypair: new KP() }),
    ]);
    closers.push(sa.close, sb.close);
    const byRole = (r: "A" | "B") => (sa.role === r ? sa.transport : sb.transport);
    transports = [byRole("A"), byRole("B")];
  }

  const t1 = performance.now();
  const res = await playMatch(protocolFor(game), seats, transports, { maxMoves: 1000 });
  const playMs = performance.now() - t1;
  for (const c of closers) c();

  let settleMs = 0;
  if (anchor === "onchain") {
    const t2 = performance.now();
    await settleTunnel(ctx.client!, ctx.funder!, seats.tunnelId, res.settlement);
    settleMs = performance.now() - t2;
  }
  return { ...res, openMs, playMs, settleMs };
}
```

- [ ] **Step 4: Implement `benchGame.ts`**

```ts
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { isPlayable, PLAYABLE } from "./games";
import { readEnvLocal } from "./env";
import { ensureRelay } from "./relayProcess";
import { runFullMatch } from "./runMatch";
import { summarize, ratePerSec } from "./metrics";

export function parseBenchArgs(argv: string[]) {
  const out = { game: "", channel: "relay" as "local" | "relay", anchor: "onchain" as "onchain" | "offchain", matches: 1, concurrency: 1, all: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") out.all = true;
    else if (a === "--offchain") out.anchor = "offchain";
    else if (a === "--anchor") out.anchor = argv[++i] as "onchain" | "offchain";
    else if (a === "--channel") out.channel = argv[++i] as "local" | "relay";
    else if (a === "--matches") out.matches = Number(argv[++i]);
    else if (a === "--concurrency") out.concurrency = Number(argv[++i]);
    else if (!a.startsWith("--")) out.game = a;
  }
  return out;
}

function funderFromEnv(env: Record<string, string>): Ed25519Keypair {
  const { secretKey } = decodeSuiPrivateKey(env.SUI_SETTLER_KEY);
  return Ed25519Keypair.fromSecretKey(secretKey);
}

async function benchOne(game: string, args: ReturnType<typeof parseBenchArgs>, ctx: { client?: SuiClient; funder?: Ed25519Keypair }) {
  const latencies: number[] = [];
  let moves = 0;
  const start = performance.now();
  for (let done = 0; done < args.matches; done += args.concurrency) {
    const batch = Math.min(args.concurrency, args.matches - done);
    const runs = await Promise.all(Array.from({ length: batch }, () => runFullMatch(game, args.channel, args.anchor, ctx)));
    for (const r of runs) { latencies.push(...r.latenciesMs); moves += r.moves; }
  }
  const elapsed = performance.now() - start;
  const s = summarize(latencies);
  console.log(`[${args.channel}/${args.anchor}] ${game}: ${moves} moves, ${ratePerSec(moves, elapsed).toFixed(1)} moves/s, p50=${s.p50.toFixed(2)}ms p99=${s.p99.toFixed(2)}ms over ${args.matches} match(es)`);
}

async function main() {
  const args = parseBenchArgs(process.argv.slice(2));
  const games = args.all ? [...PLAYABLE] : [args.game];
  for (const g of games) if (!isPlayable(g)) throw new Error(`game "${g}" is not playable (try: ${PLAYABLE.join(", ")})`);
  // offchain needs no chain; onchain needs the published package + funded settler.
  const ctx: { client?: SuiClient; funder?: Ed25519Keypair } = {};
  if (args.anchor === "onchain") {
    const env = readEnvLocal();
    if (!env.TUNNEL_PACKAGE_ID) throw new Error("run `bun run stack` first (.env.local missing PACKAGE_ID)");
    process.env.PACKAGE_ID = env.PACKAGE_ID;
    process.env.SUI_NETWORK = env.SUI_NETWORK;
    ctx.client = new SuiClient({ url: getFullnodeUrl("localnet") });
    ctx.funder = funderFromEnv(env);
  }
  let relay: { stop(): void } | null = null;
  if (args.channel === "relay") relay = await ensureRelay();
  try { for (const g of games) await benchOne(g, args, ctx); }
  finally { relay?.stop(); }
}

if (import.meta.main) main().catch((e) => { console.error(e); process.exit(1); });
```

Guard `main()` behind `import.meta.main` so importing `parseBenchArgs` in tests does not run it.

- [ ] **Step 5: Run the arg-parse test to verify it passes**

Run: `cd tools/loadbench && bun test src/benchGame.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Write the integration smoke (gated on a real stack)**

`tools/loadbench/src/smoke.test.ts`:
```ts
import { test, expect } from "bun:test";
import { readEnvLocal } from "./env";
import { runFullMatch } from "./runMatch";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";

const env = readEnvLocal();
const gated = env.TUNNEL_PACKAGE_ID ? test : test.skip;

gated("payments local-channel match opens, plays, and settles on the local stack", async () => {
  process.env.PACKAGE_ID = env.PACKAGE_ID;
  process.env.SUI_NETWORK = env.SUI_NETWORK;
  const client = new SuiClient({ url: getFullnodeUrl("localnet") });
  const { secretKey } = decodeSuiPrivateKey(env.SUI_SETTLER_KEY);
  const funder = Ed25519Keypair.fromSecretKey(secretKey);
  const r = await runFullMatch("payments", "local", "onchain", { client, funder });
  expect(r.moves).toBeGreaterThan(0);
  expect(r.settleMs).toBeGreaterThan(0);
}, 120_000);

test("offchain local-channel match plays with no chain (no stack needed)", async () => {
  const r = await runFullMatch("payments", "local", "offchain", {});
  expect(r.moves).toBeGreaterThan(0);
  expect(r.openMs).toBe(0);
  expect(r.settleMs).toBe(0);
});
```

- [ ] **Step 7: Run the smoke against a live stack**

Run: `cd tools/loadbench && bun run stack && bun test src/smoke.test.ts`
Expected: the gated test runs (not skipped) and PASSES — a real tunnel opened and closed on localnet. Without a stack it auto-skips, keeping `bun test` green in CI-less runs.

- [ ] **Step 8: Commit**

```bash
git add tools/loadbench/src/runMatch.ts tools/loadbench/src/benchGame.ts tools/loadbench/src/benchGame.test.ts tools/loadbench/src/smoke.test.ts
git commit -m "feat(loadbench): bench:game entrypoint + golden smoke"
```

---

### Task 11: `swarm` entrypoint (aggregate TPS)

**Files:**
- Create: `tools/loadbench/src/swarm.ts`
- Test: `tools/loadbench/src/swarm.test.ts` (unit: arg parsing + scheduler with a fake match fn)

**Interfaces:**
- Consumes: `runFullMatch` (Task 10); `ensureRelay`/`relayWsUrl` (Task 9); `readEnvLocal`; `ratePerSec`; `PLAYABLE`.
- Produces:
  - `parseSwarmArgs(argv: string[]): { channel: "local"|"relay"; anchor: "onchain"|"offchain"; concurrency: number; matches: number | null; durationS: number | null; games: string[] }`
  - `runSwarm(run: () => Promise<{ moves: number }>, opts: { concurrency: number; matches: number | null; durationMs: number | null; now: () => number }): Promise<{ moves: number; matches: number; elapsedMs: number }>` — keeps `concurrency` matches in flight until BOTH stop conditions that are set are satisfied (matches cap reached, or duration elapsed; whichever is set — both may be set, first to trip wins).

- [ ] **Step 1: Write the failing test**

`tools/loadbench/src/swarm.test.ts`:
```ts
import { test, expect } from "bun:test";
import { parseSwarmArgs, runSwarm } from "./swarm";

test("parseSwarmArgs reads channel, anchor, concurrency, both stop conditions, games", () => {
  const a = parseSwarmArgs(["--channel", "local", "--offchain", "--concurrency", "8", "--matches", "100", "--duration", "30", "--games", "blackjack,chat"]);
  expect(a).toEqual({ channel: "local", anchor: "offchain", concurrency: 8, matches: 100, durationS: 30, games: ["blackjack", "chat"] });
});

test("parseSwarmArgs defaults to the onchain anchor", () => {
  expect(parseSwarmArgs([]).anchor).toBe("onchain");
});

test("runSwarm stops at the matches cap", async () => {
  const res = await runSwarm(async () => ({ moves: 5 }), { concurrency: 4, matches: 20, durationMs: null, now: () => 0 });
  expect(res.matches).toBe(20);
  expect(res.moves).toBe(100);
});

test("runSwarm stops when duration elapses", async () => {
  let t = 0;
  const res = await runSwarm(async () => { t += 10; return { moves: 1 }; }, { concurrency: 1, matches: null, durationMs: 50, now: () => t });
  expect(res.elapsedMs).toBeGreaterThanOrEqual(50);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/loadbench && bun test src/swarm.test.ts`
Expected: FAIL — `./swarm` not found.

- [ ] **Step 3: Implement `swarm.ts`**

```ts
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { PLAYABLE } from "./games";
import { readEnvLocal } from "./env";
import { ensureRelay } from "./relayProcess";
import { runFullMatch } from "./runMatch";
import { ratePerSec } from "./metrics";

export function parseSwarmArgs(argv: string[]) {
  const out = { channel: "relay" as "local" | "relay", anchor: "onchain" as "onchain" | "offchain", concurrency: 8, matches: null as number | null, durationS: null as number | null, games: [...PLAYABLE] as string[] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--channel") out.channel = argv[++i] as "local" | "relay";
    else if (a === "--offchain") out.anchor = "offchain";
    else if (a === "--anchor") out.anchor = argv[++i] as "onchain" | "offchain";
    else if (a === "--concurrency") out.concurrency = Number(argv[++i]);
    else if (a === "--matches") out.matches = Number(argv[++i]);
    else if (a === "--duration") out.durationS = Number(argv[++i]);
    else if (a === "--games") out.games = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

export async function runSwarm(
  run: () => Promise<{ moves: number }>,
  opts: { concurrency: number; matches: number | null; durationMs: number | null; now: () => number },
): Promise<{ moves: number; matches: number; elapsedMs: number }> {
  const start = opts.now();
  let moves = 0, matches = 0, started = 0;
  const done = () => {
    if (opts.matches !== null && started >= opts.matches) return true;
    if (opts.durationMs !== null && opts.now() - start >= opts.durationMs) return true;
    return false;
  };
  async function worker() {
    while (!done()) {
      started++;
      const r = await run();
      moves += r.moves; matches++;
    }
  }
  await Promise.all(Array.from({ length: opts.concurrency }, () => worker()));
  return { moves, matches, elapsedMs: opts.now() - start };
}

async function main() {
  const args = parseSwarmArgs(process.argv.slice(2));
  if (args.matches === null && args.durationS === null) args.durationS = 15;
  const ctx: { client?: SuiClient; funder?: Ed25519Keypair } = {};
  if (args.anchor === "onchain") {
    const env = readEnvLocal();
    if (!env.TUNNEL_PACKAGE_ID) throw new Error("run `bun run stack` first");
    process.env.PACKAGE_ID = env.PACKAGE_ID;
    process.env.SUI_NETWORK = env.SUI_NETWORK;
    ctx.client = new SuiClient({ url: getFullnodeUrl("localnet") });
    const { secretKey } = decodeSuiPrivateKey(env.SUI_SETTLER_KEY);
    ctx.funder = Ed25519Keypair.fromSecretKey(secretKey);
  }
  const relay = args.channel === "relay" ? await ensureRelay() : null;
  let g = 0;
  const nextGame = () => args.games[g++ % args.games.length];
  const tag = `${args.channel}/${args.anchor}`;
  try {
    const res = await runSwarm(() => runFullMatch(nextGame(), args.channel, args.anchor, ctx), {
      concurrency: args.concurrency, matches: args.matches, durationMs: args.durationS !== null ? args.durationS * 1000 : null, now: () => performance.now(),
    });
    console.log(`[${tag}] swarm: ${res.moves} moves over ${res.matches} matches in ${(res.elapsedMs / 1000).toFixed(1)}s`);
    console.log(`[${tag}] aggregate move-TPS: ${ratePerSec(res.moves, res.elapsedMs).toFixed(1)}`);
    if (args.anchor === "onchain") {
      console.log(`[${tag}] tunnels settled/s: ${ratePerSec(res.matches, res.elapsedMs).toFixed(2)} (on-chain-finality-bound)`);
    }
  } finally { relay?.stop(); }
}

if (import.meta.main) main().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/loadbench && bun test src/swarm.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Integration verify (offchain burst + onchain, both channels)**

Offchain burst (no stack needed for local; relay only for relay):
- `cd tools/loadbench && bun run swarm --offchain --channel local --concurrency 16 --duration 10` → pure engine move-TPS, no chain, no relay.
- `bun run swarm --offchain --channel relay --concurrency 16 --duration 10` → relay-bound move-TPS, no chain (auto-spawns the relay).

Onchain (full real game, needs the stack):
- `bun run stack`, then `bun run swarm --channel local --concurrency 8 --matches 40` and `bun run swarm --channel relay --concurrency 8 --duration 15`.

Expected: each prints an aggregate move-TPS labelled `[channel/anchor]`; `local` is the engine ceiling, `relay` the served number; `offchain` runs print no "tunnels settled/s" line, `onchain` runs do. No errors.

- [ ] **Step 6: Commit**

```bash
git add tools/loadbench/src/swarm.ts tools/loadbench/src/swarm.test.ts
git commit -m "feat(loadbench): swarm TPS entrypoint"
```

---

## Self-Review

**Spec coverage:**
- Standardized local stack → Task 8 (compose: localnet+valkey, setup) + Task 9 (relay spawn). ✓
- `bench:game` per game → Task 10. ✓
- `swarm` for TPS → Task 11. ✓
- Two channels (local/relay), same engine path → Tasks 2, 6, 10 (`runFullMatch` channel switch). ✓
- Anchor mode onchain/offchain (offchain = pure-burst TPS, no chain) → Tasks 10, 11 (`runFullMatch` anchor switch; `--offchain`/`--anchor` flags; offchain skips client/funder/stack). ✓
- Real engine + signing + on-chain open/settle → Tasks 4, 7, 10. ✓
- 7 playable games; bombIt/cross wired; 4 rejected → Task 5. ✓
- In-memory relay store default → Task 9 (`ensureRelay` deletes `REDIS_*`). ✓
- Channel-labelled output; settled/s vs move-TPS distinction → Tasks 10, 11. ✓
- Upstream pnpm untouched except 2-line behaviors → Task 5 only. ✓
- Tests via `bun test`, golden smoke at a real boundary, gated not faked → Tasks 1–11 units + Task 10 smoke. ✓
- SSE cross-check (relay live-stats) — design §4 mentions this as a nice-to-have. **Deferred:** not blocking; can be added to `swarm.ts` later by reading the `live-stats` SSE and comparing. Noted here so it is not silently dropped.

**Placeholder scan:** No TBD/TODO; every code step has complete code; verification commands have expected output. ✓

**Type consistency:** `Transport`, `Seats`, `MatchResult`/`Phased`, `parseBenchArgs`/`parseSwarmArgs`, `runFullMatch`, `ensureRelay`, `connectRelaySeat`, `playMatch`, `protocolFor` names are used identically across tasks. Import paths use the `../../../sui-tunnel-ts/src/...` depth from `src/` and `../../../../` from `src/channels/`; each task instructs verifying the exact export with `grep` if a path/field differs (the engine is upstream and not re-checked file-by-file here). ✓

**Known verification points to confirm during execution (named, not hand-waved):** exact class names `BombItProtocol`/`CrossProtocol` (Task 5); `TunnelOpenSpec` field names (Task 7); `mulberry32`/`createParticipant` export locations (Task 4); relay `/health` path (Task 9); Sui localnet image tag/flags (Task 8). Each task tells the implementer the grep to run.
