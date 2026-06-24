# 0011 — Local-first pairing: bounded-hold matchmaking + reconnect affinity

- **Status**: Accepted
- **Date**: 2026-06-24
- **Refs**: realizes the **affinity mechanism** deferred by
  [ADR-0009](0009-data-plane-local-control-plane-redis.md) §Consequences / §Open
  questions and the affinity follow-up [ADR-0010](0010-mp-resume-protocol.md)
  §Consequences points to. Full design:
  [`docs/superpowers/specs/2026-06-24-local-first-pairing-design.md`](../superpowers/specs/2026-06-24-local-first-pairing-design.md).

## Context

`Bus::deliver` already relays a frame in-process when both seats are on one
instance, falling back to Redis `SPUBLISH` across instances. But matchmaking is
instance-blind, so co-located pairs are rare and most matches pay the cross-instance
hop on every move.

The naive fix — "prefer a same-instance waiter, else pair the FIFO front" — is a
**no-op**: under immediate pairing the queue holds at most one waiter, so a joiner
never has two candidates and co-location stays at chance (~1/N). Raising it above
chance requires a joiner to sometimes decline an available cross-instance opponent
and wait for a same-instance one.

## Decision

**Bounded-hold pairing.** A joiner pairs immediately with a same-instance waiter;
else with a waiter already past its hold deadline; else parks with
`deadline = now + T` (`T = MP_PAIR_HOLD_MS`, default 750 ms, server-clock based). A
per-waiter timer on the parking connection fires the cross-instance fallback on
expiry. One atomic Lua eval preserves exactly-once pairing and the
never-pair-self / self-drain invariants. **Reconnect affinity** via a per-browser
`Set-Cookie: aff=<instance>` lets the LB return reconnects to the same instance so
co-located matches stay co-located; the resume protocol (ADR-0010) is unchanged. A
co-located-vs-split counter makes the effect observable.

## Consequences

- Co-location now scales with traffic and the hold; at low load it falls back
  cross-instance after T (≤ 750 ms added matchmaking latency), no worse than today.
- Bounded bend of FIFO fairness; no indefinite starvation (a waiter is taken once
  past its deadline).
- One global `queue:<game>` with an O(n) in-script scan is fine while queues stay
  short; shard per instance later if contention appears.
- Affinity is best-effort: transient reconnects re-land co-located; instance death
  scatters to split (correct over the fallback). Stickiness is a one-time LB config.
- Out of scope (deferred): per-instance addressing / redirect-on-resume, direct
  instance-to-instance transport, changes to the resume protocol, per-instance queue
  sharding, and the agent-fleet strict local-only pool + human reserve floor.
