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
- No edits to upstream `sui-tunnel-ts` (framework is re-synced from upstream;
  `CLAUDE.md`).
- Reuse the existing resume lifecycle (write debounce, pagehide flush, index,
  clear, TTL eviction) with no new storage key.

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

### 2. Write/restore seam — through the `ResumeAdapter` (mirrors secret)

The transcript is owned by the poker hook (`transcriptRef`), not by the generic
`DistributedTunnel` snapshot. The generic record writer (`buildRecord`) reaches
it the same way it already reaches hidden secrets — via optional adapter hooks.

`ResumeAdapter<State, Move>` (`pvp/resumeSession.ts`) gains:

```ts
captureTranscript?(): WireTranscriptEntry[];        // serialize current transcript
restoreTranscript?(entries: WireTranscriptEntry[]): void; // rebuild + install it
```

- `buildRecord` sets `record.transcript = adapter.captureTranscript?.()`.
- `rebuildTunnel`/`restoreInto` calls
  `adapter.restoreTranscript?.(record.transcript)` when present.

The generic layer stays game-agnostic (it only calls optional hooks); the poker
adapter (`makePokerResumeAdapter`) implements them over the hook's
`transcriptRef`. This is symmetric with the existing `captureSecret` /
`restoreSecret`, and generalizes to other tunnel games unchanged.

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

The poker adapter's `restoreTranscript` installs the rebuilt transcript into
`transcriptRef.current`. `activatePokerSession` then uses the already-installed
transcript instead of unconditionally creating an empty one:

```ts
const transcript = transcriptRef.current ?? new Transcript(dt.tunnelId);
transcriptRef.current = transcript;
```

`dispose()` already nulls `transcriptRef` (`usePvpQuantumPoker.ts:303`), so a
fresh live match still starts empty.

### 4. Close the adopt gap (decision b-1)

Of the reconciliation actions, only **`adopt`** mutates state without firing
`onConfirmed` (where `transcript.append` is wired): `adoptCheckpoint` sets
`_latest` directly (`distributedTunnel.ts:227-248`). `re-propose` re-sends the
pending MOVE and lands through the normal `onAck → onConfirmed` path, so its
entry is appended automatically; `wait`/`noop`/`settle` need nothing.

So the seat that performs `adopt` (always the one exactly one nonce behind, per
the reconcile invariant) must append the adopted checkpoint itself. The hook
passes an `onReconciled` into the poker adapter; `attachResume` already invokes
`adapter.onReconciled(tunnel, action)` after acting on a resync
(`resumeSession.ts:270`). On `"adopt"`:

```ts
const latest = tunnel.snapshot().latest;
if (latest && latest.update.nonce === transcriptLastNonce(transcript) + 1n) {
  transcript.append(latest);               // fills the one missing entry
} else if (latest && latest.update.nonce > transcriptLastNonce(transcript) + 1n) {
  triggerSettle();                          // gap > 1 is impossible; never fabricate a root
}
```

The strict `+1` guard: a >1 gap cannot happen (the peer can't advance the tunnel
alone), so if it ever appears the record is corrupt/tampered — bail to the
settlement floor rather than produce a wrong transcript. An equal nonce (double
delivery) is a no-op.

### 5. Cleanup, size, failure

- **Cleanup**: the transcript lives inside the record, so `clearResumeRecord`
  (on settle/done) and `evictExpiredRecords` (6h TTL) drop it with no new code.
- **Size**: `HAND_CAP` (PvP) = 50; ~19 entries/hand × ~547 B ≈ **~520 KB** worst
  case, well under the ~5 MB `localStorage` budget. Writes are debounced and
  poker moves are seconds apart, so re-serializing the record per confirmed move
  is cheap. If `HAND_CAP` is ever raised by a large factor, revisit (IndexedDB
  supports incremental appends).
- **Quota failure**: the existing record write already swallows `setItem`
  errors; worst case the transcript isn't saved and the old mismatch reappears on
  that reload — no crash.

## Data flow

```
Live play (per confirmed update u):
  dt.onConfirmed(u): transcript.append(u); … ; (attachResume wrapper) buildRecord+writeResumeRecord
    buildRecord -> record.transcript = adapter.captureTranscript()   // atomic with latestCoSigned

Reload (cold-load):
  resumeActiveTunnels -> rebuildTunnel -> restoreInto
    adapter.restoreTranscript(record.transcript): transcriptRef.current = rebuildTranscript(...)
  activatePokerSession: transcript = transcriptRef.current ?? new Transcript()   // reuse rebuilt
  resync handshake:
    action "adopt"      -> adapter.onReconciled: transcript.append(latest)  [guard +1]
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

Co-located `node:test`, mirroring `pokerColdLoad.test.ts` (localStorage/window
fakes):

1. **Round-trip root parity** — drive a distributed pair to N co-signed entries,
   capture `original.root()`; persist via the record; `rebuildTranscript` from
   the persisted entries; assert `rebuilt.root()` byte-identical. (Also proves
   the `parse → serialize` round-trip is canonical.)
2. **Adopt gap fill** — seat one nonce behind; after the adopt `onReconciled`,
   assert its transcript root equals the ahead seat's root.
3. **Guard** — a >1 nonce gap does NOT append (no fabricated root); equal nonce
   is a no-op.
4. **Lifecycle** — `clearResumeRecord` / TTL eviction remove the embedded
   transcript with the record.

## Files touched (all frontend; no upstream edits)

- `pvp/resume.ts` — `transcript?` field + `WireTranscriptEntry`; encode/decode
  helpers.
- `pvp/resumeSession.ts` — `captureTranscript`/`restoreTranscript` on
  `ResumeAdapter`; `buildRecord`/`rebuildTunnel` wiring.
- `games/quantumPoker/pokerResumeAdapter.ts` — implement the two hooks over
  `transcriptRef`; `onReconciled` adopt-append with the `+1` guard.
- `games/quantumPoker/usePvpQuantumPoker.ts` — `rebuildTranscript`; reuse
  `transcriptRef.current` in `activatePokerSession`; pass `onReconciled`.
