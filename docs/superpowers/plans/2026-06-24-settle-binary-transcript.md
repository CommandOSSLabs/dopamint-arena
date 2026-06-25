# Settle binary transcript (v2) + canonical moves/tunnel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the JSON+hex `/settle` transcript with a fixed-layout binary v2 body (octet-stream) so 16 MB holds ~2× the moves and Walrus blobs shrink the same; ship a canonical `MAX_MOVES_PER_TUNNEL` constant every game adopts.

**Architecture:** The `/settle` body and the archived Walrus blob become one fixed-offset binary format (v2). The SDK owns the codec + a v1(JSON)/v2(binary) verify dispatch so legacy proofs still verify. The Rust backend reads `Bytes`, parses the header into the unchanged `CloseArgs` (close path untouched; the existing verify-before-gas dry-run fails safe on any mis-parse), and stores the body to Walrus. The explorer `/transcript` endpoint is a transparent byte proxy and needs no change. A shared golden hex vector pins TS↔Rust byte parity.

**Tech Stack:** `sui-tunnel-ts` (pnpm + `node:test` via tsx); React 19 FE; Rust axum backend (`cargo test`). Design: `docs/superpowers/specs/2026-06-24-settle-binary-transcript-design.md`.

---

## Binary v2 `/settle` body layout (the contract every task references)

Big-endian. Header = 229 bytes, then `count` length-prefixed entries.

```
off  size  field
0    1     version (0x02)
1    32    tunnelId
33   8     partyABalance  (u64)
41   8     partyBBalance  (u64)
49   8     finalNonce     (u64)
57   8     timestamp      (u64)
65   32    transcriptRoot
97   64    sigA           (settlement co-signature A)
161  64    sigB           (settlement co-signature B)
225  4     count          (u32)
229  ...   count × entry: u16 msgLen | message[msgLen] | entrySigA[64] | entrySigB[64]
```

The Walrus blob = the received body verbatim. `updateCount` = `count`.

### Shared golden vector (pinned in BOTH the TS and Rust tests)

Encode this exact input in the TS test, capture `toHex(...)`, pin it as
`GOLDEN_HEX`, then paste the SAME hex into the Rust test as the parse input:

```
version        = 0x02
tunnelId       = 0x0000000000000000000000000000000000000000000000000000000000000001
partyABalance  = 7
partyBBalance  = 3
finalNonce     = 5
timestamp      = 1234
transcriptRoot = 0xAA × 32
sigA           = 0x11 × 64
sigB           = 0x22 × 64
count          = 2
entry[0]: msgLen=120, message=0x33 × 120, entrySigA=0x44 × 64, entrySigB=0x55 × 64
entry[1]: msgLen=120, message=0x66 × 120, entrySigA=0x77 × 64, entrySigB=0x88 × 64
```

---

## Task 1: Canonical moves/tunnel constant

**Files:**

- Create: `sui-tunnel-ts/src/proof/limits.ts`
- Test: `sui-tunnel-ts/src/proof/limits.test.ts`
- Modify: `sui-tunnel-ts/src/proof/index.ts` (or the proof barrel; grep the existing export style)

- [ ] **Step 1: Write the failing test**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { MAX_MOVES_PER_TUNNEL, shouldRotateTunnel } from "./limits";

test("MAX_MOVES_PER_TUNNEL is the canonical 50k ceiling (binary v2 ~67k capacity)", () => {
  assert.equal(MAX_MOVES_PER_TUNNEL, 50_000);
});

test("shouldRotateTunnel is false below the cap and true at/above it", () => {
  assert.equal(shouldRotateTunnel(0), false);
  assert.equal(shouldRotateTunnel(MAX_MOVES_PER_TUNNEL - 1), false);
  assert.equal(shouldRotateTunnel(MAX_MOVES_PER_TUNNEL), true);
  assert.equal(shouldRotateTunnel(MAX_MOVES_PER_TUNNEL + 1), true);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd sui-tunnel-ts && node --import tsx --test src/proof/limits.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
/**
 * Canonical per-tunnel move ceiling for ALL games. Entries are fixed-size (state is a
 * 32-byte hash), so one move count governs every game's settle-body size predictably.
 * 50k ≈ 12 MB at the v2 binary entry size (~248 B), safely inside the 16 MB /settle cap
 * (~67k capacity). A self-play loop settles + opens a fresh tunnel once it returns true.
 * See docs/superpowers/specs/2026-06-24-settle-binary-transcript-design.md.
 */
export const MAX_MOVES_PER_TUNNEL = 50_000;

export function shouldRotateTunnel(updateCount: number): boolean {
  return updateCount >= MAX_MOVES_PER_TUNNEL;
}
```

- [ ] **Step 4: Add the barrel export**

In the proof barrel (match the existing `export * from "./..."` style):

```ts
export * from "./limits";
```

- [ ] **Step 5: Run the test, verify it passes**

Run: `cd sui-tunnel-ts && node --import tsx --test src/proof/limits.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add sui-tunnel-ts/src/proof/limits.ts sui-tunnel-ts/src/proof/limits.test.ts sui-tunnel-ts/src/proof/index.ts
git commit -m "feat(proof): canonical MAX_MOVES_PER_TUNNEL + shouldRotateTunnel"
```

---

## Task 2: v2 binary settle-body codec

**Files:**

- Create: `sui-tunnel-ts/src/proof/settleBinary.ts`
- Test: `sui-tunnel-ts/src/proof/settleBinary.test.ts`
- Reference (read): `sui-tunnel-ts/src/core/bytes.ts` (`concatBytes`, `toHex`, `fromHex`), `sui-tunnel-ts/src/core/wire.ts` (`u64ToBeBytes`, `u64FromBeBytes`)

- [ ] **Step 1: Write the failing test (round-trip + golden hex)**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { fromHex, toHex } from "../core/bytes";
import {
  encodeSettleBodyV2,
  decodeSettleBodyV2,
  SETTLE_V2_VERSION,
} from "./settleBinary";

function rep(byte: number, n: number): Uint8Array {
  return new Uint8Array(n).fill(byte);
}

const INPUT = {
  tunnelId: "0x" + "00".repeat(31) + "01",
  partyABalance: 7n,
  partyBBalance: 3n,
  finalNonce: 5n,
  timestamp: 1234n,
  transcriptRoot: rep(0xaa, 32),
  sigA: rep(0x11, 64),
  sigB: rep(0x22, 64),
  entries: [
    { message: rep(0x33, 120), sigA: rep(0x44, 64), sigB: rep(0x55, 64) },
    { message: rep(0x66, 120), sigA: rep(0x77, 64), sigB: rep(0x88, 64) },
  ],
};

test("encode→decode round-trips every field", () => {
  const decoded = decodeSettleBodyV2(encodeSettleBodyV2(INPUT));
  assert.equal(decoded.tunnelId, INPUT.tunnelId);
  assert.equal(decoded.partyABalance, INPUT.partyABalance);
  assert.equal(decoded.partyBBalance, INPUT.partyBBalance);
  assert.equal(decoded.finalNonce, INPUT.finalNonce);
  assert.equal(decoded.timestamp, INPUT.timestamp);
  assert.deepEqual(decoded.transcriptRoot, INPUT.transcriptRoot);
  assert.deepEqual(decoded.sigA, INPUT.sigA);
  assert.deepEqual(decoded.sigB, INPUT.sigB);
  assert.equal(decoded.entries.length, 2);
  assert.deepEqual(decoded.entries[1].message, INPUT.entries[1].message);
  assert.deepEqual(decoded.entries[1].sigB, INPUT.entries[1].sigB);
});

test("version byte is 0x02 and header layout is stable (GOLDEN)", () => {
  const bytes = encodeSettleBodyV2(INPUT);
  assert.equal(bytes[0], SETTLE_V2_VERSION);
  // header(229) + 2×(2 + 120 + 64 + 64) = 229 + 500 = 729 bytes
  assert.equal(bytes.length, 729);
  // PIN this once from the implementation's own output, then keep it identical
  // in Rust (Task 4). If this assertion ever changes, the wire contract changed.
  const GOLDEN_HEX =
    "<fill from `toHex(encodeSettleBodyV2(INPUT))` on first green run>";
  assert.equal(toHex(bytes), GOLDEN_HEX);
});

test("decode rejects a non-v2 version byte", () => {
  const bad = encodeSettleBodyV2(INPUT);
  bad[0] = 0x01;
  assert.throws(() => decodeSettleBodyV2(bad), /version/i);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd sui-tunnel-ts && node --import tsx --test src/proof/settleBinary.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
/**
 * v2 binary /settle body (octet-stream) — replaces JSON+hex so 16 MB holds ~2× the moves
 * and the Walrus blob shrinks the same. Fixed-offset header + length-prefixed entries; see
 * docs/superpowers/specs/2026-06-24-settle-binary-transcript-design.md for the layout. The
 * Rust backend parses the SAME bytes (golden-vector-pinned for parity).
 */
import { concatBytes, toHex } from "../core/bytes";
import { u64ToBeBytes, u64FromBeBytes } from "../core/wire";

export const SETTLE_V2_VERSION = 0x02;
const HEADER_LEN = 229;

export interface SettleBodyV2 {
  tunnelId: string; // "0x"-prefixed 32-byte hex
  partyABalance: bigint;
  partyBBalance: bigint;
  finalNonce: bigint;
  timestamp: bigint;
  transcriptRoot: Uint8Array; // 32
  sigA: Uint8Array; // 64 settlement co-sig
  sigB: Uint8Array; // 64
  entries: { message: Uint8Array; sigA: Uint8Array; sigB: Uint8Array }[];
}

function id32(tunnelId: string): Uint8Array {
  const h = tunnelId.startsWith("0x") ? tunnelId.slice(2) : tunnelId;
  const out = new Uint8Array(32);
  const b = h.padStart(64, "0");
  for (let i = 0; i < 32; i++) out[i] = parseInt(b.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function u16(n: number): Uint8Array {
  const o = new Uint8Array(2);
  new DataView(o.buffer).setUint16(0, n, false);
  return o;
}
function u32(n: number): Uint8Array {
  const o = new Uint8Array(4);
  new DataView(o.buffer).setUint32(0, n, false);
  return o;
}

export function encodeSettleBodyV2(b: SettleBodyV2): Uint8Array {
  if (b.transcriptRoot.length !== 32)
    throw new Error("transcriptRoot must be 32 bytes");
  if (b.sigA.length !== 64 || b.sigB.length !== 64)
    throw new Error("settlement sigs must be 64 bytes");
  const parts: Uint8Array[] = [
    new Uint8Array([SETTLE_V2_VERSION]),
    id32(b.tunnelId),
    u64ToBeBytes(b.partyABalance),
    u64ToBeBytes(b.partyBBalance),
    u64ToBeBytes(b.finalNonce),
    u64ToBeBytes(b.timestamp),
    b.transcriptRoot,
    b.sigA,
    b.sigB,
    u32(b.entries.length),
  ];
  for (const e of b.entries) {
    if (e.sigA.length !== 64 || e.sigB.length !== 64)
      throw new Error("entry sigs must be 64 bytes");
    parts.push(u16(e.message.length), e.message, e.sigA, e.sigB);
  }
  return concatBytes(parts);
}

export function decodeSettleBodyV2(bytes: Uint8Array): SettleBodyV2 {
  if (bytes.length < HEADER_LEN) throw new Error("settle body too short");
  if (bytes[0] !== SETTLE_V2_VERSION)
    throw new Error(`unexpected settle version: ${bytes[0]}`);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tunnelId = "0x" + toHex(bytes.slice(1, 33));
  const partyABalance = u64FromBeBytes(bytes, 33);
  const partyBBalance = u64FromBeBytes(bytes, 41);
  const finalNonce = u64FromBeBytes(bytes, 49);
  const timestamp = u64FromBeBytes(bytes, 57);
  const transcriptRoot = bytes.slice(65, 97);
  const sigA = bytes.slice(97, 161);
  const sigB = bytes.slice(161, 225);
  const count = dv.getUint32(225, false);
  const entries: SettleBodyV2["entries"] = [];
  let off = HEADER_LEN;
  for (let i = 0; i < count; i++) {
    const msgLen = dv.getUint16(off, false);
    off += 2;
    const message = bytes.slice(off, off + msgLen);
    off += msgLen;
    const eSigA = bytes.slice(off, off + 64);
    off += 64;
    const eSigB = bytes.slice(off, off + 64);
    off += 64;
    entries.push({ message, sigA: eSigA, sigB: eSigB });
  }
  return {
    tunnelId,
    partyABalance,
    partyBBalance,
    finalNonce,
    timestamp,
    transcriptRoot,
    sigA,
    sigB,
    entries,
  };
}
```

- [ ] **Step 4: Run, capture the golden hex, pin it**

Run: `cd sui-tunnel-ts && node --import tsx --test src/proof/settleBinary.test.ts`
The GOLDEN assertion fails first with the actual hex — copy that hex into `GOLDEN_HEX`, rerun.
Expected after pinning: PASS (3 tests). **Record `GOLDEN_HEX` — Task 4 reuses it verbatim.**

- [ ] **Step 5: Commit**

```bash
git add sui-tunnel-ts/src/proof/settleBinary.ts sui-tunnel-ts/src/proof/settleBinary.test.ts
git commit -m "feat(proof): v2 binary settle-body codec + golden vector"
```

---

## Task 3: verifyTranscript v1/v2 dispatch

**Files:**

- Modify: `sui-tunnel-ts/src/proof/transcript.ts` (`verifyTranscript`, line 95; add `rawEntries` accessor to `Transcript`, near line 190)
- Test: `sui-tunnel-ts/src/proof/transcript.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Add to `transcript.test.ts` (reuse the file's existing key/transcript helpers — read them first):

```ts
test("verifyTranscript accepts a v2 binary blob and verifies it ok", () => {
  // Build a real signed transcript with the file's existing helpers, then:
  const v2 = encodeSettleBodyV2({
    tunnelId,
    partyABalance,
    partyBBalance,
    finalNonce,
    timestamp,
    transcriptRoot: t.root(),
    sigA: coSigA,
    sigB: coSigB,
    entries: t.rawEntries(),
  });
  const res = verifyTranscript(v2, {
    partyA,
    partyB,
    onchainRoot: toHex(t.root()),
  });
  assert.equal(res.ok, true);
});

test("verifyTranscript on a tampered v2 entry sig reports not ok", () => {
  const v2 = encodeSettleBodyV2({
    /* …as above… */
  });
  v2[v2.length - 1] ^= 0xff; // flip a byte in the last entry sig
  const res = verifyTranscript(v2, {
    partyA,
    partyB,
    onchainRoot: toHex(t.root()),
  });
  assert.equal(res.ok, false);
});

test("verifyTranscript still verifies a legacy v1 JSON ProofRecord", () => {
  const res = verifyTranscript(t.toRecord(), {
    partyA,
    partyB,
    onchainRoot: toHex(t.root()),
  });
  assert.equal(res.ok, true);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd sui-tunnel-ts && node --import tsx --test src/proof/transcript.test.ts`
Expected: FAIL (`verifyTranscript` rejects bytes / `rawEntries` undefined).

- [ ] **Step 3: Implement**

Add the accessor to `Transcript` (after `get length()`):

```ts
  /** Raw co-signed entries (Uint8Array message + sigs) for v2 binary settle encoding. */
  rawEntries(): TranscriptEntry[] {
    return this.entries.slice();
  }
```

Change `verifyTranscript` to dispatch. Replace its signature + the `record.entries`
loop source so it works on a normalized `{ root, entries:[{message,sigA,sigB}(bytes)] }`:

```ts
export function verifyTranscript(
  input: ProofRecord | Uint8Array,
  params: {
    partyA: { publicKey: Uint8Array; scheme: number };
    partyB: { publicKey: Uint8Array; scheme: number };
    onchainRoot: string;
    lockedTotal?: bigint;
  },
): TranscriptVerification {
  // v2 binary blob (first byte 0x02) vs legacy v1 JSON record.
  const norm =
    input instanceof Uint8Array
      ? (() => {
          const d = decodeSettleBodyV2(input);
          return { root: toHex(d.transcriptRoot), entries: d.entries };
        })()
      : {
          root: input.root,
          entries: input.entries.map((e) => ({
            message: fromHex(e.message),
            sigA: fromHex(e.sigA),
            sigB: fromHex(e.sigB),
          })),
        };
  // …existing scheme guard…
  // loop over `norm.entries` (already Uint8Array — drop the per-entry fromHex);
  // use `norm.root` where `record.root` was used; stepCount = norm.entries.length.
}
```

Add `import { decodeSettleBodyV2 } from "./settleBinary";` at the top. Keep all the
existing verification logic (sig verify, nonce monotonic, balance conservation, root match).

- [ ] **Step 4: Run, verify pass**

Run: `cd sui-tunnel-ts && node --import tsx --test src/proof/transcript.test.ts`
Expected: PASS (existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add sui-tunnel-ts/src/proof/transcript.ts sui-tunnel-ts/src/proof/transcript.test.ts
git commit -m "feat(proof): verifyTranscript v1/v2 dispatch + Transcript.rawEntries"
```

---

## Task 4: Backend — parse v2 binary `/settle`, store blob

**Files:**

- Modify: `backend/tunnel-manager/src/routes.rs` (`SettleRequest` struct ~line 87; `settle` handler ~line 186)
- Reference (read): the settle handler keeps `CloseArgs` + `submit_close` + the Walrus upload unchanged — only the parse + blob source change.

- [ ] **Step 1: Write the failing test (golden vector)**

Add to `routes.rs` tests (or a new `#[cfg(test)] mod settle_v2`):

```rust
#[test]
fn parse_settle_v2_reads_header_from_golden_vector() {
    // GOLDEN_HEX from Task 2 (settleBinary.test.ts) — byte-identical.
    let bytes = hex_decode(GOLDEN_HEX);
    let p = parse_settle_v2(&bytes).expect("valid v2 body");
    assert_eq!(p.tunnel_id, "0x".to_owned() + &"00".repeat(31) + "01");
    assert_eq!(p.party_a_balance, 7);
    assert_eq!(p.party_b_balance, 3);
    assert_eq!(p.final_nonce, 5);
    assert_eq!(p.timestamp, 1234);
    assert_eq!(p.transcript_root, vec![0xaa; 32]);
    assert_eq!(p.sig_a, vec![0x11; 64]);
    assert_eq!(p.sig_b, vec![0x22; 64]);
    assert_eq!(p.update_count, 2);
}

#[test]
fn parse_settle_v2_rejects_bad_version() {
    let mut bytes = hex_decode(GOLDEN_HEX);
    bytes[0] = 0x01;
    assert!(parse_settle_v2(&bytes).is_err());
}
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd backend/tunnel-manager && cargo test parse_settle_v2`
Expected: FAIL (`parse_settle_v2` not defined).

- [ ] **Step 3: Implement the parser + switch the handler to `Bytes`**

Add a fixed-offset parser (big-endian, layout from the plan header):

```rust
struct SettleV2 {
    tunnel_id: String,
    party_a_balance: u64,
    party_b_balance: u64,
    final_nonce: u64,
    timestamp: u64,
    transcript_root: Vec<u8>,
    sig_a: Vec<u8>,
    sig_b: Vec<u8>,
    update_count: u32,
}

const SETTLE_V2_VERSION: u8 = 0x02;
const SETTLE_V2_HEADER_LEN: usize = 229;

fn parse_settle_v2(b: &[u8]) -> Result<SettleV2, String> {
    if b.len() < SETTLE_V2_HEADER_LEN { return Err("body too short".into()); }
    if b[0] != SETTLE_V2_VERSION { return Err(format!("unexpected version {}", b[0])); }
    let u64be = |o: usize| u64::from_be_bytes(b[o..o + 8].try_into().unwrap());
    Ok(SettleV2 {
        tunnel_id: format!("0x{}", hex::encode(&b[1..33])),
        party_a_balance: u64be(33),
        party_b_balance: u64be(41),
        final_nonce: u64be(49),
        timestamp: u64be(57),
        transcript_root: b[65..97].to_vec(),
        sig_a: b[97..161].to_vec(),
        sig_b: b[161..225].to_vec(),
        update_count: u32::from_be_bytes(b[225..229].try_into().unwrap()),
    })
}
```

Change the handler signature from `Json(req): Json<SettleRequest>` to `body: axum::body::Bytes`,
parse with `parse_settle_v2`, build `CloseArgs` from the parsed fields (same as today, no hex
decode needed — bytes are already binary), keep the `tunnel_mismatch` / `already_settled` / dry-run
/ `submit_close` path **unchanged**, and on success upload `body` (the raw v2 bytes) to Walrus with
`update_count = p.update_count as usize`. Remove the `SettleRequest` struct and its
`transcript: Vec<Box<RawValue>>` field (superseded); drop the now-unused `Settlement`/`ProofBlob`
JSON structs and the `serde_json::value::RawValue` feature if nothing else uses it.

- [ ] **Step 4: Run the parser tests + full crate build**

Run: `cd backend/tunnel-manager && cargo test parse_settle_v2 && cargo build`
Expected: PASS + clean build.

- [ ] **Step 5: fmt + clippy**

Run: `cd backend/tunnel-manager && cargo fmt && cargo clippy --all-targets`
Expected: no diff, no warnings.

- [ ] **Step 6: Commit**

```bash
git add backend/tunnel-manager/src/routes.rs backend/tunnel-manager/Cargo.toml
git commit -m "feat(settle): parse v2 binary body, archive raw blob"
```

---

## Task 5: FE — encode + POST v2; switch callers

**Files:**

- Modify: `frontend/src/backend/settleRequest.ts` (replace `coSignedToSettleRequest`)
- Modify: `frontend/src/backend/controlPlane.ts` (`settle()` signature + interface; the HTTP impl in this file)
- Modify callers (grep `coSignedToSettleRequest`): `frontend/src/agent/agentEngine.ts`, `frontend/src/pvp/pvpMatchHook.ts`
- Test: `frontend/src/backend/settleRequest.test.ts` (rewrite), `frontend/src/backend/controlPlane.test.ts` (update the settle test)

- [ ] **Step 1: Write the failing test**

Rewrite `settleRequest.test.ts` to assert the binary body decodes back:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { decodeSettleBodyV2 } from "../../../sui-tunnel-ts/src/proof/settleBinary.ts";
import { coSignedToSettleBodyV2 } from "./settleRequest";

test("coSignedToSettleBodyV2 emits a v2 body that decodes to the settlement + entries", () => {
  const coSigned = /* build a CoSignedSettlementWithRoot fixture */;
  const entries = [{ nonce: 1n, message: new Uint8Array(120), sigA: new Uint8Array(64), sigB: new Uint8Array(64) }];
  const body = coSignedToSettleBodyV2(coSigned, entries);
  const d = decodeSettleBodyV2(body);
  assert.equal(d.finalNonce, coSigned.settlement.finalNonce);
  assert.equal(d.entries.length, 1);
});
```

Update `controlPlane.test.ts` settle test: assert the fetch was called with
`method: "POST"`, header `Content-Type: application/octet-stream`, and a `Uint8Array`/
`ArrayBuffer` body (no JSON.stringify).

- [ ] **Step 2: Run, verify fail**

Run: `cd frontend && node --import tsx --test src/backend/settleRequest.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`settleRequest.ts` — replace the JSON mapper with:

```ts
import type { CoSignedSettlementWithRoot } from "../../../sui-tunnel-ts/src/core/tunnel.ts";
import type { TranscriptEntry } from "../../../sui-tunnel-ts/src/proof/transcript.ts";
import { encodeSettleBodyV2 } from "../../../sui-tunnel-ts/src/proof/settleBinary.ts";

/** Build the v2 binary /settle body (octet-stream) from the co-signed settlement + raw transcript. */
export function coSignedToSettleBodyV2(
  coSigned: CoSignedSettlementWithRoot,
  entries: TranscriptEntry[],
): Uint8Array {
  const s = coSigned.settlement;
  return encodeSettleBodyV2({
    tunnelId: s.tunnelId,
    partyABalance: s.partyABalance,
    partyBBalance: s.partyBBalance,
    finalNonce: s.finalNonce,
    timestamp: s.timestamp,
    transcriptRoot: s.transcriptRoot,
    sigA: coSigned.sigA,
    sigB: coSigned.sigB,
    entries: entries.map((e) => ({
      message: e.message,
      sigA: e.sigA,
      sigB: e.sigB,
    })),
  });
}
```

`controlPlane.ts` — change the interface + impl so `settle(tunnelId, body: Uint8Array)`
POSTs with `headers: { "Content-Type": "application/octet-stream" }` and `body` (the
bytes), parsing the same JSON `SettleResult` from the response. Remove
`SettleRequestBody`/`SettleTranscriptEntry`/`SettleSettlement` types (now unused).

Callers — `agentEngine.ts` and `pvpMatchHook.ts`: replace
`coSignedToSettleRequest(co, transcript.toRecord().entries)` with
`coSignedToSettleBodyV2(co, transcript.rawEntries())` and pass that to `settle(...)`.

- [ ] **Step 4: Run FE settle tests**

Run: `cd frontend && node --import tsx --test src/backend/settleRequest.test.ts src/backend/controlPlane.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/backend/settleRequest.ts frontend/src/backend/controlPlane.ts frontend/src/agent/agentEngine.ts frontend/src/pvp/pvpMatchHook.ts frontend/src/backend/settleRequest.test.ts frontend/src/backend/controlPlane.test.ts
git commit -m "feat(settle): POST v2 binary body from the FE"
```

---

## Task 6: FE — read the binary blob in the verifier

**Files:**

- Modify: `frontend/src/backend/explorerClient.ts` (`getTranscript`, ~line 76)
- Modify: `frontend/src/explorer/VerifyPanel.tsx` (~line 56, the `verifyTranscript` call)
- Test: `frontend/src/backend/explorerClient.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

```ts
test("getTranscript returns raw bytes for v2 blobs (no JSON parse)", async () => {
  // mock fetch → arrayBuffer of a v2 body; assert getTranscript returns a Uint8Array
  // whose first byte is 0x02.
});
```

- [ ] **Step 2: Run, verify fail**

Run: `cd frontend && node --import tsx --test src/backend/explorerClient.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`getTranscript` — return `new Uint8Array(await res.arrayBuffer())` instead of
`res.json() as ProofRecord` (the explorer proxies raw Walrus bytes; v2 is binary).
`VerifyPanel` — pass that `Uint8Array` straight to `verifyTranscript(bytes, {...})`
(the Task 3 dispatch handles v1 JSON vs v2 binary; a legacy JSON blob still arrives as
bytes and the dispatch `JSON.parse`s it — so decode the bytes to text and `JSON.parse`
only when the first byte isn't `0x02`, or pass bytes and let `verifyTranscript` branch).
Keep `verifyTranscript` as the single branch point: pass it the `Uint8Array`; for legacy
JSON, `verifyTranscript`'s non-`0x02` path must `JSON.parse(new TextDecoder().decode(bytes))`.
Update Task 3's dispatch to accept `Uint8Array` for BOTH (peek byte 0 → v2 binary else
JSON-decode). Adjust the Task 3 dispatch accordingly if not already.

- [ ] **Step 4: Run, verify pass**

Run: `cd frontend && node --import tsx --test src/backend/explorerClient.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/backend/explorerClient.ts frontend/src/explorer/VerifyPanel.tsx frontend/src/backend/explorerClient.test.ts
git commit -m "feat(explorer): verify reads v2 binary transcript blob"
```

---

## Task 7: Full e2e retest + typecheck

**Files:** none (verification only)

- [ ] **Step 1: SDK suite**

Run: `cd sui-tunnel-ts && node --import tsx --test "src/**/*.test.ts"`
Expected: all pass (the protocol parity + proof suites green).

- [ ] **Step 2: Frontend tests + typecheck + build**

Run: `cd frontend && node --import tsx --test "src/**/*.test.ts"` then the project's
typecheck + build (grep `package.json` scripts: `tsc --noEmit` / `vite build`).
Expected: tests pass, typecheck 0 errors, build OK.

- [ ] **Step 3: Backend suite (skip Docker-only Redis)**

Run: `cd backend/tunnel-manager && cargo test -- --skip store::redis && cargo clippy --all-targets && cargo fmt -- --check`
Expected: all pass, no clippy warnings, fmt clean.

- [ ] **Step 4: Report**

Summarize pass/fail counts for each suite. Any red that is NOT pre-existing on `dev`
(e.g. Docker-gated Redis tests) is a regression to fix before done.

---

## Self-review checklist (run after the plan executes)

- **Spec coverage:** binary v2 body (T2/T4), verify dispatch v1+v2 (T3/T6), FE encode+POST (T5), FE read (T6), canonical cap constant (T1), e2e retest (T7). Cap _enforcement_ is out of scope (PR #43 multi-game loops) — documented in the spec.
- **Type consistency:** `encodeSettleBodyV2`/`decodeSettleBodyV2`/`SettleBodyV2` (T2) used identically in T3/T5; `coSignedToSettleBodyV2` (T5) matches the `TranscriptEntry` shape from T3's `rawEntries()`; Rust `parse_settle_v2` offsets match the TS layout via `GOLDEN_HEX`.
- **Money path:** close path (`CloseArgs` → dry-run → `submit_close`) is unchanged; a mis-parse fails the dry-run. Golden vector guards byte parity.
