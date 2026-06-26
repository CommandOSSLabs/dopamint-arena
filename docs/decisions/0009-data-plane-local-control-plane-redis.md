# 0009 — Data plane local, control plane on Redis: partition by ownership

- **Status**: Proposed
- **Date**: 2026-06-20
- **Refs**: refines [ADR-0005](0005-redis-backed-ha-control-plane.md) (Redis-backed
  HA) and supersedes its _Latency_ consequence; premised on
  [ADR-0001 §1](0001-arena-baseline-architecture.md) (every move flows
  through the server relay). Driven by the `channel-through-server` work.

## Context

ADR-0005 made the backend HA on Redis with **one delivery primitive**: `deliver`
writes to a local socket if the target is on this instance, else `SPUBLISH`es the
frame to the owner's channel — **per frame**. That was justified by an explicit
premise: "PvP is human-paced (≈0 TPS), so [a Redis round-trip per relayed frame]
is immaterial; the 1M-TPS self-play lane never touches it."

Self-play was removed (ADR-0001 §1). **Every move now flows through the server relay**, so
that premise no longer holds: the relay _is_ the data plane, and a Redis
round-trip per frame for any cross-instance match becomes the throughput ceiling
(the "~50k" cap). At the same time, most relay-adjacent state is **not** actually
shared — a given match is handled by one instance, and per-instance move counts
are local — while a smaller set of state genuinely is contended across instances.

Two reasonable engineers disagree here: put the per-move relay + counter in Redis
(simple, uniform, but contended → caps throughput and adds latency), or keep them
in-process (fast, race-free, but needs seat co-location and reconnect handling).
We modelled each state surface by **who owns it** to resolve it.

## Decision

**Partition by ownership.** Single-owned, per-move state lives in-process (the data
plane); genuinely shared, contended state lives in atomic Redis (the control
plane), kept to per-match or per-second rates. The bus stays the single execution
path: `deliver` resolves local (data plane) vs remote (control-plane pub/sub
_fallback_). Co-location is a latency optimization that shifts traffic onto the
local path; **correctness never depends on it.**

**Data plane — per-instance, in-memory, never Redis on the per-move path:**

| Op                                   | Mechanism                                                 | Rate                            |
| ------------------------------------ | --------------------------------------------------------- | ------------------------------- |
| Frame relay between co-located seats | bus local branch (in-process `mpsc`)                      | per move                        |
| Move counting                        | `LocalActionCounter` (atomics), drained to Redis once/sec | per move (local) / 1 Hz (Redis) |
| Match lookup for routing             | per-connection `MatchRecord` cache                        | per move (after 1 fetch)        |

**Control plane — Redis, atomic, O(per-match) or O(per-second), never per-move:**

| Op                                | Mechanism                                                                                                                                                                                                   | Why it must be shared                                 |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Matchmaking                       | Lua `join-or-pair` on `queue:<game>`                                                                                                                                                                        | two instances must not pair one waiter                |
| Presence                          | CAS set/clear (`presence:<wallet>`)                                                                                                                                                                         | challenge-by-wallet across instances                  |
| Match record + **owner instance** | `match:<id>`; ownership is implicit in the two seat `ConnRef.instance_id`s (conn_a / conn_b) — no explicit `owner_instance_id` field; if re-homing requires one it will be added by the resume/affinity ADR | any instance must resolve a seat                      |
| Invites                           | `invite:<id>` (TTL)                                                                                                                                                                                         | inviter/accepter may be on different instances        |
| **Checkpoints**                   | `latest_checkpoint` on the match record                                                                                                                                                                     | the **durable recovery anchor** (watchtower + settle) |
| Aggregate stats                   | shared `INCRBY` fed by the 1 Hz flush                                                                                                                                                                       | every SSE viewer sees the same global total           |
| Recent-events ring                | Lua dedup-and-push (`events:recent`)                                                                                                                                                                        | one ordered, deduped feed across instances            |
| Cross-instance delivery           | `SPUBLISH mp:inst:<id>`                                                                                                                                                                                     | **fallback** transport for non-co-located matches     |

**The rule, one line:** single-owned state → in-process; genuinely
shared/contended state → atomic Redis at per-match/per-second rates. **Never put a
single-ownable, per-move thing (relay, counter, routing lookup) into the contended
Redis path.** Durability comes from the periodic co-signed **checkpoint** + on-chain
settlement, so we persist checkpoints, **not** moves.

## Consequences

- **Aggregation correctness** is preserved by the merge-commutative primitive rule: each
  instance pushes only its own deltas (never read-modify-writes a shared aggregate), so
  concurrent flushes from N instances compose correctly — INCRBY is grow-only and
  order-independent; SADD/SREM is idempotent; CAS (Lua) is last-writer. The move counter
  is deliberately at-most-once (watermark advances before the push; a failed flush drops
  that interval's delta). Do not add flush retries, which would make it at-least-once and
  double-count. See `store/mod.rs` module doc and the control-plane aggregation-correctness design notes.
- **Throughput scales by adding instances.** The data plane is shard-local and
  race-free by construction; Redis load is O(matches) + O(seconds), never
  O(moves), so Redis stops being the ceiling. This is the change that lifts the
  ~50k cap.
- **Supersedes ADR-0005's _Latency_ consequence.** "One Redis round-trip per
  relayed frame … immaterial" held only under self-play. Under the two-party-only model the
  per-frame pub/sub path is demoted to a **fallback** for matches that aren't
  co-located; the common path is in-process.
- **Realizing the local path needs two follow-ups, each its own ADR:** (a) an
  **affinity mechanism** to co-locate both seats (local-first matchmaking and/or an
  owner-home routing token), and (b) a **resume protocol** so a dropped socket
  reattaches to its match (now specified in [ADR-0010](0010-mp-resume-protocol.md);
  affinity/re-homing remains deferred to a future ADR-0011). Both are _optimizations
  and robustness_ layered on this partition, not preconditions for it: until they
  land, a split match still works correctly over the pub/sub fallback.
- **One coupling to design around:** the per-connection match cache means a
  surviving peer won't observe a re-bound conn ref on the other seat; the resume
  ADR owns cache invalidation (generation bump or a targeted bus rebind signal).
- **Durability is unchanged and deliberately move-free.** Checkpoints persist;
  moves do not. Crash/owner-death resumes from the last checkpoint plus the
  clients' co-signed state. Display counts lose ≤1 flush interval on crash
  (already accepted in `stats_counter.rs`). Funds are never at risk (on-chain).
- **What we explicitly chose not to do:** persist per-move state; route move
  counting / lookup / delivery through Redis on the co-located path; or add a
  relational DB (still none, consistent with ADR-0005).

## Open questions

- **Affinity mechanism** (own ADR): local-first pairing vs owner-home routing
  token vs hybrid; and the ingress it pins against (plain ALB app-cookie stickiness
  vs a WS gateway we control).
- **Resume protocol** (specified in [ADR-0010](0010-mp-resume-protocol.md)):
  `ConnRef` rebind, peer-cache invalidation, FE reconnect loop. Owner-death
  re-homing via a Redis CAS on `owner_instance_id` is deferred to a future
  ADR-0011 (affinity).
