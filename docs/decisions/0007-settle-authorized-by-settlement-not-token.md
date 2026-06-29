# 0007 — Settlement is self-authenticating; `/settle` drops the session bearer token

- **Status**: Accepted
- **Date**: 2026-06-18
- **Supersedes**: the settlement-authorization portion of
  [ADR-0002](0002-backend-client-api-contract.md) (the session-bearer-gated
  `POST /v1/sessions/{id}/settle`). The session/heartbeat/stats contract of
  ADR-0002 otherwise stands.
- **Refs**: [ADR-0005 §6](0005-redis-backed-ha-control-plane.md) (settle pushes the
  proof-linked global-log row), [ADR-0001 §1](0001-arena-baseline-architecture.md)
  (genuine two-party play; relay forwards opaque frames; throughput counted at the relay).

## Context

`/settle` today is `POST /v1/sessions/{id}/settle`, gated on a control-plane
**session + `stats_token`** that `register_session` mints. Three facts make that
gate the wrong shape:

1. **The settlement is already self-authenticating.** The body carries a
   `SettlementWithRoot` co-signed by _both_ ephemeral seat keys; the chain
   re-verifies both ed25519 signatures over the canonical bytes at
   `tunnel::close_cooperative_with_root` (the settler is a non-party gas payer —
   `sui.rs` module docs). Only the two seats can produce a valid settlement, and
   funds safety is enforced **entirely on-chain**.
2. **The token protects nothing the signatures don't.** `register_session`
   (routes.rs:125) is **unauthenticated** — any `userAddress`/`tunnels` with no
   ownership proof mints a `stats_token`. So the token is a capability _anyone_
   can mint for _any_ tunnel; it adds no authorization the co-signed bytes (and
   the chain) don't already enforce. For PvP it is pure ceremony: the lane
   registers a session _solely_ to pass this gate, sends **no** heartbeats, and
   the same `(tunnel_id, party_a, party_b)` fact is already held in the relay's
   `MatchRecord` (mp/mod.rs:48) — a redundant client write into a second store
   with no bridge between them.
3. **Throughput needs no session.** PvP TPS is counted **server-side at the
   relay** — one action per co-signed MOVE, ACK skipped (ws.rs:347) — and
   smoothed into a sliding-window rate (stats.rs). So the session buys settlement
   nothing for stats either.

Net: the current gate is session-coupling masquerading as authorization. It also
costs gas — `/settle` submits straight to chain with **no server-side signature
check** (sui.rs `submit_close`), so a malformed or replayed settlement burns a
failed-tx's gas.

## Decision

**The co-signed settlement is the authorization; `/settle` drops the session
token, and a gas sponsor confirms the close will land before it pays for it.**

1. **Authorization = the co-signed bytes + the chain.** The capability to settle
   a tunnel _is_ possession of a `SettlementWithRoot` co-signed by both seats —
   exactly the rule `close_cooperative_with_root` enforces. No bearer token adds
   to that; we stop pretending one does.
2. **Route + body.** `POST /v1/tunnels/{tunnelId}/settle`, body
   `{ settlement, sigA, sigB, transcript }`. No `sessionId`, no `Authorization`.
3. **Verify-before-gas (fail-fast, not authorization).** As a gas sponsor, the
   backend confirms the close will succeed _before_ sponsoring it, and rejects
   (`422`) otherwise — so a malformed, forged, or replayed settlement never burns
   a failed-tx's gas. This is hardening layered on the cheap free rejects
   (unknown tunnel via the registry; `409 already_closed`), **not** the thing that
   authorizes the caller. The mechanism (e.g. dry-running the close PTB so the
   real Move re-verifies the sigs against the on-chain pubkeys) is the spec's call.
4. **Idempotency unchanged.** Keep the `409 already_settled` guard (event-derived
   `TunnelStatus::Closed`) + the on-chain "already closed" abort.
5. **Stats path untouched.** `register_session`/`heartbeat` remain for the
   throughput/heartbeat lane; PvP no longer calls `register_session`.

## Consequences

- **One source of truth.** Authorization derives from the on-chain tunnel + the
  co-signed bytes — no mintable bearer token, no redundant client double-write,
  no second store to keep consistent. The client just POSTs the settlement.
- **Gas-DoS closed.** Verify-before-gas (plus the unknown/closed-tunnel and `409`
  guards) means only settlements that _will_ land reach `execute`. Re-checking the
  chain's own logic also closes a subtlety a local re-implementation would miss:
  the Move recomputes `final_nonce = state.nonce + 1`, so only an on-chain-truth
  check (not bytes rebuilt from the client's `finalNonce`) verifies what actually
  lands.
- **Small, contained backend change.** The fail-fast check reuses the JSON-RPC
  plumbing and the `effects.status` pattern `sui.rs` already has for `execute()`
  — no third byte-exact serializer to keep in lockstep with TS + Move, no
  separate crypto path, scheme-agnostic (the Move verifies whatever scheme each
  `PartyConfig` declares). It is e2e-deferred for the live call (needs a node),
  but the status-extraction is unit-testable against sample RPC JSON, as the
  existing `sui.rs` tests already do for events.
- **PvP client simplifies.** Drop `registerSession` from the tic-tac-toe lane;
  `controlPlane.settle` no longer takes a session id / token; the request targets
  the tunnel resource.
- **Explicitly not doing.** (a) Authenticating `register_session` — the stats
  token is low-stakes and out of scope; (b) non-cooperative / dispute settlement —
  unchanged, separate mechanism.

## Open questions

- **Pubkey read latency.** One extra object read per close (once per tunnel
  lifetime, per ADR-0005's settle-at-close cadence) is negligible, and it shares
  the resolution `submit_close` already does. Revisit only if a future lane
  settles far more often than once per tunnel.
- **Replay across a node reorg.** The `409` + on-chain close guard cover normal
  replay; a deep reorg re-opening a closed tunnel is out of scope for the demo.
