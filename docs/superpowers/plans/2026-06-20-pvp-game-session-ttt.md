# PvP Game Session (tic-tac-toe slice) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a framework-free `PvpGameSession` that wraps the SDK `DistributedTunnel`, drives a PR #28 `GameKit` to a co-signed cooperative settlement, and exposes a reactive store — then wire tic-tac-toe PvP onto it as the first strangler slice.

**Architecture:** `PvpGameSession<S,M>` owns a `DistributedTunnel` built from `kit.protocol`, runs the engine loop (`onConfirmed → bot.plan → propose → confirm`), owns the matchmaking handshake + transcript + cooperative close, and publishes a frozen snapshot via `subscribe`/`getSnapshot`. Three seams are injected (Transport, PartyEndpointFactory, SettlementSigner); the React hook and the headless fleet are two consumers of the same session. It is a refactor of the proven `agentEngine.ts playOneMatch` flow that swaps `randomMove` for the kit and adds the store.

**Tech Stack:** TypeScript (ESM), `sui-tunnel-ts` SDK (`core.DistributedTunnel`, `makeEndpoint`, wire/settlement), React 18 `useSyncExternalStore`, `node:test` via `tsx` (frontend test runner), pnpm.

## Global Constraints

- Session + transitive imports MUST load under `tsx` (no `import.meta.env`, `localStorage`, `window`, `document`, `react`, or asset imports at module scope). Browser-only concerns live only in adapter-side seam implementations.
- The session drives the **frontend** protocol via the kit (`GAME_KITS["tictactoe"].protocol`, domain `tic_tac_toe.multi.v1`) — never an SDK base protocol.
- Per-move co-sign is the engine's job (Ed25519 over the wire `StateUpdate`); the session never re-implements signing — it only supplies a `self` `PartyEndpoint` (key + bound `sign`) and an `opponent` verify-only endpoint.
- Cooperative close is **role-A-only submit**; both seats independently derive the transcript root and must agree (existing "Transcript root mismatch" guard).
- Session methods never throw across the boundary — they set `snapshot.error` + transition the phase machine + notify subscribers.
- `getSnapshot()` returns a reference-stable (frozen) value between real changes.
- Tests use `node:test` + `assert`, run via `node --import tsx --test`, co-located `*.test.ts`. Commit messages: Conventional Commits, no AI attribution.
- New session code lives under `frontend/src/agent/session/`.

---

### Task 1: Seam interfaces + loopback transport

**Files:**
- Create: `frontend/src/agent/session/seams.ts`
- Create: `frontend/src/agent/session/loopbackTransport.ts`
- Test: `frontend/src/agent/session/loopbackTransport.test.ts`

**Interfaces:**
- Consumes: SDK `Transport` (`{ send(frame: Uint8Array): void; onFrame(cb: (f: Uint8Array) => void): void }`) from `sui-tunnel-ts`.
- Produces: `SessionTransport` (SDK `Transport` + `onClose(cb)`, `onError(cb)`, `close()`); `PartyEndpointFactory`; `SettlementSigner`; `linkedLoopback(): { a: SessionTransport; b: SessionTransport }`.

- [ ] **Step 1: Write the failing test**

```typescript
// loopbackTransport.test.ts
import { describe, it } from "node:test";
import assert from "node:assert";
import { linkedLoopback } from "./loopbackTransport";

describe("linkedLoopback", () => {
  it("delivers a frame sent on A to B's onFrame handler", () => {
    const { a, b } = linkedLoopback();
    const received: number[][] = [];
    b.onFrame((f) => received.push([...f]));
    a.send(Uint8Array.of(1, 2, 3));
    assert.deepStrictEqual(received, [[1, 2, 3]]);
  });

  it("fires onClose on both ends when either closes", () => {
    const { a, b } = linkedLoopback();
    let aClosed = false;
    let bClosed = false;
    a.onClose(() => (aClosed = true));
    b.onClose(() => (bClosed = true));
    a.close();
    assert.strictEqual(aClosed, true);
    assert.strictEqual(bClosed, true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && node --import tsx --test "src/agent/session/loopbackTransport.test.ts"`
Expected: FAIL — `Cannot find module './loopbackTransport'`.

- [ ] **Step 3: Write the seam interfaces**

```typescript
// seams.ts
import type { Transport } from "sui-tunnel-ts";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";

/** SDK Transport plus disconnect signals the fleet needs. */
export interface SessionTransport extends Transport {
  onClose(cb: () => void): void;
  onError(cb: (err: unknown) => void): void;
  close(): void;
}

/** Produces the seat's signing endpoints once the opponent pubkey is known. */
export interface PartyEndpointFactory {
  /** This seat's endpoint: carries secretKey + bound sign. */
  self(): { publicKey: Uint8Array };
  /** Opaque self/opponent endpoints in the exact shape DistributedTunnel's cfg needs. */
  buildConfig(args: {
    tunnelId: string;
    selfParty: Party;
    opponentPublicKey: Uint8Array;
    opponentAddress: string;
  }): unknown;
}

/** On-chain seam — the only place a wallet / zkLogin is touched. */
export interface SettlementSigner {
  openAndFundSeatA(args: { stake: bigint }): Promise<{ tunnelId: string }>;
  depositSeatB(args: { tunnelId: string; stake: bigint }): Promise<void>;
  submitCooperativeClose(args: { tunnelId: string; coSigned: unknown }): Promise<{ digest: string }>;
  closeOnTimeout(args: { tunnelId: string }): Promise<{ digest: string }>;
}
```

- [ ] **Step 4: Write the loopback transport**

```typescript
// loopbackTransport.ts
import type { SessionTransport } from "./seams";

class LoopbackEnd implements SessionTransport {
  private frameCb: ((f: Uint8Array) => void) | null = null;
  private closeCb: (() => void) | null = null;
  peer!: LoopbackEnd;
  send(frame: Uint8Array): void {
    // Deliver a copy so the receiver can't mutate the sender's buffer.
    this.peer.frameCb?.(Uint8Array.from(frame));
  }
  onFrame(cb: (f: Uint8Array) => void): void { this.frameCb = cb; }
  onClose(cb: () => void): void { this.closeCb = cb; }
  onError(_cb: (err: unknown) => void): void { /* loopback never errors */ }
  close(): void { this.closeCb?.(); this.peer.closeCb?.(); }
}

/** Two in-process transports wired to each other — for tests and self-play. */
export function linkedLoopback(): { a: SessionTransport; b: SessionTransport } {
  const a = new LoopbackEnd();
  const b = new LoopbackEnd();
  a.peer = b; b.peer = a;
  return { a, b };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && node --import tsx --test "src/agent/session/loopbackTransport.test.ts"`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/agent/session/seams.ts frontend/src/agent/session/loopbackTransport.ts frontend/src/agent/session/loopbackTransport.test.ts
git commit -m "feat(agent): session seam interfaces + loopback transport"
```

---

### Task 2: Snapshot store (subscribe / getSnapshot, frozen + stable ref)

**Files:**
- Create: `frontend/src/agent/session/snapshotStore.ts`
- Test: `frontend/src/agent/session/snapshotStore.test.ts`

**Interfaces:**
- Produces: `SnapshotStore<T>` with `get(): Readonly<T>`, `set(next: T): void`, `subscribe(cb: () => void): () => void`. `get()` returns the SAME frozen object until `set` is called with a value that differs by structural compare.

- [ ] **Step 1: Write the failing test**

```typescript
// snapshotStore.test.ts
import { describe, it } from "node:test";
import assert from "node:assert";
import { SnapshotStore } from "./snapshotStore";

describe("SnapshotStore", () => {
  it("returns a stable reference until a real change", () => {
    const store = new SnapshotStore({ phase: "idle", n: 0 });
    const first = store.get();
    store.set({ phase: "idle", n: 0 }); // structurally identical
    assert.strictEqual(store.get(), first, "no-op set must not change the reference");
    store.set({ phase: "idle", n: 1 });
    assert.notStrictEqual(store.get(), first);
  });

  it("notifies subscribers only on a real change and the snapshot is frozen", () => {
    const store = new SnapshotStore({ phase: "idle", n: 0 });
    let calls = 0;
    store.subscribe(() => calls++);
    store.set({ phase: "idle", n: 0 });
    store.set({ phase: "idle", n: 1 });
    assert.strictEqual(calls, 1);
    assert.strictEqual(Object.isFrozen(store.get()), true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && node --import tsx --test "src/agent/session/snapshotStore.test.ts"`
Expected: FAIL — `Cannot find module './snapshotStore'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// snapshotStore.ts
/** Reference-stable store for useSyncExternalStore: identical-by-value sets are no-ops. */
export class SnapshotStore<T extends object> {
  private current: Readonly<T>;
  private readonly listeners = new Set<() => void>();
  constructor(initial: T) { this.current = Object.freeze({ ...initial }); }
  get(): Readonly<T> { return this.current; }
  set(next: T): void {
    if (sameShallow(this.current, next)) return;
    this.current = Object.freeze({ ...next });
    for (const l of this.listeners) l();
  }
  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}

function sameShallow(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => Object.is(a[k], b[k]));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && node --import tsx --test "src/agent/session/snapshotStore.test.ts"`
Expected: PASS (2 tests).

> Note for later: the session must keep nested fields (e.g. game `state`) as one
> referentially-stable object per confirmed step so `sameShallow` works; rebuild a
> nested object only when the engine confirms a new state.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/agent/session/snapshotStore.ts frontend/src/agent/session/snapshotStore.test.ts
git commit -m "feat(agent): reference-stable snapshot store"
```

---

### Task 3: `PvpGameSession` engine loop (auto mode) over loopback — the core proof

**Files:**
- Create: `frontend/src/agent/session/pvpGameSession.ts`
- Test: `frontend/src/agent/session/pvpGameSession.e2e.test.ts`

**Interfaces:**
- Consumes: `GameKit`/`GameBot`/`BotContext` (`@/agent/gameKit`); `SessionTransport` (Task 1); SDK `core.DistributedTunnel`, `makeEndpoint` (`sui-tunnel-ts`); `SnapshotStore` (Task 2).
- Produces: `class PvpGameSession<S,M>` with `attachTunnel(deps)` (test seam that injects an already-built `DistributedTunnel`), `setAuto(on)`, `getSnapshot()`, `subscribe(cb)`; `SessionSnapshot<S>` = `{ phase: SessionPhase; state: S | null; balances: {a:bigint;b:bigint} | null; terminal: boolean; error: string | null }`. `SessionPhase = "idle"|"connecting"|"queuing"|"opening"|"funding"|"playing"|"settling"|"done"|"error"|"opponent-abandoned"`.

> This task isolates the engine loop from the on-chain/relay handshake by letting the
> test build two `DistributedTunnel`s over a loopback and inject them. Task 4 adds `start()`.

- [ ] **Step 1: Write the failing two-endpoint e2e test**

```typescript
// pvpGameSession.e2e.test.ts
import { describe, it } from "node:test";
import assert from "node:assert";
import { core, makeEndpoint } from "sui-tunnel-ts";          // verified exports
import { GAME_KITS } from "@/agent/gameKit";
import { linkedLoopback } from "./loopbackTransport";
import { PvpGameSession } from "./pvpGameSession";

// Two independent sessions, EACH HOLDING ONLY ITS OWN KEY, driven to settlement.
function seeded(seed: number) { return () => () => { /* mulberry32 */ let t=(seed+=0x6d2b79f5); t=Math.imul(t^(t>>>15),t|1); t^=t+Math.imul(t^(t>>>7),t|61); return ((t^(t>>>14))>>>0)/4294967296; }; }

describe("PvpGameSession (two-endpoint loopback)", () => {
  it("drives ttt to terminal; both seats agree on the transcript root", async () => {
    const kit = GAME_KITS["tictactoe"];
    const { a: txA, b: txB } = linkedLoopback();
    const keyA = core.generateKeyPair();
    const keyB = core.generateKeyPair();
    const ctx = { tunnelId: "ttt-e2e", initialBalances: { a: 100n, b: 100n } };

    const dtA = new core.DistributedTunnel(kit.protocol as never, {
      tunnelId: ctx.tunnelId, selfParty: "A",
      self: makeEndpoint("self", "0xA", keyA, true),
      opponent: makeEndpoint("opp", "0xB", { publicKey: keyB.publicKey }, false),
    }, txA, ctx.initialBalances);
    const dtB = new core.DistributedTunnel(kit.protocol as never, {
      tunnelId: ctx.tunnelId, selfParty: "B",
      self: makeEndpoint("self", "0xB", keyB, true),
      opponent: makeEndpoint("opp", "0xA", { publicKey: keyA.publicKey }, false),
    }, txB, ctx.initialBalances);

    const sA = new PvpGameSession(kit, "A", { rngForSeat: seeded(1) });
    const sB = new PvpGameSession(kit, "B", { rngForSeat: seeded(2) });
    sA.attachTunnel({ tunnel: dtA as never, initialState: kit.protocol.initialState(ctx) });
    sB.attachTunnel({ tunnel: dtB as never, initialState: kit.protocol.initialState(ctx) });
    sA.setAuto(true); sB.setAuto(true);

    await sA.kickoff();   // seat A proposes first; B reacts via onConfirmed
    await waitFor(() => sA.getSnapshot().terminal && sB.getSnapshot().terminal);

    const bal = sA.getSnapshot().balances!;
    assert.strictEqual(bal.a + bal.b, 200n, "balances conserved");
    assert.strictEqual(
      sA.transcriptRootHex(), sB.transcriptRootHex(),
      "both seats must derive the same transcript root",
    );
  });
});

function waitFor(p: () => boolean): Promise<void> {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const i = setInterval(() => {
      if (p()) { clearInterval(i); res(); }
      else if (Date.now() - t0 > 5000) { clearInterval(i); rej(new Error("timeout")); }
    }, 1);
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && node --import tsx --test "src/agent/session/pvpGameSession.e2e.test.ts"`
Expected: FAIL — `Cannot find module './pvpGameSession'`.

- [ ] **Step 3: Implement the engine loop**

```typescript
// pvpGameSession.ts (engine-loop core; start()/settle added in Tasks 4-5)
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import type { GameKit, GameBot, BotContext } from "@/agent/gameKit";
import { SnapshotStore } from "./snapshotStore";

export type SessionPhase =
  | "idle" | "connecting" | "queuing" | "opening" | "funding"
  | "playing" | "settling" | "done" | "error" | "opponent-abandoned";

export interface SessionSnapshot<S> {
  phase: SessionPhase;
  state: S | null;
  balances: { a: bigint; b: bigint } | null;
  terminal: boolean;
  error: string | null;
}

// Minimal structural view of the engine the session drives (verified API subset).
interface TunnelLike<S, M> {
  state: S;
  latest: unknown;
  onConfirmed: (() => void) | null;
  propose(move: M, timestamp: bigint): void;
}

export class PvpGameSession<S, M> {
  private readonly bot: GameBot<S, M>;
  private readonly store: SnapshotStore<SessionSnapshot<S>>;
  private tunnel: TunnelLike<S, M> | null = null;
  private auto = false;
  private readonly transcript: unknown[] = [];

  constructor(private readonly kit: GameKit<S, M>, private readonly seat: Party, ctx: BotContext) {
    this.bot = kit.createBot(seat, ctx);
    this.store = new SnapshotStore<SessionSnapshot<S>>({
      phase: "idle", state: null, balances: null, terminal: false, error: null,
    });
  }

  // Test/Task-4 seam: inject a ready tunnel + seeded state.
  attachTunnel(deps: { tunnel: TunnelLike<S, M>; initialState: S }): void {
    this.tunnel = deps.tunnel;
    this.tunnel.onConfirmed = () => this.onConfirmed();
    this.publish("playing", deps.initialState);
  }

  setAuto(on: boolean): void { this.auto = on; }

  getSnapshot(): Readonly<SessionSnapshot<S>> { return this.store.get(); }
  subscribe(cb: () => void): () => void { return this.store.subscribe(cb); }
  transcriptRootHex(): string { return this.kit.stateHash(this.tunnel!.state); } // replaced by real root in Task 5

  /** Seat A makes the opening proposal; both seats then react on confirmation. */
  async kickoff(): Promise<void> { this.drive(); }

  private onConfirmed(): void {
    const t = this.tunnel!;
    this.transcript.push(t.latest);
    this.publish("playing", t.state);
    this.drive();
  }

  private drive(): void {
    const t = this.tunnel!;
    if (this.kit.protocol.isTerminal(t.state)) { this.publish("settling", t.state); return; }
    if (!this.auto) return;
    const move = this.bot.plan(t.state);
    if (move == null) return;
    try {
      t.propose(move, BigInt(0)); // timestamp 0n is fine off-chain; see note
      this.bot.confirm(t.state, move);
    } catch (e) {
      this.fail(e);
    }
  }

  private publish(phase: SessionPhase, state: S): void {
    this.store.set({
      phase,
      state,
      balances: this.kit.protocol.balances(state),
      terminal: this.kit.protocol.isTerminal(state),
      error: null,
    });
  }

  private fail(e: unknown): void {
    const cur = this.store.get();
    this.store.set({ ...cur, phase: "error", error: e instanceof Error ? e.message : String(e) });
  }
}
```

> Note: timestamp — the existing hooks pass `BigInt(Date.now())`; for deterministic
> tests pass a monotonic counter. The engine includes the timestamp in the signed
> StateUpdate, so A and B see each other's timestamps; it does not need to be wall-clock.
> Replace the placeholder `transcriptRootHex` with the real transcript-root build in Task 5.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && node --import tsx --test "src/agent/session/pvpGameSession.e2e.test.ts"`
Expected: PASS — ttt drives to terminal, balances sum to 200n, both roots equal. If it hangs, the kickoff/turn-gating is wrong (debug `plan()` null-handling), not the engine.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/agent/session/pvpGameSession.ts frontend/src/agent/session/pvpGameSession.e2e.test.ts
git commit -m "feat(agent): PvpGameSession engine loop over loopback tunnel"
```

---

### Task 4: `start()` startup state machine (matchmaking → fund → activate)

**Files:**
- Modify: `frontend/src/agent/session/pvpGameSession.ts`
- Test: `frontend/src/agent/session/pvpGameSession.start.test.ts`

**Interfaces:**
- Consumes: an injected `relay` client capability `{ queueJoin(game); onMatch(cb); channel(matchId): { transport: SessionTransport; partyHello(pubkey); onPeerHello(cb); announceOpened(tunnelId); onOpened(cb) } }` (adapter over the real `RelayClient`/`MpClient`; faked in the test); `PartyEndpointFactory`, `SettlementSigner` (Task 1); `makeEndpoint`, `core.DistributedTunnel`.
- Produces: `start(args: { game: string; stake: bigint }): Promise<void>` that walks phases `connecting → queuing → opening → funding → playing`, building the `DistributedTunnel` once `opponentPublicKey` arrives.

- [ ] **Step 1: Write the failing test (fake relay, two sessions, full handshake to `playing`)**

```typescript
// pvpGameSession.start.test.ts — drives start() with an in-memory fake relay/signer,
// asserts both sessions reach phase "playing" with a shared tunnelId, then converge
// to terminal exactly as Task 3 (reuse the kickoff/drive path).
// (Test builds a FakeRelayPair + FakeSettlementSigner that resolve openAndFundSeatA
//  to a fixed tunnelId and no-op deposits; asserts sA/ sB snapshots reach "playing".)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && node --import tsx --test "src/agent/session/pvpGameSession.start.test.ts"`
Expected: FAIL — `start is not a function`.

- [ ] **Step 3: Implement `start()`**

Add to `PvpGameSession`, in the verified order from the spec (queue → `match.found` `{matchId, role, opponentWallet}` → `channel(matchId)` for transport → `partyHello(self.publicKey)` and await `onPeerHello` → seat A `settlementSigner.openAndFundSeatA` + `announceOpened`, seat B `onOpened` + `depositSeatB` → build `DistributedTunnel` via `endpointFactory.buildConfig` → `attachTunnel` → `playing`). Each await sets the matching phase; any rejection routes to `fail()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && node --import tsx --test "src/agent/session/pvpGameSession.start.test.ts"`
Expected: PASS — both sessions reach `playing`, share a tunnelId, then drive to terminal.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/agent/session/pvpGameSession.ts frontend/src/agent/session/pvpGameSession.start.test.ts
git commit -m "feat(agent): PvpGameSession start() handshake state machine"
```

---

### Task 5: Cooperative close + transcript root (role-A submit, dual-path)

**Files:**
- Modify: `frontend/src/agent/session/pvpGameSession.ts`
- Test: `frontend/src/agent/session/pvpGameSession.settle.test.ts`

**Interfaces:**
- Consumes: SDK `buildSettlementHalfWithRoot(timestamp, transcriptRoot, onchainNonce)` / `combineSettlementWithRoot` on the tunnel; a `Transcript` builder (mirror `agentEngine.ts:191` usage); the relay app-channel `settleHalf` exchange; `SettlementSigner.submitCooperativeClose`.
- Produces: on `settling`, build this seat's half + transcript root, exchange halves over the app channel, assert root equality (throw → `error`), `combineSettlementWithRoot`, seat A `submitCooperativeClose` (backend → wallet fallback), phase `done` with `digests`. `transcriptRootHex()` now returns the real root.

- [ ] **Step 1: Write the failing test**

```typescript
// Two loopback sessions to terminal, then settle. Assert: both compute the SAME
// transcriptRoot; combineSettlementWithRoot succeeds; ONLY seat A calls
// submitCooperativeClose; phase -> "done"; a forced backend failure falls back to the
// wallet path; a forced root mismatch -> phase "error" (no submit).
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && node --import tsx --test "src/agent/session/pvpGameSession.settle.test.ts"`
Expected: FAIL — settlement path not implemented (`done` never reached).

- [ ] **Step 3: Implement the settle path** (build half + root from `this.transcript`, exchange, guard root equality, combine, role-A submit with backend→wallet fallback, set `done`/`error`).

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && node --import tsx --test "src/agent/session/pvpGameSession.settle.test.ts"`
Expected: PASS — `done`, roots equal, only A submits, mismatch → `error`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/agent/session/pvpGameSession.ts frontend/src/agent/session/pvpGameSession.settle.test.ts
git commit -m "feat(agent): cooperative close + transcript-root agreement"
```

---

### Task 6: Robustness — disconnect, abandonment, timeouts

**Files:**
- Modify: `frontend/src/agent/session/pvpGameSession.ts`
- Test: `frontend/src/agent/session/pvpGameSession.robustness.test.ts`

**Interfaces:**
- Consumes: `SessionTransport.onClose`/`onError` (Task 1); `SettlementSigner.closeOnTimeout`.
- Produces: `transport.onClose → phase "opponent-abandoned"`; a configurable move-timeout and settle-half timeout that escalate to `closeOnTimeout`; both-settle-paths-fail → `error`.

- [ ] **Step 1: Write the failing tests** (peer `close()` mid-game → `opponent-abandoned`; settle-half never arrives within timeout → `closeOnTimeout` called; backend+wallet both throw → `error`).

- [ ] **Step 2: Run to verify they fail.**

Run: `cd frontend && node --import tsx --test "src/agent/session/pvpGameSession.robustness.test.ts"`
Expected: FAIL — no timeout/close handling.

- [ ] **Step 3: Implement** `onClose`/`onError` wiring and the two timeouts (clearable on terminal/`done`).

- [ ] **Step 4: Run to verify they pass.**

- [ ] **Step 5: Commit**

```bash
git add frontend/src/agent/session/pvpGameSession.ts frontend/src/agent/session/pvpGameSession.robustness.test.ts
git commit -m "feat(agent): session disconnect/abandon/timeout handling"
```

---

### Task 7: Real relay + endpoint + settlement adapters for tic-tac-toe

**Files:**
- Create: `frontend/src/games/ticTacToe/agent/sessionAdapters.ts`
- Test: `frontend/src/games/ticTacToe/agent/sessionAdapters.test.ts`

**Interfaces:**
- Consumes: existing `ttt pvpRelay.ts` (`queueJoin`/`on('match.found')`/`partyHello`/`tunnelOpened`/`transport`), `ttt pvpIdentity.ts` (per-browser ephemeral, `localStorage`), `makeEndpoint`, and `frontend/src/onchain/tunnelTx.ts` (`openAndFundSharedTunnel`/`depositStake`/`closeCooperativeWithRoot` + `SignExec`).
- Produces: `makeTttRelay(client)`, `makeTttEndpointFactory(eph)`, `makeTttSettlementSigner(signExec)` — each implementing the Task-1/Task-4 seam shapes by delegating to the existing code. These files MAY touch `localStorage`/`import.meta.env` because they are adapter-side, NOT imported by the session core.

- [ ] **Step 1: Write the failing test** — `makeTttSettlementSigner` builds the same tx as the current hook for a fixed input (assert the tx kind/args), and `makeTttEndpointFactory(eph).self().publicKey` equals `eph.coreKey.publicKey`.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement the adapters** as thin delegations to the verified existing functions.

- [ ] **Step 4: Run to verify it passes.**

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/ticTacToe/agent/sessionAdapters.ts frontend/src/games/ticTacToe/agent/sessionAdapters.test.ts
git commit -m "feat(ttt): relay/endpoint/settlement session adapters"
```

---

### Task 8: Thin `usePvpTicTacToe` onto the session (parity)

**Files:**
- Modify: `frontend/src/games/ticTacToe/app/hooks/usePvpTicTacToe.ts`
- Test: `frontend/src/games/ticTacToe/app/hooks/usePvpTicTacToe.parity.test.ts`

**Interfaces:**
- Consumes: `PvpGameSession`, the Task-7 adapters, the existing `PvpTttView` return type (27 fields).
- Produces: the hook becomes `useSyncExternalStore(session.subscribe, session.getSnapshot)` plus a `mapSnapshotToView(snapshot)` that reproduces `PvpTttView`, and imperative pass-throughs (`queue`→`start`, `play`→`proposeManual`, `setAuto`, `leave`). Cumulative `score`/`games`/`digests` live as session accumulators (added to `SessionSnapshot` here).

- [ ] **Step 1: Write the failing parity test** — `mapSnapshotToView` over a fixed snapshot yields every `PvpTttView` field with the expected values (board/turn/phase/role/myMark/isMyTurn/score/games/digests/auto). Pure function, no React.

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** `mapSnapshotToView` + rewire the hook; keep the component's consumed surface byte-identical.

- [ ] **Step 4: Run to verify it passes; then run the full agent + ttt suites.**

Run: `cd frontend && node --import tsx --test "src/agent/**/*.test.ts" "src/games/ticTacToe/**/*.test.ts"`
Expected: PASS (all).

- [ ] **Step 5: Manual parity check** — run the app, play a PvP ttt match human-vs-human and bot-auto; confirm identical flow + on-chain settlement. (Use the `/run` or `/verify` skill.)

- [ ] **Step 6: Commit**

```bash
git add frontend/src/games/ticTacToe/app/hooks/usePvpTicTacToe.ts frontend/src/games/ticTacToe/app/hooks/usePvpTicTacToe.parity.test.ts
git commit -m "refactor(ttt): drive PvP hook from PvpGameSession"
```

---

## Follow-on (separate plans, not in this slice)

- **Blackjack slice** — same `PvpGameSession`; new adapters (`bjPvpIdentity` IndexedDB per-match, `bjRelay`, blackjack settle); thin `usePvpBlackjack`; account for stake-vs-bet (`defaultStake` = funding lock, wager is bot-chosen).
- **Retire** `agentEngine.ts`'s `createBehaviorProtocol`/`randomMove` path; point the fleet at `GAME_KITS` via `PvpGameSession`.
- **Kit follow-ups for the author** (flagged from the PR #28 review, out of scope here): quantum-poker `plan()` idempotency; a frontend CI job running `pnpm test`; harden the import-boundary (globals scan + react/`@/components` deny + `.tsx` + asset glob).

## Self-Review

- **Spec coverage:** session core (Tasks 2-3), three seams (Task 1 interfaces, Task 7 real impls), start() handshake (Task 4), cooperative close + root agreement (Task 5), robustness (Task 6), reactivity/parity (Tasks 2, 8), two-endpoint + root + balance + byte-parity testing (Tasks 3, 5), import hygiene (Global Constraints + Task 1/3 placement). ttt kit defect fixes are already landed (commit `3f7b4cd`). Blackjack + agentEngine retirement are explicitly deferred. Covered.
- **Placeholder scan:** Tasks 1-3 carry complete code; Tasks 4-8 specify exact files, the verified SDK/relay/tx functions to call, and concrete test assertions, with the engine-loop reference fully shown in Task 3 (the steps that "describe" build directly on that shown code rather than restating it). No `TBD`/`add error handling`/`similar to`.
- **Type consistency:** `SessionSnapshot`/`SessionPhase`, `SessionTransport`, `PartyEndpointFactory`, `SettlementSigner`, `PvpGameSession`, `SnapshotStore` names/shapes are used identically across tasks; `getSnapshot`/`subscribe`/`setAuto`/`start`/`proposeManual` are stable.
