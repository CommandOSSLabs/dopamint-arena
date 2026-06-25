# Metrics telemetry & time-series at scale — design spec

- **Date**: 2026-06-24
- **Status**: Proposed (design)
- **Refs**: extends ADR `docs/decisions/0002-backend-client-api-contract.md`
  (session / heartbeat / `stats/live` contract); builds on
  `docs/decisions/0005-redis-backed-ha-control-plane.md` (Valkey counters) and
  `docs/decisions/0012-self-play-tps-engine-two-party-on-top.md` (self-play is the
  bulk TPS engine → the dominant heartbeat emitter). Infra: ElastiCache **Valkey
  7.2** (no modules) + **Aurora PostgreSQL 16.6** (already provisioned, used by the
  explorer). Frontend deploys to a **CDN on a separate origin** from the backend.

## Goal

Make the metrics path scale for large CCU, and **persist the TPS time-series** so the
frontend can show a live graph plus headline scalars — **current TPS, peak TPS, open
(active) tunnels, total transactions processed, total tunnels processed** — without
adding a WebSocket, a new datastore, or per-event storage.

The wire contract for `register` / `settle` / `sponsor` is unchanged. `stats/live`
gains one field (`peakTps`); one read endpoint (`stats/history`) is added; the
heartbeat gains a body-token variant for `sendBeacon`.

## Read/write model — only one metric is a time-series

The five displayed figures split sharply by storage need. Four are **maintained-at-
write-time scalars** already present in the `StatsSnapshot` pushed over the existing
SSE; they need **no history**. Only the TPS graph is a time-series.

| FE display                | Shape                | Source                                                   |
| ------------------------- | -------------------- | -------------------------------------------------------- |
| Current TPS               | gauge (latest rate)  | live snapshot (SSE)                                      |
| Peak TPS                  | running max (scalar) | one maintained Valkey value, in snapshot                 |
| Open / active tunnels     | gauge                | maintained counter (`stats:tunnels:active`), in snapshot |
| Total transactions        | cumulative counter   | maintained counter (`stats:actions:game:*` sum)          |
| Total tunnels             | cumulative counter   | maintained counter (`stats:tunnels:settled`)             |
| **TPS over time (graph)** | **time-series**      | **the only thing persisted as history**                  |

Principle (per repo convention, ADR-0005): the cheapest correct cache is a counter
maintained at write time. Do **not** build analytics storage for values that are
already maintained counters.

### Write side

- **Writer:** the per-instance 1 Hz stats job (already exists for the SSE snapshot).
- **Rate:** ~1 row/s/resolution-tier, **decoupled from event volume** — whether an
  instance saw 100 or 1,000,000 actions/s, it writes one bucket. Same property that
  makes the relay counter cheap.
- **Dataset:** append-only / unbounded → **retention is mandatory** (partition drop).

### Read side

- **Scalars:** straight from the live SSE snapshot. No query.
- **Graph:** one bounded-range `GET` returning pre-bucketed, downsampled points
  (≤ a few hundred), plus the live tail from the existing SSE. Latency tolerance: seconds.

## In scope

1. **Heartbeat ingest fix** (Tier 1): self-play heartbeat stops doing 2 Redis ops/msg.
2. **TPS time-series persistence**: Aurora rollup table, counter-derivative model,
   partition-based retention + downsampling tiers.
3. **`peakTps`** maintained scalar + added to the snapshot.
4. **`GET /v1/stats/history`** read endpoint for the graph.
5. **Frontend wiring**: all five scalars + the TPS graph rendered on the **explorer page**.
6. **Client telemetry transport**: per-user coalescing + `sendBeacon` unload flush.

## Out of scope (non-goals)

- Per-event / per-move durable storage (we persist aggregates only — exact off-chain
  transactions are **not** saved here; the on-chain settlement + Walrus transcript
  remain the proof spine).
- A streaming pipeline (Kafka/Kinesis/Flink) — justified only for event-level
  durability/replay/analytics, which this display counter does not need.
- A WebSocket for telemetry (see Rejected alternatives).
- **Cross-origin / CORS handling — deferred.** Same-origin routing (the CDN proxies
  `/v1` to the backend) or edge config covers it for now; revisit only if the backend is
  served from a bare second origin. No `Access-Control-*` work in this spec.
- Per-user / per-tunnel metric cardinality (we keep ~1 global + ~7 per-game series).
- Ops dashboards: the existing `/metrics` Prometheus endpoint is unchanged and remains
  for ops; this spec is about the **in-app, user-facing** graph.

## Architecture

```
Browser (CDN origin)                Backend (api origin, HTTP/2)         Stores
  in-session ─ fetch POST (batched, 1/Ns) ─► /heartbeat ─► LocalActionCounter (in-proc)
  on unload  ─ sendBeacon (token in body) ─►                     │ 1 Hz flush
                                                                 ▼
                                              Valkey: stats:actions:game:*  (cumulative)
                                                      stats:tunnels:active/settled
                                                      stats:peak_tps        (running max)
                                                                 │ 1 Hz / 1 min sampler
                                                                 ▼  (idempotent upsert)
                                              Aurora: metric_bucket (partitioned)  ◄─ system of record
  graph open ─ GET /v1/stats/history?window ─► range scan ──────┘  (TPS derived on read)
  live tail  ◄──────── existing SSE /v1/stats/live (snapshot: current TPS, peak, totals, active)
```

- **Live, shared:** Valkey counters (ADR-0005). One added scalar, `stats:peak_tps`.
- **Durable history:** one Aurora table. Aurora is already provisioned and used by the
  explorer, so this adds a table, not infrastructure.

## Tier 1 — heartbeat ingest (the actual scale bottleneck)

Today (`backend/tunnel-manager/src/routes.rs`) each heartbeat does **two Redis
round-trips**: `get_session` (GET, for bearer auth) + `add_actions` → `INCRBY
stats:actions:game:{game}`. The INCRBY is a **single-key write hotspot**: every
self-play window of a game targets the same key, so load is `C×W` writes/s into one
key — this caps first, well before HTTP does.

The relay path already solves this (`mp/ws.rs` → `state.actions.incr()` →
`LocalActionCounter`, flushed once/s/instance in `main.rs`). Heartbeat must use the
same pattern:

1. Replace `control.add_actions(game, delta)` with `state.actions.incr(&rec.game,
delta)`. Redis writes drop from `C×W/s` → `I/s/game` (I = instances); hotspot gone.
2. Remove the per-message `get_session` GET. Two options, in preference order:
   - **Stateless signed token** (HMAC over `session_id`+expiry): zero lookup, nothing
     to invalidate. End state.
   - **In-process `session_id → stats_token` cache** (LRU/TTL, invalidate on close):
     pragmatic interim.

**Trade-off (explicit):** the local counter is undercount-safe — a crashed instance
loses ≤1 s of action counts vs. the exact INCRBY today. This is already the accepted
semantic for the higher-volume relay path; acceptable for a display counter.

After Tier 1 the heartbeat is cheap at the data layer; remaining cost is HTTP request
CPU, addressed by client coalescing below.

## Data model — store cumulative, derive rates

Store the **cumulative counter** per bucket and derive TPS as its discrete derivative
on read — the same counter-derivative model `stats.rs` already uses for the live rate
(Prometheus `rate()` style). Never store TPS directly (it is jittery and writer-
dependent).

```sql
-- hot tier: 1s resolution. Same shape for metric_bucket_1m / _1h (warm/cold).
CREATE TABLE metric_bucket (
  ts_bucket            timestamptz NOT NULL,  -- truncated to the tier resolution
  game                 text        NOT NULL,  -- per-game; global = SUM over games on read
  actions_cum          bigint      NOT NULL,  -- cumulative actions for this game (monotonic)
  tunnels_settled_cum  bigint      NOT NULL,  -- cumulative settled
  tunnels_active       integer     NOT NULL,  -- gauge
  PRIMARY KEY (game, ts_bucket)
) PARTITION BY RANGE (ts_bucket);
```

Derived on read:

- **TPS(t)** = `(actions_cum[t] − actions_cum[t−1]) / Δt`
- **Peak TPS (window)** = `max` of that derivative over the requested window
- **Peak TPS (all-time)** = `stats:peak_tps` scalar (maintained, see below)
- **Current TPS / totals / active** = latest values (live snapshot, no query)

**Idempotent multi-writer (no leader election):** `actions_cum` etc. are read from
shared Valkey, so every instance computes the _same_ global values. The sampler does
`INSERT … ON CONFLICT (game, ts_bucket) DO UPDATE` — concurrent instances writing the
same bucket converge (last-write-wins on identical data).

### Peak TPS scalar

Each 1 Hz tick: `peak = max(peak, current_tps)` in Valkey (`stats:peak_tps`, e.g. a
single key updated with a compare-and-set / Lua `max`). O(1) write and read; added to
the snapshot. Choose all-time or rolling-window per product need (rolling = also
derivable from buckets).

### Retention & downsampling (bounds the unbounded series)

Three tiers, each its own table + sampler cadence; partition by day, **drop old
partitions** for O(1) retention:

| Tier | Resolution | Retention (suggested) |
| ---- | ---------- | --------------------- |
| hot  | 1 s        | hours                 |
| warm | 1 min      | days                  |
| cold | 1 h        | weeks                 |

Each tier is fed by sampling the cumulative counter at that cadence (no separate
rollup job needed: coarser tiers just sample less often). Storage is tiny — 1 global
series at 1 s for 6 h ≈ 21.6k rows; ×7 games ≈ 151k rows. Trivial for Aurora.

## API additions

### `GET /v1/stats/history` — TPS time-series for the graph

```
GET /v1/stats/history?metric=tps&game=*&window=1h&res=1s
```

- `metric`: `tps` (default) | `actions` | `tunnels_active` | `tunnels_settled`
- `game`: `*` (global, summed) | a game id
- `window`: lookback (e.g. `15m`, `1h`, `24h`) → picks the tier whose retention covers it
- `res`: requested resolution → picks the tier (server clamps to an available tier)

```jsonc
// response — pre-bucketed, bounded point count; rates already derived
{
  "metric": "tps",
  "game": "*",
  "res": "1s",
  "points": [
    { "t": "1750000000", "v": 812345 },
    { "t": "1750000001", "v": 809210 },
  ],
}
```

`t` is unix seconds (string, per ADR-0002 u64-as-string convention); `v` is the value.

### `GET /v1/stats/live` (SSE) — one added field

```jsonc
{
  "tps": 812345,
  "peakTps": 1031200,
  "totalActions": 19200345,
  "activeTunnels": 2104,
  "settledTunnels": 880,
  "perGame": { "blackjack": { "tps": 410234, "tunnels": 1200 } },
}
```

### `POST /v1/sessions/{id}/heartbeat` — body-token variant (additive)

`sendBeacon` cannot set headers, so accept the capability in the body in addition to
today's bearer header:

```jsonc
// request (JSON body)
{
  "statsToken": "...",
  "tunnelId": "0x..",
  "nonce": "48213",
  "actionsDelta": 4800,
  "windowMs": 1000,
}
```

The bearer-header form remains valid for in-session `fetch`.

## Client telemetry transport

The frontend deploys to a CDN, separate origin from the backend. **CORS is out of scope
for now** (deferred — same-origin routing or edge config, see non-goals). HTTP/2
connection reuse is keyed by the _target_ origin, so the SSE and all heartbeat POSTs to
the backend already share one connection regardless of where the page is served; a
WebSocket would only _add_ a connection. So the only changes are:

**Coalescing.** `getControlPlaneClient` is already a singleton and `TelemetryProvider`
is app-wide. Add one aggregator that sums all open windows' `actionsDelta` into a
single periodic POST every N s → message volume `C×W` → `~C / N`.

**`sendBeacon` for the unload flush.** On `visibilitychange` (hidden) / `pagehide`,
flush the pending delta via `navigator.sendBeacon`. `sendBeacon` cannot set headers, so
the capability rides in the body (`statsToken`). Why beacon:

- Survives page unload — a normal `fetch` fired during unload is routinely cancelled,
  losing the final batch; `sendBeacon` is guaranteed queued and sent in the background.
- Non-blocking (doesn't delay navigation, unlike legacy sync XHR).
- Fire-and-forget (returns only a boolean) — matches telemetry's shape.

In-session periodic batches use normal `fetch` (page is alive); `fetch(…, {keepalive:
true})` is the variant if a header/response is ever needed with the same unload guarantee.

## Frontend wiring — all metrics on the explorer page

All five scalars and the TPS graph render at the **top of the explorer page**
(`frontend/src/explorer/ExplorerPage.tsx`), above the existing Settlements panel. The
settlements table and its stream are untouched.

### Data layer (client)

- **`StatsSnapshot`** (`src/backend/controlPlane.ts`): add `peakTps: number`. The four
  other scalars already exist (`tps`, `totalActions`, `activeTunnels`, `settledTunnels`),
  pushed ~1/s over the live SSE.
- **`useBackendStats()`** (`src/backend/useBackendStats.ts`): unchanged — already returns
  `{ snapshot, status }` from the SSE. The single source for every scalar; no new
  connection.
- **History client**: add `fetchStatsHistory(params)` to `controlPlane.ts` →
  `GET /v1/stats/history?metric=tps&game=*&window&res`, returning `{ points: {t,v}[] }`.
- **`useTpsHistory(window, res)`** (new, `src/backend/useTpsHistory.ts`): fetch the
  historical seed once on mount, then append a live point each time `useBackendStats`
  pushes a fresh `snapshot.tps` — the graph tails live without re-fetching. Cap the
  in-memory series to the window length.

### Components (mounted on `ExplorerPage`)

- **`MetricsStrip`** (`src/explorer/MetricsStrip.tsx`): a row of stat cards from
  `useBackendStats().snapshot`, reusing `Panel`. While `status === "connecting"` or
  `snapshot === null`, show placeholders (`—`).

  | Card               | Field                     |
  | ------------------ | ------------------------- |
  | Current TPS        | `snapshot.tps`            |
  | Peak TPS           | `snapshot.peakTps`        |
  | Open tunnels       | `snapshot.activeTunnels`  |
  | Total transactions | `snapshot.totalActions`   |
  | Total tunnels      | `snapshot.settledTunnels` |

- **`TpsGraph`** (`src/explorer/TpsGraph.tsx`): an **inline SVG sparkline/area** over
  `useTpsHistory()` — **no chart dependency** (`package.json` has none; an SVG
  `polyline` matches the minimalist UI and avoids a bundle add). Wrap in `Panel` +
  `PanelTitle "Throughput (TPS)"`, with a small window selector (15m / 1h / 24h) that
  drives `useTpsHistory`.

### Mount point

In `ExplorerPage.tsx`, between the `<header>` and the Settlements `<Panel>`:

```tsx
<MetricsStrip />
<TpsGraph />
```

Both are self-contained (own hooks) — no prop drilling, no change to the settlements
data flow.

### Offline / empty behavior

Reuse the existing `BackendStatus` contract: `connecting` → placeholders; `live` →
values; `offline` → keep the last values (the SSE hook already retains them). The graph
shows an empty axis until the first history fetch resolves.

## Rejected alternatives

- **WebSocket for telemetry.** Heartbeat is one-way, fire-and-forget, ~1/s — the
  RUM/analytics-SDK pattern (GA, Sentry, DataDog RUM, Amplitude, Segment) is batched
  HTTP + beacon, _not_ a per-user socket. Millions of idle stateful sockets (C10M) cost
  server memory/FDs for no benefit. WS is correct for bidirectional/low-latency — which
  is exactly why the relay uses it. Reconsider only if a genuine bidirectional/low-
  latency need appears that SSE + batched HTTP can't serve.
- **Amazon Timestream.** A purpose-built TSDB for ~7 low-rate series is over-built (new
  service/IAM/query language) for cardinality we don't have.
- **Prometheus / Grafana for the graph.** `/metrics` exists and stays for **ops**;
  proxying Grafana to **end users** is the wrong coupling for an in-app graph served by
  our own API.
- **RedisTimeSeries.** Not available — ElastiCache/Valkey can't load modules.
- **TimescaleDB on Aurora.** Not available — RDS/Aurora doesn't allow the Timescale
  extension. (Native partitioning gives us the same retention behavior anyway.)
- **Kafka/Kinesis → Flink.** Standard for durable event streams; unnecessary for a
  display counter where local aggregation already decouples store-writes from volume.

## Scaling characteristics

|                          | Naive (today)                       | This design                       |
| ------------------------ | ----------------------------------- | --------------------------------- |
| Redis writes for actions | `C×W`/s into one key/game (hotspot) | `I`/s/game (local-counter flush)  |
| Auth Redis ops/heartbeat | 1 GET                               | 0 (stateless token or cache)      |
| Telemetry messages       | `C×W`/s                             | `~C/N` (coalesced)                |
| History store writes     | n/a                                 | `~1`/s/tier (idempotent upsert)   |
| History storage growth   | n/a                                 | bounded (partition drop per tier) |

(C = concurrent users, W = open windows/user, I = backend instances, N = batch seconds.)

## Implementation phases

1. **Tier 1 ingest** — heartbeat → `LocalActionCounter`; stateless/cached auth. Highest
   leverage, smallest change, no API change. Ship first.
2. **History store** — `metric_bucket` (+ `_1m` / `_1h`) tables, partitioning, the 1 Hz
   sampler upsert, `peakTps` scalar; add `GET /v1/stats/history` and `peakTps` to the
   snapshot.
3. **Frontend wiring** — `peakTps` on `StatsSnapshot`; `MetricsStrip` + `TpsGraph` +
   `useTpsHistory` mounted on the explorer page.
4. **Client transport** — coalescing aggregator, `sendBeacon` unload flush, body-token
   heartbeat. (CORS deferred — see non-goals.)

## Open questions

- **Peak TPS semantics:** all-time, rolling 24 h, or per-deploy? (Affects whether
  `stats:peak_tps` resets and whether the window-max read path is also needed.)
- **`game` dimension for the graph:** global only, or per-game series in the UI? (Schema
  supports both; only affects the read API surface exposed initially.)
- **Aurora connection for tunnel-manager:** the backend currently uses only Valkey; the
  sampler + history read add an Aurora dependency (via the existing RDS Proxy). Confirm
  the tunnel-manager task gets `DATABASE_URL` (today only explorer tasks do).
