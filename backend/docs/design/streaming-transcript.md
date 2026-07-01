# Server-owned streaming transcript

- **Status:** Design (grounded in the current code, 2026-07-01). Supersedes the earlier
  per-settle drafts in this file's git history.
- **Scope:** the whole transcript flow — bot recorder (`rust/engine/tunnel-harness`,
  `backend/tunnel-manager/src/fleet`), settle path (`routes.rs`, `sui.rs`), the browser
  SDK/FE (`sui-tunnel-ts`, `frontend/src/pvp`, `frontend/src/backend`), the explorer read
  (`backend/explorer`), the `transcript-store` crate, and S3 storage lifecycle (`infra`).
- **Flow:** user-vs-bot arena only, over the WS relay.

## 1. Decision

**The transcript lives fully in server storage. The client holds none of it, and nobody
uploads it at settle.** As a match plays, the **bot streams every co-signed entry to S3 in
chunks, continuously**. Settle is **header-only** (root + balances + both sigs) — no full
transcript is POSTed, from the browser or the bot. The transcript is *already* in S3.

The browser keeps only its O(1) co-signed **checkpoint** (`resume.ts` `latestCoSigned`), which
is what resume + unilateral dispute already run on. It no longer accumulates entries, computes
a root, or POSTs a settle body.

The transcript exists for one purpose: **a user verifying a settled match** — the explorer's
`VerifyPanel` fetches it back, recomputes the Merkle root, and checks it against the on-chain
anchor + every signature + balance conservation, entirely in-browser.

## 2. What the code does today (the starting point)

- **The bot is already RAM-safe.** The arena bot uses `StreamingRootRecorder`
  (`transcript.rs`): it folds each co-signed leaf into an O(log N) streaming Merkle root and
  **drops the entry** (`snapshot()` returns empty). It ships **zero entries**; it emits its
  co-signed half + root over the relay (`arena_anchor.rs`). It never POSTs `/settle`.
- **The browser is the sole full-transcript holder + uploader.** It accumulates every 250 B
  entry in a growing `entries[]`, recomputes the root over the whole array at settle, and
  POSTs the entire body to `/v1/tunnels/{id}/settle` (`settleRequest.ts`, `controlPlane.ts`).
- **Settle already anchors root-only on-chain.** `/settle` parses the 229 B header, submits
  `close_cooperative_with_root` (root + balances + sigs; **no entries on-chain, ever**), then
  archives the browser's POSTed body verbatim to S3 + Walrus.

So the unbuilt core is **not** "make the bot RAM-safe" (done) — it is **move byte-ownership
from the browser to the bot**: the bot's recorder, which drops each entry, must instead
forward it to a streaming S3 uploader; then the browser can stop.

## 3. Sizing — why this is "essentially one object per match"

- Entries are a **fixed 250 B** (`wire.rs`): 2 B len + 120 B `state_update` message + 64 B
  sigA + 64 B sigB. Game state is folded into a 32-byte hash, never carried — so size is
  perfectly predictable.
- `MAX_MOVES_PER_TUNNEL = 100k` → **~25 MB**, at which the tunnel **rotates** (settle +
  reopen). So a tunnel's transcript is already bounded at ~25 MB. The 32 MB `DefaultBodyLimit`
  on `/settle` (`main.rs:269`) is the current enforcement of that ceiling.
- Therefore a "transcript" **is one bounded object per tunnel**. Most matches are far smaller
  (ttt ~25 KB, battleship ~60 KB, poker ~12 MB). **Chunks are an internal durability
  mechanism, not a user-visible structure**: a short match flushes a single chunk (reassembly
  is a no-op); only long / never-terminal matches produce several (≤~25).

**Chunk-streaming earns its place through durability, not RAM.** The bot already computes the
root in O(log N). Streaming small chunks (~1 MB, size-or-timer flush) means an abandoned tab or
a never-terminal canvas loses at most the un-flushed tail (bounded by the flush timer;
lossless on a SIGTERM drain), instead of the whole match.

## 4. Storage — the real scale problem

Not RAM (a relay task carries many matches but each is O(log N) root + one small buffer). The
gaps are storage and lifecycle:

- **No S3 lifecycle / tiering / retention exists today** — the bucket is versioned + SSE-S3 +
  private, but objects are kept **forever**. At millions of matches × up to 25 MB this is the
  dominant cost.
- **Decision — retention:** keep transcripts, **tiered** (S3 Standard → Standard-IA at 30 d →
  Glacier Instant Retrieval at 90 d). Verify reads are rare and latency-tolerant, so cold
  tiers are safe; this is the cheapest option that still lets a user verify anytime, and it's
  reversible (add an expiration later).
- **Decision — world-canvas:** free-mode, balances never change → **zero fund-dispute
  surface**; its transcript is provenance-only, yet it's the *dominant* storage driver
  (unbounded 25 MB segments). For now it takes the same streaming path as every game; a
  cheaper treatment (shorter retention, or root-only anchoring) is a follow-up optimization,
  not a blocker.

## 5. Storage layout (`transcript-store`, chunk primitives DONE)

Keyed by `tunnel_id` (the transcript *is* the tunnel; there is no `tx_digest` until settle):

- `chunk_key` → `{prefix}transcripts/{tunnel_id}/chunk-{seq:08}.bin` — immutable, monotonic,
  zero-padded so lexicographic LIST order = chunk order (no manifest needed; the root already
  lives on the on-chain settlement row).
- `TranscriptChunkWriter::put_chunk` (S3 `PutObject`) — durable the instant it returns.
- `TranscriptChunkReader::read_transcript` — LIST + concat in seq order (S3 strong LIST
  consistency; reading a *settled* tunnel guarantees all chunks present).
- `testing::FakeChunkStore` mirrors it for downstream round-trip tests. Reused by the fleet
  uploader and the explorer — and by the bot fleet.

## 6. Sequencing dependency (do not get this wrong)

The 32 MB browser `/settle` body limit is the **only** thing enforcing the size cap today.
Removing the browser POST (Phase 3) removes that enforcement — so **never-terminal rotation
must land with-or-before dropping the POST**, or a canvas would stream unbounded. Rotation is
governed by **ADR-0029 (never-terminal cooperative rotation)** — which **does not exist yet**
and must be authored before Phase 3. `CHECKPOINT_EVERY` (`world-canvas-design.md`) is
likewise unimplemented.

## 7. Full flow (target)

```
PLAY  (human ⇄ WS relay ⇄ bot; relay forwards opaque frames)
  bot co-signs each move; per committed move the recorder:
     • folds the leaf into the O(log N) root                    [DONE]
     • serializes the 250 B entry → per-match uploader channel  [new]
  uploader buffers ~1 MB; size/timer → put_chunk(seq)           [durable-on-flush]
  bot RAM: O(log N) root + one chunk buffer, released on terminal.
  browser: O(1) checkpoint + co-signs each move. NO transcript.

SETTLE (natural end, rotation at 100k, or periodic for never-terminal)
  • both co-sign settlement-with-root over the relay; bot combines halves
  • settler submits close_cooperative_with_root — HEADER ONLY
  • uploader flushes its tail; chunks are already durable. NO transcript upload.

READ / VERIFY (explorer)
  read_transcript(tunnel_id) → LIST + concat chunks → recompute root → check on-chain root.
```

## 8. Consequences (accepted)

1. **Browser co-signs a root it no longer computes** — trusts the bot's root. Fund-safety is
   unchanged: it rests on the O(1) checkpoint (co-signed balances) the Move dispute path
   consumes, not on the transcript. *(Confirm against the Move dispute path before Phase 3.)*
2. **Arena-only (human-vs-bot).** Human-vs-human has no server participant, so the server
   can't own that transcript; out of scope.
3. **Verify is unchanged for the user** — same in-browser `VerifyPanel` re-derivation; only
   the read source moves to reassembled chunks.

## 9. Phasing

- **DONE:** streaming Merkle root recorder (O(log N)); `transcript-store` crate; **chunk
  read/write primitives** (`chunk_key`, `TranscriptChunkWriter`/`Reader`, `FakeChunkStore`).
1. **Fleet streaming uploader** — recorder forwards each entry over an mpsc channel to a
   per-match uploader task that `put_chunk`s on size/timer and flushes the tail on terminal.
   Golden byte-parity test: reassembled chunks == the entries the root commits to. *(backend)*
2. **Bot-submits header-only settle** *(backend)* — folds both settle halves; settler submits
   the header-only close. (Browser still POSTs during transition; not yet removed.)
3. **ADR-0029 + never-terminal rotation, then drop the browser transcript** *(FE/SDK +
   backend)* — author ADR-0029; wire periodic settle+reopen for canvas; only then remove the
   browser `entries[]` accumulation, root compute, and `/settle` POST. (Sequencing per §6.)
4. **Explorer read migration** — `/transcript` reads `read_transcript(tunnel_id)` (chunks)
   with the legacy single-object + Walrus as fallback. *(explorer)*
5. **S3 lifecycle** — Standard → IA → Glacier-IR per §4. *(infra)*
