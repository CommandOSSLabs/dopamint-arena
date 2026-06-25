# Metrics Time-Series Implementation Plan (unified stats in the explorer)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the TPS time-series in Aurora, serve **all** `/v1/stats/*` from the explorer service, and surface five headline metrics (current TPS, peak TPS, open tunnels, total transactions, total tunnels) plus a TPS graph on the explorer page — while making the counting paths stable for large CCU.

**Architecture (CQRS read/write split):** **tunnel-manager** stays the write/aggregation engine — it owns the Valkey counters, computes the snapshot (tps via the rate window, peak, totals) and **publishes** it on Redis pub/sub `stats:snapshot`. The **explorer** becomes the single stats _read_ API: it relays `/v1/stats/live` (SSE), persists samples to an Aurora `metric_bucket` and serves `/v1/stats/history`, alongside the existing `/v1/stats/explorer`. This removes the SSE broadcast fan-out from the latency-critical relay service and keeps tunnel-manager Valkey-only (ADR-0005/0009).

**Tech Stack:** Rust (axum, fred/Valkey, Diesel-async + sqlx/Postgres), Pulumi (TS), React/TS, `node:test` via tsx.

**Spec:** `docs/superpowers/specs/2026-06-24-metrics-timeseries-design.md` — this plan adopts the spec's Aurora system-of-record as the chosen architecture (superseding the spec's "Valkey-first / Aurora-as-follow-on" framing) and unifies all stats reads under the explorer.

---

## Data flow

```
 heartbeat / relay ─► tunnel-manager (Valkey counters; broadcaster computes tps+peak+totals)
                                   │ every 500ms: bus.publish_raw("stats:snapshot", json)
                                   ▼
                         Redis pub/sub  "stats:snapshot"
                            │                       │
        explorer-api (SSE relay)            explorer-indexer (Diesel)
        /v1/stats/live ◄── broadcast        upsert metric_bucket (PK ts_bucket, 1/s, +retention)
        /v1/stats/history ◄── sqlx ─────────► Aurora metric_bucket
 browser ◄── SSE + GET /v1/stats/history (ALB routes /v1/stats/* → explorer)
```

`/v1/stats/live` and `/v1/stats/history` keep their URLs — the frontend is unaffected; only the ALB target changes.

---

## Test commands (repo quirks)

- Rust single test: `cargo test -p tunnel-manager <name>` / `cargo test -p explorer <name>` / `cargo test -p shared <name>` (run from `backend/`).
- Frontend single test: `node --import tsx --test frontend/src/backend/useTpsHistory.test.ts` (`pnpm test` is broken on this Node — no `--test-isolation`).

---

# Phase A — tunnel-manager (write side)

## Task 1: Heartbeat feeds the local counter (Tier 1 ingest)

Stops the per-heartbeat `INCRBY stats:actions:game:{game}` single-key hotspot. The delta goes into the in-process `LocalActionCounter`; the existing 1 Hz flusher (`main.rs` `spawn_action_flusher`) drains it once/sec — what the relay path already does.

**Files:** Modify `backend/tunnel-manager/src/routes.rs:213`; Test in `routes.rs`.

- [ ] **Step 1: Failing test** (in `routes.rs` `#[cfg(test)] mod tests`):

```rust
#[tokio::test]
async fn heartbeat_feeds_local_counter_not_control_directly() {
    let state = crate::state::AppState::in_memory_for_test();
    let mut rec = crate::state::SessionRecord::test_default(); // or construct with real fields
    rec.game = "blackjack".into();
    rec.stats_token = "tok".into();
    state.control.put_session("s1", rec).await;

    let mut headers = axum::http::HeaderMap::new();
    headers.insert(axum::http::header::AUTHORIZATION, "Bearer tok".parse().unwrap());
    let req = HeartbeatRequest { tunnel_id: "0xt".into(), nonce: "1".into(), actions_delta: 7, window_ms: 1000 };

    heartbeat(axum::extract::State(state.clone()), axum::extract::Path("s1".into()), headers, axum::Json(req))
        .await.unwrap();

    assert_eq!(state.control.snapshot().await.total_actions, 0, "must not hit the shared counter directly");
    assert_eq!(state.actions.drain_deltas(), vec![("blackjack".to_string(), 7)], "delta parked locally");
}
```

If `SessionRecord` has no `test_default`, construct it inline with its real fields (see `state.rs`).

- [ ] **Step 2: Run, expect FAIL** — `cargo test -p tunnel-manager heartbeat_feeds_local_counter` (today `total_actions == 7`).
- [ ] **Step 3: Change** `routes.rs` heartbeat handler:

```rust
// was: state.control.add_actions(&rec.game, req.actions_delta).await;
state.actions.incr(&rec.game, req.actions_delta);
```

- [ ] **Step 4: Run, expect PASS** — `cargo test -p tunnel-manager heartbeat_feeds_local_counter`.
- [ ] **Step 5: Commit** — `git commit -am "perf(stats): route heartbeat through local action counter"`

---

## Task 2: "Total tunnels" becomes a count-once counter (no growing set)

`stats:tunnels:settled` is an ever-growing `SADD` set (`redis.rs:139`) → unbounded memory. Replace with a counter incremented only the first time a tunnel id is seen, reusing the `SET … NX EX` dedup the recent-events ring already uses. `active` stays a set (bounded — shrinks on close).

**Files:** Modify `backend/tunnel-manager/src/store/redis.rs` (`set_tunnel_status` Closed branch; `snapshot` settled read; add `SETTLED_SEEN_TTL`); Test in `redis.rs` (redis-fixture module).

- [ ] **Step 1: Failing test** (redis-fixture module, mirrors `actions_total_is_derived_not_a_separate_key`):

```rust
#[tokio::test]
async fn settled_count_is_idempotent_under_replay() {
    let store = redis_fixture().await;
    store.set_tunnel_status("0xtun", TunnelStatus::Closed).await;
    store.set_tunnel_status("0xtun", TunnelStatus::Closed).await; // replay / second indexer
    assert_eq!(store.snapshot().await.settled_tunnels, 1, "replay must not double-count");
}
```

- [ ] **Step 2: Run, expect FAIL** — `cargo test -p tunnel-manager settled_count_is_idempotent`.
- [ ] **Step 3: Implement** in `redis.rs`:

```rust
const SETTLED_SEEN_TTL: i64 = 24 * 3600; // exceeds the indexer cursor-replay window (matches SEEN_TTL)

// in set_tunnel_status, TunnelStatus::Closed branch — replace the `sadd settled` line
// (keep the `srem stats:tunnels:active` line above it):
let newly: Option<String> = self.pool
    .set(format!("tunnels:seen:settled:{id}"), "1",
         Some(Expiration::EX(SETTLED_SEEN_TTL)), Some(SetOptions::NX), false)
    .await.ok().flatten();
if newly.is_some() {
    let _: Result<i64, _> = self.pool.incr("stats:tunnels:settled_count").await;
}
```

```rust
// in snapshot(): replace the settled SCARD with the counter GET
let settled: i64 = self.pool.get("stats:tunnels:settled_count").await.ok().flatten().unwrap_or(0);
```

Match the exact fred `set` signature used by `put_session` (Expiration::EX). `NX` returns nil when the key already exists → no incr on replay.

- [ ] **Step 4: Run, expect PASS** — `cargo test -p tunnel-manager settled_count_is_idempotent`; then `cargo test -p tunnel-manager` (no snapshot regressions).
- [ ] **Step 5: Commit** — `git commit -am "perf(stats): count settled tunnels once, drop growing set"`

---

## Task 3: Peak TPS — maintained scalar in the snapshot

**Files:** Modify `state.rs` (`StatsSnapshot`), `store/mod.rs` (trait), `store/memory.rs` + `store/redis.rs` (impls), `stats.rs` (per-tick). Test in `memory.rs`.

- [ ] **Step 1:** Add `pub peak_tps: f64,` to `StatsSnapshot` (`state.rs:73`; serde camelCase → `peakTps`). Set it in both snapshot constructors (`redis.rs`, `memory.rs`).
- [ ] **Step 2:** Add to `ControlStore` (`store/mod.rs`): `async fn update_peak_tps(&self, tps: f64);`
- [ ] **Step 3: Failing test** (`memory.rs` tests):

```rust
#[tokio::test]
async fn peak_tps_is_a_running_max() {
    let s = InMemoryControlStore::default();
    s.update_peak_tps(10.0).await;
    s.update_peak_tps(4.0).await;
    s.update_peak_tps(25.0).await;
    assert_eq!(s.snapshot().await.peak_tps, 25.0);
}
```

- [ ] **Step 4: Run, expect FAIL** — `cargo test -p tunnel-manager peak_tps_is_a_running_max`.
- [ ] **Step 5: Implement.** Memory: add `peak_tps_milli: AtomicU64` to `InMemoryControlStore`; `update_peak_tps` = `self.peak_tps_milli.fetch_max((tps*1000.0) as u64, Ordering::Relaxed);`; snapshot reads it `/1000.0`. Redis: a Lua `max` against `stats:peak_tps` (or GET+compare+SET); snapshot `GET stats:peak_tps`.
- [ ] **Step 6: Wire the broadcaster** (`stats.rs`, after `snap.tps = global.observe(...)`):

```rust
state.control.update_peak_tps(snap.tps).await;
snap.peak_tps = snap.peak_tps.max(snap.tps);
```

- [ ] **Step 7: Run, expect PASS**; then `cargo test -p tunnel-manager`.
- [ ] **Step 8: Commit** — `git commit -am "feat(stats): expose peak tps in the snapshot"`

---

## Task 4: Publish the snapshot to pub/sub; remove the local SSE route

tunnel-manager stops serving `/v1/stats/live` and instead publishes the snapshot on `stats:snapshot` each tick. The broadcaster still computes tps/peak/totals.

**Files:** Modify `stats.rs` (publish instead of local send), `routes.rs` (remove `stats_live`), `main.rs` (remove the route; drop `stats_tx` from state), `state.rs` (remove `stats_tx`), the in-memory test harness in `state.rs`.

- [ ] **Step 1:** In `stats.rs` `spawn_stats_broadcaster`, replace the local send with a publish:

```rust
// was: if let Ok(json) = serde_json::to_string(&snap) { let _ = state.stats_tx.send(json); }
if let Ok(json) = serde_json::to_string(&snap) {
    state.bus.publish_raw("stats:snapshot", json).await;
}
```

- [ ] **Step 2:** Remove the SSE route from `main.rs` (delete the `.route("/v1/stats/live", get(routes::stats_live))` line) and delete the `stats_live` handler from `routes.rs:427-436` (and now-unused `Sse`/`BroadcastStream` imports it alone used).
- [ ] **Step 3:** Remove the now-unused `stats_tx` broadcast channel: drop the field from `AppState` (`state.rs`), its construction in `main.rs`, and in `AppState::in_memory_for_test` (`state.rs:28-51`). `cargo build -p tunnel-manager` guides you to every site.
- [ ] **Step 4: Verify it still builds + tests pass** — `cargo test -p tunnel-manager`. (No new unit test: this is a transport move; end-to-end SSE is verified after Phase B/C via the explorer.)
- [ ] **Step 5: Commit** — `git commit -am "refactor(stats): publish snapshot to pubsub, drop local SSE"`

---

# Phase B — explorer (stats read service)

## Task 5: Aurora migration — `metric_bucket`

**Files:** Create `backend/explorer/migrations/0003_metric_bucket/up.sql` + `down.sql` (mirror `0001_settlement` style; auto-applied via `embed_migrations!` at indexer startup).

- [ ] **Step 1: Create `up.sql`:**

```sql
-- TPS time-series for /v1/stats/history. tunnel-manager publishes the snapshot on Redis
-- `stats:snapshot`; the explorer indexer upserts one row per second here (PK ts_bucket → idempotent
-- across the N publishing instances). Rates are derived on read. Bounded by a retention delete; an
-- index over display-only data (the durable record is on-chain + the live counters in Valkey).
CREATE TABLE IF NOT EXISTS metric_bucket (
    ts_bucket        BIGINT PRIMARY KEY,   -- epoch seconds
    total_actions    BIGINT NOT NULL,
    active_tunnels   BIGINT NOT NULL,
    settled_tunnels  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS metric_bucket_ts_idx ON metric_bucket (ts_bucket DESC);
```

- [ ] **Step 2: Create `down.sql`:**

```sql
DROP TABLE IF EXISTS metric_bucket;
```

- [ ] **Step 3: Commit** — `git commit -am "feat(explorer): add metric_bucket migration"`

---

## Task 6: `metric_history` query on the settlement store

**Files:** Modify `backend/shared/src/postgres.rs` (impl) and the `SettlementStore` trait it implements (same crate/module — find the `trait SettlementStore` def). Add a trivial impl to any in-memory/test store impl.

- [ ] **Step 1:** Add to the `SettlementStore` trait:

```rust
/// Cumulative (ts_bucket, total_actions) points within [from_secs, to_secs], ascending.
async fn metric_history(&self, from_secs: i64, to_secs: i64) -> anyhow::Result<Vec<(i64, i64)>>;
```

- [ ] **Step 2:** Implement on `PgSettlementStore` (mirrors `list`/`settled_count` sqlx style):

```rust
async fn metric_history(&self, from_secs: i64, to_secs: i64) -> anyhow::Result<Vec<(i64, i64)>> {
    let rows = sqlx::query_as::<_, (i64, i64)>(
        "SELECT ts_bucket, total_actions FROM metric_bucket \
         WHERE ts_bucket >= $1 AND ts_bucket <= $2 ORDER BY ts_bucket ASC",
    )
    .bind(from_secs)
    .bind(to_secs)
    .fetch_all(&self.pool)
    .await?;
    Ok(rows)
}
```

- [ ] **Step 3:** Add a trivial impl to any other `SettlementStore` implementor (e.g. a test/in-memory store) — return `Ok(vec![])` so the crate compiles. `cargo build -p shared -p explorer` finds them.
- [ ] **Step 4: Verify build** — `cargo build -p explorer`.
- [ ] **Step 5: Commit** — `git commit -am "feat(explorer): add metric_history store query"`

---

## Task 7: Indexer persists samples (`stats:snapshot` → `metric_bucket`)

Mirror the existing `explorer:proofs` subscriber in `wire_redis` (`indexer.rs:79-165`): subscribe to `stats:snapshot`, upsert by epoch-second (dedup across instances), and roll off old rows.

**Files:** Modify `backend/explorer/src/bin/indexer.rs` (extend `wire_redis`, or a sibling subscriber spawned the same way).

- [ ] **Step 1:** Add the sample type + SQL constants near the proof SQL:

```rust
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatsSample { total_actions: i64, active_tunnels: i64, settled_tunnels: i64 }

const METRIC_RETENTION_SECS: i64 = 30 * 24 * 3600;
const METRIC_UPSERT_SQL: &str = "INSERT INTO metric_bucket \
    (ts_bucket, total_actions, active_tunnels, settled_tunnels) VALUES ($1,$2,$3,$4) \
    ON CONFLICT (ts_bucket) DO UPDATE SET total_actions=EXCLUDED.total_actions, \
    active_tunnels=EXCLUDED.active_tunnels, settled_tunnels=EXCLUDED.settled_tunnels";
const METRIC_RETENTION_SQL: &str = "DELETE FROM metric_bucket WHERE ts_bucket < $1";
```

- [ ] **Step 2:** In `wire_redis`, after the proofs subscriber, add a second subscriber spawned the same way (own `SubscriberClient`, subscribe `stats:snapshot`, same `RecvError` handling), upserting per epoch-second. Reuse the `pool` already built in `wire_redis`:

```rust
let stats_sub = Builder::from_config(RedisConfig::from_url(redis_url)?).build_subscriber_client()?;
stats_sub.init().await?;
stats_sub.subscribe("stats:snapshot").await?;
let mut stats_msgs = stats_sub.message_rx();
let stats_pool = pool.clone();
tokio::spawn(async move {
    use diesel::sql_types::BigInt;
    use tokio::sync::broadcast::error::RecvError;
    let _sub = stats_sub;
    loop {
        let msg = match stats_msgs.recv().await {
            Ok(m) => m,
            Err(RecvError::Lagged(_)) => continue,
            Err(RecvError::Closed) => break,
        };
        let Some(payload) = msg.value.as_string() else { continue };
        let Ok(s) = serde_json::from_str::<StatsSample>(&payload) else { continue };
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64; // 1/s via PK dedup
        let mut conn = match stats_pool.get().await { Ok(c) => c, Err(_) => continue };
        let _ = diesel::sql_query(METRIC_UPSERT_SQL)
            .bind::<BigInt, _>(ts).bind::<BigInt, _>(s.total_actions)
            .bind::<BigInt, _>(s.active_tunnels).bind::<BigInt, _>(s.settled_tunnels)
            .execute(&mut conn).await;
        let _ = diesel::sql_query(METRIC_RETENTION_SQL)
            .bind::<BigInt, _>(ts - METRIC_RETENTION_SECS).execute(&mut conn).await;
    }
});
```

(`pool` is moved into the proofs task today — clone it before that move, or build the pool once and `clone()` for each task. Adjust the existing `tokio::spawn(async move { … pool … })` to use a clone so both tasks own one.)

- [ ] **Step 3: Verify build** — `cargo build -p explorer`.
- [ ] **Step 4: Commit** — `git commit -am "feat(explorer): persist tps samples to metric_bucket"`

---

## Task 8: Serve `/v1/stats/history` and `/v1/stats/live` from the explorer-api

**Files:** Modify `backend/explorer/src/api.rs` (`derive_tps_points` + `stats_history` handler + route) and `backend/explorer/src/bin/api.rs` (second pub/sub→SSE bridge for `/v1/stats/live`, mirroring the `explorer:events` bridge at `bin/api.rs:37-84`).

- [ ] **Step 1: Failing test** for the pure derivation (`api.rs` `#[cfg(test)] mod tests`):

```rust
#[test]
fn derive_tps_points_is_the_counter_derivative() {
    let cumulative = vec![(100i64, 10i64), (101, 25), (103, 55)];
    assert_eq!(derive_tps_points(&cumulative), vec![(101i64, 15.0), (103i64, 15.0)]);
}
```

- [ ] **Step 2: Run, expect FAIL** — `cargo test -p explorer derive_tps_points`.
- [ ] **Step 3: Implement** in `api.rs`:

```rust
pub(crate) fn derive_tps_points(cumulative: &[(i64, i64)]) -> Vec<(i64, f64)> {
    cumulative.windows(2).filter_map(|w| {
        let (t0, v0) = w[0];
        let (t1, v1) = w[1];
        let dt = t1 - t0;
        (dt > 0).then(|| (t1, (v1 - v0).max(0) as f64 / dt as f64))
    }).collect()
}

#[derive(serde::Deserialize)]
struct HistoryParams { window: Option<i64> }

async fn stats_history(State(s): State<ApiState>, Query(p): Query<HistoryParams>) -> Response {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    let window = p.window.unwrap_or(3600).clamp(1, 86400);
    match s.store.metric_history(now - window, now).await {
        Ok(cum) => {
            let points: Vec<_> = derive_tps_points(&cum).into_iter()
                .map(|(t, v)| serde_json::json!({ "t": t.to_string(), "v": v })).collect();
            Json(serde_json::json!({ "metric": "tps", "points": points })).into_response()
        }
        Err(e) => { tracing::error!(error = %e, "metric_history"); (StatusCode::INTERNAL_SERVER_ERROR, "internal error").into_response() }
    }
}
```

Register it in `router()`: `.route("/v1/stats/history", get(stats_history))`.

- [ ] **Step 4: Run, expect PASS** — `cargo test -p explorer derive_tps_points`.
- [ ] **Step 5: Add the `/v1/stats/live` SSE relay** in `bin/api.rs` — duplicate the `explorer:events`→broadcast bridge (`bin/api.rs:37-67`) for channel `stats:snapshot` into a second `tx`, then add the route exactly like `/v1/explorer/stream` (`bin/api.rs:70-84`):

```rust
// second bridge: stats:snapshot -> stats_tx (mirror the explorer:events bridge above)
let (stats_tx, _stats_rx) = tokio::sync::broadcast::channel::<String>(256);
if let Ok(url) = std::env::var("REDIS_PUBSUB_URL") {
    let sub = Builder::from_config(RedisConfig::from_url(&url)?).build_subscriber_client()?;
    sub.init().await?;
    sub.subscribe("stats:snapshot").await?;
    let mut messages = sub.message_rx();
    let tx2 = stats_tx.clone();
    tokio::spawn(async move {
        use tokio::sync::broadcast::error::RecvError;
        let _sub = sub;
        loop {
            match messages.recv().await {
                Ok(msg) => { if let Some(s) = msg.value.as_string() { let _ = tx2.send(s); } }
                Err(RecvError::Lagged(_)) => {}
                Err(RecvError::Closed) => break,
            }
        }
    });
}
// add to the router builder chain, next to /v1/explorer/stream:
let stats_sse_tx = stats_tx.clone();
// .route("/v1/stats/live", get(move || { let rx = stats_sse_tx.subscribe(); async move {
//     let stream = BroadcastStream::new(rx).filter_map(|m| async move {
//         m.ok().map(|json| Ok::<_, Infallible>(Event::default().data(json))) });
//     Sse::new(stream).keep_alive(KeepAlive::default()) } }))
```

(Note: N tunnel-manager instances publish ~identical snapshots, so SSE viewers receive a few duplicate frames/tick; the frontend overwrites state idempotently, so this is harmless. If instance count grows large, collapse to one stream via a `latest`+ticker — optional, not required.)

- [ ] **Step 6: Verify build** — `cargo build -p explorer`.
- [ ] **Step 7: Commit** — `git commit -am "feat(explorer): serve /v1/stats/history and /v1/stats/live"`

---

# Phase C — infra (Pulumi)

## Task 9: Route all `/v1/stats/*` to the explorer

**Files:** Modify `infra/src/components/ExplorerServices.ts:125-132`.

- [ ] **Step 1:** In the explorer `ListenerRule` `conditions[].pathPattern.values`, replace `"/v1/stats/explorer"` with `"/v1/stats/*"` so live + history + explorer all forward to the explorer target group:

```typescript
{ pathPattern: { values: ["/v1/settlements", "/v1/settlements/*", "/v1/explorer/*", "/v1/stats/*"] } },
```

- [ ] **Step 2:** No CloudFront change — `/v1/*` already forwards to the ALB (`Frontend.ts`). tunnel-manager no longer registers `/v1/stats/live` (Task 4), and the ALB now sends `/v1/stats/*` to the explorer, so nothing reaches tunnel-manager for stats.
- [ ] **Step 3: Verify** — `pnpm -C infra build` (typecheck). Deploy is via the normal Pulumi pipeline; do not deploy from here.
- [ ] **Step 4: Commit** — `git commit -am "infra: route /v1/stats/* to the explorer service"`

---

# Phase D — frontend

## Task 10: Data layer — `peakTps`, history client, `useTpsHistory`

**Files:** Modify `frontend/src/backend/controlPlane.ts`; Create `frontend/src/backend/useTpsHistory.ts` + `useTpsHistory.test.ts`.

- [ ] **Step 1:** In `controlPlane.ts` `interface StatsSnapshot`, add `peakTps: number;`.
- [ ] **Step 2:** Add to `createControlPlaneClient` (and the `ControlPlaneClient` interface):

```ts
async fetchStatsHistory(windowSecs: number): Promise<{ t: number; v: number }[]> {
  const res = await fetch(`${root}/v1/stats/history?window=${windowSecs}`);
  await failIfNotOk(res, "fetchStatsHistory");
  const body = (await res.json()) as { points: { t: string; v: number }[] };
  return body.points.map((p) => ({ t: Number(p.t), v: p.v }));
},
```

- [ ] **Step 3: Failing test** `frontend/src/backend/useTpsHistory.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { capSeries } from "./useTpsHistory";

test("capSeries keeps the newest points within the window length", () => {
  const pts = Array.from({ length: 5 }, (_, i) => ({ t: i, v: i }));
  assert.deepEqual(capSeries(pts, 3), [
    { t: 2, v: 2 },
    { t: 3, v: 3 },
    { t: 4, v: 4 },
  ]);
});
```

- [ ] **Step 4: Run, expect FAIL** — `node --import tsx --test frontend/src/backend/useTpsHistory.test.ts`.
- [ ] **Step 5: Implement** `frontend/src/backend/useTpsHistory.ts`:

```ts
import { useEffect, useRef, useState } from "react";
import { getControlPlaneClient } from "./controlPlane";
import { useBackendStats } from "./useBackendStats";

export type TpsPoint = { t: number; v: number };

export function capSeries(points: TpsPoint[], maxLen: number): TpsPoint[] {
  return points.length <= maxLen
    ? points
    : points.slice(points.length - maxLen);
}

/** Historical seed (one fetch) + live tail from each new SSE tps sample. */
export function useTpsHistory(windowSecs: number): TpsPoint[] {
  const [series, setSeries] = useState<TpsPoint[]>([]);
  const { snapshot } = useBackendStats();
  const lastT = useRef(0);
  useEffect(() => {
    let alive = true;
    getControlPlaneClient()
      .fetchStatsHistory(windowSecs)
      .then((seed) => {
        if (alive) setSeries(seed);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [windowSecs]);
  useEffect(() => {
    if (!snapshot) return;
    const t = Math.floor(Date.now() / 1000);
    if (t === lastT.current) return;
    lastT.current = t;
    setSeries((prev) =>
      capSeries([...prev, { t, v: snapshot.tps }], windowSecs),
    );
  }, [snapshot, windowSecs]);
  return series;
}
```

- [ ] **Step 6: Run, expect PASS**; **Commit** — `git commit -am "feat(explorer): tps history client + hook"`

---

## Task 11: Explorer-page components

No React test harness exists in this repo (node:test covers logic, not DOM) — verify by running the app at `/explorer`; do not add RTL.

**Files:** Create `frontend/src/explorer/MetricsStrip.tsx`, `TpsGraph.tsx`; Modify `ExplorerPage.tsx`.

- [ ] **Step 1: `MetricsStrip.tsx`** (five cards from the live SSE; `—` while connecting):

```tsx
import { Panel } from "@/components/ui/panel";
import { useBackendStats } from "@/backend/useBackendStats";

const fmt = (n: number | undefined) => (n == null ? "—" : n.toLocaleString());

export function MetricsStrip() {
  const { snapshot, status } = useBackendStats();
  const s = status === "live" ? snapshot : null;
  const cards = [
    ["Current TPS", s?.tps],
    ["Peak TPS", s?.peakTps],
    ["Open tunnels", s?.activeTunnels],
    ["Total transactions", s?.totalActions],
    ["Total tunnels", s?.settledTunnels],
  ] as const;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
      {cards.map(([label, value]) => (
        <Panel key={label} className="flex flex-col gap-1 p-3">
          <span className="wal-eyebrow text-muted-foreground">{label}</span>
          <span className="wal-mono text-lg">{fmt(value)}</span>
        </Panel>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: `TpsGraph.tsx`** (inline SVG; no chart dep):

```tsx
import { useState } from "react";
import { Panel, PanelHeader, PanelTitle } from "@/components/ui/panel";
import { useTpsHistory, type TpsPoint } from "@/backend/useTpsHistory";

const WINDOWS = [
  ["15m", 900],
  ["1h", 3600],
  ["6h", 21600],
] as const;

function path(points: TpsPoint[], w: number, h: number): string {
  if (points.length < 2) return "";
  const xs = points.map((p) => p.t);
  const minX = Math.min(...xs),
    maxX = Math.max(...xs),
    maxV = Math.max(...points.map((p) => p.v), 1);
  return points
    .map(
      (p, i) =>
        `${i ? "L" : "M"}${((p.t - minX) / (maxX - minX || 1)) * w},${h - (p.v / maxV) * h}`,
    )
    .join(" ");
}

export function TpsGraph() {
  const [win, setWin] = useState(3600);
  const series = useTpsHistory(win);
  return (
    <Panel className="flex flex-col gap-2 p-3">
      <PanelHeader className="gap-3">
        <PanelTitle>Throughput (TPS)</PanelTitle>
        <div className="ml-auto flex gap-1">
          {WINDOWS.map(([label, secs]) => (
            <button
              key={secs}
              type="button"
              onClick={() => setWin(secs)}
              className={`px-2 text-xs ${win === secs ? "text-primary" : "text-muted-foreground"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </PanelHeader>
      <svg
        viewBox="0 0 600 120"
        className="h-32 w-full"
        preserveAspectRatio="none"
      >
        <path
          d={path(series, 600, 120)}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          className="text-primary"
        />
      </svg>
    </Panel>
  );
}
```

- [ ] **Step 3: Mount on `ExplorerPage.tsx`** — add the two imports, and between `</header>` and the Settlements `<Panel>`:

```tsx
<MetricsStrip />
<TpsGraph />
```

- [ ] **Step 4: Verify in-app** — run the frontend, open `/explorer`: five cards populate from the SSE (now served by the explorer); the graph seeds from `/v1/stats/history` and tails live; cards show `—` while connecting.
- [ ] **Step 5: Commit** — `git commit -am "feat(explorer): show tps metrics + graph on explorer page"`

---

## Deferred (separate follow-on plans)

- **Client telemetry transport (scale):** app-wide aggregator coalescing all windows' `actionsDelta` into one POST every N s (C×W → ~C/N) + `navigator.sendBeacon` unload flush (token in body). Migrate the ~10 game heartbeat call sites.
- **Auth-GET removal:** drop the per-heartbeat `get_session` GET via an in-process `session_id → stats_token` TTL cache (or a stateless signed token).
- **Per-game history / downsampling tiers / native partitioning:** add a `game` column + composite PK and `_1m`/`_1h` rollup tables when long-range, per-game graphs are needed.

---

## Self-review

- **Coverage:** Tier-1 ingest (T1), settled stability (T2), peakTps (T3), publish+unify transport (T4), Aurora table (T5), history query (T6), sample persistence (T7), explorer serves all stats (T8), routing (T9), frontend data + components (T10–T11). Client coalescing/sendBeacon + auth-cache are explicitly deferred.
- **Type/name consistency:** `metric_history` returns `Vec<(i64,i64)>` (T6) → consumed by `derive_tps_points` (T8) → response `{t,v}` → `fetchStatsHistory` `{t:number,v:number}[]` (T10) → `TpsPoint`. `StatsSample` camelCase matches `StatsSnapshot` serde (T4/T7). `peak_tps`/`peakTps` consistent across `state.rs`, trait, TS type. Channel name `stats:snapshot` identical in T4 (publish), T7 (indexer), T8 (api).
- **Cross-service contract:** tunnel-manager publishes the full `StatsSnapshot` JSON on `stats:snapshot`; the explorer parses the subset it needs (`StatsSample`) for history and relays the whole JSON for live SSE — so adding snapshot fields later doesn't break either consumer.
- **Placeholders:** none — code is concrete. Two spots say "match the real signature" (`SessionRecord` fields; the exact fred `set` call) because they must mirror existing code verbatim.
