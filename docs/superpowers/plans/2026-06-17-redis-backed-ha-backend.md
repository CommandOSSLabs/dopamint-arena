# Redis-backed, horizontally-scalable backend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `tunnel-manager` correct at desired count ≥2 behind a round-robin ALB by moving all shared state to Redis and delivering cross-instance messages over sharded pub/sub — no Postgres, wire contracts unchanged.

**Architecture:** A storage seam (`ControlStore`, `MpStore`, `Bus` traits) with an in-memory impl (today's behavior; tests + local dev) and a Redis impl (`fred`) selected by env. Cross-instance server→client delivery goes through `Bus::deliver(&ConnRef, text)`: local socket if the target lives here, else `SPUBLISH` to the owner instance's `mp:inst:<id>` channel. Matchmaking is an atomic Lua `join_or_pair`. Stats are shared `INCRBY` counters + idempotent `SADD` sets. Settlement submits concurrently using SIP-58 address-balance gas (no shared gas coin → no equivocation).

**Tech Stack:** Rust, axum 0.7, tokio, `fred` (Redis client, sharded pub/sub + cluster), `async-trait`, `sui-transaction-builder`/`sui-sdk-types` 0.3.1, `testcontainers` (integration tests). Refs: spec `docs/superpowers/specs/2026-06-17-redis-backed-ha-backend-design.md`, ADR `docs/decisions/0005-redis-backed-ha-control-plane.md`.

---

## Conventions for every task

- **Commits:** Conventional Commits, imperative, ≤50-char subject, no AI attribution (see `CLAUDE.md`).
- **Run tests from the repo root:** `cargo test -p tunnel-manager <filter>`. Note (`MEMORY.md`): `cargo test` takes a single filter argument; RTK proxies cargo and filters its output — if you need full output, redirect to a file (`cargo test -p tunnel-manager 2>&1 | tee /tmp/t.txt`).
- **Integration tests** (Phase 6) are `#[ignore]` by default and only run when `TEST_REDIS_URL` is set or testcontainers is available; the unit suite must stay green with **no Redis**.
- **Async traits:** in-memory impl methods do sync `RwLock`/atomic work and return without `.await` while holding a guard — keeps the returned futures `Send`. Never hold a `std::sync::RwLock` guard across an `.await`.

---

## File structure

| File                                           | Responsibility                                                                                                                     | Phase |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `backend/tunnel-manager/src/store/mod.rs`      | **Create.** Trait defs (`ControlStore`, `MpStore`, `Bus`), `ConnRef`, a `Stores` bundle.                                           | 1     |
| `backend/tunnel-manager/src/store/memory.rs`   | **Create.** In-memory impls (today's `RwLock` maps / atomics, lifted here) + the pairing/relay/stats unit tests moved from `mp/*`. | 1     |
| `backend/tunnel-manager/src/store/redis.rs`    | **Create.** `fred` setup + Redis impls of all three traits + the Lua scripts.                                                      | 2     |
| `backend/tunnel-manager/src/state.rs`          | **Modify.** `AppState` holds `Arc<dyn …>` + `instance_id`; add `Serialize/Deserialize` to wire/state types.                        | 1     |
| `backend/tunnel-manager/src/mp/mod.rs`         | **Modify.** `Waiting`/`DirectedInvite`/`MatchRecord` seats become `ConnRef`; derive `Serialize/Deserialize`.                       | 1, 3  |
| `backend/tunnel-manager/src/mp/matchmaking.rs` | **Delete** (logic moves into `MpStore` impls).                                                                                     | 1     |
| `backend/tunnel-manager/src/mp/relay.rs`       | **Delete** (logic moves into `MpStore` impls).                                                                                     | 1     |
| `backend/tunnel-manager/src/mp/ws.rs`          | **Modify.** Keep the local conns map via `Bus::register`; add the `mp:inst:<self>` subscription; call `MpStore`/`Bus`.             | 3     |
| `backend/tunnel-manager/src/mp/protocol.rs`    | **Unchanged.**                                                                                                                     | —     |
| `backend/tunnel-manager/src/mp/auth.rs`        | **Unchanged.**                                                                                                                     | —     |
| `backend/tunnel-manager/src/routes.rs`         | **Modify.** Handlers `.await` the store; add `/health/live` + `/health/ready`.                                                     | 1, 5  |
| `backend/tunnel-manager/src/stats.rs`          | **Modify.** Broadcaster reads `ControlStore::snapshot()` and diffs locally.                                                        | 2     |
| `backend/tunnel-manager/src/sui.rs`            | **Modify.** Address-balance gas (placeholder-then-clear); drop `pick_gas_coin`/`gas_lock`; indexer writes via `ControlStore`.      | 4     |
| `backend/tunnel-manager/src/config.rs`         | **Modify.** Add `REDIS_CACHE_URL`, `REDIS_PUBSUB_URL`, `INSTANCE_ID`; impl selection.                                              | 5     |
| `backend/tunnel-manager/src/main.rs`           | **Modify.** Build `Stores` from config; wire `instance_id`; routes.                                                                | 1, 5  |
| `backend/tunnel-manager/Dockerfile`            | **Create.** Multi-stage build; runtime `debian:bookworm-slim` + `curl`. Build context = repo root.                                 | 5     |
| `Cargo.toml` (workspace) + crate `Cargo.toml`  | **Modify.** Add `async-trait`, `fred`; dev-dep `testcontainers`.                                                                   | 0     |

**Canonical type signatures** (defined in Task 1.1; later tasks must match these names exactly):

```rust
// store/mod.rs
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ConnRef { pub instance_id: String, pub conn_id: crate::mp::ConnId }

#[async_trait::async_trait]
pub trait ControlStore: Send + Sync {
    async fn put_session(&self, id: &str, rec: crate::state::SessionRecord);
    async fn get_session(&self, id: &str) -> Option<crate::state::SessionRecord>;
    async fn set_tunnel_status(&self, id: &str, s: crate::state::TunnelStatus);
    async fn get_tunnel_status(&self, id: &str) -> Option<crate::state::TunnelStatus>;
    async fn add_actions(&self, game: &str, delta: u64);
    async fn snapshot(&self) -> crate::state::StatsSnapshot; // cumulative; tps filled by broadcaster
    async fn ready(&self) -> bool; // PING the cache cluster (for /health/ready)
}

#[async_trait::async_trait]
pub trait MpStore: Send + Sync {
    async fn set_presence(&self, wallet: &str, at: ConnRef);
    async fn get_presence(&self, wallet: &str) -> Option<ConnRef>;
    async fn clear_presence_if(&self, wallet: &str, conn: crate::mp::ConnId);
    async fn join_or_pair(&self, game: &str, me: crate::mp::Waiting) -> Option<crate::mp::Waiting>;
    async fn leave_queue(&self, game: &str, wallet: &str);
    async fn put_invite(&self, match_id: &str, inv: crate::mp::DirectedInvite);
    async fn take_invite(&self, match_id: &str, accepter: &str) -> Option<crate::mp::DirectedInvite>;
    async fn drop_invite(&self, match_id: &str);
    async fn put_match(&self, match_id: &str, m: crate::mp::MatchRecord);
    async fn get_match(&self, match_id: &str) -> Option<crate::mp::MatchRecord>;
    async fn set_tunnel_id(&self, match_id: &str, tunnel_id: &str);
    async fn record_checkpoint(&self, match_id: &str, cp: crate::mp::Checkpoint);
}

#[async_trait::async_trait]
pub trait Bus: Send + Sync {
    fn instance_id(&self) -> &str;
    fn register(&self, conn: crate::mp::ConnId, tx: tokio::sync::mpsc::UnboundedSender<String>);
    fn unregister(&self, conn: crate::mp::ConnId);
    async fn deliver(&self, target: &ConnRef, text: String);
}

pub struct Stores {
    pub control: std::sync::Arc<dyn ControlStore>,
    pub mp: std::sync::Arc<dyn MpStore>,
    pub bus: std::sync::Arc<dyn Bus>,
}
```

---

## Phase 0 — Dependencies

### Task 0.1: Add crate dependencies

**Files:**

- Modify: `Cargo.toml` (workspace `[workspace.dependencies]`)
- Modify: `backend/tunnel-manager/Cargo.toml`

- [ ] **Step 1: Add to the workspace `[workspace.dependencies]` in `/Cargo.toml`**

```toml
async-trait = "0.1"
fred = "9"
```

- [ ] **Step 2: Reference them + add the test dep in `backend/tunnel-manager/Cargo.toml`**

In `[dependencies]` add:

```toml
async-trait.workspace = true
fred.workspace = true
```

In `[dev-dependencies]` add (alongside the existing `wiremock`):

```toml
testcontainers = "0.23"
testcontainers-modules = { version = "0.11", features = ["redis"] }
```

- [ ] **Step 3: Verify it resolves**

Run: `cargo build -p tunnel-manager`
Expected: builds (only new deps downloaded; no code changes yet).

> Note on `fred`: this plan uses `fred`'s `Pool`/`Client`, `Builder::from_config`, the `KeysInterface`/`ListInterface`/`SetsInterface`/`FunctionInterface`/`PubsubInterface` traits, and sharded pub/sub (`ssubscribe`/`spublish`/`message_rx`). The exact method names may differ slightly by `fred` minor version — the compile loop in Phases 2–3 will surface any mismatch; adjust against the installed version's docs (`cargo doc -p fred --open`).

- [ ] **Step 4: Commit**

```bash
git add Cargo.toml Cargo.lock backend/tunnel-manager/Cargo.toml
git commit -m "build(backend): add fred, async-trait, testcontainers"
```

---

## Phase 1 — Storage seam (no behavior change)

Goal: introduce the three traits + an in-memory impl that is byte-for-byte today's behavior, wire `AppState` to `Arc<dyn …>`, make handlers `.await` the store. Single-instance behavior identical; every existing test green. **No Redis yet.**

### Task 1.1: Define the traits and `ConnRef`

**Files:**

- Create: `backend/tunnel-manager/src/store/mod.rs`
- Modify: `backend/tunnel-manager/src/main.rs` (add `mod store;`)

- [ ] **Step 1: Create `store/mod.rs` with the canonical signatures**

Paste the **Canonical type signatures** block from the File-structure section above verbatim into `backend/tunnel-manager/src/store/mod.rs`, prefixed with:

```rust
//! Storage seam: the in-memory impl (today's maps/atomics; tests + local dev) and the Redis
//! impl (prod/HA) live behind these traits. Handlers hold `Arc<dyn …>` and never see Redis.

pub mod memory;

use async_trait::async_trait;
```

(Adjust the `crate::…` paths in the signatures to plain names where the `use` makes them in scope; keep `Stores` and `ConnRef` public.) `pub mod redis;` is added in Phase 2.

- [ ] **Step 2: Register the module in `main.rs`**

In `backend/tunnel-manager/src/main.rs`, add `mod store;` to the module list (after `mod state;`).

- [ ] **Step 3: Verify it compiles (no impls yet)**

Run: `cargo build -p tunnel-manager`
Expected: FAIL — `memory` module not found. That's expected; Task 1.2 creates it. (If you prefer green-between-steps, comment out `pub mod memory;` until 1.2.)

- [ ] **Step 4: Commit** (after 1.2 compiles — these two tasks form one commit)

### Task 1.2: Make state/mp types serializable and seat-on-`ConnRef`

**Files:**

- Modify: `backend/tunnel-manager/src/state.rs:14-28` (`SessionRecord`, `TunnelStatus`)
- Modify: `backend/tunnel-manager/src/mp/mod.rs:20-62` (`Waiting`, `DirectedInvite`, `Checkpoint`, `MatchRecord`)

- [ ] **Step 1: Derive serde on `SessionRecord` and `TunnelStatus`**

In `state.rs`, add derives:

```rust
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionRecord {
    pub game: String,
    pub tunnels: Vec<crate::routes::TunnelRef>,
    pub stats_token: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TunnelStatus { Created, Active, Closed }
```

Make `TunnelRef` serializable: in `routes.rs:66-72` add `Serialize` to its derives and make the struct + fields `pub` (it is already `pub(crate)`; change to `pub` and add `pub` on `tunnel_id`/`party_a`/`party_b`) so `store` can serialize it.

- [ ] **Step 2: Seat `Waiting`/`DirectedInvite`/`MatchRecord` on `ConnRef`; derive serde**

In `mp/mod.rs`:

```rust
use crate::store::ConnRef;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Waiting { pub wallet: Wallet, pub conn: ConnRef }

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DirectedInvite { pub from: Wallet, pub to: Wallet, pub game: GameId, pub from_conn: ConnRef }

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Checkpoint {
    pub nonce: u64, pub party_a_balance: u64, pub party_b_balance: u64,
    pub state_hash: String, pub sig_a: String, pub sig_b: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MatchRecord {
    pub game: GameId,
    pub seat_a: Wallet, pub seat_b: Wallet,
    pub conn_a: ConnRef, pub conn_b: ConnRef,
    pub tunnel_id: Option<String>,
    pub latest_checkpoint: Option<Checkpoint>,
}
```

Update the existing `mp/mod.rs` test `match_record_starts_without_tunnel_or_checkpoint` to build `conn_a`/`conn_b` as `ConnRef { instance_id: "i".into(), conn_id: Uuid::nil() }`.

- [ ] **Step 3: Verify compile of types**

Run: `cargo build -p tunnel-manager`
Expected: FAIL only on callers of the changed types (matchmaking/relay/ws/state) — fixed in the next tasks. The type definitions themselves compile.

### Task 1.3: Implement `InMemoryControlStore` (lift today's stats/session/registry logic)

**Files:**

- Modify: `backend/tunnel-manager/src/store/memory.rs`

- [ ] **Step 1: Write the in-memory `ControlStore` impl**

Create the struct holding today's fields and implement the trait. The bodies are today's logic from `routes.rs`/`stats.rs`/`sui.rs::apply_event`, moved:

```rust
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;
use async_trait::async_trait;

use crate::state::{GameStat, SessionRecord, StatsSnapshot, TunnelStatus};
use super::ControlStore;

#[derive(Default)]
pub struct InMemoryControlStore {
    sessions: RwLock<HashMap<String, SessionRecord>>,
    tunnels: RwLock<HashMap<String, TunnelStatus>>,
    total_actions: AtomicU64,
    active_tunnels: AtomicU64,
    settled_tunnels: AtomicU64,
    per_game_actions: RwLock<HashMap<String, u64>>,
    per_game_tunnels: RwLock<HashMap<String, u64>>, // maintained at register (was session-scan in stats.rs)
}

#[async_trait]
impl ControlStore for InMemoryControlStore {
    async fn put_session(&self, id: &str, rec: SessionRecord) {
        // Maintain per-game tunnel count at write time (replaces the per-tick session scan).
        *self.per_game_tunnels.write().unwrap().entry(rec.game.clone()).or_insert(0)
            += rec.tunnels.len() as u64;
        self.sessions.write().unwrap().insert(id.to_owned(), rec);
    }
    async fn get_session(&self, id: &str) -> Option<SessionRecord> {
        self.sessions.read().unwrap().get(id).cloned()
    }
    async fn set_tunnel_status(&self, id: &str, s: TunnelStatus) {
        // Idempotent count maintenance — identical transition logic to sui::apply_event.
        let mut map = self.tunnels.write().unwrap();
        let prev = map.insert(id.to_owned(), s);
        let was_active = matches!(prev, Some(TunnelStatus::Active));
        match s {
            TunnelStatus::Active if !was_active => { self.active_tunnels.fetch_add(1, Ordering::Relaxed); }
            TunnelStatus::Closed if !matches!(prev, Some(TunnelStatus::Closed)) => {
                if was_active { self.active_tunnels.fetch_sub(1, Ordering::Relaxed); }
                self.settled_tunnels.fetch_add(1, Ordering::Relaxed);
            }
            _ => {}
        }
    }
    async fn get_tunnel_status(&self, id: &str) -> Option<TunnelStatus> {
        self.tunnels.read().unwrap().get(id).copied()
    }
    async fn add_actions(&self, game: &str, delta: u64) {
        self.total_actions.fetch_add(delta, Ordering::Relaxed);
        *self.per_game_actions.write().unwrap().entry(game.to_owned()).or_insert(0) += delta;
    }
    async fn snapshot(&self) -> StatsSnapshot {
        let actions = self.per_game_actions.read().unwrap();
        let tunnels = self.per_game_tunnels.read().unwrap();
        let mut per_game: HashMap<String, GameStat> = HashMap::new();
        for (game, total) in actions.iter() {
            per_game.entry(game.clone()).or_insert(GameStat { tps: 0, tunnels: 0, total_actions: 0 }).total_actions = *total;
        }
        for (game, n) in tunnels.iter() {
            per_game.entry(game.clone()).or_insert(GameStat { tps: 0, tunnels: 0, total_actions: 0 }).tunnels = *n;
        }
        StatsSnapshot {
            tps: 0, // filled by the broadcaster from its per-tick diff
            total_actions: self.total_actions.load(Ordering::Relaxed),
            active_tunnels: self.active_tunnels.load(Ordering::Relaxed),
            settled_tunnels: self.settled_tunnels.load(Ordering::Relaxed),
            per_game,
        }
    }
    async fn ready(&self) -> bool { true } // in-memory is always ready
}
```

- [ ] **Step 2: Move the stats unit tests into `memory.rs`**

Move `heartbeats_attribute_actions_per_game` (from `routes.rs`) and `events_reduce_to_terminal_status_and_maintain_counts` (from `sui.rs`) into a `#[cfg(test)] mod tests` here, rewritten against the trait (async, use `tokio_test::block_on` or `#[tokio::test]`). Example:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::TunnelStatus;

    #[tokio::test]
    async fn heartbeats_attribute_actions_per_game() {
        let s = InMemoryControlStore::default();
        s.add_actions("blackjack", 1000).await;
        s.add_actions("payments", 250).await;
        s.add_actions("blackjack", 200).await;
        let snap = s.snapshot().await;
        assert_eq!(snap.per_game["blackjack"].total_actions, 1200);
        assert_eq!(snap.per_game["payments"].total_actions, 250);
        assert_eq!(snap.total_actions, 1450);
    }

    #[tokio::test]
    async fn tunnel_events_reduce_to_terminal_and_maintain_counts() {
        let s = InMemoryControlStore::default();
        s.set_tunnel_status("0xt", TunnelStatus::Created).await;
        s.set_tunnel_status("0xt", TunnelStatus::Active).await;
        let snap = s.snapshot().await;
        assert_eq!(snap.active_tunnels, 1);
        s.set_tunnel_status("0xt", TunnelStatus::Closed).await;
        s.set_tunnel_status("0xt", TunnelStatus::Closed).await; // replay no-op
        let snap = s.snapshot().await;
        assert_eq!((snap.active_tunnels, snap.settled_tunnels), (0, 1));
    }
}
```

- [ ] **Step 3: Run the moved tests**

Run: `cargo test -p tunnel-manager memory::`
Expected: PASS (2 tests). They encode the same invariants as the originals — counts maintained at write time, terminal-event idempotency.

### Task 1.4: Implement `InMemoryMpStore` (lift matchmaking + relay logic)

**Files:**

- Modify: `backend/tunnel-manager/src/store/memory.rs`
- Delete: `backend/tunnel-manager/src/mp/matchmaking.rs`, `backend/tunnel-manager/src/mp/relay.rs` (after moving logic + tests)

- [ ] **Step 1: Write `InMemoryMpStore` implementing the trait**

The bodies are the existing `quick_match_join`/`quick_match_leave`/`challenge_*`/`relay_target`/`record_checkpoint`/`set_tunnel_id` logic from `mp/matchmaking.rs` and `mp/relay.rs`, adapted to the trait. Key adaptation: `join_or_pair` returns the **opponent `Waiting`** (the WS layer builds the `MatchRecord` + match id), and queues store `Waiting { wallet, conn: ConnRef }`.

```rust
use std::collections::{HashMap, VecDeque};
use crate::mp::{Checkpoint, ConnId, DirectedInvite, MatchRecord, Waiting};
use super::{ConnRef, MpStore};

#[derive(Default)]
pub struct InMemoryMpStore {
    presence: RwLock<HashMap<String, ConnRef>>,
    queues: RwLock<HashMap<String, VecDeque<Waiting>>>,
    invites: RwLock<HashMap<String, DirectedInvite>>,
    matches: RwLock<HashMap<String, MatchRecord>>,
}

#[async_trait]
impl MpStore for InMemoryMpStore {
    async fn set_presence(&self, wallet: &str, at: ConnRef) {
        self.presence.write().unwrap().insert(wallet.to_owned(), at);
    }
    async fn get_presence(&self, wallet: &str) -> Option<ConnRef> {
        self.presence.read().unwrap().get(wallet).cloned()
    }
    async fn clear_presence_if(&self, wallet: &str, conn: ConnId) {
        let mut p = self.presence.write().unwrap();
        if p.get(wallet).map(|c| c.conn_id) == Some(conn) { p.remove(wallet); }
    }
    async fn join_or_pair(&self, game: &str, me: Waiting) -> Option<Waiting> {
        let mut queues = self.queues.write().unwrap();
        let q = queues.entry(game.to_owned()).or_default();
        q.retain(|w| w.wallet != me.wallet); // drop stale self entry (reconnect)
        if let Some(front) = q.pop_front() { Some(front) } else { q.push_back(me); None }
    }
    async fn leave_queue(&self, game: &str, wallet: &str) {
        if let Some(q) = self.queues.write().unwrap().get_mut(game) { q.retain(|w| w.wallet != wallet); }
    }
    async fn put_invite(&self, match_id: &str, inv: DirectedInvite) {
        self.invites.write().unwrap().insert(match_id.to_owned(), inv);
    }
    async fn take_invite(&self, match_id: &str, accepter: &str) -> Option<DirectedInvite> {
        let mut inv = self.invites.write().unwrap();
        match inv.get(match_id) {
            Some(i) if i.to == accepter => inv.remove(match_id),
            _ => None,
        }
    }
    async fn drop_invite(&self, match_id: &str) { self.invites.write().unwrap().remove(match_id); }
    async fn put_match(&self, match_id: &str, m: MatchRecord) {
        self.matches.write().unwrap().insert(match_id.to_owned(), m);
    }
    async fn get_match(&self, match_id: &str) -> Option<MatchRecord> {
        self.matches.read().unwrap().get(match_id).cloned()
    }
    async fn set_tunnel_id(&self, match_id: &str, tunnel_id: &str) {
        if let Some(m) = self.matches.write().unwrap().get_mut(match_id) { m.tunnel_id = Some(tunnel_id.to_owned()); }
    }
    async fn record_checkpoint(&self, match_id: &str, cp: Checkpoint) {
        if let Some(m) = self.matches.write().unwrap().get_mut(match_id) {
            if m.latest_checkpoint.as_ref().map_or(true, |c| cp.nonce >= c.nonce) { m.latest_checkpoint = Some(cp); }
        }
    }
}
```

- [ ] **Step 2: Move + rewrite the matchmaking/relay behavior tests into `memory.rs`**

Move the four behavior tests (`quick_match_pairs_the_second_joiner`, `quick_match_is_per_game`, `challenge_accept_requires_the_invited_wallet`, `record_checkpoint_keeps_highest_nonce`) here, rewritten against `MpStore`. The seat-A=earlier-waiter assertion now lives in the WS layer (it builds the record); here assert the **store-level** invariant. Example:

```rust
#[tokio::test]
async fn join_or_pair_returns_the_earlier_waiter_then_drains() {
    let s = InMemoryMpStore::default();
    let cr = |id: &str| ConnRef { instance_id: "i".into(), conn_id: uuid::Uuid::new_v4() };
    let a = Waiting { wallet: "0xa".into(), conn: cr("a") };
    let b = Waiting { wallet: "0xb".into(), conn: cr("b") };
    assert!(s.join_or_pair("ttt", a.clone()).await.is_none(), "first parks");
    let opp = s.join_or_pair("ttt", b).await.expect("second pairs");
    assert_eq!(opp.wallet, "0xa", "opponent is the earlier waiter (seat A)");
}

#[tokio::test]
async fn record_checkpoint_keeps_highest_nonce() {
    let s = InMemoryMpStore::default();
    let cr = ConnRef { instance_id: "i".into(), conn_id: uuid::Uuid::nil() };
    s.put_match("m", MatchRecord { game: "ttt".into(), seat_a: "0xa".into(), seat_b: "0xb".into(),
        conn_a: cr.clone(), conn_b: cr, tunnel_id: None, latest_checkpoint: None }).await;
    let cp = |n| Checkpoint { nonce: n, party_a_balance: 1, party_b_balance: 1, state_hash: "h".into(), sig_a: "a".into(), sig_b: "b".into() };
    s.record_checkpoint("m", cp(5)).await;
    s.record_checkpoint("m", cp(3)).await; // stale
    assert_eq!(s.get_match("m").await.unwrap().latest_checkpoint.unwrap().nonce, 5);
}
```

- [ ] **Step 3: Delete the old modules**

Delete `backend/tunnel-manager/src/mp/matchmaking.rs` and `backend/tunnel-manager/src/mp/relay.rs`. Remove `pub mod matchmaking;` and `pub mod relay;` from `mp/mod.rs`.

- [ ] **Step 4: Run the moved tests**

Run: `cargo test -p tunnel-manager memory::`
Expected: PASS. (`ws.rs` still references the deleted modules — fixed in Task 1.5; if the crate won't compile, temporarily `#[allow(unused)]` or proceed to 1.5 before running the full suite.)

### Task 1.5: Implement the single-instance `Bus`, rewire `AppState`, `main.rs`, handlers, `ws.rs`

**Files:**

- Modify: `backend/tunnel-manager/src/store/memory.rs` (add `LocalBus`)
- Modify: `backend/tunnel-manager/src/state.rs` (AppState)
- Modify: `backend/tunnel-manager/src/main.rs`
- Modify: `backend/tunnel-manager/src/routes.rs` (handlers `.await`)
- Modify: `backend/tunnel-manager/src/mp/ws.rs`
- Modify: `backend/tunnel-manager/src/stats.rs`

- [ ] **Step 1: Add `LocalBus` (single-instance Bus) to `memory.rs`**

```rust
use tokio::sync::mpsc;
use crate::mp::ConnId;
use super::Bus;

pub struct LocalBus {
    instance_id: String,
    conns: RwLock<HashMap<ConnId, mpsc::UnboundedSender<String>>>,
}
impl LocalBus {
    pub fn new(instance_id: String) -> Self { Self { instance_id, conns: RwLock::new(HashMap::new()) } }
}
#[async_trait]
impl Bus for LocalBus {
    fn instance_id(&self) -> &str { &self.instance_id }
    fn register(&self, conn: ConnId, tx: mpsc::UnboundedSender<String>) { self.conns.write().unwrap().insert(conn, tx); }
    fn unregister(&self, conn: ConnId) { self.conns.write().unwrap().remove(&conn); }
    async fn deliver(&self, target: &ConnRef, text: String) {
        // Single instance: target is always local. (Phase 3 adds the cross-instance branch.)
        if let Some(tx) = self.conns.read().unwrap().get(&target.conn_id) { let _ = tx.send(text); }
    }
}
```

- [ ] **Step 2: Replace `AppState`'s state fields with the `Stores` bundle + `instance_id`**

In `state.rs`, replace the struct body (keep `settler`, `walrus`, `stats_tx`, and the stats wire types unchanged):

```rust
pub struct AppState {
    pub instance_id: String,
    pub control: std::sync::Arc<dyn crate::store::ControlStore>,
    pub mp: std::sync::Arc<dyn crate::store::MpStore>,
    pub bus: std::sync::Arc<dyn crate::store::Bus>,
    pub settler: crate::sui::SuiSettler,
    pub walrus: crate::walrus::WalrusClient,
    pub stats_tx: tokio::sync::broadcast::Sender<String>,
}
```

Remove the now-unused imports (`HashMap`, `AtomicU64`, `RwLock`, `mpsc`, the mp type imports) from `state.rs`.

- [ ] **Step 3: Rewrite `routes.rs::test_support::test_state()` to build the in-memory `Stores`**

```rust
pub(crate) fn test_state() -> SharedState {
    use base64::Engine;
    let key = base64::engine::general_purpose::STANDARD.encode([1u8; 32]);
    let settler = crate::sui::SuiSettler::new("http://127.0.0.1:9999".into(), "0x2", "0x2::sui::SUI", &key).expect("test settler");
    let walrus = crate::walrus::WalrusClient::new("http://pub".into(), "http://agg".into());
    let (stats_tx, _) = tokio::sync::broadcast::channel(4);
    std::sync::Arc::new(AppState {
        instance_id: "test-instance".into(),
        control: std::sync::Arc::new(crate::store::memory::InMemoryControlStore::default()),
        mp: std::sync::Arc::new(crate::store::memory::InMemoryMpStore::default()),
        bus: std::sync::Arc::new(crate::store::memory::LocalBus::new("test-instance".into())),
        settler, walrus, stats_tx,
    })
}
```

- [ ] **Step 4: Update `routes.rs` handlers to `.await` the store**

- `register_session`: replace the `state.sessions.write()…insert` with `state.control.put_session(&session_id, SessionRecord { game: req.game, tunnels: req.tunnels, stats_token: stats_token.clone() }).await;`
- `heartbeat`: replace the session lookup with `let Some(rec) = state.control.get_session(&session_id).await else { return Err(ApiError::resp(NOT_FOUND, "unknown_session", "no such session")) };` then bearer-check `rec.stats_token`; replace the action accounting with `state.control.add_actions(&rec.game, req.actions_delta).await;` (drop the local `total_actions`/`attribute_actions`).
- `settle`: replace the session lookup with `get_session(&session_id).await`, the tunnel-in-session check unchanged; replace the already-closed check with `if state.control.get_tunnel_status(&req.settlement.tunnel_id).await == Some(TunnelStatus::Closed) { … 409 … }`.
- Delete `attribute_actions` and the local `metrics`/`render_metrics`'s direct atomic reads → have `metrics` build from `state.control.snapshot().await` (read the cumulative numbers from the snapshot). Keep the Prometheus text format.

- [ ] **Step 5: Update `ws.rs` to call `MpStore`/`Bus`**

Rewrite the WS handlers to (a) register the socket via `state.bus.register(conn_id, tx.clone())` on connect, (b) build `ConnRef { instance_id: state.bus.instance_id().to_owned(), conn_id }` wherever a conn is stored, (c) call `state.mp.*` (async) instead of `matchmaking::*`/`relay::*`, (d) deliver via `state.bus.deliver(&conn_ref, text).await`. The pairing decision (seat A = earlier waiter / inviter) moves here: after `join_or_pair` returns the opponent, build the `MatchRecord` (seat_a = opponent.wallet, seat_b = me) + a `new_match_id()` and `put_match`. On disconnect: track a local `HashSet<GameId>` of games this conn joined and call `leave_queue` for each + `clear_presence_if(wallet, conn_id)`. Make `handle_message`/`handle_authed` async. (Full new `ws.rs` is produced in Phase 3 Task 3.2 — for Phase 1 the local-only `LocalBus` makes it single-instance-correct.)

- [ ] **Step 6: Update `stats.rs` broadcaster to read the snapshot + diff locally**

```rust
pub(crate) fn spawn_stats_broadcaster(state: SharedState) {
    const TICK_MS: u64 = 500;
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(TICK_MS));
        let mut prev_total = 0u64;
        loop {
            interval.tick().await;
            let mut snap = state.control.snapshot().await;
            let cur = snap.total_actions;
            snap.tps = cur.saturating_sub(prev_total) * (1000 / TICK_MS);
            prev_total = cur;
            if let Ok(json) = serde_json::to_string(&snap) { let _ = state.stats_tx.send(json); }
        }
    });
}
```

Delete the old `build_snapshot` (its logic now lives in `ControlStore::snapshot`).

- [ ] **Step 7: Update `main.rs` to build the in-memory `Stores`**

Replace the `AppState { … }` construction with the in-memory `Stores` (mirroring `test_state` but reading `instance_id` from config in Phase 5; for now hardcode a boot uuid: `let instance_id = uuid::Uuid::new_v4().to_string();`). Keep `spawn_stats_broadcaster` and `spawn_event_indexer`. Update `sui::spawn_event_indexer` to write via `state.control.set_tunnel_status(...).await` (see Task 4.3 for the indexer; for Phase 1 keep it calling the in-memory store).

- [ ] **Step 8: Run the full unit suite**

Run: `cargo test -p tunnel-manager`
Expected: PASS — every pre-existing test (settle camelCase, parse helpers, bearer auth, protocol round-trip, build_close_tx, ed25519, indexer reduction, pairing) green. Behavior is byte-identical at one instance.

- [ ] **Step 9: Commit Phase 1**

```bash
git add -A backend/tunnel-manager
git commit -m "refactor(backend): storage seam with in-memory impls"
```

---

## Phase 2 — Redis impls (`fred`) + impl selection

Goal: a Redis impl of `ControlStore` + `MpStore` (the `Bus` Redis impl is Phase 3), selected when `REDIS_CACHE_URL` is set. Key schema per the spec.

### Task 2.1: `fred` client setup + `RedisControlStore`

**Files:**

- Create: `backend/tunnel-manager/src/store/redis.rs`
- Modify: `backend/tunnel-manager/src/store/mod.rs` (`pub mod redis;`)

- [ ] **Step 1: Connection helper + `RedisControlStore` skeleton**

```rust
//! Redis impls (fred). Cache cluster holds sessions/registry/stats/presence/queues/invites/matches.
use std::collections::HashMap;
use async_trait::async_trait;
use fred::prelude::*;
use crate::state::{GameStat, SessionRecord, StatsSnapshot, TunnelStatus};
use super::ControlStore;

pub async fn connect(url: &str) -> anyhow::Result<Pool> {
    let config = Config::from_url(url)?;
    let pool = Builder::from_config(config).build_pool(6)?;
    pool.init().await?;
    Ok(pool)
}

pub struct RedisControlStore { pub pool: Pool }

const SESSION_TTL: i64 = 24 * 3600;
```

- [ ] **Step 2: Write a focused integration test (ignored unless Redis present)**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    fn test_url() -> Option<String> { std::env::var("TEST_REDIS_URL").ok() }

    #[tokio::test]
    #[ignore = "requires TEST_REDIS_URL"]
    async fn sessions_roundtrip_and_actions_count() {
        let Some(url) = test_url() else { return };
        let s = RedisControlStore { pool: connect(&url).await.unwrap() };
        s.add_actions("blackjack", 100).await;
        s.add_actions("blackjack", 50).await;
        let snap = s.snapshot().await;
        assert!(snap.total_actions >= 150);
        assert!(snap.per_game.get("blackjack").map_or(false, |g| g.total_actions >= 150));
    }
}
```

- [ ] **Step 3: Implement `ControlStore` for `RedisControlStore`**

Key schema: `session:<id>` (JSON, TTL 24h), `tunnel:<id>` (status string), `stats:actions:total` / `stats:actions:game:<g>` (INCRBY), `stats:tunnels:active` / `stats:tunnels:settled` (SADD sets, count=SCARD), `stats:tunnels:game:<g>` (INCRBY at register).

```rust
#[async_trait]
impl ControlStore for RedisControlStore {
    async fn put_session(&self, id: &str, rec: SessionRecord) {
        let json = serde_json::to_string(&rec).unwrap();
        let _: () = self.pool.set(format!("session:{id}"), json, Some(Expiration::EX(SESSION_TTL)), None, false).await.unwrap_or(());
        let _: () = self.pool.incr_by(format!("stats:tunnels:game:{}", rec.game), rec.tunnels.len() as i64).await.map(|_: i64| ()).unwrap_or(());
    }
    async fn get_session(&self, id: &str) -> Option<SessionRecord> {
        let v: Option<String> = self.pool.get(format!("session:{id}")).await.ok().flatten();
        v.and_then(|j| serde_json::from_str(&j).ok())
    }
    async fn set_tunnel_status(&self, id: &str, s: TunnelStatus) {
        // Idempotent sets: SADD same id is a no-op, so N indexers don't over-count.
        let _: () = self.pool.set(format!("tunnel:{id}"), serde_json::to_string(&s).unwrap(), None, None, false).await.unwrap_or(());
        match s {
            TunnelStatus::Active => { let _: i64 = self.pool.sadd("stats:tunnels:active", id).await.unwrap_or(0); }
            TunnelStatus::Closed => {
                let _: i64 = self.pool.srem("stats:tunnels:active", id).await.unwrap_or(0);
                let _: i64 = self.pool.sadd("stats:tunnels:settled", id).await.unwrap_or(0);
            }
            TunnelStatus::Created => {}
        }
    }
    async fn get_tunnel_status(&self, id: &str) -> Option<TunnelStatus> {
        let v: Option<String> = self.pool.get(format!("tunnel:{id}")).await.ok().flatten();
        v.and_then(|j| serde_json::from_str(&j).ok())
    }
    async fn add_actions(&self, game: &str, delta: u64) {
        let _: i64 = self.pool.incr_by("stats:actions:total", delta as i64).await.unwrap_or(0);
        let _: i64 = self.pool.incr_by(format!("stats:actions:game:{game}"), delta as i64).await.unwrap_or(0);
    }
    async fn snapshot(&self) -> StatsSnapshot {
        let total: i64 = self.pool.get("stats:actions:total").await.ok().flatten().unwrap_or(0);
        let active: i64 = self.pool.scard("stats:tunnels:active").await.unwrap_or(0);
        let settled: i64 = self.pool.scard("stats:tunnels:settled").await.unwrap_or(0);
        // Per-game: read the small set of game keys via SCAN of stats:actions:game:* and stats:tunnels:game:*.
        let mut per_game: HashMap<String, GameStat> = HashMap::new();
        for (prefix, set_actions) in [("stats:actions:game:", true), ("stats:tunnels:game:", false)] {
            let keys: Vec<String> = self.scan_keys(&format!("{prefix}*")).await;
            for key in keys {
                let g = key.trim_start_matches(prefix).to_owned();
                let v: i64 = self.pool.get(&key).await.ok().flatten().unwrap_or(0);
                let e = per_game.entry(g).or_insert(GameStat { tps: 0, tunnels: 0, total_actions: 0 });
                if set_actions { e.total_actions = v as u64; } else { e.tunnels = v as u64; }
            }
        }
        StatsSnapshot { tps: 0, total_actions: total as u64, active_tunnels: active as u64, settled_tunnels: settled as u64, per_game }
    }
    async fn ready(&self) -> bool { self.pool.ping::<String>(None).await.is_ok() }
}
```

Add a small `scan_keys(&self, pattern) -> Vec<String>` helper using `SCAN` (cursor loop) — the game-key cardinality is tiny (one per game, ~7), so this is O(games) per tick, not O(sessions).

- [ ] **Step 4: Run (with a local Redis)**

Run: `TEST_REDIS_URL=redis://127.0.0.1:6379 cargo test -p tunnel-manager redis:: -- --ignored`
Expected: PASS if a Redis 7 is reachable; SKIPPED (returns early) otherwise. Unit suite without the var stays green.

- [ ] **Step 5: Commit**

```bash
git add -A backend/tunnel-manager
git commit -m "feat(backend): redis ControlStore impl"
```

### Task 2.2: `RedisMpStore` + the atomic `join_or_pair` Lua

**Files:**

- Modify: `backend/tunnel-manager/src/store/redis.rs`

- [ ] **Step 1: Write the concurrency integration test first**

```rust
#[tokio::test]
#[ignore = "requires TEST_REDIS_URL"]
async fn join_or_pair_pairs_each_waiter_exactly_once_under_concurrency() {
    let Some(url) = test_url() else { return };
    let s = std::sync::Arc::new(RedisMpStore { pool: connect(&url).await.unwrap() });
    let game = format!("g{}", uuid::Uuid::new_v4().simple());
    let mut handles = vec![];
    for i in 0..50u32 {
        let s = s.clone(); let game = game.clone();
        handles.push(tokio::spawn(async move {
            let cr = super::ConnRef { instance_id: "i".into(), conn_id: uuid::Uuid::new_v4() };
            s.join_or_pair(&game, crate::mp::Waiting { wallet: format!("0x{i}"), conn: cr }).await
        }));
    }
    let mut pairs = 0; let mut parked = 0;
    for h in handles { if h.await.unwrap().is_some() { pairs += 1; } else { parked += 1; } }
    // 50 joiners → 25 pair events, 25 parked; never a double-pair (would exceed 25 pairs).
    assert_eq!(pairs, 25); assert_eq!(parked, 25);
}
```

- [ ] **Step 2: Implement `RedisMpStore` with the Lua `join_or_pair`**

```rust
pub struct RedisMpStore { pub pool: Pool }

// KEYS[1]=queue:<game> ARGV[1]=selfWaitingJson ARGV[2]=selfWallet
const JOIN_OR_PAIR: &str = r#"
local front = redis.call('LPOP', KEYS[1])
while front do
  local w = cjson.decode(front)
  if w.wallet ~= ARGV[2] then return front end
  front = redis.call('LPOP', KEYS[1])
end
redis.call('RPUSH', KEYS[1], ARGV[1])
return false
"#;

// presence compare-and-delete: only remove if it still points at this conn.
const CLEAR_PRESENCE_IF: &str = r#"
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end
"#;

#[async_trait]
impl MpStore for RedisMpStore {
    async fn set_presence(&self, wallet: &str, at: ConnRef) {
        let _: () = self.pool.set(format!("presence:{wallet}"), at.conn_id.to_string(), None, None, false).await.unwrap_or(());
        // store the full ConnRef JSON too, for cross-instance delivery lookups
        let _: () = self.pool.set(format!("presence:ref:{wallet}"), serde_json::to_string(&at).unwrap(), None, None, false).await.unwrap_or(());
    }
    async fn get_presence(&self, wallet: &str) -> Option<ConnRef> {
        let v: Option<String> = self.pool.get(format!("presence:ref:{wallet}")).await.ok().flatten();
        v.and_then(|j| serde_json::from_str(&j).ok())
    }
    async fn clear_presence_if(&self, wallet: &str, conn: crate::mp::ConnId) {
        let _: i64 = self.pool.eval(CLEAR_PRESENCE_IF, vec![format!("presence:{wallet}")], vec![conn.to_string()]).await.unwrap_or(0);
        // also clear the ref mirror (best-effort)
        let cur: Option<String> = self.pool.get(format!("presence:{wallet}")).await.ok().flatten();
        if cur.is_none() { let _: () = self.pool.del::<i64, _>(format!("presence:ref:{wallet}")).await.map(|_| ()).unwrap_or(()); }
    }
    async fn join_or_pair(&self, game: &str, me: crate::mp::Waiting) -> Option<crate::mp::Waiting> {
        let me_json = serde_json::to_string(&me).unwrap();
        let res: Option<String> = self.pool.eval(JOIN_OR_PAIR, vec![format!("queue:{game}")], vec![me_json, me.wallet.clone()]).await.unwrap_or(None);
        res.and_then(|j| serde_json::from_str(&j).ok())
    }
    async fn leave_queue(&self, game: &str, wallet: &str) {
        // LREM by value needs the exact element; instead scan-and-rebuild is overkill — store wallet→json is 1:1,
        // so fetch the list, filter, rewrite under a short MULTI. For demo scale (tiny queues) this is fine.
        let items: Vec<String> = self.pool.lrange(format!("queue:{game}"), 0, -1).await.unwrap_or_default();
        let kept: Vec<String> = items.into_iter().filter(|j| serde_json::from_str::<crate::mp::Waiting>(j).map_or(true, |w| w.wallet != wallet)).collect();
        let _: () = self.pool.del::<i64, _>(format!("queue:{game}")).await.map(|_| ()).unwrap_or(());
        if !kept.is_empty() { let _: () = self.pool.rpush(format!("queue:{game}"), kept).await.map(|_: i64| ()).unwrap_or(()); }
    }
    async fn put_invite(&self, match_id: &str, inv: crate::mp::DirectedInvite) {
        let _: () = self.pool.set(format!("invite:{match_id}"), serde_json::to_string(&inv).unwrap(), Some(Expiration::EX(60)), None, false).await.unwrap_or(());
    }
    async fn take_invite(&self, match_id: &str, accepter: &str) -> Option<crate::mp::DirectedInvite> {
        let v: Option<String> = self.pool.get(format!("invite:{match_id}")).await.ok().flatten();
        let inv: crate::mp::DirectedInvite = v.and_then(|j| serde_json::from_str(&j).ok())?;
        if inv.to == accepter { let _: () = self.pool.del::<i64, _>(format!("invite:{match_id}")).await.map(|_| ()).unwrap_or(()); Some(inv) } else { None }
    }
    async fn drop_invite(&self, match_id: &str) { let _: () = self.pool.del::<i64, _>(format!("invite:{match_id}")).await.map(|_| ()).unwrap_or(()); }
    async fn put_match(&self, match_id: &str, m: crate::mp::MatchRecord) {
        let _: () = self.pool.set(format!("match:{match_id}"), serde_json::to_string(&m).unwrap(), Some(Expiration::EX(6*3600)), None, false).await.unwrap_or(());
    }
    async fn get_match(&self, match_id: &str) -> Option<crate::mp::MatchRecord> {
        let v: Option<String> = self.pool.get(format!("match:{match_id}")).await.ok().flatten();
        v.and_then(|j| serde_json::from_str(&j).ok())
    }
    async fn set_tunnel_id(&self, match_id: &str, tunnel_id: &str) {
        if let Some(mut m) = self.get_match(match_id).await { m.tunnel_id = Some(tunnel_id.to_owned()); self.put_match(match_id, m).await; }
    }
    async fn record_checkpoint(&self, match_id: &str, cp: crate::mp::Checkpoint) {
        if let Some(mut m) = self.get_match(match_id).await {
            if m.latest_checkpoint.as_ref().map_or(true, |c| cp.nonce >= c.nonce) { m.latest_checkpoint = Some(cp); self.put_match(match_id, m).await; }
        }
    }
}
```

> `record_checkpoint`/`set_tunnel_id` are read-modify-write; for the demo's per-match low contention this is acceptable. If contention shows up, move the highest-nonce check into a Lua script over `match:<id>`. Noted, not built (YAGNI).

- [ ] **Step 3: Run the concurrency test**

Run: `TEST_REDIS_URL=redis://127.0.0.1:6379 cargo test -p tunnel-manager join_or_pair -- --ignored`
Expected: PASS — exactly 25 pairs, 25 parked. This is the spec's success criterion #2.

- [ ] **Step 4: Commit**

```bash
git add -A backend/tunnel-manager
git commit -m "feat(backend): redis MpStore + atomic join_or_pair"
```

---

## Phase 3 — Cross-instance delivery (`Bus`)

Goal: the Redis `Bus` (`SPUBLISH` to `mp:inst:<id>` when the target is remote) + each task's subscription loop, and the final `ws.rs` that uses `Bus`/`MpStore` end-to-end.

### Task 3.1: `RedisBus` + the subscription loop

**Files:**

- Modify: `backend/tunnel-manager/src/store/redis.rs`

- [ ] **Step 1: Integration test — deliver from instance X reaches a socket on instance Y**

```rust
#[tokio::test]
#[ignore = "requires TEST_REDIS_URL"]
async fn deliver_crosses_instances() {
    let Some(url) = test_url() else { return };
    // Instance B owns the socket; instance A delivers to it.
    let bus_b = RedisBus::new("B".into(), connect(&url).await.unwrap()).await;
    let bus_a = RedisBus::new("A".into(), connect(&url).await.unwrap()).await;
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let conn = uuid::Uuid::new_v4();
    bus_b.register(conn, tx);
    bus_a.deliver(&super::ConnRef { instance_id: "B".into(), conn_id: conn }, "hello".into()).await;
    let got = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv()).await.unwrap().unwrap();
    assert_eq!(got, "hello");
}
```

- [ ] **Step 2: Implement `RedisBus`**

```rust
use tokio::sync::mpsc;
use std::sync::RwLock;
use std::collections::HashMap;
use super::{Bus, ConnRef};

pub struct RedisBus {
    instance_id: String,
    pub_pool: Pool,                                   // for SPUBLISH
    conns: std::sync::Arc<RwLock<HashMap<crate::mp::ConnId, mpsc::UnboundedSender<String>>>>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct Wire { conn: crate::mp::ConnId, text: String }

impl RedisBus {
    pub async fn new(instance_id: String, pub_pool: Pool) -> Self {
        let conns: std::sync::Arc<RwLock<HashMap<_, mpsc::UnboundedSender<String>>>> = Default::default();
        let bus = Self { instance_id: instance_id.clone(), pub_pool, conns: conns.clone() };
        bus.spawn_subscriber().await;
        bus
    }
    async fn spawn_subscriber(&self) {
        // A dedicated subscriber client SSUBSCRIBEs to this instance's channel and fans inbound
        // {conn,text} to the local socket. Uses the pubsub cluster connection.
        let channel = format!("mp:inst:{}", self.instance_id);
        let conns = self.conns.clone();
        let sub = self.pub_pool.next().clone_new(); // a fresh client for subscription
        sub.init().await.expect("subscriber init");
        let mut rx = sub.message_rx();
        sub.ssubscribe(channel).await.expect("ssubscribe");
        tokio::spawn(async move {
            while let Ok(msg) = rx.recv().await {
                if let Some(s) = msg.value.as_string() {
                    if let Ok(w) = serde_json::from_str::<Wire>(&s) {
                        if let Some(tx) = conns.read().unwrap().get(&w.conn) { let _ = tx.send(w.text); }
                    }
                }
            }
        });
    }
}

#[async_trait]
impl Bus for RedisBus {
    fn instance_id(&self) -> &str { &self.instance_id }
    fn register(&self, conn: crate::mp::ConnId, tx: mpsc::UnboundedSender<String>) { self.conns.write().unwrap().insert(conn, tx); }
    fn unregister(&self, conn: crate::mp::ConnId) { self.conns.write().unwrap().remove(&conn); }
    async fn deliver(&self, target: &ConnRef, text: String) {
        if target.instance_id == self.instance_id {
            if let Some(tx) = self.conns.read().unwrap().get(&target.conn_id) { let _ = tx.send(text); }
        } else {
            let wire = serde_json::to_string(&Wire { conn: target.conn_id, text }).unwrap();
            let _: () = self.pub_pool.spublish(format!("mp:inst:{}", target.instance_id), wire).await.map(|_: i64| ()).unwrap_or(());
        }
    }
}
```

> The exact `fred` subscriber API (`clone_new`/`message_rx`/`ssubscribe`/`spublish`/`as_string`) is version-sensitive — confirm against the installed `fred` docs; the compile + the integration test pin it. If sharded pub/sub isn't exposed, fall back to regular `subscribe`/`publish` (correctness is identical for the demo; sharded is the scaling form).

- [ ] **Step 3: Run the cross-instance test**

Run: `TEST_REDIS_URL=redis://127.0.0.1:6379 cargo test -p tunnel-manager deliver_crosses_instances -- --ignored`
Expected: PASS — "hello" arrives on B's socket via A's deliver. Spec success criterion #1 (relay across tasks).

- [ ] **Step 4: Commit**

```bash
git add -A backend/tunnel-manager
git commit -m "feat(backend): redis Bus cross-instance deliver"
```

### Task 3.2: Final `ws.rs` over `Bus`/`MpStore`

**Files:**

- Modify: `backend/tunnel-manager/src/mp/ws.rs`

- [ ] **Step 1: Rewrite `ws.rs`** (full file)

```rust
//! `GET /v1/mp` WebSocket. Upgrade → challenge → connect-auth → register presence + a local
//! outbound channel via Bus → drive matchmaking/relay through MpStore + Bus::deliver.
use std::collections::HashSet;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::mp::protocol::{ClientMsg, ServerMsg};
use crate::mp::{auth, Checkpoint, ConnId, DirectedInvite, MatchRecord, Waiting};
use crate::state::SharedState;
use crate::store::ConnRef;

pub async fn mp_upgrade(State(state): State<SharedState>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

fn new_match_id() -> String { format!("match_{}", Uuid::new_v4().simple()) }
fn here(state: &SharedState, conn: ConnId) -> ConnRef { ConnRef { instance_id: state.bus.instance_id().to_owned(), conn_id: conn } }

async fn handle_socket(socket: WebSocket, state: SharedState) {
    let conn_id: ConnId = Uuid::new_v4();
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        while let Some(text) = rx.recv().await { if sink.send(Message::Text(text)).await.is_err() { break; } }
    });
    let nonce = conn_id.to_string();
    let _ = tx.send(ServerMsg::Challenge { nonce: nonce.clone() }.to_text());

    let mut wallet: Option<String> = None;
    let mut joined_games: HashSet<String> = HashSet::new();

    while let Some(Ok(msg)) = stream.next().await {
        let text = match msg { Message::Text(t) => t, Message::Close(_) => break, _ => continue };
        let client_msg = match serde_json::from_str::<ClientMsg>(&text) {
            Ok(m) => m,
            Err(_) => { let _ = tx.send(ServerMsg::error("bad_message", "unparseable control message").to_text()); continue; }
        };
        if let Err(code) = handle_message(&state, &tx, conn_id, &nonce, &mut wallet, &mut joined_games, client_msg).await {
            let _ = tx.send(ServerMsg::error(code, code).to_text());
        }
    }

    // Disconnect cleanup (folds ADR-0004 cuts): conditional presence clear + leave every joined queue.
    if let Some(w) = wallet {
        state.mp.clear_presence_if(&w, conn_id).await;
        for g in joined_games { state.mp.leave_queue(&g, &w).await; }
    }
    state.bus.unregister(conn_id);
    writer.abort();
}

async fn handle_message(
    state: &SharedState, tx: &mpsc::UnboundedSender<String>, conn_id: ConnId, nonce: &str,
    wallet: &mut Option<String>, joined: &mut HashSet<String>, msg: ClientMsg,
) -> Result<(), &'static str> {
    match msg {
        ClientMsg::Connect { wallet: w, pubkey, sig, nonce: claimed } => {
            if claimed != nonce { return Err("bad_nonce"); }
            if !auth::verify_ed25519(&pubkey, nonce.as_bytes(), &sig) { return Err("bad_signature"); }
            state.bus.register(conn_id, tx.clone());
            state.mp.set_presence(&w, here(state, conn_id)).await;
            *wallet = Some(w);
            Ok(())
        }
        other => { let w = wallet.as_ref().ok_or("not_authenticated")?.clone(); handle_authed(state, conn_id, &w, joined, other).await }
    }
}

async fn handle_authed(
    state: &SharedState, conn_id: ConnId, wallet: &str, joined: &mut HashSet<String>, msg: ClientMsg,
) -> Result<(), &'static str> {
    match msg {
        ClientMsg::QueueJoin { game } => {
            joined.insert(game.clone());
            let me = Waiting { wallet: wallet.to_owned(), conn: here(state, conn_id) };
            if let Some(opp) = state.mp.join_or_pair(&game, me).await {
                let match_id = new_match_id();
                let rec = MatchRecord {
                    game: game.clone(), seat_a: opp.wallet.clone(), seat_b: wallet.to_owned(),
                    conn_a: opp.conn.clone(), conn_b: here(state, conn_id), tunnel_id: None, latest_checkpoint: None,
                };
                state.mp.put_match(&match_id, rec.clone()).await;
                state.bus.deliver(&rec.conn_a, ServerMsg::MatchFound { match_id: match_id.clone(), role: "A".into(), opponent_wallet: rec.seat_b.clone(), game: game.clone() }.to_text()).await;
                state.bus.deliver(&rec.conn_b, ServerMsg::MatchFound { match_id, role: "B".into(), opponent_wallet: rec.seat_a, game }.to_text()).await;
            }
            Ok(())
        }
        ClientMsg::QueueLeave => { for g in joined.drain() { state.mp.leave_queue(&g, wallet).await; } Ok(()) }
        ClientMsg::ChallengeCreate { target_wallet, game } => {
            let Some(target) = state.mp.get_presence(&target_wallet).await else { return Err("target_offline") };
            let match_id = new_match_id();
            state.mp.put_invite(&match_id, DirectedInvite { from: wallet.to_owned(), to: target_wallet.clone(), game: game.clone(), from_conn: here(state, conn_id) }).await;
            state.bus.deliver(&target, ServerMsg::ChallengeIncoming { match_id, from_wallet: wallet.to_owned(), game }.to_text()).await;
            Ok(())
        }
        ClientMsg::ChallengeAccept { match_id } => {
            let Some(inv) = state.mp.take_invite(&match_id, wallet).await else { return Err("unknown_invite") };
            let rec = MatchRecord {
                game: inv.game.clone(), seat_a: inv.from.clone(), seat_b: wallet.to_owned(),
                conn_a: inv.from_conn.clone(), conn_b: here(state, conn_id), tunnel_id: None, latest_checkpoint: None,
            };
            state.mp.put_match(&match_id, rec.clone()).await;
            state.bus.deliver(&rec.conn_a, ServerMsg::MatchFound { match_id: match_id.clone(), role: "A".into(), opponent_wallet: rec.seat_b.clone(), game: rec.game.clone() }.to_text()).await;
            state.bus.deliver(&rec.conn_b, ServerMsg::MatchFound { match_id, role: "B".into(), opponent_wallet: rec.seat_a, game: rec.game }.to_text()).await;
            Ok(())
        }
        ClientMsg::ChallengeDecline { match_id } => { state.mp.drop_invite(&match_id).await; Ok(()) }
        ClientMsg::PartyHello { match_id, ephemeral_pubkey, wallet_sig } => {
            let envelope = serde_json::json!({ "type": "party.hello", "matchId": match_id, "ephemeralPubkey": ephemeral_pubkey, "walletSig": wallet_sig }).to_string();
            forward_to_other(state, &match_id, conn_id, envelope).await; Ok(())
        }
        ClientMsg::TunnelOpened { match_id, tunnel_id } => { state.mp.set_tunnel_id(&match_id, &tunnel_id).await; Ok(()) }
        ClientMsg::Relay { match_id, payload } => {
            let envelope = ServerMsg::Relay { match_id: match_id.clone(), payload }.to_text();
            forward_to_other(state, &match_id, conn_id, envelope).await; Ok(())
        }
        ClientMsg::WatchtowerCheckpoint { match_id, nonce, party_a_balance, party_b_balance, state_hash, sig_a, sig_b } => {
            let cp = Checkpoint {
                nonce: nonce.parse().map_err(|_| "bad_checkpoint")?,
                party_a_balance: party_a_balance.parse().map_err(|_| "bad_checkpoint")?,
                party_b_balance: party_b_balance.parse().map_err(|_| "bad_checkpoint")?,
                state_hash, sig_a, sig_b,
            };
            state.mp.record_checkpoint(&match_id, cp).await; Ok(())
        }
        ClientMsg::Connect { .. } => Err("already_connected"),
    }
}

/// Forward an opaque envelope to the OTHER seat of `match_id`, wherever it lives.
async fn forward_to_other(state: &SharedState, match_id: &str, from: ConnId, text: String) {
    let Some(m) = state.mp.get_match(match_id).await else { return };
    let target = if m.conn_a.conn_id == from { Some(m.conn_b) } else if m.conn_b.conn_id == from { Some(m.conn_a) } else { None };
    if let Some(t) = target { state.bus.deliver(&t, text).await; }
}
```

- [ ] **Step 2: Build + run the whole unit suite**

Run: `cargo test -p tunnel-manager`
Expected: PASS — protocol round-trip tests unchanged; everything compiles against the async store/bus. Single-instance behavior identical (LocalBus path).

- [ ] **Step 3: Commit**

```bash
git add -A backend/tunnel-manager
git commit -m "feat(backend): ws over Bus + MpStore"
```

---

## Phase 4 — Concurrent settlement (address-balance gas)

Goal: submit closes concurrently with no shared gas coin → no equivocation. Replace `pick_gas_coin`/`gas_lock` with SIP-58 address-balance gas via the verified placeholder-then-clear workaround. Node acceptance is gated behind an e2e on a v125+ network (deferred, noted).

### Task 4.1: Build closes with address-balance gas

**Files:**

- Modify: `backend/tunnel-manager/src/sui.rs`

- [ ] **Step 1: Write the failing unit test**

```rust
// Address-balance gas (SIP-58): the built close tx must carry an EMPTY gas payment so the node
// charges gas as a FundsWithdrawal from the settler's SUI balance — no owned gas coin to lock,
// so concurrent closes never equivocate. The owner is the sender; budget/price are set.
#[test]
fn build_close_tx_uses_address_balance_gas() {
    let tx = build_close_tx(
        Address::from_str("0xabc").unwrap(),
        "0x2::sui::SUI".parse().unwrap(),
        Address::from_str("0x9").unwrap(),
        &args_with_root(32),
        1000, // gas_price
    ).expect("builds");
    assert!(tx.gas_payment.objects.is_empty(), "gas payment must be empty (address-balance)");
    assert_eq!(tx.gas_payment.owner, Address::from_str("0x9").unwrap());
    assert_eq!(tx.gas_payment.budget, GAS_BUDGET);
}
```

- [ ] **Step 2: Run it (fails — signature still takes `&ResolvedRefs`)**

Run: `cargo test -p tunnel-manager build_close_tx_uses_address_balance_gas`
Expected: FAIL (compile error: `build_close_tx` arity/shape).

- [ ] **Step 3: Rewrite `build_close_tx` to take `gas_price` and clear the gas payment**

Change the signature to `fn build_close_tx(package_id: Address, coin_type: TypeTag, sender: Address, args: &CloseArgs, gas_price: u64) -> anyhow::Result<Transaction>`. Keep the PTB body (tunnel/balances/sigs/ts/root/clock) unchanged. Replace the gas/build tail with:

```rust
    // try_build hard-requires ≥1 gas object (builder.rs:676), so add a placeholder...
    tb.add_gas_objects([ObjectInput::owned(Address::ZERO, 1, Digest::ZERO)]);
    tb.set_sender(sender);
    tb.set_gas_budget(GAS_BUDGET);
    tb.set_gas_price(gas_price.max(1));
    let mut tx = tb.try_build().map_err(|e| anyhow!("build close tx: {e}"))?;
    // ...then clear it: empty gas_payment.objects => implicit FundsWithdrawal from the sender's
    // address balance (SIP-58), which is concurrency-safe (no coin lock). MUST be before signing
    // since the signature covers gas_payment.
    tx.gas_payment.objects.clear();
    Ok(tx)
```

Drop the `clock`/`gas` fields from `ResolvedRefs` usage in the builder (the clock arg is still added inside the PTB from a constant `SharedRef`; keep that). Update the existing build tests (`build_close_tx_builds_for_valid_settlement`, `build_close_tx_rejects_wrong_root_length`, `ed25519_signature_serializes_to_97_byte_sui_format`) to the new signature (pass `1000` for gas_price instead of `&refs()`), and drop the now-unused `gas`/`OwnedRef` parts of the `refs()` helper.

- [ ] **Step 4: Run the tests**

Run: `cargo test -p tunnel-manager build_close_tx`
Expected: PASS (3 tests) — including the empty-gas assertion.

### Task 4.2: Drop gas-coin selection + the gas lock from `submit_close`

**Files:**

- Modify: `backend/tunnel-manager/src/sui.rs`

- [ ] **Step 1: Remove `pick_gas_coin`, the `gas_lock` mutex, and the gas `OwnedRef` resolution**

In `SuiSettler`: delete the `gas_lock: Mutex<()>` field (and its init). In `submit_close`: remove `let _gas = self.gas_lock.lock().await;` and the `gas: self.pick_gas_coin().await?` resolution. The new body resolves only the tunnel ref + gas price, builds, signs, executes — and multiple `submit_close` calls now run concurrently (no shared coin):

```rust
pub async fn submit_close(&self, args: CloseArgs) -> anyhow::Result<String> {
    let tunnel = self.resolve_shared(&args.tunnel_id).await?;
    let gas_price = self.reference_gas_price().await?;
    let tx = build_close_tx_with_tunnel(self.package_id, self.coin_type.clone(), self.sender, &args, &tunnel, gas_price)?;
    let sig = self.signer.sign_transaction(&tx).map_err(|e| anyhow!("sign close tx: {e}"))?;
    self.execute(&tx, &sig).await
}
```

(Refactor: fold the tunnel `SharedRef` into the builder as a param — rename the builder to take `&SharedRef` for the tunnel and the static clock internally. Keep `build_close_tx`'s pure-core testable as in Task 4.1; the only added input is the tunnel ref. Adjust Task 4.1's tests to construct a `SharedRef` for the tunnel.) Delete `pick_gas_coin` and the `OwnedRef` struct if now unused.

- [ ] **Step 2: Build + run**

Run: `cargo test -p tunnel-manager sui`
Expected: PASS — settle unit tests green; `submit_close` compiles without gas-coin selection.

- [ ] **Step 3: Commit**

```bash
git add -A backend/tunnel-manager
git commit -m "feat(backend): address-balance gas for concurrent settle"
```

> **Deferred (gated, not built here):**
>
> - **E2e node acceptance** on a protocol-v125+ network (localnet/testnet pinned to a `sui` ≥ the address-balance release): submit a real `close_cooperative_with_root` with empty gas payment and assert `effects.status == success`. If it fails, switch to the Redis-leased gas-coin pool (spec §Concurrent settlement fallback). Add this as a `#[ignore]` e2e mirroring the existing localnet settle harness.
> - **PTB batching** of self-play closes (optional throughput optimization) — pre-validate + bisect-retry; PvP stays single. Add when settle volume justifies it.

### Task 4.3: Indexer writes through `ControlStore`

**Files:**

- Modify: `backend/tunnel-manager/src/sui.rs`

- [ ] **Step 1: Rewrite `spawn_event_indexer` to fold events via the store**

Replace the direct `apply_event(map, active, settled, …)` call with `state.control.set_tunnel_status(&tunnel_id, status).await` per event, mapping the event type string to `TunnelStatus` (Created/Active/Closed). Delete `apply_event` (its transition logic now lives in `ControlStore::set_tunnel_status`, idempotent in both impls). Keep the cursor-advance + retry loop unchanged.

```rust
for (etype, tid) in events {
    let status = match etype.rsplit("::").next() {
        Some("TunnelCreated") => Some(TunnelStatus::Created),
        Some("TunnelActivated") => Some(TunnelStatus::Active),
        Some("TunnelClosed" | "TunnelClosedWithRoot") => Some(TunnelStatus::Closed),
        _ => None,
    };
    if let Some(s) = status { state.control.set_tunnel_status(&tid, s).await; }
}
```

The `events_reduce_to_terminal_status_and_maintain_counts` invariant is already covered by `tunnel_events_reduce_to_terminal_and_maintain_counts` in `memory.rs` (Task 1.3) — no duplicate test needed.

- [ ] **Step 2: Build + run; commit**

Run: `cargo test -p tunnel-manager`
Expected: PASS.

```bash
git add -A backend/tunnel-manager
git commit -m "refactor(backend): indexer folds events via ControlStore"
```

---

## Phase 5 — Deploy contract (health, config, Dockerfile)

### Task 5.1: Health endpoints (`/health/live`, `/health/ready` cache-gated)

**Files:**

- Modify: `backend/tunnel-manager/src/routes.rs`
- Modify: `backend/tunnel-manager/src/main.rs`

- [ ] **Step 1: Write the failing test**

```rust
// /health/ready is 200 iff the cache cluster answers (ControlStore::ready); the in-memory store
// is always ready. /health/live is always 200. A pubsub outage must NOT flip readiness (cache-only).
#[tokio::test]
async fn health_ready_reflects_control_store() {
    let state = test_state(); // in-memory => ready() == true
    let code = ready(axum::extract::State(state)).await;
    assert_eq!(code, axum::http::StatusCode::OK);
}
```

- [ ] **Step 2: Run it (fails — `ready` not defined)**

Run: `cargo test -p tunnel-manager health_ready_reflects_control_store`
Expected: FAIL.

- [ ] **Step 3: Add the handlers**

```rust
pub(crate) async fn live() -> StatusCode { StatusCode::OK }

/// 200 iff the CACHE cluster answers. Pubsub is a WS-path soft dependency and is intentionally
/// NOT pinged here (else a pubsub blip would 503 stats/settle and the ALB would drop all targets).
pub(crate) async fn ready(State(state): State<SharedState>) -> StatusCode {
    if state.control.ready().await { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE }
}
```

Keep the existing `health()` returning `"ok"` as the `/healthz` alias.

- [ ] **Step 4: Wire routes in `main.rs`**

```rust
.route("/healthz", get(routes::health))
.route("/health/live", get(routes::live))
.route("/health/ready", get(routes::ready))
```

- [ ] **Step 5: Run; commit**

Run: `cargo test -p tunnel-manager health`
Expected: PASS.

```bash
git add -A backend/tunnel-manager
git commit -m "feat(backend): /health/live + cache-gated /health/ready"
```

### Task 5.2: Config + impl selection

**Files:**

- Modify: `backend/tunnel-manager/src/config.rs`
- Modify: `backend/tunnel-manager/src/main.rs`

- [ ] **Step 1: Add the Redis/instance fields + a test**

In `config.rs`, add to `Config`: `pub redis_cache_url: Option<String>`, `pub redis_pubsub_url: Option<String>`, `pub instance_id: Option<String>`. Read them in `from_env` (`opt("REDIS_CACHE_URL")`, etc.). Add a test:

```rust
#[test]
fn from_env_reads_redis_and_instance() {
    std::env::set_var("REDIS_CACHE_URL", "rediss://cache:6379");
    let c = Config::from_env().unwrap();
    assert_eq!(c.redis_cache_url.as_deref(), Some("rediss://cache:6379"));
    std::env::remove_var("REDIS_CACHE_URL");
}
```

- [ ] **Step 2: Impl selection in `main.rs`**

```rust
let instance_id = config.instance_id.clone().unwrap_or_else(|| Uuid::new_v4().to_string());
let stores = if let Some(cache_url) = config.redis_cache_url.clone() {
    let pubsub_url = Config::require("REDIS_PUBSUB_URL", &config.redis_pubsub_url)?.to_string();
    let cache = store::redis::connect(&cache_url).await?;
    let pubsub = store::redis::connect(&pubsub_url).await?;
    store::Stores {
        control: Arc::new(store::redis::RedisControlStore { pool: cache.clone() }),
        mp: Arc::new(store::redis::RedisMpStore { pool: cache }),
        bus: Arc::new(store::redis::RedisBus::new(instance_id.clone(), pubsub).await),
    }
} else {
    store::Stores {
        control: Arc::new(store::memory::InMemoryControlStore::default()),
        mp: Arc::new(store::memory::InMemoryMpStore::default()),
        bus: Arc::new(store::memory::LocalBus::new(instance_id.clone())),
    }
};
let state: SharedState = Arc::new(AppState {
    instance_id, control: stores.control, mp: stores.mp, bus: stores.bus, settler, walrus, stats_tx,
});
```

- [ ] **Step 3: Run; commit**

Run: `cargo test -p tunnel-manager config`
Expected: PASS. Local dev with no `REDIS_*` uses in-memory impls (spec success criterion #5).

```bash
git add -A backend/tunnel-manager
git commit -m "feat(backend): redis impl selection by env"
```

### Task 5.3: Dockerfile

**Files:**

- Create: `backend/tunnel-manager/Dockerfile`
- Create: `.dockerignore` (repo root, if absent)

- [ ] **Step 1: Write the Dockerfile (build context = repo root)**

```dockerfile
# Build context MUST be the repo root: `-p tunnel-manager` needs the workspace
# Cargo.toml + Cargo.lock, which live at the root (not backend/tunnel-manager/).
FROM rust:1-bookworm AS builder
WORKDIR /app
COPY . .
RUN cargo build --release -p tunnel-manager

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/tunnel-manager /usr/local/bin/tunnel-manager
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/tunnel-manager"]
```

- [ ] **Step 2: Add a `.dockerignore` at the repo root** (avoid shipping build artifacts/secrets)

```
target/
.git/
**/node_modules/
.env
```

- [ ] **Step 3: Build the image from the repo root**

Run: `docker build -f backend/tunnel-manager/Dockerfile -t dopamint-backend:dev .`
Expected: image builds; the binary is present.

- [ ] **Step 4: Verify the container health probe works**

Run:

```bash
docker run --rm -d --name dbtest -p 8080:8080 \
  -e SUI_RPC_URL=http://127.0.0.1:1 -e TUNNEL_PACKAGE_ID=0x2 \
  -e SUI_SETTLER_KEY=$(printf '\0%.0s' {1..32} | base64) \
  -e WALRUS_PUBLISHER_URL=http://x -e WALRUS_AGGREGATOR_URL=http://x \
  dopamint-backend:dev || true
sleep 2
docker exec dbtest curl -fs http://localhost:8080/health/live && echo OK
docker rm -f dbtest
```

Expected: `ok` then `OK` (live is always 200; the settler key is a dummy 32-byte base64). Spec success criterion #4.

- [ ] **Step 5: Commit**

```bash
git add backend/tunnel-manager/Dockerfile .dockerignore
git commit -m "build(backend): multi-stage Dockerfile"
```

---

## Phase 6 — Integration test sweep (testcontainers)

Goal: a CI-runnable integration suite that spins a `redis:7` container and exercises the Redis impls + cross-instance delivery end-to-end, without requiring a hand-run Redis.

### Task 6.1: testcontainers harness

**Files:**

- Create: `backend/tunnel-manager/tests/redis_integration.rs`

- [ ] **Step 1: Write the harness + the four invariants**

```rust
//! Integration: Redis impls under a real redis:7. Gated by testcontainers availability (Docker).
use testcontainers_modules::{redis::Redis, testcontainers::runners::AsyncRunner};
use tunnel_manager::store::{ControlStore, MpStore, Bus, ConnRef}; // requires lib target — see Step 2

#[tokio::test]
async fn redis_impls_uphold_invariants() {
    let node = Redis::default().start().await.unwrap();
    let port = node.get_host_port_ipv4(6379).await.unwrap();
    let url = format!("redis://127.0.0.1:{port}");

    // 1. join_or_pair pairs each waiter exactly once (concurrency).
    // 2. Bus::deliver crosses instances.
    // 3. clear_presence_if only removes the matching conn.
    // 4. ready() flips false→true (already up here => true).
    // (Bodies mirror the #[ignore] tests in store/redis.rs, pointed at `url`.)
}
```

- [ ] **Step 2: Expose a library target so integration tests can import the store**

`tests/` can only import a crate's **library**. Add `src/lib.rs` re-exporting the modules the test needs (`pub mod store; pub mod state; pub mod mp; …`) and have `main.rs` use the lib (`use tunnel_manager::*;`), OR keep the binary-only layout and move these checks into `#[ignore]` unit tests inside `store/redis.rs` driven by `TEST_REDIS_URL` (Phases 2–3 already wrote those). **Recommended:** keep the binary-only crate and rely on the Phase 2–3 `#[ignore]` tests + a CI job that starts redis and sets `TEST_REDIS_URL` — simpler, no lib refactor. If a lib target is wanted later, do it as a separate change.

- [ ] **Step 3: Add the CI job**

In `.github/workflows/ci.yml`, add a `backend-redis-it` job: `services: redis: image: redis:7`, env `TEST_REDIS_URL: redis://localhost:6379`, step `cargo test -p tunnel-manager -- --ignored`. (Confirm `actionlint` passes.)

- [ ] **Step 4: Run the ignored suite against the CI Redis locally**

Run: `docker run -d -p 6379:6379 redis:7 && TEST_REDIS_URL=redis://127.0.0.1:6379 cargo test -p tunnel-manager -- --ignored`
Expected: PASS — join_or_pair (25/25), cross-instance deliver, presence conditional-clear, ready().

- [ ] **Step 5: Commit**

```bash
git add -A backend/tunnel-manager .github/workflows/ci.yml
git commit -m "test(backend): redis integration suite + CI job"
```

---

## Phase 7 — Infra hand-off

### Task 7.1: Record the infra delta for Max

**Files:**

- The infra delta already lives in `docs/decisions/0005-redis-backed-ha-control-plane.md` (§ Infra delta). This task is the hand-off note, not new infra code (infra is a separate repo/owner).

- [ ] **Step 1: Open a tracking issue / PR comment to infra** summarizing the § Infra delta: drop Aurora + RDS Proxy + migration task + DB secrets + DB-restore runbook; keep both Redis clusters (pubsub cluster-mode-enabled); leave Pulumi `Database`/`DatabaseProxy` components dormant; fix the task def env (`REDIS_*` + `SUI_*`/`WALRUS_*`/`TUNNEL_*` + `SUI_SETTLER_KEY` secret); `/health/ready` cache-gated + a pubsub alarm; Docker build context = repo root.

- [ ] **Step 2: No code commit** (doc + hand-off only). Confirm the ADR's § Infra delta is current.

---

## Self-Review

**Spec coverage:**

- Storage seam (in-memory + Redis): Phases 1–2 ✓
- `Bus::deliver` + per-instance subscription: Phase 3 ✓
- Atomic `join_or_pair` Lua: Task 2.2 ✓
- Stats counters + per-instance SSE same global numbers: `add_actions`/`snapshot` (write-time counters + SADD sets) + broadcaster diff (Task 1.3, 2.1, 1.5 step 6) ✓
- Concurrent settlement (address-balance gas): Phase 4 ✓ (e2e + batching explicitly deferred/gated)
- Health endpoints (cache-gated ready): Task 5.1 ✓
- Config + impl selection: Task 5.2 ✓
- Dockerfile (context = root): Task 5.3 ✓
- Disconnect cleanup (conditional presence + leave queues): Task 3.2 ✓
- Integration tests (concurrency, cross-instance, presence, ready): Phases 2/3/6 ✓
- Infra hand-off: Phase 7 ✓

**Type consistency:** `ConnRef { instance_id, conn_id }`, `Waiting { wallet, conn: ConnRef }`, `MatchRecord` seats on `ConnRef`, trait method names (`join_or_pair`, `clear_presence_if`, `deliver`, `register`/`unregister`/`instance_id`, `set_tunnel_status`, `add_actions`, `snapshot`, `ready`) are used identically across Tasks 1.1 → 6. `StatsSnapshot.tps` is filled by the broadcaster (stores return tps=0).

**Known judgment calls (flagged, not placeholders):**

- `fred` pub/sub method names are version-sensitive — pinned by compile + the Phase-3 integration test (Task 0.1 note, Task 3.1 note).
- Per-game tunnel count is maintained at register time (`stats:tunnels:game:<g>` counter) instead of the old per-tick session scan — a deliberate read/write-model fix, noted in Task 1.3.
- Integration tests run via `#[ignore]` + `TEST_REDIS_URL` + a CI Redis service (Task 6.1 step 2) rather than forcing a lib-target refactor — simpler; lib target deferred.
- E2e node-acceptance of empty-payment gas and PTB batching are deferred and gated (Task 4.2 note), matching the spec.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-17-redis-backed-ha-backend.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
