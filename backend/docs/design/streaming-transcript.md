# Streaming transcript: bounded-RAM commitment + durable chunked S3 archive

- **Status:** Draft (design approved in principle)
- **Date:** 2026-07-01
- **Scope:** the co-located arena bot's transcript path (`backend/tunnel-manager`,
  `rust/engine/tunnel-harness`, `backend/tunnel-manager/src/s3.rs`).
- **Related:** ADR-0007 (settle authorized by settlement), ADR-0019 (channel-closing
  invariants), ADR-0020 (self-play TPS engine, two-party on top), ADR-0023/0024 (S3
  archive).

## 1. Problem

The co-located arena bot must not exhaust server RAM by holding whole game transcripts,
and the transcript archive must be produced without buffering the whole thing in memory.

Modelling read/write first (repo convention):

- **Writer:** one co-signed update per move (250 B on the wire: 2 B len + 120 B
  `state_update` + 64 B sigA + 64 B sigB). Append-only, bounded per tunnel by
  `MAX_MOVES_PER_TUNNEL = 100_000` (`sui-tunnel-ts/src/proof/limits.ts:8`) ≈ 25 MB.
- **Two consumers** of that stream: (1) a 32-byte **Merkle root**, co-signed at settle
  and anchored on-chain (`close_cooperative_with_root`); (2) the raw entries as a
  provenance **archive**. The chain never re-derives the root from entries — it stores
  only the agreed root (`transcript.ts:10-13`). Fund-safety/dispute never read the
  transcript (they use the single latest checkpoint, O(1)) — so the transcript is
  provenance, not defense.
- **Volume:** world-canvas ≤ 100 000 updates (~19–25 MB), *never-terminal*
  (`rust/protocols/world-canvas/src/lib.rs:21`; `rust/fleet/core/src/play_match.rs:85-88`);
  bomb-it / chicken-cross ≤ 5 400 (~1 MB); all other games tens of moves.

**Current state on `dev-raid`:**

- The bot wires `InMemoryTranscriptRecorder::new()` for every game at one call site
  (`backend/tunnel-manager/src/fleet/colocated.rs:260`) — an unbounded
  `Vec<TranscriptEntry>` kept **solely** to hash the root; the bot's anchor emits only the
  root and ignores the entries (`fleet/arena_anchor.rs:139-156`).
- The root is a blake2b256 Merkle tree over the whole leaf set, computed at settle
  (`sui-tunnel-ts/src/proof/transcript.ts:39`; Rust mirror in `tunnel-harness/transcript.rs`).
- S3 archival is a single `PutObject` of the *whole* body at settle
  (`backend/tunnel-manager/src/s3.rs`; wired at `routes.rs:488-499`) — so it holds the
  full transcript in RAM at settle, and only fires for games that cooperatively settle.
- **Lifecycle gap (accepted, out of scope):** world-canvas is never-terminal and ends on
  tab-close, so it never cooperatively settles — its funds never settle and no on-chain
  root is anchored. This design does **not** change that (see §7, dropped periodic
  settlement). It only stops world-canvas from consuming RAM and, optionally, archives its
  bytes best-effort.

### The core insight

The big-RAM game (world-canvas) is **never archived**; the archived games (≤ 1 MB) aren't
big-RAM. The RAM problem is not *where* the transcript lives — it is that the bot
materializes ~19 MB to produce a **32-byte** commitment it could compute incrementally.
So the fix decomposes into two independent pillars.

## 2. Goals / non-goals

**Goals**

- G1. Bound per-match server RAM to O(log N) for the commitment — no OOM at CCU scale.
- G2. Keep the on-chain commitment **byte-identical** to today (golden-vector parity
  Rust↔TS); no consensus/verifier/FE break.
- G3. Produce the durable archive by **streaming bounded chunks** to S3 during play,
  never buffering the whole transcript, and keep already-written bytes independently
  readable even when a stream is abandoned.

**Non-goals**

- Periodic cooperative settlement for never-terminal channels (world-canvas provenance /
  fund-settlement). Explicitly dropped for now — see §7.
- Changing dispute / premature-close / fund-safety (already O(1) via the checkpoint).
- Human-vs-human matchmaking (server holds no transcript there; relay is opaque).
- The staged ACK-resend reliability WIP in `party_driver.rs` — orthogonal; P1 lands
  around it.

**Success criteria**

- A world-canvas match to 100 000 moves holds < 1 MB resident commitment state (vs ~19 MB).
- `streaming_root(entries) == transcriptRoot(entries)` for N ∈ {0,1,2,3,5,6,7,8,100,100000}
  in Rust and TS. Existing terminal-game settle + explorer verify pass unchanged.
- No stream holds > one chunk (~512 KiB) of archive buffer; abandoned streams' flushed
  chunks are durably readable in S3.

## 3. Design

### Pillar 1 — Incremental commitment (streaming Merkle recorder)

Replace `InMemoryTranscriptRecorder` at `colocated.rs:260` with a recorder that keeps a
**per-level carry array** (one perfect-subtree root per level) instead of the entries.

> This is **not** a Merkle Mountain Range. MMR "bag-the-peaks" and a naive
> one-op-per-level fold both produce the *wrong* root under this padding rule (verified at
> N=5). The rule in `transcript.ts:39-51` pads **every** odd level with `ZERO32` (the raw
> 32 zero bytes, same value at every level), then combines pairs with
> `blake2b256("sui_tunnel::transcript::node" ‖ L ‖ R)`.

- **`record(entry)`** — hash the leaf
  (`blake2b256("sui_tunnel::transcript::leaf" ‖ msg ‖ sigA ‖ sigB)`), then a
  **binary-counter carry**: insert at level 0; while the current level's slot is occupied,
  combine `NODE(slot, carried)` and promote to the next level. `carry[k]`, when set, is the
  perfect-subtree root over 2^k leaves. Amortized O(1); ≤ ⌈log₂N⌉ carries resident.
- **`root()`** — fold the occupied carries low→high into `acc` (tracking its level). For
  each set `carry[k]`: if `acc` unset, `acc = carry[k]`; else **lift `acc` up to level `k`
  by combining `NODE(acc, ZERO32)` once per intermediate level** (the odd-level zero-leaf
  pad), then `acc = NODE(carry[k], acc)` (carry left, acc right). Empty → `ZERO32`.
- **Retains no entries** → RAM = O(log N) ≈ 17 × 32 B ≈ **544 B/match**.

Reference roots (must equal `transcriptRoot`; `cᵢ` = perfect subtree at level i, `Z=ZERO32`):
`N=3 → N(c1, N(c0,Z))`; `N=5 → N(c2, N(N(c0,Z),Z))`; `N=6 → N(c2, N(c1,Z))`;
`N=7 → N(c2, N(c1, N(c0,Z)))`.

This byte-for-byte parity is P1's **foundation**: P1 does not touch the FE, which still
recomputes its own whole-tree root and asserts equality against the bot's half
(`pvpMatchHook.ts:924-929`). The `TranscriptRecorder` trait is unchanged; only the impl
swaps, so `arena_anchor` / `party_driver` change only at the constructor.

**P1 changes nothing observable at settle** — the root, the `settleHalf` wire, the
`/settle` route, and the on-chain call are identical; only the bot's internal root
derivation differs. Zero FE / wire / route change.

### Pillar 2 — S3 as the verification source (read-redirect), Walrus synced async

> **SUPERSEDES the streaming design below (2026-07-01).** The bot-streams-chunks mechanism
> was dropped: it serves no game that verifies. Verification only exists for games that
> *settle* (they have an on-chain root to check against) — and those are the *small* ones,
> already archived whole. The *large* game (world-canvas) never settles → never verifies,
> so streaming it produces un-anchored dead chunks. And a verification source must be the
> **authoritative co-signed FE body**, not the bot's independent re-derivation (divergence
> risk, heightened by the ACK-resend WIP). The chunked/streaming detail below is retained
> only for its S3 best-practice rationale; it is **not** the implementation.

The chosen outcome ("the explorer verifies from S3") is achieved by a small read-redirect,
because the settle route **already** archives the whole co-signed body to S3
(`routes.rs:448-463`, key `{prefix}transcripts/{tunnel}/{tx_digest}.bin`, byte-identical to
the Walrus blob). So:

- **Explorer reads S3 primary.** `GET /v1/settlements/:digest/transcript`
  (`backend/explorer/src/api.rs:70`) does an S3 `GetObject` at
  `{prefix}transcripts/{row.tunnel_id}/{digest}.bin` (both fields are on `SettlementRow`,
  `backend/shared/src/lib.rs:65-79`) and returns those bytes; the browser verifies them
  exactly as it verifies the Walrus blob today (same bytes). **Dual-read:** fall back to the
  Walrus aggregator when the S3 object is absent, so the cutover can't regress verification.
- **New explorer S3 access.** `backend/explorer` has no AWS SDK today — add `aws-sdk-s3` +
  `aws-config`, an `Option<S3TranscriptReader>` on `ApiState` (behind a `TranscriptReader`
  trait so it's fake-testable), env `S3_TRANSCRIPTS_BUCKET`/`S3_TRANSCRIPTS_PREFIX`, and IAM
  `s3:GetObject` on the transcripts bucket for the explorer API task role
  (`infra/src/components/ExplorerServices.ts`).
- **S3 becomes primary, Walrus async (later phase).** Make the settle-route S3 write
  reliable (awaited) and move the Walrus upload off the hot path into an **async sidecar**
  (S3→Walrus replication worker with retries) — then retire Walrus-on-settle.

Everything from here to the end of Pillar 2 is the **superseded** streaming design:

Why not multipart: uploaded parts are **not a readable object until
`CompleteMultipartUpload`** — so an abandoned stream (our dominant lifecycle) would archive
*nothing* (invisible, billed, orphaned parts needing a lifecycle reaper). Multipart's 5 MiB
minimum part would also force 5 MiB buffers × concurrency ≈ the OOM relocated. Sequential
objects have no minimum size, are durable/listable the instant `PutObject` returns, and
S3's strong read-after-write consistency makes each flush immediately recoverable.

- **Chunking:** buffer entries in RAM to a **512 KiB** target (~2 000 × 250-byte entries),
  then `PutObject` to `transcripts/{tunnel_id}/{seq:08}.bin` (zero-padded `seq` so lexical
  = numeric order). Flush on **size OR a short timer (2–5 s)** so never-terminal / abandoned
  streams archive continuously. Per-stream buffer = one chunk.
- **Ownership:** the **bot** (recorder) writes the chunks — it is the transcript owner, as
  requested. The archiver (`TranscriptArchiver` / `S3Archiver`, already in
  `s3.rs`/`AppState`) is injected into the recorder with the `tunnel_id`.
- **Manifest at settle:** write `transcripts/{tunnel_id}/manifest.json` (ordered chunk
  keys, per-chunk entry count + app-hash, total count, and the anchored `transcript_root`).
  Replaces the single whole-body `PutObject` in the settle route (`routes.rs:488-499`).
  Abandoned streams need no manifest — `ListObjectsV2(prefix)` + numeric sort reassembles
  them; a manifest can be sealed best-effort by the bot's end-of-match path.
- **Settle-route change (backend-only):** stop archiving the whole body; the route uses the
  header (root/balances/sigs) for the on-chain close and seals the manifest. The FE still
  POSTs the same body (used for the close); a future optional optimization slims that to a
  header-only POST since the entries are already in S3. **No FE change required for P2.**
- **Verify:** explorer fetches the manifest, streams chunks via the existing backend proxy,
  recomputes the Merkle root, checks against the on-chain root (multi-chunk read).
- **Two independent checksums:** the app Merkle root (verification) and S3 `Crc32C`
  (`.checksum_algorithm(Crc32C)`, transport + at-rest integrity) — complementary.

**Rust API (sequential):**
```rust
client.put_object()
    .bucket(&bucket)
    .key(format!("transcripts/{tunnel_id}/{seq:08}.bin"))
    .body(ByteStream::from(chunk))            // chunk: bytes::Bytes — retryable, no disk
    .checksum_algorithm(ChecksumAlgorithm::Crc32C)
    .set_metadata(Some(md))
    .send().await?;
```

**Concurrency & backpressure:** one shared `Arc<Client>` (internal hyper pool); **serial
within a stream** — await each PUT before advancing `seq` (no gaps, order preserved,
retries idempotent since same key = overwrite); parallel across streams; a global
`tokio::sync::Semaphore` (~64–256 permits) around `.send()` bounds total in-flight PUT
memory; a bounded `mpsc` from the game task propagates backpressure. `RetryConfig` standard
(or adaptive for `503 SlowDown` smoothing during prefix scale-up).

**Deploy / crash durability:** extend `main.rs` `shutdown_signal()` (already handles
SIGTERM; Fargate `stopTimeout: 30`, `infra/src/components/Backend.ts`) to flush in-flight
chunk buffers before exit → **rolling deploys are lossless**. A hard SIGKILL loses only the
current sub-chunk tail, bounded by the flush timer. No orphaned-part reaper (sequential
objects have no orphan concept); optional S3 lifecycle expiry on the `transcripts/` prefix
bounds storage of abandoned / un-anchored transcripts.

## 4. Scalability

| | Server RAM / match | Settle-time archive RAM |
|---|---|---|
| Today | up to ~19 MB (world-canvas) → 500 canvases ≈ **9.5 GB → OOM** | whole body (≤ 32 MB) per concurrent settle |
| P1 | **~544 B** (O(log N) commitment) | unchanged |
| P2 | + one ~512 KiB chunk buffer during flush | **~0** (bytes pre-streamed; settle seals a tiny manifest) |

Peak P2 archive memory ≈ streams × chunk_size (e.g. 1 000 × 512 KiB ≈ 0.5 GB worst case,
tunable to 256 KiB). PUT cost is negligible ($0.005/1 000; ~49 PUTs per 25 MB stream).
Per-prefix throughput (3 500 PUT/s) is a non-issue — each tunnel is its own prefix.

## 5. Failure modes & robustness

- **Abandonment (common, incl. every world-canvas):** chunks flushed during play are
  durable; the stream is recoverable via `ListObjectsV2`. No on-chain root (no cooperative
  settle) — accepted (§7).
- **Deploy:** graceful SIGTERM drain flushes buffers → lossless.
- **Hard crash (OOM/SIGKILL):** lose ≤ one sub-chunk tail (bounded by the flush timer).
- **S3 transient failure:** SDK standard retries inline; a chunk PUT is idempotent
  (same key). Archive is best-effort and never blocks settlement (as today).
- **Bot-vs-FE entry parity:** the bot serializes each entry in the same 250-byte wire form
  the FE settle body uses, so reassembled chunks are byte-identical to the settle body's
  entry section and verify against the same root.

## 6. Testing

- **Golden parity (blocking, P1):** `streaming_root(entries) == transcriptRoot(entries)`
  for N ∈ {0,1,2,3,5,6,7,8,100,100000}, Rust and TS, shared vectors. **N=5 and N=6 are
  load-bearing** (carry-gap cases where the naive folds diverge). One mismatch breaks the
  settleHalf assert and every settle.
- **RAM bound (P1):** drive a synthetic 100k-move match; assert commitment state < 1 MB
  (⌈log₂N⌉ × 32 B).
- **Regression (P1):** existing co-located settle tests + explorer verify pass unchanged.
- **P2:** chunk-boundary reassembly (concatenated objects == original entry stream);
  timer + size flush; `ListObjectsV2` reassembly of an abandoned stream; manifest round-trip
  and verify-from-manifest recomputes the anchored root; graceful-drain flushes the tail;
  semaphore bounds in-flight PUTs.

Tests named by behavior; the golden parity test is the spec for the wire commitment.

## 7. Dropped: periodic settlement for never-terminal channels

A never-terminal channel could only anchor an on-chain root and settle funds via **periodic
cooperative settlement** (settle every N moves while both parties are online, reopen
carrying state). That is a larger, lifecycle-changing effort (canvas-state hand-off, extra
on-chain settle volume, an ADR) and is **explicitly out of scope here**. Consequence:
world-canvas keeps its current behavior — funds do not settle, no on-chain transcript root —
but P1 removes its RAM cost and P2 (optionally) archives its bytes best-effort. Revisit as a
separate ADR if world-canvas provenance / fund-settlement becomes a product requirement.

## 8. Open decisions

1. **Enable P2 streaming for never-terminal games?** world-canvas would produce durable but
   **un-anchored** (no on-chain root) chunks — storage cost vs provenance-lite value. Gate
   per-game or via an S3 lifecycle expiry, or restrict P2 to games that settle.
2. **Manifest public anchor** — S3-only + on-chain root, or also mirror the small manifest
   to Walrus for the public-verifier story (Walrus stays best-effort today).
3. **Browser root: verify vs trust** (future) — if the FE is ever slimmed to hold no
   transcript, have it verify the root with the same O(log N) accumulator rather than trust
   the bot's root. Not needed for P1/P2.

## 9. Phasing

- **P1 — streaming Merkle recorder** — **DONE** (committed): swap at `colocated.rs`
  (`StreamingRootRecorder`) + golden parity + RAM-bound tests. Resolves the server OOM. No
  S3 / FE / wire / settle-route changes.
- **P2 — explorer verifies from S3 (read-redirect), S3 primary**: the explorer `/transcript`
  endpoint reads the S3 object (`GetObject` at the deterministic key) primary, falling back
  to Walrus; add `aws-sdk-s3` + a fake-testable `TranscriptReader` to `backend/explorer`,
  config, and IAM `s3:GetObject`. No streaming, no recorder change. (Supersedes the dropped
  chunked-streaming design — see Pillar 2.)
- **P3 — S3-primary write + async Walrus** — **DONE**: the settle route archives to S3
  **synchronously** (primary, `routes.rs`), pushes the settled row immediately, then
  replicates to Walrus in a **spawned** task that publishes the proof link async via
  `explorer:proofs` (COALESCE-merged onto the row) — best-effort, since S3 holds the
  authoritative copy. The FE settle response no longer waits on Walrus (it only reads
  `txDigest`, verified). Follow-ups: a **durable reconciler** (rows missing `walrus_blob_id`
  → replicate) if guaranteed Walrus replication is required; and the tunnel-manager
  *recent-events* live feed shows the proof link only once the async Walrus completes.
- **Reusable extraction** — **DONE**: `backend/transcript-store` (canonical key + read/write
  traits + `S3TranscriptStore` + `from_env` + `testing` fakes), reused by tunnel-manager,
  explorer, and available to the bot fleet. Mirrors `wallet-pool/s3`.

## 10. References (S3 streaming best-practice)

- Multipart: parts not readable until Complete; billing; must complete/abort —
  https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html
- Multipart limits (5 MiB min part except last, 10k parts) —
  https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html
- Abort incomplete MPU lifecycle —
  https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpu-abort-incomplete-mpu-lifecycle-config.html
- `ByteStream` (From<Vec<u8>>/From<Bytes>, retryable, file-backed variants) —
  https://docs.rs/aws-sdk-s3/latest/aws_sdk_s3/primitives/struct.ByteStream.html
- Rust S3 examples (put_object, multipart) —
  https://docs.aws.amazon.com/sdk-for-rust/latest/dg/rust_s3_code_examples.html
- S3 performance (3 500 PUT/s per prefix) —
  https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html
- Object integrity / CRC32C —
  https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity.html
- Strong read-after-write consistency —
  https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html
- Prior art: Kafka tiered storage —
  https://aiven.io/blog/apache-kafka-tiered-storage-in-depth-how-writes-and-metadata-flow ;
  Loki storage — https://grafana.com/docs/loki/latest/operations/storage/
