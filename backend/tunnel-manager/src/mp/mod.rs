//! Multiplayer experience lane (ADR-0004): a STATEFUL service beside the stateless
//! control-plane. Presence + matchmaking + opaque-frame relay + watchtower capture.
//! NEVER signs a move and is NEVER a counterparty.

pub mod auth;
pub mod matchmaking;
pub mod protocol;
pub mod relay;
pub mod ws;

use std::collections::VecDeque;

use uuid::Uuid;

pub type Wallet = String;
pub type GameId = String;
pub type MatchId = String;
pub type ConnId = Uuid;

/// A player parked in a Quick-Match queue for one game.
#[derive(Debug, Clone)]
pub struct Waiting {
    pub wallet: Wallet,
    pub conn: ConnId,
}

/// A directed Challenge-by-wallet invite awaiting accept/decline.
#[derive(Debug, Clone)]
pub struct DirectedInvite {
    pub from: Wallet,
    pub to: Wallet,
    pub game: GameId,
    pub from_conn: ConnId,
}

/// The latest fully co-signed update for a match — the watchtower's defense material.
/// Captured from an explicit `watchtower.checkpoint` (NOT by parsing relay frames).
#[derive(Debug, Clone)]
pub struct Checkpoint {
    pub nonce: u64,
    pub party_a_balance: u64,
    pub party_b_balance: u64,
    pub state_hash: String,
    pub sig_a: String,
    pub sig_b: String,
}

/// A live or forming match. Seats are wallets; `tunnel_id` is filled once the opener
/// announces it via `tunnel.opened`.
#[derive(Debug, Clone)]
pub struct MatchRecord {
    pub game: GameId,
    pub seat_a: Wallet,
    pub seat_b: Wallet,
    pub conn_a: ConnId,
    pub conn_b: ConnId,
    pub tunnel_id: Option<String>,
    pub latest_checkpoint: Option<Checkpoint>,
}

/// FIFO Quick-Match queue per game.
pub type GameQueue = VecDeque<Waiting>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn match_record_starts_without_tunnel_or_checkpoint() {
        let m = MatchRecord {
            game: "ttt".into(),
            seat_a: "0xa".into(),
            seat_b: "0xb".into(),
            conn_a: Uuid::nil(),
            conn_b: Uuid::nil(),
            tunnel_id: None,
            latest_checkpoint: None,
        };
        assert!(m.tunnel_id.is_none());
        assert!(m.latest_checkpoint.is_none());
    }
}
