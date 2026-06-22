//! In-memory impls of `ControlStore`, `MpStore`, and `Bus`. Today's `RwLock`
//! maps/atomics lifted here. Selected when no `REDIS_CACHE_URL` is set.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;

use async_trait::async_trait;
use tokio::sync::mpsc;

use super::{Bus, ConnRef, ControlStore, MpStore};
use crate::mp::{Checkpoint, ConnId, DirectedInvite, MatchRecord, Waiting};
use crate::state::{GameStat, SessionRecord, StatsSnapshot, TunnelEvent, TunnelStatus};

// ===== ControlStore =====

#[derive(Default)]
pub struct InMemoryControlStore {
    sessions: RwLock<HashMap<String, SessionRecord>>,
    tunnels: RwLock<HashMap<String, TunnelStatus>>,
    total_actions: AtomicU64,
    active_tunnels: AtomicU64,
    settled_tunnels: AtomicU64,
    per_game_actions: RwLock<HashMap<String, u64>>,
    // Maintained at put_session time (replaces the old per-tick session scan in stats.rs).
    per_game_tunnels: RwLock<HashMap<String, u64>>,
    recent_ring: RwLock<VecDeque<TunnelEvent>>,
    seen_digests: RwLock<HashSet<String>>,
}

#[async_trait]
impl ControlStore for InMemoryControlStore {
    async fn put_session(&self, id: &str, rec: SessionRecord) {
        *self
            .per_game_tunnels
            .write()
            .unwrap()
            .entry(rec.game.clone())
            .or_insert(0) += rec.tunnels.len() as u64;
        self.sessions.write().unwrap().insert(id.to_owned(), rec);
    }

    async fn get_session(&self, id: &str) -> Option<SessionRecord> {
        self.sessions.read().unwrap().get(id).cloned()
    }

    async fn set_tunnel_status(&self, id: &str, s: TunnelStatus) {
        let mut map = self.tunnels.write().unwrap();
        let prev = map.insert(id.to_owned(), s);
        let was_active = matches!(prev, Some(TunnelStatus::Active));
        match s {
            TunnelStatus::Active if !was_active => {
                self.active_tunnels.fetch_add(1, Ordering::Relaxed);
            }
            TunnelStatus::Closed if !matches!(prev, Some(TunnelStatus::Closed)) => {
                if was_active {
                    self.active_tunnels.fetch_sub(1, Ordering::Relaxed);
                }
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
        *self
            .per_game_actions
            .write()
            .unwrap()
            .entry(game.to_owned())
            .or_insert(0) += delta;
    }

    async fn snapshot(&self) -> StatsSnapshot {
        let actions = self.per_game_actions.read().unwrap();
        let tunnels = self.per_game_tunnels.read().unwrap();
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
            total_actions: self.total_actions.load(Ordering::Relaxed),
            active_tunnels: self.active_tunnels.load(Ordering::Relaxed),
            settled_tunnels: self.settled_tunnels.load(Ordering::Relaxed),
            per_game,
            recent_events: self.recent_ring.read().unwrap().iter().cloned().collect(),
        }
    }

    async fn push_recent_event(&self, ev: TunnelEvent) {
        let mut seen = self.seen_digests.write().unwrap();
        let mut ring = self.recent_ring.write().unwrap();
        if seen.insert(ev.tx_digest.clone()) {
            ring.push_front(ev);
            ring.truncate(super::RECENT_EVENTS_CAP);
            return;
        }
        // Already recorded. The /settle handler's enriched row (with a Walrus proofUrl) and the
        // event indexer's bare row race for the same digest; whichever lands first claims it.
        // The handler loses that race when Walrus upload delays its push past the indexer's 1s
        // poll — so upgrade the stored row in place when this one carries a proofUrl it lacks,
        // and never downgrade an existing one.
        if ev.proof_url.is_some() {
            if let Some(row) = ring.iter_mut().find(|r| r.tx_digest == ev.tx_digest) {
                if row.proof_url.is_none() {
                    row.proof_url = ev.proof_url;
                }
            }
        }
    }

    async fn recent_events(&self) -> Vec<TunnelEvent> {
        self.recent_ring.read().unwrap().iter().cloned().collect()
    }

    async fn ready(&self) -> bool {
        true
    }
}

// ===== MpStore =====

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
        if p.get(wallet).map(|c| c.conn_id) == Some(conn) {
            p.remove(wallet);
        }
    }

    async fn join_or_pair(&self, game: &str, me: Waiting) -> Option<Waiting> {
        let mut queues = self.queues.write().unwrap();
        let q = queues.entry(game.to_owned()).or_default();
        // Drop stale self entry so a reconnect re-queues cleanly.
        q.retain(|w| w.wallet != me.wallet);
        if let Some(front) = q.pop_front() {
            Some(front)
        } else {
            q.push_back(me);
            None
        }
    }

    async fn leave_queue(&self, game: &str, wallet: &str) {
        if let Some(q) = self.queues.write().unwrap().get_mut(game) {
            q.retain(|w| w.wallet != wallet);
        }
    }

    async fn put_invite(&self, match_id: &str, inv: DirectedInvite) {
        self.invites
            .write()
            .unwrap()
            .insert(match_id.to_owned(), inv);
    }

    async fn take_invite(&self, match_id: &str, accepter: &str) -> Option<DirectedInvite> {
        let mut inv = self.invites.write().unwrap();
        match inv.get(match_id) {
            Some(i) if i.to == accepter => inv.remove(match_id),
            _ => None,
        }
    }

    async fn drop_invite(&self, match_id: &str) {
        self.invites.write().unwrap().remove(match_id);
    }

    async fn put_match(&self, match_id: &str, m: MatchRecord) {
        self.matches.write().unwrap().insert(match_id.to_owned(), m);
    }

    async fn get_match(&self, match_id: &str) -> Option<MatchRecord> {
        self.matches.read().unwrap().get(match_id).cloned()
    }

    async fn set_tunnel_id(&self, match_id: &str, tunnel_id: &str) {
        if let Some(m) = self.matches.write().unwrap().get_mut(match_id) {
            m.tunnel_id = Some(tunnel_id.to_owned());
        }
    }

    async fn record_checkpoint(&self, match_id: &str, cp: Checkpoint) {
        if let Some(m) = self.matches.write().unwrap().get_mut(match_id) {
            if m.latest_checkpoint
                .as_ref()
                .map_or(true, |c| cp.nonce >= c.nonce)
            {
                m.latest_checkpoint = Some(cp);
            }
        }
    }
}

// ===== Bus =====

pub struct LocalBus {
    instance_id: String,
    conns: RwLock<HashMap<ConnId, mpsc::UnboundedSender<String>>>,
}

impl LocalBus {
    pub fn new(instance_id: String) -> Self {
        Self {
            instance_id,
            conns: RwLock::new(HashMap::new()),
        }
    }
}

#[async_trait]
impl Bus for LocalBus {
    fn instance_id(&self) -> &str {
        &self.instance_id
    }

    fn register(&self, conn: ConnId, tx: mpsc::UnboundedSender<String>) {
        self.conns.write().unwrap().insert(conn, tx);
    }

    fn unregister(&self, conn: ConnId) {
        self.conns.write().unwrap().remove(&conn);
    }

    async fn deliver(&self, target: &ConnRef, text: String) {
        // Single instance: target is always local. (Phase 3 adds the cross-instance branch.)
        if let Some(tx) = self.conns.read().unwrap().get(&target.conn_id) {
            let _ = tx.send(text);
        }
    }

    async fn publish_raw(&self, channel: &str, payload: String) {
        let _ = (channel, payload);
    }
}

// ===== Tests =====
// These cover ControlStore and MpStore invariants; relay routing moves into ws.rs.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{TunnelEvent, TunnelEventKind, TunnelStatus};

    fn settled(tunnel: &str, digest: &str) -> TunnelEvent {
        TunnelEvent {
            tunnel_id: tunnel.into(),
            kind: TunnelEventKind::Settled,
            party_a_balance: Some(1),
            party_b_balance: Some(1),
            transcript_root: None,
            tx_digest: digest.into(),
            timestamp_ms: 1,
            proof_url: None,
        }
    }

    // A pushed event must appear in the broadcast snapshot — that is how the dashboard receives
    // the feed (it rides the existing /v1/stats/live SSE; no new endpoint).
    #[tokio::test]
    async fn snapshot_includes_recent_events() {
        let s = InMemoryControlStore::default();
        s.push_recent_event(settled("0xt", "dig1")).await;
        let snap = s.snapshot().await;
        assert_eq!(snap.recent_events.len(), 1);
        assert_eq!(snap.recent_events[0].tx_digest, "dig1");
    }

    // Newest-first, capped, and idempotent by tx_digest: a re-polled event (cursor restart /
    // second indexer) must NOT create a duplicate row. This is success criterion #3 in the spec.
    #[tokio::test]
    async fn recent_events_are_newest_first_capped_and_deduped() {
        let s = InMemoryControlStore::default();
        for i in 0..(crate::store::RECENT_EVENTS_CAP + 5) {
            s.push_recent_event(settled(&format!("0x{i}"), &format!("d{i}")))
                .await;
        }
        s.push_recent_event(settled("0x0", "d0")).await; // replay of the oldest — must be a no-op
        let got = s.recent_events().await;
        assert_eq!(got.len(), crate::store::RECENT_EVENTS_CAP, "ring is capped");
        let newest = crate::store::RECENT_EVENTS_CAP + 4;
        assert_eq!(got[0].tx_digest, format!("d{newest}"), "newest first");
    }

    // The /settle handler's enriched row (with a Walrus proofUrl) and the indexer's bare row
    // race for the same tx_digest. The proofUrl MUST survive regardless of arrival order: a
    // later enriched row upgrades a bare one (the real case — Walrus upload makes the handler
    // lose the race), and a later bare row never erases an existing proofUrl. Without this the
    // Transaction Log shows a successful settle with no proof link.
    #[tokio::test]
    async fn proof_url_survives_indexer_handler_race_either_order() {
        let proof = "https://agg/v1/blobs/xyz";
        let enriched = |t, d| TunnelEvent {
            proof_url: Some(proof.into()),
            ..settled(t, d)
        };

        // indexer (bare) first, then handler (enriched): the bare row is upgraded.
        let s = InMemoryControlStore::default();
        s.push_recent_event(settled("0xt", "d")).await;
        s.push_recent_event(enriched("0xt", "d")).await;
        let got = s.recent_events().await;
        assert_eq!(got.len(), 1, "still one row (deduped by digest)");
        assert_eq!(
            got[0].proof_url.as_deref(),
            Some(proof),
            "bare row upgraded to the proofUrl"
        );

        // handler (enriched) first, then indexer (bare): the proofUrl is not downgraded.
        let s2 = InMemoryControlStore::default();
        s2.push_recent_event(enriched("0xt", "d")).await;
        s2.push_recent_event(settled("0xt", "d")).await;
        let got2 = s2.recent_events().await;
        assert_eq!(got2.len(), 1);
        assert_eq!(
            got2[0].proof_url.as_deref(),
            Some(proof),
            "bare row never downgrades a proofUrl"
        );
    }

    // Heartbeat deltas must accrue to the session's game. Moved from routes.rs.
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

    // Created→Active→Closed reduces correctly; replay (cursor restart) is idempotent.
    // Moved from sui.rs::events_reduce_to_terminal_status_and_maintain_counts.
    #[tokio::test]
    async fn tunnel_events_reduce_to_terminal_and_maintain_counts() {
        let s = InMemoryControlStore::default();
        s.set_tunnel_status("0xt", TunnelStatus::Created).await;
        s.set_tunnel_status("0xt", TunnelStatus::Active).await;
        let snap = s.snapshot().await;
        assert_eq!(snap.active_tunnels, 1);
        s.set_tunnel_status("0xt", TunnelStatus::Closed).await;
        s.set_tunnel_status("0xt", TunnelStatus::Closed).await; // replay — no-op
        let snap = s.snapshot().await;
        assert_eq!((snap.active_tunnels, snap.settled_tunnels), (0, 1));
    }

    fn cr() -> ConnRef {
        ConnRef {
            instance_id: "i".into(),
            conn_id: uuid::Uuid::new_v4(),
        }
    }

    // First joiner parks; second joiner gets back the earlier waiter (seat A).
    #[tokio::test]
    async fn join_or_pair_returns_the_earlier_waiter_then_drains() {
        let s = InMemoryMpStore::default();
        let a = Waiting {
            wallet: "0xa".into(),
            conn: cr(),
        };
        let b = Waiting {
            wallet: "0xb".into(),
            conn: cr(),
        };
        assert!(
            s.join_or_pair("ttt", a.clone()).await.is_none(),
            "first parks"
        );
        let opp = s.join_or_pair("ttt", b).await.expect("second pairs");
        assert_eq!(opp.wallet, "0xa", "opponent is the earlier waiter (seat A)");
    }

    // Players queued for different games never pair.
    #[tokio::test]
    async fn join_or_pair_is_per_game() {
        let s = InMemoryMpStore::default();
        assert!(s
            .join_or_pair(
                "ttt",
                Waiting {
                    wallet: "0xa".into(),
                    conn: cr()
                }
            )
            .await
            .is_none());
        assert!(s
            .join_or_pair(
                "chess",
                Waiting {
                    wallet: "0xb".into(),
                    conn: cr()
                }
            )
            .await
            .is_none());
    }

    // Only the invited wallet can accept; a wrong wallet returns None.
    #[tokio::test]
    async fn challenge_accept_requires_the_invited_wallet() {
        let s = InMemoryMpStore::default();
        let inv = DirectedInvite {
            from: "0xa".into(),
            to: "0xb".into(),
            game: "ttt".into(),
            from_conn: ConnRef {
                instance_id: "i".into(),
                conn_id: uuid::Uuid::nil(),
            },
        };
        s.put_invite("mid1", inv).await;
        assert!(s.take_invite("mid1", "0xWRONG").await.is_none());
        let got = s.take_invite("mid1", "0xb").await.expect("accept");
        assert_eq!(got.from, "0xa");
        // invite is consumed
        assert!(s.take_invite("mid1", "0xb").await.is_none());
    }

    // A newer checkpoint supersedes an older one; a stale lower-nonce one is ignored.
    #[tokio::test]
    async fn record_checkpoint_keeps_highest_nonce() {
        let s = InMemoryMpStore::default();
        let cr_ref = ConnRef {
            instance_id: "i".into(),
            conn_id: uuid::Uuid::nil(),
        };
        s.put_match(
            "m",
            MatchRecord {
                game: "ttt".into(),
                seat_a: "0xa".into(),
                seat_b: "0xb".into(),
                conn_a: cr_ref.clone(),
                conn_b: cr_ref,
                tunnel_id: None,
                latest_checkpoint: None,
            },
        )
        .await;
        let cp = |n| Checkpoint {
            nonce: n,
            party_a_balance: 1,
            party_b_balance: 1,
            state_hash: "h".into(),
            sig_a: "a".into(),
            sig_b: "b".into(),
        };
        s.record_checkpoint("m", cp(5)).await;
        s.record_checkpoint("m", cp(3)).await; // stale
        assert_eq!(
            s.get_match("m")
                .await
                .unwrap()
                .latest_checkpoint
                .unwrap()
                .nonce,
            5
        );
    }
}
