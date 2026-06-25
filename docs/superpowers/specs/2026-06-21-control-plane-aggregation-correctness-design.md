# Control-plane aggregation correctness & store hardening

- **Date**: 2026-06-21
- **Status**: Draft for review
- **Refs**: refines [ADR-0009](../../decisions/0009-data-plane-local-control-plane-redis.md)
  (data plane local / control plane on Redis) and [ADR-0005](../../decisions/0005-redis-backed-ha-control-plane.md)
  (Redis-backed HA). Driven by the `channel-through-server` work.
- **Scope owner**: backend `tunnel-manager` store layer (`backend/tunnel-manager/src/store/`).

## Problem

ADR-0009 partitions state by ownership: single-owned per-move state stays in-process;
genuinely shared state lives in atomic Redis at per-match/per-second rates. The open
question this spec resolves: **how do we guarantee per-instance local state aggregates
correctly once pushed to Redis, without a relational store and without touching the
per-move hot path?**

A surface-by-surface audit of `store/redis.rs` (cross-checked against `store/memory.rs`
and the per-move relay in `mp/ws.rs`) found the _counting_ surfaces already correct, but
several _owned_ surfaces use a non-atomic GET→mutate→SET — the read-modify-write that
breaks under concurrent instances — plus two slow resource leaks.

## The principle

**Aggregating per-instance state correctly = each instance emits only its own deltas into
a structure that merges associatively or idempotently; never read-modify-write a shared
aggregate from an instance.** Three legal shapes, one rule:

| Shape                   | Primitive                             | Why it merges                                                | Surfaces                       |
| ----------------------- | ------------------------------------- | ------------------------------------------------------------ | ------------------------------ |
| **Count**               | `INCRBY` (grow-only counter)          | commutative + associative; instance-count independent        | move counter, per-game counts  |
| **Membership**          | `SADD`/`SREM` (set union)             | idempotent; retries & duplicate instances are free           | active/settled tunnels         |
| **Owned / last-writer** | single key + CAS / atomic field write | not _merged_ — _owned_; conflict resolved by CAS, not summed | match record, presence, invite |

The move counter is already a correct distributed G-counter: `LocalActionCounter`
(`stats_counter.rs`) emits non-overlapping deltas via a per-game watermark, and `INCRBY`
merges them. It is restart-safe because an instance only ever pushes deltas it generated
since boot — it never re-reads and re-adds its own prior contribution. The defects are all
in the **owned** row, where the code does GET→mutate→SET instead of an atomic write.

## Keep as-is (correct by construction — do not touch)

Changing these would be the over-engineering this work is meant to avoid.

- Move-counter G-counter merge (`stats_counter.rs`, `add_actions` per-game `INCRBY`).
- Tunnel active/settled sets (`SADD`/`SREM`/`SCARD`) — idempotent union.
- `join_or_pair` and `leave_queue` — already atomic Lua, cluster-safe (single `KEYS[1]`).
- `push_recent_event` dedup+upgrade — already atomic Lua.
- **Snapshot cross-key skew** (`snapshot()` reads several keys non-atomically): sub-tick,
  display-only, eventually consistent. The `RateWindow` already clamps a backwards-moving
  counter. **Document the invariant; do not add a transaction.**
- **Counter at-most-once loss on crash**: keep it. It is undercount-safe by design (we only
  ever push already-counted deltas, so it never inflates). Do **not** add flush retries —
  that converts at-most-once into at-least-once and risks double-counting a display number.

## Fixes

Each fix removes a non-atomic multi-call dance and replaces it with one atomic op — a net
simplification, not added machinery.

### F1 — Match record as a Redis HASH with independent field writes

- **Defect**: `set_tunnel_id` and `record_checkpoint` (`redis.rs:497–514`) do
  `get_match` → mutate one field → `put_match`. Two instances racing (e.g. a `TunnelOpened`
  writing `tunnel_id` while a watchtower writes `latest_checkpoint`) lose one update.
- **Fix**: store the match as a HASH keyed `match:<id>` with fields `game`, `seat_a`,
  `seat_b`, `conn_a`, `conn_b`, `tunnel_id`, `latest_checkpoint`, and `checkpoint_nonce`.
  `conn_a`/`conn_b`/`latest_checkpoint` hold **opaque JSON strings produced by Rust**;
  `game`/`seat_a`/`seat_b`/`tunnel_id` are plain strings; `checkpoint_nonce` is a plain
  integer. `set_tunnel_id` → `HSET tunnel_id` (one independent field). `record_checkpoint`
  → an O(1) Lua that compares the incoming nonce to `checkpoint_nonce` and `HSET`s the new
  `latest_checkpoint` (verbatim) + `checkpoint_nonce` only if newer (monotonic CAS).
  `get_match` → `HGETALL`, reassemble the struct field-by-field. Independent fields can no
  longer clobber each other.
- **Why opaque field + separate nonce (load-bearing)**: a Lua RMW on a single JSON blob is
  rejected because it must `cjson.decode`/`encode` the whole record on every write, and
  Redis's embedded Lua represents numbers as **doubles** — so `party_a_balance` /
  `party_b_balance` (`u64`) above 2^53 (~9M SUI in MIST) would be silently corrupted. Those
  balances are submitted **on-chain** (`sui.rs:433-434`) and covered by the checkpoint's
  `sig_a`/`sig_b`, so corruption breaks watchtower/settle. Storing the checkpoint as an
  opaque string written **verbatim** (Rust's `serde_json` keeps `u64` exact) and keeping the
  CAS on a separate integer `checkpoint_nonce` means the Lua never `cjson`-touches a balance.
- **TTL**: a HASH has no per-write TTL like `SET EX`. Fold `HSET … ; EXPIRE match:<id> 21600`
  into one Lua/pipeline so writes stay one round-trip and the 6h lifetime is preserved;
  refresh TTL on field writes too.
- **Memory impl**: unchanged in behavior — already atomic under one `RwLock` write guard.

### F2 — `take_invite` as one atomic Lua

- **Defect**: `take_invite` (`redis.rs:441–462`) does `GET` → check `to == accepter` →
  `DEL`. A retried/double-clicked accept lets two calls both pass the check and both return
  `Some(invite)` → two match creations.
- **Fix**: one Lua — `GET`; if absent or `to != accepter` return nil; else `DEL` and return
  the JSON. Single-winner by construction. Memory impl already atomic.

### F3 — Presence collapsed to one key

- **Defect**: `set_presence` (`redis.rs:325–354`) writes two keys (`presence:<wallet>` for
  the CAS, `presence:ref:<wallet>` for the full ConnRef). `clear_presence_if` Lua deletes the
  primary then a _separate_ `DEL` clears the mirror — if that second `DEL` fails the mirror
  orphans, and presence keys have no TTL, so orphans accumulate unbounded.
- **Fix**: one key `presence:<wallet>` holding the full ConnRef JSON. `set_presence` →
  one `SET`. `clear_presence_if` Lua → `cjson.decode` the stored value, compare `conn_id`,
  `DEL` if it matches — one atomic op, no mirror, no orphan. `get_presence` → one `GET` +
  decode. Memory impl already single-key.

### F4 — Drop `stats:actions:total`, derive it

- **Defect**: `add_actions` (`redis.rs:150`) does two `INCRBY` (total + per-game),
  non-atomic, so total can diverge from the per-game sum.
- **Fix**: write only `stats:actions:game:<game>`. `snapshot` already scans the per-game
  keys; sum them for `total_actions`. One source of truth, divergence impossible.
- **Scalability bonus**: `stats:actions:total` was the single key every instance writes
  every second — one hash slot on one shard. Removing it distributes stats writes across
  shards by game (see Scalability section).

### F5 — `events:seen` self-cleaning dedup

- **Defect**: the dedup set `events:seen` (`redis.rs:32`) is never pruned → slow unbounded
  growth.
- **Fix**: inside `PUSH_RECENT_EVENT`, replace the `SADD events:seen <digest>` membership
  check with a per-digest `SET events:seen:<digest> 1 NX EX <window>` (still one op inside
  the existing Lua). `NX` gives the same "is this new?" signal; `EX` bounds the keyspace.
  Pick `<window>` ≥ the indexer's max cursor-replay horizon.

### Shutdown flush (the one addition to the counter path)

`shutdown_signal()` (`main.rs:129`) currently just logs and returns, so even a clean
SIGTERM rollout drops the last ≤1s of counted moves. Add a final
`drain_deltas → add_actions` before the runtime exits. One extra batch at shutdown; no
steady-state cost. This is the only counter change — the at-most-once semantics stay.

## Scalability & performance impact

**The per-move hot path is untouched.** Steady-state relay stays: one `RwLock` read for the
counter, one for `deliver`, zero Redis (per-connection match cache), no await-under-lock.
ADR-0009's "throughput scales by adding instances" property is fully preserved.

Every fix is perf-neutral-to-positive on its (cold, control-plane) path:

| Change         | Redis round-trips                       | Effect                                                                                  |
| -------------- | --------------------------------------- | --------------------------------------------------------------------------------------- |
| F1             | `set_tunnel_id`/`record_checkpoint` 2→1 | off hot path; fewer round-trips                                                         |
| F2             | 2→1                                     | per-match; fewer                                                                        |
| F3             | `set_presence` 2→1, `clear` up-to-2→1   | per-connection; fewer + less memory                                                     |
| F4             | `add_actions` 2→1 INCRBY                | removes the one universally-write-contended key; distributes stats writes across shards |
| F5             | unchanged                               | bounds a memory leak                                                                    |
| shutdown flush | +1 batch at SIGTERM                     | negligible                                                                              |

Watch-items: keep all new Lua O(1) (no `LRANGE`/loops) so they never block the shard; fold
F1's `HSET`+`EXPIRE` into one Lua/pipeline so `put_match` stays a single round-trip.

## Rollout / compatibility (the real side effect)

F1 and F3 change the **Redis wire format** of ephemeral keys (`match:` STRING-JSON → HASH;
`presence:` two keys → one); F4 stops writing `stats:actions:total`. During a rolling deploy,
old and new instances disagree on shape for the rollout window.

**Decision: flag-day for these keys, no dual-read/write shim.** Matches, presence, and
invites are all ephemeral with TTLs, and the system already tolerates reconnect (a pubsub
blip degrades PvP the same way). In-flight matches during the deploy window fall back to
reconnect / on-chain dispute — funds never at risk. For F4, `total` briefly differs during
rollout and self-heals once all instances are new (display-only). A dual-read shim would add
exactly the kind of complexity this work removes; rejected.

## Testing

- **Unit (memory impl, fast)**: pairing/routing logic is unchanged; existing tests stay
  green. Add: `record_checkpoint` keeps the highest nonce under interleaved writes;
  `take_invite` returns `Some` to exactly one of two concurrent accepters; `clear_presence_if`
  only deletes on conn-id match.
- **Integration (Redis impl, focused)**: F1 — concurrent `set_tunnel_id` + `record_checkpoint`
  on one match preserves both fields (the lost-update regression). F2 — two concurrent
  `take_invite` calls yield one `Some`, one `None`. F4 — `snapshot().total_actions` equals the
  sum of per-game keys after interleaved `add_actions`. F5 — a replayed digest within the
  window dedups; after the window it is allowed (and the old key has expired).
- **Parity**: assert memory and Redis impls agree on the above (the store-trait golden tests).
- Name tests by behavior; no retry-loops on flakes.

## ADR / doc follow-ups

- Add an **"Aggregation correctness"** subsection to ADR-0009 stating the merge-primitive
  principle and the explicit at-most-once / undercount-safe trade.
- **Correct ADR-0009 drift**: it lists `owner_instance_id` on the match record, but the code
  has no such field — ownership is implicit in the two `ConnRef.instance_id`s. Either add the
  field (if the resume/affinity ADRs need it) or strike it from ADR-0009. Recommend striking
  it here and letting the resume ADR introduce it when it actually needs re-homing.

## Out of scope / deferred

- **Hot-path micro-optimizations** (per-move `ConnRef` clone, envelope re-serialize, fallback
  `Value` parse): marginal, and they trade clarity for nanoseconds. The big win (single-parse
  via the outer `kind` tag) already landed. Explicitly not pursued.
- **Out-of-order tunnel lifecycle events** (Closed-before-Active skewing active/settled
  counts): an indexer-ordering concern, not aggregation. Its own thread.
- **`put_session` per-game tunnel over-count on re-register**: noted; advisory display metric,
  on-chain is authoritative. Revisit only if it visibly drifts.
- **Resume protocol & match-cache invalidation**: owned by the resume ADR (ADR-0009 §Open
  questions), unchanged here.
