# PvP transcript resume persistence — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist each PvP tunnel's co-signed transcript to localStorage and replay it on reload so a resumed seat rebuilds the identical Merkle root and cooperative close no longer fails with `transcript-root mismatch` — across every affected lane (poker, battleship, the shared `pvpMatchHook`).

**Architecture:** Add generic persistence/replay primitives to `pvp/resume.ts` (embed entries in `ResumeRecord`) and surface a rebuilt `Transcript` from `pvp/resumeSession.ts`'s `rebuildTunnel`. Then apply one uniform five-edit wiring to each game hook. No upstream `sui-tunnel-ts` edits — only public SDK APIs.

**Tech Stack:** TypeScript, React (dapp-kit), `sui-tunnel-ts` SDK (`Transcript`, `DistributedTunnel`, wire codec), `node:test` via `tsx`, prettier.

## Global Constraints

- No edits to `sui-tunnel-ts/` or `sui_tunnel/` (upstream-authoritative; re-synced from upstream).
- All commands run from `/Users/aaronphan/Documents/projects/quantum_poker/dopamint-arena/frontend`.
- Test runner: `node --import tsx --test "<glob>"`. Typecheck: `npx tsc --noEmit`. Format: `npx prettier --write "<file>"`. Full suite: `npm test`.
- Commit style (repo `CLAUDE.md`): Conventional Commits, subject ≤ 50 chars, imperative, lowercase after type, **no AI attribution**.
- localStorage has no append API; the transcript rides inside the existing `ResumeRecord` (one `setItem`) so it stays atomic with `latestCoSigned`.

---

### Task 1: Transcript persistence primitives (`pvp/resume.ts`)

**Files:**
- Modify: `src/pvp/resume.ts`
- Test: `src/pvp/resume.test.ts`

**Interfaces:**
- Produces:
  - `interface WireTranscriptEntry { nonce: string; message: string; sigA: string; sigB: string }`
  - `ResumeRecord.transcript?: WireTranscriptEntry[]`
  - `transcriptToWire(t: Transcript): WireTranscriptEntry[]`
  - `rebuildTranscript(tunnelId: string, entries: WireTranscriptEntry[]): Transcript`
  - `transcriptLastNonce(t: Transcript): bigint`
  - `appendAdoptedCheckpoint(t: Transcript, latest: CoSignedUpdate | null): "appended" | "noop" | "gap"`

- [ ] **Step 1: Write the failing tests**

In `src/pvp/resume.test.ts`, add a static type import near the top (after line 2):

```ts
import type { CoSignedUpdate } from "sui-tunnel-ts/core/tunnel";
```

Add the four new names to the existing `await import("./resume")` destructure (the block ending `} = await import("./resume");`):

```ts
  evictExpiredRecords,
  hasResumableMatch,
  transcriptToWire,
  rebuildTranscript,
  transcriptLastNonce,
  appendAdoptedCheckpoint,
  keypairFromSecretHex,
} = await import("./resume");
```

Add a `Transcript` dynamic import after the `toHex` import line (`const { toHex } = await import("sui-tunnel-ts/core/bytes");`):

```ts
const { Transcript } = await import("sui-tunnel-ts/proof/transcript");
```

Append these tests just before the `// --- tiny fixtures local to the test ---` comment:

```ts
// Build n co-signed updates (nonces 1..n) by alternating self-play steps on the counter proto.
function counterUpdates(n: number): { tid: string; out: CoSignedUpdate[] } {
  const ka = generateKeyPair(),
    kb = generateKeyPair();
  const tid = `0x${"31".repeat(32)}`;
  const sp = OffchainTunnel.selfPlay(counterProto(), tid, ka, kb, "0xA", "0xB", {
    a: 1000n,
    b: 1000n,
  });
  const out: CoSignedUpdate[] = [];
  for (let i = 0; i < n; i++) {
    sp.step(0, i % 2 === 0 ? "A" : "B");
    out.push(sp.latest!);
  }
  return { tid, out };
}

test("transcriptToWire + rebuildTranscript reproduce the root byte-for-byte", () => {
  const { tid, out } = counterUpdates(5);
  const orig = new Transcript(tid);
  out.forEach((u) => orig.append(u));
  const rebuilt = rebuildTranscript(tid, transcriptToWire(orig));
  assert.equal(rebuilt.length, 5);
  assert.deepEqual(
    Uint8Array.from(rebuilt.root()),
    Uint8Array.from(orig.root()),
    "rebuilt transcript yields the same Merkle root",
  );
});

test("appendAdoptedCheckpoint fills exactly the next entry to match the natural root", () => {
  const { tid, out } = counterUpdates(5);
  const ref = new Transcript(tid);
  out.forEach((u) => ref.append(u)); // 1..5 naturally

  const t = new Transcript(tid);
  out.slice(0, 4).forEach((u) => t.append(u)); // 1..4
  assert.equal(appendAdoptedCheckpoint(t, out[4]), "appended"); // nonce 5 === 4+1
  assert.deepEqual(
    Uint8Array.from(t.root()),
    Uint8Array.from(ref.root()),
    "adopt-appended transcript matches the never-dropped one",
  );
});

test("appendAdoptedCheckpoint guards a >1 gap and a present/absent nonce", () => {
  const { tid, out } = counterUpdates(5);
  const t = new Transcript(tid);
  out.slice(0, 3).forEach((u) => t.append(u)); // 1..3, last = 3
  assert.equal(appendAdoptedCheckpoint(t, out[4]), "gap"); // nonce 5 > 3+1
  assert.equal(t.length, 3, "gap is never appended");
  assert.equal(appendAdoptedCheckpoint(t, out[1]), "noop"); // nonce 2 <= 3
  assert.equal(appendAdoptedCheckpoint(t, null), "noop");
  assert.equal(t.length, 3);
});

test("a record carrying a transcript is removed by clearResumeRecord", () => {
  const { tid, out } = counterUpdates(2);
  const built = new Transcript(tid);
  out.forEach((u) => built.append(u));
  writeResumeRecord({
    matchId: "m",
    tunnelId: tid,
    role: "A",
    game: "g",
    opponentWallet: "0xb",
    opponentPubkeyHex: "ab",
    selfEphemeralSecretHex: toHex(generateKeyPair().secretKey),
    latestCoSigned: toWireCoSigned(out[1]),
    latestState: {},
    transcript: transcriptToWire(built),
    updatedAt: 1,
  });
  flushResumeWrites();
  assert.equal(readResumeRecord(tid)?.transcript?.length, 2);
  clearResumeRecord(tid);
  assert.equal(readResumeRecord(tid), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test "src/pvp/resume.test.ts"`
Expected: FAIL — `transcriptToWire is not a function` (and the other new helpers undefined).

- [ ] **Step 3: Implement the primitives in `src/pvp/resume.ts`**

Change the wire import (currently `import type { StateUpdate } from "sui-tunnel-ts/core/wire";`) to a value import, and add the `Transcript` import, just below the existing imports:

```ts
import { parseStateUpdate, type StateUpdate } from "sui-tunnel-ts/core/wire";
import { Transcript } from "sui-tunnel-ts/proof/transcript";
```

Add the `transcript` field to `ResumeRecord` (immediately after the `secret?: JsonValue;` line):

```ts
  /** Full co-signed transcript from tunnel-open to `latestCoSigned`, hex-encoded. Persisted in the
   *  SAME record so it is written atomically with the checkpoint; replayed on cold-load to recompute
   *  the Merkle root the peer holds, so cooperative close does not hit a transcript-root mismatch. */
  transcript?: WireTranscriptEntry[];
```

Add the `WireTranscriptEntry` interface next to `WireCoSigned` (after the `WireCoSigned` interface):

```ts
/** localStorage-safe transcript entry: the signed StateUpdate bytes + both sigs (hex; nonce decimal). */
export interface WireTranscriptEntry {
  nonce: string;
  message: string;
  sigA: string;
  sigB: string;
}
```

Add the four helpers immediately after the `listActiveTunnels` function:

```ts
/** Serialize a live transcript to its localStorage form. */
export function transcriptToWire(t: Transcript): WireTranscriptEntry[] {
  return t.rawEntries().map((e) => ({
    nonce: e.nonce.toString(),
    message: toHex(e.message),
    sigA: toHex(e.sigA),
    sigB: toHex(e.sigB),
  }));
}

/** Replay persisted entries into a Transcript. `root()` matches the pre-reload root because the
 *  Transcript derives each leaf from the (canonical) message + sigs, not from any live engine state. */
export function rebuildTranscript(
  tunnelId: string,
  entries: WireTranscriptEntry[],
): Transcript {
  const t = new Transcript(tunnelId);
  for (const e of entries) {
    t.append({
      update: parseStateUpdate(fromHex(e.message)),
      sigA: fromHex(e.sigA),
      sigB: fromHex(e.sigB),
    });
  }
  return t;
}

/** Highest nonce currently in the transcript, or 0 when empty. */
export function transcriptLastNonce(t: Transcript): bigint {
  const n = t.length;
  return n === 0 ? 0n : t.rawEntries()[n - 1].nonce;
}

/** On a resync "adopt" the SDK advances `_latest` WITHOUT firing onConfirmed, so the adopted
 *  checkpoint is missing from the transcript. Append it IFF it is exactly the next entry. A >1 gap
 *  ("gap") cannot happen without tampering and is never appended — the existing settle-time root
 *  check then rejects the close safely. An already-present nonce / null is a "noop". */
export function appendAdoptedCheckpoint(
  t: Transcript,
  latest: CoSignedUpdate | null,
): "appended" | "noop" | "gap" {
  if (!latest) return "noop";
  const last = transcriptLastNonce(t);
  if (latest.update.nonce === last + 1n) {
    t.append(latest);
    return "appended";
  }
  if (latest.update.nonce > last + 1n) return "gap";
  return "noop";
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test "src/pvp/resume.test.ts"`
Expected: PASS (all existing + 4 new tests).

- [ ] **Step 5: Format, then commit**

```bash
npx prettier --write "src/pvp/resume.ts" "src/pvp/resume.test.ts"
git add src/pvp/resume.ts src/pvp/resume.test.ts
git commit -m "feat(pvp): persist co-signed transcript for resume"
```

---

### Task 2: Surface the rebuilt transcript (`pvp/resumeSession.ts`)

**Files:**
- Modify: `src/pvp/resumeSession.ts`
- Test: `src/pvp/resumeSession.test.ts`

**Interfaces:**
- Consumes (Task 1): `WireTranscriptEntry`, `rebuildTranscript`, `ResumeRecord.transcript`.
- Produces:
  - `ResumeAdapter.captureTranscript?(): WireTranscriptEntry[]`
  - `RestoredSession.transcript: Transcript | null`
  - `rebuildTunnel` returns `{ tunnel, channel, transcript }`.

- [ ] **Step 1: Write the failing tests**

In `src/pvp/resumeSession.test.ts`, add `transcriptToWire` to the `await import("./resume")` destructure:

```ts
const {
  writeResumeRecord,
  flushResumeWrites,
  readResumeRecord,
  clearResumeRecord,
  toWireCoSigned,
  transcriptToWire,
} = await import("./resume");
```

Add a `Transcript` dynamic import after the `toHex` import line:

```ts
const { Transcript } = await import("sui-tunnel-ts/proof/transcript");
```

Append these two tests at the end of the file:

```ts
test("rebuildTunnel surfaces a transcript whose root matches the persisted entries", () => {
  const ka = generateKeyPair(),
    kb = generateKeyPair();
  const tid = `0x${"47".repeat(32)}`;
  const sp = OffchainTunnel.selfPlay(proto as never, tid, ka, kb, "0xA", "0xB", {
    a: 1000n,
    b: 1000n,
  });
  sp.step(0, "A");
  const u1 = sp.latest!;
  sp.step(0, "B");
  const u2 = sp.latest!;
  const ref = new Transcript(tid);
  ref.append(u1);
  ref.append(u2);

  writeResumeRecord({
    matchId: `match-${tid.slice(0, 6)}`,
    tunnelId: tid,
    role: "A",
    game: "counter",
    opponentWallet: "0xB",
    opponentPubkeyHex: toHex(kb.publicKey),
    selfEphemeralSecretHex: toHex(ka.secretKey),
    latestCoSigned: toWireCoSigned(u2),
    latestState: adapter.serializeState(sp.state),
    transcript: transcriptToWire(ref),
    updatedAt: Date.now(),
  });
  flushResumeWrites();

  const mp = makeFakeMp();
  const session = rebuildTunnel(
    mp as never,
    readResumeRecord(tid)!,
    { proto, adapter } as never,
    { selfWallet: "0xA" },
  );
  assert.ok(session.transcript, "transcript surfaced on the restored session");
  assert.deepEqual(
    Uint8Array.from(session.transcript!.root()),
    Uint8Array.from(ref.root()),
    "rebuilt transcript root matches the persisted one",
  );
  clearResumeRecord(tid);
});

test("rebuildTunnel returns a null transcript when the record has none", () => {
  const tid = `0x${"48".repeat(32)}`;
  const record = recordAtNonce2(
    tid,
    generateKeyPair() as never,
    generateKeyPair() as never,
  );
  writeResumeRecord(record);
  flushResumeWrites();
  const session = rebuildTunnel(
    makeFakeMp() as never,
    readResumeRecord(tid)!,
    { proto, adapter } as never,
    { selfWallet: "0xA" },
  );
  assert.equal(session.transcript, null);
  clearResumeRecord(tid);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test "src/pvp/resumeSession.test.ts"`
Expected: FAIL — `session.transcript` is `undefined` (asserts `ok`/`deepEqual` fail).

- [ ] **Step 3: Implement in `src/pvp/resumeSession.ts`**

Add `rebuildTranscript` to the value import from `./resume` and `WireTranscriptEntry` to the type import:

```ts
import {
  clearResumeRecord,
  evictExpiredRecords,
  fromWireCoSigned,
  keypairFromSecretHex,
  listActiveTunnels,
  readResumeRecord,
  rebuildTranscript,
  toWireCoSigned,
  writeResumeRecord,
} from "./resume";
import type { JsonValue, ResumeRecord, WireTranscriptEntry } from "./resume";
```

Add a `Transcript` type import next to the other `sui-tunnel-ts` imports at the top:

```ts
import type { Transcript } from "sui-tunnel-ts/proof/transcript";
```

In the `ResumeAdapter` interface, add `captureTranscript` just before `onReconciled`:

```ts
  /** Serialize the game's live transcript for persistence (atomic with the checkpoint). Games that
   *  build a Transcript supply this; others omit it. Restore is via RestoredSession.transcript. */
  captureTranscript?(): WireTranscriptEntry[];
```

In `buildRecord`, add the `transcript` field to the returned object (after the `secret:` line):

```ts
    secret: adapter.captureSecret ? adapter.captureSecret() : undefined,
    transcript: adapter.captureTranscript?.(),
    updatedAt: Date.now(),
```

In the `RestoredSession` interface, add the `transcript` field:

```ts
export interface RestoredSession<State, Move> {
  tunnel: DistributedTunnel<State, Move>;
  channel: PvpChannel;
  transcript: Transcript | null;
}
```

In `rebuildTunnel`, replace the final `return { tunnel, channel };` with:

```ts
  const transcript = record.transcript
    ? rebuildTranscript(record.tunnelId, record.transcript)
    : null;
  return { tunnel, channel, transcript };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test "src/pvp/resumeSession.test.ts"`
Expected: PASS (existing + 2 new tests).

- [ ] **Step 5: Format, then commit**

```bash
npx prettier --write "src/pvp/resumeSession.ts" "src/pvp/resumeSession.test.ts"
git add src/pvp/resumeSession.ts src/pvp/resumeSession.test.ts
git commit -m "feat(pvp): surface rebuilt transcript on cold-load"
```

---

### Task 3: Wire the poker lane (`games/quantumPoker/usePvpQuantumPoker.ts`)

**Files:**
- Modify: `src/games/quantumPoker/usePvpQuantumPoker.ts`

**Interfaces:**
- Consumes (Tasks 1-2): `transcriptToWire`, `appendAdoptedCheckpoint`, `ResumeAdapter.captureTranscript`, `RestoredSession.transcript`.

The poker hook uses a `transcriptRef` (functional hook) and `reset` already nulls it — so only four edits are needed (no field/reset change).

- [ ] **Step 1: Import the two helpers**

In the `@/pvp/resume` import block (the one containing `installResumePersistence`, `clearResumeRecord`), add:

```ts
  clearResumeRecord,
  transcriptToWire,
  appendAdoptedCheckpoint,
} from "@/pvp/resume";
```

- [ ] **Step 2: Reuse a rebuilt transcript in `activatePokerSession`**

Replace:

```ts
      const transcript = new Transcript(dt.tunnelId);
      transcriptRef.current = transcript;
```

with:

```ts
      const transcript = transcriptRef.current ?? new Transcript(dt.tunnelId);
      transcriptRef.current = transcript;
```

- [ ] **Step 3: Capture the transcript + adopt-append in the live adapter**

In the `attachResume({ ... adapter: makePokerResumeAdapter({ ... }) ... })` call, replace the `adapter: makePokerResumeAdapter({ ... onReconciled: () => { sync(); maybeAutoPropose(); }, }),` with a spread object that adds `captureTranscript` and routes adopt through `onReconciled`:

```ts
        adapter: {
          ...makePokerResumeAdapter({
            getSecret: () => {
              const s = dt.state;
              return {
                localSecretsA: s.localSecretsA,
                localSecretsB: s.localSecretsB,
                holeA: s.holeA,
                holeB: s.holeB,
              };
            },
            setSecret: (sec) => {
              const s = dt.state;
              s.localSecretsA = sec.localSecretsA;
              s.localSecretsB = sec.localSecretsB;
              s.holeA = sec.holeA;
              s.holeB = sec.holeB;
            },
            onReconciled: (_tunnel, outcome) => {
              // A resync "adopt" advanced our state without onConfirmed → append the missed entry,
              // else settle would see a short transcript. Then re-fire the plumbing/auto loop.
              if (outcome === "adopt" && transcriptRef.current)
                appendAdoptedCheckpoint(
                  transcriptRef.current,
                  dt.snapshot().latest,
                );
              sync();
              maybeAutoPropose();
            },
          }),
          captureTranscript: () =>
            transcriptRef.current
              ? transcriptToWire(transcriptRef.current)
              : [],
        },
```

- [ ] **Step 4: Install the restored transcript in `resume`**

Replace:

```ts
        const { tunnel, channel } = restored[0];
```

with:

```ts
        const { tunnel, channel, transcript } = restored[0];
```

Then, just before the `const waitPeer = makeInbox(channel);` line in `resume`, add:

```ts
        transcriptRef.current = transcript;
```

- [ ] **Step 5: Typecheck + run the poker/pvp suites**

Run: `npx tsc --noEmit`
Expected: exit 0 (no errors).

Run: `node --import tsx --test "src/pvp/**/*.test.ts" "src/games/quantumPoker/**/*.test.ts"`
Expected: PASS (regression — existing `pokerColdLoad` etc. stay green).

- [ ] **Step 6: Format, then commit**

```bash
npx prettier --write "src/games/quantumPoker/usePvpQuantumPoker.ts"
git add src/games/quantumPoker/usePvpQuantumPoker.ts
git commit -m "fix(poker): replay transcript on PvP reload"
```

---

### Task 4: Wire the battleship lane (`games/battleship/useBattleshipPvp.ts`)

**Files:**
- Modify: `src/games/battleship/useBattleshipPvp.ts`

**Interfaces:**
- Consumes (Tasks 1-2): `transcriptToWire`, `appendAdoptedCheckpoint`, `RestoredSession.transcript`.

Battleship is a class hook (`new Transcript` is a local in `activateSession`), so it needs a `private transcript` field. `Transcript` is already imported (line 12).

- [ ] **Step 1: Import the two helpers**

Add `transcriptToWire` and `appendAdoptedCheckpoint` to the existing `@/pvp/resume` import in this file (the import that already brings in `installResumePersistence` / `listActiveTunnels` / `readResumeRecord`). If there is no `@/pvp/resume` import yet, add:

```ts
import { transcriptToWire, appendAdoptedCheckpoint } from "@/pvp/resume";
```

- [ ] **Step 2: Add the transcript field**

After the line `private dt: BattleshipTunnel | null = null;` add:

```ts
  private transcript: Transcript | null = null;
```

- [ ] **Step 3: Null the field in `reset`**

In `reset`, replace:

```ts
    this.dt = null;
    this.secret = null;
    this.role = null;
```

with:

```ts
    this.dt = null;
    this.transcript = null;
    this.secret = null;
    this.role = null;
```

- [ ] **Step 4: Reuse a rebuilt transcript in `activateSession`**

Replace:

```ts
    const transcript = new Transcript(dt.tunnelId);
```

with:

```ts
    const transcript = this.transcript ?? new Transcript(dt.tunnelId);
    this.transcript = transcript;
```

- [ ] **Step 5: Capture the transcript + adopt-append at the `attachResume` site**

Replace:

```ts
    this.detachResume?.();
    this.detachResume = attachResume({
      mp,
      channel,
      tunnel: dt,
      adapter: this.makeAdapter(),
```

with:

```ts
    this.detachResume?.();
    const baseAdapter = this.makeAdapter();
    const baseOnReconciled = baseAdapter.onReconciled;
    this.detachResume = attachResume({
      mp,
      channel,
      tunnel: dt,
      adapter: {
        ...baseAdapter,
        captureTranscript: () =>
          this.transcript ? transcriptToWire(this.transcript) : [],
        onReconciled: (t, outcome) => {
          if (outcome === "adopt" && this.transcript)
            appendAdoptedCheckpoint(this.transcript, t.snapshot().latest);
          baseOnReconciled(t, outcome);
        },
      },
```

- [ ] **Step 6: Install the restored transcript in `resume`**

Replace:

```ts
        const { tunnel, channel } = restored[0];
```

with:

```ts
        const { tunnel, channel, transcript } = restored[0];
        this.transcript = transcript;
```

- [ ] **Step 7: Typecheck + run the battleship/pvp suites**

Run: `npx tsc --noEmit`
Expected: exit 0.

Run: `node --import tsx --test "src/pvp/**/*.test.ts" "src/games/battleship/**/*.test.ts"`
Expected: PASS.

- [ ] **Step 8: Format, then commit**

```bash
npx prettier --write "src/games/battleship/useBattleshipPvp.ts"
git add src/games/battleship/useBattleshipPvp.ts
git commit -m "fix(battleship): replay transcript on PvP reload"
```

---

### Task 5: Wire the shared lane (`pvp/pvpMatchHook.ts`)

**Files:**
- Modify: `src/pvp/pvpMatchHook.ts`

**Interfaces:**
- Consumes (Tasks 1-2): `transcriptToWire`, `appendAdoptedCheckpoint`, `RestoredSession.transcript`.

Fixes bombIt, chickenCross, and worldCanvas in one place (they all run through this hook). `Transcript` is already imported (line 26).

- [ ] **Step 1: Import the two helpers**

Add `transcriptToWire` and `appendAdoptedCheckpoint` to the existing `@/pvp/resume` import in this file (the one bringing in `installResumePersistence` / `evictExpiredRecords` / `listActiveTunnels` / `readResumeRecord`).

- [ ] **Step 2: Add the transcript field**

After the line `private dt: DistributedTunnel<State, Move> | null = null;` add:

```ts
  private transcript: Transcript | null = null;
```

- [ ] **Step 3: Null the field in `reset`**

In `reset`, replace:

```ts
    this.mp = null;
    this.dt = null;
    this.role = null;
```

with:

```ts
    this.mp = null;
    this.dt = null;
    this.transcript = null;
    this.role = null;
```

- [ ] **Step 4: Reuse a rebuilt transcript in `activateSession`**

Replace:

```ts
    const transcript = new Transcript(dt.tunnelId);
```

with:

```ts
    const transcript = this.transcript ?? new Transcript(dt.tunnelId);
    this.transcript = transcript;
```

- [ ] **Step 5: Capture the transcript + adopt-append at the `attachResume` site**

Replace:

```ts
    this.detachResume?.();
    this.detachResume = attachResume({
      mp,
      channel,
      tunnel: dt,
      adapter: this.makeAdapter(),
```

with:

```ts
    this.detachResume?.();
    const baseAdapter = this.makeAdapter();
    const baseOnReconciled = baseAdapter.onReconciled;
    this.detachResume = attachResume({
      mp,
      channel,
      tunnel: dt,
      adapter: {
        ...baseAdapter,
        captureTranscript: () =>
          this.transcript ? transcriptToWire(this.transcript) : [],
        onReconciled: (t, outcome) => {
          if (outcome === "adopt" && this.transcript)
            appendAdoptedCheckpoint(this.transcript, t.snapshot().latest);
          baseOnReconciled(t, outcome);
        },
      },
```

- [ ] **Step 6: Install the restored transcript in `resume`**

Replace:

```ts
        const { tunnel, channel } = restored[0];
```

with:

```ts
        const { tunnel, channel, transcript } = restored[0];
        this.transcript = transcript;
```

- [ ] **Step 7: Typecheck + run the full suite**

Run: `npx tsc --noEmit`
Expected: exit 0.

Run: `npm test`
Expected: PASS (regression across all lanes — `tttColdLoad`, `resumeSession`, etc. stay green).

- [ ] **Step 8: Format, then commit**

```bash
npx prettier --write "src/pvp/pvpMatchHook.ts"
git add src/pvp/pvpMatchHook.ts
git commit -m "fix(pvp): replay transcript on reload in shared hook"
```

---

### Task 6: Wire the tic-tac-toe lane (`games/ticTacToe/app/hooks/usePvpTicTacToe.ts`)

**Files:**
- Modify: `src/games/ticTacToe/app/hooks/usePvpTicTacToe.ts`

**Interfaces:**
- Consumes (Tasks 1-2): `transcriptToWire`, `appendAdoptedCheckpoint`, `RestoredSession.transcript`.

ttt is a functional-ref hook (`transcriptRef`) that builds the transcript (`transcriptRef.current = new proof.Transcript(tunnelId)`) in the **live-only** path, *outside* the shared `activateTttSession`. Cold-load re-enters the shared activate without re-creating it, so the rebuilt transcript installed in `resume` is never clobbered — only **three** edits are needed (no reuse-`??`, no reset-null). ttt settles by transcript root (`"Transcript root mismatch between players"`), so it has the same reload bug.

- [ ] **Step 1: Import the two helpers**

Add `transcriptToWire` and `appendAdoptedCheckpoint` to the existing `} from "@/pvp/resume";` import block (the one containing `installResumePersistence`).

- [ ] **Step 2: Capture + adopt-append at the `attachResume` site**

Replace:

```ts
      detachResumeRef.current?.();
      detachResumeRef.current = attachResume({
        mp,
        channel,
        tunnel: t,
        adapter: makeTttResumeAdapter<AnyState, CellMove>(() => onAdvance()),
```

with:

```ts
      detachResumeRef.current?.();
      const baseAdapter = makeTttResumeAdapter<AnyState, CellMove>(() =>
        onAdvance(),
      );
      const baseOnReconciled = baseAdapter.onReconciled;
      detachResumeRef.current = attachResume({
        mp,
        channel,
        tunnel: t,
        adapter: {
          ...baseAdapter,
          captureTranscript: () =>
            transcriptRef.current
              ? transcriptToWire(transcriptRef.current)
              : [],
          onReconciled: (rt, outcome) => {
            if (outcome === "adopt" && transcriptRef.current)
              appendAdoptedCheckpoint(
                transcriptRef.current,
                rt.snapshot().latest,
              );
            baseOnReconciled(rt, outcome);
          },
        },
```

- [ ] **Step 3: Install the restored transcript in `resume`**

Replace (the line with the `// one active match per game in practice` comment):

```ts
            const { tunnel, channel } = restored[0]; // one active match per game in practice
```

with:

```ts
            const { tunnel, channel, transcript } = restored[0]; // one active match per game in practice
            transcriptRef.current = transcript;
```

- [ ] **Step 4: Typecheck + run the ttt/pvp suites**

Run: `npx tsc --noEmit`
Expected: exit 0.

Run: `node --import tsx --test "src/pvp/**/*.test.ts" "src/games/ticTacToe/tttColdLoad.test.ts"`
Expected: PASS.

- [ ] **Step 5: Format, then commit**

```bash
npx prettier --write "src/games/ticTacToe/app/hooks/usePvpTicTacToe.ts"
git add src/games/ticTacToe/app/hooks/usePvpTicTacToe.ts
git commit -m "fix(tictactoe): replay transcript on PvP reload"
```

---

### Task 7: Wire the blackjack lane (`games/blackjack/app/hooks/usePvpBlackjack.ts`)

**Files:**
- Modify: `src/games/blackjack/app/hooks/usePvpBlackjack.ts`

**Interfaces:**
- Consumes (Tasks 1-2): `transcriptToWire`, `appendAdoptedCheckpoint`, `RestoredSession.transcript`.

Same three-edit functional-ref pattern as ttt (Task 6): transcript built live-only at `transcriptRef.current = new proof.Transcript(tunnelId)`, shared `activateSession`, settles by transcript root.

- [ ] **Step 1: Import the two helpers**

Add `transcriptToWire` and `appendAdoptedCheckpoint` to the existing `} from "@/pvp/resume";` import block.

- [ ] **Step 2: Capture + adopt-append at the `attachResume` site**

Replace:

```ts
      detachResumeRef.current?.();
      detachResumeRef.current = attachResume({
        mp,
        channel,
        tunnel: t,
        adapter: makeBlackjackResumeAdapter(() => onAdvance()),
```

with:

```ts
      detachResumeRef.current?.();
      const baseAdapter = makeBlackjackResumeAdapter(() => onAdvance());
      const baseOnReconciled = baseAdapter.onReconciled;
      detachResumeRef.current = attachResume({
        mp,
        channel,
        tunnel: t,
        adapter: {
          ...baseAdapter,
          captureTranscript: () =>
            transcriptRef.current
              ? transcriptToWire(transcriptRef.current)
              : [],
          onReconciled: (rt, outcome) => {
            if (outcome === "adopt" && transcriptRef.current)
              appendAdoptedCheckpoint(
                transcriptRef.current,
                rt.snapshot().latest,
              );
            baseOnReconciled(rt, outcome);
          },
        },
```

- [ ] **Step 3: Install the restored transcript in `resume`**

Replace:

```ts
          const { tunnel, channel } = restored[0];
```

with:

```ts
          const { tunnel, channel, transcript } = restored[0];
          transcriptRef.current = transcript;
```

(Note: `const { tunnel, channel } = restored[0];` also appears in the resumeSession test — this edit is in `usePvpBlackjack.ts` only. Match the one in the `resume`/`resumeActiveTunnels` block of this hook.)

- [ ] **Step 4: Typecheck + run the full suite**

Run: `npx tsc --noEmit`
Expected: exit 0.

Run: `npm test`
Expected: PASS (regression across all lanes).

- [ ] **Step 5: Format, then commit**

```bash
npx prettier --write "src/games/blackjack/app/hooks/usePvpBlackjack.ts"
git add src/games/blackjack/app/hooks/usePvpBlackjack.ts
git commit -m "fix(blackjack): replay transcript on PvP reload"
```

---

### Task 8: Document the standard step (`docs/`)

**Files:**
- Modify: `docs/resume-adapter-guide.md`
- Modify: `docs/adding-a-tunnel-game.md`

**Interfaces:**
- Consumes: the finished feature (the five-edit pattern, §4a of the spec).

- [ ] **Step 1: Read both docs**

Run: `sed -n '1,40p' docs/resume-adapter-guide.md docs/adding-a-tunnel-game.md` (from the repo root) to find the right section to extend in each (the resume / settle section).

- [ ] **Step 2: Add a "Transcript persistence" subsection to `docs/resume-adapter-guide.md`**

Add, under the resume-wiring section, prose stating: a tunnel game that builds a `Transcript` and resumes MUST persist it or cooperative close fails with a transcript-root mismatch on the reloaded seat. The framework provides it via five edits on the game hook (link to the spec): keep a `transcript` ref/field reused on activate (`T ?? new Transcript(id)`); spread `captureTranscript: () => T ? transcriptToWire(T) : []` onto the `attachResume` adapter; in the adapter's `onReconciled`, call `appendAdoptedCheckpoint(T, tunnel.snapshot().latest)` on `"adopt"`; install `restored[0].transcript` into `T` in `resume`; null `T` in `reset`. Reference: `docs/superpowers/specs/2026-06-25-pvp-transcript-resume-persistence-design.md`.

- [ ] **Step 3: Add a checklist line to `docs/adding-a-tunnel-game.md`**

In the per-layer checklist's resume/settle row, add: "If the game builds a `Transcript`, wire transcript persistence (the five edits in the resume-adapter guide) so reload-then-settle does not hit a transcript-root mismatch."

- [ ] **Step 4: Commit**

```bash
git add docs/resume-adapter-guide.md docs/adding-a-tunnel-game.md
git commit -m "docs(pvp): document transcript resume persistence"
```

---

## Self-Review

- **Spec coverage:** §1 data model → Task 1 (`transcript?` field). §2 write/restore seam → Task 2 (`captureTranscript`, `RestoredSession.transcript`, `rebuildTunnel`). §3 replay → Task 1 (`rebuildTranscript`) + Task 2 (surfaced) + Tasks 3-7 (reuse/install). §4 adopt gap → Task 1 (`appendAdoptedCheckpoint`) + Tasks 3-7 (`onReconciled`). §4a five edits → Tasks 3 (poker), 4 (battleship), 5 (pvpMatchHook). §4b three edits → Tasks 6 (ttt), 7 (blackjack). §5 cleanup → Tasks 3-5 (reset nulls); ttt/blackjack need none (§4b). Rollout table (all 5 PvP lanes) → Tasks 3-7. soloSessionHook (self-play) → out of scope. Docs → Task 8. Testing #1-#5 → Tasks 1-2. ✓
- **Placeholder scan:** none — every step shows exact code/commands.
- **Type consistency:** `transcriptToWire`/`rebuildTranscript`/`transcriptLastNonce`/`appendAdoptedCheckpoint` and `WireTranscriptEntry`/`RestoredSession.transcript` are named identically across Tasks 1-7. The class hooks use `t`; ttt/blackjack use `rt` as the `onReconciled` tunnel param (avoids shadowing their outer `t` tunnel); poker uses `_tunnel` + outer `dt`. All valid. ✓
