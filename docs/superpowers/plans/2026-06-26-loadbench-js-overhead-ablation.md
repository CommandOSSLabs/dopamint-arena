# loadbench JS-overhead ablation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a JS-side, capture-then-replay ablation to loadbench that attributes loadbench's real per-move cost to each structural overhead (JSON codec, frame JSON, bigint, Promise/await, native crypto hop, GC) versus rustbench, as a line-item report.

**Architecture:** Run two deterministic real `playMatch` blackjack matches offchain/local — one clean (for the per-move wall budget + aggregate GC), one with non-invasive recording wrappers (transports + a `setDefaultBackend` crypto wrapper) to harvest real artifacts. Then time the *real* engine functions (`encodeFrame`/`decodeFrame`, `bigintSafeCodec`, `nativeBackend` sign/verify, the `proposeAndAwait` wrapper) over those artifacts in warmed, median-of-N loops. Render a report with non-overlapping additive buckets, a residual, and informational sub-measures. No edits to upstream `sui-tunnel-ts`.

**Tech Stack:** TypeScript on **Bun** (`bun test`, `bun run`); engine imported via relative paths from `../../../sui-tunnel-ts/src`; `node:perf_hooks`, `process.hrtime.bigint()`.

## Global Constraints

- loadbench is a **Bun** package — do NOT convert tooling. Tests use `import { test, expect } from "bun:test"`; run with `bun test`.
- **No edits to `sui-tunnel-ts/` or `frontend/`** — only `tools/loadbench/` changes. Engine seams used are already public: `encodeFrame`, `decodeFrame`, `MoveCodec`, `Frame`, `setDefaultBackend`, `defaultBackend`, `nativeBackend`, `nobleBackend`, `nativeBackendSupported`.
- Import the engine via relative paths exactly as existing loadbench files do (e.g. `../../../sui-tunnel-ts/src/core/distributedFrame`).
- Conventional Commits; subject ≤ 50 chars, imperative, lowercase after type; **no AI attribution** in commit messages.
- Ablation is **single-thread, offchain, local channel, blackjack** only. The TS blackjack match is deterministic at **34 moves** (verified). Never assert rustbench's "143" on the TS side.
- No flaky absolute-timing assertions in tests — assert structure, shape, and determinism, not nanoseconds.
- All new files live in `tools/loadbench/src/`. Run all commands from `tools/loadbench/`.

---

### Task 1: Export the two loadbench-owned measurement seams

The ablation must time the real move codec and the real Promise/await wrapper.
Both live in `match.ts` but are not exported. Add `export` (purely additive,
non-breaking) so the ablation can import the exact same objects the real match
uses.

**Files:**
- Modify: `tools/loadbench/src/match.ts` (add `export` to `bigintSafeCodec` and `proposeAndAwait`)
- Test: `tools/loadbench/src/ablationSeams.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export const bigintSafeCodec: MoveCodec<unknown>` — `{ encode(m): unknown; decode(j): unknown }`, a double-JSON codec.
  - `export function proposeAndAwait(dt: DistributedTunnel<unknown, unknown>, move: unknown, ts: bigint): Promise<number>` — wraps `dt.propose` in a Promise that resolves (with elapsed ms) when `dt.onConfirmed` fires.

- [ ] **Step 1: Write the failing test**

Create `tools/loadbench/src/ablationSeams.test.ts`:

```ts
import { test, expect } from "bun:test";
import { bigintSafeCodec, proposeAndAwait } from "./match";

test("bigintSafeCodec round-trips bigint and bytes", () => {
  const move = { n: 7n, b: new Uint8Array([1, 2, 3]) };
  const decoded = bigintSafeCodec.decode(bigintSafeCodec.encode(move)) as {
    n: bigint;
    b: Uint8Array;
  };
  expect(decoded.n).toBe(7n);
  expect(Array.from(decoded.b)).toEqual([1, 2, 3]);
});

test("proposeAndAwait resolves with elapsed ms on synchronous confirm", async () => {
  // Minimal structural stub: proposeAndAwait only touches onConfirmed + propose.
  const stub = {
    onConfirmed: undefined as ((u: unknown) => void) | undefined,
    propose(_m: unknown, _ts: bigint) {
      this.onConfirmed?.(undefined);
    },
  };
  const ms = await proposeAndAwait(stub as never, { kind: "noop" }, 1n);
  expect(typeof ms).toBe("number");
  expect(ms).toBeGreaterThanOrEqual(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/ablationSeams.test.ts`
Expected: FAIL — `bigintSafeCodec`/`proposeAndAwait` are not exported (import resolves to `undefined`, calling `.decode` throws).

- [ ] **Step 3: Add `export` to both seams**

In `tools/loadbench/src/match.ts`, change the declaration of `bigintSafeCodec` (currently `const bigintSafeCodec: MoveCodec<unknown> = {`) to:

```ts
export const bigintSafeCodec: MoveCodec<unknown> = {
```

and change `function proposeAndAwait(` to:

```ts
export function proposeAndAwait(
```

Change nothing else in those bodies.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/ablationSeams.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/loadbench/src/match.ts tools/loadbench/src/ablationSeams.test.ts
git commit -m "refactor(loadbench): export move codec + await seam"
```

---

### Task 2: Timing helper + capture phase

Build the capture: one clean match for the budget + GC, one recording match for
artifacts. Plus a small median-of-N timing helper used here and in Task 3.

**Files:**
- Create: `tools/loadbench/src/ablation.ts`
- Test: `tools/loadbench/src/ablationCapture.test.ts`

**Interfaces:**
- Consumes: `makeSeats`, `playMatch` (`./match`); `kitFor`, `gameStake` (`./games`); `pairLocalChannel` (`./channels/localChannel`); `setDefaultBackend`, `nativeBackend`, `nativeBackendSupported` (`../../../sui-tunnel-ts/src/core/crypto-native`); `nobleBackend` (`../../../sui-tunnel-ts/src/core/crypto`); `Transport` type (`../../../sui-tunnel-ts/src/core/distributedTunnel`); `CryptoBackend`, `SignFn`, `VerifyFn` (`../../../sui-tunnel-ts/src/core/crypto`).
- Produces:
  - `export function medianNs(fn: () => void, iters: number, trials: number): number` — ns per single `fn()` call (median across `trials` batches of `iters`).
  - `export interface AblationCapture { game: string; moves: number; frames: Uint8Array[]; cryptoSecret: Uint8Array; cryptoPublic: Uint8Array; signMessage: Uint8Array; signSignature: Uint8Array; signCount: number; verifyCount: number; perMoveBudgetNs: number; gcPauseNsPerMove: number | null; }`
  - `export async function captureMatch(game: string): Promise<AblationCapture>`

- [ ] **Step 1: Write the failing test**

Create `tools/loadbench/src/ablationCapture.test.ts`:

```ts
import { test, expect } from "bun:test";
import { captureMatch, medianNs } from "./ablation";
import { decodeFrame } from "../../../sui-tunnel-ts/src/core/distributedFrame";
import { bigintSafeCodec } from "./match";

test("medianNs returns a positive per-call time", () => {
  const ns = medianNs(() => {
    let s = 0;
    for (let i = 0; i < 100; i++) s += i;
    if (s < 0) throw new Error("unreachable");
  }, 1000, 5);
  expect(ns).toBeGreaterThan(0);
});

test("captureMatch harvests real blackjack artifacts deterministically", async () => {
  const a = await captureMatch("blackjack");
  const b = await captureMatch("blackjack");
  expect(a.moves).toBe(b.moves); // determinism guard (observed: 34)
  expect(a.moves).toBe(34);
  expect(a.frames.length).toBeGreaterThan(0);
  expect(a.signCount).toBeGreaterThan(0);
  expect(a.verifyCount).toBeGreaterThan(0);
  expect(a.perMoveBudgetNs).toBeGreaterThan(0);
  expect(a.cryptoSecret.length).toBe(32);
  // captured frames are real and decodable through the engine
  const f = decodeFrame(a.frames[0], bigintSafeCodec);
  expect(f.kind === "move" || f.kind === "ack").toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/ablationCapture.test.ts`
Expected: FAIL — `./ablation` module does not exist.

- [ ] **Step 3: Write `ablation.ts` capture + timing**

Create `tools/loadbench/src/ablation.ts`:

```ts
import { PerformanceObserver } from "node:perf_hooks";
import type { Transport } from "../../../sui-tunnel-ts/src/core/distributedTunnel";
import {
  setDefaultBackend,
  nativeBackend,
  nativeBackendSupported,
} from "../../../sui-tunnel-ts/src/core/crypto-native";
import {
  nobleBackend,
  type CryptoBackend,
  type SignFn,
  type VerifyFn,
} from "../../../sui-tunnel-ts/src/core/crypto";
import { makeSeats, playMatch } from "./match";
import { kitFor, gameStake } from "./games";
import { pairLocalChannel } from "./channels/localChannel";

/** Median per-call nanoseconds: `trials` batches of `iters` calls, median of batch means. */
export function medianNs(fn: () => void, iters: number, trials: number): number {
  const means: number[] = [];
  // warmup
  for (let i = 0; i < iters; i++) fn();
  for (let t = 0; t < trials; t++) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) fn();
    const end = process.hrtime.bigint();
    means.push(Number(end - start) / iters);
  }
  means.sort((x, y) => x - y);
  return means[Math.floor(means.length / 2)];
}

export interface AblationCapture {
  game: string;
  moves: number;
  frames: Uint8Array[];
  cryptoSecret: Uint8Array;
  cryptoPublic: Uint8Array;
  signMessage: Uint8Array;
  signSignature: Uint8Array;
  signCount: number;
  verifyCount: number;
  perMoveBudgetNs: number;
  gcPauseNsPerMove: number | null;
}

function recordingTransport(t: Transport, sink: Uint8Array[]): Transport {
  return {
    send: (f) => {
      sink.push(f.slice());
      t.send(f);
    },
    onFrame: (cb) => t.onFrame(cb),
  };
}

interface CryptoRec {
  secret: Uint8Array | null;
  pub: Uint8Array | null;
  signMessage: Uint8Array | null;
  signSignature: Uint8Array | null;
  signCount: number;
  verifyCount: number;
}

function capturingBackend(base: CryptoBackend, rec: CryptoRec): CryptoBackend {
  return {
    name: "capturing",
    makeSigner(secret: Uint8Array): SignFn {
      if (!rec.secret) rec.secret = secret.slice();
      const fn = base.makeSigner(secret);
      return (message) => {
        const sig = fn(message);
        rec.signCount++;
        if (!rec.signMessage) {
          rec.signMessage = message.slice();
          rec.signSignature = sig.slice();
        }
        return sig;
      };
    },
    makeVerifier(pub: Uint8Array): VerifyFn {
      if (!rec.pub) rec.pub = pub.slice();
      const fn = base.makeVerifier(pub);
      return (message, signature) => {
        rec.verifyCount++;
        return fn(message, signature);
      };
    },
  };
}

const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

export async function captureMatch(game: string): Promise<AblationCapture> {
  const stake = gameStake(game);
  const baseBackend = nativeBackendSupported() ? nativeBackend : nobleBackend;

  // --- Clean match: per-move wall budget + aggregate GC (no recording overhead). ---
  let gcNs = 0;
  let gcObserved = false;
  let obs: PerformanceObserver | null = null;
  try {
    obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        gcObserved = true;
        gcNs += e.duration * 1e6; // ms -> ns
      }
    });
    obs.observe({ entryTypes: ["gc"] });
  } catch {
    obs = null;
  }
  const cleanSeats = makeSeats(`ablate-clean`, { a: stake, b: stake }, 0n);
  const clean = await playMatch(kitFor(game), cleanSeats, pairLocalChannel(), {
    maxMoves: 1000,
  });
  obs?.disconnect();
  const moves = clean.moves;
  const perMoveBudgetNs = mean(clean.latenciesMs) * 1e6;
  const gcPauseNsPerMove = obs && gcObserved ? gcNs / moves : null;

  // --- Recording match: harvest real artifacts. ---
  const frames: Uint8Array[] = [];
  const rec: CryptoRec = {
    secret: null,
    pub: null,
    signMessage: null,
    signSignature: null,
    signCount: 0,
    verifyCount: 0,
  };
  setDefaultBackend(capturingBackend(baseBackend, rec));
  try {
    const [ta, tb] = pairLocalChannel();
    const seats = makeSeats(`ablate-rec`, { a: stake, b: stake }, 0n);
    await playMatch(
      kitFor(game),
      seats,
      [recordingTransport(ta, frames), recordingTransport(tb, frames)],
      { maxMoves: 1000 },
    );
  } finally {
    setDefaultBackend(null);
  }

  if (!rec.secret || !rec.pub || !rec.signMessage || !rec.signSignature) {
    throw new Error("ablation capture: crypto artifacts missing (no sign/verify observed)");
  }

  return {
    game,
    moves,
    frames,
    cryptoSecret: rec.secret,
    cryptoPublic: rec.pub,
    signMessage: rec.signMessage,
    signSignature: rec.signSignature,
    signCount: rec.signCount,
    verifyCount: rec.verifyCount,
    perMoveBudgetNs,
    gcPauseNsPerMove,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/ablationCapture.test.ts`
Expected: PASS (2 tests). If `a.moves` is not 34, STOP — re-verify the move count with `bun run` before changing the assertion (the determinism guard must still hold).

- [ ] **Step 5: Commit**

```bash
git add tools/loadbench/src/ablation.ts tools/loadbench/src/ablationCapture.test.ts
git commit -m "feat(loadbench): capture real ablation artifacts"
```

---

### Task 3: Replay / measure phase

Time the real engine functions over the captured artifacts and assemble
non-overlapping additive buckets (JSON, crypto, Promise/await), the residual,
and informational sub-measures (move codec, bigint, GC, native-vs-noble).

**Files:**
- Modify: `tools/loadbench/src/ablation.ts` (append)
- Test: `tools/loadbench/src/ablationMeasure.test.ts`

**Interfaces:**
- Consumes: `AblationCapture`, `medianNs` (Task 2); `bigintSafeCodec`, `proposeAndAwait` (`./match`); `encodeFrame`, `decodeFrame`, `type Frame`, `type MoveFrame` (`../../../sui-tunnel-ts/src/core/distributedFrame`); `nativeBackend` (`../../../sui-tunnel-ts/src/core/crypto-native`); `nobleBackend` (`../../../sui-tunnel-ts/src/core/crypto`).
- Produces:
  - `export interface AblationLine { label: string; nsPerMove: number; }`
  - `export interface AblationResult { game: string; moves: number; perMoveBudgetNs: number; buckets: AblationLine[]; attributedNs: number; residualNs: number; subMeasures: AblationLine[]; }`
  - `export function measureAblation(cap: AblationCapture, trials?: number): AblationResult`

- [ ] **Step 1: Write the failing test**

Create `tools/loadbench/src/ablationMeasure.test.ts`:

```ts
import { test, expect } from "bun:test";
import { captureMatch, measureAblation } from "./ablation";

test("measureAblation yields additive buckets + residual + sub-measures", async () => {
  const cap = await captureMatch("blackjack");
  const r = measureAblation(cap, 3);

  expect(r.game).toBe("blackjack");
  expect(r.moves).toBe(cap.moves);

  const labels = r.buckets.map((b) => b.label);
  expect(labels).toEqual([
    "JSON envelope + move codec (encode+decode)",
    "crypto sign+verify (native hop)",
    "Promise/await wrapper (proposeAndAwait)",
  ]);
  for (const b of r.buckets) expect(b.nsPerMove).toBeGreaterThan(0);

  // attributed = sum of buckets; residual = budget - attributed (no double count)
  const sum = r.buckets.reduce((a, b) => a + b.nsPerMove, 0);
  expect(Math.abs(r.attributedNs - sum)).toBeLessThan(1e-6);
  expect(Math.abs(r.residualNs - (r.perMoveBudgetNs - r.attributedNs))).toBeLessThan(1e-6);

  const subLabels = r.subMeasures.map((s) => s.label);
  expect(subLabels).toContain("of which move codec (encode+decode)");
  expect(subLabels).toContain("bigint conversions+arithmetic vs number (isolated)");
  expect(subLabels).toContain("crypto native sign+verify");
  expect(subLabels).toContain("crypto noble sign+verify");
  expect(subLabels).toContain("GC pause (aggregate)");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/ablationMeasure.test.ts`
Expected: FAIL — `measureAblation` is not exported.

- [ ] **Step 3: Append measure logic to `ablation.ts`**

Add these imports at the top of `tools/loadbench/src/ablation.ts` (alongside existing imports):

```ts
import {
  encodeFrame,
  decodeFrame,
  type Frame,
  type MoveFrame,
} from "../../../sui-tunnel-ts/src/core/distributedFrame";
import { bigintSafeCodec, proposeAndAwait } from "./match";
```

Append to the end of `tools/loadbench/src/ablation.ts`:

```ts
export interface AblationLine {
  label: string;
  nsPerMove: number;
}

export interface AblationResult {
  game: string;
  moves: number;
  perMoveBudgetNs: number;
  buckets: AblationLine[];
  attributedNs: number;
  residualNs: number;
  subMeasures: AblationLine[];
}

export function measureAblation(cap: AblationCapture, trials = 5): AblationResult {
  const { moves } = cap;
  // Decode every captured frame once (real engine), keep the Frame objects for re-encode.
  const decoded: Frame<unknown>[] = cap.frames.map((bytes) =>
    decodeFrame(bytes, bigintSafeCodec),
  );

  // --- Bucket 1: JSON envelope + move codec (encode + decode of every frame). ---
  // Per match the engine encodes each frame (sender) and decodes it (receiver):
  // summing one encode + one decode per captured frame, divided by moves.
  const jsonTotalNs = medianNs(
    () => {
      for (let i = 0; i < cap.frames.length; i++) {
        const bytes = encodeFrame(decoded[i], bigintSafeCodec);
        decodeFrame(bytes, bigintSafeCodec);
      }
    },
    50,
    trials,
  );
  const jsonNsPerMove = jsonTotalNs / moves;

  // --- Bucket 2: crypto sign+verify via the native hop, scaled by real op counts. ---
  const baseBackend = nativeBackendSupported() ? nativeBackend : nobleBackend;
  const signNs = (backend: CryptoBackend): number => {
    const signer = backend.makeSigner(cap.cryptoSecret);
    return medianNs(() => void signer(cap.signMessage), 2000, trials);
  };
  const verifyNs = (backend: CryptoBackend): number => {
    const verifier = backend.makeVerifier(cap.cryptoPublic);
    return medianNs(() => void verifier(cap.signMessage, cap.signSignature), 2000, trials);
  };
  const nativeSign = signNs(baseBackend);
  const nativeVerify = verifyNs(baseBackend);
  const cryptoNsPerMove =
    (cap.signCount * nativeSign + cap.verifyCount * nativeVerify) / moves;

  // --- Bucket 3: Promise/await wrapper per move (synchronous-resolve stub). ---
  // Exactly one awaited proposeAndAwait per move in the real loop.
  const promiseNsPerMove = awaitWrapperNs(trials);

  const buckets: AblationLine[] = [
    { label: "JSON envelope + move codec (encode+decode)", nsPerMove: jsonNsPerMove },
    { label: "crypto sign+verify (native hop)", nsPerMove: cryptoNsPerMove },
    { label: "Promise/await wrapper (proposeAndAwait)", nsPerMove: promiseNsPerMove },
  ];
  const attributedNs = buckets.reduce((a, b) => a + b.nsPerMove, 0);
  const residualNs = cap.perMoveBudgetNs - attributedNs;

  // --- Informational sub-measures (overlap the buckets; NOT added to the subtotal). ---
  const moveObjs = decoded
    .filter((f): f is MoveFrame<unknown> => f.kind === "move")
    .map((f) => f.move);
  const moveCodecNs =
    moveObjs.length === 0
      ? 0
      : medianNs(
          () => {
            for (const m of moveObjs) bigintSafeCodec.decode(bigintSafeCodec.encode(m));
          },
          200,
          trials,
        ) / moves;

  const bigints = decoded
    .filter((f): f is MoveFrame<unknown> => f.kind === "move")
    .map((f) => [f.nonce, f.timestamp, f.partyABalance, f.partyBBalance] as const);
  const bigintDeltaNs = bigintVsNumberDeltaNs(bigints, trials) / moves;

  const subMeasures: AblationLine[] = [
    { label: "of which move codec (encode+decode)", nsPerMove: moveCodecNs },
    { label: "bigint conversions+arithmetic vs number (isolated)", nsPerMove: bigintDeltaNs },
    {
      label: "crypto native sign+verify",
      nsPerMove: (cap.signCount * nativeSign + cap.verifyCount * nativeVerify) / moves,
    },
    {
      label: "crypto noble sign+verify",
      nsPerMove:
        (cap.signCount * signNs(nobleBackend) + cap.verifyCount * verifyNs(nobleBackend)) /
        moves,
    },
    { label: "GC pause (aggregate)", nsPerMove: cap.gcPauseNsPerMove ?? 0 },
  ];

  return {
    game: cap.game,
    moves,
    perMoveBudgetNs: cap.perMoveBudgetNs,
    buckets,
    attributedNs,
    residualNs,
    subMeasures,
  };
}

/** Time the real `proposeAndAwait` wrapper resolving synchronously, per call. */
function awaitWrapperNs(trials: number): number {
  const stub = {
    onConfirmed: undefined as ((u: unknown) => void) | undefined,
    propose(_m: unknown, _ts: bigint) {
      this.onConfirmed?.(undefined);
    },
  };
  const iters = 2000;
  const means: number[] = [];
  for (let t = 0; t < trials + 1; t++) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) {
      void proposeAndAwait(stub as never, { kind: "noop" }, 1n);
    }
    const end = process.hrtime.bigint();
    if (t > 0) means.push(Number(end - start) / iters); // drop warmup batch
  }
  means.sort((x, y) => x - y);
  return means[Math.floor(means.length / 2)];
}

/** Isolated cost of doing the per-frame bigint work as bigint vs as number. */
function bigintVsNumberDeltaNs(
  rows: ReadonlyArray<readonly [bigint, bigint, bigint, bigint]>,
  trials: number,
): number {
  const big = medianNs(
    () => {
      let acc = 0n;
      for (const [nonce, ts, a, b] of rows) {
        acc += BigInt(nonce.toString()) + BigInt(ts.toString()) + a + b + 1n;
      }
      if (acc < 0n) throw new Error("unreachable");
    },
    200,
    trials,
  );
  const nums = rows.map(
    ([nonce, ts, a, b]) =>
      [Number(nonce), Number(ts), Number(a), Number(b)] as const,
  );
  const num = medianNs(
    () => {
      let acc = 0;
      for (const [nonce, ts, a, b] of nums) {
        acc += Number(String(nonce)) + Number(String(ts)) + a + b + 1;
      }
      if (acc < 0) throw new Error("unreachable");
    },
    200,
    trials,
  );
  return Math.max(0, big - num);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/ablationMeasure.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add tools/loadbench/src/ablation.ts tools/loadbench/src/ablationMeasure.test.ts
git commit -m "feat(loadbench): measure per-overhead ablation"
```

---

### Task 4: Report rendering (stdout + markdown)

Render `AblationResult` into the `[local/offchain]` console table and a markdown
report, with the honesty caveats and the optional rustbench floor reference.

**Files:**
- Create: `tools/loadbench/src/ablationReport.ts`
- Test: `tools/loadbench/src/ablationReport.test.ts`

**Interfaces:**
- Consumes: `AblationResult`, `AblationLine` (`./ablation`).
- Produces:
  - `export function renderAblation(r: AblationResult, rustbenchFloorNs?: number | null): string`
  - `export function renderAblationMarkdown(r: AblationResult, stampedAt: string, rustbenchFloorNs?: number | null): string`
  - `export function ablationBasename(env: string, stamp: string): string` — `ablation-<env>-<stamp>.md`

- [ ] **Step 1: Write the failing test**

Create `tools/loadbench/src/ablationReport.test.ts`:

```ts
import { test, expect } from "bun:test";
import {
  renderAblation,
  renderAblationMarkdown,
  ablationBasename,
} from "./ablationReport";
import type { AblationResult } from "./ablation";

const fixture: AblationResult = {
  game: "blackjack",
  moves: 34,
  perMoveBudgetNs: 10000,
  buckets: [
    { label: "JSON envelope + move codec (encode+decode)", nsPerMove: 3000 },
    { label: "crypto sign+verify (native hop)", nsPerMove: 4000 },
    { label: "Promise/await wrapper (proposeAndAwait)", nsPerMove: 500 },
  ],
  attributedNs: 7500,
  residualNs: 2500,
  subMeasures: [
    { label: "of which move codec (encode+decode)", nsPerMove: 1200 },
    { label: "GC pause (aggregate)", nsPerMove: 0 },
  ],
};

test("renderAblation shows buckets, subtotal, residual, budget, percentages", () => {
  const s = renderAblation(fixture);
  expect(s).toContain("[local/offchain]");
  expect(s).toContain("JSON envelope + move codec (encode+decode)");
  expect(s).toContain("crypto sign+verify (native hop)");
  expect(s).toContain("attributed subtotal");
  expect(s).toContain("unattributed");
  expect(s).toContain("per-move budget");
  expect(s).toContain("100%"); // budget line is the 100% reference
  expect(s).toContain("30%"); // JSON 3000/10000
  expect(s).toContain("of which move codec");
});

test("renderAblation appends the rustbench floor when provided", () => {
  const s = renderAblation(fixture, 1200);
  expect(s).toContain("rustbench floor");
  expect(s).toContain("1200");
});

test("renderAblationMarkdown emits a table with a header row", () => {
  const md = renderAblationMarkdown(fixture, "20260626-120000");
  expect(md).toContain("# loadbench JS-overhead ablation");
  expect(md).toContain("| overhead | ns/move | % of budget |");
  expect(md).toContain("blackjack");
});

test("ablationBasename builds the expected filename", () => {
  expect(ablationBasename("dev", "20260626-120000")).toBe(
    "ablation-dev-20260626-120000.md",
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/ablationReport.test.ts`
Expected: FAIL — `./ablationReport` does not exist.

- [ ] **Step 3: Write `ablationReport.ts`**

Create `tools/loadbench/src/ablationReport.ts`:

```ts
import type { AblationResult, AblationLine } from "./ablation";

const PREFIX = "[local/offchain]";

function pct(ns: number, budget: number): string {
  if (budget <= 0) return "n/a";
  return `${Math.round((ns / budget) * 100)}%`;
}

function ns(n: number): string {
  return `${Math.round(n)}ns`;
}

function line(l: AblationLine, budget: number): string {
  return `  ${l.label.padEnd(48)} ${ns(l.nsPerMove).padStart(10)}  ${pct(
    l.nsPerMove,
    budget,
  ).padStart(5)}`;
}

export function renderAblation(
  r: AblationResult,
  rustbenchFloorNs?: number | null,
): string {
  const b = r.perMoveBudgetNs;
  const out: string[] = [];
  out.push(`${PREFIX} JS-overhead ablation: ${r.game}, ${r.moves} moves`);
  out.push(`${PREFIX} additive per-move buckets (non-overlapping):`);
  for (const bucket of r.buckets) out.push(line(bucket, b));
  out.push(line({ label: "attributed subtotal", nsPerMove: r.attributedNs }, b));
  out.push(
    line(
      { label: "unattributed (engine + microtask delivery + JIT/AOT)", nsPerMove: r.residualNs },
      b,
    ),
  );
  out.push(line({ label: "per-move budget (measured)", nsPerMove: b }, b));
  if (rustbenchFloorNs != null) {
    out.push(`${PREFIX} rustbench floor (AOT ref): ${ns(rustbenchFloorNs)}/move`);
  }
  out.push(`${PREFIX} informational sub-measures (overlap buckets; not additive):`);
  for (const sub of r.subMeasures) out.push(line(sub, b));
  out.push(
    `${PREFIX} note: isolated costs are measured outside the real interleaving; ` +
      `the attributed subtotal need not equal the budget, and the residual ` +
      `absorbs engine logic, microtask delivery, JIT-vs-AOT, and measurement drift.`,
  );
  return out.join("\n") + "\n";
}

export function renderAblationMarkdown(
  r: AblationResult,
  stampedAt: string,
  rustbenchFloorNs?: number | null,
): string {
  const b = r.perMoveBudgetNs;
  const row = (l: AblationLine) =>
    `| ${l.label} | ${Math.round(l.nsPerMove)} | ${pct(l.nsPerMove, b)} |`;
  const lines: string[] = [];
  lines.push(`# loadbench JS-overhead ablation`);
  lines.push("");
  lines.push(`- game: \`${r.game}\``);
  lines.push(`- moves: ${r.moves}`);
  lines.push(`- generated: ${stampedAt}`);
  if (rustbenchFloorNs != null) {
    lines.push(`- rustbench floor (AOT ref): ${Math.round(rustbenchFloorNs)} ns/move`);
  }
  lines.push("");
  lines.push(`## Additive per-move buckets (non-overlapping)`);
  lines.push("");
  lines.push(`| overhead | ns/move | % of budget |`);
  lines.push(`|---|---|---|`);
  for (const bucket of r.buckets) lines.push(row(bucket));
  lines.push(row({ label: "attributed subtotal", nsPerMove: r.attributedNs }));
  lines.push(
    row({
      label: "unattributed (engine + microtask delivery + JIT/AOT)",
      nsPerMove: r.residualNs,
    }),
  );
  lines.push(row({ label: "per-move budget (measured)", nsPerMove: b }));
  lines.push("");
  lines.push(`## Informational sub-measures (overlap buckets; not additive)`);
  lines.push("");
  lines.push(`| overhead | ns/move | % of budget |`);
  lines.push(`|---|---|---|`);
  for (const sub of r.subMeasures) lines.push(row(sub));
  lines.push("");
  lines.push(
    `> Isolated costs are measured outside the real interleaving; the attributed ` +
      `subtotal need not equal the budget, and the residual absorbs engine logic, ` +
      `microtask delivery, JIT-vs-AOT, and measurement drift.`,
  );
  return lines.join("\n") + "\n";
}

export function ablationBasename(env: string, stamp: string): string {
  return `ablation-${env}-${stamp}.md`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/ablationReport.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/loadbench/src/ablationReport.ts tools/loadbench/src/ablationReport.test.ts
git commit -m "feat(loadbench): render ablation report"
```

---

### Task 5: CLI wiring (`bun run bench --ablation`)

Route `--ablation` early in the CLI to run capture → measure → print → write
markdown, bypassing the swarm/latency planning (ablation is single-thread, no
fleet, no container).

**Files:**
- Modify: `tools/loadbench/src/cli.ts`
- Create: `tools/loadbench/src/ablationRun.ts`
- Test: `tools/loadbench/src/ablationRun.test.ts`

**Interfaces:**
- Consumes: `captureMatch`, `measureAblation` (`./ablation`); `renderAblation`, `renderAblationMarkdown`, `ablationBasename` (`./ablationReport`); `envName` (`./benchEnv`); `isPlayable` (`./games`).
- Produces:
  - `export interface AblationArgs { game: string; trials: number; }`
  - `export function parseAblationArgs(argv: string[]): AblationArgs` — reads `--game <name>` (default `blackjack`) and `--trials <n>` (default 5); rejects non-playable games.
  - `export async function runAblation(argv: string[]): Promise<string>` — runs the ablation, prints the console report, writes the markdown to `reports/`, returns the report file path.

- [ ] **Step 1: Write the failing test**

Create `tools/loadbench/src/ablationRun.test.ts`:

```ts
import { test, expect } from "bun:test";
import { parseAblationArgs } from "./ablationRun";

test("parseAblationArgs defaults to blackjack + 5 trials", () => {
  const a = parseAblationArgs(["--ablation"]);
  expect(a.game).toBe("blackjack");
  expect(a.trials).toBe(5);
});

test("parseAblationArgs reads --game and --trials", () => {
  const a = parseAblationArgs(["--ablation", "--game", "blackjack", "--trials", "9"]);
  expect(a.game).toBe("blackjack");
  expect(a.trials).toBe(9);
});

test("parseAblationArgs rejects an unplayable game", () => {
  expect(() => parseAblationArgs(["--ablation", "--game", "nope"])).toThrow();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/ablationRun.test.ts`
Expected: FAIL — `./ablationRun` does not exist.

- [ ] **Step 3: Write `ablationRun.ts`**

Create `tools/loadbench/src/ablationRun.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureMatch, measureAblation } from "./ablation";
import {
  renderAblation,
  renderAblationMarkdown,
  ablationBasename,
} from "./ablationReport";
import { envName } from "./benchEnv";
import { isPlayable, PLAYABLE } from "./games";

export interface AblationArgs {
  game: string;
  trials: number;
}

export function parseAblationArgs(argv: string[]): AblationArgs {
  let game = "blackjack";
  let trials = 5;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--game") game = argv[++i] ?? game;
    else if (argv[i] === "--trials") trials = Number(argv[++i] ?? trials);
  }
  if (!isPlayable(game)) {
    throw new Error(`game "${game}" is not playable (one of: ${PLAYABLE.join(", ")})`);
  }
  if (!Number.isFinite(trials) || trials < 1) {
    throw new Error(`--trials must be a positive integer`);
  }
  return { game, trials };
}

function stamp(): string {
  // YYYYMMDD-HHMMSS in local time, no separators that break filenames.
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

export async function runAblation(argv: string[]): Promise<string> {
  const { game, trials } = parseAblationArgs(argv);
  const cap = await captureMatch(game);
  const result = measureAblation(cap, trials);

  process.stdout.write(renderAblation(result));

  const at = stamp();
  const dir = join(import.meta.dir, "..", "reports");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, ablationBasename(envName(), at));
  writeFileSync(file, renderAblationMarkdown(result, at));
  process.stdout.write(`[local/offchain] ablation report: ${file}\n`);
  return file;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/ablationRun.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Route `--ablation` in `cli.ts`**

`main` is synchronous (`function main(): void`) and already starts with
`const argv = process.argv.slice(2);` followed by the `--help`/`-h` block. It
dispatches the swarm/latency modes by spawning child processes, but the ablation
runs in-process. Because `main` is not `async`, route via
`import().then().catch()` rather than `await`.

In `tools/loadbench/src/cli.ts`, insert this block **immediately after** the
existing `if (argv.includes("--help") || argv.includes("-h")) { ... }` block
inside `main` (reuse the existing `argv`):

```ts
  if (argv.includes("--ablation")) {
    import("./ablationRun")
      .then((m) => m.runAblation(argv))
      .catch((e: unknown) => {
        console.error(String((e as Error)?.message ?? e));
        process.exit(1);
      });
    return;
  }
```

Do not change the `import.meta.main` entry wrapper at the bottom of the file.

- [ ] **Step 6: Run the real end-to-end ablation**

Run: `bun run bench --ablation`
Expected: prints the `[local/offchain] JS-overhead ablation:` block with three
buckets, a subtotal, a residual, a budget line, sub-measures, and a
`ablation report:` path. A markdown file appears under `tools/loadbench/reports/`.

- [ ] **Step 7: Run the whole suite**

Run: `bun test`
Expected: all tests pass (existing + the 4 new ablation test files). The on-chain
smoke skips with no `.env.local`.

- [ ] **Step 8: Commit**

```bash
git add tools/loadbench/src/ablationRun.ts tools/loadbench/src/ablationRun.test.ts tools/loadbench/src/cli.ts
git commit -m "feat(loadbench): wire --ablation cli mode"
```

---

### Task 6: Document the ablation in the loadbench README

**Files:**
- Modify: `tools/loadbench/README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing (docs only).

- [ ] **Step 1: Add an ablation section**

In `tools/loadbench/README.md`, add a new subsection under `## Commands`
(after the `bun run bench` description), verbatim:

```markdown
### `bun run bench --ablation` — explain the gap vs rustbench

Attributes loadbench's real per-move cost to each structural JS overhead
(JSON envelope + move codec, native crypto sign/verify hop, Promise/await
wrapper), with a residual that absorbs engine logic, microtask delivery, and
JIT-vs-AOT. Single-thread, offchain, local channel, `blackjack` by default.

```bash
bun run bench --ablation                 # blackjack, 5 trials
bun run bench --ablation --trials 11     # more replay trials
```

It runs two deterministic real matches — one clean (per-move wall budget +
aggregate GC), one recording (real frames + real signed messages) — then times
the real engine functions over the captured artifacts. Prints an
`[local/offchain]` table and writes `reports/ablation-<env>-<stamp>.md`.
Informational sub-measures (move-codec share, bigint-vs-number delta, GC pause,
native-vs-noble crypto) overlap the buckets and are not added to the subtotal.
```

- [ ] **Step 2: Commit**

```bash
git add tools/loadbench/README.md
git commit -m "docs(loadbench): document --ablation mode"
```

---

## Self-Review

**Spec coverage:**
- Capture (clean + recording, public seams, no upstream edits) → Task 2. ✓
- Replay buckets (JSON, crypto, Promise/await) + sub-measures (move codec, bigint, GC, native-vs-noble) → Task 3. ✓
- Report (table, subtotal, residual, budget, caveats, optional rustbench floor, markdown) → Task 4. ✓
- CLI `--ablation` (blackjack/local/offchain default, `--trials`) → Task 5. ✓
- Determinism guard (34 moves) → Task 2 test. ✓
- Error handling (missing crypto artifacts → throw; unplayable game → throw; GC observer unavailable → null/0 line) → Tasks 2, 3, 5. ✓
- Native-backend-unsupported fallback to noble base → Task 2 (`baseBackend`). ✓
- Honesty caveats in report → Task 4. ✓
- Testing tiers (unit report/math; integration real-engine determinism + counts) → Tasks 2–5. ✓

**Placeholder scan:** No TBD/TODO; every code/test step has complete code. ✓

**Type consistency:** `AblationCapture`, `AblationLine`, `AblationResult`, `medianNs`, `captureMatch`, `measureAblation`, `renderAblation`, `renderAblationMarkdown`, `ablationBasename`, `parseAblationArgs`, `runAblation` are defined once and referenced with matching signatures across tasks. The three bucket labels in Task 3 match the assertions in Tasks 3 and 4. ✓

**Note on GC line:** GC is reported as an informational sub-measure that degrades to `0` ns/move when the Bun `gc` PerformanceObserver is unavailable (`cap.gcPauseNsPerMove ?? 0`). The console/markdown still render the line; it is never added to the additive subtotal, so an unavailable observer cannot distort attribution.
</content>
