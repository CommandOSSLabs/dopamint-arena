//! Storage seam: the in-memory impl (today's maps/atomics; tests + local dev) and the Redis
//! impl (prod/HA) live behind these traits. Handlers hold `Arc<dyn …>` and never see Redis.
//!
//! ## Aggregation invariant
//! Each instance pushes only its own deltas into a merge-commutative primitive; no method
//! read-modify-writes a shared aggregate. Three shapes: counts → `INCRBY` (grow-only,
//! order-independent); membership → `SADD`/`SREM` (idempotent union); owned/last-writer →
//! single key + CAS (Lua), never summed. The move counter is at-most-once (undercount-safe):
//! it only ever pushes already-counted deltas, so it never inflates — do NOT add flush
//! retries, which would make it at-least-once and double-count.

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
}

/// Per-connection control signal routed over the bus ctrl channel (parallel to the hot-path
/// client channel). `Evict` drops a match from the connection's relay cache; `Populate` warms it
/// with a freshly-created record so a never-relayed seat still has the match cached. The record is
/// boxed to keep `Evict` (the common signal) cheap to move and the enum small.
#[derive(Debug)]
pub enum CtrlMsg {
    Evict(String),
    Populate(String, Box<crate::mp::MatchRecord>),
}

#[async_trait]
pub trait Bus: Send + Sync {
    fn instance_id(&self) -> &str;
    /// `client_tx` carries client-bound frames (written to the socket). `ctrl_tx` carries
    /// internal control signals — match-cache evict/populate. Kept separate so control never
    /// competes with or parses the hot-path frame stream.
    fn register(
        &self,
        conn: crate::mp::ConnId,
        client_tx: tokio::sync::mpsc::UnboundedSender<String>,
        ctrl_tx: tokio::sync::mpsc::UnboundedSender<CtrlMsg>,
    );
    fn unregister(&self, conn: crate::mp::ConnId);
    async fn deliver(&self, target: &ConnRef, text: String);
    /// Fire-and-forget publish to a Redis channel (cross-service signal). In-memory is a no-op.
    async fn publish_raw(&self, channel: &str, payload: String);
    /// Tell `target`'s connection task to drop `match_id` from its relay cache (so its next
    /// relay re-reads the match and picks up a rebound peer `ConnRef`). Routes locally or via
    /// the cross-instance pub/sub channel. No-op if the target is unknown.
    async fn evict(&self, target: &ConnRef, match_id: &str);
    /// Warm `target`'s relay cache with a freshly-created match record (so a seat that has not yet
    /// relayed still has the match cached for disconnect-notify and first-relay-without-GET). Routes
    /// locally or via the cross-instance pub/sub channel. No-op if the target is unknown.
    async fn populate(&self, target: &ConnRef, match_id: &str, rec: &crate::mp::MatchRecord);
}
