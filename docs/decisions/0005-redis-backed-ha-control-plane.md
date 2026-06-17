# 0005 — Redis-backed, horizontally-scalable control-plane + mp lane

- **Status**: Proposed
- **Date**: 2026-06-17
- **Refs**: builds on [ADR-0002](0002-backend-client-api-contract.md) (stateless
  control-plane) and [ADR-0004](0004-multiplayer-pvp-experience-lane.md) (the
  stateful PvP lane). Driven by the AWS infra design (Max Mai), which runs the
  backend as ≥2 Fargate tasks behind an ALB. Design spec:
  `docs/superpowers/specs/2026-06-17-redis-backed-ha-backend-design.md`.

## Context

ADR-0004 made the backend **stateful**: presence, matchmaking queues, invites,
matches, and per-connection socket handles all live in process memory
(`AppState`'s `RwLock<HashMap>`s). The control-plane (sessions, stats counters) is
also per-process. That is correct at **one** instance.

The infra runs the backend at **desired count ≥ 2 behind an ALB**. With round-robin
routing, in-process state breaks three ways:
- **PvP relay/matchmaking**: two players can land on different tasks; the relay
  can't reach a socket in another task's memory, and queues don't pair across tasks.
- **Sessions**: register on task 1, settle on task 2 → 404 (the session lives only
  on task 1).
- **Stats**: heartbeat counters diverge per task; each SSE viewer sees a partial number.

We modelled every state surface's read/write pattern (see the spec). The result:
**there is no relational or durable data** — everything is ephemeral key-value,
atomic counters, atomic queue pops, or pub/sub. Settlements are final on-chain;
transcripts are on Walrus; the tunnel registry is re-derivable from chain events.

The infra as drafted provisions **Aurora PostgreSQL + RDS Proxy + a migration step**
alongside two Redis clusters. Carrying a relational database under non-relational,
mostly-ephemeral state is exactly the over-build CLAUDE.md warns against
("adding complexity before checking if the write path can maintain the value for free").

## Decision

Make the backend horizontally scalable on **Redis only** — no Postgres.

1. **Shared state in Redis (the infra's two clusters, used as designed).**
   - **cache cluster** → sessions, presence, queues, invites, matches, stats counters.
   - **pubsub cluster** → cross-instance message delivery (the relay and server→client pushes).
2. **One delivery primitive: `deliver(targetInstanceId, targetConnId, msg)`.** If the
   target is local, write to the in-process socket; else `SPUBLISH` to the owner's
   per-instance channel `mp:inst:<id>` (sharded pub/sub, Redis 7), which that instance
   delivers locally. Every server→client send (`match.found`, `challenge.incoming`,
   relayed frames) goes through it. Frames stay **byte-opaque** — `deliver` never parses them.
3. **Per-instance keeps only what must be local:** the `connId → live socket` map and
   one long-lived subscription to its own channel. The chain indexer runs per instance
   (the chain is the source of truth; each instance folds it independently).
4. **Atomic matchmaking** via a Lua `join-or-pair` script on `queue:<game>` (atomic
   pop-other-or-push-self) so two tasks never pair the same waiter.
5. **Consistent global stats** via shared `INCRBY` counters; each instance's broadcaster
   reads the shared total per tick and diffs → all SSE viewers see the same global TPS.
   No stats pub/sub needed.
6. **Storage behind a trait (`MpStore` / control-plane store).** The current in-memory
   maps become the **in-memory impl** (fast unit tests, local dev); a **Redis impl**
   ships for prod. Pairing/routing *logic* is unit-tested against the in-memory impl;
   the Redis impl gets a focused integration test.
7. **Deploy contract:** add `GET /health/live` (always 200) and `GET /health/ready`
   (200 iff the **cache** cluster answers — the HTTP path's only hard dependency; pubsub is a
   WS-path soft dependency with its own alarm, so a pubsub blip degrades PvP but never blacks
   out stats/settle; 503 on startup/shutdown), a multi-stage **Dockerfile** (build context =
   repo root, for the workspace manifest + lockfile), and `REDIS_CACHE_URL` /
   `REDIS_PUBSUB_URL` / `INSTANCE_ID` config — alongside the `SUI_*` / `WALRUS_*` / `TUNNEL_*`
   vars the binary already requires and `SUI_SETTLER_KEY` as the task secret.
   **Drop the migration task** (no DB).
8. **Settle for concurrency, never by serializing.** Self-play closes are high-volume and bursty
   (~one per tunnel) — at the 1M-effective-TPS target the on-chain close rate is bounded only by
   tunnel count, so the settle path must submit *concurrently*. A global lock would cap
   finalization at one tx per RPC round-trip and is rejected. Equivocation is purely a **gas-coin**
   (owned-object) hazard — a coin used by two conflicting in-flight txs is locked until the epoch
   boundary; the **tunnel is a shared object** (consensus-sequenced) and never equivocates. So the
   single rule is: *no two in-flight txs share a gas-coin version.*
   - **Primary: address-balance gas (SIP-58).** Pay gas from the settler's SUI *address balance*
     (empty `gas_payment.objects` → an implicit `FundsWithdrawal`), so there is **no gas coin to
     lock** — concurrent single closes are equivocation-free with no pool, lease, or refill to
     operate. Verified against the vendored SDK (both 0.3.1, latest): `try_build` rejects empty gas
     (`MissingGasObjects`), but `sui-sdk-types` is SIP-58-aware (`FundsWithdrawal`, public
     `GasPayment.objects`), so the close path builds with a placeholder gas object and clears
     `gas_payment.objects` **before signing**. Gated on the target network at protocol **v125+** and
     an **e2e** confirming node acceptance (the feature is ~1 month old).
   - **Fallback if a gate fails: Redis-leased gas-coin pool** — one distinct coin per in-flight tx,
     returned at its new version (Mysten's own Redis-backed `sui-gas-pool` pattern).
   - **Optional optimization (either model): batch** self-play closes into one PTB (≤1024 commands)
     to cut tx/gas count; the PTB is atomic, so pre-validate and bisect-retry, and keep **PvP closes
     single** (untrusted parties). The in-process `gas_lock` mutex stays only a same-process guard.

## Consequences

- **HA-capable**: safe at desired count ≥ 2 with autoscaling; ALB round-robin no longer
  breaks PvP, sessions, or stats.
- **Infra delta**: Aurora + RDS Proxy + the `migrate.sh` step + DB secrets are dropped; both
  Redis clusters stay (the Pulumi DB components stay in the repo but dormant). Full hand-off list
  in [§ Infra delta](#infra-delta). Saves ~$1–2k/mo and removes the deploy pipeline's most
  failure-prone step (migration ordering + pre-migration snapshot + DB-restore runbook all go).
- **Settlement is concurrency-safe, not serialized**: PTB-batched self-play closes + non-shared
  gas (address balance, or a Redis-leased coin pool) keep many closes in flight without sharing a
  gas-coin version — so no equivocation *and* no throughput cap. PvP closes settle singly.
- **Readiness scoped to the cache cluster**: a pubsub failover degrades PvP delivery only;
  stats/settle keep serving. Trade-off: PvP frames can drop silently during a pubsub blip —
  covered by a dedicated pubsub alarm, not by pulling the task.
- **New hot-path dependency on Redis**: mitigated by ElastiCache Multi-AZ + automatic
  failover; on a total cache loss, players reconnect/re-queue and in-flight matches fall
  back to the on-chain dispute/timeout paths — **funds are never at risk** (they live on-chain).
- **Testability preserved**: the store trait keeps the pairing/routing logic in fast,
  deterministic unit tests; Redis specifics (atomicity, pub/sub) are integration-tested.
- **Latency**: one Redis round-trip per relayed frame for cross-instance matches. PvP is
  human-paced (≈0 TPS), so this is immaterial; the 1M-TPS self-play lane never touches it.

## Infra delta

The AWS infra design (Max) is a draft; these are the changes it needs to match this ADR.

**Drop:** Aurora PostgreSQL + RDS Proxy; the migration task definition, the pre-migration
snapshot step, and the DB-restore runbook; the `db-secret` / `db-password-secret` and the
`DATABASE_URL` / `DATABASE_PASSWORD` task-def entries.

**Keep:** both ElastiCache clusters — the pubsub cluster must be **cluster-mode-enabled**
(sharded `SSUBSCRIBE`/`SPUBLISH` requires it). Leave the Pulumi `Database.ts` /
`DatabaseProxy.ts` components in the repo but **not instantiated**, so the deferred-leaderboards
revisit is a config flip, not a re-author.

**Fix the backend task definition (it currently can't boot):** add `REDIS_CACHE_URL`,
`REDIS_PUBSUB_URL` (`rediss://`), optional `INSTANCE_ID`, and the vars the binary already
requires at startup — `SUI_RPC_URL`, `TUNNEL_PACKAGE_ID`, `TUNNEL_COIN_TYPE`,
`WALRUS_PUBLISHER_URL`, `WALRUS_AGGREGATOR_URL`; add `SUI_SETTLER_KEY` as the task secret
(replacing `DATABASE_PASSWORD`). Without the `SUI_*`/`WALRUS_*` set, `Config::require` in
`main.rs` fails loud before the socket binds — the as-drafted task def is dead on arrival.

**Other:** ALB + container health checks target `/health/ready` (cache-gated); add a CloudWatch
alarm on the pubsub cluster (it no longer fails the task). Docker build context = repo root
(the Cargo workspace manifest + lockfile live there), so `deploy-backend.yml` must build from
root, not `backend/tunnel-manager/`.

## Alternatives considered

- **Postgres + Redis (match the infra literally)** — a relational system-of-record plus
  Redis hot path. Rejected for v1: there is no relational/durable data to justify it
  (history is on-chain + Walrus); it adds a schema, migrations, and RDS Proxy for nothing.
  Revisit **if** leaderboards / player profiles / queryable history land — added then, for that.
- **Postgres-only with LISTEN/NOTIFY** for the relay. Rejected: LISTEN/NOTIFY is a weaker
  fan-out primitive and puts per-move relay load on the database — wrong tool for the WS hot path.
- **Single instance / sticky sessions** (no shared state). Rejected: not HA, a single point
  of failure, and ALB stickiness doesn't fix cross-player relay (two players, two sockets).

## Open questions

- **`INSTANCE_ID` source**: ECS task ID (metadata endpoint) vs container hostname vs a
  boot-time uuid. Recommendation: env override, else boot-time uuid (sufficient for the channel).
- **Settlement gas model (mostly resolved)**: address-balance gas is the chosen primary —
  verified reachable on the vendored SDK 0.3.1 via build-with-placeholder-then-clear
  `gas_payment.objects` (the builder's `try_build` rejects empty gas directly). Remaining: an e2e
  on a protocol-**v125+** network confirming node acceptance; if it fails, fall back to the
  Redis-leased coin pool. Batch size vs gas budget + bisect-retry is an optimization, deferred to
  implementation.
- **Carryovers from ADR-0004** (unchanged by this ADR): server-side pubkey↔wallet binding;
  on-chain watchtower *submission* of the captured checkpoint; disconnect queue/presence cleanup.
