# 0002 — Backend ↔ client API contract (control plane, v1)

> **⚠️ Premise updated by [ADR-0006](0006-genuine-two-party-only-drop-self-play.md).**
> This contract assumed the per-move loop was client-local self-play with no
> matchmaking. Self-play is dropped — every tunnel is now genuine two-party, so the
> backend also runs **matchmaking + an opaque relay** (a separate WS surface). The
> **session / heartbeat / stats contract defined here is unchanged**: the agent
> fleet still registers sessions and heartbeats move deltas.
>
> **⚠️ Settle superseded by [ADR-0007](0007-settle-authorized-by-settlement-not-token.md).**
> The bearer-gated `POST /v1/sessions/{id}/settle` defined below is replaced by
> `POST /v1/tunnels/{tunnelId}/settle`, authorized by the co-signed settlement
> itself (no session token). Treat the settle section here as historical.
>
> **➕ Metrics extended by [metrics-timeseries-design](../superpowers/specs/2026-06-24-metrics-timeseries-design.md).**
> Adds `GET /v1/stats/history` (persisted TPS time-series), a `peakTps` field on the
> `stats/live` snapshot, and a body-token heartbeat variant for `sendBeacon`. The
> heartbeat/stats contract here is otherwise unchanged.
>
> `GET /v1/stats/history` accepts **either** `window=<secs>` (trailing, default 1h) **or**
> an absolute `from=<epoch>&to=<epoch>` range; `from`/`to` win when both are present. The
> range is bounded to the 30-day metric retention and **downsampled server-side** to ≤1000
> points — one per stride-wide bucket carrying the bucket's last cumulative counter, so each
> derived point is the **average** TPS across its bucket (long ranges are smoothed; the client
> additionally peak-preserves when decimating the shorter, denser series it renders). Response:
> `{ "metric": "tps", "points": [{ "t": "<epoch-secs>", "v": <tps> }] }`.

- **Status**: Accepted (v1 draft, target: June-19 demo)
- **Date**: 2026-06-16
- **Refs**: DOP-170 (backend), DOP-181 (client runtime), DOP-173 (catalog),
  DOP-174–180 (game clients). Builds on [ADR-0001](0001-arena-baseline-architecture.md).

## Context

Per ADR-0001, gameplay does **not** flow through this contract: per-move frames
travel the separate opaque relay (the WS surface), and the backend never reads or
signs a move. This backend is the control / stats / proof spine.
Seven game clients (4 frontend engineers) integrate with the one Rust backend,
so this contract is the seam that lets them build in parallel. Publish it first;
the FE can code against a mock before the backend exists.

## Scope

- **In:** session registration, throughput heartbeat, settlement + Walrus
  archival, the live aggregate feed for the activity panel.
- **Out:** per-move / gameplay traffic (travels the relay, never sent here);
  matchmaking + relay (a separate WS surface, not this stats/settle contract);
  identity beyond a per-session token.

## Conventions

- Base path `/v1`; JSON; UTF-8. Auth: `Authorization: Bearer <statsToken>`
  (returned by `POST /sessions`).
- **All `u64` values (balances, nonce, timestamp) are encoded as decimal
  _strings_** — they exceed JS `number` precision and the SDK holds them as
  `bigint`. 32-byte values (pubkeys, signatures, hashes, `transcriptRoot`) are
  `0x`-prefixed hex.
- **Registry authority:** the **on-chain events are the source of truth** for a
  tunnel's existence, funds, and status — the backend maintains its registry by
  indexing `TunnelCreated` / `TunnelActivated` / `TunnelClosed`. `POST /sessions`
  is **not** trusted for funds; it only supplies game/session grouping + metadata
  for the stats panel.

## Endpoints

### `POST /v1/sessions` — register a game session

Called after the wallet PTB (`create_and_fund`) has opened+funded the tunnels.
Groups them under a session for stats + settlement tracking. The SDK side of
this extension lives in `sui-tunnel-ts/src/onchain/createAndFund.ts`
(`buildOpenAndFundMany`), exercised end-to-end by
`src/examples/createAndFundBatch.ts` (localnet open→settle harness).

```jsonc
// request
{ "userAddress": "0x..",
  "game": "blackjack",
  "tunnels": [ { "tunnelId": "0x..", "partyA": "0x..", "partyB": "0x.." } ] }
// response
{ "sessionId": "sess_...", "statsToken": "..." }
```

### `POST /v1/sessions/{sessionId}/heartbeat` — throughput report

Coarse, **aggregated deltas** (~1/s) — **not** one call per move.

```jsonc
// request
{ "tunnelId": "0x..", "nonce": "48213", "actionsDelta": 4800, "windowMs": 1000 }
// response: 204 No Content
```

### `POST /v1/sessions/{sessionId}/settle` — settle + archive one tunnel

A **thin envelope over the SDK's `CoSignedSettlementWithRoot`** — the FE
serializes `buildSettlementWithRoot()` output directly; do not rename fields.
The payload has **two parts for two consumers**:

- `{ settlement, sigA, sigB }` → on-chain `close_cooperative_with_root`.
- `transcript[]` → **Walrus only** (proof-of-existence; never goes on-chain).

**`finalNonce` is the signed settlement nonce, not the off-chain move count.** The
chain reconstructs `final_nonce = tunnel.state.nonce + 1` (tunnel.move) and verifies
the co-signatures against it; the backend passes it through but does not supply it on
chain. The SDK signs `onchainNonce + 1`, and in self-play (no on-chain `update_state`)
`onchainNonce = 0`, so this is `"1"` — **not** the heartbeat's off-chain `nonce` (e.g.
`48213`). Signing the move count here fails on-chain with `EInvalidSignature`.

```jsonc
// request
{ "settlement": { "tunnelId": "0x..", "partyABalance": "1500", "partyBBalance": "500",
                  "finalNonce": "1", "timestamp": "1750000000000",
                  "transcriptRoot": "0x..(32B).." },
  "sigA": "0x..", "sigB": "0x..",
  "transcript": [ /* co-signed updates, for Walrus archival */ ] }
// response
{ "txDigest": "..", "walrusBlobId": "..", "proofUrl": "https://.." }
```

### `GET /v1/stats/live` — aggregate feed (SSE) → catalog activity panel

Server-sent events; the backend sums per-client heartbeats into global figures.

```jsonc
{
  "tps": 812345,
  "totalActions": 19200345,
  "activeTunnels": 2104,
  "settledTunnels": 880,
  "perGame": { "blackjack": { "tps": 410234, "tunnels": 1200 } },
}
```

## Sequence

```
wallet PTB (create_and_fund)        ── opens+funds N tunnels (1 popup)
        │
client  ├─ POST /sessions           ── register {game, tunnelIds}
        ├─ [self-play loop, local]  ── thousands of co-signed moves (NOT sent here)
        ├─ POST /heartbeat  (~1/s)  ── aggregated action counts ─┐
        └─ POST /settle             ── final co-signed state      │
                                         backend → close + Walrus  │
catalog ← SSE /stats/live  ◄──────────── backend aggregates ◄─────┘
backend ← chain events (TunnelCreated/Activated/Closed)  ── authoritative registry
```

## Errors

HTTP status + `{ "error": { "code": "...", "message": "..." } }`. Notable:
`401` bad/missing token · `404` unknown session/tunnel · `409` tunnel already
settled · `422` settlement failed on-chain verification (bad sig / balance sum).

## Status & versioning

`/v1` is the June-19 draft. The Rust backend (DOP-170) is the reference
implementation; once stable, an OpenAPI spec generated from it supersedes this
doc as the source of truth. Breaking changes bump the path prefix.
