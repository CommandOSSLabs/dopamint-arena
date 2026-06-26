# 0014 — bigint wire boundary: codec owns all string↔bigint conversions

- **Status**: Accepted
- **Date**: 2026-06-26
- **Refs**: extends [ADR-0010](0010-mp-resume-protocol.md) (resume persistence) and the
  `PeerMessage` / `ResumeAdapter` contracts in `mpClient.ts` / `resumeSession.ts`.

## Context

Balances, nonces, and timestamps in the tunnel are `bigint` (Move `u64`). Before this
decision, multiple layers each independently converted them to strings for JSON transport
and back to bigint when consuming them:

- `WireStateUpdate` declared string fields; `toWireCoSigned` called `.toString()` on four
  fields; `fromWireCoSigned` called `BigInt()` on the same four.
- Every `settleHalf` peer-message constructor (pvpMatchHook, QP, battleship, agentEngine)
  called `.toString()` on four settlement fields to match `PeerMessage.settleHalf: string`.
- `bombItResumeAdapter` and `crossResumeAdapter` each manually `.toString()`'d five bigint
  state fields in `serializeState` and `BigInt()`'d them back in `deserializeState`.
- `balancesFromCheckpoint` in `resumeSession.ts` wrapped two already-bigint fields in
  redundant `BigInt()`.

This scatter means any new path that reads these values can silently get a string where a
bigint is expected (or vice versa), and the correct conversion site is non-obvious.

The transport already has a clean single-boundary codec: `stringifyWithBigint` /
`parseWithBigint` in `resume.ts`, used by `mpClient.ts` for all peer messages and by the
localStorage persistence layer. The codec is the right and only place for the conversion.

## Decision

**Balances / nonces / timestamps are `bigint` end-to-end. `stringifyWithBigint` /
`parseWithBigint` in the transport is the single JSON boundary.**

Concretely:

1. `WireStateUpdate.{nonce,timestamp,partyABalance,partyBBalance}` are `bigint`. The
   tagged form (`{"__bigint__":"…"}`) is what hits localStorage; `parseWithBigint` revives
   them on read.
2. `toWireCoSigned` passes bigints through unchanged (no `.toString()`).
3. `fromWireCoSigned` passes bigints through unchanged (no `BigInt()` wrapping).
4. `PeerMessage.settleHalf.{partyABalance,partyBBalance,finalNonce,timestamp}` are `bigint`.
   Send sites pass `half.settlement.*` directly.
5. `bombItResumeAdapter` and `crossResumeAdapter` pass bigint state fields through in
   `serializeState`; `deserializeState` casts them (the codec already revived them).
6. `balancesFromCheckpoint` reads `WireStateUpdate` bigints directly.

**Adapters and peer-message constructors MUST NOT call `.toString()` on numeric fields.**
The doc-comment on `PeerMessage` and on `WireStateUpdate` codify this contract.

Note: `settleHalf`'s numeric fields are `bigint` in the type even though the current
receive side (`waitPeer<{ sig; transcriptRoot }>`) ignores them — this preserves type
symmetry and is correct for any future reader.

## Consequences

- One authoritative JSON boundary; no per-layer conversion code to audit.
- New adapters and peer-message extensions that carry numeric values get the right type
  from the interface and need no manual codec work.
- Old localStorage records (decimal-string form) become unreadable once a seat writes a
  new tagged record. Impact: at most one lost resume checkpoint per active match on the
  first deploy — which the reconciliation handshake closes (≤1 move gap, per ADR-0010).
- The two "no bigint in serialized form" adapter tests are repurposed to
  "bigint survives a `stringifyWithBigint`/`parseWithBigint` round-trip", which is the
  property that actually matters.
