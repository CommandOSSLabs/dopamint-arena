# Local-First Pairing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make two players who connect to the same relay instance pair with each other, so their per-move relay uses the existing in-process channel instead of Redis pub/sub.

**Architecture:** One behavioral change in matchmaking — the `JOIN_OR_PAIR` Lua script prefers a same-instance waiter before falling back to today's FIFO-front pairing. The resulting co-located `MatchRecord` then flows through the already-existing `Bus::deliver` local branch with zero Redis on the per-move path. A per-instance counter records co-located vs. split pairings so the effect is observable.

**Tech Stack:** Rust (`backend/tunnel-manager`), `cargo test`, Redis/Valkey Lua scripting, testcontainers (Docker required for Redis integration tests), Prometheus text metrics.

## Global Constraints

- **Design spec:** `docs/superpowers/specs/2026-06-24-local-first-pairing-design.md` — the source of truth for scope.
- **Commits:** Conventional Commits (`<type>(<scope>): <subject>`), subject ≤ 50 chars, imperative, lowercase after type, no trailing period. **No AI attribution** (commits read as human-authored).
- **No trait/struct changes** to `MpStore` or `Waiting`: the joiner's instance is already `me.conn.instance_id`.
- **Preserve existing invariants:** `JOIN_OR_PAIR` stays a single atomic Redis eval (exactly-once pairing under concurrency; never pairs a wallet with itself; drains stale self-entries).
- **Correctness never depends on co-location:** a split match must still form and work over the pub/sub fallback.
- **Redis integration tests require Docker** (testcontainers spins up `redis:7.4-alpine`).
- **Run backend tests with:** `cargo test --manifest-path backend/tunnel-manager/Cargo.toml`.

---

### Task 1: Record the decision as ADR-0011

**Files:**
- Create: `docs/decisions/0011-local-first-pairing.md`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing (documentation only).

- [ ] **Step 1: Write the ADR**

Create `docs/decisions/0011-local-first-pairing.md`:

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add docs/decisions/0011-local-first-pairing.md
git commit -m "docs: add ADR-0011 local-first pairing"
```

---

### Task 2: Local-first pairing in `JOIN_OR_PAIR`

**Files:**
- Modify: `backend/tunnel-manager/src/store/redis.rs:286-298` (the `JOIN_OR_PAIR` constant + comment)
- Modify: `backend/tunnel-manager/src/store/redis.rs:439-457` (the `join_or_pair` caller — add `ARGV[3]`)
- Test: `backend/tunnel-manager/src/store/redis.rs` (new test in the existing `mod tests`)

**Interfaces:**
- Consumes: `crate::mp::Waiting { wallet, conn: ConnRef { instance_id, conn_id } }`; `RedisMpStore::new(pool)`; the `redis_fixture()` test helper returning `(ContainerAsync<Redis>, RedisPool)`.
- Produces: unchanged public signature `async fn join_or_pair(&self, game: &str, me: Waiting) -> Option<Waiting>` — behavior now prefers same-instance opponents.

- [ ] **Step 1: Write the failing test**

Add to the `mod tests` block in `backend/tunnel-manager/src/store/redis.rs` (alongside `join_or_pair_pairs_each_waiter_exactly_once_under_concurrency`):

```rust
#[tokio::test]
async fn join_or_pair_prefers_a_same_instance_opponent() {
    let (_redis, pool) = redis_fixture().await;
    let s = RedisMpStore::new(pool);
    let game = format!("g{}", uuid::Uuid::new_v4().simple());
    let w = |wallet: &str, inst: &str| crate::mp::Waiting {
        wallet: wallet.to_owned(),
        conn: ConnRef {
            instance_id: inst.to_owned(),
            conn_id: uuid::Uuid::new_v4(),
        },
    };

    // Two waiters park: A on instance "ia" (front), B on instance "ib".
    assert!(s.join_or_pair(&game, w("wa", "ia")).await.is_none());
    assert!(s.join_or_pair(&game, w("wb", "ib")).await.is_none());

    // A joiner on "ib" must pair with the same-instance waiter (wb), not the FIFO front (wa).
    let opp = s
        .join_or_pair(&game, w("wj", "ib"))
        .await
        .expect("should pair");
    assert_eq!(opp.wallet, "wb", "same-instance opponent preferred over FIFO front");

    // The skipped front waiter (wa) is still queued → next joiner pairs with it (fallback).
    let opp2 = s
        .join_or_pair(&game, w("wk", "ic"))
        .await
        .expect("should pair");
    assert_eq!(opp2.wallet, "wa", "FIFO-front waiter still pairs when no local match");
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test --manifest-path backend/tunnel-manager/Cargo.toml join_or_pair_prefers_a_same_instance_opponent -- --nocapture`
Expected: FAIL — current script returns the FIFO front (`wa`), so the first assertion fails with `assertion left == right` (`left: "wa"`, `right: "wb"`).

- [ ] **Step 3: Replace the `JOIN_OR_PAIR` constant and its comment**

In `backend/tunnel-manager/src/store/redis.rs`, replace lines 286-298:

```rust
// KEYS[1]=queue:<game> ARGV[1]=selfWaitingJson ARGV[2]=selfWallet ARGV[3]=selfInstance
// Atomically: drain stale self entries; pick a same-instance opponent if one waits, else the
// FIFO-front opponent; else park self. Same-instance pairs relay in-process (no Redis on the
// per-move path); cross-instance is the fallback. One eval → exactly-once under concurrency.
// Returns the opponent JSON (string) or nil (false in Lua → None in Rust).
const JOIN_OR_PAIR: &str = r#"
local items = redis.call('LRANGE', KEYS[1], 0, -1)
local fallback = nil
local colocated = nil
for _, v in ipairs(items) do
  local ok, w = pcall(cjson.decode, v)
  if ok then
    if w.wallet == ARGV[2] then
      redis.call('LREM', KEYS[1], 1, v)
    else
      if fallback == nil then fallback = v end
      if colocated == nil and w.conn and w.conn.instance_id == ARGV[3] then
        colocated = v
      end
    end
  end
end
local chosen = colocated or fallback
if chosen then
  redis.call('LREM', KEYS[1], 1, chosen)
  return chosen
end
redis.call('RPUSH', KEYS[1], ARGV[1])
return false
"#;
```

- [ ] **Step 4: Pass the joiner's instance to the script**

In `backend/tunnel-manager/src/store/redis.rs`, in `join_or_pair` (around line 446), add the third `ARGV`:

```rust
            .eval::<Option<String>, _, _, _>(
                JOIN_OR_PAIR,
                vec![format!("queue:{game}")],
                vec![me_json, me.wallet.clone(), me.conn.instance_id.clone()],
            )
```

- [ ] **Step 5: Run the new test plus the existing pairing tests**

Run: `cargo test --manifest-path backend/tunnel-manager/Cargo.toml join_or_pair -- --nocapture`
Expected: PASS — `join_or_pair_prefers_a_same_instance_opponent`, `join_or_pair_pairs_each_waiter_exactly_once_under_concurrency`, and `join_or_pair_never_pairs_wallet_with_itself` all green.

- [ ] **Step 6: Commit**

```bash
git add backend/tunnel-manager/src/store/redis.rs
git commit -m "feat(mp): prefer same-instance opponent when pairing"
```

---

### Task 3: Co-located vs. split pairing metric

**Files:**
- Modify: `backend/tunnel-manager/src/stats_counter.rs` (add `MatchPairingMetrics`)
- Modify: `backend/tunnel-manager/src/state.rs:8-19` (add `pairing` field) and `:34-42` (`in_memory_for_test`)
- Modify: `backend/tunnel-manager/src/main.rs:78` (`AppState { … }` production construction)
- Modify: `backend/tunnel-manager/src/routes.rs:24-44` (`test_state` construction)
- Modify: `backend/tunnel-manager/src/mp/ws.rs:238` and `:327` (observe at both match-creation sites)
- Modify: `backend/tunnel-manager/src/routes.rs:387-405` (`metrics` handler + `render_metrics`)
- Test: `backend/tunnel-manager/src/stats_counter.rs` (unit) and `backend/tunnel-manager/src/routes.rs:542-550` (render)

**Interfaces:**
- Consumes: `crate::mp::MatchRecord { conn_a: ConnRef, conn_b: ConnRef, … }`; `SharedState`/`AppState`.
- Produces:
  - `crate::stats_counter::MatchPairingMetrics` with `pub fn observe(&self, colocated: bool)` and `pub fn snapshot(&self) -> (u64, u64)` (returns `(colocated, split)`).
  - `AppState.pairing: MatchPairingMetrics`.
  - Two new Prometheus counters: `tunnel_matches_colocated_total`, `tunnel_matches_split_total`.

- [ ] **Step 1: Write the failing unit test for `MatchPairingMetrics`**

Add to the `mod tests` block in `backend/tunnel-manager/src/stats_counter.rs`:

```rust
#[test]
fn pairing_metrics_tally_colocated_and_split() {
    let m = MatchPairingMetrics::default();
    m.observe(true);
    m.observe(true);
    m.observe(false);
    assert_eq!(m.snapshot(), (2, 1));
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test --manifest-path backend/tunnel-manager/Cargo.toml pairing_metrics_tally -- --nocapture`
Expected: FAIL — `cannot find type MatchPairingMetrics`.

- [ ] **Step 3: Implement `MatchPairingMetrics`**

Append to `backend/tunnel-manager/src/stats_counter.rs` (after `impl LocalActionCounter`, before `#[cfg(test)]`):

```rust
/// Per-instance tally of pairing outcomes: both seats on this instance (colocated → in-process
/// relay) vs. split across instances (Redis-fallback relay). Per-instance by design — co-location
/// is an instance-local outcome and Prometheus sums these across scraped instances.
#[derive(Default)]
pub struct MatchPairingMetrics {
    colocated: AtomicU64,
    split: AtomicU64,
}

impl MatchPairingMetrics {
    /// Record one freshly created match. `colocated` = both seats share this instance.
    pub fn observe(&self, colocated: bool) {
        if colocated {
            self.colocated.fetch_add(1, Ordering::Relaxed);
        } else {
            self.split.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Cumulative `(colocated, split)` totals for Prometheus export.
    pub fn snapshot(&self) -> (u64, u64) {
        (
            self.colocated.load(Ordering::Relaxed),
            self.split.load(Ordering::Relaxed),
        )
    }
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `cargo test --manifest-path backend/tunnel-manager/Cargo.toml pairing_metrics_tally -- --nocapture`
Expected: PASS.

- [ ] **Step 5: Add the `pairing` field to `AppState` and all three constructors**

In `backend/tunnel-manager/src/state.rs`, add the field to the struct (after `actions`, line 18):

```rust
    /// Per-instance co-located-vs-split pairing tally (see stats_counter).
    pub pairing: crate::stats_counter::MatchPairingMetrics,
```

In `in_memory_for_test` (line 34-42), add to the `AppState { … }` literal (after `actions: …`):

```rust
            pairing: crate::stats_counter::MatchPairingMetrics::default(),
```

In `backend/tunnel-manager/src/main.rs` (the `AppState { … }` at line 78), add the same field line:

```rust
        pairing: crate::stats_counter::MatchPairingMetrics::default(),
```

In `backend/tunnel-manager/src/routes.rs` (`test_state`, the `AppState { … }` at line 36), add the same field line:

```rust
            pairing: crate::stats_counter::MatchPairingMetrics::default(),
```

- [ ] **Step 6: Observe at both match-creation sites**

In `backend/tunnel-manager/src/mp/ws.rs`, in the `QueueJoin` arm, immediately after `matches.insert(match_id.clone(), rec.clone());` (line 238):

```rust
                state
                    .pairing
                    .observe(rec.conn_a.instance_id == rec.conn_b.instance_id);
```

In the `ChallengeAccept` arm, immediately after `matches.insert(match_id.clone(), rec.clone());` (line 327):

```rust
            state
                .pairing
                .observe(rec.conn_a.instance_id == rec.conn_b.instance_id);
```

- [ ] **Step 7: Update the `/metrics` render test (failing) for the new counters**

Replace the body of `metrics_render_exposes_counters` in `backend/tunnel-manager/src/routes.rs` (lines 542-550):

```rust
    #[tokio::test]
    async fn metrics_render_exposes_counters() {
        let state = test_state();
        state.control.add_actions("blackjack", 42).await;
        state.pairing.observe(true);
        state.pairing.observe(true);
        state.pairing.observe(false);
        let snap = state.control.snapshot().await;
        let (colocated, split) = state.pairing.snapshot();
        let body = render_metrics(&snap, colocated, split);
        assert!(body.contains("tunnel_actions_total 42"), "got: {body}");
        assert!(body.contains("# TYPE tunnel_active gauge"));
        assert!(body.contains("tunnel_matches_colocated_total 2"), "got: {body}");
        assert!(body.contains("tunnel_matches_split_total 1"), "got: {body}");
    }
```

- [ ] **Step 8: Run it to verify it fails**

Run: `cargo test --manifest-path backend/tunnel-manager/Cargo.toml metrics_render_exposes_counters -- --nocapture`
Expected: FAIL — `render_metrics` takes 1 argument, not 3 (compile error).

- [ ] **Step 9: Extend `metrics` handler and `render_metrics`**

In `backend/tunnel-manager/src/routes.rs`, replace the `metrics` handler and `render_metrics` (lines 387-405):

```rust
pub(crate) async fn metrics(State(state): State<SharedState>) -> impl IntoResponse {
    let snap = state.control.snapshot().await;
    let (colocated, split) = state.pairing.snapshot();
    (
        [(
            axum::http::header::CONTENT_TYPE,
            "text/plain; version=0.0.4",
        )],
        render_metrics(&snap, colocated, split),
    )
}

fn render_metrics(snap: &StatsSnapshot, colocated: u64, split: u64) -> String {
    format!(
        "# TYPE tunnel_actions_total counter\ntunnel_actions_total {}\n\
         # TYPE tunnel_settled_total counter\ntunnel_settled_total {}\n\
         # TYPE tunnel_active gauge\ntunnel_active {}\n\
         # TYPE tunnel_matches_colocated_total counter\ntunnel_matches_colocated_total {}\n\
         # TYPE tunnel_matches_split_total counter\ntunnel_matches_split_total {}\n",
        snap.total_actions, snap.settled_tunnels, snap.active_tunnels, colocated, split,
    )
}
```

- [ ] **Step 10: Run the render test and the full backend suite**

Run: `cargo test --manifest-path backend/tunnel-manager/Cargo.toml`
Expected: PASS — `metrics_render_exposes_counters`, `pairing_metrics_tally_colocated_and_split`, the `join_or_pair` tests, and all pre-existing tests green.

- [ ] **Step 11: Commit**

```bash
git add backend/tunnel-manager/src/stats_counter.rs backend/tunnel-manager/src/state.rs backend/tunnel-manager/src/main.rs backend/tunnel-manager/src/routes.rs backend/tunnel-manager/src/mp/ws.rs
git commit -m "feat(mp): meter co-located vs split pairings"
```

---

## Notes for the implementer

- **Docker must be running** for Task 2's Redis integration test (testcontainers pulls `redis:7.4-alpine`). If Docker is unavailable, the test errors at container start, not at the assertion — that is an environment problem, not a code failure.
- **Do not** add per-instance queue sharding, re-homing, stickiness, or instance-to-instance transport — all explicitly out of scope (see spec §Out of scope).
- The `memory.rs` store needs **no change**: it is single-instance, so same-instance preference is always satisfied.
