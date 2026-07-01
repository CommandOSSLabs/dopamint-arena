//! Multiplayer experience lane (ADR-0004): a STATEFUL service beside the stateless
//! control-plane. Presence + matchmaking + opaque-frame relay + watchtower capture.
//! NEVER signs a move and is NEVER a counterparty.

pub mod auth;
pub mod protocol;
pub mod ws;

use uuid::Uuid;

use crate::store::ConnRef;

pub type Wallet = String;
pub type GameId = String;
pub type ConnId = Uuid;

/// A player parked in a Quick-Match queue for one game.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Waiting {
    pub wallet: Wallet,
    pub conn: ConnRef,
    /// True for a fleet bot. Two bots are NEVER paired (a bot only ever plays a human); the
    /// matchmaker skips a candidate when both sides are bots. Defaults false so existing
    /// (human) clients and any pre-`is_bot` queue entries decode as humans.
    #[serde(default)]
    pub is_bot: bool,
}

/// The fleet invariant: a bot is NEVER paired with another bot — a bot only ever plays a human.
/// The matchmaker consults this when picking a candidate. The Redis `JOIN_OR_PAIR`/`FALLBACK_PAIR`
/// Lua mirrors this guard inline (`not (me_bot and w.is_bot)`); keep the two in sync.
pub fn pairing_allowed(me_is_bot: bool, candidate_is_bot: bool) -> bool {
    !(me_is_bot && candidate_is_bot)
}

/// A directed Challenge-by-wallet invite awaiting accept/decline.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DirectedInvite {
    pub from: Wallet,
    pub to: Wallet,
    pub game: GameId,
    pub from_conn: ConnRef,
}

/// The latest fully co-signed update for a match — the watchtower's defense material.
/// Captured from an explicit `watchtower.checkpoint` (NOT by parsing relay frames).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Checkpoint {
    pub nonce: u64,
    pub party_a_balance: u64,
    pub party_b_balance: u64,
    pub state_hash: String,
    pub sig_a: String,
    pub sig_b: String,
}

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

/// A live or forming match. Seats are wallets; `tunnel_id` is filled once the opener
/// announces it via `tunnel.opened`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MatchRecord {
    pub game: GameId,
    pub seat_a: Wallet,
    pub seat_b: Wallet,
    pub conn_a: ConnRef,
    pub conn_b: ConnRef,
    pub tunnel_id: Option<String>,
    pub latest_checkpoint: Option<Checkpoint>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn match_record_starts_without_tunnel_or_checkpoint() {
        let cr = ConnRef {
            instance_id: "i".into(),
            conn_id: Uuid::nil(),
        };
        let m = MatchRecord {
            game: "ttt".into(),
            seat_a: "0xa".into(),
            seat_b: "0xb".into(),
            conn_a: cr.clone(),
            conn_b: cr,
            tunnel_id: None,
            latest_checkpoint: None,
        };
        assert!(m.tunnel_id.is_none());
        assert!(m.latest_checkpoint.is_none());
    }
}
