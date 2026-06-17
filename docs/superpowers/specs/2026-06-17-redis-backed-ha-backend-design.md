# Redis-backed, horizontally-scalable backend — design spec

- **Date**: 2026-06-17
- **Status**: Approved (design)
- **Refs**: ADR `docs/decisions/0005-redis-backed-ha-control-plane.md`; builds on
  ADR-0002 (control-plane) + ADR-0004 (PvP lane). Deploy target: the AWS infra
  (≥2 Fargate tasks behind an ALB).

## Goal

Make `tunnel-manager` correct at **desired count ≥ 2** by moving all shared state to
**Redis** and delivering cross-instance messages over **sharded pub/sub** — with no
Postgres. Preserve the existing wire contracts (ADR-0002 HTTP, ADR-0004 WS) byte-for-byte;
the FE sees no protocol change. Keep the pairing/routing logic in fast unit tests.

## In scope

1. A storage seam (`ControlStore`, `MpStore`, `Bus` traits) with **in-memory** impls
   (today's behavior; tests + local dev) and **Redis** impls (prod/HA).
2. The cross-instance delivery primitive (`Bus::deliver` + a per-instance subscription).
3. Atomic matchmaking across instances (Lua `join-or-pair`).
4. Shared stats counters + per-instance SSE that all report the same global numbers.
5. Deploy contract: `/health/live` + `/health/ready`, a multi-stage Dockerfile, Redis config.
6. Concurrent settlement: PTB-batched self-play closes + non-shared gas (address balance or a
   Redis-leased coin pool) so closes scale at the 1M-TPS target without equivocation.

## Out of scope (non-goals)

Postgres / any relational store; leaderboards / player profiles / queryable history;
warm pools; per-message wallet re-auth. Carryovers from ADR-0004 remain open
(pubkey↔wallet binding, on-chain watchtower submission, disconnect queue cleanup).

## Architecture

```
        ALB (round-robin)            ElastiCache (cache cluster)        ElastiCache (pubsub cluster)
        │                            session:* presence:* queue:*       channel mp:inst:<id>
   ┌────┴─────┐  ┌──────────┐        invite:* match:* stats:*           (sharded pub/sub)
   │ task A   │  │ task B   │  ──────────────► shared KV/counters ◄───── deliver() crosses tasks here
   │ sockets  │  │ sockets  │
   │ conn→tx  │  │ conn→tx  │  each task: 1 local socket map + 1 SSUBSCRIBE mp:inst:<self> + own chain indexer
   └──────────┘  └──────────┘
```

- **Local to each task (never shared):** `conns: HashMap<ConnId, mpsc::Sender<String>>`
  (live socket writers) and the subscription to its own `mp:inst:<instanceId>` channel.
- **Shared in Redis cache cluster:** sessions, tunnel registry, stats counters, presence,
  queues, invites, matches.
- **Redis pubsub cluster:** the per-instance delivery channel only.

## Storage seam (the traits)

All async (`#[async_trait]`). Injected into `AppState` as `Arc<dyn …>`. The **in-memory
impl is today's code** (RwLock maps / atomics); the **Redis impl** uses `fred`.

```rust
#[async_trait]
pub trait ControlStore: Send + Sync {
    async fn put_session(&self, id: &str, rec: SessionRecord);
    async fn get_session(&self, id: &str) -> Option<SessionRecord>;
    // tunnel registry (indexer-written, single logical writer)
    async fn set_tunnel_status(&self, id: &str, s: TunnelStatus);
    async fn get_tunnel_status(&self, id: &str) -> Option<TunnelStatus>;
    // stats counters — maintained at write time (cheapest correct cache)
    async fn add_actions(&self, game: &str, delta: u64);
    async fn snapshot(&self, tick_ms: u64) -> StatsSnapshot;
}

#[async_trait]
pub trait MpStore: Send + Sync {
    async fn set_presence(&self, wallet: &str, at: ConnRef);
    async fn get_presence(&self, wallet: &str) -> Option<ConnRef>;
    async fn clear_presence_if(&self, wallet: &str, conn: ConnId); // only if it still points at `conn`
    /// Atomic across instances: pair with a different waiter, else enqueue self. Returns the
    /// paired opponent's ConnRef+wallet, or None if enqueued.
    async fn join_or_pair(&self, game: &str, me: Waiting) -> Option<Waiting>;
    async fn leave_queue(&self, game: &str, wallet: &str);
    async fn put_invite(&self, match_id: &str, inv: DirectedInvite);
    async fn take_invite(&self, match_id: &str, accepter: &str) -> Option<DirectedInvite>;
    async fn drop_invite(&self, match_id: &str);
    async fn put_match(&self, match_id: &str, m: MatchRecord);
    async fn get_match(&self, match_id: &str) -> Option<MatchRecord>;
    async fn set_tunnel_id(&self, match_id: &str, tunnel_id: &str);
    async fn record_checkpoint(&self, match_id: &str, cp: Checkpoint); // keep highest nonce
}

#[async_trait]
pub trait Bus: Send + Sync {
    /// Deliver `text` to a specific connection, wherever it lives.
    async fn deliver(&self, target: &ConnRef, text: String);
}

/// Where a connection lives. `ConnId` stays a uuid; `instance_id` is this task's id.
pub struct ConnRef { pub instance_id: String, pub conn_id: ConnId }
```

`MatchRecord` now stores each seat as a `ConnRef` (so the relay knows the owning instance).
The pairing decision (seat A = earlier waiter / inviter) is unchanged — only *where* the
queue lives moves.

## `Bus::deliver` semantics (the crux)

```
deliver(target):
  if target.instance_id == self.instance_id:
      if let Some(tx) = local_conns.get(target.conn_id): tx.send(text)   // local socket
  else:
      SPUBLISH "mp:inst:<target.instance_id>"  json{ conn: target.conn_id, text }
```

Each task runs one subscriber on `mp:inst:<self>`; on a message `{conn, text}` it does the
local `local_conns.get(conn)?.send(text)`. Every server→client send — `match.found`,
`challenge.incoming`, and **relayed frames** — calls `deliver`. The relay still never parses
the payload; `deliver` moves an opaque string.

The in-memory `Bus` impl (single instance) is just the local-socket branch.

**Disconnect cleanup** (folds in the ADR-0004 cuts, since this rewrites the path): on socket
close, `clear_presence_if(wallet, conn)` (compare-and-delete — only removes presence if it
still points at *this* conn, so a reconnect's newer entry survives) and `leave_queue(game,
wallet)` for any game the wallet was queued in (no ghost `Waiting`). Both are store ops, so
they work across instances.

## Redis key schema (cache cluster)

| Key | Type | Value | TTL |
|---|---|---|---|
| `session:<id>` | string | JSON `SessionRecord` | 24h |
| `tunnel:<id>` | string | `created\|active\|closed` | none (idempotent indexer replay) |
| `stats:actions:total` / `stats:actions:game:<g>` | counter | `INCRBY` (each heartbeat hits one task → counted once) | none |
| `stats:tunnels:active` / `stats:tunnels:settled` | **set** of tunnelIds | `SADD` on activate, `SREM` active + `SADD` settled on close; count = `SCARD` | none |
| `presence:<wallet>` | string | JSON `ConnRef` | refreshed; cleared on disconnect |
| `queue:<game>` | list | JSON `Waiting` per element | none (drained by pairing) |
| `invite:<matchId>` | string | JSON `DirectedInvite` | 60s |
| `match:<matchId>` | string | JSON `MatchRecord` | refreshed; e.g. 6h |

Pub/sub channel (pubsub cluster): `mp:inst:<instanceId>` via **sharded** `SSUBSCRIBE`/`SPUBLISH`.

## Atomic `join_or_pair` (Lua, single key → cluster-safe)

```lua
-- KEYS[1] = queue:<game>   ARGV[1] = selfWaitingJson   ARGV[2] = selfWallet
local front = redis.call('LPOP', KEYS[1])
while front do
  local w = cjson.decode(front)
  if w.wallet ~= ARGV[2] then
    return front                 -- paired: caller builds match(opponent=front, me=self)
  end
  front = redis.call('LPOP', KEYS[1])   -- stale self entry (reconnect); drop and keep popping
end
redis.call('RPUSH', KEYS[1], ARGV[1])   -- no opponent; enqueue self
return false
```

Single `KEYS` entry → all slots match → valid in cluster mode. Run via `EVALSHA`.

## Stats: consistent global numbers without pub/sub

`add_actions` is `INCRBY stats:actions:total` + `INCRBY stats:actions:game:<g>` (write-time
maintenance; each heartbeat is processed by exactly one task, so no double-count). Tunnel
**active/settled counts are derived from idempotent sets** (`SADD`/`SREM`, count = `SCARD`)
rather than `INCR`: every task runs its own chain indexer, so the same `TunnelActivated`
event is observed N times — an `INCR` would over-count N×, but `SADD` of the same tunnelId
is a no-op. `set_tunnel_status` performs the set maintenance idempotently; `snapshot` reads
`SCARD`. Each task's broadcaster, once per tick, reads the shared counters/sets, diffs the
actions counter against its own last-read for the global per-tick TPS, builds the snapshot,
and pushes to its **local** SSE subscribers — so all viewers on all tasks see the same global
numbers. (`stats_tx` broadcast stays per-task for local fan-out.)

> N per-instance indexers cost N× Sui-RPC event reads; acceptable at demo scale. Electing a
> single indexer (Redis lock) to cut RPC load is a noted future optimization — the idempotent
> sets make correctness independent of how many indexers run.

## Concurrent settlement (gas, not a lock)

At the 1M-effective-TPS target the on-chain *close* rate is bounded by tunnel count, so `/settle`
must submit concurrently across instances. Do **not** add a global settle-lock — it caps
finalization at one tx per round-trip. Equivocation is purely a **gas-coin** hazard (two
conflicting in-flight txs sharing a coin version lock it until epoch end); the tunnel is a
**shared** object and never equivocates.

**Primary: address-balance gas (SIP-58).** Pay gas from the settler's SUI address balance — empty
`gas_payment.objects` → an implicit `FundsWithdrawal` — so there is no gas coin to lock and
concurrent single closes are equivocation-free with **no pool to operate**. Verified against the
vendored SDK (both 0.3.1, latest): `TransactionBuilder::try_build` rejects empty gas
(`MissingGasObjects`, builder.rs:676), but `sui-sdk-types` exposes `FundsWithdrawal` and public
`GasPayment.objects` / `Transaction.gas_payment`. So in `sui.rs`: build the close tx with a
placeholder gas object (to pass `try_build`), then `tx.gas_payment.objects.clear()` **before
signing** (the signature covers `gas_payment`), then submit. This replaces `pick_gas_coin`'s
`limit 1` coin, which equivocates at count ≥2. **Gates:** target network at protocol **v125+**;
an **e2e** confirming the node accepts an empty-payment close (build path verified; node
acceptance is the open risk — the feature is ~1 month old).

**Fallback (if a gate fails): Redis-leased gas-coin pool** — a set of pre-split coin ids; lease one
per in-flight tx, execute, return it at its new version (sequential reuse of one coin is safe;
concurrent is not — Mysten's Redis-backed `sui-gas-pool` pattern).

**Optional optimization (either model): PTB-batch self-play closes** — pack ~50–100
`close_cooperative_with_root` calls per PTB (≤1024 commands) to cut tx/gas count. The PTB is
atomic, so pre-validate (sig + not-already-closed) and bisect-retry on abort. **PvP closes settle
singly** (untrusted parties; one bad close must not abort others'). The in-process `gas_lock` stays
a same-process guard only.

## Health endpoints (`routes.rs`)

- `GET /health/live` → always `200` while the process runs.
- `GET /health/ready` → `PING` the **cache** cluster only — the HTTP path's single hard
  dependency; `200` iff it succeeds; `503` otherwise (so it's 503 during startup before connect,
  and during graceful shutdown). The **pubsub** cluster is a WS-path soft dependency: a pubsub
  outage degrades PvP delivery but must NOT 503 the task (else a pubsub blip black-holes
  stats/settle and the ALB drops every target). Cover pubsub with its own alarm. Keep `/healthz`
  as a `/health/live` alias for back-compat.

## Config (`config.rs`)

Add (required at boot, fail-loud like the SUI_* vars **when running the Redis impl**):
`REDIS_CACHE_URL`, `REDIS_PUBSUB_URL` (both `rediss://`). `INSTANCE_ID` optional → else a
boot-time uuid. **Impl selection:** if `REDIS_CACHE_URL` is set → Redis impls; else the
in-memory impls (local dev / tests). No DB vars. Drop nothing else.

The existing `SUI_*` / `WALRUS_*` / `TUNNEL_*` vars stay required at startup (`main.rs`), and
`SUI_SETTLER_KEY` is the task's Secrets Manager secret. The infra task def must supply them or the
container exits before binding — this is the infra's current gap to close, not a code change.

## Dockerfile (`backend/tunnel-manager/Dockerfile`)

Multi-stage: `rust:1-bookworm` builder → `cargo build --release -p tunnel-manager`; runtime
`debian:bookworm-slim` + `ca-certificates` + `curl` (the infra's container health check shells
`curl -f .../health/live`), copy the binary, `EXPOSE 8080`, run the binary. (distroless is the
leaner alternative but drops `curl` — would require changing the infra's container health check.)

**Build context = repo root** (not `backend/tunnel-manager/`): `-p tunnel-manager` needs the
workspace `Cargo.toml` + `Cargo.lock`, which live at the root. The infra `deploy-backend.yml`
build step must set the context accordingly.

## Module layout

```
src/store/mod.rs      traits (ControlStore, MpStore, Bus) + ConnRef + a `Stores` bundle
src/store/memory.rs   in-memory impls  (today's RwLock maps / atomics — moved here)
src/store/redis.rs    fred client setup + Redis impls of all three traits + the Lua script
src/mp/ws.rs          keeps local conns map + the mp:inst:<self> subscription; calls Bus/MpStore
src/mp/protocol.rs    UNCHANGED (wire enums)
src/routes.rs         handlers call ControlStore; add health endpoints
src/state.rs          AppState holds Arc<dyn ControlStore/MpStore/Bus> + instance_id + local conns
```

`mp/matchmaking.rs` + `mp/relay.rs` collapse into `MpStore` methods (pairing is now atomic in
the store); their behavior-level tests move to `store/memory.rs`'s test module.

## Testing

- **Unit (fast, no IO):** pairing/routing/checkpoint/stats logic against the **in-memory**
  impls — same assertions as today (seat-A=earlier-waiter, invite-auth, highest-nonce, etc.).
- **Integration (`#[ignore]` unless `TEST_REDIS_URL` set; run in a Redis-backed CI job):**
  against `testcontainers` `redis:7` — `join_or_pair` under concurrency pairs each waiter
  exactly once; `Bus::deliver` from instance X reaches a socket owned by instance Y; presence
  conditional-clear; checkpoint highest-nonce; `/health/ready` flips 503→200 when Redis is up.
- **Contract unchanged:** existing `protocol.rs` / settle-shape tests stay green (no wire change).

## Phasing (for the implementation plan)

1. **Seam, no behavior change** — introduce the three traits + in-memory impls (lift today's
   maps into `store/memory.rs`), wire `AppState` to `Arc<dyn …>`, make handlers async-call the
   store. Single-instance behavior identical; all existing tests green.
2. **Redis impls** — `fred` setup + Redis impls + the Lua script; impl selection by env.
3. **Cross-instance delivery** — `Bus` Redis impl + the `mp:inst:<self>` subscription loop in
   `ws.rs`; `MatchRecord` carries `ConnRef`s.
4. **Concurrent settlement** — `sui.rs`: address-balance gas (build w/ placeholder gas, clear
   `gas_payment.objects` before signing); replace the `limit 1` coin; e2e on a v125+ node, else
   fall back to a Redis-leased coin pool. PTB-batch self-play closes as an optimization; PvP single.
5. **Deploy contract** — health endpoints (ready = cache-only), config, Dockerfile (context = root).
6. **Integration tests** — testcontainers coverage for atomicity + cross-instance deliver;
   concurrent-settlement test (N parallel closes never equivocate or lock a coin).
7. **Infra handoff** — note for Max: drop Aurora + RDS Proxy + migrate step + DB secrets;
   point health checks at `/health/ready` (cache-gated); supply `REDIS_*` + `SUI_*`/`WALRUS_*` +
   the settler secret; Docker build context = repo root.

## Success criteria

1. Two backend tasks behind a round-robin proxy: a player who registers a session on task A
   can heartbeat/settle on task B; two players who land on different tasks **pair and relay**
   end-to-end; the SSE TPS number is identical on both tasks.
2. `join_or_pair` never double-pairs a waiter under concurrent load (integration test).
3. `/health/ready` is 503 until the **cache** cluster answers `PING`, then 200; a pubsub
   outage does NOT flip it; `/health/live` is always 200.
4. The image builds and runs; `curl /health/live` succeeds inside the container.
5. Local dev + unit tests run with **no Redis** (in-memory impls); wire contracts unchanged.
6. Concurrent `/settle`s across both tasks finalize on-chain without equivocation or coin-lock
   (batched self-play closes; non-shared gas); a single PvP close failure never aborts another.
