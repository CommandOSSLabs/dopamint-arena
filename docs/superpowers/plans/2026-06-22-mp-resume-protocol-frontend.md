# MP Resume Protocol — Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a dropped PvP player — including a full page reload — re-attach to their in-flight match and resume from the current co-signed state, by adding a reconnect loop to `MpClient`, reload-grade tunnel reconstruction from locally-persisted co-signed checkpoints, and a peer-to-peer reconciliation handshake, with on-chain unilateral settlement as the floor.

**Architecture:** Three layers. **Layer A (SDK, `sui-tunnel-ts`):** additive `DistributedTunnel` resume primitives (`adoptCheckpoint`, `snapshot`, `seatPending`, `resendPending`) + a pure `reconcile` decision engine. **Layer B (`frontend/src/pvp/mpClient.ts`):** a reconnect loop (backoff + jitter), `resume`/`queue.join` on reconnect, typed `resume.ok`/`peer.resumed`/`peer.dropped` events, and an in-memory active-match registry; ttt/caro migrate onto it and `RelayClient` is deprecated. **Layer C (per-game):** a `localStorage` resume-record helper (debounced write + `pagehide` flush) and thin per-game adapters wired through one shared `attachResume` driver. Reconciliation rides the existing opaque peer-message side channel via a new `resync` `PeerMessage` variant — no new server messages. On-chain settlement reuses the SDK's existing `raise_dispute` → `force_close` path.

**Tech Stack:** TypeScript. `sui-tunnel-ts` SDK on **pnpm + prettier 2.8.8 + `node:test` via tsx** (co-located `*.test.ts`). `frontend` React/TS app, also tested with **`node:test` via tsx** (pnpm + prettier). ed25519 (`@noble/curves`), blake2b256 (`@noble/hashes`), `@mysten/sui` Transactions for on-chain.

## Global Constraints

These apply to every task. Exact values copied from the spec/design/ADR.

- **Reload-grade resume.** Reconstruct the tunnel from persistence, not just re-attach the socket.
- **Generic SDK core + thin per-game adapters.** No game re-implements verification, adoption, or persistence. One audited crypto/reconciliation path.
- **Local-authoritative + peer gap-fill.** Each seat restores its own tunnel (and its own hidden secret, which the peer can never supply) from local persistence; the peer's `resync` only resolves the ≤1 in-flight move and recovers a client whose `localStorage` was cleared.
- **Per-move cost is unchanged.** Zero per-move signature verification beyond the existing `onMove`/`onAck` co-sign; zero per-move Redis/on-chain ops; the relay payload stays opaque and byte-for-byte. The only per-move addition is marking the resume record dirty; the `localStorage` write is debounced/coalesced off the hot path.
- **Signature verification (`adoptCheckpoint`) happens at resume time only.**
- **No new server message types.** Reconciliation rides the existing peer-message side channel via a new `resync` `PeerMessage` variant.
- **60s grace is a frontend constant.** The server never ends a match.
- **On-chain `timeout_ms` = `86_400_000n` (24h)** for every PvP tunnel (`frontend/src/games/ticTacToe/app/lib/pvpOnchain.ts:33`, `blackjack/app/lib/bjPvpOnchain.ts:32`, `frontend/src/onchain/tunnelTx.ts` default). 24h ≫ the 60s grace, so a post-grace settle is always contestable by a late-returning peer. **No timeout change needed.**
- **Framework discipline (CLAUDE.md):** `sui-tunnel-ts` is upstream-authoritative. The SDK additions are additive, minimal, and the genuinely-missing capability resume needs — not a refactor. Keep it on pnpm + prettier + `node:test` via tsx; co-locate `*.test.ts`.
- **`RelayClient` is deprecated, not deleted** — marked `@deprecated` (both `app/lib/pvpRelay.ts` and its `packages/client/` copy), left in the tree.
- **bigints serialize via a JSON replacer/reviver** in persistence (a `__bigint__` sentinel); the on-chain wire fields (`stateHash`, balances, nonce, timestamp) persist as hex / decimal strings.
- **Conventional Commits**, imperative, ≤50-char subject, lowercase after type, no trailing period, **no AI attribution**. One logical change per commit.

## Open items — resolved during planning

- **Exact `timeout_ms`:** 24h (`86_400_000n`) — confirmed above; ≥ 60s, no change.
- **Unilateral settle entrypoint + args:** `raise_dispute` then `force_close`. `sui-tunnel-ts/src/onchain/txbuilders.ts` already ships `buildRaiseDisputeFromUpdate(tx, tunnelId, u: CoSignedUpdate, raiser: Party, coinType?)` (submits the both-signed latest state; counterparty sig is selected by `raiser`) and `buildForceClose(tx, { tunnelId, coinType? })` (finalizes after the on-chain timeout, raiser only). The FE only **surfaces** these in `frontend/src/onchain/tunnelTx.ts` (Task 7), mirroring the existing `closeCooperative` cast pattern.
- **`encodeState` is a one-way digest input for resume purposes.** Every game's `encodeState` is a canonical byte concat over **public** state and omits local/derived fields (battleship fleet, poker slot secrets, poker hole cards). So **every adapter owns full-state JSON (de)serialization** — `adoptCheckpoint` re-binds by asserting `blake2b256(encodeState(deserialized)) === stateHash`. Uniform across all four games.
- **Helper location:** SDK reconcile in `sui-tunnel-ts/src/core/reconcile.ts`; FE persistence in `frontend/src/pvp/resume.ts`; the shared handshake/adapter driver in `frontend/src/pvp/resumeSession.ts`. The **in-memory active-match registry lives inside `MpClient`** (connection-lifecycle state); the **persisted active-tunnel index lives in `resume.ts`** (durable game state).

## Discrepancies vs. the spec (grounded in the current code)

- The spec's per-game table lists blackjack as already on `MpClient`. **It is not** — `frontend/src/games/blackjack/app/hooks/usePvpBlackjack.ts:24` imports `RelayClient` from `@/games/blackjack/app/lib/bjRelay`. Blackjack's adapter (Task 6) therefore **also migrates bjRelay → MpClient**, same as ttt/caro.
- Frontend tests run under **`node:test` via tsx** (`frontend/package.json` `test` script), not bun. The bun `*.e2e.test.ts` files live only in the nested `ticTacToe/packages/*` workspaces and are engine-only (they never touch a WS client). New resume tests are `node:test` and require adding `"src/pvp/**/*.test.ts"` to the frontend `test` glob (Task 3).

## Test command reference

- **SDK, one file:** `cd sui-tunnel-ts && node --import tsx --test src/core/<file>.test.ts`
- **SDK, by test name:** add `--test-name-pattern "<name>"`
- **SDK, whole suite:** `pnpm -C sui-tunnel-ts test`
- **SDK typecheck / format:** `pnpm -C sui-tunnel-ts typecheck` · `pnpm -C sui-tunnel-ts exec prettier --write <files>`
- **Frontend, one file:** `cd frontend && node --import tsx --test src/pvp/<file>.test.ts`
- **Frontend, whole suite:** `pnpm -C frontend test`
- **Frontend typecheck / format:** `pnpm -C frontend typecheck` · `pnpm -C frontend format`

## File structure

**Created**
- `sui-tunnel-ts/src/core/reconcile.ts` — pure `decideReconcile` + decision types (Layer A).
- `sui-tunnel-ts/src/core/reconcile.test.ts` — decision-table units.
- `frontend/src/pvp/resume.ts` — `ResumeRecord`, wire conversions, bigint JSON, debounced `localStorage` persistence, active-tunnel index, TTL eviction (Layer C persistence).
- `frontend/src/pvp/resume.test.ts` — persistence + restore units.
- `frontend/src/pvp/resumeSession.ts` — `ResumeAdapter` interface, `attachResume` driver, `restoreInto`, `resync` build/handle, 60s grace timer (Layer C driver).
- `frontend/src/pvp/resumeSession.test.ts` — cross-client drop→reconnect→reconcile integration; grace-timer unit.
- `frontend/src/pvp/mpClient.test.ts` — reconnect-loop units (mocked `WebSocket`).
- `frontend/src/pvp/mpClientFrameParity.test.ts` — frame + peer-message round-trip across two `MpClient`s (migration gate).
- `frontend/src/games/ticTacToe/app/lib/tttResumeAdapter.ts` — ttt/caro adapter.
- `frontend/src/games/blackjack/app/lib/bjResumeAdapter.ts` — blackjack adapter.
- `frontend/src/games/battleship/battleshipResumeAdapter.ts` — battleship adapter (+ fleet secret).
- `frontend/src/games/battleship/battleshipResumeAdapter.test.ts` — fleet-secret-never-in-resync test.
- `frontend/src/games/quantumPoker/pokerResumeAdapter.ts` — quantum poker adapter.

**Modified**
- `sui-tunnel-ts/src/core/distributedTunnel.ts` — add `adoptCheckpoint`, `snapshot`, `seatPending`, `resendPending`; `propose` refactored onto `seatPending`; `PendingProposal` gains `move`/`timestamp`.
- `sui-tunnel-ts/src/core/distributedTunnel.test.ts` — resume-primitive units.
- `sui-tunnel-ts/src/core/index.ts` — `export * from "./reconcile"`.
- `frontend/src/pvp/mpClient.ts` — reconnect loop, resume wire, typed events, active-match registry, `PeerMessage` extensions (`opened`/`settle`/`closed`/`stop` for ttt; `resync`).
- `frontend/package.json` — add `"src/pvp/**/*.test.ts"` to the `test` glob.
- `frontend/src/onchain/tunnelTx.ts` — surface unilateral `raiseDisputeUnilateral` + `forceCloseAfterTimeout`.
- The four hooks: `ticTacToe/app/hooks/usePvpTicTacToe.ts`, `blackjack/app/hooks/usePvpBlackjack.ts`, `battleship/useBattleshipPvp.ts`, `quantumPoker/usePvpQuantumPoker.ts`.
- `frontend/src/games/ticTacToe/app/lib/pvpRelay.ts` + `…/packages/client/src/lib/pvpRelay.ts` — `@deprecated`.

---

### Task 1: SDK — `DistributedTunnel` resume primitives

Seat a tunnel at a verified both-signed checkpoint, expose a read-only snapshot, prepare a pending proposal without sending, and re-send the current pending frame. These are the genuinely-missing tunnel capabilities resume needs; everything else (the reconcile decision, persistence, wire) builds on them.

**Files:**
- Modify: `sui-tunnel-ts/src/core/distributedTunnel.ts`
- Test: `sui-tunnel-ts/src/core/distributedTunnel.test.ts` (extend; co-located, `node:test`)

**Interfaces:**
- Consumes: `CoSignedUpdate`, `verifyCoSignedUpdate` (`./tunnel`), `StateUpdate`, `serializeStateUpdate` (`./wire`), `blake2b256` (`./crypto`), `bytesEqual` (`./bytes`), `MoveFrame`/`encodeFrame` (`./distributedFrame`); existing private `_state`/`_nonce`/`_latest`/`pending`/`total`/`self`/`opponent`/`selfParty`/`protocol`/`codec`/`transport`/`selfIsA()`.
- Produces:
  - `interface TunnelSnapshot<State, Move> { state: State; nonce: bigint; latest: CoSignedUpdate | null; pending: { move: Move; timestamp: bigint } | null }`
  - `adoptCheckpoint(state: State, coSigned: CoSignedUpdate): void` — verifies and seats; **throws** on a bad sig / wrong `tunnelId` / hash mismatch / balance-sum mismatch; **silent no-op** on a lower nonce.
  - `snapshot(): TunnelSnapshot<State, Move>`
  - `seatPending(move: Move, timestamp: bigint): void` — prepares + signs `pending` WITHOUT sending (deterministic).
  - `resendPending(): void` — re-sends the current `pending`'s MOVE frame byte-identically; no-op if none.
  - `propose` unchanged externally (now `seatPending` + send). `PendingProposal` gains `move`/`timestamp`.

- [ ] **Step 1: Write the failing tests**

Append to `sui-tunnel-ts/src/core/distributedTunnel.test.ts`. Reuse the file's existing `counterProtocol`, `makeEndpoint`, `defaultBackend`, `BAL` fixtures. Build a real both-signed checkpoint with `OffchainTunnel.selfPlay`, then adopt it into a fresh `DistributedTunnel`.

```ts
test("adoptCheckpoint seats a valid both-signed checkpoint and clears stale pending", () => {
  const tunnelId = `0x${"22".repeat(32)}`;
  const ka = generateKeyPair(), kb = generateKeyPair();
  // Produce a co-signed update at nonce 2 via self-play.
  const sp = OffchainTunnel.selfPlay(counterProtocol, tunnelId, ka, kb, "0xA", "0xB", BAL);
  sp.step(1, "A"); sp.step(1, "B");
  const checkpoint = sp.latest!;          // CoSignedUpdate at nonce 2
  const state = sp.state;                 // CounterState at nonce 2

  const backend = defaultBackend();
  const dt = new DistributedTunnel<typeof state, number>(
    counterProtocol,
    {
      tunnelId,
      self: makeEndpoint(backend, "0xA", { publicKey: ka.publicKey, scheme: 0, secretKey: ka.secretKey }, true),
      opponent: makeEndpoint(backend, "0xB", { publicKey: kb.publicKey, scheme: 0 }, false),
      selfParty: "A",
    },
    { send() {}, onFrame() {} },
    BAL,
  );
  dt.seatPending(1, 5n);                   // a stale pending at nonce 1
  dt.adoptCheckpoint(state, checkpoint);

  assert.equal(dt.nonce, 2n);
  assert.equal(dt.latest, checkpoint);
  assert.equal(dt.snapshot().pending, null, "pending <= adopted nonce is cleared");
  assert.deepEqual(dt.state, state);
});

test("adoptCheckpoint rejects a tampered signature", () => {
  const tunnelId = `0x${"23".repeat(32)}`;
  const ka = generateKeyPair(), kb = generateKeyPair();
  const sp = OffchainTunnel.selfPlay(counterProtocol, tunnelId, ka, kb, "0xA", "0xB", BAL);
  sp.step(1, "A");
  const bad = { ...sp.latest!, sigB: new Uint8Array(sp.latest!.sigB.length) };
  const backend = defaultBackend();
  const dt = new DistributedTunnel<ReturnType<typeof counterProtocol.initialState>, number>(
    counterProtocol,
    { tunnelId, self: makeEndpoint(backend, "0xA", { publicKey: ka.publicKey, scheme: 0, secretKey: ka.secretKey }, true),
      opponent: makeEndpoint(backend, "0xB", { publicKey: kb.publicKey, scheme: 0 }, false), selfParty: "A" },
    { send() {}, onFrame() {} }, BAL,
  );
  assert.throws(() => dt.adoptCheckpoint(sp.state, bad), /signature|verif/i);
});

test("adoptCheckpoint rejects wrong tunnelId, hash mismatch, and balance-sum mismatch; ignores lower nonce", () => {
  const tunnelId = `0x${"24".repeat(32)}`;
  const ka = generateKeyPair(), kb = generateKeyPair();
  const sp = OffchainTunnel.selfPlay(counterProtocol, tunnelId, ka, kb, "0xA", "0xB", BAL);
  sp.step(1, "A"); sp.step(1, "B");
  const cp = sp.latest!;
  const backend = defaultBackend();
  const mk = (tid: string) => new DistributedTunnel<ReturnType<typeof counterProtocol.initialState>, number>(
    counterProtocol,
    { tunnelId: tid, self: makeEndpoint(backend, "0xA", { publicKey: ka.publicKey, scheme: 0, secretKey: ka.secretKey }, true),
      opponent: makeEndpoint(backend, "0xB", { publicKey: kb.publicKey, scheme: 0 }, false), selfParty: "A" },
    { send() {}, onFrame() {} }, BAL,
  );
  // wrong tunnelId
  assert.throws(() => mk(`0x${"99".repeat(32)}`).adoptCheckpoint(sp.state, cp), /tunnelId/i);
  // hash mismatch: a different state under the signed hash
  const wrongState = { ...sp.state, count: (sp.state as { count: number }).count + 1 };
  assert.throws(() => mk(tunnelId).adoptCheckpoint(wrongState as typeof sp.state, cp), /hash/i);
  // balance-sum mismatch: a checkpoint whose balances do not sum to total
  const badBal = { ...cp, update: { ...cp.update, partyABalance: cp.update.partyABalance + 1n } };
  assert.throws(() => mk(tunnelId).adoptCheckpoint(sp.state, badBal), /balance/i);
  // lower nonce is a silent no-op
  const dt = mk(tunnelId);
  dt.adoptCheckpoint(sp.state, cp);                 // now at nonce 2
  const older = OffchainTunnel.selfPlay(counterProtocol, tunnelId, ka, kb, "0xA", "0xB", BAL);
  older.step(1, "A");                                // nonce 1
  dt.adoptCheckpoint(older.state, older.latest!);    // ignored
  assert.equal(dt.nonce, 2n);
});

test("seatPending does not send; resendPending re-emits the byte-identical MOVE frame", () => {
  const tunnelId = `0x${"25".repeat(32)}`;
  const ka = generateKeyPair(), kb = generateKeyPair();
  const sent: Uint8Array[] = [];
  const backend = defaultBackend();
  const dt = new DistributedTunnel<ReturnType<typeof counterProtocol.initialState>, number>(
    counterProtocol,
    { tunnelId, self: makeEndpoint(backend, "0xA", { publicKey: ka.publicKey, scheme: 0, secretKey: ka.secretKey }, true),
      opponent: makeEndpoint(backend, "0xB", { publicKey: kb.publicKey, scheme: 0 }, false), selfParty: "A" },
    { send: (b) => sent.push(b), onFrame() {} }, BAL,
  );
  dt.seatPending(1, 7n);
  assert.equal(sent.length, 0, "seatPending must not touch the transport");
  dt.resendPending();
  dt.resendPending();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], sent[1], "re-sends are deterministic and identical");
  // and identical to what propose() would have produced
  const sent2: Uint8Array[] = [];
  const dt2 = new DistributedTunnel<ReturnType<typeof counterProtocol.initialState>, number>(
    counterProtocol,
    { tunnelId, self: makeEndpoint(backend, "0xA", { publicKey: ka.publicKey, scheme: 0, secretKey: ka.secretKey }, true),
      opponent: makeEndpoint(backend, "0xB", { publicKey: kb.publicKey, scheme: 0 }, false), selfParty: "A" },
    { send: (b) => sent2.push(b), onFrame() {} }, BAL,
  );
  dt2.propose(1, 7n);
  assert.deepEqual(sent[0], sent2[0], "seatPending+resendPending == propose frame");
});
```

Add to the existing import block (top of the file already imports `OffchainTunnel`, `makeEndpoint`, `defaultBackend`, `generateKeyPair`, `DistributedTunnel`):
nothing new required beyond what the file already imports.

- [ ] **Step 2: Run to verify they fail**

Run: `cd sui-tunnel-ts && node --import tsx --test --test-name-pattern "adoptCheckpoint|seatPending" src/core/distributedTunnel.test.ts`
Expected: FAIL — `adoptCheckpoint`/`snapshot`/`seatPending`/`resendPending` are not functions.

- [ ] **Step 3: Add the imports + snapshot type**

In `distributedTunnel.ts`, extend the `./tunnel` import to include `verifyCoSignedUpdate`:

```ts
import { CoSignedSettlement, CoSignedSettlementWithRoot, CoSignedUpdate, PartyEndpoint, verifyCoSignedUpdate } from "./tunnel";
```

Add near the other exported interfaces (after `Transport`):

```ts
/** Read-only view of a tunnel's resume-relevant state (for persistence / reconciliation). */
export interface TunnelSnapshot<State, Move> {
  state: State;
  nonce: bigint;
  latest: CoSignedUpdate | null;
  pending: { move: Move; timestamp: bigint } | null;
}
```

- [ ] **Step 4: Carry `move`/`timestamp` on the pending proposal**

Change `PendingProposal` and the field type:

```ts
interface PendingProposal<State, Move> {
  next: State;
  update: StateUpdate;
  msg: Uint8Array;
  sigSelf: Uint8Array;
  move: Move;
  timestamp: bigint;
}
```
```ts
  private pending: PendingProposal<State, Move> | null;
```

- [ ] **Step 5: Refactor `propose` onto `seatPending` and add `resendPending`/a private frame builder**

Replace the body of `propose` and add the helpers (keep the existing doc comment on `propose`):

```ts
  propose(move: Move, timestamp: bigint): void {
    this.seatPending(move, timestamp);
    this.transport.send(encodeFrame(this.pendingMoveFrame(), this.codec));
  }

  /** Prepare + sign this seat's pending proposal WITHOUT sending it. Deterministic: the same
   *  (state, move, timestamp) yields byte-identical signed bytes — so a restored proposal
   *  re-sends identically. `propose` = seatPending + send; restore uses seatPending alone and
   *  lets the reconciliation handshake decide whether to (re-)send. */
  seatPending(move: Move, timestamp: bigint): void {
    if (this.pending) throw new Error("a proposal is already awaiting ACK");
    const next = this.protocol.applyMove(this._state, move, this.selfParty);
    const { a, b } = this.protocol.balances(next);
    if (a + b !== this.total) throw new Error(`balance sum ${a + b} != locked total ${this.total}`);
    const nonce = this._nonce + 1n;
    const stateHash = blake2b256(this.protocol.encodeState(next));
    const update: StateUpdate = {
      tunnelId: this.tunnelId,
      stateHash,
      nonce,
      timestamp,
      partyABalance: a,
      partyBBalance: b,
    };
    const msg = serializeStateUpdate(update);
    const sigSelf = this.self.sign!(msg);
    this.pending = { next, update, msg, sigSelf, move, timestamp };
  }

  /** Re-send the current pending proposal's MOVE frame (idempotent at the peer iff it has not
   *  applied it — the reconciliation handshake guarantees this). No-op if nothing is pending. */
  resendPending(): void {
    if (this.pending) this.transport.send(encodeFrame(this.pendingMoveFrame(), this.codec));
  }

  private pendingMoveFrame(): MoveFrame<Move> {
    const p = this.pending!;
    return {
      kind: "move",
      nonce: p.update.nonce,
      by: this.selfParty,
      move: p.move,
      timestamp: p.timestamp,
      stateHash: p.update.stateHash,
      partyABalance: p.update.partyABalance,
      partyBBalance: p.update.partyBBalance,
      sigProposer: p.sigSelf,
    };
  }
```

- [ ] **Step 6: Add `adoptCheckpoint` + `snapshot`**

Add as public methods (e.g. after `resendPending`):

```ts
  /** Seat the tunnel at a verified both-signed checkpoint (resume-time only). Asserts the
   *  checkpoint binds to `state`, balances sum to the locked total, and both signatures verify.
   *  A checkpoint older than the current nonce is ignored (never move backward). Throws on any
   *  integrity failure so the caller can fall through to the settlement floor. */
  adoptCheckpoint(state: State, coSigned: CoSignedUpdate): void {
    const u = coSigned.update;
    if (u.tunnelId !== this.tunnelId) throw new Error("adoptCheckpoint: tunnelId mismatch");
    if (u.nonce < this._nonce) return; // lower nonce: silent no-op
    if (u.partyABalance + u.partyBBalance !== this.total) {
      throw new Error("adoptCheckpoint: balance sum != locked total");
    }
    const reHash = blake2b256(this.protocol.encodeState(state));
    if (!bytesEqual(reHash, u.stateHash)) throw new Error("adoptCheckpoint: state hash mismatch");
    const partyA = this.selfIsA() ? this.self : this.opponent;
    const partyB = this.selfIsA() ? this.opponent : this.self;
    if (!verifyCoSignedUpdate(coSigned, partyA, partyB)) {
      throw new Error("adoptCheckpoint: co-signature verification failed");
    }
    this._state = state;
    this._nonce = u.nonce;
    this._latest = coSigned;
    if (this.pending && this.pending.update.nonce <= u.nonce) this.pending = null;
  }

  /** Read-only resume snapshot for persistence / reconciliation. */
  snapshot(): TunnelSnapshot<State, Move> {
    return {
      state: this._state,
      nonce: this._nonce,
      latest: this._latest,
      pending: this.pending ? { move: this.pending.move, timestamp: this.pending.timestamp } : null,
    };
  }
```

- [ ] **Step 7: Run the new tests + the full SDK suite**

Run: `cd sui-tunnel-ts && node --import tsx --test src/core/distributedTunnel.test.ts`
Expected: PASS (new tests + the existing `propose`/`onMove`/`onAck` tests, which are unchanged because the `propose` frame is byte-identical).
Then: `pnpm -C sui-tunnel-ts test` → PASS (no regressions across the SDK).

- [ ] **Step 8: Typecheck, format, commit**

Run: `pnpm -C sui-tunnel-ts typecheck && pnpm -C sui-tunnel-ts exec prettier --write src/core/distributedTunnel.ts src/core/distributedTunnel.test.ts`
```bash
git add sui-tunnel-ts/src/core/distributedTunnel.ts sui-tunnel-ts/src/core/distributedTunnel.test.ts
git commit -m "feat(tunnel): add resume primitives"
```

---

### Task 2: SDK — generic reconcile decision engine

A pure function that maps the two seats' resync views to one action. No IO, no crypto (verification lives in `adoptCheckpoint`). This is the audited decision table all four games share.

**Files:**
- Create: `sui-tunnel-ts/src/core/reconcile.ts`
- Modify: `sui-tunnel-ts/src/core/index.ts` (barrel export)
- Test: `sui-tunnel-ts/src/core/reconcile.test.ts` (new, `node:test`)

**Interfaces:**
- Consumes: `CoSignedUpdate` (`./tunnel`), `bytesEqual` (`./bytes`).
- Produces:
  - `type ReconcileAction = "adopt" | "wait" | "re-propose" | "noop" | "settle"`
  - `interface ReconcileDecision { action: ReconcileAction }`
  - `interface ResyncView { nonce: bigint; hasPending: boolean; checkpoint: CoSignedUpdate | null }`
  - `function decideReconcile(self: ResyncView, peer: ResyncView): ReconcileDecision`

- [ ] **Step 1: Write the failing tests**

Create `sui-tunnel-ts/src/core/reconcile.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { decideReconcile, ResyncView } from "./reconcile";
import { CoSignedUpdate } from "./tunnel";

const cp = (nonce: bigint, hashByte: number): CoSignedUpdate => ({
  update: {
    tunnelId: `0x${"11".repeat(32)}`,
    stateHash: new Uint8Array(32).fill(hashByte),
    nonce,
    timestamp: 0n,
    partyABalance: 1000n,
    partyBBalance: 1000n,
  },
  sigA: new Uint8Array(64),
  sigB: new Uint8Array(64),
});
const view = (nonce: bigint, hasPending: boolean, checkpoint: CoSignedUpdate | null): ResyncView =>
  ({ nonce, hasPending, checkpoint });

test("peer ahead -> adopt", () => {
  assert.equal(decideReconcile(view(1n, false, cp(1n, 1)), view(2n, false, cp(2n, 2))).action, "adopt");
});
test("self ahead -> wait (peer adopts mine)", () => {
  assert.equal(decideReconcile(view(2n, false, cp(2n, 2)), view(1n, false, cp(1n, 1))).action, "wait");
});
test("equal nonce + self has pending -> re-propose", () => {
  assert.equal(decideReconcile(view(3n, true, cp(3n, 3)), view(3n, false, cp(3n, 3))).action, "re-propose");
});
test("equal nonce + no pending -> noop", () => {
  assert.equal(decideReconcile(view(3n, false, cp(3n, 3)), view(3n, false, cp(3n, 3))).action, "noop");
});
test("equal nonce + conflicting stateHash -> settle (equivocation)", () => {
  assert.equal(decideReconcile(view(3n, true, cp(3n, 3)), view(3n, false, cp(3n, 9))).action, "settle");
});
test("equal at nonce 0 with no checkpoints -> noop, not settle", () => {
  assert.equal(decideReconcile(view(0n, false, null), view(0n, false, null)).action, "noop");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd sui-tunnel-ts && node --import tsx --test src/core/reconcile.test.ts`
Expected: FAIL — `./reconcile` does not exist.

- [ ] **Step 3: Implement `reconcile.ts`**

Create `sui-tunnel-ts/src/core/reconcile.ts`:

```ts
/**
 * Resume reconciliation decision table (pure). Given each seat's latest co-signed nonce, whether
 * it holds an in-flight proposal, and its checkpoint, decide the single action that converges the
 * two seats. A drop leaves them AT MOST one move apart (a seat cannot propose nonce N+2 while N+1
 * is pending), so these five cases are exhaustive. Verification is NOT done here — the caller
 * verifies the peer's checkpoint inside `DistributedTunnel.adoptCheckpoint` when acting on "adopt".
 */
import { bytesEqual } from "./bytes";
import { CoSignedUpdate } from "./tunnel";

export type ReconcileAction = "adopt" | "wait" | "re-propose" | "noop" | "settle";
export interface ReconcileDecision {
  action: ReconcileAction;
}

/** One seat's view exchanged in a `resync`. `checkpoint` is its highest both-signed update. */
export interface ResyncView {
  nonce: bigint;
  hasPending: boolean;
  checkpoint: CoSignedUpdate | null;
}

/**
 * Decide what THIS seat (`self`) should do given the peer's resync view.
 *  - peer ahead            -> "adopt"      (adopt peer's checkpoint+state; clears my pending)
 *  - self ahead            -> "wait"       (my resync lets the peer adopt; nothing for me to do)
 *  - equal, conflicting    -> "settle"     (equivocation: different both-signed state at one nonce)
 *  - equal, self pending   -> "re-propose" (re-send my in-flight MOVE through the normal transport)
 *  - equal, no pending     -> "noop"       (already converged; resume play)
 */
export function decideReconcile(self: ResyncView, peer: ResyncView): ReconcileDecision {
  if (peer.nonce > self.nonce) return { action: "adopt" };
  if (self.nonce > peer.nonce) return { action: "wait" };
  if (
    self.checkpoint &&
    peer.checkpoint &&
    !bytesEqual(self.checkpoint.update.stateHash, peer.checkpoint.update.stateHash)
  ) {
    return { action: "settle" };
  }
  if (self.hasPending) return { action: "re-propose" };
  return { action: "noop" };
}
```

- [ ] **Step 4: Export from the core barrel**

In `sui-tunnel-ts/src/core/index.ts`, add after the `distributedTunnel` export line:

```ts
export * from "./reconcile";
```

- [ ] **Step 5: Run the tests + suite**

Run: `cd sui-tunnel-ts && node --import tsx --test src/core/reconcile.test.ts` → PASS.
Then: `pnpm -C sui-tunnel-ts test` → PASS.

- [ ] **Step 6: Typecheck, format, commit**

Run: `pnpm -C sui-tunnel-ts typecheck && pnpm -C sui-tunnel-ts exec prettier --write src/core/reconcile.ts src/core/reconcile.test.ts src/core/index.ts`
```bash
git add sui-tunnel-ts/src/core/reconcile.ts src/core/reconcile.test.ts src/core/index.ts
git commit -m "feat(reconcile): add resume decision engine"
```

> Note the `git add` paths are relative to `sui-tunnel-ts/` if you `cd`'d in; from the repo root use the full `sui-tunnel-ts/src/core/...` paths.

---

### Task 3: MpClient — reconnect loop, resume wire, typed events, active-match registry

Make `MpClient` reconnect-capable: on an unexpected socket close, reconnect to the LB with capped exponential backoff + jitter, re-run the `challenge→connect` handshake, then `resume { matchId }` for every active match (and re-issue `queue.join` if only queued). Surface `resume.ok` / `peer.resumed` / `peer.dropped` as typed events. The relay-handler map, match queue/waiters, active-match registry, and queued-game list all survive the socket swap.

**Files:**
- Modify: `frontend/src/pvp/mpClient.ts`
- Modify: `frontend/package.json` (add `"src/pvp/**/*.test.ts"` to the `test` glob so the new tests run)
- Test: `frontend/src/pvp/mpClient.test.ts` (new, mocked `WebSocket`, `node:test`)

**Interfaces:**
- Consumes: existing handshake, `#relayHandlers`, `#matchQueue`, `#matchWaiters`, `wrapInnerFrameJson`.
- Produces (new public surface):
  - `interface ResumeOkEvent { matchId: string; role: Role; opponentWallet: string; game: string; peerOnline: boolean }`
  - `interface PeerResumedEvent { matchId: string; seat: Role; connRef: unknown }`
  - `interface PeerDroppedEvent { matchId: string }`
  - `interface ReconnectConfig { baseMs: number; maxMs: number; jitter: number }` and `function nextBackoffDelay(attempt: number, cfg: ReconnectConfig, rand: () => number): number`
  - `onResumeOk(cb)`, `onPeerResumed(cb)`, `onPeerDropped(cb)` — subscribe; return an unsubscribe fn.
  - `markActive(matchId: string)` — register a match the reconnect loop should `resume` (also set automatically at `match.found` and `channel(matchId)`; cleared in `releaseMatch`).
  - constructor gains an optional 4th arg `opts?: { WebSocketCtor?: typeof WebSocket; reconnect?: ReconnectConfig; scheduler?: (fn: () => void, ms: number) => void; rand?: () => number }` (defaults: global `WebSocket`, `{ baseMs: 500, maxMs: 10_000, jitter: 0.2 }`, `setTimeout`, `Math.random`) — the seam that makes reconnect unit-testable.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/pvp/mpClient.test.ts`. A `FakeWebSocket` records instances and lets the test drive `onopen`/`onmessage`/`onclose`. A synchronous `scheduler` runs reconnect immediately; `jitter: 0` and `rand: () => 0` make delays deterministic.

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { MpClient, nextBackoffDelay } from "./mpClient";
import { generateKeyPair } from "sui-tunnel-ts/core/crypto";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  url: string;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(s: string) { this.sent.push(s); }
  close() { this.closed = true; this.onclose?.(); }
  // test helpers
  open() { this.onopen?.(); }
  recv(obj: unknown) { this.onmessage?.({ data: JSON.stringify(obj) }); }
  // drive the challenge so connect() resolves
  handshake() { this.open(); this.recv({ type: "challenge", nonce: "n1" }); }
}

function mkClient() {
  FakeWebSocket.instances = [];
  const eph = generateKeyPair();
  const mp = new MpClient("ws://x/v1/mp", "0xwallet", eph as never, {
    WebSocketCtor: FakeWebSocket as unknown as typeof WebSocket,
    reconnect: { baseMs: 1, maxMs: 4, jitter: 0 },
    scheduler: (fn) => fn(),       // run reconnect synchronously
    rand: () => 0,
  });
  return { mp };
}

test("nextBackoffDelay grows exponentially, caps, and stays within the jitter band", () => {
  const cfg = { baseMs: 500, maxMs: 10_000, jitter: 0.2 };
  assert.equal(nextBackoffDelay(0, cfg, () => 0.5), 500);          // base, mid-jitter == base
  assert.equal(nextBackoffDelay(1, cfg, () => 0.5), 1000);
  assert.equal(nextBackoffDelay(10, cfg, () => 0.5), 10_000);      // capped
  const lo = nextBackoffDelay(2, cfg, () => 0);                    // 2000 * (1 - 0.2)
  const hi = nextBackoffDelay(2, cfg, () => 1);                    // 2000 * (1 + 0.2)
  assert.ok(lo >= 1600 && hi <= 2400, `band [${lo}, ${hi}]`);
});

test("unexpected close reconnects, re-runs connect, and resumes each active match", async () => {
  const { mp } = mkClient();
  await connect(mp);
  mp.markActive("m1");
  mp.markActive("m2");
  FakeWebSocket.instances[0].close();                  // unexpected drop
  // a new socket was created and re-handshaked by the loop
  const fresh = FakeWebSocket.instances[1];
  assert.ok(fresh, "reconnected with a new socket");
  fresh.handshake();
  const resumes = fresh.sent.map((s) => JSON.parse(s)).filter((m) => m.type === "resume");
  assert.deepEqual(resumes.map((r) => r.matchId).sort(), ["m1", "m2"]);
});

test("queued-only client re-issues queue.join on reconnect", async () => {
  const { mp } = mkClient();
  await connect(mp);
  void mp.quickMatch("ttt");                            // queued, no match yet
  FakeWebSocket.instances[0].close();
  const fresh = FakeWebSocket.instances[1];
  fresh.handshake();
  const joins = fresh.sent.map((s) => JSON.parse(s)).filter((m) => m.type === "queue.join");
  assert.deepEqual(joins.map((j) => j.game), ["ttt"]);
});

test("relay handlers and match waiters survive the socket swap", async () => {
  const { mp } = mkClient();
  await connect(mp);
  const ch = mp.channel("m1");
  let got: Uint8Array | null = null;
  ch.transport.onFrame((b) => { got = b; });
  FakeWebSocket.instances[0].close();
  FakeWebSocket.instances[1].handshake();
  // a relay for m1 still routes to the same handler after reconnect
  FakeWebSocket.instances[1].recv({ type: "relay", matchId: "m1", payload: JSON.stringify({ t: "frame", data: "hi" }) });
  assert.equal(new TextDecoder().decode(got!), "hi");
});

test("explicit close() does not reconnect", async () => {
  const { mp } = mkClient();
  await connect(mp);
  mp.close();
  assert.equal(FakeWebSocket.instances.length, 1, "no new socket after explicit close");
});

test("typed events dispatch resume.ok / peer.resumed / peer.dropped", async () => {
  const { mp } = mkClient();
  await connect(mp);
  const seen: string[] = [];
  mp.onResumeOk((e) => seen.push(`ok:${e.matchId}:${e.peerOnline}`));
  mp.onPeerResumed((e) => seen.push(`res:${e.matchId}:${e.seat}`));
  mp.onPeerDropped((e) => seen.push(`drop:${e.matchId}`));
  const ws = FakeWebSocket.instances[0];
  ws.recv({ type: "resume.ok", matchId: "m1", role: "A", opponentWallet: "0xb", game: "ttt", peerOnline: true });
  ws.recv({ type: "peer.resumed", matchId: "m1", seat: "B", connRef: { x: 1 } });
  ws.recv({ type: "peer.dropped", matchId: "m1" });
  assert.deepEqual(seen, ["ok:m1:true", "res:m1:B", "drop:m1"]);
});

// connect() resolves after the challenge; the FakeWebSocket created synchronously is instances[0].
async function connect(mp: MpClient) {
  const p = mp.connect();
  FakeWebSocket.instances[0].handshake();
  await p;
}
```

- [ ] **Step 2: Add the pvp test glob, then run to verify failure**

In `frontend/package.json`, change the `test` script to include `"src/pvp/**/*.test.ts"`:

```json
"test": "node --import tsx --test \"src/components/**/*.test.ts\" \"src/backend/**/*.test.ts\" \"src/pvp/**/*.test.ts\" \"src/games/blackjack/*.test.ts\" \"src/games/battleship/**/*.test.ts\"",
```

Run: `cd frontend && node --import tsx --test src/pvp/mpClient.test.ts`
Expected: FAIL — `nextBackoffDelay`, `onResumeOk`, `markActive`, and the `opts` ctor arg do not exist.

- [ ] **Step 3: Add the event types + backoff helper**

In `mpClient.ts`, after the `MatchInfo` interface, add:

```ts
export interface ResumeOkEvent {
  matchId: string;
  role: Role;
  opponentWallet: string;
  game: string;
  peerOnline: boolean;
}
export interface PeerResumedEvent {
  matchId: string;
  seat: Role;
  /** Server-side routing only — the FE ignores its contents. */
  connRef: unknown;
}
export interface PeerDroppedEvent {
  matchId: string;
}

export interface ReconnectConfig {
  baseMs: number;
  maxMs: number;
  jitter: number;
}
const DEFAULT_RECONNECT: ReconnectConfig = { baseMs: 500, maxMs: 10_000, jitter: 0.2 };

/** Capped exponential backoff with symmetric jitter. `attempt` is 0-based. `rand` ∈ [0,1). */
export function nextBackoffDelay(attempt: number, cfg: ReconnectConfig, rand: () => number): number {
  const capped = Math.min(cfg.maxMs, cfg.baseMs * 2 ** attempt);
  const spread = capped * cfg.jitter;
  return Math.round(capped - spread + rand() * spread * 2);
}

interface MpClientOptions {
  WebSocketCtor?: typeof WebSocket;
  reconnect?: ReconnectConfig;
  scheduler?: (fn: () => void, ms: number) => void;
  rand?: () => number;
}
```

- [ ] **Step 4: Add the fields, constructor opts, and event-subscription plumbing**

Add private fields and wire the constructor (keep the existing field block; add these):

```ts
  #closing = false;
  #reconnectAttempt = 0;
  #activeMatches = new Set<string>();
  #queuedGames: string[] = [];
  readonly #WebSocketCtor: typeof WebSocket;
  readonly #reconnectCfg: ReconnectConfig;
  readonly #schedule: (fn: () => void, ms: number) => void;
  readonly #rand: () => number;
  readonly #resumeOkSubs = new Set<(e: ResumeOkEvent) => void>();
  readonly #peerResumedSubs = new Set<(e: PeerResumedEvent) => void>();
  readonly #peerDroppedSubs = new Set<(e: PeerDroppedEvent) => void>();
```

Change the constructor signature to accept `opts` and initialize:

```ts
  constructor(url: string, wallet: string, ephemeral: KeyPair, opts: MpClientOptions = {}) {
    this.#url = url;
    this.#wallet = wallet;
    this.#ephemeral = ephemeral;
    this.#sign = defaultBackend().makeSigner(ephemeral.secretKey!);
    this.#WebSocketCtor = opts.WebSocketCtor ?? WebSocket;
    this.#reconnectCfg = opts.reconnect ?? DEFAULT_RECONNECT;
    this.#schedule = opts.scheduler ?? ((fn, ms) => { setTimeout(fn, ms); });
    this.#rand = opts.rand ?? Math.random;
  }
```

Add subscription methods (return an unsubscribe):

```ts
  onResumeOk(cb: (e: ResumeOkEvent) => void): () => void {
    this.#resumeOkSubs.add(cb);
    return () => this.#resumeOkSubs.delete(cb);
  }
  onPeerResumed(cb: (e: PeerResumedEvent) => void): () => void {
    this.#peerResumedSubs.add(cb);
    return () => this.#peerResumedSubs.delete(cb);
  }
  onPeerDropped(cb: (e: PeerDroppedEvent) => void): () => void {
    this.#peerDroppedSubs.add(cb);
    return () => this.#peerDroppedSubs.delete(cb);
  }
  /** Register a match so the reconnect loop will `resume` it. */
  markActive(matchId: string): void {
    this.#activeMatches.add(matchId);
  }
```

- [ ] **Step 5: Refactor `connect` into a reusable socket-open + persistent close handler**

Replace `connect()` and `#deliverMatch`/queue plumbing so the message handler, queue tracking, and active-match registry are shared across sockets. The handler now also wires `resume.ok`/`peer.resumed`/`peer.dropped` and records active matches at `match.found`.

```ts
  /** Open the socket and complete the challenge→connect handshake. Installs the persistent
   *  onclose handler that drives reconnection. Safe to call once; reconnects reuse #openSocket. */
  connect(): Promise<void> {
    this.#closing = false;
    return this.#openSocket();
  }

  #openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new this.#WebSocketCtor(this.#url);
      this.#ws = ws;
      let opened = false;
      ws.onmessage = (ev) => {
        const m = JSON.parse(typeof ev.data === "string" ? ev.data : "");
        if (m.type === "challenge") {
          const sig = this.#sign(te.encode(m.nonce));
          ws.send(JSON.stringify({
            type: "connect", wallet: this.#wallet,
            pubkey: toHex(this.#ephemeral.publicKey), sig: toHex(sig), nonce: m.nonce,
          }));
          this.#connected = true;
          opened = true;
          resolve();
        } else if (m.type === "match.found") {
          this.#activeMatches.add(m.matchId as string);
          this.#dropQueued(m.game as string);
          this.#deliverMatch({
            matchId: m.matchId as string, role: m.role as Role,
            opponentWallet: m.opponentWallet as string, game: m.game as string,
          });
        } else if (m.type === "relay") {
          this.#relayHandlers.get(m.matchId as string)?.(m.payload as string);
        } else if (m.type === "resume.ok") {
          this.#activeMatches.add(m.matchId as string);
          this.#emitResumeOk({
            matchId: m.matchId, role: m.role, opponentWallet: m.opponentWallet,
            game: m.game, peerOnline: !!m.peerOnline,
          });
        } else if (m.type === "peer.resumed") {
          this.#emitPeerResumed({ matchId: m.matchId, seat: m.seat as Role, connRef: m.connRef });
        } else if (m.type === "peer.dropped") {
          this.#emitPeerDropped({ matchId: m.matchId });
        } else if (m.type === "queue.timeout") {
          this.#failNextMatch(new Error("queue.timeout"));
        } else if (m.type === "error") {
          if (!this.#connected) reject(new Error(`mp ${m.code}: ${m.message}`));
          else this.#failNextMatch(new Error(`mp ${m.code}: ${m.message}`));
        }
      };
      ws.onerror = () => {
        if (!opened && !this.#connected) reject(new Error("mp websocket error"));
      };
      ws.onclose = () => {
        this.#ws = null;
        if (!this.#closing) this.#scheduleReconnect();
      };
    });
  }

  #scheduleReconnect(): void {
    const delay = nextBackoffDelay(this.#reconnectAttempt++, this.#reconnectCfg, this.#rand);
    this.#schedule(() => {
      if (this.#closing) return;
      void this.#openSocket()
        .then(() => {
          this.#reconnectAttempt = 0;
          this.#resumeActive();
        })
        .catch(() => this.#scheduleReconnect());
    }, delay);
  }

  /** After a reconnect handshake, re-attach to every active match and re-queue if only queued. */
  #resumeActive(): void {
    for (const matchId of this.#activeMatches) this.#send({ type: "resume", matchId });
    if (this.#activeMatches.size === 0) {
      for (const game of this.#queuedGames) this.#send({ type: "queue.join", game });
    }
  }

  #emitResumeOk(e: ResumeOkEvent) { this.#resumeOkSubs.forEach((cb) => cb(e)); }
  #emitPeerResumed(e: PeerResumedEvent) { this.#peerResumedSubs.forEach((cb) => cb(e)); }
  #emitPeerDropped(e: PeerDroppedEvent) { this.#peerDroppedSubs.forEach((cb) => cb(e)); }
  #dropQueued(game: string) {
    const i = this.#queuedGames.indexOf(game);
    if (i >= 0) this.#queuedGames.splice(i, 1);
  }
```

- [ ] **Step 6: Track queued games and clear the active registry on release/close**

Update `quickMatch` to record the queued game, and `releaseMatch`/`close` to maintain the registry:

```ts
  quickMatch(game: string): Promise<MatchInfo> {
    this.#queuedGames.push(game);
    this.#send({ type: "queue.join", game });
    const buffered = this.#matchQueue.shift();
    if (buffered) { this.#dropQueued(buffered.game); return Promise.resolve(buffered); }
    return new Promise((resolve, reject) => this.#matchWaiters.push({ resolve, reject }));
  }
```
```ts
  releaseMatch(matchId: string) {
    this.#relayHandlers.delete(matchId);
    this.#activeMatches.delete(matchId);
  }

  close() {
    this.#closing = true;
    this.#ws?.close();
    this.#ws = null;
  }
```

Also register the match in `channel(matchId)` so a match the caller is mid-setup on is resumable: add `this.#activeMatches.add(matchId);` as the first line of `channel`.

- [ ] **Step 7: Run the tests**

Run: `cd frontend && node --import tsx --test src/pvp/mpClient.test.ts`
Expected: PASS.
Then: `pnpm -C frontend test` → PASS (the new pvp glob runs alongside the existing suites).

- [ ] **Step 8: Typecheck, format, commit**

Run: `pnpm -C frontend typecheck && pnpm -C frontend format`
```bash
git add frontend/src/pvp/mpClient.ts frontend/src/pvp/mpClient.test.ts frontend/package.json
git commit -m "feat(mp): add reconnect loop and resume wire"
```

---

### Task 4: Migrate ttt/caro to MpClient; deprecate RelayClient

Swap the ttt/caro hook's transport from `RelayClient` to the now-reconnect-capable `MpClient`, reconciling the one real divergence (the engine-frame envelope key: `RelayClient`'s `{t:"frame", f}` vs `MpClient`'s `{t:"frame", data}`). Map the hook's app messages onto `MpClient`'s peer channel by extending the `PeerMessage` union with the variants ttt/caro already use (their handler bodies stay identical). Mark `RelayClient` (and its `packages/client/` copy) `@deprecated` — keep, don't delete.

**Files:**
- Modify: `frontend/src/pvp/mpClient.ts` (extend `PeerMessage` with `opened`/`settle`/`closed`/`stop`)
- Modify: `frontend/src/games/ticTacToe/app/hooks/usePvpTicTacToe.ts`
- Modify: `frontend/src/games/ticTacToe/app/lib/pvpRelay.ts` (`@deprecated`)
- Modify: `frontend/src/games/ticTacToe/packages/client/src/lib/pvpRelay.ts` (`@deprecated`)
- Test: `frontend/src/pvp/mpClientFrameParity.test.ts` (new — the migration gate)

**Interfaces:**
- Consumes: `MpClient.connect`, `quickMatch`, `channel`, `announceTunnel`, `releaseMatch`, `onResumeOk`/`onPeerResumed`/`onPeerDropped`; the extended `PeerMessage`.
- Produces: ttt/caro running on `MpClient`; `RelayClient` `@deprecated`. No change to the engine, the protocol, or the on-chain path.

The exact ttt/caro app messages (from `usePvpTicTacToe.ts:235,261,332,355,383,582`): `{t:"opened", tunnelId}`, `{t:"settle", sig, root}`, `{t:"closed", digest}`, `{t:"stop"}`, plus the ephemeral-pubkey exchange. `MpClient` already carries `{t:"hello", ephemeralPubkey}` — the hook's `party.hello` server message maps to that peer message (matching how battleship/poker already exchange `hello`).

- [ ] **Step 1: Write the failing parity test**

Create `frontend/src/pvp/mpClientFrameParity.test.ts`. Build an in-memory fake relay that connects two `MpClient`s: each client's `FakeWebSocket.send` of a `{type:"relay", matchId, payload}` is delivered to the OTHER client's `onmessage` as `{type:"relay", matchId, payload}`. Then assert an engine frame and a peer message round-trip across the `channel` API.

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { MpClient } from "./mpClient";
import { generateKeyPair } from "sui-tunnel-ts/core/crypto";

// Two FakeWebSockets cross-wired: a relay frame sent by one is received by the other.
function fakeRelayPair() {
  const peers: FakeWS[] = [];
  class FakeWS {
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(_url: string) { peers.push(this); }
    send(s: string) {
      const m = JSON.parse(s);
      if (m.type === "relay") {
        const other = peers.find((p) => p !== this);
        other?.onmessage?.({ data: JSON.stringify({ type: "relay", matchId: m.matchId, payload: m.payload }) });
      }
    }
    close() { this.onclose?.(); }
    handshake() { this.onopen?.(); this.onmessage?.({ data: JSON.stringify({ type: "challenge", nonce: "n" }) }); }
  }
  return { FakeWS, peers };
}

test("engine frames and peer messages round-trip across two MpClients (envelope parity)", async () => {
  const { FakeWS, peers } = fakeRelayPair();
  const opts = { WebSocketCtor: FakeWS as unknown as typeof WebSocket } as never;
  const a = new MpClient("ws://x", "0xa", generateKeyPair() as never, opts);
  const b = new MpClient("ws://x", "0xb", generateKeyPair() as never, opts);
  const pa = a.connect(); peers[0].handshake(); await pa;
  const pb = b.connect(); peers[1].handshake(); await pb;

  const chA = a.channel("m1");
  const chB = b.channel("m1");
  let frame: Uint8Array | null = null;
  let peerMsg: unknown = null;
  chB.transport.onFrame((bytes) => { frame = bytes; });
  chB.onPeer((m) => { peerMsg = m; });

  chA.transport.send(new TextEncoder().encode(JSON.stringify({ kind: "move", nonce: "1" })));
  chA.sendPeer({ t: "hello", ephemeralPubkey: "deadbeef" } as never);

  assert.equal(JSON.parse(new TextDecoder().decode(frame!)).kind, "move", "frame survives the {t:frame,data} envelope");
  assert.deepEqual(peerMsg, { t: "hello", ephemeralPubkey: "deadbeef" });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && node --import tsx --test src/pvp/mpClientFrameParity.test.ts`
Expected: FAIL — the assertions don't pass until the two clients are correctly cross-wired through the real `channel` send/decode paths (this test also guards that `MpClient`'s `{t:"frame", data}` envelope is the one in effect).

> If this test already passes (the `channel`/transport plumbing is unchanged from Task 3), keep it as a permanent regression guard for the envelope and proceed — the migration's real change is in the hook, which is exercised by Steps 4–6 + typecheck.

- [ ] **Step 3: Extend the `PeerMessage` union for ttt/caro app messages**

In `mpClient.ts`, add the ttt/caro variants to `PeerMessage` (keep the existing ones):

```ts
  | { t: "opened"; tunnelId: string }
  | { t: "settle"; sig: string; root: string }
  | { t: "closed"; digest: string }
  | { t: "stop" }
```

(These mirror `RelayClient`'s app messages verbatim so the hook's dispatcher logic is copied unchanged. Consolidating `opened`↔`open` is a later cleanup, out of scope.)

- [ ] **Step 4: Migrate the ttt/caro hook transport**

In `usePvpTicTacToe.ts`, replace the `RelayClient` wiring with `MpClient`. The mapping (apply at each call site):

| RelayClient (today) | MpClient (after) |
|---|---|
| `import { RelayClient } from "@/games/ticTacToe/app/lib/pvpRelay"` | `import { MpClient, resolveMpWsUrl, type MatchInfo, type PeerMessage } from "@/pvp/mpClient"` |
| `new RelayClient(MP_URL, w.address, eph.coreKey)` | `new MpClient(resolveMpWsUrl(MP_URL), w.address, eph.coreKey)` |
| `await relay.ready` | `await mp.connect()` |
| `relay.on("error", …)` | wrap `quickMatch` in try/catch (it rejects with the error) |
| `relay.on("match.found", cb)` + `relay.queueJoin(game)` | `const m = await mp.quickMatch(game)` then call the existing `onMatch(mp, m)` |
| `relay.transport(matchId)` | `mp.channel(matchId).transport` |
| `relay.onApp(matchId, cb)` | `mp.channel(matchId).onPeer(cb)` — keep the `mm.t === "opened" | "settle" | "closed" | "stop"` body unchanged |
| `relay.sendApp(matchId, {t:"opened",tunnelId})` etc. | `channel.sendPeer({t:"opened",tunnelId})` etc. (hold the `channel` from `mp.channel(matchId)` in a ref) |
| `relay.partyHello(matchId, eph.pubkeyHex, "")` | `channel.sendPeer({ t: "hello", ephemeralPubkey: eph.pubkeyHex })` |
| `relay.on("party.hello", cb)` (reads `h.ephemeralPubkey`) | handle `{t:"hello"}` inside the same `onPeer` dispatcher: `if (mm.t === "hello") { … mm.ephemeralPubkey … }` |
| `relay.tunnelOpened(matchId, tunnelId)` | `mp.announceTunnel(matchId, tunnelId)` |
| `relay.close()` | `mp.close()` |
| `relayRef` type/usages | `mpRef: useRef<MpClient | null>` + a `channelRef: useRef<PvpChannel | null>` |

Key detail: `MpClient.channel(matchId)` must be called **once** per match and the returned `PvpChannel` held in a ref — both the engine transport and `sendPeer`/`onPeer` come from that one object, and calling `channel` again re-binds the relay handler. Build the channel in `onMatch`, store it, and pass `channel.transport` to `new core.DistributedTunnel(...)` (replacing `relay.transport(m.matchId)` at line ~452).

- [ ] **Step 5: Mark `RelayClient` `@deprecated`**

At the top of `frontend/src/games/ticTacToe/app/lib/pvpRelay.ts`, above `export class RelayClient`, add:

```ts
/**
 * @deprecated Use `MpClient` from `@/pvp/mpClient`, which adds the reconnect/resume loop. ttt/caro
 * migrated off `RelayClient`; this class is kept (not deleted) for reference and lower-risk rollback.
 */
```
Apply the identical doc comment to `frontend/src/games/ticTacToe/packages/client/src/lib/pvpRelay.ts`.

- [ ] **Step 6: Run the parity test + typecheck**

Run: `cd frontend && node --import tsx --test src/pvp/mpClientFrameParity.test.ts` → PASS.
Run: `pnpm -C frontend typecheck` → PASS (the hook now compiles against `MpClient`'s API; the `PeerMessage` union covers every `mm.t` branch).
Run: `pnpm -C frontend test` → PASS.

- [ ] **Step 7: Engine regression note (no code change)**

The engine-only bun e2e (`ticTacToe/app/lib/pvpEngine.e2e.test.ts` and the `packages/client` copy) never touch a WS client, so the migration cannot regress them. If bun is available, optionally confirm: `cd frontend/src/games/ticTacToe && bun test src/app/lib/pvpEngine.e2e.test.ts` → PASS. Do not gate the task on bun.

- [ ] **Step 8: Format, commit**

Run: `pnpm -C frontend format`
```bash
git add frontend/src/pvp/mpClient.ts frontend/src/pvp/mpClientFrameParity.test.ts \
  frontend/src/games/ticTacToe/app/hooks/usePvpTicTacToe.ts \
  frontend/src/games/ticTacToe/app/lib/pvpRelay.ts \
  frontend/src/games/ticTacToe/packages/client/src/lib/pvpRelay.ts
git commit -m "refactor(pvp): migrate ttt/caro to MpClient"
```

---

### Task 5: Persistence helper (`resume.ts`)

The reload-grade layer: a compact `ResumeRecord` per tunnel in `localStorage`, written debounced/coalesced on each confirmed move and flushed synchronously on `pagehide`. Includes bigint-safe JSON, `CoSignedUpdate`↔wire conversions, a persisted active-tunnel index, and 6h TTL eviction. This task is pure persistence + wire plumbing; the adapter/handshake driver that calls it lands in Task 6.

**Files:**
- Create: `frontend/src/pvp/resume.ts`
- Test: `frontend/src/pvp/resume.test.ts` (new, `node:test`)

**Interfaces:**
- Consumes: `CoSignedUpdate`, `StateUpdate` (`sui-tunnel-ts/core/tunnel`, `…/core/wire`), `toHex`/`fromHex` (`sui-tunnel-ts/core/bytes`).
- Produces:
  - `type JsonValue` (re-exported alias for `unknown`-ish JSON), `WireStateUpdate`, `WireCoSigned`, `ResumeRecord`.
  - `toWireCoSigned(u: CoSignedUpdate): WireCoSigned`, `fromWireCoSigned(w: WireCoSigned): CoSignedUpdate`.
  - `stringifyWithBigint(v: unknown): string`, `parseWithBigint(s: string): unknown`.
  - `writeResumeRecord(r: ResumeRecord): void` (debounced), `flushResumeWrites(): void` (sync), `installResumePersistence(): void` (registers `pagehide`/`visibilitychange` flush; idempotent).
  - `readResumeRecord(tunnelId: string): ResumeRecord | null`, `clearResumeRecord(tunnelId: string): void`, `listActiveTunnels(): string[]`, `evictExpiredRecords(maxAgeMs?: number): void` (default `6 * 3600_000`).

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/pvp/resume.test.ts`. `node` has no `localStorage`/`window`, so install minimal fakes on `globalThis` before importing the module under test.

```ts
import test from "node:test";
import assert from "node:assert/strict";

// Minimal localStorage + window fakes (must exist before importing resume.ts).
class FakeStorage {
  map = new Map<string, string>();
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
}
(globalThis as Record<string, unknown>).localStorage = new FakeStorage();
(globalThis as Record<string, unknown>).window = { addEventListener() {} };

const {
  stringifyWithBigint, parseWithBigint, toWireCoSigned, fromWireCoSigned,
  writeResumeRecord, flushResumeWrites, readResumeRecord, clearResumeRecord,
  listActiveTunnels, evictExpiredRecords,
} = await import("./resume");
const { OffchainTunnel, makeEndpoint } = await import("sui-tunnel-ts/core/tunnel");
const { defaultBackend } = await import("sui-tunnel-ts/core/crypto-native");
const { generateKeyPair } = await import("sui-tunnel-ts/core/crypto");

test("bigint round-trips through stringify/parse", () => {
  const v = { a: 10n, nested: [1n, { b: 2n }], s: "x" };
  assert.deepEqual(parseWithBigint(stringifyWithBigint(v)), v);
});

test("CoSignedUpdate survives the wire conversion byte-for-byte", () => {
  const ka = generateKeyPair(), kb = generateKeyPair();
  const tid = `0x${"31".repeat(32)}`;
  const sp = OffchainTunnel.selfPlay(counterProto(), tid, ka, kb, "0xA", "0xB", { a: 1000n, b: 1000n });
  sp.step(1, "A");
  const u = sp.latest!;
  const back = fromWireCoSigned(toWireCoSigned(u));
  assert.equal(back.update.nonce, u.update.nonce);
  assert.equal(back.update.partyABalance, u.update.partyABalance);
  assert.deepEqual(back.update.stateHash, u.update.stateHash);
  assert.deepEqual(back.sigA, u.sigA);
  assert.deepEqual(back.sigB, u.sigB);
});

test("writes are coalesced; flush forces one setItem; read round-trips; index + TTL", () => {
  const ls = (globalThis as Record<string, unknown>).localStorage as FakeStorage;
  let sets = 0;
  const realSet = ls.setItem.bind(ls);
  ls.setItem = (k: string, v: string) => { sets++; realSet(k, v); };

  const rec = (tunnelId: string, updatedAt: number) => ({
    matchId: "m", tunnelId, role: "A" as const, game: "ttt",
    opponentWallet: "0xb", opponentPubkeyHex: "ab",
    latestCoSigned: toWireCoSigned(sampleCoSigned(tunnelId)),
    latestState: { board: [0], balanceA: 1000n, balanceB: 1000n },
    updatedAt,
  });
  writeResumeRecord(rec("0xT1", 100));
  writeResumeRecord(rec("0xT1", 200)); // same tunnel, coalesced
  const before = sets;
  flushResumeWrites();
  assert.ok(sets > before, "flush performed the deferred write");

  const got = readResumeRecord("0xT1");
  assert.equal(got?.latestState && (got.latestState as { balanceA: bigint }).balanceA, 1000n);
  assert.deepEqual(listActiveTunnels(), ["0xT1"]);

  writeResumeRecord(rec("0xT2", 1)); flushResumeWrites();
  evictExpiredRecords(0); // everything is "older than 0ms"
  assert.equal(readResumeRecord("0xT1"), null);
  assert.deepEqual(listActiveTunnels(), []);

  clearResumeRecord("0xT2");
});

// --- tiny fixtures local to the test ---
function counterProto() {
  return {
    name: "counter-test",
    initialState: () => ({ count: 0, turn: "A" as const }),
    applyMove: (s: { count: number; turn: "A" | "B" }) => ({ count: s.count + 1, turn: s.turn === "A" ? "B" as const : "A" as const }),
    encodeState: (s: { count: number }) => new Uint8Array([s.count & 0xff]),
    balances: () => ({ a: 1000n, b: 1000n }),
    isTerminal: () => false,
  };
}
function sampleCoSigned(tunnelId: string) {
  const ka = generateKeyPair(), kb = generateKeyPair();
  const sp = OffchainTunnel.selfPlay(counterProto(), tunnelId, ka, kb, "0xA", "0xB", { a: 1000n, b: 1000n });
  sp.step(1, "A");
  return sp.latest!;
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && node --import tsx --test src/pvp/resume.test.ts`
Expected: FAIL — `./resume` does not exist.

- [ ] **Step 3: Implement `resume.ts`**

Create `frontend/src/pvp/resume.ts`:

```ts
/**
 * Reload-grade resume persistence. Each seat persists a compact ResumeRecord per tunnel to
 * localStorage (the same synchronous, reload-surviving home as the ephemeral signer, pvpIdentity).
 * Writes are debounced/coalesced off the move hot path; a synchronous pagehide/visibilitychange
 * flush guarantees durability before a reload. bigints are tagged through a JSON replacer/reviver;
 * the signed wire fields persist as hex / decimal strings so a record reconstructs a settleable
 * CoSignedUpdate. Losing the latest checkpoint to the debounce window is safe — restore lands at
 * most one move behind, which the reconciliation handshake closes.
 */
import { toHex, fromHex } from "sui-tunnel-ts/core/bytes";
import type { CoSignedUpdate } from "sui-tunnel-ts/core/tunnel";
import type { StateUpdate } from "sui-tunnel-ts/core/wire";

export type JsonValue = unknown;

const KEY_PREFIX = "mp_resume.v1:";
const INDEX_KEY = "mp_resume.v1.index";
const DEFAULT_TTL_MS = 6 * 3600_000;

/** localStorage-safe form of a signed StateUpdate (stateHash hex; u64s decimal strings). */
export interface WireStateUpdate {
  tunnelId: string;
  stateHash: string;
  nonce: string;
  timestamp: string;
  partyABalance: string;
  partyBBalance: string;
}
export interface WireCoSigned {
  update: WireStateUpdate;
  sigA: string;
  sigB: string;
}

/** Compact per-tunnel resume state. `latestState`/`pending.move`/`secret` are adapter-serialized. */
export interface ResumeRecord {
  matchId: string;
  tunnelId: string;
  role: "A" | "B";
  game: string;
  opponentWallet: string;
  opponentPubkeyHex: string;
  latestCoSigned: WireCoSigned;
  latestState: JsonValue;
  pending?: { move: JsonValue; timestamp: string };
  secret?: JsonValue;
  updatedAt: number;
}

export function toWireCoSigned(u: CoSignedUpdate): WireCoSigned {
  return {
    update: {
      tunnelId: u.update.tunnelId,
      stateHash: toHex(u.update.stateHash),
      nonce: u.update.nonce.toString(),
      timestamp: u.update.timestamp.toString(),
      partyABalance: u.update.partyABalance.toString(),
      partyBBalance: u.update.partyBBalance.toString(),
    },
    sigA: toHex(u.sigA),
    sigB: toHex(u.sigB),
  };
}
export function fromWireCoSigned(w: WireCoSigned): CoSignedUpdate {
  const update: StateUpdate = {
    tunnelId: w.update.tunnelId,
    stateHash: fromHex(w.update.stateHash),
    nonce: BigInt(w.update.nonce),
    timestamp: BigInt(w.update.timestamp),
    partyABalance: BigInt(w.update.partyABalance),
    partyBBalance: BigInt(w.update.partyBBalance),
  };
  return { update, sigA: fromHex(w.sigA), sigB: fromHex(w.sigB) };
}

const BIGINT_TAG = "__bigint__";
export function stringifyWithBigint(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    typeof val === "bigint" ? { [BIGINT_TAG]: val.toString() } : val,
  );
}
export function parseWithBigint(s: string): unknown {
  return JSON.parse(s, (_k, val) => {
    if (val && typeof val === "object" && typeof (val as Record<string, unknown>)[BIGINT_TAG] === "string") {
      return BigInt((val as Record<string, string>)[BIGINT_TAG]);
    }
    return val;
  });
}

function ls(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}
function readIndex(): string[] {
  const raw = ls()?.getItem(INDEX_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw) as string[]; } catch { return []; }
}
function writeIndex(ids: string[]): void {
  ls()?.setItem(INDEX_KEY, JSON.stringify([...new Set(ids)]));
}

// Debounce: keep the newest record per tunnel dirty; flush coalesces to one write each.
const dirty = new Map<string, ResumeRecord>();
let scheduled = false;

export function writeResumeRecord(r: ResumeRecord): void {
  dirty.set(r.tunnelId, r);
  if (scheduled) return;
  scheduled = true;
  const flush = () => { scheduled = false; flushResumeWrites(); };
  // Coalesce a burst of confirmed moves into one write; microtask if available, else timer.
  if (typeof queueMicrotask === "function") queueMicrotask(flush);
  else setTimeout(flush, 0);
}

export function flushResumeWrites(): void {
  const store = ls();
  if (!store) { dirty.clear(); return; }
  if (dirty.size === 0) return;
  const ids = readIndex();
  for (const [tunnelId, rec] of dirty) {
    store.setItem(KEY_PREFIX + tunnelId, stringifyWithBigint(rec));
    if (!ids.includes(tunnelId)) ids.push(tunnelId);
  }
  writeIndex(ids);
  dirty.clear();
}

export function readResumeRecord(tunnelId: string): ResumeRecord | null {
  const raw = ls()?.getItem(KEY_PREFIX + tunnelId);
  if (!raw) return null;
  try { return parseWithBigint(raw) as ResumeRecord; } catch { return null; }
}

export function clearResumeRecord(tunnelId: string): void {
  dirty.delete(tunnelId);
  ls()?.removeItem(KEY_PREFIX + tunnelId);
  writeIndex(readIndex().filter((id) => id !== tunnelId));
}

export function listActiveTunnels(): string[] {
  return readIndex().filter((id) => ls()?.getItem(KEY_PREFIX + id) != null);
}

export function evictExpiredRecords(maxAgeMs: number = DEFAULT_TTL_MS): void {
  const now = Date.now();
  for (const id of readIndex()) {
    const rec = readResumeRecord(id);
    if (!rec || now - rec.updatedAt >= maxAgeMs) clearResumeRecord(id);
  }
}

let installed = false;
/** Register synchronous flush on tab hide/close. Idempotent; safe to call on app mount. */
export function installResumePersistence(): void {
  if (installed) return;
  const w = (globalThis as { window?: { addEventListener?: (t: string, cb: () => void) => void } }).window;
  if (!w?.addEventListener) return;
  installed = true;
  w.addEventListener("pagehide", flushResumeWrites);
  w.addEventListener("visibilitychange", () => {
    const doc = (globalThis as { document?: { visibilityState?: string } }).document;
    if (doc?.visibilityState === "hidden") flushResumeWrites();
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `cd frontend && node --import tsx --test src/pvp/resume.test.ts` → PASS.
Then: `pnpm -C frontend test` → PASS.

- [ ] **Step 5: Typecheck, format, commit**

Run: `pnpm -C frontend typecheck && pnpm -C frontend format`
```bash
git add frontend/src/pvp/resume.ts frontend/src/pvp/resume.test.ts
git commit -m "feat(pvp): add resume-record persistence"
```

---

### Task 6: Per-game adapters + `resync` handshake + reconciliation wiring

Tie Layers A/B/C together: add the `resync` `PeerMessage` variant, a shared `attachResume` driver + `restoreInto` cold-load helper (so every hook's resume wiring is one call), the `ResumeAdapter` interface, and the four thin per-game adapters. The driver runs the reconciliation handshake (`decideReconcile` → `adoptCheckpoint` / `resendPending` / `propose` / settle) over the peer channel and persists on every confirmed move.

This task has two halves: **6A** the shared driver + integration test (one TDD cycle), **6B** the four per-game adapters wired into their hooks (one TDD cycle each, parallel structure). Blackjack's wiring also migrates `bjRelay → MpClient`.

**Files (6A):**
- Modify: `frontend/src/pvp/mpClient.ts` (add the `resync` `PeerMessage` variant)
- Create: `frontend/src/pvp/resumeSession.ts`
- Test: `frontend/src/pvp/resumeSession.test.ts`

**Files (6B):**
- Create: `…/ticTacToe/app/lib/tttResumeAdapter.ts`, `…/blackjack/app/lib/bjResumeAdapter.ts`, `…/battleship/battleshipResumeAdapter.ts`, `…/quantumPoker/pokerResumeAdapter.ts`
- Modify: the four hooks (wire `attachResume` + cold-load `restoreInto`); `usePvpBlackjack.ts` also swaps `bjRelay → MpClient` (apply the Task 4 mapping)
- Test: `frontend/src/games/battleship/battleshipResumeAdapter.test.ts`

**Interfaces:**
- Consumes: `decideReconcile`, `ResyncView`, `ReconcileAction` (`sui-tunnel-ts/core/reconcile`); `DistributedTunnel`, `TunnelSnapshot`, `CoSignedUpdate` (SDK); `MpClient`, `PvpChannel`, the resume events; `resume.ts` (`ResumeRecord`, `toWireCoSigned`/`fromWireCoSigned`, `writeResumeRecord`, `readResumeRecord`, `listActiveTunnels`).
- Produces:
  - In `mpClient.ts`: `| { t: "resync"; nonce: string; hasPending: boolean; checkpoint?: WireCoSigned; fullState?: JsonValue }` (import `WireCoSigned`/`JsonValue` types from `./resume`).
  - `interface ResumeAdapter<State, Move>` (full-state + optional move/secret serialization + `onReconciled`).
  - `function attachResume<State, Move>(args): () => void` — wires persistence + the resync handshake; returns a detach fn.
  - `function restoreInto<State, Move>(tunnel, record, adapter): void` — cold-load: `adoptCheckpoint` + optional `restoreSecret` + `seatPending` (no send).

- [ ] **Step 1: Write the failing integration + driver test**

Create `frontend/src/pvp/resumeSession.test.ts`. Use the fake-relay pair from Task 4 to run two `MpClient`s, drive a couple of ttt-style counter moves, drop+reload one seat (rebuild its tunnel via `restoreInto` from a persisted record), reconnect, run the handshake, and assert both converge and the next move co-signs.

```ts
import test from "node:test";
import assert from "node:assert/strict";
// localStorage/window fakes must exist before importing resume modules.
(globalThis as Record<string, unknown>).localStorage = new (class { m = new Map<string,string>();
  getItem(k:string){return this.m.has(k)?this.m.get(k)!:null;} setItem(k:string,v:string){this.m.set(k,v);}
  removeItem(k:string){this.m.delete(k);} })();
(globalThis as Record<string, unknown>).window = { addEventListener() {} };

const { decideReconcile } = await import("sui-tunnel-ts/core/reconcile");
const { restoreInto } = await import("./resumeSession");
const { writeResumeRecord, flushResumeWrites, readResumeRecord, toWireCoSigned } = await import("./resume");
const { DistributedTunnel } = await import("sui-tunnel-ts/core/distributedTunnel");
const { makeEndpoint, OffchainTunnel } = await import("sui-tunnel-ts/core/tunnel");
const { defaultBackend } = await import("sui-tunnel-ts/core/crypto-native");
const { generateKeyPair } = await import("sui-tunnel-ts/core/crypto");

const proto = {
  name: "counter-test",
  initialState: () => ({ count: 0, turn: "A" as const }),
  applyMove: (s: { count: number; turn: "A" | "B" }, _m: number, by: "A" | "B") =>
    ({ count: s.count + 1, turn: by === "A" ? "B" as const : "A" as const }),
  encodeState: (s: { count: number }) => new Uint8Array([s.count & 0xff]),
  balances: () => ({ a: 1000n, b: 1000n }),
  isTerminal: () => false,
};
const adapter = {
  serializeState: (s: unknown) => s,
  deserializeState: (j: unknown) => j as { count: number; turn: "A" | "B" },
  onReconciled: () => {},
};

test("restoreInto reconstructs a tunnel that co-signs the next move byte-identically", () => {
  const ka = generateKeyPair(), kb = generateKeyPair();
  const tid = `0x${"41".repeat(32)}`;
  // Self-play to nonce 2 to get a real checkpoint + state.
  const sp = OffchainTunnel.selfPlay(proto as never, tid, ka, kb, "0xA", "0xB", { a: 1000n, b: 1000n });
  sp.step(0, "A"); sp.step(0, "B");
  const record = {
    matchId: "m", tunnelId: tid, role: "A" as const, game: "counter",
    opponentWallet: "0xB", opponentPubkeyHex: "ab",
    latestCoSigned: toWireCoSigned(sp.latest!),
    latestState: adapter.serializeState(sp.state),
    updatedAt: Date.now(),
  };
  writeResumeRecord(record); flushResumeWrites();

  const backend = defaultBackend();
  const sent: Uint8Array[] = [];
  const restored = new DistributedTunnel(
    proto as never,
    { tunnelId: tid,
      self: makeEndpoint(backend, "0xA", { publicKey: ka.publicKey, scheme: 0, secretKey: ka.secretKey }, true),
      opponent: makeEndpoint(backend, "0xB", { publicKey: kb.publicKey, scheme: 0 }, false), selfParty: "A" },
    { send: (b) => sent.push(b), onFrame() {} }, { a: 1000n, b: 1000n },
  );
  restoreInto(restored, readResumeRecord(tid)!, adapter as never);
  assert.equal(restored.nonce, 2n);
  // The restored tunnel proposes move 3 with the exact bytes a never-dropped tunnel would.
  restored.propose(0, 9n);
  assert.equal(restored.nonce, 2n);          // unconfirmed
  assert.ok(sent.length === 1);
});

test("decideReconcile + adopt path: a peer-ahead resync seats the missed move", () => {
  // Drive the same fixtures: self at nonce 1, peer at nonce 2 with a checkpoint+fullState.
  const ka = generateKeyPair(), kb = generateKeyPair();
  const tid = `0x${"42".repeat(32)}`;
  const sp = OffchainTunnel.selfPlay(proto as never, tid, ka, kb, "0xA", "0xB", { a: 1000n, b: 1000n });
  sp.step(0, "A"); // nonce 1 — what self has
  const selfState = sp.state, selfCp = sp.latest!;
  sp.step(0, "B"); // nonce 2 — what peer has
  const peerState = sp.state, peerCp = sp.latest!;

  const self = { nonce: 1n, hasPending: false, checkpoint: selfCp };
  const peer = { nonce: 2n, hasPending: false, checkpoint: peerCp };
  assert.equal(decideReconcile(self, peer).action, "adopt");

  const backend = defaultBackend();
  const t = new DistributedTunnel(
    proto as never,
    { tunnelId: tid,
      self: makeEndpoint(backend, "0xA", { publicKey: ka.publicKey, scheme: 0, secretKey: ka.secretKey }, true),
      opponent: makeEndpoint(backend, "0xB", { publicKey: kb.publicKey, scheme: 0 }, false), selfParty: "A" },
    { send() {}, onFrame() {} }, { a: 1000n, b: 1000n },
  );
  t.adoptCheckpoint(selfState, selfCp);   // self restored at 1
  t.adoptCheckpoint(peerState, peerCp);   // adopt the peer-ahead checkpoint
  assert.equal(t.nonce, 2n);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && node --import tsx --test src/pvp/resumeSession.test.ts`
Expected: FAIL — `./resumeSession` (`restoreInto`) does not exist.

- [ ] **Step 3: Add the `resync` `PeerMessage` variant**

In `mpClient.ts`, import the wire types from `./resume` and add the variant to `PeerMessage`:

```ts
import type { WireCoSigned, JsonValue } from "./resume";
```
```ts
  | {
      t: "resync";
      nonce: string;
      hasPending: boolean;
      checkpoint?: WireCoSigned;
      fullState?: JsonValue;
    }
```

- [ ] **Step 4: Implement `resumeSession.ts`**

Create `frontend/src/pvp/resumeSession.ts`:

```ts
/**
 * Per-game resume driver. One `attachResume` call wires a game's tunnel + channel into:
 *  - debounced persistence on every confirmed move (the resume record), and
 *  - the resume-time reconciliation handshake over the existing peer-message side channel.
 * Games supply only a thin `ResumeAdapter` (full-state (de)serialization, an optional hidden
 * secret the peer can never supply, optional move (de)serialization for codec-based moves, and a
 * re-render hook). Verification + adoption live in the SDK; this module never touches keys or
 * signatures directly.
 */
import type { DistributedTunnel } from "sui-tunnel-ts/core/distributedTunnel";
import type { CoSignedUpdate } from "sui-tunnel-ts/core/tunnel";
import { decideReconcile, ReconcileAction, ResyncView } from "sui-tunnel-ts/core/reconcile";
import type { MpClient, PvpChannel, PeerMessage } from "./mpClient";
import {
  JsonValue, ResumeRecord, fromWireCoSigned, toWireCoSigned, writeResumeRecord,
} from "./resume";

export type ReconcileOutcome = ReconcileAction;

/** A game's thin resume adapter. State (de)serialization is REQUIRED and covers the FULL app
 *  state; `serializeState` MUST exclude any hidden secret (captured separately). Move methods
 *  default to identity (JSON-native moves); secret methods are omitted by games with no secret. */
export interface ResumeAdapter<State, Move> {
  serializeState(s: State): JsonValue;
  deserializeState(j: JsonValue): State;
  serializeMove?(m: Move): JsonValue;
  deserializeMove?(j: JsonValue): Move;
  captureSecret?(): JsonValue;
  restoreSecret?(j: JsonValue): void;
  onReconciled(tunnel: DistributedTunnel<State, Move>, outcome: ReconcileOutcome): void;
}

/** Static record fields the driver cannot derive from the tunnel snapshot. */
export interface ResumeIdentity {
  matchId: string;
  tunnelId: string;
  role: "A" | "B";
  game: string;
  opponentWallet: string;
  opponentPubkeyHex: string;
}

export interface AttachResumeArgs<State, Move> {
  mp: MpClient;
  channel: PvpChannel;
  tunnel: DistributedTunnel<State, Move>;
  adapter: ResumeAdapter<State, Move>;
  identity: ResumeIdentity;
}

/** Build the full ResumeRecord from the live tunnel snapshot + static identity + adapter. */
function buildRecord<State, Move>(
  tunnel: DistributedTunnel<State, Move>,
  adapter: ResumeAdapter<State, Move>,
  identity: ResumeIdentity,
): ResumeRecord | null {
  const snap = tunnel.snapshot();
  if (!snap.latest) return null; // nothing co-signed yet — nothing to resume to
  const serMove = adapter.serializeMove ?? ((m: Move) => m as unknown as JsonValue);
  return {
    ...identity,
    latestCoSigned: toWireCoSigned(snap.latest),
    latestState: adapter.serializeState(snap.state),
    pending: snap.pending
      ? { move: serMove(snap.pending.move), timestamp: snap.pending.timestamp.toString() }
      : undefined,
    secret: adapter.captureSecret ? adapter.captureSecret() : undefined,
    updatedAt: Date.now(),
  };
}

/** Cold-load: seat a freshly-constructed tunnel from a persisted record WITHOUT sending. The
 *  reconciliation handshake decides whether to (re-)send the pending move. */
export function restoreInto<State, Move>(
  tunnel: DistributedTunnel<State, Move>,
  record: ResumeRecord,
  adapter: ResumeAdapter<State, Move>,
): void {
  tunnel.adoptCheckpoint(adapter.deserializeState(record.latestState), fromWireCoSigned(record.latestCoSigned));
  if (record.secret !== undefined && adapter.restoreSecret) adapter.restoreSecret(record.secret);
  if (record.pending) {
    const deMove = adapter.deserializeMove ?? ((j: JsonValue) => j as unknown as Move);
    tunnel.seatPending(deMove(record.pending.move), BigInt(record.pending.timestamp));
  }
}

/** Send THIS seat's resync (latest nonce + pending flag + checkpoint + full state for gap-fill). */
function sendResync<State, Move>(args: AttachResumeArgs<State, Move>): void {
  const snap = args.tunnel.snapshot();
  args.channel.sendPeer({
    t: "resync",
    nonce: snap.nonce.toString(),
    hasPending: snap.pending !== null,
    checkpoint: snap.latest ? toWireCoSigned(snap.latest) : undefined,
    fullState: args.adapter.serializeState(snap.state),
  } as Extract<PeerMessage, { t: "resync" }>);
}

/** React to a peer's resync: decide, then act on the LOCAL tunnel (verify-on-adopt). */
function onResync<State, Move>(
  args: AttachResumeArgs<State, Move>,
  msg: Extract<PeerMessage, { t: "resync" }>,
): void {
  const snap = args.tunnel.snapshot();
  const self: ResyncView = { nonce: snap.nonce, hasPending: snap.pending !== null, checkpoint: snap.latest };
  const peerCp: CoSignedUpdate | null = msg.checkpoint ? fromWireCoSigned(msg.checkpoint) : null;
  const peer: ResyncView = { nonce: BigInt(msg.nonce), hasPending: msg.hasPending, checkpoint: peerCp };
  const { action } = decideReconcile(self, peer);
  try {
    if (action === "adopt" && peerCp && msg.fullState !== undefined) {
      args.tunnel.adoptCheckpoint(args.adapter.deserializeState(msg.fullState), peerCp);
    } else if (action === "re-propose") {
      args.tunnel.resendPending();
    }
    // "wait"/"noop" do nothing; "settle" is surfaced to the game via onReconciled.
    args.adapter.onReconciled(args.tunnel, action);
  } catch {
    // adoptCheckpoint rejected (equivocation / tamper) -> fall through to the settlement floor.
    args.adapter.onReconciled(args.tunnel, "settle");
  }
}

/**
 * Wire persistence + the resync handshake. Persists on every confirmed move (debounced), sends a
 * resync when the peer is reachable (`resume.ok` with peerOnline, or `peer.resumed`), and reacts to
 * the peer's resync. Returns a detach fn (unsubscribes; does not close the socket).
 */
export function attachResume<State, Move>(args: AttachResumeArgs<State, Move>): () => void {
  const { mp, channel, tunnel, identity } = args;

  // Persist on confirm, preserving any game-set onConfirmed.
  const prevConfirmed = tunnel.onConfirmed;
  tunnel.onConfirmed = (u) => {
    prevConfirmed?.(u);
    const rec = buildRecord(tunnel, args.adapter, identity);
    if (rec) writeResumeRecord(rec);
  };

  // Route the peer's resync through the channel's existing onPeer; preserve any prior handler.
  const peerHandler = (m: Exclude<PeerMessage, { t: "frame" }>) => {
    if ((m as { t: string }).t === "resync") onResync(args, m as Extract<PeerMessage, { t: "resync" }>);
  };
  channel.addPeerListener(peerHandler);

  const offOk = mp.onResumeOk((e) => { if (e.matchId === identity.matchId && e.peerOnline) sendResync(args); });
  const offRes = mp.onPeerResumed((e) => { if (e.matchId === identity.matchId) sendResync(args); });

  return () => {
    offOk(); offRes();
    channel.removePeerListener(peerHandler);
    if (tunnel.onConfirmed) tunnel.onConfirmed = prevConfirmed;
  };
}
```

`attachResume` needs the channel to support **multiple** peer listeners (the game's own dispatcher + the resync handler). `MpClient.channel().onPeer` today stores a single callback. Add `addPeerListener`/`removePeerListener` to `PvpChannel` (and keep `onPeer` as the single-listener convenience that calls `addPeerListener`):

In `mpClient.ts`, change `channel()` to keep a `Set` of peer listeners and fan out:

```ts
  channel(matchId: string): PvpChannel {
    this.#activeMatches.add(matchId);
    let engineOnFrame: ((bytes: Uint8Array) => void) | null = null;
    const peerCbs = new Set<(msg: Exclude<PeerMessage, { t: "frame" }>) => void>();
    this.#relayHandlers.set(matchId, (payload) => {
      const o = JSON.parse(payload) as PeerMessage;
      if (o.t === "frame") engineOnFrame?.(te.encode(o.data));
      else peerCbs.forEach((cb) => cb(o));
    });
    const relaySend = (obj: PeerMessage) =>
      this.#send({ type: "relay", matchId, payload: JSON.stringify(obj) });
    return {
      transport: {
        send: (bytes) => this.#send({ type: "relay", matchId, payload: wrapInnerFrameJson(new TextDecoder().decode(bytes)) }),
        onFrame: (cb) => { engineOnFrame = cb; },
      },
      sendPeer: (msg) => relaySend(msg),
      onPeer: (cb) => { peerCbs.clear(); peerCbs.add(cb); },
      addPeerListener: (cb) => { peerCbs.add(cb); },
      removePeerListener: (cb) => { peerCbs.delete(cb); },
    };
  }
```
and extend the `PvpChannel` interface with `addPeerListener`/`removePeerListener`.

- [ ] **Step 5: Run the integration test + suite**

Run: `cd frontend && node --import tsx --test src/pvp/resumeSession.test.ts` → PASS.
Then: `pnpm -C frontend test` → PASS.

- [ ] **Step 6: Typecheck, format, commit (6A)**

Run: `pnpm -C frontend typecheck && pnpm -C frontend format`
```bash
git add frontend/src/pvp/mpClient.ts frontend/src/pvp/resumeSession.ts frontend/src/pvp/resumeSession.test.ts
git commit -m "feat(pvp): add resync handshake driver"
```

#### 6B: the four per-game adapters + hook wiring

Each adapter is a small module; each hook gains the same three wirings: (1) on cold mount, `evictExpiredRecords()` + for each `listActiveTunnels()` belonging to this game, rebuild the tunnel and `restoreInto`; (2) after building the live tunnel, `attachResume({ mp, channel, tunnel, adapter, identity })`; (3) `installResumePersistence()` once. The adapters differ only in state shape and secret.

State serialization for every game is **full-state JSON** (bigints handled by `resume.ts`'s `stringifyWithBigint`). `serializeState` is a plain structural copy; `deserializeState` rebuilds the typed state. The adapter MUST exclude the hidden secret from `serializeState` (battleship fleet, poker slot secrets/hole cards) and round-trip it only via `captureSecret`/`restoreSecret`.

- [ ] **Step 1: Write the failing battleship secret test**

Create `frontend/src/games/battleship/battleshipResumeAdapter.test.ts`. Assert the fleet secret is restored locally and **never** appears in a `resync` payload (the canonical reason local-authoritative was chosen).

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { makeBattleshipResumeAdapter } from "./battleshipResumeAdapter";
import { randomFleetSecret } from "./engine/selfPlay";

test("the fleet secret round-trips locally and never enters a resync/serializeState payload", () => {
  let stored: unknown = null;
  const secret = randomFleetSecret(() => 0.5);
  const adapter = makeBattleshipResumeAdapter({
    getSecret: () => secret,
    setSecret: (s) => { stored = s; },
  });
  // A representative public state (no fleet).
  const state = {
    phase: "playing", turn: "A", pendingShot: null, commitA: null, commitB: null,
    shotsAtA: [], shotsAtB: [], hitsOnA: 0, hitsOnB: 0, winner: 0,
    balanceA: 500n, balanceB: 500n, total: 1000n, stake: 100n,
  };
  const serialized = adapter.serializeState(state as never);
  const blob = JSON.stringify(serialized, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  // No fleet cell / salt leaks into the wire-bound state.
  for (const cell of secret.placements ?? []) {
    assert.ok(!blob.includes(String(cell)), "fleet placement leaked into serializeState");
  }
  // captureSecret is the ONLY carrier of the secret; restoreSecret round-trips it.
  const cap = adapter.captureSecret!();
  adapter.restoreSecret!(cap);
  assert.deepEqual(stored, secret);
});
```

(Adjust the `secret.placements` field name to the actual `FleetSecret` shape in `battleship/engine/selfPlay.ts`; the assertion intent is "no fleet bytes in `serializeState` output".)

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && node --import tsx --test src/games/battleship/battleshipResumeAdapter.test.ts`
Expected: FAIL — `./battleshipResumeAdapter` does not exist.

- [ ] **Step 3: Implement the four adapter modules**

`frontend/src/games/ticTacToe/app/lib/tttResumeAdapter.ts` — full public state, no secret, JSON-native move (`{cell}`):
```ts
import type { ResumeAdapter } from "@/pvp/resumeSession";
// AnyState/CellMove mirror the hook's tunnel generics (board/turn/winner/balances + gamesPlayed).
export function makeTttResumeAdapter<AnyState, CellMove>(
  onReconciled: ResumeAdapter<AnyState, CellMove>["onReconciled"],
): ResumeAdapter<AnyState, CellMove> {
  return {
    serializeState: (s) => s as unknown as never,           // plain JSON (bigint balances via resume.ts)
    deserializeState: (j) => j as AnyState,
    // move is JSON-native ({cell}); identity move (de)serialization is the default
    onReconciled,
  };
}
```

`frontend/src/games/blackjack/app/lib/bjResumeAdapter.ts` — full `BetBlackjackState`, no secret, JSON-native move:
```ts
import type { ResumeAdapter } from "@/pvp/resumeSession";
import type { BetBlackjackState, BlackjackMove } from "./bjBetProtocol"; // adjust import to the actual path
export function makeBlackjackResumeAdapter(
  onReconciled: ResumeAdapter<BetBlackjackState, BlackjackMove>["onReconciled"],
): ResumeAdapter<BetBlackjackState, BlackjackMove> {
  return {
    serializeState: (s) => ({ ...s }) as unknown as never,  // numeric arrays + bigint balances
    deserializeState: (j) => j as BetBlackjackState,
    onReconciled,
  };
}
```

`frontend/src/games/battleship/battleshipResumeAdapter.ts` — public state + **fleet secret** via capture/restore + binary move codec:
```ts
import type { ResumeAdapter } from "@/pvp/resumeSession";
import { battleshipMoveCodec, type BattleshipState, type BattleshipMove } from "./protocol";
import type { FleetSecret } from "./engine/selfPlay";

export function makeBattleshipResumeAdapter(args: {
  getSecret: () => FleetSecret;
  setSecret: (s: FleetSecret) => void;
  onReconciled?: ResumeAdapter<BattleshipState, BattleshipMove>["onReconciled"];
}): ResumeAdapter<BattleshipState, BattleshipMove> {
  return {
    // serializeState carries ONLY public state. commits are Uint8Array → hex-able plain arrays.
    serializeState: (s) => ({
      ...s,
      commitA: s.commitA ? Array.from(s.commitA) : null,
      commitB: s.commitB ? Array.from(s.commitB) : null,
    }) as unknown as never,
    deserializeState: (j) => {
      const o = j as Record<string, unknown>;
      return {
        ...(o as object),
        commitA: o.commitA ? Uint8Array.from(o.commitA as number[]) : null,
        commitB: o.commitB ? Uint8Array.from(o.commitB as number[]) : null,
      } as BattleshipState;
    },
    serializeMove: (m) => battleshipMoveCodec.encode(m) as never,
    deserializeMove: (j) => battleshipMoveCodec.decode(j),
    captureSecret: () => args.getSecret() as unknown as never, // fleet — NEVER in serializeState
    restoreSecret: (j) => args.setSecret(j as FleetSecret),
    onReconciled: args.onReconciled ?? (() => {}),
  };
}
```

`frontend/src/games/quantumPoker/pokerResumeAdapter.ts` — public state + **slot-secret/hole-card** via capture/restore + poker move codec. `serializeState` strips the local-only fields (`localSecretsA/B`, `holeA/B`):
```ts
import type { ResumeAdapter } from "@/pvp/resumeSession";
import { pokerMoveCodec, type PokerState, type PokerMove } from "./protocol"; // adjust to actual path

type PokerSecret = { localSecretsA: unknown; localSecretsB: unknown; holeA: unknown; holeB: unknown };

export function makePokerResumeAdapter(args: {
  getSecret: () => PokerSecret;
  setSecret: (s: PokerSecret) => void;
  onReconciled?: ResumeAdapter<PokerState, PokerMove>["onReconciled"];
}): ResumeAdapter<PokerState, PokerMove> {
  return {
    serializeState: (s) => {
      // Drop local-only secret fields; encode Uint8Array commit/reveal arrays as plain arrays.
      const { localSecretsA: _a, localSecretsB: _b, holeA: _ha, holeB: _hb, ...pub } = s as never;
      return JSON.parse(JSON.stringify(pub, (_k, v) => (v instanceof Uint8Array ? Array.from(v) : v))) as never;
    },
    deserializeState: (j) => j as PokerState, // hook re-hydrates Uint8Arrays where the protocol needs them
    serializeMove: (m) => pokerMoveCodec.encode(m) as never,
    deserializeMove: (j) => pokerMoveCodec.decode(j),
    captureSecret: () => args.getSecret() as unknown as never,
    restoreSecret: (j) => args.setSecret(j as PokerSecret),
    onReconciled: args.onReconciled ?? (() => {}),
  };
}
```

(For battleship/poker, confirm the exact `FleetSecret` / slot-secret shapes and the codec export paths in their files; the adapter's contract is fixed — public state in `serializeState`, secret only in `captureSecret`/`restoreSecret`.)

- [ ] **Step 4: Wire each hook (ttt, blackjack, battleship, poker)**

In each hook, after the live `DistributedTunnel` is constructed and the channel is available, add the three wirings. ttt/blackjack: `onReconciled` calls the hook's existing re-render (`onAdvance`/`sync`). For blackjack, ALSO apply the Task 4 `bjRelay → MpClient` mapping first.

Concrete shape (battleship shown; the others are identical minus the secret args):
```ts
import { attachResume, restoreInto } from "@/pvp/resumeSession";
import {
  installResumePersistence, listActiveTunnels, readResumeRecord, evictExpiredRecords,
} from "@/pvp/resume";
import { makeBattleshipResumeAdapter } from "./battleshipResumeAdapter";

// once, on mount:
installResumePersistence();
evictExpiredRecords();

// after building `dt` (the live DistributedTunnel) and `channel`:
const adapter = makeBattleshipResumeAdapter({
  getSecret: () => secretRef.current!,
  setSecret: (s) => { secretRef.current = s; },
  onReconciled: () => this.sync(),
});
const detach = attachResume({
  mp, channel, tunnel: dt, adapter,
  identity: {
    matchId: match.matchId, tunnelId, role: match.role, game: "battleship",
    opponentWallet: match.opponentWallet, opponentPubkeyHex: toHex(opp.publicKey),
  },
});
// call detach() on match teardown (alongside mp.releaseMatch(matchId)).

// COLD-LOAD restore (on mount, before queueing a fresh match): for each persisted tunnel of THIS
// game, rebuild the tunnel and restoreInto, then let the reconnect loop `resume` it.
for (const tunnelId of listActiveTunnels()) {
  const rec = readResumeRecord(tunnelId);
  if (!rec || rec.game !== "battleship") continue;
  const restored = new DistributedTunnel(proto, cfgFromRecord(rec), channelFor(rec.matchId).transport, BALANCES);
  restoreInto(restored, rec, makeBattleshipResumeAdapter({ getSecret, setSecret }));
  mp.markActive(rec.matchId);
  attachResume({ mp, channel: channelFor(rec.matchId), tunnel: restored, adapter, identity: identityFromRecord(rec) });
}
```

The cold-load path reuses the hook's existing tunnel-construction code (`cfgFromRecord` = the same `self`/`opponent`/`selfParty` the hook already builds from the match + ephemeral key + persisted `opponentPubkeyHex`). The reconnect loop (Task 3) then issues `resume { matchId }`; `attachResume` sends/handles the `resync` once `resume.ok(peerOnline)`/`peer.resumed` arrives.

- [ ] **Step 5: Run battleship test + suite + typecheck**

Run: `cd frontend && node --import tsx --test src/games/battleship/battleshipResumeAdapter.test.ts` → PASS.
Run: `pnpm -C frontend typecheck` → PASS (all four hooks compile against the adapter + driver).
Run: `pnpm -C frontend test` → PASS.

- [ ] **Step 6: Format, commit (6B)**

Run: `pnpm -C frontend format`
```bash
git add frontend/src/games/ticTacToe/app/lib/tttResumeAdapter.ts \
  frontend/src/games/blackjack/app/lib/bjResumeAdapter.ts \
  frontend/src/games/blackjack/app/hooks/usePvpBlackjack.ts \
  frontend/src/games/battleship/battleshipResumeAdapter.ts \
  frontend/src/games/battleship/battleshipResumeAdapter.test.ts \
  frontend/src/games/battleship/useBattleshipPvp.ts \
  frontend/src/games/quantumPoker/pokerResumeAdapter.ts \
  frontend/src/games/quantumPoker/usePvpQuantumPoker.ts \
  frontend/src/games/ticTacToe/app/hooks/usePvpTicTacToe.ts
git commit -m "feat(pvp): add per-game resume adapters"
```

---

### Task 7: Settlement floor — unilateral settle + 60s grace timer

When the peer never returns (or equivocates), the present seat settles on-chain from the last co-signed checkpoint it holds. Surface the SDK's existing unilateral `raise_dispute` → `force_close` builders in `frontend/src/onchain/tunnelTx.ts` (today wires cooperative close only), and add the 60s FE grace timer to `attachResume` so `peer.dropped` → grace → settle offer.

**Files:**
- Modify: `frontend/src/onchain/tunnelTx.ts` (add `raiseDisputeUnilateral` + `forceCloseAfterTimeout`)
- Modify: `frontend/src/pvp/resumeSession.ts` (grace timer in `attachResume`)
- Test: `frontend/src/pvp/resumeSession.test.ts` (extend — grace-timer unit with injected timers)

**Interfaces:**
- Consumes: `buildRaiseDisputeFromUpdate`, `buildForceClose` (`sui-tunnel-ts/onchain/txbuilders`); `CoSignedUpdate`, `Party`; `SignExec`; `MpClient.onPeerDropped`/`onResumeOk`/`onPeerResumed`.
- Produces:
  - `raiseDisputeUnilateral(opts: { signExec: SignExec; tunnelId: string; update: CoSignedUpdate; role: Party }): Promise<string>` — stakes the both-signed latest state on-chain (opens the dispute/timeout window).
  - `forceCloseAfterTimeout(opts: { signExec: SignExec; tunnelId: string }): Promise<string>` — finalizes after the on-chain `timeout_ms` (24h), paying out the staked split.
  - `attachResume` gains `graceMs?` (default `60_000`) + `onGraceExpired?: (latest: CoSignedUpdate | null) => void`; the timer starts on `peer.dropped`, cancels on `resume.ok(peerOnline)`/`peer.resumed`.

- [ ] **Step 1: Write the failing grace-timer test**

Append to `frontend/src/pvp/resumeSession.test.ts`. Inject a fake `setTimeout`/`clearTimeout` and a minimal fake `MpClient` exposing the three event subscriptions, then assert grace fires only when no peer return arrives.

```ts
test("peer.dropped starts a grace timer; peer return cancels it; expiry offers settle", async () => {
  const { attachResume } = await import("./resumeSession");
  // Minimal fake MpClient: capture subscribers, expose triggers.
  const subs: Record<string, ((e: { matchId: string; peerOnline?: boolean }) => void)[]> = { drop: [], ok: [], res: [] };
  const fakeMp = {
    onPeerDropped: (cb: never) => { subs.drop.push(cb as never); return () => {}; },
    onResumeOk: (cb: never) => { subs.ok.push(cb as never); return () => {}; },
    onPeerResumed: (cb: never) => { subs.res.push(cb as never); return () => {}; },
  };
  const channel = { addPeerListener() {}, removePeerListener() {}, sendPeer() {}, transport: { send() {}, onFrame() {} }, onPeer() {} };
  let fire: (() => void) | null = null;
  const sched = { set: (fn: () => void) => { fire = fn; return 1 as never; }, clear: () => { fire = null; } };

  // No latest yet → onGraceExpired receives null but still fires.
  const tunnel = { snapshot: () => ({ state: {}, nonce: 0n, latest: null, pending: null }), onConfirmed: undefined } as never;
  let expired: unknown = "unset";
  attachResume({
    mp: fakeMp as never, channel: channel as never, tunnel,
    adapter: { serializeState: (s: unknown) => s, deserializeState: (j: unknown) => j, onReconciled() {} } as never,
    identity: { matchId: "m1", tunnelId: "0xT", role: "A", game: "g", opponentWallet: "0xb", opponentPubkeyHex: "ab" },
    graceMs: 60_000, onGraceExpired: (l) => { expired = l; },
    timers: { setTimeout: sched.set as never, clearTimeout: sched.clear as never },
  } as never);

  // peer drops → timer armed
  subs.drop.forEach((cb) => cb({ matchId: "m1" }));
  assert.ok(fire, "grace timer armed on peer.dropped");
  // peer returns before expiry → timer cancelled, no settle offer
  subs.res.forEach((cb) => cb({ matchId: "m1" }));
  assert.equal(fire, null, "grace timer cancelled on peer return");
  assert.equal(expired, "unset");

  // drop again, then let it expire
  subs.drop.forEach((cb) => cb({ matchId: "m1" }));
  fire!();
  assert.equal(expired, null, "grace expiry offered settle from the held checkpoint (null here)");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd frontend && node --import tsx --test --test-name-pattern "grace timer" src/pvp/resumeSession.test.ts`
Expected: FAIL — `attachResume` ignores `peer.dropped`/`graceMs`/`onGraceExpired`/`timers`.

- [ ] **Step 3: Add the grace timer to `attachResume`**

Extend `AttachResumeArgs` and `attachResume` in `resumeSession.ts`:

```ts
export interface AttachResumeArgs<State, Move> {
  mp: MpClient;
  channel: PvpChannel;
  tunnel: DistributedTunnel<State, Move>;
  adapter: ResumeAdapter<State, Move>;
  identity: ResumeIdentity;
  graceMs?: number;
  onGraceExpired?: (latest: CoSignedUpdate | null) => void;
  /** Injectable for tests; defaults to the globals. */
  timers?: { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (h: unknown) => void };
}
```

Inside `attachResume`, after the existing subscriptions, add:

```ts
  const graceMs = args.graceMs ?? 60_000;
  const timers = args.timers ?? { setTimeout, clearTimeout };
  let graceHandle: unknown = null;
  const cancelGrace = () => { if (graceHandle != null) { timers.clearTimeout(graceHandle); graceHandle = null; } };

  const offDrop = mp.onPeerDropped((e) => {
    if (e.matchId !== identity.matchId) return;
    cancelGrace();
    graceHandle = timers.setTimeout(() => {
      graceHandle = null;
      args.onGraceExpired?.(tunnel.snapshot().latest);
    }, graceMs);
  });
  // a peer return cancels the grace timer (handshake handles convergence instead)
  const offOkCancel = mp.onResumeOk((e) => { if (e.matchId === identity.matchId && e.peerOnline) cancelGrace(); });
  const offResCancel = mp.onPeerResumed((e) => { if (e.matchId === identity.matchId) cancelGrace(); });
```

Add `offDrop(); offOkCancel(); offResCancel(); cancelGrace();` to the returned detach fn.

- [ ] **Step 4: Surface the unilateral builders in `tunnelTx.ts`**

In `frontend/src/onchain/tunnelTx.ts`, add the SDK imports + casts (mirroring the existing `buildCloseFromSettlement` cast pattern) and the two functions:

```ts
import {
  buildRaiseDisputeFromUpdate as sdkRaiseDisputeFromUpdate,
  buildForceClose as sdkForceClose,
} from "sui-tunnel-ts/onchain/txbuilders";
import type { CoSignedUpdate } from "sui-tunnel-ts/core/tunnel";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";

const buildRaiseDisputeFromUpdate = sdkRaiseDisputeFromUpdate as unknown as (
  tx: Transaction, tunnelId: string, u: CoSignedUpdate, raiser: Party,
) => void;
const buildForceClose = sdkForceClose as unknown as (
  tx: Transaction, p: { tunnelId: string },
) => void;

/**
 * Unilateral settlement floor, step 1: stake the latest BOTH-signed checkpoint on-chain via
 * `raise_dispute`, opening the on-chain timeout window. Used when the peer is gone and a fresh
 * cooperative co-signature is unavailable. `force_close` finalizes after `timeout_ms` (24h).
 */
export async function raiseDisputeUnilateral(opts: {
  signExec: SignExec;
  tunnelId: string;
  update: CoSignedUpdate;
  role: Party;
}): Promise<string> {
  const tx = new Transaction();
  buildRaiseDisputeFromUpdate(tx, opts.tunnelId, opts.update, opts.role);
  const { digest } = await opts.signExec(tx);
  return digest;
}

/** Unilateral settlement floor, step 2: finalize the staked dispute after the on-chain timeout. */
export async function forceCloseAfterTimeout(opts: {
  signExec: SignExec;
  tunnelId: string;
}): Promise<string> {
  const tx = new Transaction();
  buildForceClose(tx, { tunnelId: opts.tunnelId });
  const { digest } = await opts.signExec(tx);
  return digest;
}
```

- [ ] **Step 5: Wire `onGraceExpired` in the hooks (settle offer)**

In each hook's `attachResume({ … })` call, pass `onGraceExpired: (latest) => { /* surface "opponent gone — settle?" UI; on confirm: */ if (latest) void raiseDisputeUnilateral({ signExec, tunnelId, update: latest, role }); }`. The same path serves equivocation (the driver's `onReconciled(tunnel, "settle")` surfaces the identical offer). Submitting `force_close` is a follow-up the user triggers after the 24h on-chain window; surface it as a separate action that calls `forceCloseAfterTimeout({ signExec, tunnelId })`. (No new dispute logic — these are thin wrappers over the existing SDK builders.)

- [ ] **Step 6: Run the grace test + suite + typecheck**

Run: `cd frontend && node --import tsx --test src/pvp/resumeSession.test.ts` → PASS.
Run: `pnpm -C frontend typecheck` → PASS.
Run: `pnpm -C frontend test` → PASS.

- [ ] **Step 7: Format, commit**

Run: `pnpm -C frontend format`
```bash
git add frontend/src/onchain/tunnelTx.ts frontend/src/pvp/resumeSession.ts frontend/src/pvp/resumeSession.test.ts \
  frontend/src/games/ticTacToe/app/hooks/usePvpTicTacToe.ts \
  frontend/src/games/blackjack/app/hooks/usePvpBlackjack.ts \
  frontend/src/games/battleship/useBattleshipPvp.ts \
  frontend/src/games/quantumPoker/usePvpQuantumPoker.ts
git commit -m "feat(pvp): surface unilateral settle and grace timer"
```

---

## Final verification

- [ ] **SDK suite green:** `pnpm -C sui-tunnel-ts test` — all `node:test` units pass, including the new `adoptCheckpoint`/`snapshot`/`seatPending`/`resendPending` and `decideReconcile` tests; existing `propose`/`onMove`/`onAck` tests unchanged (the MOVE frame is byte-identical).
- [ ] **Frontend suite green:** `pnpm -C frontend test` — the new `src/pvp/**` tests run alongside the existing suites (the glob was extended in Task 3).
- [ ] **Typecheck clean:** `pnpm -C sui-tunnel-ts typecheck` and `pnpm -C frontend typecheck`.
- [ ] **Format clean:** `pnpm -C frontend format` and `pnpm -C sui-tunnel-ts exec prettier --check "src/core/*.ts"` (or `--write`).
- [ ] **Hot path unchanged:** `git diff main -- sui-tunnel-ts/src/core/distributedTunnel.ts` shows only additive methods + the `propose`→`seatPending` refactor (same emitted frame). No per-move signature verification, Redis, or on-chain op was added — verification is confined to `adoptCheckpoint` (resume-time) and the only per-move addition is the debounced resume-record write.
- [ ] **Opaque relay unchanged:** the relay still forwards `{type:"relay", matchId, payload}` blindly; reconciliation rides `{t:"resync"}` inside the existing peer payload — no new server message type.
- [ ] **`RelayClient` kept, deprecated:** both `pvpRelay.ts` files still exist and carry the `@deprecated` doc; ttt/caro (and blackjack) no longer import them at runtime.
- [ ] **Battleship secret invariant:** `battleshipResumeAdapter.test.ts` asserts the fleet never appears in `serializeState`/`resync` output.

## Self-review notes (spec coverage)

- **Layer A — `adoptCheckpoint` + `snapshot`** → Task 1 (plus `seatPending`/`resendPending`, the deterministic re-send primitives the "decide before touching transport" rule requires). **Generic `reconcile` engine + decision table** → Task 2.
- **Layer B — reconnect loop (backoff+jitter), `resume`/`queue.join` on reconnect, `resume.ok`/`peer.resumed`/`peer.dropped` typed events, active-match registry, survive relay-handler re-bind** → Task 3. **ttt/caro migration onto MpClient + `@deprecated` RelayClient + frame-envelope parity** → Task 4.
- **Layer C — persistence helper (`ResumeRecord`, debounced write, `pagehide` flush, bigint replacer/reviver, cold-load restore, active-tunnel index, 6h TTL eviction)** → Task 5. **Per-game adapters (ttt/caro, blackjack, battleship-with-fleet-secret, quantum poker) + `resync` PeerMessage variant + reconciliation handshake** → Task 6.
- **Settlement floor — surface unilateral `raise_dispute`/`force_close` in `tunnelTx.ts`; wire 60s grace timer to `peer.dropped`; equivocation falls through the same path** → Task 7.
- **Performance invariants** (zero per-move sig verify beyond `onMove`/`onAck`, zero per-move Redis/on-chain, opaque byte-identical relay, no new server messages, sig verify at resume only) → enforced by the design and checked in Final Verification.
- **Open items** (timeout 24h ≥ 60s; `raise_dispute`→`force_close` from a `CoSignedUpdate`; encodeState treated as one-way so adapters own (de)serialization; helper module split) → resolved in the front-matter and grounded in code.
- **Testing strategy** maps: SDK units (Tasks 1–2), persistence + restore units (Task 5), MpClient reconnect units (Task 3), cross-client drop→reconnect→reconcile integration (Task 6A), battleship secret test (Task 6B), ttt frame-envelope parity (Task 4), grace-timer unit (Task 7).
- **Discrepancies surfaced:** blackjack is on `bjRelay` (not `MpClient`) → migrated in Task 6B; frontend tests are `node:test` (not bun) → `src/pvp` glob added in Task 3.
