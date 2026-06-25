# Control-plane Aggregation Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every per-instance state surface aggregate correctly in Redis by replacing non-atomic read-modify-write paths with atomic primitives, removing two slow resource leaks, and dropping one redundant contended key — without touching the per-move hot path.

**Architecture:** All changes live in the storage seam (`backend/tunnel-manager/src/store/`). The in-memory impl is already atomic under `RwLock`; the defects are in the Redis impl, which currently does GET→mutate→SET on owned keys. We replace those with single Lua scripts / single-key writes, keep the two impls behaviorally identical, and add a shutdown flush for the move counter. The hot path (`mp/ws.rs`) is deliberately untouched.

**Tech Stack:** Rust, `tokio`, `async-trait`, `fred` 9.x (Redis client), `serde_json`. Tests via `cargo test` (`node:test`/`tsx` not used here). Redis integration tests are `#[ignore]` and require a live Redis at `TEST_REDIS_URL`.

## Global Constraints

- **No relational DB; Redis-only.** Consistent with ADR-0005. Do not add storage backends.
- **Memory and Redis impls stay behaviorally identical.** Every store-trait method must give the same observable result in both; tests assert this.
- **New Lua scripts must be O(1).** No `LRANGE`/loops over unbounded data inside a script (it blocks the shard).
- **The cache pool is treated as non-cluster** (the existing `PUSH_RECENT_EVENT` script already passes two un-tagged keys); multi-key Lua on the cache pool is therefore allowed. Do not assume cluster-mode for the cache.
- **Checkpoint balances are `u64` and must stay byte-exact.** Never `cjson.decode`/`encode` a value carrying `party_a_balance`/`party_b_balance` inside Redis Lua (Lua numbers are doubles → precision loss > 2^53). Store the checkpoint as an opaque string written verbatim.
- **Rollout is a flag-day for `match:` and `presence:` keys** (their wire shape changes). No dual-read/write shim. In-flight matches during deploy fall back to reconnect/on-chain — accepted.
- **Conventional Commits, imperative, ≤50-char subject, no AI attribution.** One logical change per commit.
- **Hot path is out of scope.** Do not modify `mp/ws.rs` relay, `LocalActionCounter::incr`, or the per-move path except the shutdown-flush wiring in Task 6.

**Running tests:**

- Fast (memory + pure): `cargo test -p tunnel-manager`
- Redis integration (needs Redis): start one with `docker run --rm -p 6379:6379 redis:7`, then
  `TEST_REDIS_URL=redis://localhost:6379 cargo test -p tunnel-manager -- --ignored --test-threads=1`
  (single-threaded: the ignored tests share one Redis and some assert on global keys).

---

### Task 1: F4 — derive `total_actions` from per-game counts

Remove the redundant, universally-contended `stats:actions:total` key. Each instance already increments `stats:actions:game:<game>`; the total is the sum of those. Single source of truth, and it drops the one key every instance writes every second.

**Files:**

- Modify: `backend/tunnel-manager/src/store/redis.rs:150-162` (`add_actions`), `:164-206` (`snapshot`)
- Modify: `backend/tunnel-manager/src/store/memory.rs:21` (struct field), `:69-77` (`add_actions`), `:79-111` (`snapshot`)
- Test: `backend/tunnel-manager/src/store/memory.rs` (existing `heartbeats_attribute_actions_per_game` must stay green), `backend/tunnel-manager/src/store/redis.rs` (new ignored test)

**Interfaces:**

- Consumes: nothing new.
- Produces: no signature change. `snapshot().total_actions` now equals `Σ per_game[*].total_actions`. `add_actions` writes only `stats:actions:game:<game>`.

- [ ] **Step 1: Write the failing Redis test**

Add to the `mod tests` block in `redis.rs` (after `actions_count_accumulates_per_game`):

```rust
#[tokio::test]
#[ignore = "requires TEST_REDIS_URL"]
async fn actions_total_is_derived_not_a_separate_key() {
    let Some(url) = test_url() else { return };
    let pool = connect(&url).await.unwrap();
    // Clear the legacy aggregate so a stale value can't mask the assertion.
    let _: Option<i64> = pool.del("stats:actions:total").await.ok();
    let s = RedisControlStore::new(pool.clone());
    let game = format!("g{}", uuid::Uuid::new_v4().simple());
    s.add_actions(&game, 7).await;
    s.add_actions(&game, 5).await;
    // Total must come from summing per-game keys, never from a written aggregate.
    let legacy: Option<i64> = pool.get("stats:actions:total").await.ok().flatten();
    assert!(legacy.is_none(), "stats:actions:total must not be written");
    let snap = s.snapshot().await;
    assert_eq!(snap.per_game[&game].total_actions, 12);
    assert!(snap.total_actions >= 12, "total is the sum of per-game");
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `TEST_REDIS_URL=redis://localhost:6379 cargo test -p tunnel-manager actions_total_is_derived_not_a_separate_key -- --ignored`
Expected: FAIL — `stats:actions:total must not be written` (current `add_actions` writes it).

- [ ] **Step 3: Drop the total write in the Redis `add_actions`**

Replace `redis.rs:150-162` with:

```rust
    async fn add_actions(&self, game: &str, delta: u64) {
        // Per-game only: the total is derived in `snapshot` as the sum of per-game keys.
        // Writing a separate total would be a redundant, single-slot write-hotspot (every
        // instance, every second) and could diverge from the per-game sum on partial failure.
        let res: Result<i64, _> = self
            .pool
            .incr_by(format!("stats:actions:game:{game}"), delta as i64)
            .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis add_actions incr per-game failed");
        }
    }
```

- [ ] **Step 4: Derive the total in the Redis `snapshot`**

In `redis.rs:164-206`, delete the `let total: i64 = … "stats:actions:total" …` read, add a running sum, and use it. The method becomes:

```rust
    async fn snapshot(&self) -> StatsSnapshot {
        let active: i64 = self.pool.scard("stats:tunnels:active").await.unwrap_or(0);
        let settled: i64 = self.pool.scard("stats:tunnels:settled").await.unwrap_or(0);

        let mut total_actions: u64 = 0;
        let mut per_game: HashMap<String, GameStat> = HashMap::new();
        for (prefix, is_actions) in [
            ("stats:actions:game:", true),
            ("stats:tunnels:game:", false),
        ] {
            let keys = self.scan_keys(&format!("{prefix}*")).await;
            for key in keys {
                let v: i64 = self.pool.get(&key).await.ok().flatten().unwrap_or(0);
                let game = key.trim_start_matches(prefix).to_owned();
                let entry = per_game.entry(game).or_insert(GameStat {
                    tps: 0.0,
                    tunnels: 0,
                    total_actions: 0,
                });
                if is_actions {
                    entry.total_actions = v as u64;
                    total_actions += v as u64;
                } else {
                    entry.tunnels = v as u64;
                }
            }
        }

        let recent_events = self.recent_events().await;
        StatsSnapshot {
            tps: 0.0, // filled by the broadcaster from its per-tick diff
            total_actions,
            active_tunnels: active as u64,
            settled_tunnels: settled as u64,
            per_game,
            recent_events,
        }
    }
```

- [ ] **Step 5: Mirror the change in the memory impl**

In `memory.rs`, delete the `total_actions: AtomicU64,` field at `:21`. Replace `add_actions` (`:69-77`) with:

```rust
    async fn add_actions(&self, game: &str, delta: u64) {
        // Per-game only; total is derived in `snapshot` (parity with the Redis impl).
        *self
            .per_game_actions
            .write()
            .unwrap()
            .entry(game.to_owned())
            .or_insert(0) += delta;
    }
```

In `snapshot` (`:79-111`), build a running sum and use it. Replace the body with:

```rust
    async fn snapshot(&self) -> StatsSnapshot {
        let actions = self.per_game_actions.read().unwrap();
        let tunnels = self.per_game_tunnels.read().unwrap();
        let mut total_actions: u64 = 0;
        let mut per_game: HashMap<String, GameStat> = HashMap::new();
        for (game, total) in actions.iter() {
            per_game
                .entry(game.clone())
                .or_insert(GameStat {
                    tps: 0.0,
                    tunnels: 0,
                    total_actions: 0,
                })
                .total_actions = *total;
            total_actions += *total;
        }
        for (game, n) in tunnels.iter() {
            per_game
                .entry(game.clone())
                .or_insert(GameStat {
                    tps: 0.0,
                    tunnels: 0,
                    total_actions: 0,
                })
                .tunnels = *n;
        }
        StatsSnapshot {
            tps: 0.0, // filled by the broadcaster from its per-tick diff
            total_actions,
            active_tunnels: self.active_tunnels.load(Ordering::Relaxed),
            settled_tunnels: self.settled_tunnels.load(Ordering::Relaxed),
            per_game,
            recent_events: self.recent_ring.read().unwrap().iter().cloned().collect(),
        }
    }
```

- [ ] **Step 6: Run the fast suite to verify parity holds**

Run: `cargo test -p tunnel-manager heartbeats_attribute_actions_per_game`
Expected: PASS (`total_actions == 1450` still holds, now derived).

- [ ] **Step 7: Run the Redis test to verify it passes**

Run: `TEST_REDIS_URL=redis://localhost:6379 cargo test -p tunnel-manager actions_total_is_derived_not_a_separate_key -- --ignored`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/tunnel-manager/src/store/redis.rs backend/tunnel-manager/src/store/memory.rs
git commit -m "refactor(store): derive total actions from per-game"
```

---

### Task 2: F2 — make `take_invite` atomic

`GET`→check→`DEL` lets two concurrent accepts both return `Some` (a retried/double-clicked accept creates two matches). Collapse to one Lua: get, check recipient, del, return — single winner.

**Files:**

- Modify: `backend/tunnel-manager/src/store/redis.rs` (add a `TAKE_INVITE` const near the other scripts ~`:321`; rewrite `take_invite` `:441-462`)
- Test: `backend/tunnel-manager/src/store/redis.rs` (new ignored concurrency test)

**Interfaces:**

- Consumes: nothing new.
- Produces: `take_invite(match_id, accepter) -> Option<DirectedInvite>` unchanged; now atomic (exactly one of N concurrent equal calls returns `Some`).

- [ ] **Step 1: Write the failing concurrency test**

Add to `mod tests` in `redis.rs`:

```rust
#[tokio::test]
#[ignore = "requires TEST_REDIS_URL"]
async fn take_invite_yields_some_to_exactly_one_concurrent_accepter() {
    let Some(url) = test_url() else { return };
    let s = std::sync::Arc::new(RedisMpStore::new(connect(&url).await.unwrap()));
    let mid = format!("m{}", uuid::Uuid::new_v4().simple());
    let inv = crate::mp::DirectedInvite {
        from: "0xa".into(),
        to: "0xb".into(),
        game: "ttt".into(),
        from_conn: ConnRef { instance_id: "i".into(), conn_id: uuid::Uuid::nil() },
    };
    s.put_invite(&mid, inv).await;
    // Two concurrent accepts by the invited wallet; exactly one must win.
    let (s1, s2, m1, m2) = (s.clone(), s.clone(), mid.clone(), mid.clone());
    let h1 = tokio::spawn(async move { s1.take_invite(&m1, "0xb").await });
    let h2 = tokio::spawn(async move { s2.take_invite(&m2, "0xb").await });
    let wins = [h1.await.unwrap(), h2.await.unwrap()]
        .iter()
        .filter(|o| o.is_some())
        .count();
    assert_eq!(wins, 1, "exactly one concurrent accept may consume the invite");
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `TEST_REDIS_URL=redis://localhost:6379 cargo test -p tunnel-manager take_invite_yields_some_to_exactly_one_concurrent_accepter -- --ignored`
Expected: FAIL (often `wins == 2`) — the GET→DEL gap lets both read the invite.

- [ ] **Step 3: Add the Lua script**

Add near the other script consts in `redis.rs` (after `LEAVE_QUEUE`, ~`:321`):

```rust
// Atomic accept: return the invite JSON and delete it iff it exists and is addressed to the
// accepter; else nil. Single-winner under concurrent accepts (no GET→DEL gap).
// KEYS[1]=invite:<match_id>  ARGV[1]=accepter wallet
const TAKE_INVITE: &str = r#"
local raw = redis.call('GET', KEYS[1])
if not raw then return false end
local inv = cjson.decode(raw)
if inv.to ~= ARGV[1] then return false end
redis.call('DEL', KEYS[1])
return raw
"#;
```

Note: `cjson.decode` here only reads `inv.to` (a string) and returns the **original `raw`** verbatim — it never re-encodes, so no number fields are touched.

- [ ] **Step 4: Rewrite `take_invite` to eval it**

Replace `redis.rs:441-462` with:

```rust
    async fn take_invite(
        &self,
        match_id: &str,
        accepter: &str,
    ) -> Option<crate::mp::DirectedInvite> {
        let raw: Option<String> = match self
            .pool
            .eval::<Option<String>, _, _, _>(
                TAKE_INVITE,
                vec![format!("invite:{match_id}")],
                vec![accepter.to_owned()],
            )
            .await
        {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!(error = %e, "redis take_invite eval failed");
                None
            }
        };
        raw.and_then(|j| serde_json::from_str(&j).ok())
    }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `TEST_REDIS_URL=redis://localhost:6379 cargo test -p tunnel-manager take_invite_yields_some_to_exactly_one_concurrent_accepter -- --ignored`
Expected: PASS (`wins == 1`).

- [ ] **Step 6: Run the memory parity test (unchanged behavior)**

Run: `cargo test -p tunnel-manager challenge_accept_requires_the_invited_wallet`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/tunnel-manager/src/store/redis.rs
git commit -m "fix(store): make take_invite atomic"
```

---

### Task 3: F3 — collapse presence to a single key

`set_presence` writes two keys (`presence:<wallet>` + `presence:ref:<wallet>`) and `clear_presence_if` deletes them in two ops — the mirror orphans if the second `DEL` fails, and presence has no TTL, so orphans accumulate. Store the full `ConnRef` JSON under one key; the CAS Lua decodes it to compare `conn_id`.

**Files:**

- Modify: `backend/tunnel-manager/src/store/redis.rs` (`CLEAR_PRESENCE_IF` const `:299-308`; `set_presence` `:325-354`; `get_presence` `:356-364`; `clear_presence_if` `:366-389`)
- Test: `backend/tunnel-manager/src/store/redis.rs` (new ignored test)

**Interfaces:**

- Consumes: `ConnRef { instance_id: String, conn_id: ConnId }` (already serde).
- Produces: `set_presence`/`get_presence`/`clear_presence_if` signatures unchanged. On-disk: one key `presence:<wallet>` holding `ConnRef` JSON. No `presence:ref:` key exists.

- [ ] **Step 1: Write the failing test**

Add to `mod tests` in `redis.rs`:

```rust
#[tokio::test]
#[ignore = "requires TEST_REDIS_URL"]
async fn presence_uses_one_key_and_cas_clears_it() {
    let Some(url) = test_url() else { return };
    let pool = connect(&url).await.unwrap();
    let s = RedisMpStore::new(pool.clone());
    let wallet = format!("0x{}", uuid::Uuid::new_v4().simple());
    let conn = uuid::Uuid::new_v4();
    s.set_presence(&wallet, ConnRef { instance_id: "A".into(), conn_id: conn }).await;
    // No mirror key may exist.
    let mirror: Option<String> = pool.get(format!("presence:ref:{wallet}")).await.ok().flatten();
    assert!(mirror.is_none(), "no presence:ref mirror key");
    // Round-trips the full ConnRef.
    let got = s.get_presence(&wallet).await.expect("presence present");
    assert_eq!((got.instance_id.as_str(), got.conn_id), ("A", conn));
    // CAS with a wrong conn must not clear.
    s.clear_presence_if(&wallet, uuid::Uuid::new_v4()).await;
    assert!(s.get_presence(&wallet).await.is_some(), "wrong conn must not clear");
    // CAS with the right conn clears it, leaving no key behind.
    s.clear_presence_if(&wallet, conn).await;
    assert!(s.get_presence(&wallet).await.is_none(), "matching conn clears");
    let leftover: Option<String> = pool.get(format!("presence:{wallet}")).await.ok().flatten();
    assert!(leftover.is_none(), "no orphaned presence key");
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `TEST_REDIS_URL=redis://localhost:6379 cargo test -p tunnel-manager presence_uses_one_key_and_cas_clears_it -- --ignored`
Expected: FAIL — `no presence:ref mirror key` (current `set_presence` writes the mirror).

- [ ] **Step 3: Replace the CAS script**

Replace `CLEAR_PRESENCE_IF` at `redis.rs:299-308` with a version that decodes the stored `ConnRef` and compares its `conn_id`:

```rust
// Presence compare-and-delete on a single key holding the full ConnRef JSON: delete only if
// the stored conn_id still matches. cjson.decode reads conn_id (a string) only; nothing is
// re-encoded. KEYS[1]=presence:<wallet>  ARGV[1]=conn_id string
const CLEAR_PRESENCE_IF: &str = r#"
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ref = cjson.decode(raw)
if ref.conn_id == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
"#;
```

- [ ] **Step 4: Rewrite `set_presence` to one key**

Replace `redis.rs:325-354` with:

```rust
    async fn set_presence(&self, wallet: &str, at: ConnRef) {
        // One key holds the full ConnRef JSON: get_presence reads it; clear_presence_if's Lua
        // decodes conn_id from it. No separate mirror to orphan.
        let res: Result<(), _> = self
            .pool
            .set(
                format!("presence:{wallet}"),
                serde_json::to_string(&at).unwrap(),
                None,
                None,
                false,
            )
            .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis set_presence failed");
        }
    }
```

- [ ] **Step 5: Point `get_presence` at the single key**

Replace `redis.rs:356-364` with:

```rust
    async fn get_presence(&self, wallet: &str) -> Option<ConnRef> {
        let v: Option<String> = self
            .pool
            .get(format!("presence:{wallet}"))
            .await
            .ok()
            .flatten();
        v.and_then(|j| serde_json::from_str(&j).ok())
    }
```

- [ ] **Step 6: Simplify `clear_presence_if` to one eval**

Replace `redis.rs:366-389` with:

```rust
    async fn clear_presence_if(&self, wallet: &str, conn: crate::mp::ConnId) {
        let res: Result<i64, _> = self
            .pool
            .eval(
                CLEAR_PRESENCE_IF,
                vec![format!("presence:{wallet}")],
                vec![conn.to_string()],
            )
            .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis clear_presence_if eval failed");
        }
    }
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `TEST_REDIS_URL=redis://localhost:6379 cargo test -p tunnel-manager presence_uses_one_key_and_cas_clears_it -- --ignored`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/tunnel-manager/src/store/redis.rs
git commit -m "fix(store): collapse presence to one key"
```

---

### Task 4: F1 — store the match record as a Redis HASH

`set_tunnel_id` and `record_checkpoint` do `get_match`→mutate→`put_match`, so concurrent writes to different fields clobber each other. Store the record as a HASH with independent fields. Keep the checkpoint as an **opaque JSON string** plus a separate integer `checkpoint_nonce` for the monotonic CAS, so the Lua never `cjson`-touches a `u64` balance.

**Files:**

- Modify: `backend/tunnel-manager/src/store/redis.rs` (add `PUT_MATCH` + `RECORD_CHECKPOINT` consts near the other scripts; rewrite `put_match` `:471-485`, `get_match` `:487-495`, `set_tunnel_id` `:497-502`, `record_checkpoint` `:504-514`)
- Test: `backend/tunnel-manager/src/store/redis.rs` (new ignored tests); existing `record_checkpoint_keeps_highest_nonce` in `memory.rs` stays green

**Interfaces:**

- Consumes: `MatchRecord { game, seat_a, seat_b, conn_a: ConnRef, conn_b: ConnRef, tunnel_id: Option<String>, latest_checkpoint: Option<Checkpoint> }`; `Checkpoint { nonce: u64, .. }`.
- Produces: `put_match`/`get_match`/`set_tunnel_id`/`record_checkpoint` signatures unchanged. On-disk: HASH `match:<id>` with string fields `game`, `seat_a`, `seat_b`, `conn_a` (JSON), `conn_b` (JSON), optional `tunnel_id`, optional `latest_checkpoint` (JSON), optional `checkpoint_nonce` (integer). 6h TTL on the key.

- [ ] **Step 1: Write the failing tests (lost-update race + balance exactness + round-trip)**

Add to `mod tests` in `redis.rs`. Add this helper near the top of the module (after `test_url`):

```rust
fn sample_match() -> crate::mp::MatchRecord {
    let cr = ConnRef { instance_id: "i".into(), conn_id: uuid::Uuid::new_v4() };
    crate::mp::MatchRecord {
        game: "ttt".into(),
        seat_a: "0xa".into(),
        seat_b: "0xb".into(),
        conn_a: cr.clone(),
        conn_b: cr,
        tunnel_id: None,
        latest_checkpoint: None,
    }
}
```

```rust
#[tokio::test]
#[ignore = "requires TEST_REDIS_URL"]
async fn match_record_round_trips_through_hash() {
    let Some(url) = test_url() else { return };
    let s = RedisMpStore::new(connect(&url).await.unwrap());
    let mid = format!("m{}", uuid::Uuid::new_v4().simple());
    let m = sample_match();
    s.put_match(&mid, m.clone()).await;
    let got = s.get_match(&mid).await.expect("match round-trips");
    assert_eq!(got.game, m.game);
    assert_eq!((got.seat_a, got.seat_b), (m.seat_a, m.seat_b));
    assert_eq!(got.conn_a.conn_id, m.conn_a.conn_id);
    assert!(got.tunnel_id.is_none() && got.latest_checkpoint.is_none());
}

#[tokio::test]
#[ignore = "requires TEST_REDIS_URL"]
async fn tunnel_id_and_checkpoint_writes_do_not_clobber() {
    let Some(url) = test_url() else { return };
    let s = std::sync::Arc::new(RedisMpStore::new(connect(&url).await.unwrap()));
    let mid = format!("m{}", uuid::Uuid::new_v4().simple());
    s.put_match(&mid, sample_match()).await;
    // A huge balance (> 2^53) must survive byte-exact: it rides in the checkpoint and is
    // submitted on-chain, so any precision loss is a correctness break.
    let big = 9_007_199_254_740_993u64; // 2^53 + 1
    let cp = crate::mp::Checkpoint {
        nonce: 4,
        party_a_balance: big,
        party_b_balance: 1,
        state_hash: "h".into(),
        sig_a: "a".into(),
        sig_b: "b".into(),
    };
    let (s1, s2, m1, m2) = (s.clone(), s.clone(), mid.clone(), mid.clone());
    let h1 = tokio::spawn(async move { s1.set_tunnel_id(&m1, "0xtunnel").await });
    let h2 = tokio::spawn(async move { s2.record_checkpoint(&m2, cp).await });
    h1.await.unwrap();
    h2.await.unwrap();
    let got = s.get_match(&mid).await.unwrap();
    assert_eq!(got.tunnel_id.as_deref(), Some("0xtunnel"), "tunnel_id survived");
    let stored = got.latest_checkpoint.expect("checkpoint survived");
    assert_eq!(stored.nonce, 4);
    assert_eq!(stored.party_a_balance, big, "u64 balance must be byte-exact");
}

#[tokio::test]
#[ignore = "requires TEST_REDIS_URL"]
async fn record_checkpoint_keeps_highest_nonce_redis() {
    let Some(url) = test_url() else { return };
    let s = RedisMpStore::new(connect(&url).await.unwrap());
    let mid = format!("m{}", uuid::Uuid::new_v4().simple());
    s.put_match(&mid, sample_match()).await;
    let cp = |n| crate::mp::Checkpoint {
        nonce: n, party_a_balance: 1, party_b_balance: 1,
        state_hash: "h".into(), sig_a: "a".into(), sig_b: "b".into(),
    };
    s.record_checkpoint(&mid, cp(5)).await;
    s.record_checkpoint(&mid, cp(3)).await; // stale, must be ignored
    assert_eq!(s.get_match(&mid).await.unwrap().latest_checkpoint.unwrap().nonce, 5);
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `TEST_REDIS_URL=redis://localhost:6379 cargo test -p tunnel-manager match_record -- --ignored`
Run: `TEST_REDIS_URL=redis://localhost:6379 cargo test -p tunnel-manager tunnel_id_and_checkpoint -- --ignored`
Expected: `tunnel_id_and_checkpoint_writes_do_not_clobber` FAILS (one field lost in the GET→SET race); the round-trip/nonce tests fail to compile-match because the impl still uses STRING JSON (they will pass against the old impl on the happy path but the clobber test is the red driver). The clobber test is the gate.

- [ ] **Step 3: Add the match scripts**

Add near the other script consts in `redis.rs`:

```rust
// Write the match HASH atomically with its 6h TTL. Core fields are always present; tunnel_id
// and checkpoint are written only when non-empty (sentinel '' means "skip"). The checkpoint is
// stored verbatim (opaque JSON) and its nonce kept as a plain integer field, so no balance is
// ever cjson-round-tripped. KEYS[1]=match:<id>
// ARGV: 1=game 2=seat_a 3=seat_b 4=conn_a 5=conn_b 6=tunnel_id|'' 7=checkpoint|'' 8=nonce|'' 9=ttl
const PUT_MATCH: &str = r#"
redis.call('HSET', KEYS[1], 'game', ARGV[1], 'seat_a', ARGV[2], 'seat_b', ARGV[3], 'conn_a', ARGV[4], 'conn_b', ARGV[5])
if ARGV[6] ~= '' then redis.call('HSET', KEYS[1], 'tunnel_id', ARGV[6]) end
if ARGV[7] ~= '' then redis.call('HSET', KEYS[1], 'latest_checkpoint', ARGV[7], 'checkpoint_nonce', ARGV[8]) end
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[9]))
return 1
"#;

// Monotonic checkpoint CAS: store the new checkpoint (verbatim) only if its nonce >= the stored
// one. Compares integers; never decodes the checkpoint body, so balances stay byte-exact.
// KEYS[1]=match:<id>  ARGV[1]=nonce  ARGV[2]=checkpoint json  ARGV[3]=ttl
const RECORD_CHECKPOINT: &str = r#"
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
local cur = redis.call('HGET', KEYS[1], 'checkpoint_nonce')
if cur and tonumber(ARGV[1]) < tonumber(cur) then return 0 end
redis.call('HSET', KEYS[1], 'latest_checkpoint', ARGV[2], 'checkpoint_nonce', ARGV[1])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return 1
"#;
```

- [ ] **Step 4: Add a `MATCH_TTL` const and rewrite `put_match`**

Near `SESSION_TTL` at `redis.rs:18`, add:

```rust
const MATCH_TTL: i64 = 6 * 3600;
```

Replace `put_match` (`:471-485`) with:

```rust
    async fn put_match(&self, match_id: &str, m: crate::mp::MatchRecord) {
        let (cp_json, cp_nonce) = match &m.latest_checkpoint {
            Some(cp) => (serde_json::to_string(cp).unwrap(), cp.nonce.to_string()),
            None => (String::new(), String::new()),
        };
        let res: Result<i64, _> = self
            .pool
            .eval(
                PUT_MATCH,
                vec![format!("match:{match_id}")],
                vec![
                    m.game,
                    m.seat_a,
                    m.seat_b,
                    serde_json::to_string(&m.conn_a).unwrap(),
                    serde_json::to_string(&m.conn_b).unwrap(),
                    m.tunnel_id.unwrap_or_default(),
                    cp_json,
                    cp_nonce,
                    MATCH_TTL.to_string(),
                ],
            )
            .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis put_match eval failed");
        }
    }
```

- [ ] **Step 5: Rewrite `get_match` to read the HASH**

Replace `get_match` (`:487-495`) with:

```rust
    async fn get_match(&self, match_id: &str) -> Option<crate::mp::MatchRecord> {
        let h: HashMap<String, String> = self
            .pool
            .hgetall(format!("match:{match_id}"))
            .await
            .ok()?;
        if h.is_empty() {
            return None;
        }
        Some(crate::mp::MatchRecord {
            game: h.get("game")?.clone(),
            seat_a: h.get("seat_a")?.clone(),
            seat_b: h.get("seat_b")?.clone(),
            conn_a: serde_json::from_str(h.get("conn_a")?).ok()?,
            conn_b: serde_json::from_str(h.get("conn_b")?).ok()?,
            tunnel_id: h.get("tunnel_id").cloned(),
            latest_checkpoint: h
                .get("latest_checkpoint")
                .and_then(|s| serde_json::from_str(s).ok()),
        })
    }
```

- [ ] **Step 6: Rewrite `set_tunnel_id` and `record_checkpoint`**

Replace `set_tunnel_id` + `record_checkpoint` (`:497-514`) with:

```rust
    async fn set_tunnel_id(&self, match_id: &str, tunnel_id: &str) {
        // Independent field write — cannot clobber the checkpoint. Refresh the TTL.
        let key = format!("match:{match_id}");
        let res: Result<i64, _> = self.pool.hset(&key, ("tunnel_id", tunnel_id)).await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis set_tunnel_id hset failed");
            return;
        }
        // fred 9.4: `expire(key, seconds)` is 2-arg (returns 1 on success). Refresh the 6h TTL.
        let _: Result<i64, _> = self.pool.expire(&key, MATCH_TTL).await;
    }

    async fn record_checkpoint(&self, match_id: &str, cp: crate::mp::Checkpoint) {
        let res: Result<i64, _> = self
            .pool
            .eval(
                RECORD_CHECKPOINT,
                vec![format!("match:{match_id}")],
                vec![
                    cp.nonce.to_string(),
                    serde_json::to_string(&cp).unwrap(),
                    MATCH_TTL.to_string(),
                ],
            )
            .await;
        if let Err(e) = res {
            tracing::warn!(error = %e, "redis record_checkpoint eval failed");
        }
    }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `TEST_REDIS_URL=redis://localhost:6379 cargo test -p tunnel-manager match_record_round_trips_through_hash tunnel_id_and_checkpoint_writes_do_not_clobber record_checkpoint_keeps_highest_nonce_redis -- --ignored --test-threads=1`
Expected: PASS — both fields survive the race; the 2^53+1 balance is byte-exact; stale nonce ignored.

- [ ] **Step 8: Run the memory parity test**

Run: `cargo test -p tunnel-manager record_checkpoint_keeps_highest_nonce`
Expected: PASS (memory impl unchanged).

- [ ] **Step 9: Commit**

```bash
git add backend/tunnel-manager/src/store/redis.rs
git commit -m "refactor(store): store match as a redis hash"
```

---

### Task 5: F5 — self-cleaning recent-events dedup

`events:seen` is a SET that's never pruned → slow unbounded growth. Replace the membership check with a per-digest key carrying a TTL, so the dedup window self-expires. Keep it inside the existing atomic `PUSH_RECENT_EVENT` script.

**Files:**

- Modify: `backend/tunnel-manager/src/store/redis.rs` (`PUSH_RECENT_EVENT` const `:32-54`; the `eval` call in `push_recent_event` `:208-225`)
- Add: `SEEN_TTL` const near `:18`
- Test: `backend/tunnel-manager/src/store/redis.rs` (new ignored test; existing `recent_events_ring_dedupes_and_caps` stays green)

**Interfaces:**

- Consumes: nothing new.
- Produces: `push_recent_event` signature unchanged. On-disk: dedup is now per-digest keys `events:seen:<digest>` with a TTL (no `events:seen` SET).

- [ ] **Step 1: Write the failing test**

Add to `mod tests` in `redis.rs`:

```rust
#[tokio::test]
#[ignore = "requires TEST_REDIS_URL"]
async fn recent_events_dedup_key_is_per_digest_with_ttl() {
    let Some(url) = test_url() else { return };
    let pool = connect(&url).await.unwrap();
    let s = RedisControlStore::new(pool.clone());
    let digest = format!("d{}", uuid::Uuid::new_v4().simple());
    let ev = crate::state::TunnelEvent {
        tunnel_id: "0xt".into(),
        kind: crate::state::TunnelEventKind::Settled,
        party_a_balance: Some(1),
        party_b_balance: Some(1),
        transcript_root: None,
        tx_digest: digest.clone(),
        timestamp_ms: 1,
        proof_url: None,
    };
    s.push_recent_event(ev).await;
    // Dedup is tracked by a per-digest key that carries a positive TTL (self-cleaning).
    let ttl: i64 = pool.ttl(format!("events:seen:{digest}")).await.unwrap_or(-2);
    assert!(ttl > 0, "per-digest dedup key must have a TTL, got {ttl}");
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `TEST_REDIS_URL=redis://localhost:6379 cargo test -p tunnel-manager recent_events_dedup_key_is_per_digest_with_ttl -- --ignored`
Expected: FAIL (`ttl == -2`, key absent) — dedup currently lives in the `events:seen` SET.

- [ ] **Step 3: Add the TTL const**

Near `SESSION_TTL` at `redis.rs:18`, add:

```rust
// Dedup horizon for recent-events: must exceed the indexer's worst-case cursor-replay window.
const SEEN_TTL: i64 = 24 * 3600;
```

- [ ] **Step 4: Rewrite the script to use a per-digest TTL key**

Replace `PUSH_RECENT_EVENT` (`:32-54`) with (note `KEYS[2]` is now the per-digest key, and `ARGV[4]` is the TTL):

```rust
const PUSH_RECENT_EVENT: &str = r#"
if redis.call('SET', KEYS[2], '1', 'NX', 'EX', tonumber(ARGV[4])) then
  redis.call('LPUSH', KEYS[1], ARGV[1])
  redis.call('LTRIM', KEYS[1], 0, tonumber(ARGV[3]) - 1)
  return 1
end
local incoming = cjson.decode(ARGV[1])
if incoming.proofUrl == nil or incoming.proofUrl == cjson.null then
  return 0
end
local rows = redis.call('LRANGE', KEYS[1], 0, -1)
for i = 1, #rows do
  local row = cjson.decode(rows[i])
  if row.txDigest == ARGV[2] then
    if row.proofUrl == nil or row.proofUrl == cjson.null then
      redis.call('LSET', KEYS[1], i - 1, ARGV[1])
      return 1
    end
    return 0
  end
end
return 0
"#;
```

Also update the doc comment above the const (`:20-31`): replace the "`events:seen` is unbounded but tiny" sentence with: "Dedup is a per-digest `events:seen:<digest>` key with a TTL, so the dedup set self-expires (no unbounded growth)."

- [ ] **Step 5: Update the `eval` call**

In `push_recent_event` (`:208-225`), the `eval` currently passes keys `["events:recent", "events:seen"]` and args `[json, tx_digest, cap]`. Replace the key/arg vectors so `KEYS[2]` is the per-digest key and the TTL is appended:

```rust
            .eval::<i64, _, _, _>(
                PUSH_RECENT_EVENT,
                vec![
                    "events:recent".to_string(),
                    format!("events:seen:{}", ev.tx_digest),
                ],
                vec![
                    json,
                    ev.tx_digest.clone(),
                    crate::store::RECENT_EVENTS_CAP.to_string(),
                    SEEN_TTL.to_string(),
                ],
            )
```

Leave the rest of `push_recent_event` unchanged.

- [ ] **Step 6: Run the new test and the dedup regression**

Run: `TEST_REDIS_URL=redis://localhost:6379 cargo test -p tunnel-manager recent_events_dedup_key_is_per_digest_with_ttl recent_events_ring_dedupes_and_caps recent_events_proof_url_survives_race_either_order -- --ignored --test-threads=1`
Expected: PASS — TTL key present; dedup + cap still hold; proofUrl upgrade still works.

- [ ] **Step 7: Commit**

```bash
git add backend/tunnel-manager/src/store/redis.rs
git commit -m "fix(store): self-cleaning recent-events dedup"
```

---

### Task 6: Flush the action counter on shutdown

`shutdown_signal()` returns and the runtime drops the flusher, losing the last ≤1s of counted moves even on a clean SIGTERM rollout. Extract the flush body into a reusable async fn and call it once on shutdown. Keeps at-most-once semantics (no retries).

**Files:**

- Modify: `backend/tunnel-manager/src/main.rs:113-126` (`spawn_action_flusher`), `:88` (startup), and the shutdown path around `:107-110`/`:128-147`
- Test: `backend/tunnel-manager/src/main.rs` (new unit test on the extracted fn) — or co-locate in `stats_counter.rs` if `main.rs` has no test module

**Interfaces:**

- Consumes: `state.actions: LocalActionCounter` (has `drain_deltas() -> Vec<(String, u64)>`), `state.control: Arc<dyn ControlStore>` (has `add_actions(&str, u64)`).
- Produces: `async fn flush_actions(state: &SharedState)` — drains the per-game deltas once and pushes them to the control store. Idempotent across calls (the watermark means a second call with no new moves is a no-op).

- [ ] **Step 1: Write the failing test**

Add a test module at the bottom of `main.rs` (or extend an existing one). It builds an in-memory-backed `SharedState`, increments the counter, flushes, and asserts the snapshot reflects it and a second flush is a no-op:

```rust
#[cfg(test)]
mod flush_tests {
    use super::*;

    #[tokio::test]
    async fn flush_actions_drains_counter_into_control_store() {
        let state = crate::state::SharedState::in_memory_for_test();
        state.actions.incr("ttt", 3);
        state.actions.incr("ttt", 2);
        flush_actions(&state).await;
        assert_eq!(state.control.snapshot().await.per_game["ttt"].total_actions, 5);
        // Nothing new since the last drain → a second flush adds nothing.
        flush_actions(&state).await;
        assert_eq!(state.control.snapshot().await.per_game["ttt"].total_actions, 5);
    }
}
```

If `SharedState::in_memory_for_test()` does not exist, add it next to `SharedState` in `state.rs` as a test-only constructor that wires `InMemoryControlStore`, `InMemoryMpStore`, and `LocalBus` (mirror how `main.rs` builds the in-memory variant; gate with `#[cfg(any(test, feature = "test-util"))]`). Check `state.rs` for an existing test constructor first and reuse it.

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test -p tunnel-manager flush_actions_drains_counter_into_control_store`
Expected: FAIL to compile — `flush_actions` does not exist yet.

- [ ] **Step 3: Extract `flush_actions` and reuse it in the spawned flusher**

Replace `spawn_action_flusher` (`main.rs:113-126`) with:

```rust
/// Drain the per-instance move counter into ControlStore once. At-most-once by design: deltas
/// are advanced at drain time, so a failed push loses ≤1 interval of display counts and never
/// double-counts. Used both by the 1 Hz flusher and the shutdown drain.
async fn flush_actions(state: &SharedState) {
    for (game, delta) in state.actions.drain_deltas() {
        state.control.add_actions(&game, delta).await;
    }
}

/// Drain the per-instance move counter into ControlStore once per second (no Redis round trip
/// per move). Lossy-by-design on crash: ≤1s of display counts.
fn spawn_action_flusher(state: SharedState) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(1));
        loop {
            tick.tick().await;
            flush_actions(&state).await;
        }
    });
}
```

- [ ] **Step 4: Drain once on shutdown**

The server is started with `.with_graceful_shutdown(shutdown_signal())` at `main.rs:107-109`. After `axum::serve(...).await?` returns (i.e. graceful shutdown completed), add a final flush before `Ok(())`. Change the tail of `run`/`main` (around `:107-110`) to:

```rust
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    // Graceful shutdown completed: push the last sub-second of counted moves so a clean
    // rollout doesn't drop them (the 1 Hz flusher is gone with the runtime by now).
    flush_actions(&state).await;
    Ok(())
```

Note: `state` is moved into the axum app via `.with_state(state)` at `main.rs:103`. Clone it before that call (`let flush_state = state.clone();`) and use `flush_state` for both `spawn_action_flusher(flush_state.clone())` and the final `flush_actions(&flush_state).await`. Verify the exact variable wiring in `main.rs:80-110` and adjust names to match.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cargo test -p tunnel-manager flush_actions_drains_counter_into_control_store`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/tunnel-manager/src/main.rs backend/tunnel-manager/src/state.rs
git commit -m "fix(stats): flush action counter on shutdown"
```

---

### Task 7: Document the aggregation invariant and fix ADR drift

Record _why_ the design is correct (so no one "fixes" the at-most-once counter into a double-counter) and reconcile ADR-0009 with the code.

**Files:**

- Modify: `backend/tunnel-manager/src/store/mod.rs` (doc comments on `ControlStore`/`MpStore`)
- Modify: `backend/tunnel-manager/src/stats_counter.rs:1-5` (tighten the loss-semantics comment)
- Modify: `docs/decisions/0009-data-plane-local-control-plane-redis.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Add the aggregation invariant to the store trait docs**

At the top of `store/mod.rs` (after the module doc at `:1-2`), add:

```rust
//! ## Aggregation invariant
//! Each instance pushes only its own deltas into a merge-commutative primitive; no method
//! read-modify-writes a shared aggregate. Three shapes: counts → `INCRBY` (grow-only,
//! order-independent); membership → `SADD`/`SREM` (idempotent union); owned/last-writer →
//! single key + CAS (Lua), never summed. The move counter is at-most-once (undercount-safe):
//! it only ever pushes already-counted deltas, so it never inflates — do NOT add flush
//! retries, which would make it at-least-once and double-count.
```

- [ ] **Step 2: Tighten the counter comment**

In `stats_counter.rs:1-5`, replace "At-most-once on a crash (lose ≤1 flush interval ...)" wording so it states the real scope: a failed flush (crash _or_ a Redis error) drops that interval's delta permanently because the watermark already advanced; this is deliberate (undercount-safe), and a final drain runs on graceful shutdown (see `flush_actions`).

```rust
//! At-most-once: `drain_deltas` advances the watermark before the push, so a failed flush
//! (crash OR a Redis error) drops that interval's delta — never double-counts. Undercount-safe
//! by design for display stats. A graceful shutdown runs one final flush (`flush_actions`).
```

- [ ] **Step 3: Add an "Aggregation correctness" subsection to ADR-0009**

In `docs/decisions/0009-data-plane-local-control-plane-redis.md`, under the `## Consequences` section, add a bullet referencing the merge-primitive principle and the at-most-once trade (one short paragraph, citing the store-layer hardening in this work / the spec at `docs/superpowers/specs/2026-06-21-control-plane-aggregation-correctness-design.md`).

- [ ] **Step 4: Strike the `owner_instance_id` drift**

In ADR-0009's Decision table, the `Match record + owner instance` row claims `match:<id>` includes `owner_instance_id`. The code has no such field — ownership is implicit in the two `ConnRef.instance_id`s. Edit that row to say ownership is implicit in the seat ConnRefs, and note that an explicit `owner_instance_id` is deferred to the resume/affinity ADR if re-homing needs it.

- [ ] **Step 5: Verify the docs build / no broken links**

Run: `cargo build -p tunnel-manager` (confirms the doc-comment edits compile)
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/tunnel-manager/src/store/mod.rs backend/tunnel-manager/src/stats_counter.rs docs/decisions/0009-data-plane-local-control-plane-redis.md
git commit -m "docs(store): record aggregation invariant"
```

---

## Final verification

- [ ] **Fast suite green:** `cargo test -p tunnel-manager` (all non-ignored pass)
- [ ] **Redis suite green:** `docker run --rm -p 6379:6379 redis:7` then
      `TEST_REDIS_URL=redis://localhost:6379 cargo test -p tunnel-manager -- --ignored --test-threads=1`
- [ ] **Lint/format:** `cargo clippy -p tunnel-manager --all-targets` and `cargo fmt --check`
- [ ] **Hot path untouched:** `git diff main -- backend/tunnel-manager/src/mp/ws.rs` is empty (except any unrelated pre-existing changes).

## Self-review notes (spec coverage)

- F1 → Task 4; F2 → Task 2; F3 → Task 3; F4 → Task 1; F5 → Task 5; shutdown flush → Task 6; "Keep as-is" + ADR drift + invariant docs → Task 7.
- Rollout/compat is a deploy-time action (flag-day), captured in Global Constraints; no code task.
- Out-of-scope items (hot-path micro-opts, out-of-order tunnel events, put_session over-count) intentionally have no task.
