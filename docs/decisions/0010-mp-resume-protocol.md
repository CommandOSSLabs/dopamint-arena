# 0010 — MP resume protocol: rebind, peer-reconcile, on-chain floor

- **Status**: Accepted
- **Date**: 2026-06-22
- **Refs**: implements the deferred "resume protocol" from
  [ADR-0009](0009-data-plane-local-control-plane-redis.md) §Consequences and §Open questions.
  Full design rationale is kept in the mp-resume-protocol design notes.

## Context

A dropped WebSocket abandons a live match. The match record survives in Redis (6h TTL) but both
seat `ConnRef`s are stale — any relayed frame goes into the void and there is no path for the
returning player to re-attach. ADR-0009 deferred the resume protocol to its own ADR. This is it.

The core tension: a correct resume path must not add Redis or on-chain ops to the per-move
relay path (ADR-0009's central invariant), yet it must handle the returning client's need for
a fresh socket binding and the peer's need for an up-to-date routing cache entry.

## Decision

**Resume = atomic `ConnRef` rebind + socket reconnect + event-driven peer relay-cache
eviction.**

1. **Rebind (`rebind_match_conn`):** one atomic Lua op (`HGET` the seat wallets, `HSET` the
   matching seat's `ConnRef`, `EXPIRE` refresh). O(1), per-reconnect — never per move.
2. **Peer cache reconciliation:** on resume the server **evicts** the peer's stale relay-cache
   entry over the bus ctrl channel (`evict`, local or cross-instance). The peer's next relay is
   the only place that re-reads the match — one `get_match` GET, post-resume and rare — to pick up
   the rebound `ConnRef`. **No Redis read is added to the steady-state move path** (cache hits skip
   the GET). The `ConnRef` does NOT ride in a message; the rebound value is read lazily from the
   store on the first post-resume relay.
3. **Peer-to-peer state reconciliation:** the online peer re-sends its latest co-signed
   checkpoint over the existing relay side channel. The resumer verifies both signatures and
   adopts the highest nonce that carries both signatures. This is **client-side, at resume
   only** — off the hot path, zero per-move cost.
4. **On-chain settlement is the floor** when peers can't reconcile (peer never returns within
   the grace window, or genuine equivocation). No new on-chain code; the existing
   `update_state` + close + dispute path applies.

**Auth:** the existing `Connect` handshake (ed25519 over a server nonce) is reused. `Resume`
carries only `match_id`; authorization is the seat-ownership check inside `rebind_match_conn`
(the authed wallet must equal `seat_a` or `seat_b`). No new crypto, no new token.

**Grace window:** 60 s, enforced by the **frontend UX timer** (the FE shows "opponent
reconnecting…" after `PeerDropped` and offers "claim/settle" after the window). The server
**never ends a match**; match records survive until the 6h TTL expires. The 60 s window is
≤ the on-chain challenge window so a settlement triggered after the grace period is always
contestable by a late-returning peer.

## Consequences

- **Instance death is survived implicitly:** when a backend instance dies, both sockets drop;
  each peer independently reconnects (the load balancer may route them to different surviving
  instances) via the same `Connect`→`Resume` path and rebinds its own seat. No dedicated
  dead-instance detection or proactive migration needed.
- **Per-move path is unchanged.** `relay_to_other` issues no new Redis or on-chain ops; it reads
  the match from its per-connection cache. Resume invalidates that cache via `evict`, costing one
  `get_match` GET on the peer's first post-resume relay — never per move. Performance invariant
  from ADR-0009 holds.
- **`peer.dropped` is robust for both seats.** Both seats' relay caches are warm at `match.found`:
  the match-creating connection inserts the record locally, and the waiter (the seat paired by the
  other player's action) is warmed at match creation via the bus `populate` ctrl signal (local or
  cross-instance). So a seat that drops before its first relay still notifies its peer, closing the
  cold-cache gap a never-relayed waiter would otherwise have.
- **Cross-instance evict/populate ride the pub/sub channel (ADR-0005 soft dependency).** A rolling
  deploy may drop a few cross-instance ctrl signals mid-rollout; an evicted-but-missed peer's cache
  stays stale until the next relay triggers a lazy miss, and a populate-but-missed waiter falls back
  to the lazy first-relay GET. Steady-state moves still work via the fallback pub/sub path.
- **Out of scope → future affinity ADR (0011):** proactive owner-death re-homing (server
  detects a dead instance and migrates matches via a Redis CAS on `owner_instance_id`),
  liveness heartbeats, and any server-side watchtower checkpoint store for resume. The server
  stores **no game state** for resume; the existing `record_checkpoint` / `latest_checkpoint`
  machinery is independent and may serve a future watchtower role, but resume does not depend
  on it and this ADR does not extend it.
