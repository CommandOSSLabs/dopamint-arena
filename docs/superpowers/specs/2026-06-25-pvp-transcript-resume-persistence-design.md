# PvP transcript resume persistence — design

- **Status**: Accepted
- **Date**: 2026-06-25

> Dev phase — no backward-compat. The `ResumeRecord` schema gains a field;
> records written before it are simply transcript-less (the same eviction path
> already drops records missing other newer fields).

## Context

A PvP poker match runs over a `DistributedTunnel`. Every co-signed update is
appended to a `Transcript` ([sui-tunnel-ts/src/proof/transcript.ts]) — an
ordered, append-only list of `{ nonce, message, sigA, sigB }`. At cooperative
close, both seats compute `transcript.root()` (a Merkle root over all entries),
exchange the hex roots, and **abort if they differ**
(`"settlement transcript-root mismatch between parties"`,
`usePvpQuantumPoker.ts:989-990`). The agreed root is what both sign into the
on-chain close; Walrus archives the full transcript behind it.

Resume-on-reload was added earlier (see
`2026-06-22-mp-resume-protocol-frontend-design.md` and
`2026-06-22-6b-per-game-resume-design.md`): each seat persists a compact
`ResumeRecord` per tunnel to `localStorage`, and on cold-load rebuilds the
`DistributedTunnel` from the **latest co-signed checkpoint**.

**The bug:** the `ResumeRecord` persists only `latestCoSigned` (one checkpoint),
never the transcript. The transcript lives only in memory (`transcriptRef`), and
`activatePokerSession` always builds a **fresh empty** `Transcript`
(`usePvpQuantumPoker.ts:465`) — on the live path AND the cold-load path. So a
reloaded seat rebuilds a transcript that covers only updates made *after* the
reload. Its root no longer matches the peer's full-history root, and the next
cooperative close throws `transcript-root mismatch`. Resume restores enough state
to keep *playing*, but settlement breaks.

### Key invariant that makes this tractable

Every update needs **both** signatures, so a tunnel **cannot advance while one
party is offline**. A reloaded seat therefore missed no co-signed updates — its
persisted transcript is the complete history, minus at most the single entry lost
to the persistence debounce window. The reconciliation table is explicit
(`core/reconcile.ts`): *"a drop leaves them AT MOST one move apart."* So recovery
needs only local persistence + replay, plus closing a ≤1-entry gap — no
peer-to-peer transcript transfer (that was the rejected Option 2).

## Goals / Non-goals

**Goals**
- A reloaded PvP seat rebuilds a transcript whose `root()` is byte-identical to
  its pre-reload root, so cooperative close succeeds.
- **Standardize across every affected lane.** The persistence/replay primitives
  live in the generic resume layer; the per-hook wiring is one uniform pattern
  applied to *every* PvP lane that builds a `Transcript` and resumes — poker,
  battleship, the shared `pvpMatchHook` (→ bombIt, chickenCross, worldCanvas),
  tic-tac-toe, and blackjack — plus a documented standard step for new tunnel
  games.
- No edits to upstream `sui-tunnel-ts` (framework is re-synced from upstream;
  `CLAUDE.md`).
- Reuse the existing resume lifecycle (write debounce, pagehide flush, index,
  clear, TTL eviction) with no new storage key.

### Affected lanes (rollout)

| Lane | Hook | Builds `Transcript`? | Fix |
| --- | --- | --- | --- |
| Quantum poker | `usePvpQuantumPoker.ts` | yes (`transcriptRef`) | wire (5 edits, §4a) |
| Battleship | `useBattleshipPvp.ts` | yes (class field) | wire (5 edits, §4a) |
| bombIt / chickenCross / worldCanvas | shared `pvp/pvpMatchHook.ts` | yes (class field) | wire once (5 edits, §4a) |
| Tic-tac-toe | `games/ticTacToe/app/hooks/usePvpTicTacToe.ts` | yes (`new proof.Transcript`) | wire (3 edits, §4b) |
| Blackjack | `games/blackjack/app/hooks/usePvpBlackjack.ts` | yes (`new proof.Transcript`) | wire (3 edits, §4b) |

**All five PvP lanes are affected.** ttt and blackjack settle by transcript root
(`buildSettlementHalfWithRoot`, with a `"Transcript root mismatch between
players"` guard) exactly like poker — an earlier scope pass missed them because
they construct the transcript as the namespace-qualified `new proof.Transcript(…)`,
which a `new Transcript(` grep does not match. They are NOT exempt.

`_shared/soloSessionHook.ts` also builds a transcript + root, but it is
**self-play** (one client signs both halves), so its root is always
self-consistent and cooperative close never fails on a reloaded seat — only the
Walrus proof archive would miss entries. Out of scope here.

**Non-goals**
- Bot / Auto / watch-bots lanes — `useQuantumPokerAuto.ts` writes no resume
  records, so it neither needs nor gets transcript persistence.
- Peer-to-peer transcript recovery (Option 2) and a generic
  resume-layer-owned transcript (Option “generic”) — see Alternatives.
- Raising `HAND_CAP` or changing the settle-body format.

## Design

### 1. Data model — embed in `ResumeRecord` (decision a-1)

Add one optional field to `ResumeRecord` (`pvp/resume.ts`):

```ts
/** Hex-encoded transcript entries from tunnel-open to the checkpoint above.
 *  Persisted in the SAME record as latestCoSigned so a single setItem keeps them
 *  atomic: transcript's last nonce always equals latestCoSigned.update.nonce. */
transcript?: WireTranscriptEntry[];

interface WireTranscriptEntry {
  nonce: string;   // decimal
  message: string; // hex (canonical serialized StateUpdate — the signed payload)
  sigA: string;    // hex
  sigB: string;    // hex
}
```

Atomicity is the reason for embedding over a separate `mp_transcript.v1:<id>`
key: the transcript rides inside the same JSON blob as the checkpoint, so one
`setItem` writes both and they can never skew. On restore the adopt path then
fills exactly one entry (§4) — no "trim transcript to checkpoint nonce"
reconciliation is needed.

### 2. Write/restore seam — asymmetric, generic both ends

The transcript is owned by the game hook (poker's `transcriptRef`; the class
hooks' local `transcript`), not by the generic `DistributedTunnel` snapshot.

- **Write** — through the adapter, mirroring `captureSecret`. `ResumeAdapter`
  gains one optional hook:
  ```ts
  captureTranscript?(): WireTranscriptEntry[];
  ```
  `buildRecord` sets `record.transcript = adapter.captureTranscript?.()`. The
  hook supplies a `captureTranscript` that serializes its live transcript.

- **Restore** — through the return value, NOT a second adapter hook. `Transcript`
  is a generic tunnel artifact, so the generic `rebuildTunnel` rebuilds it from
  `record.transcript` and returns it; `RestoredSession` gains
  `transcript: Transcript | null`. The hook installs it into its own
  `transcriptRef`/field before `activateSession`.

Why restore via the return value rather than a `restoreTranscript` adapter hook:
`resumeActiveTunnels` rebuilds *every* record with one shared adapter, so an
adapter that mutated a shared ref would clobber it across multiple rebuilds.
Returning the transcript per `RestoredSession` keeps each match's transcript with
its tunnel; the hook (which already uses `restored[0]`) installs exactly the one
it activates. `restoreInto` stays untouched (the `pokerColdLoad` test that calls
it directly is unaffected).

### 3. Replay on cold-load

A frontend helper rebuilds a `Transcript` from persisted entries using only
public SDK APIs:

```ts
function rebuildTranscript(tunnelId: string, entries: WireTranscriptEntry[]): Transcript {
  const t = new Transcript(tunnelId);
  for (const e of entries) {
    t.append({
      update: parseStateUpdate(fromHex(e.message)), // canonical round-trip
      sigA: fromHex(e.sigA),
      sigB: fromHex(e.sigB),
    });
  }
  return t; // t.root() === pre-reload root
}
```

`Transcript.append` recomputes each leaf from `message ‖ sigA ‖ sigB`, so a
replayed transcript yields the identical root. `parseStateUpdate` →
`serializeStateUpdate` is canonical (the same wire codec the live path co-signs
through; the existing `pokerColdLoad` test already relies on its byte-stability).

`rebuildTunnel` calls `rebuildTranscript` and returns it as
`RestoredSession.transcript`; the hook's `resume` installs it into its own
`transcriptRef`/field, and `activateSession` reuses it instead of
unconditionally creating an empty one:

```ts
const transcript = T ?? new Transcript(dt.tunnelId); // T = transcriptRef.current / this.transcript
T = transcript;
```

`reset`/`dispose` nulls `T`, so a fresh live match still starts empty.

### 4. Close the adopt gap (decision b-1)

Of the reconciliation actions, only **`adopt`** mutates state without firing
`onConfirmed` (where `transcript.append` is wired): `adoptCheckpoint` sets
`_latest` directly (`distributedTunnel.ts:227-248`). `re-propose` re-sends the
pending MOVE and lands through the normal `onAck → onConfirmed` path, so its
entry is appended automatically; `wait`/`noop`/`settle` need nothing.

So the seat that performs `adopt` (always the one exactly one nonce behind, per
the reconcile invariant) must append the adopted checkpoint itself. Each hook's
`onReconciled` (already invoked by `attachResume` as
`adapter.onReconciled(tunnel, action)`, `resumeSession.ts:270`) calls one pure
helper on `"adopt"`:

```ts
appendAdoptedCheckpoint(transcript, tunnel.snapshot().latest);
```

`appendAdoptedCheckpoint(t, latest)` appends `latest` **iff** its nonce is
exactly `transcriptLastNonce(t) + 1` (returns `"appended"`); an already-present
nonce is a `"noop"`; a `>1` gap is a `"gap"` and is **not** appended. The `>1`
gap cannot happen (the peer can't advance the tunnel alone), so the helper never
fabricates a root; if a corrupt/tampered record ever produced one, not appending
leaves the transcript short and the **existing** settle-time root-mismatch guard
(`"transcript-root mismatch between parties"`) rejects the close safely — no new
bail path is needed.

### 4a. The uniform per-hook wiring (poker, battleship, pvpMatchHook)

Every affected hook gets the **same five edits** (poker uses `transcriptRef`; the
class hooks use a `private transcript: Transcript | null` field — call it `T`):

1. **Reuse on activate** — in `activateSession`, replace
   `const transcript = new Transcript(dt.tunnelId)` with
   `const transcript = T ?? new Transcript(dt.tunnelId); T = transcript;`.
2. **Capture** — spread onto the `attachResume` adapter:
   `captureTranscript: () => T ? transcriptToWire(T) : []`.
3. **Adopt-append** — in the adapter's `onReconciled(tunnel, outcome)`, add
   `if (outcome === "adopt" && T) appendAdoptedCheckpoint(T, tunnel.snapshot().latest);`
   before the existing `sync()`.
4. **Install on resume** — in `resume`, destructure
   `const { tunnel, channel, transcript } = restored[0]` and set `T = transcript`
   before `activateSession`.
5. **Clear** — in `dispose`/`reset`, set `T = null` (poker's `reset` already
   nulls `transcriptRef`; the class hooks add the null).

For the class hooks the adapter is built by `makeAdapter()` (poker builds it
inline at the `attachResume` site); edits 2–3 spread the two methods onto that
adapter and wrap its `onReconciled`.

### 4b. The ttt/blackjack variant (3 edits, not 5)

ttt and blackjack are functional-ref hooks (`transcriptRef`), but unlike poker
they create the transcript (`transcriptRef.current = new proof.Transcript(id)`)
in the **live-only** path, *outside* the shared `activate*Session`. Cold-load
re-enters the shared activate without re-creating it, so the rebuilt transcript
installed in `resume` is never clobbered — no reuse-`??` and no reset-null edit
is needed. Three edits each:

1. **Capture + adopt-append** — at the `attachResume` site (inside the shared
   activate), build the base adapter, then spread `captureTranscript` and wrap
   `onReconciled` to call `appendAdoptedCheckpoint(transcriptRef.current,
   tunnel.snapshot().latest)` on `"adopt"` (the `make*ResumeAdapter` factory
   takes a single `() => void` callback, so wrap at the spread, not through it).
2. **Install on resume** — destructure `const { tunnel, channel, transcript } =
   restored[0]` and set `transcriptRef.current = transcript`.
3. **Import** `transcriptToWire` + `appendAdoptedCheckpoint`.

The live path's unconditional `= new proof.Transcript(id)` already gives each
fresh match its own transcript, so nothing to reset.

### 5. Cleanup, size, failure

- **Cleanup**: the transcript lives inside the record, so `clearResumeRecord`
  (on settle/done) and `evictExpiredRecords` (6h TTL) drop it with no new code.
- **Size & per-move cost**: `HAND_CAP` (PvP) = 50; ~19 entries/hand × ~547 B ≈
  **~520 KB** worst case, well under the ~5 MB `localStorage` budget. Note
  `captureTranscript` re-serializes the **whole** transcript on every confirmed
  move, so the per-match CPU cost is O(history²) (~520 KB hex-encoded ~950×) —
  but writes are debounced/coalesced and poker moves are seconds apart, so it is
  cheap at this cap. If `HAND_CAP` is ever raised by a large factor, revisit both
  the size and this per-move cost (IndexedDB supports incremental appends).
- **Quota failure**: the existing record write already swallows `setItem`
  errors; worst case the transcript isn't saved and the old mismatch reappears on
  that reload — no crash.

## Data flow

```
Live play (per confirmed update u):
  dt.onConfirmed(u): transcript.append(u); … ; (attachResume wrapper) buildRecord+writeResumeRecord
    buildRecord -> record.transcript = adapter.captureTranscript()   // atomic with latestCoSigned

Reload (cold-load):
  resumeActiveTunnels -> rebuildTunnel: restoreInto + transcript = rebuildTranscript(record.transcript)
    returns RestoredSession { tunnel, channel, transcript }
  resume: T = restored[0].transcript
  activateSession: transcript = T ?? new Transcript()              // reuse rebuilt
  resync handshake:
    action "adopt"      -> onReconciled: appendAdoptedCheckpoint(T, latest)  [append iff +1]
    action "re-propose" -> resendPending -> onAck -> onConfirmed -> transcript.append (automatic)
  settle: transcript.root() == peer's root  -> close succeeds
```

## Alternatives considered

- **(a-2) Separate `mp_transcript.v1:<id>` key.** Keeps the frequent checkpoint
  write small, but checkpoint and transcript become two writes on two debounce
  cadences → they can skew (transcript ahead/behind the checkpoint nonce),
  forcing a "trim transcript to checkpoint nonce" reconciliation on restore.
  Rejected for the atomicity of a-1.
- **(b-2) Make SDK `adoptCheckpoint` fire `onConfirmed`.** Conceptually cleaner,
  but (1) edits upstream and (2) the hook's `onConfirmed` does much more than
  append (activity rows, terminal→settle, `maybeAutoPropose`) — firing it during
  a resync adopt would mis-fire all of it. Rejected.
- **Generic resume-layer-owned transcript.** The resume layer already wraps
  `onConfirmed`; it could own one transcript for all games and hand it to settle.
  Cleaner long-term, but requires reworking how each game's settle obtains its
  transcript. Higher risk than needed to fix the mismatch; deferred (YAGNI).
- **(Option 2) Peer ships the transcript at resync.** Unnecessary given local
  persistence + the both-sigs invariant; adds a large resync payload and a
  peer-online dependency. Rejected.

## Testing (TDD)

The correctness lives in the generic primitives — test them as pure `node:test`
units (`resume.test.ts` / `resumeSession.test.ts`, existing localStorage/window
fakes + the `counterProto`/`OffchainTunnel.selfPlay` fixtures):

1. **Round-trip root parity** (`resume.test.ts`) — build a `Transcript` of N
   co-signed updates, `transcriptToWire` → `rebuildTranscript`, assert
   `rebuilt.root()` byte-identical. (Also proves `parse → serialize` is
   canonical.)
2. **Adopt-append** (`resume.test.ts`) — `appendAdoptedCheckpoint(t, uK1)` on a
   transcript ending at nonce K returns `"appended"` and yields the same root as
   a transcript that had K+1 naturally.
3. **Guard** (`resume.test.ts`) — `appendAdoptedCheckpoint` returns `"gap"`
   (no append) for a >1 nonce, `"noop"` for an already-present nonce / null.
4. **Lifecycle** (`resume.test.ts`) — a record *with* a transcript is removed by
   `clearResumeRecord` / TTL eviction.
5. **`rebuildTunnel` surfaces the transcript** (`resumeSession.test.ts`) — a
   record with `transcript` set yields `RestoredSession.transcript` whose root
   matches; a record without it yields `null`.

The per-hook wiring (poker, battleship, pvpMatchHook, ttt, blackjack) is thin
glue over already-tested primitives; verify each by `pnpm typecheck` + the full
`pnpm test` suite (regression: existing `pokerColdLoad` / `tttColdLoad` /
`resumeSession` tests stay green). Acceptance for the representative lane (poker): two tabs, play
past one co-signed hand, reload one seat, play to match end → cooperative close
succeeds (no `transcript-root mismatch`).

## Files touched (all frontend; no upstream edits)

- `pvp/resume.ts` — `transcript?` field + `WireTranscriptEntry`;
  `transcriptToWire` / `rebuildTranscript` / `transcriptLastNonce` /
  `appendAdoptedCheckpoint` (+ tests in `resume.test.ts`).
- `pvp/resumeSession.ts` — `captureTranscript?` on `ResumeAdapter`;
  `transcript: Transcript | null` on `RestoredSession`; `buildRecord` +
  `rebuildTunnel` wiring (+ test in `resumeSession.test.ts`).
- `games/quantumPoker/usePvpQuantumPoker.ts` — the five edits (§4a); `reset`
  already nulls `transcriptRef`.
- `games/battleship/useBattleshipPvp.ts` — the five edits (§4a) + a
  `private transcript: Transcript | null` field.
- `pvp/pvpMatchHook.ts` — the five edits (§4a) + a `private transcript` field;
  fixes bombIt / chickenCross / worldCanvas in one place.
- `games/ticTacToe/app/hooks/usePvpTicTacToe.ts` — the three edits (§4b).
- `games/blackjack/app/hooks/usePvpBlackjack.ts` — the three edits (§4b).
- `docs/resume-adapter-guide.md`, `docs/adding-a-tunnel-game.md` — document
  transcript persistence as the standard resume step.
