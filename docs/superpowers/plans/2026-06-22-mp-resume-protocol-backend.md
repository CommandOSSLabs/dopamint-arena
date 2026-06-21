# MP Resume Protocol — Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a dropped player reconnect (to any instance) and re-attach to their in-flight match — by atomically rebinding the seat's `ConnRef`, notifying the peer, and invalidating the peer's relay cache — without adding a single Redis or on-chain op to the per-move hot path.

**Architecture:** All server-side. A new atomic `rebind_match_conn` store primitive rebinds a seat's `ConnRef` in the match HASH. Four new wire messages (`resume`, `resume.ok`, `peer.resumed`, `peer.dropped`) carry the control flow. The peer's *backend* relay cache (the per-connection `matches` map in `handle_socket`) is invalidated via a new bus **eviction** path — a parallel per-connection control channel that routes an evict signal locally or cross-instance, leaving the hot-path client channel untouched. Live game-state reconciliation is client-side and is the **frontend follow-up plan**, not this one.

**Tech Stack:** Rust, `tokio`, `async-trait`, `fred` 9.x (Redis), `serde_json`. Tests via `cargo test` (`#[ignore]` Redis integration tests need `TEST_REDIS_URL`).

## Global Constraints

- **Redis-only; no new storage backends** (ADR-0005/0009).
- **Memory and Redis store impls stay behaviorally identical.** Every store-trait method gives the same observable result in both; tests assert parity.
- **New Lua scripts are O(1).** No loops/`LRANGE` over unbounded data. `rebind_match_conn`'s Lua is `HGET`×2 + `HSET` + `EXPIRE` only.
- **Never `cjson` a checkpoint balance** (carried over from ADR discipline). N/A here — `ConnRef` carries no numbers — but do not introduce any `cjson` of a value holding `party_*_balance`.
- **Per-move hot path stays Redis-free and on-chain-free.** `relay_to_other` logic is unchanged. The bus eviction path must NOT add any per-move work to the client delivery channel.
- **Reuse the existing `Connect` auth** (ed25519 over the server nonce, `mp/auth.rs`). Resume authorization is the seat-ownership check inside `rebind_match_conn` — no new crypto, no new token.
- **The 60s grace window is a frontend UX timer, not backend state.** The server NEVER unilaterally ends a match. This plan adds no grace-window timer, no abandonment logic; on-chain `timeout_ms` (per-tunnel, ≥ the 1-minute `MIN_TIMEOUT_DELTA_MS`) governs contestability.
- **Wire shapes follow the existing dotted-`type`, camelCase convention.** A rename is an FE integration break — the `protocol.rs` round-trip tests are the guard.
- **Conventional Commits, imperative, ≤50-char subject, no AI attribution.** One logical change per commit.
- **MATCH_TTL** already exists in `store/redis.rs` (6h). Rebind refreshes it.

**Running tests:**
- Fast (memory + pure): `cargo test -p tunnel-manager`
- Redis integration: `docker run --rm -p 6379:6379 redis:7`, then
  `TEST_REDIS_URL=redis://localhost:6379 cargo test -p tunnel-manager -- --ignored --test-threads=1`

**Out of scope (frontend follow-up plan):** the `mpClient` reconnect loop, peer co-signed-state re-send, signature verification, and per-game checkpoint reconciliation (highest both-signed nonce wins). This plan establishes and tests the *server wire contract and mechanics* those will consume.

---

### Task 1: `Seat` type + atomic `rebind_match_conn` store primitive

The foundation: rebind one seat's `ConnRef` in the match record atomically, authorized by seat ownership, identical in both store impls.

**Files:**
- Modify: `backend/tunnel-manager/src/mp/mod.rs` (add `Seat` enum near `MatchRecord`)
- Modify: `backend/tunnel-manager/src/store/mod.rs` (add `rebind_match_conn` to the `MpStore` trait)
- Modify: `backend/tunnel-manager/src/store/memory.rs` (impl on the in-memory `MpStore`)
- Modify: `backend/tunnel-manager/src/store/redis.rs` (add `REBIND_MATCH_CONN` const near the other scripts; impl on `RedisMpStore`)
- Test: `backend/tunnel-manager/src/store/memory.rs` (unit), `backend/tunnel-manager/src/store/redis.rs` (ignored integration)

**Interfaces:**
- Consumes: existing `ConnRef`, `MatchRecord`, `MATCH_TTL`.
- Produces: `pub enum Seat { A, B }`; `async fn rebind_match_conn(&self, match_id: &str, wallet: &str, at: ConnRef) -> Option<Seat>` on `MpStore`. Returns `Some(Seat)` for the rebound seat, `None` if the match is absent or `wallet` owns no seat.

- [ ] **Step 1: Add the `Seat` enum**

In `mp/mod.rs`, near `MatchRecord` (`:48`), add:

```rust
/// Which seat of a match a wallet occupies. `A` = seat_a/conn_a, `B` = seat_b/conn_b.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Seat {
    A,
    B,
}

impl Seat {
    /// Wire form matching the FE `Role` ("A" | "B").
    pub fn as_role(self) -> &'static str {
        match self {
            Seat::A => "A",
            Seat::B => "B",
        }
    }
}
```

- [ ] **Step 2: Add the trait method**

In `store/mod.rs`, inside `pub trait MpStore` (after `record_checkpoint`, `:63`), add:

```rust
    /// Rebind a seat's live connection after a reconnect. Authorized by seat ownership:
    /// rebinds `conn_a` iff `wallet == seat_a`, else `conn_b` iff `wallet == seat_b`, else
    /// no-op. Refreshes the record TTL. Returns the rebound seat, or `None` if the match is
    /// gone or the wallet owns no seat. Atomic (last-writer-wins per seat).
    async fn rebind_match_conn(
        &self,
        match_id: &str,
        wallet: &str,
        at: ConnRef,
    ) -> Option<crate::mp::Seat>;
```

- [ ] **Step 3: Write the failing memory-impl unit test**

In `store/memory.rs` `mod tests`, add (`InMemoryMpStore` derives `Default`; its `matches` field is `RwLock<HashMap<String, MatchRecord>>`):

```rust
#[tokio::test]
async fn rebind_match_conn_rebinds_owning_seat_and_noops_otherwise() {
    let s = InMemoryMpStore::default();
    let mid = "m-rebind";
    let cr = |id: &str| ConnRef { instance_id: id.into(), conn_id: uuid::Uuid::new_v4() };
    s.put_match(mid, crate::mp::MatchRecord {
        game: "ttt".into(), seat_a: "0xa".into(), seat_b: "0xb".into(),
        conn_a: cr("i1"), conn_b: cr("i1"), tunnel_id: None, latest_checkpoint: None,
    }).await;
    // Wrong wallet → None, nothing changes.
    assert_eq!(s.rebind_match_conn(mid, "0xstranger", cr("i9")).await, None);
    // Seat A owner rebinds conn_a only.
    let new_a = cr("i2");
    assert_eq!(s.rebind_match_conn(mid, "0xa", new_a.clone()).await, Some(crate::mp::Seat::A));
    let got = s.get_match(mid).await.unwrap();
    assert_eq!(got.conn_a.instance_id, new_a.instance_id);
    assert_eq!(got.conn_a.conn_id, new_a.conn_id);
    // Seat B owner rebinds conn_b only.
    assert_eq!(s.rebind_match_conn(mid, "0xb", cr("i3")).await, Some(crate::mp::Seat::B));
    // Absent match → None.
    assert_eq!(s.rebind_match_conn("nope", "0xa", cr("i4")).await, None);
}
```


- [ ] **Step 4: Run it to verify it fails**

Run: `cargo test -p tunnel-manager rebind_match_conn_rebinds_owning_seat_and_noops_otherwise`
Expected: FAIL to compile — `rebind_match_conn` not implemented for the in-memory store.

- [ ] **Step 5: Implement the memory impl**

In `store/memory.rs`, in `impl MpStore for InMemoryMpStore` (next to `record_checkpoint`), add:

```rust
    async fn rebind_match_conn(
        &self,
        match_id: &str,
        wallet: &str,
        at: ConnRef,
    ) -> Option<crate::mp::Seat> {
        let mut matches = self.matches.write().unwrap();
        let m = matches.get_mut(match_id)?;
        if m.seat_a == wallet {
            m.conn_a = at;
            Some(crate::mp::Seat::A)
        } else if m.seat_b == wallet {
            m.conn_b = at;
            Some(crate::mp::Seat::B)
        } else {
            None
        }
    }
```

- [ ] **Step 6: Run the unit test to verify it passes**

Run: `cargo test -p tunnel-manager rebind_match_conn_rebinds_owning_seat_and_noops_otherwise`
Expected: PASS.

- [ ] **Step 7: Add the Redis Lua script**

In `store/redis.rs`, near the other script consts (after `RECORD_CHECKPOINT`), add:

```rust
// Rebind a seat's ConnRef, authorized by seat ownership, and refresh the TTL. Returns 'a'/'b'
// for the rebound seat, or false if the match is gone / the wallet owns no seat. O(1): two
// HGETs + one HSET + EXPIRE, no loops, no cjson (ConnRef carries no numeric balance).
// KEYS[1]=match:<id>  ARGV[1]=wallet  ARGV[2]=ConnRef json  ARGV[3]=ttl
const REBIND_MATCH_CONN: &str = r#"
local sa = redis.call('HGET', KEYS[1], 'seat_a')
if not sa then return false end
if sa == ARGV[1] then
  redis.call('HSET', KEYS[1], 'conn_a', ARGV[2])
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
  return 'a'
end
local sb = redis.call('HGET', KEYS[1], 'seat_b')
if sb == ARGV[1] then
  redis.call('HSET', KEYS[1], 'conn_b', ARGV[2])
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
  return 'b'
end
return false
"#;
```

- [ ] **Step 8: Implement the Redis impl**

In `store/redis.rs`, in `impl MpStore for RedisMpStore` (next to `record_checkpoint`), add:

```rust
    async fn rebind_match_conn(
        &self,
        match_id: &str,
        wallet: &str,
        at: ConnRef,
    ) -> Option<crate::mp::Seat> {
        let res: Result<Option<String>, _> = self
            .pool
            .eval(
                REBIND_MATCH_CONN,
                vec![format!("match:{match_id}")],
                vec![
                    wallet.to_owned(),
                    serde_json::to_string(&at).unwrap(),
                    MATCH_TTL.to_string(),
                ],
            )
            .await;
        match res {
            Ok(Some(s)) if s == "a" => Some(crate::mp::Seat::A),
            Ok(Some(s)) if s == "b" => Some(crate::mp::Seat::B),
            Ok(_) => None,
            Err(e) => {
                tracing::warn!(error = %e, "redis rebind_match_conn eval failed");
                None
            }
        }
    }
```

- [ ] **Step 9: Write the failing Redis integration test**

In `store/redis.rs` `mod tests`, add (reuse the existing `test_url`, `connect`, `sample_match`, `RedisMpStore::new` helpers):

```rust
#[tokio::test]
#[ignore = "requires TEST_REDIS_URL"]
async fn rebind_match_conn_rebinds_seat_and_rejects_non_owner() {
    let Some(url) = test_url() else { return };
    let s = RedisMpStore::new(connect(&url).await.unwrap());
    let mid = format!("m{}", uuid::Uuid::new_v4().simple());
    s.put_match(&mid, sample_match()).await; // seat_a="0xa", seat_b="0xb"
    let new = ConnRef { instance_id: "i2".into(), conn_id: uuid::Uuid::new_v4() };
    // Non-owner → None, no change.
    assert_eq!(s.rebind_match_conn(&mid, "0xstranger", new.clone()).await, None);
    // Seat A owner rebinds conn_a; conn_b untouched.
    let before = s.get_match(&mid).await.unwrap();
    assert_eq!(s.rebind_match_conn(&mid, "0xa", new.clone()).await, Some(crate::mp::Seat::A));
    let after = s.get_match(&mid).await.unwrap();
    assert_eq!(after.conn_a.conn_id, new.conn_id, "conn_a rebound");
    assert_eq!(after.conn_b.conn_id, before.conn_b.conn_id, "conn_b untouched");
    // Absent match → None (EXISTS-guarded by seat_a presence).
    let gone = format!("m{}", uuid::Uuid::new_v4().simple());
    assert_eq!(s.rebind_match_conn(&gone, "0xa", new).await, None);
}
```

- [ ] **Step 10: Run both tests (fast + Redis)**

Run: `cargo test -p tunnel-manager rebind_match_conn`
Run: `TEST_REDIS_URL=redis://localhost:6379 cargo test -p tunnel-manager rebind_match_conn_rebinds_seat_and_rejects_non_owner -- --ignored`
Expected: both PASS.

- [ ] **Step 11: Lint + commit**

Run: `cargo fmt && cargo clippy -p tunnel-manager --all-targets`
```bash
git add backend/tunnel-manager/src/mp/mod.rs backend/tunnel-manager/src/store/mod.rs backend/tunnel-manager/src/store/memory.rs backend/tunnel-manager/src/store/redis.rs
git commit -m "feat(store): add atomic rebind_match_conn"
```

---

### Task 2: Resume protocol wire messages

Add the four messages and lock their exact wire shapes with round-trip tests (the FE contract).

**Files:**
- Modify: `backend/tunnel-manager/src/mp/protocol.rs` (add one `ClientMsg` + three `ServerMsg` variants; add round-trip tests)

**Interfaces:**
- Consumes: nothing new.
- Produces: `ClientMsg::Resume { match_id }`; `ServerMsg::ResumeOk { match_id, role, opponent_wallet, game, peer_online }`, `ServerMsg::PeerResumed { match_id, seat, conn_ref }`, `ServerMsg::PeerDropped { match_id }`. `conn_ref` serializes the existing `ConnRef`.

- [ ] **Step 1: Write the failing round-trip tests**

In `protocol.rs` `mod tests`, add:

```rust
#[test]
fn client_resume_deserializes_dotted_name() {
    let m: ClientMsg = serde_json::from_str(r#"{"type":"resume","matchId":"m1"}"#).unwrap();
    assert_eq!(m, ClientMsg::Resume { match_id: "m1".into() });
}

#[test]
fn server_resume_ok_serializes_with_dotted_camelcase() {
    let s = ServerMsg::ResumeOk {
        match_id: "m1".into(), role: "A".into(),
        opponent_wallet: "0xb".into(), game: "ttt".into(), peer_online: true,
    }.to_text();
    assert!(s.contains(r#""type":"resume.ok""#));
    assert!(s.contains(r#""matchId":"m1""#));
    assert!(s.contains(r#""opponentWallet":"0xb""#));
    assert!(s.contains(r#""peerOnline":true"#));
}

#[test]
fn server_peer_dropped_and_resumed_serialize() {
    assert!(ServerMsg::PeerDropped { match_id: "m1".into() }
        .to_text().contains(r#""type":"peer.dropped""#));
    let pr = ServerMsg::PeerResumed {
        match_id: "m1".into(), seat: "B".into(),
        conn_ref: crate::store::ConnRef { instance_id: "i2".into(), conn_id: uuid::Uuid::nil() },
    }.to_text();
    assert!(pr.contains(r#""type":"peer.resumed""#));
    assert!(pr.contains(r#""seat":"B""#));
    assert!(pr.contains(r#""connRef""#));
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cargo test -p tunnel-manager -- protocol`
Expected: FAIL to compile — the variants don't exist.

- [ ] **Step 3: Add the `ClientMsg::Resume` variant**

In `protocol.rs`, inside `enum ClientMsg`, after `WatchtowerCheckpoint`, add:

```rust
    /// Re-attach to an existing match after a reconnect. Valid only after `Connect`.
    /// Authorization is the seat-ownership check server-side.
    #[serde(rename = "resume")]
    Resume { match_id: String },
```

- [ ] **Step 4: Add the three `ServerMsg` variants**

In `protocol.rs`, inside `enum ServerMsg`, after `Relay`, add:

```rust
    /// Re-attach confirmed. `peer_online` reflects whether the opponent currently has a live
    /// socket (from presence), so the client knows whether to expect a peer state re-send.
    #[serde(rename = "resume.ok")]
    ResumeOk {
        match_id: String,
        role: String,
        opponent_wallet: String,
        game: String,
        peer_online: bool,
    },
    /// Sent to the opponent when a seat reconnects: carries the new `ConnRef` so the FE can
    /// re-send its latest co-signed state. (Backend relay-cache invalidation is separate — the
    /// bus eviction path, Task 4.)
    #[serde(rename = "peer.resumed")]
    PeerResumed {
        match_id: String,
        seat: String,
        conn_ref: crate::store::ConnRef,
    },
    /// Sent to the still-present seat when the opponent's socket drops, so the FE can start its
    /// 60s grace timer.
    #[serde(rename = "peer.dropped")]
    PeerDropped { match_id: String },
```

Note: `ConnRef` already derives `Serialize`; `ServerMsg` derives `Serialize`. If the compiler complains `ServerMsg` needs `PartialEq` for an existing test, `ConnRef` already derives `PartialEq` so it composes.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p tunnel-manager -- protocol`
Expected: PASS.

- [ ] **Step 6: Lint + commit**

Run: `cargo fmt && cargo clippy -p tunnel-manager --all-targets`
```bash
git add backend/tunnel-manager/src/mp/protocol.rs
git commit -m "feat(mp): add resume protocol messages"
```

---

### Task 3: Bus eviction path (peer relay-cache invalidation)

Give the bus a way to tell a peer's *connection task* to drop a match from its relay cache, routed locally or cross-instance — without touching the hot-path client channel. A parallel per-connection **control** channel carries match-ids to evict; the connection loop drains it and removes the entry, so the next relay re-reads the match once (rare, post-resume) and picks up the rebound `ConnRef`.

**Files:**
- Modify: `backend/tunnel-manager/src/store/mod.rs` (`Bus` trait: `register` gains a ctrl sender; add `evict`)
- Modify: `backend/tunnel-manager/src/store/memory.rs` (`LocalBus`: ctrl map, `evict`)
- Modify: `backend/tunnel-manager/src/store/redis.rs` (`RedisBus`: ctrl map, `evict`, `WireMsg` enum, subscriber routing)
- Modify: `backend/tunnel-manager/src/mp/ws.rs` (`handle_socket`: create ctrl channel, register it, add a `select!` arm that evicts; the test harness at `:517` register call)
- Test: `backend/tunnel-manager/src/store/redis.rs` (ignored), `backend/tunnel-manager/src/mp/ws.rs` (behavioral, if a harness exists)

**Interfaces:**
- Consumes: existing `Bus`, `ConnRef`, the per-connection `matches` cache.
- Produces: `Bus::register(&self, conn, client_tx, ctrl_tx)` (ctrl carries `String` match-ids); `async fn Bus::evict(&self, target: &ConnRef, match_id: &str)`. After `evict`, the target connection removes `match_id` from its relay cache.

- [ ] **Step 1: Extend the `Bus` trait**

In `store/mod.rs`, change `register` and add `evict`:

```rust
#[async_trait]
pub trait Bus: Send + Sync {
    fn instance_id(&self) -> &str;
    /// `client_tx` carries client-bound frames (written to the socket). `ctrl_tx` carries
    /// internal control signals — currently match-ids to evict from the connection's relay
    /// cache. Kept separate so control never competes with or parses the hot-path frame stream.
    fn register(
        &self,
        conn: crate::mp::ConnId,
        client_tx: tokio::sync::mpsc::UnboundedSender<String>,
        ctrl_tx: tokio::sync::mpsc::UnboundedSender<String>,
    );
    fn unregister(&self, conn: crate::mp::ConnId);
    async fn deliver(&self, target: &ConnRef, text: String);
    /// Tell `target`'s connection task to drop `match_id` from its relay cache (so its next
    /// relay re-reads the match and picks up a rebound peer `ConnRef`). Routes locally or via
    /// the cross-instance pub/sub channel. No-op if the target is unknown.
    async fn evict(&self, target: &ConnRef, match_id: &str);
}
```

- [ ] **Step 2: Update `LocalBus`**

In `store/memory.rs`, add a `ctrls` map and impl the new signature + `evict`:

```rust
pub struct LocalBus {
    instance_id: String,
    conns: RwLock<HashMap<ConnId, mpsc::UnboundedSender<String>>>,
    ctrls: RwLock<HashMap<ConnId, mpsc::UnboundedSender<String>>>,
}
```
Update `LocalBus::new` to init `ctrls: RwLock::new(HashMap::new())`. Then in `impl Bus for LocalBus`:

```rust
    fn register(
        &self,
        conn: ConnId,
        client_tx: mpsc::UnboundedSender<String>,
        ctrl_tx: mpsc::UnboundedSender<String>,
    ) {
        self.conns.write().unwrap().insert(conn, client_tx);
        self.ctrls.write().unwrap().insert(conn, ctrl_tx);
    }

    fn unregister(&self, conn: ConnId) {
        self.conns.write().unwrap().remove(&conn);
        self.ctrls.write().unwrap().remove(&conn);
    }

    async fn evict(&self, target: &ConnRef, match_id: &str) {
        let tx = self.ctrls.read().unwrap().get(&target.conn_id).cloned();
        if let Some(tx) = tx {
            let _ = tx.send(match_id.to_owned());
        }
    }
```
Leave `deliver` unchanged.

- [ ] **Step 3: Update `RedisBus` — fields, register/unregister, WireMsg**

In `store/redis.rs`, replace the `Wire` struct with a tagged enum that carries both frame delivery and eviction:

```rust
// Cross-instance pub/sub payload. `Frame` is a client-bound relay frame; `Evict` tells a
// connection task to drop a match from its relay cache. Retagged from the old flat
// `{conn,text}` — internal to the bus, deployed together. A rolling deploy may drop a few
// cross-instance frames mid-rollout (pubsub is a soft dependency, ADR-0005); accepted.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(tag = "k")]
enum WireMsg {
    Frame { conn: ConnId, text: String },
    Evict { conn: ConnId, match_id: String },
}
```

Add a `ctrls` field to `RedisBus` alongside `conns`:

```rust
    ctrls: std::sync::Arc<RwLock<HashMap<ConnId, mpsc::UnboundedSender<String>>>>,
```
Initialize it in `RedisBus::new` (mirror `conns`: `let ctrls: ... = Default::default();` and `ctrls: ctrls.clone()` … wait — clone the Arc into the subscriber task, store the original in the struct; mirror exactly how `conns`/`conns_arc` is handled). Update `register`/`unregister` to insert/remove both maps with the new two-tx signature (same bodies as `LocalBus`).

- [ ] **Step 4: Update the `RedisBus` subscriber loop to route `WireMsg`**

In `RedisBus::new`, the inbound task currently decodes `Wire` and sends `w.text` to `conns`. Replace the decode/dispatch with:

```rust
                        let Ok(msg) = serde_json::from_str::<WireMsg>(&payload) else {
                            continue;
                        };
                        match msg {
                            WireMsg::Frame { conn, text } => {
                                if let Some(tx) = conns_arc.read().unwrap().get(&conn) {
                                    let _ = tx.send(text);
                                }
                            }
                            WireMsg::Evict { conn, match_id } => {
                                if let Some(tx) = ctrls_arc.read().unwrap().get(&conn) {
                                    let _ = tx.send(match_id);
                                }
                            }
                        }
```
(Clone a `ctrls_arc = ctrls.clone()` into the task alongside `conns_arc`.)

- [ ] **Step 5: Update `RedisBus::deliver` and add `evict`**

`deliver` now serializes `WireMsg::Frame`:

```rust
    async fn deliver(&self, target: &ConnRef, text: String) {
        if target.instance_id == self.instance_id {
            let tx = self.conns.read().unwrap().get(&target.conn_id).cloned();
            if let Some(tx) = tx {
                let _ = tx.send(text);
            }
        } else {
            let wire = serde_json::to_string(&WireMsg::Frame {
                conn: target.conn_id,
                text,
            })
            .expect("WireMsg serializes");
            let channel = format!("mp:inst:{}", target.instance_id);
            let res: Result<i64, _> = self.publisher.next().spublish(channel, wire).await;
            if let Err(e) = res {
                tracing::warn!(error = %e, instance = %target.instance_id, "spublish frame failed");
            }
        }
    }

    async fn evict(&self, target: &ConnRef, match_id: &str) {
        if target.instance_id == self.instance_id {
            let tx = self.ctrls.read().unwrap().get(&target.conn_id).cloned();
            if let Some(tx) = tx {
                let _ = tx.send(match_id.to_owned());
            }
        } else {
            let wire = serde_json::to_string(&WireMsg::Evict {
                conn: target.conn_id,
                match_id: match_id.to_owned(),
            })
            .expect("WireMsg serializes");
            let channel = format!("mp:inst:{}", target.instance_id);
            let res: Result<i64, _> = self.publisher.next().spublish(channel, wire).await;
            if let Err(e) = res {
                tracing::warn!(error = %e, instance = %target.instance_id, "spublish evict failed");
            }
        }
    }
```

- [ ] **Step 6: Wire the ctrl channel into `handle_socket`**

In `ws.rs` `handle_socket` (`:77`), after the client channel (`:80`), add a ctrl channel and register both:

```rust
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let (ctrl_tx, mut ctrl_rx) = mpsc::unbounded_channel::<String>();
```
Find the `state.bus.register(conn_id, tx.clone())` site (inside `handle_message`'s `Connect`, `:195`, and the test harness at `:517`) — update both calls to the new two-arg form `register(conn_id, tx.clone(), ctrl_tx.clone())`. The `ctrl_tx` must be threaded into `handle_message`/`handle_authed` the same way `tx` is (add a `ctrl_tx: &mpsc::UnboundedSender<String>` param), OR register inside `handle_socket` instead — simplest: register in `handle_socket` right after creating the channels is NOT possible (registration happens on `Connect` to gate on auth). Thread `ctrl_tx` through `handle_message` → the `Connect` arm calls `register(conn_id, tx.clone(), ctrl_tx.clone())`. Update the `handle_message` signature and its call site (`:143-152`) accordingly.

Then add a `select!` arm in the loop (`:102`) to drain evictions:

```rust
            evict = ctrl_rx.recv() => {
                match evict {
                    Some(match_id) => { matches.remove(&match_id); }
                    None => {} // ctrl channel never closes before the socket; ignore
                }
            }
```

Also update the test harness `make_conn_ref` (`ws.rs` `mod tests`, ~`:517`) for the new two-tx `register`. It currently does `state.bus.register(conn_id, tx)`; change it to create a ctrl channel too (its receiver is unused by frame-reading tests and may be dropped):

```rust
    fn make_conn_ref(state: &SharedState) -> (ConnId, mpsc::UnboundedReceiver<String>) {
        let conn_id = Uuid::new_v4();
        let (tx, rx) = mpsc::unbounded_channel();
        let (ctrl_tx, _ctrl_rx) = mpsc::unbounded_channel();
        state.bus.register(conn_id, tx, ctrl_tx);
        (conn_id, rx)
    }
```

- [ ] **Step 7: Build + write a failing Redis eviction test**

Run: `cargo build -p tunnel-manager` (fix any signature-threading errors first).

Then in `store/redis.rs` `mod tests`, add a test that `evict` reaches a registered ctrl channel locally:

```rust
#[tokio::test]
#[ignore = "requires TEST_REDIS_URL"]
async fn evict_signals_the_target_ctrl_channel() {
    let Some(url) = test_url() else { return };
    let bus = RedisBus::new("instA".into(), connect(&url).await.unwrap()).await.unwrap();
    let conn = uuid::Uuid::new_v4();
    let (ctx, _crx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let (cctx, mut ccrx) = tokio::sync::mpsc::unbounded_channel::<String>();
    bus.register(conn, ctx, cctx);
    // Same-instance evict routes to the ctrl channel.
    bus.evict(&ConnRef { instance_id: "instA".into(), conn_id: conn }, "m1").await;
    assert_eq!(ccrx.recv().await.as_deref(), Some("m1"));
}
```

- [ ] **Step 8: Run the eviction test + the existing relay tests**

Run: `TEST_REDIS_URL=redis://localhost:6379 cargo test -p tunnel-manager evict_signals_the_target_ctrl_channel -- --ignored`
Run: `cargo test -p tunnel-manager` (the existing `relay_to_other` cache tests at `ws.rs:690+` must stay green — they register a single tx; if they call `register`, update them to pass a dummy ctrl tx).
Expected: PASS. Confirm `relay_to_other` itself is unchanged (only the loop and registration changed).

- [ ] **Step 9: Lint + commit**

Run: `cargo fmt && cargo clippy -p tunnel-manager --all-targets`
```bash
git add backend/tunnel-manager/src/store/mod.rs backend/tunnel-manager/src/store/memory.rs backend/tunnel-manager/src/store/redis.rs backend/tunnel-manager/src/mp/ws.rs
git commit -m "feat(bus): add peer relay-cache eviction path"
```

---

### Task 4: `Resume` handler

Handle `ClientMsg::Resume`: rebind the seat, compute `peer_online` from presence, warm this connection's relay cache, reply `ResumeOk`, deliver `PeerResumed` to the opponent, and `evict` the opponent's stale relay-cache entry.

**Files:**
- Modify: `backend/tunnel-manager/src/mp/ws.rs` (`handle_authed`: add the `ClientMsg::Resume` arm; the arm needs the per-connection `matches` cache and `conn_id`)
- Test: `backend/tunnel-manager/src/mp/ws.rs` (behavioral, using the existing in-file test harness)

**Interfaces:**
- Consumes: `MpStore::rebind_match_conn`, `MpStore::get_match`, `MpStore::get_presence`, `Bus::deliver`, `Bus::evict`, the `matches` cache, `here(state, conn_id)`.
- Produces: server emits `ResumeOk` to the resumer and `PeerResumed` + an evict signal to the opponent. On failure emits `Error("not_a_seat" | "match_gone")`.

- [ ] **Step 1: Write the failing behavioral test**

Use the file's real harness: `test_state()` builds an in-memory `SharedState`; `make_conn_ref(&state) -> (ConnId, UnboundedReceiver<String>)` registers a connection on the bus and returns its frame receiver (you will have updated `make_conn_ref` for the new `register` signature in Task 3). Authed flow is driven by calling `handle_authed(state, conn_id, wallet, &mut joined, &mut matches, msg)` directly. Add to `ws.rs` `mod tests`:

```rust
#[tokio::test]
async fn resume_rebinds_seat_and_acks_with_role() {
    let state = test_state();
    let inst = state.bus.instance_id().to_owned();
    let mid = "m-resume";
    // Resumer (seat A) and opponent (seat B) connections, each with a frame receiver.
    let (conn_a, mut rx_a) = make_conn_ref(&state);
    let (conn_b, mut rx_b) = make_conn_ref(&state);
    let ref_b = ConnRef { instance_id: inst.clone(), conn_id: conn_b };
    // Opponent is "online" (presence set); match has a STALE conn_a to be rebound.
    state.mp.set_presence("0xb", ref_b.clone()).await;
    state.mp.put_match(mid, MatchRecord {
        game: "ttt".into(), seat_a: "0xa".into(), seat_b: "0xb".into(),
        conn_a: ConnRef { instance_id: "old".into(), conn_id: Uuid::new_v4() },
        conn_b: ref_b, tunnel_id: None, latest_checkpoint: None,
    }).await;

    let mut joined = HashSet::new();
    let mut matches = HashMap::new();
    handle_authed(&state, conn_a, "0xa", &mut joined, &mut matches,
        ClientMsg::Resume { match_id: mid.into() }).await.unwrap();

    // Resumer got resume.ok with role A and peerOnline true.
    let a = rx_a.recv().await.unwrap();
    assert!(a.contains(r#""type":"resume.ok""#) && a.contains(r#""role":"A""#)
        && a.contains(r#""peerOnline":true"#), "got: {a}");
    // Opponent got peer.resumed carrying the resumer's new ConnRef.
    let b = rx_b.recv().await.unwrap();
    assert!(b.contains(r#""type":"peer.resumed""#) && b.contains(r#""seat":"A""#), "got: {b}");
    // The store now binds conn_a to the resumer's connection, and the cache is warm.
    assert_eq!(state.mp.get_match(mid).await.unwrap().conn_a.conn_id, conn_a);
    assert!(matches.contains_key(mid), "resumer cache warmed");
}
```

Add a `not_a_seat` case too:

```rust
#[tokio::test]
async fn resume_rejects_non_seat_wallet() {
    let state = test_state();
    let (conn, _rx) = make_conn_ref(&state);
    let cr = |id: &str| ConnRef { instance_id: id.into(), conn_id: Uuid::new_v4() };
    state.mp.put_match("m1", MatchRecord {
        game: "ttt".into(), seat_a: "0xa".into(), seat_b: "0xb".into(),
        conn_a: cr("i"), conn_b: cr("i"), tunnel_id: None, latest_checkpoint: None,
    }).await;
    let mut joined = HashSet::new();
    let mut matches = HashMap::new();
    let r = handle_authed(&state, conn, "0xstranger", &mut joined, &mut matches,
        ClientMsg::Resume { match_id: "m1".into() }).await;
    assert_eq!(r, Err("not_a_seat"));
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test -p tunnel-manager resume_rebinds_seat_and_acks_with_role`
Expected: FAIL — the `Resume` arm doesn't exist (or the helper is missing).

- [ ] **Step 3: Implement the `Resume` arm**

In `ws.rs` `handle_authed` (`:207`), add an arm. **Important:** `handle_authed` has **no `tx` param** — authed arms send frames to a connection via `state.bus.deliver(&conn_ref, text)` (the bus routes to the registered socket), exactly like the `QueueJoin`/`ChallengeAccept` arms deliver `MatchFound`. The resumer's own frames are delivered to its own `ConnRef` (`here(state, conn_id)`). `matches`, `conn_id`, `wallet`, `state` are all in scope.

```rust
        ClientMsg::Resume { match_id } => {
            let me = here(state, conn_id);
            let seat = match state.mp.rebind_match_conn(&match_id, wallet, me.clone()).await {
                Some(s) => s,
                None => return Err("not_a_seat"),
            };
            let Some(rec) = state.mp.get_match(&match_id).await else {
                return Err("match_gone");
            };
            // Warm this connection's relay cache so its first post-resume relay needs no GET.
            matches.insert(match_id.clone(), rec.clone());
            // Opponent seat wallet + ConnRef.
            let (opp_wallet, opp_conn) = match seat {
                crate::mp::Seat::A => (rec.seat_b.clone(), rec.conn_b.clone()),
                crate::mp::Seat::B => (rec.seat_a.clone(), rec.conn_a.clone()),
            };
            let peer_online = state.mp.get_presence(&opp_wallet).await.is_some();
            // ResumeOk to self (delivered via the bus to this connection's socket).
            state
                .bus
                .deliver(
                    &me,
                    ServerMsg::ResumeOk {
                        match_id: match_id.clone(),
                        role: seat.as_role().to_owned(),
                        opponent_wallet: opp_wallet,
                        game: rec.game.clone(),
                        peer_online,
                    }
                    .to_text(),
                )
                .await;
            // Tell the opponent we're back: PeerResumed (FE re-sends state) + evict its stale
            // relay-cache entry so its next relay routes to our new ConnRef.
            state
                .bus
                .deliver(
                    &opp_conn,
                    ServerMsg::PeerResumed {
                        match_id: match_id.clone(),
                        seat: seat.as_role().to_owned(),
                        conn_ref: me,
                    }
                    .to_text(),
                )
                .await;
            state.bus.evict(&opp_conn, &match_id).await;
            Ok(())
        }
```

Note: `as_role()` returns the *resumer's* seat. `PeerResumed.seat` is the resumer's seat (so the opponent knows which seat's `ConnRef` changed). `PeerResumed.conn_ref` is the resumer's new `ConnRef` (`me`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p tunnel-manager resume_rebinds_seat_and_acks_with_role`
Expected: PASS.

- [ ] **Step 5: Run the full fast suite**

Run: `cargo test -p tunnel-manager`
Expected: PASS (no regressions).

- [ ] **Step 6: Lint + commit**

Run: `cargo fmt && cargo clippy -p tunnel-manager --all-targets`
```bash
git add backend/tunnel-manager/src/mp/ws.rs
git commit -m "feat(mp): handle resume re-attach"
```

---

### Task 5: Disconnect `peer.dropped` notice + conn→matches tracking

Notify the still-present seat when an opponent drops, so the FE can start its 60s grace timer. Make it robust (fires even if the dropper never relayed) by populating the per-connection `matches` cache at match creation, then iterating it on disconnect. Zero per-move cost.

**Files:**
- Modify: `backend/tunnel-manager/src/mp/ws.rs` (`handle_authed`: insert the created `MatchRecord` into `matches` at `QueueJoin`/`ChallengeAccept`; extract a `notify_peers_dropped` fn; call it from `handle_socket` on disconnect)
- Test: `backend/tunnel-manager/src/mp/ws.rs` (behavioral)

**Interfaces:**
- Consumes: the per-connection `matches` cache, `Bus::deliver`, `conn_id`.
- Produces: `async fn notify_peers_dropped(state: &SharedState, conn_id: ConnId, matches: &HashMap<String, MatchRecord>)` — for each cached match where `conn_id` is a seat, delivers `PeerDropped{match_id}` to the other seat. Called from `handle_socket` on disconnect.

- [ ] **Step 1: Write the failing test**

Extract the notify routine as a free fn (Step 3) so it is unit-testable without driving a real socket. Add to `ws.rs` `mod tests`, using the real harness:

```rust
#[tokio::test]
async fn disconnect_notifies_the_other_seat() {
    let state = test_state();
    let inst = state.bus.instance_id().to_owned();
    let (conn_a, _rx_a) = make_conn_ref(&state); // the dropper (seat A)
    let (conn_b, mut rx_b) = make_conn_ref(&state); // the opponent (seat B)
    let mid = "m-drop";
    let rec = MatchRecord {
        game: "ttt".into(), seat_a: "0xa".into(), seat_b: "0xb".into(),
        conn_a: ConnRef { instance_id: inst.clone(), conn_id: conn_a },
        conn_b: ConnRef { instance_id: inst.clone(), conn_id: conn_b },
        tunnel_id: None, latest_checkpoint: None,
    };
    // A's per-connection cache holds the match (populated at match creation in real flow).
    let mut matches = HashMap::new();
    matches.insert(mid.to_string(), rec);
    // A disconnects.
    notify_peers_dropped(&state, conn_a, &matches).await;
    let b = rx_b.recv().await.unwrap();
    assert!(b.contains(r#""type":"peer.dropped""#) && b.contains(r#""matchId":"m-drop""#), "got: {b}");
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test -p tunnel-manager disconnect_notifies_the_other_seat`
Expected: FAIL — no `PeerDropped` is emitted.

- [ ] **Step 3: Populate `matches` at match creation**

In `ws.rs` `handle_authed`, at the two match-creation sites, insert the record into the per-connection cache so disconnect can find it. After `build_quick_match` returns `(match_id, rec)` (`:223`) and after the match is persisted, add:

```rust
                matches.insert(match_id.clone(), rec.clone());
```
Do the same after `build_challenge_match` (`:298`) once `match_id`/`rec` are known and persisted. (These are control-plane, per-match — not the hot path.)

- [ ] **Step 4: Extract `notify_peers_dropped` and call it on disconnect**

Add the free fn near `relay_to_other` in `ws.rs`:

```rust
/// On disconnect, tell each active opponent that this connection's seat dropped so their FE can
/// start its grace timer. Driven by the per-connection relay cache (populated at match creation
/// in Step 3), so it fires even if this seat never relayed a frame. Control-plane only.
async fn notify_peers_dropped(
    state: &SharedState,
    conn_id: ConnId,
    matches: &std::collections::HashMap<String, MatchRecord>,
) {
    for (match_id, rec) in matches {
        let other = if rec.conn_a.conn_id == conn_id {
            Some(&rec.conn_b)
        } else if rec.conn_b.conn_id == conn_id {
            Some(&rec.conn_a)
        } else {
            None
        };
        if let Some(other) = other {
            state
                .bus
                .deliver(other, ServerMsg::PeerDropped { match_id: match_id.clone() }.to_text())
                .await;
        }
    }
}
```

Then call it in `handle_socket`'s disconnect cleanup (`:161-167`), before `bus.unregister(conn_id)` and while `matches` is still in scope:

```rust
    notify_peers_dropped(&state, conn_id, &matches).await;
```
Keep the existing `clear_presence_if` + `leave_queue` as-is.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cargo test -p tunnel-manager disconnect_notifies_the_other_seat`
Expected: PASS.

- [ ] **Step 6: Run the full fast suite**

Run: `cargo test -p tunnel-manager`
Expected: PASS.

- [ ] **Step 7: Lint + commit**

Run: `cargo fmt && cargo clippy -p tunnel-manager --all-targets`
```bash
git add backend/tunnel-manager/src/mp/ws.rs
git commit -m "feat(mp): notify peer on disconnect"
```

---

### Task 6: ADR-0010 + spec linkage

Record the decision so the design is discoverable and the affinity/re-homing boundary is explicit.

**Files:**
- Create: `docs/decisions/0010-mp-resume-protocol.md`
- Modify: `docs/decisions/0009-data-plane-local-control-plane-redis.md` (point its deferred "resume protocol" mention at ADR-0010)

**Interfaces:** none (docs only).

- [ ] **Step 1: Write ADR-0010**

Create `docs/decisions/0010-mp-resume-protocol.md` following the `0000-template.md` structure. Decision content (one tight ADR):

- **Context:** a dropped socket abandons a live match; the match record survives in Redis but its seat `ConnRef` is stale. ADR-0009 deferred resume to its own ADR; this is it.
- **Decision:** Resume = atomic `ConnRef` rebind (`rebind_match_conn`) + socket reconnect + event-driven peer relay-cache eviction (bus `evict`). Live game state reconciles **peer-to-peer** (highest both-signed checkpoint wins, client-verified) over the existing relay side channel; **on-chain settlement is the floor** when peers can't reconcile. The server stores **no game state** for resume and adds **zero per-move Redis/on-chain ops**. Auth reuses `Connect`; authorization is the seat-ownership check. The 60s grace window is a **frontend UX timer**; the server never ends a match.
- **Consequences:** instance death is survived implicitly (both peers reconnect via the same path); proactive owner-death re-homing and any server-side watchtower checkpoint store are **out of scope → future affinity ADR (0011)**. Cross-instance eviction rides the pub/sub channel; a rolling deploy may drop a few cross-instance frames mid-rollout (pubsub is a soft dependency, ADR-0005).
- Link the spec: `docs/superpowers/specs/2026-06-22-mp-resume-protocol-design.md`.

- [ ] **Step 2: Reconcile ADR-0009**

In `docs/decisions/0009-data-plane-local-control-plane-redis.md`, where it defers "a resume protocol so a dropped socket can rejoin" (the Decision/Consequences area, ~lines 85-89), add a parenthetical that resume is now specified in **ADR-0010**, and that affinity/re-homing remains deferred (future ADR-0011).

- [ ] **Step 3: Verify docs compile-adjacent**

Run: `cargo build -p tunnel-manager` (sanity; docs don't affect the build but confirm the tree is green).
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add docs/decisions/0010-mp-resume-protocol.md docs/decisions/0009-data-plane-local-control-plane-redis.md
git commit -m "docs(adr): record mp resume protocol"
```

---

## Final verification

- [ ] **Fast suite green:** `cargo test -p tunnel-manager` (all non-ignored pass)
- [ ] **Redis suite green:** `docker run --rm -p 6379:6379 redis:7` then
  `TEST_REDIS_URL=redis://localhost:6379 cargo test -p tunnel-manager -- --ignored --test-threads=1`
- [ ] **Lint/format:** `cargo clippy -p tunnel-manager --all-targets` clean and `cargo fmt --check`
- [ ] **Hot path unchanged:** `relay_to_other`'s body is byte-identical except that the connection loop gained a ctrl-channel `select!` arm and registration gained a ctrl tx. No Redis/on-chain op added to the per-move path. Confirm with `git diff main -- backend/tunnel-manager/src/mp/ws.rs` (only the resume arm, disconnect notice, cache-population, ctrl arm, and registration signatures changed).

## Self-review notes (spec coverage)

- Spec C1 (`rebind_match_conn`) → Task 1. C2 (protocol messages) → Task 2. C4 (peer-cache invalidation) → Task 3 (bus evict) + Task 4 (resume calls it). C3 (`Resume` handler, `peer_online` via presence) → Task 4. Disconnect `PeerDropped` + conn→matches tracking → Task 5. ADR-0010 + 0009 reconcile → Task 6.
- Spec C5 (peer-to-peer reconciliation: re-send, sig-verify, max-nonce) and C6 (settlement floor) are **client-side** → the **frontend follow-up plan**; this plan delivers the server wire + mechanics they consume. Queue/lobby re-attach is FE behavior on the same primitive (re-issue `queue.join`/`Resume` on reconnect) — also the FE plan; the backend already supports it (idempotent `join_or_pair`, presence rebind at `Connect`).
- The 60s grace window has no backend task by design (FE UX timer; server never ends a match).
- Out-of-scope (owner-death re-homing, server watchtower store) intentionally have no task; recorded in ADR-0010 as the future affinity ADR.
