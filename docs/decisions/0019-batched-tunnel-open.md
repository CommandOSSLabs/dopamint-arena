# 0019 — Batch connect-time self-play tunnel opens into one PTB

- **Status**: Proposed
- **Date**: 2026-06-26

## Context

On desktop load the games workspace seeds one window per registered module
(`Desktop.seedLayoutFor`), and each self-play window auto-starts on wallet
connect (`arenaWindow` auto-start effect → `soloSessionHook.start`). Each start
fires its own sponsored transactions — an address-balance top-up
(`ensureStakeBalance`) plus an open+fund (`openAndFundSelfPlay`) — as separate
`POST /v1/sponsor` calls. With ~7 windows that is 10–30 concurrent sponsor calls
on connect, which trips the sponsor's rate/quota (HTTP 422), so games fail to
fund and a per-window 5 s retry loop re-fires the burst.

ADR-0013 removed the owned-coin *equivocation* for concurrent opens by funding
the stake from the player's SIP-58 address balance, but it explicitly only
*serializes* contention via stale-rebuild retries and does **not** reduce the
*number* of sponsor calls — the quota is still hit.

## Decision

We coalesce all self-play tunnel opens issued in the same connect tick into one
Programmable Transaction Block. A `TunnelOpenBatcher` collects `requestTunnelOpen`
calls from every window, funds the summed stake once, and submits a single
`openAndFundMany` PTB (one `splitCoins` for all 2N stakes, one `create_and_fund`
per game — the SDK's `buildOpenAndFundMany`). The created tunnels are correlated
back to callers by party-A address (objectChanges order is unspecified). Batches
larger than `MAX_BATCH` are chunked under the PTB command/argument ceiling, and a
chunk failure falls back to per-request single opens.

## Consequences

- Connect-time sponsor calls drop from ~10–30 to ~2 (one stake-balance ensure for
  the sum, one batched open), independent of window count; the per-window retry
  wave coalesces into one batched retry.
- One PTB = one gas-coin use, so gas-coin equivocation cannot occur within a batch
  (strictly safer than N concurrent opens).
- Funding logic moves out of `soloSessionHook.start` into the batcher (single
  source of truth); a batch of size 1 is byte-for-byte today's open.
- Cost: PTB has command/argument ceilings, so very large batches must chunk
  (logged, never silently capped); a batched PTB is atomic, so a chunk needs a
  per-request fallback. We deliberately do NOT fold the faucet/sweep into the same
  PTB yet (needs Move-semantics verification) and do NOT change PvP or the eager
  auto-start UX.
