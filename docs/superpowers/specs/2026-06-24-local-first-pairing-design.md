# Local-first pairing — bounded-hold matchmaking + reconnect affinity

- **Date**: 2026-06-24
- **Status**: Draft (design)
- **Refs**: realizes the **affinity mechanism** deferred by
  [ADR-0009](../../decisions/0009-data-plane-local-control-plane-redis.md)
  §Consequences / §Open questions, and the **re-homing / affinity follow-up**
  that [ADR-0010](../../decisions/0010-mp-resume-protocol.md) §Consequences
  explicitly punts to "future affinity ADR (0011)". Builds on the data-plane
  `deliver` fast path (ADR-0009) and the resume machinery (ADR-0010).
- **Supersedes**: the earlier draft of this file (the "prefer same-instance, fall
  back to FIFO front" sketch), which analysis showed to be a no-op — see
  §"Why the naive version does nothing".

## Problem

When two players connect to the **same** relay instance, every move between them
*can* be relayed entirely in-process — `Bus::deliver`
(`backend/tunnel-manager/src/store/redis.rs`) routes a frame to the peer's socket
directly when the target seat is on this instance, and only `SPUBLISH`es across
instances. The local channel already exists; the win is real and free **when a
match is co-located**.

But matchmaking is instance-blind. `JOIN_OR_PAIR` pops the FIFO front of the
global `queue:<game>`, so two same-instance players are routinely paired with
partners elsewhere, and both matches pay the cross-instance Redis hop on every
move for the life of the match. We want to **produce** co-location at pairing
time, and **keep** it across reconnects.

### Why the naive version does nothing

The obvious change — "prefer a same-instance waiter, else pair the FIFO front" —
is a **no-op**. Under immediate pairing the queue holds **at most one waiter at
any instant**: every `join_or_pair` either removes a waiter (pair) or adds one
(park), and with distinct wallets it always pairs when *any* waiter is present.
So a joiner never sees two waiters to choose between, and "prefer same-instance"
never has a second candidate. Co-location stays at chance (~1/N for N
instances) — exactly today's rate. (The existing concurrency test's "25 parked"
counts call return values, not simultaneous queue depth; max depth is still 1.)

The only way to raise co-location above chance is for a joiner to **sometimes
decline an available cross-instance opponent and wait** for a same-instance one.
That waiting is the essential ingredient; it is what lets the queue accumulate
multiple waiters so the preference has teeth. The design axis is simply *how long
to wait*:

| Hold T | Behavior | Co-location | Liveness |
|--------|----------|-------------|----------|
| T=0 (immediate fallback) | pair with anyone present | chance — **no-op** | fine |
| T=∞ (local-only) | only ever pair same-instance | guaranteed | **starves** cross-instance-only players |
| 0<T<∞ (bounded hold) | wait up to T for local, then fall back | **> chance** | fine, +bounded latency |

Per-instance queue sharding does **not** remove this requirement — it makes the
local lookup cheaper but a joiner that finds its shard empty must still either
hold or fall back. So the design is the **bounded hold**.

## Decision

1. **Bounded-hold matchmaking.** A joiner pairs immediately with a same-instance
   waiter if one exists; otherwise it pairs with a waiter that has already waited
   past its hold deadline; otherwise it **parks** with a deadline `now + T`. A
   per-waiter timer on the parking instance fires the cross-instance fallback when
   the hold expires. Default `T = 750 ms`, env-tunable via `MP_PAIR_HOLD_MS`.

2. **Reconnect affinity via LB session stickiness.** The relay sets a per-client
   affinity cookie on the WebSocket handshake; the load balancer routes reconnects
   back to the same instance, so a co-located match that drops returns co-located.
   The resume protocol (ADR-0010) is unchanged — affinity only influences *which
   instance* the resumer lands on, never correctness.

3. **Observability.** Per-instance counters for co-located vs. split matches and
   for hold-fallback matches, exported on `/metrics`.

Correctness never depends on co-location: a split match still forms and works over
the existing pub/sub fallback. The hold only delays *which* opponent a player
gets, never *whether* a valid match forms.

## Component 1 — Bounded-hold matchmaking

### Queue entry deadline

When a player parks, the script stamps a `deadline` (absolute ms) onto the queue
entry, computed inside Lua as `redis TIME + hold_ms`. Using **Redis's own clock**
(not any instance's wall clock) means every instance's script agrees on "now"
with zero skew — essential because waiters parked by one instance are read and
expired by scripts running on others.

`Waiting { wallet, conn }` is **unchanged**. The `deadline` is a Lua-managed field
on the stored queue JSON; Rust does not model it and ignores it on the way back
out (serde drops unknown fields on deserialize). cjson round-trips the entry
(`{wallet, conn:{instance_id, conn_id}, deadline}`) — no balance or signature is
ever re-encoded, preserving the byte-exactness rule that applies to checkpoints
(not relevant here, but the convention holds).

### `JOIN_OR_PAIR` (one atomic eval)

```
KEYS[1]=queue:<game>
ARGV[1]=selfJson  ARGV[2]=selfWallet  ARGV[3]=selfInstance  ARGV[4]=holdMs

now  := redis TIME → ms
items := LRANGE KEYS[1] 0 -1
colocated, expired := nil, nil
for each v in items:
  w := cjson.decode(v)            -- pcall-guarded
  if w.wallet == selfWallet:
    LREM KEYS[1] 1 v              -- drain stale self-entry
  else:
    if colocated == nil and w.conn.instance_id == selfInstance: colocated := v
    if expired   == nil and w.deadline ~= nil and w.deadline <= now: expired := v
if colocated: LREM KEYS[1] 1 colocated; return colocated   -- co-located pair (any time)
if expired:   LREM KEYS[1] 1 expired;   return expired      -- cross-instance fallback
selfWithDeadline := inject deadline=now+holdMs into selfJson
RPUSH KEYS[1] selfWithDeadline
return false                                                -- parked
```

Priority: **same-instance always wins**; a cross-instance opponent is taken only
once it has waited out its own hold. A joiner with neither parks — which is what
makes the queue hold several waiters and lets later same-instance joiners
co-locate.

### Per-waiter hold timer (event-driven, no global sweep)

The instance that parks a waiter owns that waiter's socket, so it arms a
`tokio::time::sleep(hold_ms)` task. On expiry it runs a **fallback-pair** eval:

```
KEYS[1]=queue:<game>  ARGV[1]=selfWallet
items := LRANGE
if no entry with wallet==selfWallet: return nil      -- already paired; no-op
opp := first entry with wallet ~= selfWallet         -- oldest different-wallet waiter
if opp: LREM self; LREM opp; return opp
return nil                                            -- no opponent yet; stay parked
```

- **Busy case:** a same-instance joiner pairs the waiter before its timer fires;
  the timer then no-ops.
- **Idle two-player case:** A(i1) and B(i2) both park; the first timer to fire
  pairs them cross-instance — no starvation, no periodic scanner.
- **Lone waiter:** A parks with no opponent; its timer fires, finds none, leaves
  it parked. A is paired when any future joiner arrives (the join path treats a
  past-deadline waiter as `expired`). If no opponent ever arrives, A waits — which
  is correct, there is no one to play.

### Shared match-creation path

Both the join handler and the timer-expiry handler call one helper —
`create_and_announce_match(state, game, seat_x: Waiting, seat_y: Waiting)`:

1. build the `MatchRecord`, `put_match` (once per match, off the hot path),
2. `deliver` `MatchFound` to **both** seats over the bus (in-process or pub/sub),
3. `populate` the non-local seat's relay cache (the local seat warms directly),
4. bump the pairing metric (§Component 3).

In the join case one seat is the local joiner (as today). In the timer case the
local seat is the waiter whose timer fired; the opponent may be remote — handled
by the same `deliver`/`populate` cross-instance machinery that already notifies a
parked waiter today. This consolidates the two existing match-announce blocks in
`ws.rs` (the `QueueJoin` arm) into one reused function.

### Invariants preserved

- **Exactly-once under concurrency:** `JOIN_OR_PAIR` and fallback-pair are each a
  single atomic eval; `LREM` removes the claimed entry, so two instances racing
  (two joins, or a join racing a timer) cannot double-pair the same waiter.
- **Never pairs a wallet with itself / drains stale self-entries:** the
  `wallet == selfWallet` branch both skips self as an opponent and `LREM`s it.
- **Memory store behavior unchanged:** single instance ⇒ every waiter is
  same-instance ⇒ the co-located branch always hits ⇒ immediate FIFO; the hold and
  timers never engage. The `MpStore` method gains a `hold_ms` parameter and a
  `fallback_pair` method; the memory impl pairs immediately and its `fallback_pair`
  is effectively unreachable (nothing ever parks waiting for a local partner).

## Component 2 — Reconnect affinity (LB session stickiness)

A co-located match drops when a socket dies; the resume protocol (ADR-0010)
re-attaches it. Today the load balancer may route the reconnect to any instance,
so the match can come back **split**. Affinity steers the reconnect back to the
same instance.

**Mechanism (chosen): per-client affinity cookie.**

- *App:* `mp_upgrade` sets `Set-Cookie: aff=<instance_id>` on the WebSocket
  handshake response. No other app change; resume logic is untouched.
- *Ops (outside this repo):* enable cookie-based stickiness on the load balancer
  so a reconnect carrying `aff` is routed to that instance. Documented as a
  required deployment step.
- *Why it works:* the cookie is per-client, returning each player to **its own**
  last instance. For a co-located match both players' last instance is the same →
  both return → still co-located. For a split match each returns to its own →
  unchanged. It never makes co-location worse.
- *Failure mode — instance death:* the cookie points at a dead instance; the LB
  reroutes to a live one; players scatter; resume keeps the match **correct** over
  the Redis fallback (exactly today's behavior). This scatter is inherent — you
  cannot route to a dead pod — and is **not** something this design tries to beat.

**Rejected / deferred — per-instance addressing + redirect-on-resume.** Precise
enough to send a player to the *peer's* instance even if the player's own instance
moved, but it requires per-pod public DNS + TLS (the per-task addressing ADR-0009
deferred) plus an app redirect path and FE redial logic. Its extra precision only
matters when a player's own instance dies mid-match — which scatters under both
mechanisms — so it buys little for a lot of infra. Out of scope here.

## Component 3 — Observability

Per-instance counters, exported on `/metrics` alongside `tunnel_actions_total`:

- `tunnel_matches_colocated_total` — both seats on one instance (in-process relay).
- `tunnel_matches_split_total` — seats across instances (Redis-fallback relay).
- `tunnel_matches_hold_fallback_total` — match formed via the expired/timer
  cross-instance fallback rather than a same-instance pairing.

Co-located/split is the headline (is co-location happening?); hold-fallback is the
cost signal (how often did the hold expire without finding a local partner?).
Per-instance by design — co-location is an instance-local outcome and Prometheus
sums across scraped instances. Incremented in `create_and_announce_match`.

## What stays unchanged

- **`deliver`, the relay hot path, the per-connection match cache** — already
  in-process for co-located seats; this change routes more matches into that path.
- **The match record in Redis** (`put_match`, once per match) — the durable anchor
  resume relies on; off the per-move path.
- **Resume protocol (ADR-0010)** — rebind, peer-reconcile, evict/populate, grace
  window: all unchanged. Affinity changes only which instance a resumer lands on.
- **Challenge-by-wallet / invites** — directed pairing of two specific wallets
  wherever they are; the hold does not apply. Co-location stays incidental there.

## Consequences

- **Co-location now scales with traffic *and* the hold.** Under load, same-instance
  partners arrive within T and matches co-locate; at low load the hold expires and
  matches form cross-instance (no worse than today, plus up to T latency).
- **Bounded added matchmaking latency.** A cross-instance match costs up to `T`
  (default 750 ms) extra before forming. Same-instance matches and any join that
  finds an already-expired waiter pay nothing. Tunable via `MP_PAIR_HOLD_MS`.
- **Fairness: a bounded bend of FIFO.** A same-instance joiner can pair ahead of an
  earlier cross-instance waiter, but only until that waiter's deadline, after which
  it is taken. No indefinite starvation.
- **One global `queue:<game>` with an O(n) in-script scan** stays fine while queues
  are short. Shard per instance later if matchmaking contention appears.
- **Affinity is best-effort.** Transient reconnects re-land co-located; instance
  death scatters to split (correct). Stickiness is a one-time LB config.

## Out of scope

- Per-instance addressing / redirect-on-resume (Mechanism B).
- Any change to the resume protocol itself.
- Per-instance queue sharding.
- Beating the instance-death scatter (proactive re-homing / live migration).
- The agent-fleet strict local-only pool + human reserve floor (separate, larger
  effort).

## Testing

Redis-integration (testcontainers — multi-instance behavior cannot be exercised by
the single-instance memory store), behavioral names:

- **Co-locates when a local partner arrives within the hold:** park A(i1); B(i1)
  joins → pair A&B; metric `colocated`.
- **Holds, then falls back:** park A(i1); B(i2) joins (no local, A not expired) →
  B parks, queue holds two; past the deadline, the next join (or timer) pairs them
  cross-instance; metric `hold_fallback` + `split`.
- **Idle two-player fallback:** A(i1), B(i2) park with no further joins → the first
  timer firing pairs them (no starvation).
- **Lone waiter never force-paired:** A parks alone, timer fires, no opponent →
  stays parked.
- **Invariants stay green:** exactly-once under concurrency, never-pair-self,
  self-drain (existing tests, possibly re-parameterized for the `hold_ms` arg).
- **Single-instance degeneracy:** memory store pairs immediately; hold never
  engages.

Time control: tests drive the deadline window with a short `hold_ms` (a few ms) and
a brief real sleep past it, or exercise the expired branch directly by parking with
a near-zero hold. The exact harness is settled in the plan. A small fixture
readiness retry (already added) covers the testcontainers/redis startup race.

## Phasing (for the implementation plan)

Each phase is independently shippable and reviewable:

1. **Bounded-hold matchmaking** + the shared `create_and_announce_match` path
   (folds in the committed `JOIN_OR_PAIR` generalization and the fixture readiness
   fix).
2. **Pairing metric** — co-located / split / hold-fallback counters on `/metrics`.
3. **Affinity cookie** in `mp_upgrade` + a docs note on the required LB stickiness
   config.

## Follow-up

Rewrite **ADR-0011** to record the accepted decision (bounded-hold pairing +
cookie-stickiness affinity), capturing the no-op analysis as the rationale for
rejecting immediate fallback. This closes the affinity follow-up ADR-0010 points
to. Re-homing / per-instance addressing remain deferred.
