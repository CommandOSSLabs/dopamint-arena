# Local-first pairing — co-located matches use the in-process channel, not Redis

- **Date**: 2026-06-24
- **Status**: Draft (design)
- **Refs**: realizes the **affinity mechanism** deferred by
  [ADR-0009](../../decisions/0009-data-plane-local-control-plane-redis.md)
  §Consequences / §Open questions (the local-first half; re-homing stays
  deferred). Relies on the data-plane `deliver` fast path established there and
  the resume machinery in
  [ADR-0010](../../decisions/0010-mp-resume-protocol.md).

## Problem

When two players happen to connect to the **same** relay instance, every move
between them *could* be relayed entirely in-process. Today it often isn't —
because matchmaking is instance-blind, the pair is frequently split across
instances and forced onto the Redis `SPUBLISH` per-frame path for the life of
the match.

The gap is in **matchmaking, not relaying**. Two facts from the current code:

- **The local channel already exists.** `Bus::deliver`
  (`backend/tunnel-manager/src/store/redis.rs:776`) routes a frame in-process
  when the target seat is on this instance, and only `SPUBLISH`es otherwise:

  ```rust
  if target.instance_id == self.instance_id {
      let tx = self.conns.read()…get(&target.conn_id);  // the peer's socket sender
      tx.send(text);                                      // in-process; no Redis
  } else { /* SPUBLISH mp:inst:<id> */ }
  ```

  `relay_to_other` (`mp/ws.rs:533`) reads the `MatchRecord` from a per-connection
  cache (one `get_match` to warm it, then never again) and counts moves with an
  in-process atomic. So a **co-located** match already does zero Redis per move.

- **Matchmaking never prefers co-location.** `JOIN_OR_PAIR`
  (`redis.rs:289`) pops the **FIFO front** of the global `queue:<game>`,
  ignoring instance:

  ```lua
  if w.wallet ~= ARGV[2] then return front end   -- first different-wallet, any instance
  ```

  So two players on the same instance are routinely paired with partners on
  *other* instances, and both resulting matches pay the cross-instance Redis hop
  on every move.

This is **opportunistic** co-location: we do **not** move or re-home anyone.
Players are paired by whoever is already connected where; we only capitalize on
the case where two of them landed on the same instance.

## Decision

**Local-first pairing.** When a player joins a quick-match queue, prefer a
waiting opponent **on the same instance**; fall back to the current FIFO-front
behavior when there is none. The resulting `MatchRecord` then has both seats'
`ConnRef`s on one instance, so the existing `deliver` local branch carries every
move in-process — no Redis on the per-move path.

Correctness never depends on co-location: a split match (no same-instance
partner available) is still paired and still works over the existing pub/sub
fallback, exactly as today. This only changes *who pairs with whom*, never
whether a valid match forms.

### The change — `JOIN_OR_PAIR` (the only substantive edit)

The `Waiting` entry already carries the instance:
`Waiting { wallet, conn: ConnRef { instance_id, conn_id } }`
(`mp/mod.rs:19`). So the joiner's instance is already available; **no struct or
`MpStore` trait change** is needed — the Rust caller (`redis.rs:439`) just passes
`me.conn.instance_id` as a new `ARGV[3]`.

New script behavior (replacing the destructive LPOP loop):

1. `LRANGE` the (short) queue once.
2. Choose, in priority order:
   - the first different-wallet entry whose `conn.instance_id == ARGV[3]`
     (**co-located**), else
   - the first different-wallet entry (**FIFO fallback** — today's choice).
3. `LREM` the chosen entry and return it; also `LREM` any stale self-entries
   (`wallet == ARGV[2]`), preserving the current self-drain.
4. If no opponent exists, `RPUSH` self and return nil (unchanged).

The whole script still runs as one atomic Redis evaluation, so the existing
guarantees hold:

- **Pairs each waiter exactly once under concurrency** — two concurrent joiners
  cannot claim the same entry, because each script runs to completion atomically
  (preserves `join_or_pair_pairs_each_waiter_exactly_once_under_concurrency`,
  `redis.rs:1086`).
- **Never pairs a wallet with itself** — self-entries are excluded and drained
  (preserves `join_or_pair_never_pairs_wallet_with_itself`, `redis.rs:1274`).

`memory.rs` (single-instance store, used in tests/local dev) is co-located by
construction — all waiters share one `instance_id` — so prefer-same-instance
degenerates to FIFO front. **No behavioral change there.**

## What stays unchanged

- **`deliver`, the relay hot path, and the per-connection match cache** — already
  in-process for co-located seats; this change just routes more matches into that
  path.
- **The match record in Redis** (`put_match`, once per match) — kept; it is the
  durable anchor resume relies on (ADR-0010). It is per-*match*, off the per-move
  hot path.
- **Resume (ADR-0010)** — unaffected. A co-located match that drops and
  reconnects resumes exactly as today; if the returning socket lands on a
  different instance the match simply becomes split (correct, over the fallback).
- **Challenge-by-wallet / invites** — directed pairing of two specific wallets
  wherever they are connected; local-first does not apply. Co-location remains
  incidental there. Left as-is.

## Consequences

- **Co-location rate tracks concurrency, by design.** When a queue holds several
  waiters (busy game, few instances), most joins find a same-instance partner and
  co-locate. At low load (0–1 waiters) it degrades to ~1/N — no worse than today.
  The win is opportunistic and self-scaling with traffic, not guaranteed.
- **Fairness: a slight, bounded bend of FIFO.** Preferring a same-instance waiter
  can let a later arrival pair ahead of the front waiter. With short queues this
  is negligible, and the front waiter is still served the moment a joiner has no
  same-instance partner. If starvation ever shows up, bound the preference to the
  first *K* entries — deliberately **out of scope** here.
- **Scale note.** A single global `queue:<game>` with an O(n) in-script scan is
  fine while pairing keeps the queue short. If matchmaking-queue contention
  appears at extreme scale, shard the queue per instance (which also hardens
  locality). Out of scope now.

## Observability

Add a **co-located vs. split** counter, incremented at match creation by
comparing the two seats' `instance_id`s, exported alongside the existing
`tunnel_actions_total` (`routes.rs` `/metrics`). This is the single number that
tells us whether the optimization is doing anything in production; without it the
effect is invisible.

## Out of scope (explicitly not in this change)

- **Re-homing / moving a player** to the peer's instance, and the per-instance
  public addressing it would require (per-task DNS/TLS). Deferred — revisit only
  if guaranteed co-location is ever needed.
- **Direct instance-to-instance transport** to replace the Redis fallback for
  genuinely cross-instance matches. Separate effort.
- **Session stickiness** (helps human reconnects re-land on the same instance).
  A small infra-only follow-up, not required here.
- **Strict local-only matching pool + human reserve floor** (the agent-fleet
  `scaled-relay-agent-fleet-design.md` §4/§6.1 throughput design). That is a
  separate, larger piece; this change is the minimal opportunistic version.

## Testing

Behavioral tests on `join_or_pair` (Redis integration, testcontainers — the
multi-instance behavior cannot be exercised by the single-instance memory store):

- **Co-locates when possible**: queue `[A-waiter, B-waiter]`, joiner on instance
  B → pairs the **B-waiter** (same instance), leaving the A-waiter queued.
- **FIFO fallback when not**: queue `[A-waiter]`, joiner on instance B → pairs the
  **A-waiter** (split match still forms).
- **Preference is by instance, not order**: a same-instance waiter behind an
  earlier cross-instance waiter is still chosen.
- **Invariants preserved**: never pairs self; stale self-entries drained; exactly
  one pairing under concurrent joiners (existing tests stay green).
- **Metric**: match creation increments the co-located or split counter to match
  the seats' instances.

## Follow-up

Record the accepted decision as **ADR-0011** under `docs/decisions/` (the
affinity mechanism ADR-0009 deferred), scoped to the local-first half; re-homing
and instance-to-instance transport remain deferred.
