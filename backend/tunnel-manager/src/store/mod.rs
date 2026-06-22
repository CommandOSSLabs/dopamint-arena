//! Storage seam: the in-memory impl (today's maps/atomics; tests + local dev) and the Redis
//! impl (prod/HA) live behind these traits. Handlers hold `Arc<dyn …>` and never see Redis.

pub mod memory;
pub mod redis;

use async_trait::async_trait;

/// Bounded depth of the recent-events display ring (ADR-0005). Newest-first; older rows
/// fall off. The durable record lives on-chain + Walrus, so this is display-only.
pub const RECENT_EVENTS_CAP: usize = 50;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ConnRef {
    pub instance_id: String,
    pub conn_id: crate::mp::ConnId,
}

#[async_trait]
pub trait ControlStore: Send + Sync {
    async fn put_session(&self, id: &str, rec: crate::state::SessionRecord);
    async fn get_session(&self, id: &str) -> Option<crate::state::SessionRecord>;
    async fn set_tunnel_status(&self, id: &str, s: crate::state::TunnelStatus);
    async fn get_tunnel_status(&self, id: &str) -> Option<crate::state::TunnelStatus>;
    async fn add_actions(&self, game: &str, delta: u64);
    /// Cumulative snapshot; `tps` is filled by the broadcaster from its per-tick diff.
    async fn snapshot(&self) -> crate::state::StatsSnapshot;
    /// Append a displayable lifecycle row to the bounded recent-events ring, idempotent by
    /// `tx_digest` (cursor-restart replays and multi-instance indexers must not double-insert).
    async fn push_recent_event(&self, ev: crate::state::TunnelEvent);
    /// The ring, newest-first, capped at `RECENT_EVENTS_CAP`.
    async fn recent_events(&self) -> Vec<crate::state::TunnelEvent>;
    /// PING the cache cluster (for /health/ready). In-memory is always ready.
    async fn ready(&self) -> bool;
}

#[async_trait]
pub trait MpStore: Send + Sync {
    async fn set_presence(&self, wallet: &str, at: ConnRef);
    async fn get_presence(&self, wallet: &str) -> Option<ConnRef>;
    async fn clear_presence_if(&self, wallet: &str, conn: crate::mp::ConnId);
    /// Join the queue. Returns the earlier waiter (opponent) if one was parked, else parks self.
    async fn join_or_pair(&self, game: &str, me: crate::mp::Waiting) -> Option<crate::mp::Waiting>;
    async fn leave_queue(&self, game: &str, wallet: &str);
    async fn put_invite(&self, match_id: &str, inv: crate::mp::DirectedInvite);
    async fn take_invite(
        &self,
        match_id: &str,
        accepter: &str,
    ) -> Option<crate::mp::DirectedInvite>;
    async fn drop_invite(&self, match_id: &str);
    async fn put_match(&self, match_id: &str, m: crate::mp::MatchRecord);
    async fn get_match(&self, match_id: &str) -> Option<crate::mp::MatchRecord>;
    async fn set_tunnel_id(&self, match_id: &str, tunnel_id: &str);
    async fn record_checkpoint(&self, match_id: &str, cp: crate::mp::Checkpoint);
}

#[async_trait]
pub trait Bus: Send + Sync {
    fn instance_id(&self) -> &str;
    fn register(&self, conn: crate::mp::ConnId, tx: tokio::sync::mpsc::UnboundedSender<String>);
    fn unregister(&self, conn: crate::mp::ConnId);
    async fn deliver(&self, target: &ConnRef, text: String);
    /// Fire-and-forget publish to a Redis channel (cross-service signal). In-memory is a no-op.
    async fn publish_raw(&self, channel: &str, payload: String);
}
