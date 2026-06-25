# Settle binary transcript + canonical moves/tunnel — design

- **Status**: Accepted
- **Date**: 2026-06-24

> Dev phase — no backward-compat. There is a single unified binary settle-body
> format (no legacy JSON path); the leading version byte is `0x01`, used only as
> a cheap guard against a garbage body.

## Context

A long self-play session co-signs many moves into ONE tunnel and ships the whole
transcript in the `/settle` body for Walrus archival. The body is JSON with
hex-encoded fields, the worst possible encoding:

- **hex doubles** every binary field (`message` 120 B → 240 chars; `sigA`+`sigB`
  128 B → 256 chars).
- **JSON repeats keys + `tunnelId`** in every entry.

Result: ~500 B/entry → 16 MB caps at ~33k moves. A ~500-match game already 413s.
The settler boss is right: **the fix is a better encoding, not a bigger limit**
(16 MB is generous; raising it trades backend RAM × settle-concurrency for
deferring the real problem).

The on-chain settlement already anchors only the 32-byte Merkle root; Walrus is
the data-availability layer holding the bytes behind that root. The transcript
MUST be archived in full (every entry, both signatures) for the proof to verify
— it cannot be sampled.

### Read/write model

- **Writer**: one client per tunnel, once per close. Bounded per tunnel (capped
  moves/tunnel). Bursty under a fleet of self-play tunnels closing together.
- **Reader**: the in-browser verifier, on demand, re-checks every entry's
  signatures + recomputes the root vs the on-chain anchor.
- **Dataset**: each transcript is bounded; the archive (many blobs) grows
  append-only on Walrus.

### Cost levers (why the design points where it does)

| layer | per tunnel | scales as | wants |
|---|---|---|---|
| on-chain close | 1 sponsored tx | `1/S` | big S |
| Walrus blob | write fee + (~5× encoded + fixed per-blob metadata) × epochs | per-blob overhead dominates small blobs | big S |
| settle RAM | whole body buffered | `concurrency × body` | bounded S |
| crash-before-close | loses unanchored history | linear in S | bounded S |
| **signatures** | 128 B/entry, **incompressible** | — | the hard floor |

`S` = moves/tunnel. Everything except RAM and crash-loss wants big S. So: **max
S on an efficient encoding, with a safety cap**. The 128 B/entry signature floor
means no encoding beats ~131k moves/16 MB; the realistic target is ~2× today.

## Decision

Two coordinated changes:

1. **`/settle` body + Walrus blob become a fixed-layout binary format.**
   `application/octet-stream`. The transcript entries pack the raw bytes the SDK
   already produces (`serializeStateUpdate` + the two raw ed25519 sigs) — no hex,
   no per-entry keys, `tunnelId` carried once in the header. ~248 B/entry → 16 MB
   holds ~67k moves (**~2×**), and the Walrus blob shrinks the same amount.

2. **A canonical `MAX_MOVES_PER_TUNNEL = 50_000` constant + `shouldRotateTunnel()`
   helper ship in the SDK.** Because state is committed as a 32-byte hash, every
   entry is the SAME fixed size in every game — so one move-count cap governs all
   games predictably. A game's self-play loop settles + opens a fresh tunnel when
   the transcript reaches the cap. 50k ≈ 12 MB at this size, well under 16 MB.

### Why octet-stream (not base64-in-JSON or raise-the-limit)

- **Raise the limit** — rejected. 16 MB is generous; bigger = RAM × concurrency.
- **base64-in-JSON** — only ~1.45× (base64's 1.33× overhead caps the request at
  ~48k), forcing a 30k cap. Doesn't reach the 50k standard.
- **octet-stream** — full 2× (67k), clean 50k standard, and the Walrus blob is the
  same bytes (max storage efficiency). Money-field-parse risk is bounded by the
  existing **verify-before-gas dry-run**: a mis-parsed settlement field produces a
  close tx the co-signatures don't cover → dry-run fails → no funds move. A
  shared **golden test vector** pins TS↔Rust byte parity.

### Binary `/settle` body layout

Big-endian. Header = 229 bytes, then `count` length-prefixed entries.

```
off  size  field
0    1     version (0x01)
1    32    tunnelId
33   8     partyABalance  (u64)
41   8     partyBBalance  (u64)
49   8     finalNonce     (u64)
57   8     timestamp      (u64)
65   32    transcriptRoot
97   64    sigA           (settlement co-signature A)
161  64    sigB           (settlement co-signature B)
225  4     count          (u32)
229  ...   count × entry:
             u16 msgLen | message[msgLen] | entrySigA[64] | entrySigB[64]
```

`message` is length-prefixed (not assumed 120 B) so a future non-32-byte
`stateHash` still round-trips. The Walrus blob = the received body verbatim;
`updateCount` = `count`. The settlement co-sigs in the header are harmless to
archive (already implied on-chain); the verifier ignores them and checks the
per-entry sigs + the root.

### Verifier input

`verifyTranscript(blob: Uint8Array, …)` decodes the single binary settle body
(`decodeSettleBody`) and verifies it — there is no legacy path. The leading
version byte (`0x01`) only guards against a garbage/wrong body. Dev phase: the
FE↔backend request format and stored blobs are all the one format (they deploy
together on `dev`); no backward-compat is carried.

## Touch points

**SDK (`sui-tunnel-ts/`)**
- `src/proof/limits.ts` *(new)* — `MAX_MOVES_PER_TUNNEL`, `shouldRotateTunnel`.
- `src/proof/settleBinary.ts` *(new)* — `encodeSettleBody` / `decodeSettleBody`.
- `src/proof/transcript.ts` — `verifyTranscript` accepts the binary blob.
- `src/proof/index.ts` / barrel — export the new module.

**Frontend (`frontend/`)**
- `src/backend/settleRequest.ts` — `coSignedToSettleBody(...)` → `Uint8Array`.
- `src/backend/controlPlane.ts` — `settle()` POSTs `application/octet-stream`.
- `src/explorer/explorerClient.ts` / `VerifyPanel.tsx` — fetch the blob as bytes,
  pass to `verifyTranscript`.

**Backend (`backend/tunnel-manager/`)**
- `src/routes.rs` — `settle` reads `Bytes`, parses the binary header → `CloseArgs`
  (close path unchanged), stores the body to Walrus, `updateCount` = `count`.
  The `transcript: Vec<Box<RawValue>>` JSON field is removed (superseded).
- Retains the 16 MB cap, settle concurrency limit, and one-RPC epoch+gas already
  on `dev`.

## Test strategy

- **Golden vector** (the parity anchor): a fixed `(settlement, 2 entries)` input
  whose exact bytes are asserted in BOTH a TS test and a Rust test. Any drift in
  either encoder/decoder fails immediately.
- **Round-trip**: `decode(encode(x)) == x` in TS.
- **Verify**: a binary blob verifies `ok`; tamper one entry sig → `ok:false`.
- **Bad version**: a wrong leading version byte is rejected with a clean error.
- **Cap**: `shouldRotateTunnel` false below, true at/above `MAX_MOVES_PER_TUNNEL`.
- **Backend**: Rust parses the golden vector header into the expected `CloseArgs`.

## Out of scope (documented, not built here)

- **Cap enforcement in multi-game loops.** The multi-game wrappers
  (`multiGame*Protocol`, `stepMultiGame`) land in PR #43, not on `dev`. This spec
  ships the constant + helper; each game's self-play loop calls
  `shouldRotateTunnel(transcript.length)` → settle + reopen. Wiring is per-game.
- **Walrus epoch tuning** — a config/ops change, tracked separately.
- **Two-step settle** (separate close vs archive endpoints) — a future option if
  archival should be decoupled from the money path.

## Consequences

- 16 MB `/settle` holds ~67k moves (~2×); Walrus blobs ~2× smaller.
- Every game adopts `MAX_MOVES_PER_TUNNEL = 50_000` → max on-chain/Walrus
  amortization, safely inside the 16 MB ceiling.
- In-browser verify time scales with moves (~50k ed25519 checks ≈ a few seconds);
  acceptable on-demand, mitigable with native/WASM crypto later.
