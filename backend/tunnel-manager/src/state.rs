//! Shared application state + the stats wire types. The registry here is in-memory;
//! the authoritative tunnel registry becomes on-chain events in Phase 3 (ADR-0002).

use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::RwLock;

use serde::Serialize;
use tokio::sync::{broadcast, mpsc};

use crate::mp::{ConnId, DirectedInvite, GameId, GameQueue, MatchId, MatchRecord, Wallet};
use crate::routes::TunnelRef;

pub struct SessionRecord {
    pub game: String,
    pub tunnels: Vec<TunnelRef>,
    /// Bearer token returned by `POST /sessions`; required on this session's writes.
    pub stats_token: String,
}

/// A tunnel's lifecycle status, derived from on-chain events (ADR-0002: events are
/// the authoritative registry; `POST /sessions` is advisory grouping only).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TunnelStatus {
    Created,
    Active,
    Closed,
}

pub struct AppState {
    pub sessions: RwLock<HashMap<String, SessionRecord>>,
    pub total_actions: AtomicU64,
    /// Event-derived counts, maintained at write time by the indexer (the single
    /// controlled writer) so the stats tick reads them O(1) — no per-tick map scan.
    pub active_tunnels: AtomicU64,
    pub settled_tunnels: AtomicU64,
    /// Per-tunnel status, folded from on-chain events. Retained (not evicted) so the
    /// poll loop's cursor replay on restart stays idempotent.
    pub tunnels: RwLock<HashMap<String, TunnelStatus>>,
    /// Cumulative off-chain actions attributed per game (maintained at heartbeat write
    /// time). The broadcaster turns the per-tick delta into per-game TPS.
    pub per_game_actions: RwLock<HashMap<String, u64>>,
    /// Submits cooperative closes on-chain (non-party gas payer). See `crate::sui`.
    pub settler: crate::sui::SuiSettler,
    /// Archives off-chain transcripts to Walrus at settle. See `crate::walrus`.
    pub walrus: crate::walrus::WalrusClient,
    /// Latest aggregate snapshot is computed once per tick and fanned out here to
    /// every SSE subscriber — so cost scales with the audience, not with TPS.
    pub stats_tx: broadcast::Sender<String>,

    // ===== Multiplayer (ADR-0004). In-memory; bounded by concurrent players, not moves. =====
    /// Who is online, by wallet → their live connection.
    pub presence: RwLock<HashMap<Wallet, ConnId>>,
    /// Quick-Match waiters, per game.
    pub queues: RwLock<HashMap<GameId, GameQueue>>,
    /// Outstanding directed invites, by match id.
    pub invites: RwLock<HashMap<MatchId, DirectedInvite>>,
    /// Live/forming matches: seats, tunnel id, latest co-signed checkpoint (watchtower).
    pub matches: RwLock<HashMap<MatchId, MatchRecord>>,
    /// Per-connection outbound channel so matchmaking/relay can push JSON to a socket.
    pub conns: RwLock<HashMap<ConnId, mpsc::UnboundedSender<String>>>,
}

pub type SharedState = std::sync::Arc<AppState>;

// ===== Stats wire types — JSON is camelCase to match the SDK (see ADR-0002). =====

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsSnapshot {
    pub tps: u64,
    pub total_actions: u64,
    pub active_tunnels: u64,
    pub settled_tunnels: u64,
    pub per_game: HashMap<String, GameStat>,
}

#[derive(Debug, Serialize)]
pub struct GameStat {
    pub tps: u64,
    pub tunnels: u64,
    /// Cumulative actions attributed to this game (basis for `tps`'s per-tick delta).
    pub total_actions: u64,
}
