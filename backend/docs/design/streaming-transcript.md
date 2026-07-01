# Server-owned streaming transcript

- **Status:** Design (final target). Supersedes the earlier per-settle draft in this file's
  git history. P1 landed; the rest is the target architecture below.
- **Date:** 2026-07-01
- **Scope:** the whole transcript flow — bot recorder (`rust/engine/tunnel-harness`,
  `backend/tunnel-manager/src/fleet`), settle path (`routes.rs`), the browser SDK
  (`sui-tunnel-ts`) + FE (`frontend/src/pvp`), and the explorer read
  (`backend/explorer`). ADR-0029 covers the never-terminal settlement lifecycle.

## 1. The decision

**The transcript lives fully on the server. The client holds none of it.** As a
human-vs-bot arena game is played over the relay, the **bot streams every co-signed move to
S3 in chunks, continuously** — the bot is the sole transcript owner. The browser keeps only
what protects the *user*: it co-signs each move and retains the single latest co-signed
**checkpoint** (for resume + dispute). It no longer accumulates, computes a root over, or
uploads the transcript.

This is the original request ("con bot backend làm … upload từng chunk"): the bot does it,
streamed, so server RAM stays bounded and the browser is relieved.

## 2. Why streaming, and why NOT S3 multipart

The transcript is an **append-only stream that frequently never completes** — world-canvas
ends when the human closes the tab, and every deploy hard-kills in-flight matches. That
lifecycle rules out `CreateMultipartUpload → UploadPart → CompleteMultipartUpload`:

- **Parts are invisible/unreadable until `CompleteMultipartUpload`.** An upload that never
  completes (our common case) archives **nothing** — orphaned, billed, un-listable parts
  needing a reaper. The opposite of "capture the ongoing history."
- **5 MiB minimum part** is too coarse for bounded RAM + frequent durability; and once
  segments are small (periodic settlement, §4), a multipart upload is a **single part**
  anyway = a plain `PutObject`.

**Instead: sequential, immediately-durable objects.** One `PutObject` per small chunk
(~1 MB) to `transcripts/{tunnel_id}/{seq:08}.bin`. Each chunk is a real, readable object the
instant it lands (S3 strong read-after-write), so an abandoned stream keeps everything
flushed so far. A tiny `manifest.json` lists the chunks for the verifier. This is the
industry pattern for append-only-log → object store (Kafka tiered storage, Grafana Loki);
they use multipart only to move an *already-complete* segment.

## 3. Full flow

```
PLAY  (human ⇄ WS relay ⇄ bot;  relay forwards opaque frames, never parses)
  bot co-signs each move; per committed move the recorder:
     • folds the leaf into the O(log N) Merkle root            [P1, RAM-safe, DONE]
     • appends the entry to a ~1 MB buffer
     • buffer full / timer → PutObject …/{seq:08}.bin           [STREAM, durable-on-flush]
  bot holds only: root peaks + one chunk buffer. Bounded regardless of length.
  browser holds: O(1) checkpoint + co-signs each move. NO transcript.

SETTLE
  • both co-sign the settlement-with-root over the relay (browser co-signs the bot's root)
  • bot combines the halves; the settler submits close_cooperative_with_root — HEADER ONLY
    (root + balances + sigs; entries are already in S3). No browser POST.
  • seal manifest.json (chunk keys + root) for the segment

WORLD-CANVAS (never-terminal): PERIODIC cooperative settlement every N moves / T sec
  (ADR-0029) — anchors a root on-chain per segment, carries canvas state to the next segment.
  Mid-segment abandonment: chunks so far are durable; only the current unsealed segment
  lacks an on-chain root (bounded loss).

READ / VERIFY  (explorer)
  fetch manifest → GetObject each chunk → concat → recompute root → check on-chain root.
```

## 4. Components

- **`StreamingRootRecorder` (Rust, `tunnel-harness`)** — the P1 O(log N) Merkle accumulator
  **plus** a bounded chunk buffer and an mpsc `Sender`. `record()` folds the leaf and sends
  the serialized entry. Byte-parity requirement: the bot serializes each entry
  (`TranscriptSettleEntry::from_transcript_entry` + u16 length prefix) so reassembled chunks
  are byte-identical to the co-signed leaves the root commits to — a golden test enforces it.
- **Per-match uploader task (`fleet`)** — owns the channel receiver + the `transcript-store`
  archiver + `tunnel_id`; sequential `PutObject` on size/timer; **finalize-on-channel-close**
  flushes the tail + seals the manifest on *both* clean settle and world-canvas abort (the
  recorder is dropped on both paths → channel closes). Reuses `transcript-store` (§7).
- **Bot-submits-settle (`fleet` + `routes.rs`)** — the bot combines both settle halves and
  the settler submits the header-only close. The browser `POST /settle` path is removed; the
  browser only sends its `settleHalf` over the relay (which it already does).
- **Browser drops `Transcript` (`sui-tunnel-ts` + `frontend/src/pvp`)** — delete the
  accumulation (`pvpMatchHook.ts:419/459`), `rawEntries()` upload (`:937`), root
  compute (`:912`), and `settle.ts`/`settleRequest.ts` body build+POST. Keep co-signing +
  the checkpoint. The browser **trusts the bot's root** when co-signing (chosen; funds are
  protected by the checkpoint, not the root) — or, if trustless is wanted later, runs the
  same O(log N) accumulator (~500 B) to verify it.
- **Periodic settlement + canvas carry-over (`fleet/core`, ADR-0029)** — never-terminal
  games settle every N moves while both parties are online; the fresh segment opens carrying
  the canvas state.
- **Explorer reassembly (`backend/explorer`)** — `/transcript` reads the manifest + chunks
  from S3 (via `transcript-store`), reassembles, verifies. Replaces the single-blob read.

## 5. Consequences (accepted, on the record)

1. **Browser co-signs a root it no longer computes** — trusts the bot's root. Funds safe via
   the checkpoint. (O(log N) browser-side verify is the trustless upgrade if ever needed.)
2. **Arena-only (human-vs-bot).** Human-vs-human has no server participant (opaque relay),
   so the server can't own the transcript there; that path keeps its browser transcript or is
   dropped. The arena is bot-backed → covered.
3. **Fund-safety unchanged** — dispute/premature-close run on the O(1) checkpoint the browser
   keeps; dropping the transcript doesn't weaken it (verified in the Move dispute path).

## 6. Scalability / failure

- Bot RAM per match: O(log N) root peaks + one ~1 MB chunk buffer — bounded for any length.
- Deploy/crash: lose ≤ the current sub-chunk tail (bounded by the flush timer); flushed
  chunks are durable. A graceful-drain on SIGTERM (track in-flight uploaders) makes planned
  deploys lossless — follow-up.
- Abandonment: chunks durable; last unsealed segment un-anchored (bounded).

## 7. Reuse — `backend/transcript-store` (DONE)

The write (`TranscriptArchiver`) and read (`TranscriptReader`) both go through the shared
`transcript-store` crate (canonical `transcript_key`, `S3TranscriptStore` `from_env`,
`testing` fakes), mirroring `wallet-pool/s3`. The streaming uploader and the explorer both
use it; the boss's **bot fleet** depends on it the same way. The `TranscriptArchiver` doc
states the reuse contract: archive the **authoritative co-signed body byte-for-byte**.

## 8. Phasing (this supersedes the per-settle P2 already committed)

1. **Streaming recorder** → S3 sequential chunks during play. *(backend; foundation)*
2. **Bot-submits-settle** (header-only) + remove the browser POST path. *(backend + FE)*
3. **Browser drops `Transcript`** (trust root). *(FE / SDK)*
4. **Periodic settlement + canvas carry-over** for world-canvas. *(backend; ADR-0029)*
5. **Explorer chunk reassembly + manifest.** *(explorer)*

**DONE already and reused:** P1 (streaming Merkle recorder, O(log N) root) and the
`transcript-store` crate. The committed per-settle archive + explorer read-redirect are
**superseded** by (1)+(5) and will be replaced.

## 9. References

S3 sequential-vs-multipart, strong read-after-write, prior art (Kafka tiered storage, Loki):
see the S3 best-practice sources retained in git history of this file. AWS multipart
overview: https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html
