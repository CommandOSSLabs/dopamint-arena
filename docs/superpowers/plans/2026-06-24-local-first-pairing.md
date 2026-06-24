# Local-First Pairing (Bounded-Hold) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make matchmaking actively produce co-located matches (both seats on one relay instance, relaying in-process) via a bounded hold, keep co-location across reconnects via an LB affinity cookie, and meter the co-located-vs-split rate.

**Architecture:** A joiner pairs immediately with a same-instance waiter; else with a waiter past its hold deadline; else parks with `deadline = now + T` (`T = MP_PAIR_HOLD_MS`, default 750 ms). A per-waiter timer on the parking connection fires a cross-instance fallback when the hold expires. Both the join path and the timer path build the match through one shared `create_and_announce_match`. A per-browser `Set-Cookie: aff=<instance>` lets the LB return reconnects to the same instance.

**Tech Stack:** Rust (`backend/tunnel-manager`), `cargo test`, Redis/Valkey Lua scripting (server-clock deadlines via `TIME`), testcontainers (Docker required for Redis integration tests), `tokio` timers, axum WebSocket upgrade, Prometheus text metrics.

## Global Constraints

- **Design spec:** `docs/superpowers/specs/2026-06-24-local-first-pairing-design.md` — source of truth for scope. This plan supersedes the no-op "prefer same-instance, fall back to FIFO front" approach from this file's earlier version.
- **Supersedes ADR draft:** the committed `docs/decisions/0011-local-first-pairing.md` describes the no-op version; Task 1 rewrites it.
- **Commits:** Conventional Commits (`<type>(<scope>): <subject>`), subject ≤ 50 chars, imperative, lowercase after type, no trailing period. **No AI attribution** (commits read as human-authored).
- **`Waiting` struct stays unchanged.** The hold `deadline` is a Lua-managed field on the queue-entry JSON; Rust ignores it on deserialize (serde drops unknown fields). Do not add a Rust field for it.
- **`JOIN_OR_PAIR` and `fallback_pair` stay single atomic Redis evals** (exactly-once pairing under concurrency; never pair a wallet with itself; drain stale self-entries).
- **Correctness never depends on co-location:** a split match must still form and relay over the pub/sub fallback. The hold changes *which* opponent, never *whether* a valid match forms.
- **Server clock for deadlines:** compute "now" inside Lua via `redis.call('TIME')` so every instance agrees with zero skew. Never pass a Rust wall-clock time as the deadline base.
- **Memory store keeps current behavior:** single-instance ⇒ every waiter is same-instance ⇒ pair immediately; the hold/timer never engages.
- **Redis integration tests require Docker** (testcontainers spins up `redis:7.4-alpine`). The `redis_fixture()` readiness retry is already committed.
- **Run backend tests with:** `cargo test --manifest-path backend/tunnel-manager/Cargo.toml`. Redis integration tests need Docker reachable; if the sandbox blocks the container port, run with the sandbox disabled.

---

### Task 1: Rewrite ADR-0011 for the bounded-hold decision

**Files:**
- Modify: `docs/decisions/0011-local-first-pairing.md` (full rewrite)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing (documentation only).

- [ ] **Step 1: Replace the ADR body**

Overwrite `docs/decisions/0011-local-first-pairing.md` with:

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add docs/decisions/0011-local-first-pairing.md
git commit -m "docs: rewrite ADR-0011 for bounded-hold pairing"
```

---

### Task 2: Add `pair_hold_ms` config to `AppState`

**Files:**
- Modify: `backend/tunnel-manager/src/state.rs:8-19` (struct) and `:28-43` (`in_memory_for_test`)
- Modify: `backend/tunnel-manager/src/main.rs:78-86` (`AppState { … }` construction + env read)
- Modify: `backend/tunnel-manager/src/routes.rs:36-43` (`test_state` construction)

**Interfaces:**
- Consumes: nothing.
- Produces: `AppState.pair_hold_ms: u64` — the matchmaking hold in milliseconds, read once at startup from `MP_PAIR_HOLD_MS` (default `750`).

- [ ] **Step 1: Add the field to the struct**

In `backend/tunnel-manager/src/state.rs`, add to `AppState` after `actions` (line 18):

```rust
    /// Matchmaking hold in ms: how long a joiner waits for a same-instance partner
    /// before falling back to a cross-instance opponent. From `MP_PAIR_HOLD_MS`.
    pub pair_hold_ms: u64,
```

In `in_memory_for_test` (the `AppState { … }` at line 34-42), add after `actions: …`:

```rust
            pair_hold_ms: 750,
```

- [ ] **Step 2: Read the env var in `main.rs`**

In `backend/tunnel-manager/src/main.rs`, immediately before `let state: SharedState = Arc::new(AppState {` (line 78), add:

```rust
    let pair_hold_ms = std::env::var("MP_PAIR_HOLD_MS")
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(750);
```

Then add to the `AppState { … }` literal after `actions: …` (line 85):

```rust
        pair_hold_ms,
```

- [ ] **Step 3: Add the field to `test_state`**

In `backend/tunnel-manager/src/routes.rs`, in the `AppState { … }` of `test_state` (line 36-43), add after `actions: …`:

```rust
            pair_hold_ms: 750,
```

- [ ] **Step 4: Build to verify it compiles**

Run: `cargo build --manifest-path backend/tunnel-manager/Cargo.toml`
Expected: builds clean (no behavior change yet).

- [ ] **Step 5: Commit**

```bash
git add backend/tunnel-manager/src/state.rs backend/tunnel-manager/src/main.rs backend/tunnel-manager/src/routes.rs
git commit -m "feat(mp): add MP_PAIR_HOLD_MS pairing hold config"
```

---

### Task 3: Bounded-hold pairing in the store layer

**Files:**
- Modify: `backend/tunnel-manager/src/store/mod.rs:51` (`MpStore::join_or_pair` signature) and `:51-52` (add `fallback_pair`)
- Modify: `backend/tunnel-manager/src/store/redis.rs:286-298` (`JOIN_OR_PAIR` const + comment), add a `FALLBACK_PAIR` const, `:439-457` (`join_or_pair` impl — add `hold_ms`), and add the `fallback_pair` impl
- Modify: `backend/tunnel-manager/src/store/memory.rs:172-183` (`join_or_pair` — add `hold_ms`), add `fallback_pair` impl
- Modify: `backend/tunnel-manager/src/mp/ws.rs:235` (the one `join_or_pair` caller — pass `state.pair_hold_ms`)
- Test: `backend/tunnel-manager/src/store/redis.rs` (new tests in `mod tests`)

**Interfaces:**
- Consumes: `AppState.pair_hold_ms` (Task 2); `crate::mp::Waiting { wallet, conn: ConnRef { instance_id, conn_id } }`; `redis_fixture()` → `(ContainerAsync<Redis>, RedisPool)`.
- Produces:
  - `MpStore::join_or_pair(&self, game: &str, me: Waiting, hold_ms: u64) -> Option<Waiting>` — pairs same-instance first, else a past-deadline waiter, else parks with `deadline = now + hold_ms`.
  - `MpStore::fallback_pair(&self, game: &str, wallet: &str) -> Option<Waiting>` — if `wallet` is still parked, pair it with the oldest different-wallet waiter and return that opponent; else `None`.

- [ ] **Step 1: Change the trait**

In `backend/tunnel-manager/src/store/mod.rs`, replace the `join_or_pair` line (51):

```rust
    async fn join_or_pair(
        &self,
        game: &str,
        me: crate::mp::Waiting,
        hold_ms: u64,
    ) -> Option<crate::mp::Waiting>;
    /// Timer-driven cross-instance fallback: if `wallet` is still parked in `game`'s queue,
    /// pair it with the oldest different-wallet waiter and return that opponent; else `None`.
    async fn fallback_pair(&self, game: &str, wallet: &str) -> Option<crate::mp::Waiting>;
```

- [ ] **Step 2: Write the failing Redis tests**

In `backend/tunnel-manager/src/store/redis.rs`, replace the committed `join_or_pair_prefers_a_same_instance_opponent` test with these four (they call the new 3-arg `join_or_pair` and `fallback_pair`):

```rust
    // A long hold lets two cross-instance waiters park together; a later same-instance joiner
    // then prefers its co-located partner over the FIFO front.
    #[tokio::test]
    async fn join_or_pair_prefers_a_same_instance_opponent() {
        let (_redis, pool) = redis_fixture().await;
        let s = RedisMpStore::new(pool);
        let game = format!("g{}", uuid::Uuid::new_v4().simple());
        let hold = 10_000; // long: nothing expires during the test
        let w = |wallet: &str, inst: &str| crate::mp::Waiting {
            wallet: wallet.to_owned(),
            conn: ConnRef { instance_id: inst.to_owned(), conn_id: uuid::Uuid::new_v4() },
        };
        // A(ia) and B(ib) both park (no local partner, neither expired).
        assert!(s.join_or_pair(&game, w("wa", "ia"), hold).await.is_none());
        assert!(s.join_or_pair(&game, w("wb", "ib"), hold).await.is_none());
        // Joiner on ib pairs the same-instance waiter wb, not the FIFO front wa.
        let opp = s.join_or_pair(&game, w("wj", "ib"), hold).await.expect("pairs");
        assert_eq!(opp.wallet, "wb", "same-instance preferred over FIFO front");
        // wa is still queued → a same-instance joiner on ia pairs it.
        let opp2 = s.join_or_pair(&game, w("wk", "ia"), hold).await.expect("pairs");
        assert_eq!(opp2.wallet, "wa", "front waiter still pairs same-instance");
    }

    // With a short hold, a parked cross-instance waiter becomes selectable once its deadline
    // passes — the join path's expired branch pairs it.
    #[tokio::test]
    async fn join_or_pair_falls_back_to_expired_waiter() {
        let (_redis, pool) = redis_fixture().await;
        let s = RedisMpStore::new(pool);
        let game = format!("g{}", uuid::Uuid::new_v4().simple());
        let w = |wallet: &str, inst: &str| crate::mp::Waiting {
            wallet: wallet.to_owned(),
            conn: ConnRef { instance_id: inst.to_owned(), conn_id: uuid::Uuid::new_v4() },
        };
        assert!(s.join_or_pair(&game, w("wa", "ia"), 30).await.is_none());
        // Before expiry, a cross-instance joiner does NOT take wa — it parks instead.
        assert!(s.join_or_pair(&game, w("wb", "ib"), 30).await.is_none());
        tokio::time::sleep(std::time::Duration::from_millis(80)).await;
        // After expiry, the next cross-instance joiner pairs the oldest expired waiter (wa).
        let opp = s.join_or_pair(&game, w("wc", "ic"), 30).await.expect("pairs");
        assert_eq!(opp.wallet, "wa", "expired waiter taken as cross-instance fallback");
    }

    // Two idle cross-instance waiters: the timer-driven fallback pairs them.
    #[tokio::test]
    async fn fallback_pair_matches_two_idle_waiters() {
        let (_redis, pool) = redis_fixture().await;
        let s = RedisMpStore::new(pool);
        let game = format!("g{}", uuid::Uuid::new_v4().simple());
        let w = |wallet: &str, inst: &str| crate::mp::Waiting {
            wallet: wallet.to_owned(),
            conn: ConnRef { instance_id: inst.to_owned(), conn_id: uuid::Uuid::new_v4() },
        };
        assert!(s.join_or_pair(&game, w("wa", "ia"), 10_000).await.is_none());
        assert!(s.join_or_pair(&game, w("wb", "ib"), 10_000).await.is_none());
        let opp = s.fallback_pair(&game, "wa").await.expect("pairs");
        assert_eq!(opp.wallet, "wb", "fallback pairs the other idle waiter");
        // Both removed: a subsequent fallback for wa finds nothing.
        assert!(s.fallback_pair(&game, "wa").await.is_none());
    }

    // A lone waiter's fallback is a no-op (no opponent); an already-paired waiter's too.
    #[tokio::test]
    async fn fallback_pair_noops_without_opponent() {
        let (_redis, pool) = redis_fixture().await;
        let s = RedisMpStore::new(pool);
        let game = format!("g{}", uuid::Uuid::new_v4().simple());
        let w = |wallet: &str, inst: &str| crate::mp::Waiting {
            wallet: wallet.to_owned(),
            conn: ConnRef { instance_id: inst.to_owned(), conn_id: uuid::Uuid::new_v4() },
        };
        assert!(s.join_or_pair(&game, w("wa", "ia"), 10_000).await.is_none());
        assert!(s.fallback_pair(&game, "wa").await.is_none(), "no opponent → no-op");
        assert!(s.fallback_pair(&game, "wnone").await.is_none(), "absent self → no-op");
    }
```

Also update the two existing pairing tests to the 3-arg signature: in `join_or_pair_pairs_each_waiter_exactly_once_under_concurrency` change the call to `s.join_or_pair(&game, crate::mp::Waiting { … }, 0)` and in `join_or_pair_never_pairs_wallet_with_itself` add `, 0` to each `join_or_pair` call (a `0` hold means "park with an already-past deadline" — fine for those tests, which assert self-drain / single-pair, not hold timing).

- [ ] **Step 3: Run the tests to verify they fail to compile/fail**

Run: `cargo test --manifest-path backend/tunnel-manager/Cargo.toml join_or_pair fallback_pair -- --nocapture`
Expected: FAIL — `join_or_pair` takes 2 args not 3 / `fallback_pair` not found (compile error) until the impls land.

- [ ] **Step 4: Replace `JOIN_OR_PAIR` and add `FALLBACK_PAIR` (redis.rs)**

In `backend/tunnel-manager/src/store/redis.rs`, replace lines 286-298 with:

```rust
// KEYS[1]=queue:<game> ARGV[1]=selfJson ARGV[2]=selfWallet ARGV[3]=selfInstance ARGV[4]=holdMs
// Atomically (server-clock `now` from TIME): drain stale self entries; pair a same-instance
// opponent if one waits; else a different-wallet waiter already past its deadline; else park self
// with deadline=now+holdMs. Co-located pairs relay in-process; cross-instance is the fallback.
// One eval → exactly-once under concurrency. Returns the opponent JSON or nil (None in Rust).
const JOIN_OR_PAIR: &str = r#"
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local items = redis.call('LRANGE', KEYS[1], 0, -1)
local colocated = nil
local expired = nil
for _, v in ipairs(items) do
  local ok, w = pcall(cjson.decode, v)
  if ok then
    if w.wallet == ARGV[2] then
      redis.call('LREM', KEYS[1], 1, v)
    else
      if colocated == nil and w.conn and w.conn.instance_id == ARGV[3] then
        colocated = v
      end
      if expired == nil and w.deadline and tonumber(w.deadline) <= now then
        expired = v
      end
    end
  end
end
local chosen = colocated or expired
if chosen then
  redis.call('LREM', KEYS[1], 1, chosen)
  return chosen
end
local me = cjson.decode(ARGV[1])
me.deadline = now + tonumber(ARGV[4])
redis.call('RPUSH', KEYS[1], cjson.encode(me))
return false
"#;

// KEYS[1]=queue:<game> ARGV[1]=selfWallet
// Timer-driven fallback: if self is still parked, pair it with the oldest different-wallet
// waiter (any instance). Drains self entries; LREMs the chosen opponent. Returns opponent JSON
// or nil. One atomic eval → cannot double-pair against a concurrent join.
const FALLBACK_PAIR: &str = r#"
local items = redis.call('LRANGE', KEYS[1], 0, -1)
local self_present = false
local opp = nil
for _, v in ipairs(items) do
  local ok, w = pcall(cjson.decode, v)
  if ok then
    if w.wallet == ARGV[1] then
      self_present = true
    elseif opp == nil then
      opp = v
    end
  end
end
if not self_present then return false end
if opp == nil then return false end
for _, v in ipairs(items) do
  local ok, w = pcall(cjson.decode, v)
  if ok and w.wallet == ARGV[1] then redis.call('LREM', KEYS[1], 1, v) end
end
redis.call('LREM', KEYS[1], 1, opp)
return opp
"#;
```

- [ ] **Step 5: Update the `join_or_pair` impl and add `fallback_pair` (redis.rs)**

In `backend/tunnel-manager/src/store/redis.rs`, replace the `join_or_pair` method (lines 439-457) with:

```rust
    async fn join_or_pair(
        &self,
        game: &str,
        me: crate::mp::Waiting,
        hold_ms: u64,
    ) -> Option<crate::mp::Waiting> {
        let me_json = serde_json::to_string(&me).unwrap();
        let res: Option<String> = match self
            .pool
            .eval::<Option<String>, _, _, _>(
                JOIN_OR_PAIR,
                vec![format!("queue:{game}")],
                vec![
                    me_json,
                    me.wallet.clone(),
                    me.conn.instance_id.clone(),
                    hold_ms.to_string(),
                ],
            )
            .await
        {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, "redis join_or_pair eval failed");
                None
            }
        };
        res.and_then(|j| serde_json::from_str(&j).ok())
    }

    async fn fallback_pair(&self, game: &str, wallet: &str) -> Option<crate::mp::Waiting> {
        let res: Option<String> = match self
            .pool
            .eval::<Option<String>, _, _, _>(
                FALLBACK_PAIR,
                vec![format!("queue:{game}")],
                vec![wallet.to_owned()],
            )
            .await
        {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, "redis fallback_pair eval failed");
                None
            }
        };
        res.and_then(|j| serde_json::from_str(&j).ok())
    }
```

- [ ] **Step 6: Update the memory impl (memory.rs)**

In `backend/tunnel-manager/src/store/memory.rs`, replace `join_or_pair` (lines 172-183) and add `fallback_pair` right after it:

```rust
    async fn join_or_pair(&self, game: &str, me: Waiting, _hold_ms: u64) -> Option<Waiting> {
        // Single-instance store: every waiter shares this instance, so the same-instance branch
        // always hits and we pair immediately. The hold never engages (no cross-instance waiters).
        let mut queues = self.queues.write().unwrap();
        let q = queues.entry(game.to_owned()).or_default();
        q.retain(|w| w.wallet != me.wallet);
        if let Some(front) = q.pop_front() {
            Some(front)
        } else {
            q.push_back(me);
            None
        }
    }

    async fn fallback_pair(&self, game: &str, wallet: &str) -> Option<Waiting> {
        // Reachable only in multi-instance deployments; single-instance pairs at join time. Kept
        // consistent: if `wallet` is still parked, pair it with the oldest different-wallet waiter.
        let mut queues = self.queues.write().unwrap();
        let q = queues.entry(game.to_owned()).or_default();
        if !q.iter().any(|w| w.wallet == wallet) {
            return None;
        }
        let opp_idx = q.iter().position(|w| w.wallet != wallet)?;
        let opp = q.remove(opp_idx);
        q.retain(|w| w.wallet != wallet);
        opp
    }
```

(`q.remove(opp_idx)` on a `VecDeque` returns `Option<Waiting>`; the trailing `opp` returns it.)

- [ ] **Step 7: Pass the hold at the call site (ws.rs)**

In `backend/tunnel-manager/src/mp/ws.rs`, in the `QueueJoin` arm, change the pairing call (line 235) from `state.mp.join_or_pair(&game, me).await` to:

```rust
            if let Some(opp) = state.mp.join_or_pair(&game, me, state.pair_hold_ms).await {
```

Leave the rest of the arm unchanged for now (the parked/None branch gets its timer in Task 4).

- [ ] **Step 8: Run the store tests + existing suite**

Run: `cargo test --manifest-path backend/tunnel-manager/Cargo.toml join_or_pair fallback_pair -- --nocapture`
Expected: PASS — the four new tests, the concurrency test, and the never-pairs-self test all green.

- [ ] **Step 9: Commit**

```bash
git add backend/tunnel-manager/src/store/mod.rs backend/tunnel-manager/src/store/redis.rs backend/tunnel-manager/src/store/memory.rs backend/tunnel-manager/src/mp/ws.rs
git commit -m "feat(mp): bounded-hold pairing in the store"
```

---

### Task 4: Shared match-creation path + per-waiter hold timer (ws.rs)

**Files:**
- Modify: `backend/tunnel-manager/src/mp/ws.rs` — add `create_and_announce_match`; rewrite the `QueueJoin` arm to use it and to arm a hold timer on park; add a `FuturesUnordered` hold-timer arm to the `handle_socket` select loop; thread a pending-holds handle through `handle_message`/`handle_authed`
- Test: `backend/tunnel-manager/src/mp/ws.rs` (`mod tests`) — a memory-store announce test and a redis-store hold→timer→fallback test

**Interfaces:**
- Consumes: `MpStore::join_or_pair(.., hold_ms)` and `MpStore::fallback_pair(game, wallet)` (Task 3); `state.pair_hold_ms` (Task 2); `Bus::deliver`, `Bus::populate`; `build_quick_match`.
- Produces: `async fn create_and_announce_match(state: &SharedState, game: &str, seat_a: Waiting, seat_b: Waiting) -> (String, MatchRecord)` — builds the record (seat A = `seat_a`, seat B = `seat_b`), `put_match`, delivers `MatchFound` to both seats, populates both relay caches, and returns `(match_id, rec)`.

- [ ] **Step 1: Add `create_and_announce_match`**

In `backend/tunnel-manager/src/mp/ws.rs`, add after `build_quick_match` (after line 50):

```rust
/// Build, persist, and announce a freshly paired match. Used by both the join path and the
/// hold-timer fallback. Delivers `MatchFound` to both seats and warms both relay caches via the
/// bus (`populate`), so neither seat needs to be the synchronous creator — the timer path pairs
/// two parked waiters, neither of which is "the joiner".
async fn create_and_announce_match(
    state: &SharedState,
    game: &str,
    seat_a: Waiting,
    seat_b: Waiting,
) -> (String, MatchRecord) {
    let match_id = new_match_id();
    let rec = MatchRecord {
        game: game.to_owned(),
        seat_a: seat_a.wallet.clone(),
        seat_b: seat_b.wallet.clone(),
        conn_a: seat_a.conn.clone(),
        conn_b: seat_b.conn.clone(),
        tunnel_id: None,
        latest_checkpoint: None,
    };
    state.mp.put_match(&match_id, rec.clone()).await;
    state
        .bus
        .deliver(
            &rec.conn_a,
            ServerMsg::MatchFound {
                match_id: match_id.clone(),
                role: "A".into(),
                opponent_wallet: rec.seat_b.clone(),
                game: game.to_owned(),
            }
            .to_text(),
        )
        .await;
    state
        .bus
        .deliver(
            &rec.conn_b,
            ServerMsg::MatchFound {
                match_id: match_id.clone(),
                role: "B".into(),
                opponent_wallet: rec.seat_a.clone(),
                game: game.to_owned(),
            }
            .to_text(),
        )
        .await;
    state.bus.populate(&rec.conn_a, &match_id, &rec).await;
    state.bus.populate(&rec.conn_b, &match_id, &rec).await;
    (match_id, rec)
}
```

- [ ] **Step 2: Add a pending-holds type alias and thread it through the handlers**

In `backend/tunnel-manager/src/mp/ws.rs`, near the top (after the imports), add:

```rust
use futures_util::stream::FuturesUnordered;
use std::pin::Pin;
use std::future::Future;

/// A parked waiter's hold expiry: resolves to `(game, me)` after the hold elapses, on the
/// connection's task (dropped — cancelled — when the connection ends).
type HoldTimer = Pin<Box<dyn Future<Output = (String, Waiting)> + Send>>;
```

Add `holds: &mut FuturesUnordered<HoldTimer>` as the final parameter of both `handle_message` (line 184) and `handle_authed` (line 220), and pass it through the `handle_message → handle_authed` call (line 215). Confirm `futures-util` is a dependency (it is — used elsewhere in the crate; if not present, add `futures-util` to `backend/tunnel-manager/Cargo.toml`).

- [ ] **Step 3: Rewrite the `QueueJoin` arm to use the helper and arm a timer**

In `backend/tunnel-manager/src/mp/ws.rs`, replace the whole `ClientMsg::QueueJoin { game } => { … }` arm (lines 229-280) with:

```rust
        ClientMsg::QueueJoin { game } => {
            joined.insert(game.clone());
            let me = Waiting {
                wallet: wallet.to_owned(),
                conn: here(state, conn_id),
            };
            match state.mp.join_or_pair(&game, me.clone(), state.pair_hold_ms).await {
                Some(opp) => {
                    // Seat A = earlier waiter (opp), seat B = this joiner (me).
                    create_and_announce_match(state, &game, opp, me).await;
                }
                None => {
                    // Parked: arm a hold timer on this connection's task. On expiry the select
                    // loop runs the cross-instance fallback. Cancelled if the connection ends.
                    let hold = state.pair_hold_ms;
                    let g = game.clone();
                    holds.push(Box::pin(async move {
                        tokio::time::sleep(std::time::Duration::from_millis(hold)).await;
                        (g, me)
                    }));
                }
            }
            Ok(())
        }
```

- [ ] **Step 4: Add the hold-timer arm + the `FuturesUnordered` to the select loop**

In `backend/tunnel-manager/src/mp/ws.rs` `handle_socket`, declare the holds set near `matches` (after line 93):

```rust
    let mut holds: FuturesUnordered<HoldTimer> = FuturesUnordered::new();
```

Pass `&mut holds` into the `handle_message(...)` call (line 153-164, add as the final argument). Then add a new arm to the `tokio::select!` (after the `inbound = stream.next()` arm, before the closing `}` at line 168):

```rust
            Some((game, me)) = holds.next(), if !holds.is_empty() => {
                // Hold expired: if still parked, pair across instances and announce.
                if let Some(opp) = state.mp.fallback_pair(&game, &me.wallet).await {
                    // Seat A = this (the waiter whose timer fired), seat B = the opponent.
                    create_and_announce_match(&state, &game, me, opp).await;
                }
            }
```

Add `use futures_util::StreamExt as _;` if `next()`/`is_empty()` are not already in scope (the loop uses `stream.next()`, so `StreamExt` is already imported — reuse it).

- [ ] **Step 5: Write the memory-store announce test**

In `backend/tunnel-manager/src/mp/ws.rs` `mod tests`, add (uses the existing `test_state()` / connection-building helpers in that module — mirror the pattern of `resume_rebinds_seat_and_acks_with_role` at line ~887 for registering two conns with frame receivers):

```rust
    // create_and_announce_match delivers MatchFound to BOTH seats and warms both caches.
    #[tokio::test]
    async fn announce_match_notifies_both_seats() {
        let state = AppState::in_memory_for_test();
        let inst = state.bus.instance_id().to_owned();
        let (ca, mut rxa) = test_conn(&state); // helper: registers a conn, returns (ConnRef, frame rx)
        let (cb, mut rxb) = test_conn(&state);
        let a = Waiting { wallet: "0xa".into(), conn: ca };
        let b = Waiting { wallet: "0xb".into(), conn: cb };
        let (_mid, rec) = create_and_announce_match(&state, "ttt", a, b).await;
        assert_eq!(rec.seat_a, "0xa");
        assert_eq!(rec.seat_b, "0xb");
        // Both sockets receive a match.found frame.
        let fa = recv_json(&mut rxa).await;
        let fb = recv_json(&mut rxb).await;
        assert_eq!(fa["type"], "match.found");
        assert_eq!(fa["role"], "A");
        assert_eq!(fb["role"], "B");
        let _ = inst;
    }
```

If `test_conn`/`recv_json` helpers don't already exist in the test module, add them by extracting the connection-registration pattern already used by the resume tests (register a `conn_id`, install a sender into the bus via the same path those tests use, return its receiver). Keep them in the `mod tests` block.

- [ ] **Step 6: Write the redis-store hold→timer→fallback test**

Add to `backend/tunnel-manager/src/mp/ws.rs` `mod tests` (Docker required; build a redis-backed `SharedState` — extract a `redis_state()` helper mirroring `redis_fixture()` from `store/redis.rs`, wiring `RedisMpStore` + `RedisBus` into an `AppState` with a short `pair_hold_ms`):

```rust
    // Two idle cross-instance waiters over the full handler: the hold timer fires and both
    // sockets receive match.found (proves the select-loop timer wiring).
    #[tokio::test]
    async fn hold_timer_pairs_two_idle_waiters() {
        // Drive two handle_socket tasks (wallets on different instances via distinct RedisBus
        // instance ids sharing one Redis), each sending queue.join for the same game with a short
        // pair_hold_ms. Assert both receive match.found within ~2× the hold. See spec §Testing.
    }
```

Implement it concretely against whatever multi-instance harness the resume tests already use; if no two-instance ws harness exists, assert the wiring at the seam instead: park a waiter via `join_or_pair` on a short hold, push a `HoldTimer`, drive the select loop once past the hold, and assert `fallback_pair` + `create_and_announce_match` delivered `match.found` to a registered opponent conn. Do not leave this as a comment-only stub — it must contain executable assertions before commit.

- [ ] **Step 7: Run the ws tests + full suite**

Run: `cargo test --manifest-path backend/tunnel-manager/Cargo.toml`
Expected: PASS — the announce test, the hold-timer test, the Task 3 store tests, and all pre-existing tests green.

- [ ] **Step 8: Commit**

```bash
git add backend/tunnel-manager/src/mp/ws.rs
git commit -m "feat(mp): hold timer + shared match announce"
```

---

### Task 5: Co-located vs. split pairing metric

**Files:**
- Modify: `backend/tunnel-manager/src/stats_counter.rs` (add `MatchPairingMetrics`)
- Modify: `backend/tunnel-manager/src/state.rs` (add `pairing` field) + `in_memory_for_test`
- Modify: `backend/tunnel-manager/src/main.rs` (`AppState { … }`) + `backend/tunnel-manager/src/routes.rs` (`test_state`)
- Modify: `backend/tunnel-manager/src/mp/ws.rs` (`create_and_announce_match` — observe)
- Modify: `backend/tunnel-manager/src/routes.rs:387-405` (`metrics` handler + `render_metrics`)
- Test: `backend/tunnel-manager/src/stats_counter.rs` (unit) + `backend/tunnel-manager/src/routes.rs` (render)

**Interfaces:**
- Consumes: `create_and_announce_match`'s `rec.conn_a`/`rec.conn_b` (Task 4); `SharedState`.
- Produces:
  - `crate::stats_counter::MatchPairingMetrics` with `pub fn observe(&self, colocated: bool)` and `pub fn snapshot(&self) -> (u64, u64)` returning `(colocated, split)`.
  - `AppState.pairing: MatchPairingMetrics`.
  - Prometheus counters `tunnel_matches_colocated_total`, `tunnel_matches_split_total`.

- [ ] **Step 1: Write the failing unit test**

Add to `backend/tunnel-manager/src/stats_counter.rs` `mod tests`:

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

Append to `backend/tunnel-manager/src/stats_counter.rs` (after `impl LocalActionCounter`, before `#[cfg(test)]`). Use the `AtomicU64`/`Ordering` already imported by `LocalActionCounter`:

```rust
/// Per-instance tally of pairing outcomes: both seats on this instance (colocated → in-process
/// relay) vs. split across instances (Redis-fallback relay). Per-instance by design — Prometheus
/// sums these across scraped instances.
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

In `backend/tunnel-manager/src/state.rs`, add to the struct after `pair_hold_ms` (Task 2):

```rust
    /// Per-instance co-located-vs-split pairing tally (see stats_counter).
    pub pairing: crate::stats_counter::MatchPairingMetrics,
```

In `in_memory_for_test`, add after `pair_hold_ms: 750,`:

```rust
            pairing: crate::stats_counter::MatchPairingMetrics::default(),
```

In `backend/tunnel-manager/src/main.rs`, add to the `AppState { … }` after `pair_hold_ms,`:

```rust
        pairing: crate::stats_counter::MatchPairingMetrics::default(),
```

In `backend/tunnel-manager/src/routes.rs` `test_state`, add after `pair_hold_ms: 750,`:

```rust
            pairing: crate::stats_counter::MatchPairingMetrics::default(),
```

- [ ] **Step 6: Observe in `create_and_announce_match`**

In `backend/tunnel-manager/src/mp/ws.rs`, in `create_and_announce_match`, immediately after `state.mp.put_match(&match_id, rec.clone()).await;`, add:

```rust
    state
        .pairing
        .observe(rec.conn_a.instance_id == rec.conn_b.instance_id);
```

- [ ] **Step 7: Update the `/metrics` render test (failing)**

Replace the body of `metrics_render_exposes_counters` in `backend/tunnel-manager/src/routes.rs` (line ~543):

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

- [ ] **Step 9: Extend the `metrics` handler and `render_metrics`**

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

- [ ] **Step 10: Run the render test + full suite**

Run: `cargo test --manifest-path backend/tunnel-manager/Cargo.toml`
Expected: PASS — `metrics_render_exposes_counters`, `pairing_metrics_tally_colocated_and_split`, and all pre-existing tests green.

- [ ] **Step 11: Commit**

```bash
git add backend/tunnel-manager/src/stats_counter.rs backend/tunnel-manager/src/state.rs backend/tunnel-manager/src/main.rs backend/tunnel-manager/src/routes.rs backend/tunnel-manager/src/mp/ws.rs
git commit -m "feat(mp): meter co-located vs split pairings"
```

---

### Task 6: Reconnect affinity cookie

**Files:**
- Modify: `backend/tunnel-manager/src/mp/ws.rs:18-20` (`mp_upgrade`)
- Modify: `docs/adding-a-tunnel-game.md` OR a new `docs/decisions/` note — add the required LB stickiness deployment note (a short doc block; do not create infra config)
- Test: `backend/tunnel-manager/src/mp/ws.rs` (`mod tests`) — assert the handshake response carries the affinity cookie

**Interfaces:**
- Consumes: `state.bus.instance_id()`.
- Produces: `mp_upgrade` responses carry `Set-Cookie: aff=<instance_id>; Path=/; SameSite=Lax` on the WebSocket handshake.

- [ ] **Step 1: Write the failing test**

Add to `backend/tunnel-manager/src/mp/ws.rs` `mod tests`:

```rust
    // The WS handshake response sets the per-browser affinity cookie naming this instance, so the
    // LB can route reconnects back here (preserving co-location). See ADR-0011 / spec §Component 2.
    #[tokio::test]
    async fn mp_upgrade_sets_affinity_cookie() {
        use axum::http::{header, Request};
        use tower::ServiceExt as _; // oneshot
        let state = AppState::in_memory_for_test();
        let app = axum::Router::new()
            .route("/v1/mp", axum::routing::get(mp_upgrade))
            .with_state(state.clone());
        // A valid WS upgrade request (handshake headers); the response is 101 with Set-Cookie.
        let req = Request::builder()
            .uri("/v1/mp")
            .header(header::CONNECTION, "upgrade")
            .header(header::UPGRADE, "websocket")
            .header(header::SEC_WEBSOCKET_VERSION, "13")
            .header(header::SEC_WEBSOCKET_KEY, "dGhlIHNhbXBsZSBub25jZQ==")
            .body(axum::body::Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        let cookie = resp
            .headers()
            .get(header::SET_COOKIE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        assert!(cookie.starts_with("aff=test-instance"), "got: {cookie}");
    }
```

(`tower` is already a transitive dep via axum; if `tower::ServiceExt` is unavailable in dev-deps, add `tower` to `[dev-dependencies]` in `backend/tunnel-manager/Cargo.toml`.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test --manifest-path backend/tunnel-manager/Cargo.toml mp_upgrade_sets_affinity_cookie -- --nocapture`
Expected: FAIL — no `Set-Cookie` header on the response.

- [ ] **Step 3: Set the cookie in `mp_upgrade`**

In `backend/tunnel-manager/src/mp/ws.rs`, replace `mp_upgrade` (lines 18-20) with:

```rust
pub async fn mp_upgrade(State(state): State<SharedState>, ws: WebSocketUpgrade) -> Response {
    let instance = state.bus.instance_id().to_owned();
    let mut resp = ws.on_upgrade(move |socket| handle_socket(socket, state));
    if let Ok(value) =
        axum::http::HeaderValue::from_str(&format!("aff={instance}; Path=/; SameSite=Lax"))
    {
        resp.headers_mut()
            .insert(axum::http::header::SET_COOKIE, value);
    }
    resp
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test --manifest-path backend/tunnel-manager/Cargo.toml mp_upgrade_sets_affinity_cookie -- --nocapture`
Expected: PASS.

- [ ] **Step 5: Add the LB deployment note**

Append a short section to `docs/adding-a-tunnel-game.md` (or create `docs/decisions/0011-local-first-pairing.md`'s companion note) titled "Deployment: relay session stickiness":

```markdown
## Deployment: relay session stickiness (local-first pairing)

The relay sets `Set-Cookie: aff=<instance_id>` on the `/v1/mp` WebSocket handshake.
For co-location to survive reconnects, the load balancer MUST be configured for
cookie-based session affinity on `/v1/mp`, honoring the `aff` cookie (or its own
stickiness cookie). Without it, reconnects are routed round-robin and co-located
matches degrade to split (still correct, over the Redis fallback). Cross-origin
deployments also need `SameSite=None; Secure` on the cookie.
```

- [ ] **Step 6: Commit**

```bash
git add backend/tunnel-manager/src/mp/ws.rs docs/adding-a-tunnel-game.md
git commit -m "feat(mp): set relay affinity cookie on handshake"
```

---

## Notes for the implementer

- **Docker must be running** for the Redis integration tests (Tasks 3 and 4's redis test). If the sandbox blocks the mapped container port, run those `cargo test` commands with the sandbox disabled. A container-readiness retry is already in `redis_fixture()`.
- **Lua `TIME` in scripts** is allowed under Redis 7.4's default effects-replication; `now` is milliseconds = `seconds*1000 + floor(micros/1000)`.
- **cjson round-trips the queue entry** (`{wallet, conn:{instance_id, conn_id}, deadline}`). No balance/signature is ever in a `Waiting`, so re-encoding is safe; the stored string is what `LREM` matches.
- **Do not** add per-instance queue sharding, re-homing, redirect-on-resume, or changes to the resume protocol — all out of scope (spec §Out of scope).
- **Timer cancellation** is structural: the `FuturesUnordered<HoldTimer>` lives in `handle_socket`, so when the connection task ends every pending hold is dropped. A dropped socket also runs `leave_queue` for each joined game, so a late `fallback_pair` finds no self-entry and no-ops.
- **Match record in Redis** (`put_match`) is unchanged and stays once-per-match, off the per-move path.
```
