//! Shared application state + the stats wire types.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

pub struct AppState {
    pub control: std::sync::Arc<dyn crate::store::ControlStore>,
    pub mp: std::sync::Arc<dyn crate::store::MpStore>,
    pub bus: std::sync::Arc<dyn crate::store::Bus>,
    pub settler: crate::sui::SuiSettler,
    pub walrus: crate::walrus::WalrusClient,
    /// Latest aggregate snapshot is computed once per tick and fanned out here to
    /// every SSE subscriber — so cost scales with the audience, not with TPS.
    pub stats_tx: broadcast::Sender<String>,
}

pub type SharedState = std::sync::Arc<AppState>;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SessionRecord {
    pub game: String,
    pub tunnels: Vec<crate::routes::TunnelRef>,
    /// Bearer token returned by `POST /sessions`; required on this session's writes.
    pub stats_token: String,
}

/// A tunnel's lifecycle status, derived from on-chain events (ADR-0002: events are
/// the authoritative registry; `POST /sessions` is advisory grouping only).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TunnelStatus {
    Created,
    Active,
    Closed,
}

// ===== Stats wire types — JSON is camelCase to match the SDK (see ADR-0002). =====

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsSnapshot {
    pub tps: f64,
    pub total_actions: u64,
    pub active_tunnels: u64,
    pub settled_tunnels: u64,
    pub per_game: HashMap<String, GameStat>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GameStat {
    pub tps: f64,
    pub tunnels: u64,
    /// Cumulative actions attributed to this game (basis for `tps`'s per-tick delta).
    pub total_actions: u64,
}
