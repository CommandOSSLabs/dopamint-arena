# Bomb It & Chicken Cross — PvP match-resume port

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Bring bomb-it and chicken-cross PvP to full parity with PR #39's match-resume protocol (warm reconnect + cold page-reload rejoin + 1h grace-settle), matching the pattern every other PvP game (battleship/blackjack/ttt/poker) already uses.

**Architecture:** Mirror `frontend/src/games/battleship/useBattleshipPvp.ts` — an out-of-React `PvpSession` keyed by `windowId` (so a minimized window stays connected), wired to the shared resume infra (`attachResume`, `resumeActiveTunnels`) via a thin per-game `ResumeAdapter`. Our two games are SIMPLER than battleship: JSON-native moves (no `moveCodec`), no hidden secret (public symmetric field, ADR-0010 → no `captureSecret`/`restoreSecret`). The only adapter work is bigint/Uint8Array (de)serialization. The existing matchmaking + `settle()` + per-tick propose loop are preserved; they move inside the `PvpSession` skeleton.

**Tech Stack:** TypeScript, React (`useSyncExternalStore`), `node:test` via `tsx`, pnpm, Vite. `#39` is already merged (`cb4e7b5`).

## Global Constraints

- `origin/dev` (incl. #39) is already merged into `feat/bomb-it-pvp` at `cb4e7b5`. Do NOT re-merge.
- Reference to mirror (read it, do not edit it): `frontend/src/games/battleship/useBattleshipPvp.ts`, `battleshipResumeAdapter.ts`, `battleshipColdLoad.test.ts`.
- Shared resume infra (consume, do not edit): `frontend/src/pvp/resumeSession.ts` (`attachResume`, `resumeActiveTunnels`, `restoreInto`, `rebuildTunnel`, `ResumeAdapter`, `ResumeIdentity`), `frontend/src/pvp/resume.ts` (`installResumePersistence`, `evictExpiredRecords`, `readResumeRecord`, `listActiveTunnels`, `writeResumeRecord`, `flushResumeWrites`, `clearResumeRecord`, `toWireCoSigned`).
- Import discipline (frontend `*.test.ts` run under tsx): runtime SDK imports use RELATIVE `.ts` paths (`../../../../sui-tunnel-ts/src/...`), never the bare `sui-tunnel-ts/...` specifier. Hooks/components (Vite-bundled) use the bare specifier and the `@/` alias.
- `windowId` already exists on `GameWindowProps` (`frontend/src/games/types.ts`).
- Our moves are JSON-native: `BombItMove = { a?, b? }`, `CrossMove = { dirA?, dirB? }` — no `moveCodec`, no `serializeMove`/`deserializeMove` (identity defaults).
- Our games have NO hidden secret — omit `captureSecret`/`restoreSecret`.
- Conventional Commits, subject ≤ 50 chars, imperative, lowercase after type, no trailing period. NO AI attribution / no Co-Authored-By. One logical change per commit.
- Gate (frontend): `pnpm typecheck` + `pnpm build`; tests via `node --import tsx --test <file>`.

---

### Task 1: Chicken Cross resume adapter

**Files:**
- Create: `frontend/src/games/chickenCross/crossResumeAdapter.ts`
- Test: `frontend/src/games/chickenCross/crossResumeAdapter.test.ts`

**Interfaces:**
- Consumes: `ResumeAdapter` from `@/pvp/resumeSession`; `CrossState`, `CrossMove` from `sui-tunnel-ts/protocol/cross` (test uses the relative `.ts` path).
- Produces: `export function makeCrossResumeAdapter(onReconciled?): ResumeAdapter<CrossState, CrossMove>`.

`CrossState` fields (from `sui-tunnel-ts/src/protocol/cross.ts`): `tick: bigint`, `seed: bigint`, `players: [CrossPlayer, CrossPlayer]` where `CrossPlayer = { lane: number; col: number; score: number; invulnTicks: number }`, `winner: "A"|"B"|null`, `balanceA: bigint`, `balanceB: bigint`, `total: bigint`. Only the five bigints need conversion; players/winner are JSON-native.

- [ ] **Step 1: Write the failing test**

`frontend/src/games/chickenCross/crossResumeAdapter.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { makeCrossResumeAdapter } from "./crossResumeAdapter.ts";
import { CrossProtocol } from "../../../../sui-tunnel-ts/src/protocol/cross.ts";

test("serializeState round-trips through JSON and restores bigints", () => {
  const proto = new CrossProtocol();
  const s0 = proto.initialState({ tunnelId: "0xfeed", initialBalances: { a: 500n, b: 500n } });
  const s1 = proto.applyMove(s0, { dirA: "north" }, "A"); // tick=1n, a real bigint state
  const adapter = makeCrossResumeAdapter();
  const json = JSON.parse(JSON.stringify(adapter.serializeState(s1))); // must be JSON-safe
  const back = adapter.deserializeState(json);
  assert.equal(back.tick, s1.tick);
  assert.equal(back.seed, s1.seed);
  assert.equal(back.balanceA, s1.balanceA);
  assert.equal(back.balanceB, s1.balanceB);
  assert.equal(back.total, s1.total);
  assert.equal(typeof back.tick, "bigint");
  assert.deepEqual(back.players, s1.players);
  assert.equal(back.winner, s1.winner);
});

test("serializeState emits no bigint values (localStorage-safe)", () => {
  const proto = new CrossProtocol();
  const s = proto.initialState({ tunnelId: "0xabc", initialBalances: { a: 500n, b: 500n } });
  const j = makeCrossResumeAdapter().serializeState(s) as Record<string, unknown>;
  for (const k of ["tick", "seed", "balanceA", "balanceB", "total"])
    assert.equal(typeof j[k], "string", `${k} must serialize to string`);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && node --import tsx --test "src/games/chickenCross/crossResumeAdapter.test.ts"`
Expected: FAIL — `makeCrossResumeAdapter` not found / module missing.

- [ ] **Step 3: Implement the adapter**

`frontend/src/games/chickenCross/crossResumeAdapter.ts`:

```ts
/**
 * Chicken Cross resume adapter. The state is fully public (no hidden secret — ADR-0010) and moves
 * are JSON-native ({ dirA?, dirB? }), so the only work is bigint (de)serialization: localStorage
 * can't hold bigints, so the five bigint fields round-trip as decimal strings. players/winner are
 * already JSON-native and pass through unchanged.
 */
import type { ResumeAdapter } from "@/pvp/resumeSession";
import type { JsonValue } from "@/pvp/resume";
import type { CrossState, CrossMove } from "sui-tunnel-ts/protocol/cross";

export function makeCrossResumeAdapter(
  onReconciled?: ResumeAdapter<CrossState, CrossMove>["onReconciled"],
): ResumeAdapter<CrossState, CrossMove> {
  return {
    serializeState: (s) =>
      ({
        tick: s.tick.toString(),
        seed: s.seed.toString(),
        players: s.players,
        winner: s.winner,
        balanceA: s.balanceA.toString(),
        balanceB: s.balanceB.toString(),
        total: s.total.toString(),
      }) as unknown as JsonValue,
    deserializeState: (j) => {
      const o = j as Record<string, unknown>;
      return {
        tick: BigInt(o.tick as string),
        seed: BigInt(o.seed as string),
        players: o.players as CrossState["players"],
        winner: o.winner as CrossState["winner"],
        balanceA: BigInt(o.balanceA as string),
        balanceB: BigInt(o.balanceB as string),
        total: BigInt(o.total as string),
      };
    },
    onReconciled: onReconciled ?? (() => {}),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && node --import tsx --test "src/games/chickenCross/crossResumeAdapter.test.ts"`
Expected: PASS — 2/2, pristine.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/chickenCross/crossResumeAdapter.ts frontend/src/games/chickenCross/crossResumeAdapter.test.ts
git commit -m "feat(cross): pvp resume adapter"
```

---

### Task 2: Bomb It resume adapter

**Files:**
- Create: `frontend/src/games/bombIt/bombItResumeAdapter.ts`
- Test: `frontend/src/games/bombIt/bombItResumeAdapter.test.ts`

**Interfaces:**
- Produces: `export function makeBombItResumeAdapter(onReconciled?): ResumeAdapter<BombItState, BombItMove>`.

`BombItState` fields (from `sui-tunnel-ts/src/protocol/bombIt.ts`): `tick: bigint`, `seed: bigint`, `grid: Uint8Array`, `players: [BombItPlayer, BombItPlayer]` (`{ row, col, alive }` — JSON-native), `bombs: BombItBomb[]` (`{ row, col, fuse, owner }` — JSON-native), `winner: "A"|"B"|"draw"|null`, `balanceA/B/total: bigint`. Conversion needed: five bigints → strings, `grid: Uint8Array` → number[].

- [ ] **Step 1: Write the failing test**

`frontend/src/games/bombIt/bombItResumeAdapter.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { makeBombItResumeAdapter } from "./bombItResumeAdapter.ts";
import { BombItProtocol, CELL_COUNT } from "../../../../sui-tunnel-ts/src/protocol/bombIt.ts";

test("serializeState round-trips through JSON: bigints + grid Uint8Array", () => {
  const proto = new BombItProtocol();
  const s0 = proto.initialState({ tunnelId: "0xfeed", initialBalances: { a: 100n, b: 100n } });
  const s1 = proto.applyMove(s0, { a: "bomb" }, "A"); // tick=1n + a live bomb
  const adapter = makeBombItResumeAdapter();
  const back = adapter.deserializeState(JSON.parse(JSON.stringify(adapter.serializeState(s1))));
  assert.equal(back.tick, s1.tick);
  assert.equal(back.seed, s1.seed);
  assert.equal(back.balanceA, s1.balanceA);
  assert.equal(back.total, s1.total);
  assert.equal(typeof back.tick, "bigint");
  assert.ok(back.grid instanceof Uint8Array);
  assert.equal(back.grid.length, CELL_COUNT);
  assert.deepEqual(Array.from(back.grid), Array.from(s1.grid));
  assert.deepEqual(back.players, s1.players);
  assert.deepEqual(back.bombs, s1.bombs);
  assert.equal(back.winner, s1.winner);
});

test("serializeState is JSON-safe (no bigint, grid as number[])", () => {
  const proto = new BombItProtocol();
  const s = proto.initialState({ tunnelId: "0xabc", initialBalances: { a: 100n, b: 100n } });
  const j = makeBombItResumeAdapter().serializeState(s) as Record<string, unknown>;
  for (const k of ["tick", "seed", "balanceA", "balanceB", "total"])
    assert.equal(typeof j[k], "string");
  assert.ok(Array.isArray(j.grid));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && node --import tsx --test "src/games/bombIt/bombItResumeAdapter.test.ts"`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the adapter**

`frontend/src/games/bombIt/bombItResumeAdapter.ts`:

```ts
/**
 * Bomb It resume adapter. State is fully public (no hidden secret — ADR-0010) and moves are
 * JSON-native ({ a?, b? }). localStorage holds neither bigints nor typed arrays, so the five bigint
 * fields round-trip as decimal strings and the grid round-trips as a plain number[]. players/bombs
 * are already JSON-native.
 */
import type { ResumeAdapter } from "@/pvp/resumeSession";
import type { JsonValue } from "@/pvp/resume";
import type { BombItState, BombItMove } from "sui-tunnel-ts/protocol/bombIt";

export function makeBombItResumeAdapter(
  onReconciled?: ResumeAdapter<BombItState, BombItMove>["onReconciled"],
): ResumeAdapter<BombItState, BombItMove> {
  return {
    serializeState: (s) =>
      ({
        tick: s.tick.toString(),
        seed: s.seed.toString(),
        grid: Array.from(s.grid),
        players: s.players,
        bombs: s.bombs,
        winner: s.winner,
        balanceA: s.balanceA.toString(),
        balanceB: s.balanceB.toString(),
        total: s.total.toString(),
      }) as unknown as JsonValue,
    deserializeState: (j) => {
      const o = j as Record<string, unknown>;
      return {
        tick: BigInt(o.tick as string),
        seed: BigInt(o.seed as string),
        grid: Uint8Array.from(o.grid as number[]),
        players: o.players as BombItState["players"],
        bombs: o.bombs as BombItState["bombs"],
        winner: o.winner as BombItState["winner"],
        balanceA: BigInt(o.balanceA as string),
        balanceB: BigInt(o.balanceB as string),
        total: BigInt(o.total as string),
      };
    },
    onReconciled: onReconciled ?? (() => {}),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && node --import tsx --test "src/games/bombIt/bombItResumeAdapter.test.ts"`
Expected: PASS — 2/2, pristine.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/bombIt/bombItResumeAdapter.ts frontend/src/games/bombIt/bombItResumeAdapter.test.ts
git commit -m "feat(bomb-it): pvp resume adapter"
```

---

### Task 3: Chicken Cross PvP hook → out-of-React session + resume

**Files:**
- Rewrite: `frontend/src/games/chickenCross/usePvpChickenCross.ts`
- Modify: `frontend/src/games/chickenCross/ChickenCrossWindow.tsx` (pass `windowId`)

**Interfaces:**
- Consumes: `makeCrossResumeAdapter` (Task 1); `attachResume`, `resumeActiveTunnels` from `@/pvp/resumeSession`; `installResumePersistence`, `evictExpiredRecords`, `readResumeRecord`, `listActiveTunnels` from `@/pvp/resume`; `registerWindowDisposer` from `@/lib/windowSessions`; existing `CrossProtocol`, `deriveView`, `MpClient`, `DistributedTunnel`, `Transcript`, on-chain builders, `coSignedToSettleRequest`.
- Produces: `export function usePvpChickenCross(windowId: string): PvpChickenCross` — same `PvpChickenCross` interface fields as today (`status, role, stake, auto, view, winner, error, findMatch, setDir, toggleAuto, reset`), now driven by `useSyncExternalStore`.

This task mirrors `frontend/src/games/battleship/useBattleshipPvp.ts` structurally. Read that file first — it is the template. Apply these game-specific deltas:

1. **No secret, no codec.** Omit all `FleetSecret`/`placements`/`makeFleetSecret`/`battleshipMoveCodec`/`proposeDue`/`raiseDisputeUnilateral` (battleship-only). `DistributedTunnel` is constructed WITHOUT `moveCodec`. `resumeActiveTunnels`/`rebuildTunnel` spec is `{ proto, adapter }` (no `moveCodec`).
2. **Preserve the CURRENT hook's game loop** (from the existing `usePvpChickenCross.ts` before this rewrite): the `turn(nonce)`/`maybePropose` per-tick scheduler (a `setTimeout` at `STEP_MS = 300` that proposes this seat's hop — bot via `proto.randomMove(state, myRole, rng)` reading `dirA`/`dirB`, or the human's `myDirRef`), the `auto`/`setDir`/`toggleAuto` controls, `STAKE = 500n`, and the existing `settle()` function (transcript-root settle + wallet fallback) — keep `settle()` as-is at the bottom of the file.
3. **Adopt battleship's session shape:** an out-of-React `PvpSession` class with `subscribe`/`getSnapshot`/`emit`/`fail`/`sync`/`reset`/`dispose`/`makeAdapter`/`activateSession`/`resume`/`findMatch`, a module-level `Map<string, PvpSession>` keyed by `windowId`, `getPvpSession(windowId)` registering a `registerWindowDisposer(windowId, "chicken-cross-pvp", …)`, and the hook body using `useSyncExternalStore(session.subscribe, session.getSnapshot)` + a `useEffect(() => session.resume(), [session, account?.address])`.
4. **`sync()`** sets `view = deriveView(dt.displayState)` and copies `winner = dt.state.winner` into the snapshot.
5. **`makeAdapter()`** returns `makeCrossResumeAdapter(() => this.sync())`.
6. **`activateSession(mp, channel, dt, waitPeer, info)`** (shared by live + cold-load): sets `dt.onConfirmed` to (append transcript; `sync()`; `maybePropose()`; on `proto.isTerminal` → set `settling`, status `"settling"`, run `settle(...)` → status `"settled"`/`fail`), then `this.detachResume = attachResume({ mp, channel, tunnel: dt, adapter: this.makeAdapter(), identity: { matchId, tunnelId: dt.tunnelId, role, game: "chicken-cross", opponentWallet, opponentPubkeyHex, selfEphemeralSecretHex }, onGraceExpired: (latest) => { if (latest) void closeCooperativeWithRoot-or-raiseDispute… } })`. For the grace floor use the SAME unilateral path battleship uses if available (`raiseDisputeUnilateral`); if cross has no dispute builder wired, fall back to `onGraceExpired: undefined` is NOT allowed — use `raiseDisputeUnilateral({ signExec, tunnelId, update: latest, role })` (imported from `../../onchain/tunnelTx`, same as battleship). Set status `"playing"` + `sync()`.
7. **`resume()`** (cold-load on mount): `installResumePersistence(); evictExpiredRecords();` guard `if (this.mp) return;` and wallet-ready guard; check `listActiveTunnels().map(readResumeRecord).some(r => r?.game === "chicken-cross")` else return; build `mp`, `resumeActiveTunnels<CrossState, CrossMove>(mp, "chicken-cross", { proto: new CrossProtocol(), adapter: this.makeAdapter() }, { selfWallet: wallet })`; if none, close + return; else read the restored `{tunnel, channel}` + its record, set `role`, build `waitPeer`, `activateSession(...)`, `await mp.connect()`, then `maybePropose()` to kick a due move.
8. **`findMatch()`**: keep the current matchmaking flow (connect → quickMatch("chicken-cross") → hello pubkey exchange → seat A `openAndFundSharedTunnel`+announce / seat B `depositStake` → build `DistributedTunnel` WITHOUT moveCodec), then call `activateSession(mp, channel, dt, waitPeer, { matchId, role, opponentWallet, opponentPubkeyHex: toHex(oppPub), selfEphemeralSecretHex: toHex(ephemeral.secretKey) })`, then the readiness handshake (A awaits "ready" / B sends "ready"), then `maybePropose()`. Call `installResumePersistence(); evictExpiredRecords();` at the top.
9. **`reset()`/`dispose()`**: clear the propose timer, `detachResume?.()`, `mp?.close()`, null refs, emit.

- [ ] **Step 1: Read the reference**

Read `frontend/src/games/battleship/useBattleshipPvp.ts` in full and the current `frontend/src/games/chickenCross/usePvpChickenCross.ts` (the game loop to preserve). No code change yet.

- [ ] **Step 2: Rewrite the hook**

Apply deltas 1–9 above. Keep the existing `settle()` function verbatim. Keep `maybePropose`/`turn`/`makeInbox` (move `makeInbox` to module scope like battleship). Construct `DistributedTunnel` with NO `moveCodec`. Hook signature becomes `usePvpChickenCross(windowId: string)`.

- [ ] **Step 3: Pass windowId from the Window**

In `frontend/src/games/chickenCross/ChickenCrossWindow.tsx`: change `export function ChickenCrossWindow(_props: GameWindowProps)` to `export function ChickenCrossWindow({ windowId }: GameWindowProps)` and `const pvp = usePvpChickenCross()` → `const pvp = usePvpChickenCross(windowId)`.

- [ ] **Step 4: Typecheck**

Run: `cd frontend && pnpm typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/chickenCross/usePvpChickenCross.ts frontend/src/games/chickenCross/ChickenCrossWindow.tsx
git commit -m "feat(cross): pvp match resume + session"
```

---

### Task 4: Bomb It PvP hook → out-of-React session + resume

**Files:**
- Rewrite: `frontend/src/games/bombIt/usePvpBombIt.ts`
- Modify: `frontend/src/games/bombIt/BombItWindow.tsx` (pass `windowId`)

**Interfaces:**
- Same as Task 3 but for bomb-it: `makeBombItResumeAdapter`, `BombItProtocol`, `BombItState`/`BombItMove`, `game: "bomb-it"`, `STEP_MS = 250`, controls `queueAction`/`toggleAuto`/`auto`, bot move via `proto.randomMove(state, myRole, rng)` reading `.a`/`.b`, human via `nextActionRef`.
- Produces: `export function usePvpBombIt(windowId: string): PvpBombIt` (same interface fields as today), `useSyncExternalStore`-driven.

Identical structure to Task 3, with the bomb-it game-loop preserved from the current `usePvpBombIt.ts` (the `maybePropose` reading `nextActionRef`/`auto`, `queueAction`, winner type `"A"|"B"|"draw"|null`). `DistributedTunnel` built WITHOUT `moveCodec`. `sync()` sets `view = deriveView(dt.displayState)` + `winner = dt.state.winner`. Adapter = `makeBombItResumeAdapter(() => this.sync())`. `resume()` keys on `"bomb-it"`. `settle()` kept verbatim.

- [ ] **Step 1: Read the reference**

Read `frontend/src/games/battleship/useBattleshipPvp.ts` and the just-rewritten `frontend/src/games/chickenCross/usePvpChickenCross.ts` (Task 3) as the closest in-repo template, plus the current `usePvpBombIt.ts` (loop to preserve). No code change yet.

- [ ] **Step 2: Rewrite the hook**

Mirror Task 3's structure with the bomb-it deltas above. Hook signature `usePvpBombIt(windowId: string)`. No `moveCodec`.

- [ ] **Step 3: Pass windowId from the Window**

In `frontend/src/games/bombIt/BombItWindow.tsx`: `export function BombItWindow({ windowId }: GameWindowProps)` and `usePvpBombIt()` → `usePvpBombIt(windowId)`.

- [ ] **Step 4: Typecheck**

Run: `cd frontend && pnpm typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/bombIt/usePvpBombIt.ts frontend/src/games/bombIt/BombItWindow.tsx
git commit -m "feat(bomb-it): pvp match resume + session"
```

---

### Task 5: Cold-load round-trip tests

**Files:**
- Create: `frontend/src/games/chickenCross/crossColdLoad.test.ts`
- Create: `frontend/src/games/bombIt/bombItColdLoad.test.ts`

**Interfaces:** consume `rebuildTunnel` from `@/pvp/resumeSession`; `writeResumeRecord`/`flushResumeWrites`/`readResumeRecord`/`clearResumeRecord`/`toWireCoSigned` from `@/pvp/resume`; `OffchainTunnel`/`makeEndpoint` + `generateKeyPair` + `toHex` from the SDK (relative `.ts` paths in tests).

These mirror `battleshipColdLoad.test.ts` but SIMPLER (no secret, no codec, JSON-native moves). The check: a record persisted from a real co-signed self-play state rebuilds (via `rebuildTunnel`) to a tunnel whose `displayState` matches the original — proving the adapter's bigint/Uint8Array (de)serialization survives the localStorage round-trip.

- [ ] **Step 1: Write the cross cold-load test**

`frontend/src/games/chickenCross/crossColdLoad.test.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { makeCrossResumeAdapter } from "./crossResumeAdapter.ts";
import { rebuildTunnel } from "../../pvp/resumeSession.ts";
import {
  writeResumeRecord, flushResumeWrites, readResumeRecord, clearResumeRecord, toWireCoSigned,
} from "../../pvp/resume.ts";
import { OffchainTunnel, makeEndpoint } from "../../../../sui-tunnel-ts/src/core/tunnel.ts";
import { defaultBackend } from "../../../../sui-tunnel-ts/src/core/crypto-native.ts";
import { generateKeyPair } from "../../../../sui-tunnel-ts/src/core/crypto.ts";
import { toHex } from "../../../../sui-tunnel-ts/src/core/bytes.ts";
import { CrossProtocol } from "../../../../sui-tunnel-ts/src/protocol/cross.ts";

(globalThis as Record<string, unknown>).localStorage = new (class {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
})();
(globalThis as Record<string, unknown>).window = { addEventListener() {} };

test("cross cold-load: rebuilt tunnel restores the co-signed state from localStorage", () => {
  const proto = new CrossProtocol() as never;
  const ka = generateKeyPair(), kb = generateKeyPair();
  const tid = `0x${"63".repeat(32)}`;
  const sp = OffchainTunnel.selfPlay(proto, tid, ka as never, kb as never, "0xA", "0xB", { a: 500n, b: 500n });
  sp.step({ dirA: "north" }, "A");
  sp.step({ dirB: "north" }, "B");

  const adapter = makeCrossResumeAdapter();
  writeResumeRecord({
    matchId: "match-cross", tunnelId: tid, role: "B", game: "chicken-cross",
    opponentWallet: "0xA", opponentPubkeyHex: toHex(ka.publicKey),
    selfEphemeralSecretHex: toHex(kb.secretKey),
    latestCoSigned: toWireCoSigned(sp.latest!),
    latestState: adapter.serializeState(sp.state as never),
    updatedAt: Date.now(),
  } as never);
  flushResumeWrites();

  const mp = { channel: () => ({ transport: { send() {}, onFrame() {} }, sendPeer() {}, onPeer() {}, addPeerListener() {}, removePeerListener() {} }), markActive() {} } as never;
  const { tunnel } = rebuildTunnel(mp, readResumeRecord(tid)!, { proto, adapter: makeCrossResumeAdapter() } as never, { selfWallet: "0xB" });
  const st = (tunnel as { snapshot(): { state: { tick: bigint; balanceA: bigint; total: bigint } } }).snapshot().state;
  assert.equal(st.tick, sp.state.tick);
  assert.equal(st.balanceA, sp.state.balanceA);
  assert.equal(st.total, sp.state.total);
  clearResumeRecord(tid);
});
```

- [ ] **Step 2: Run it (red → green as written)**

Run: `cd frontend && node --import tsx --test "src/games/chickenCross/crossColdLoad.test.ts"`
Expected: PASS — 1/1. (If `rebuildTunnel`/`snapshot` shapes differ, adjust the assertion to the real snapshot field names from `resumeSession.ts`/`distributedTunnel.ts` — do not weaken the bigint-equality checks.)

- [ ] **Step 3: Write the bomb-it cold-load test**

`frontend/src/games/bombIt/bombItColdLoad.test.ts` — same structure, with `BombItProtocol`, `game: "bomb-it"`, tid `0x${"b1".repeat(32)}`, steps `sp.step({ a: "bomb" }, "A"); sp.step({ b: "north" }, "B");`, `makeBombItResumeAdapter`, and an extra assertion that the rebuilt grid matches: `assert.deepEqual(Array.from(st.grid), Array.from(sp.state.grid))`.

- [ ] **Step 4: Run it**

Run: `cd frontend && node --import tsx --test "src/games/bombIt/bombItColdLoad.test.ts"`
Expected: PASS — 1/1.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/chickenCross/crossColdLoad.test.ts frontend/src/games/bombIt/bombItColdLoad.test.ts
git commit -m "test(pvp): bomb-it/cross cold-load round-trip"
```

---

### Task 6: Full gate

**Files:** none (verification only).

- [ ] **Step 1: SDK protocol + core tests**

Run: `cd sui-tunnel-ts && node --import tsx --test src/protocol/cross.test.ts src/protocol/bombIt.test.ts src/core/reconcile.test.ts src/core/distributedTunnel.test.ts src/core/distributedFrame.test.ts`
Expected: all pass, 0 fail.

- [ ] **Step 2: Frontend game + pvp + adapter + cold-load tests**

Run: `cd frontend && node --import tsx --test "src/games/bombIt/session-core.test.ts" "src/games/chickenCross/session-core.test.ts" "src/games/bombIt/bombItResumeAdapter.test.ts" "src/games/chickenCross/crossResumeAdapter.test.ts" "src/games/bombIt/bombItColdLoad.test.ts" "src/games/chickenCross/crossColdLoad.test.ts" "src/pvp/mpClient.test.ts" "src/pvp/resume.test.ts" "src/pvp/resumeSession.test.ts"`
Expected: all pass, 0 fail.

- [ ] **Step 3: Typecheck + build**

Run: `cd frontend && pnpm typecheck && pnpm build`
Expected: typecheck exit 0; build succeeds (only pre-existing INEFFECTIVE_DYNAMIC_IMPORT warnings).

- [ ] **Step 4: Confirm clean tree**

Run: `cd /Users/realestzan/Projects/code/dopamint-arena && git status --short`
Expected: empty.

---

## Self-Review

**1. Spec coverage:** resume adapters (Tasks 1–2), full-parity out-of-React hooks + windowId + attachResume + cold-load + grace (Tasks 3–4), cold-load tests (Task 5), gate (Task 6). ✓
**2. Placeholder scan:** adapters + tests are complete code; the hook tasks specify exact deltas against a named in-repo reference (battleship) + the current hook — the reference IS the spec for the ~300-line skeleton, not a placeholder. ✓
**3. Type consistency:** `makeCrossResumeAdapter`/`makeBombItResumeAdapter` signatures match `ResumeAdapter<State, Move>`; `usePvp<Game>(windowId: string)` matches the battleship hook + `GameWindowProps.windowId`; `resumeActiveTunnels`/`rebuildTunnel`/`attachResume`/`ResumeIdentity` match `resumeSession.ts`. ✓
