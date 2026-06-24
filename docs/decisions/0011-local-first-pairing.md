# 0011 — Local-first pairing: co-located matches relay in-process

- **Status**: Accepted
- **Date**: 2026-06-24
- **Refs**: realizes the local-first half of the **affinity mechanism** deferred by
  [ADR-0009](0009-data-plane-local-control-plane-redis.md) §Consequences / §Open
  questions. Re-homing and instance-to-instance transport remain deferred. Full
  design: [`docs/superpowers/specs/2026-06-24-local-first-pairing-design.md`](../superpowers/specs/2026-06-24-local-first-pairing-design.md).

## Context

`Bus::deliver` already relays a frame in-process when both seats are on one
instance, falling back to Redis `SPUBLISH` only across instances. But matchmaking
(`JOIN_OR_PAIR`) pops the FIFO front of the global queue regardless of instance,
so two players who landed on the same instance are routinely paired with partners
elsewhere — forcing every move onto the Redis fallback for the life of the match.
The local channel exists; nothing routes matches into it.

## Decision

Prefer a **same-instance** waiting opponent at pairing time; fall back to the
FIFO-front opponent when none exists. Co-location becomes opportunistic — no
player is moved or re-homed. The pairing stays one atomic Lua eval, preserving
exactly-once pairing and the never-pair-self / self-drain invariants. A
per-instance co-located-vs-split counter makes the effect observable.

## Consequences

- Co-location rate tracks concurrency: high when queues hold multiple waiters,
  ~1/N at low load (no worse than today). The win is opportunistic.
- A slight, bounded bend of strict FIFO fairness; negligible with short queues.
- Single global `queue:<game>` with an O(n) in-script scan is fine while queues
  stay short; shard per-instance later if matchmaking contention appears.
- Out of scope (deferred): re-homing + per-instance addressing, direct
  instance-to-instance transport, session stickiness, and the agent-fleet strict
  local-only pool + human reserve floor.
