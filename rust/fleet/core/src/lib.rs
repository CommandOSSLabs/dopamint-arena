//! `fleet-core` — the transport-agnostic serving-fleet orchestration (ADR-0020/0024).
//!
//! One shared `play_match` drives a genuine two-party match for ANY game over the
//! [`relay_ws::RelayTransport`] seam, demuxed by [`match_channel::MatchChannel`]. Both fleet
//! deployments depend on this and supply only a transport:
//!   * the WS-client `bot-fleet` (its `WsRelayTransport` over `/v1/mp`), and
//!   * the co-located game-server in `tunnel-manager` (a bus-channel transport).
//!
//! Deliberately free of WebSocket deps so the relay can consume it without a WS client in its
//! binary. On-chain open/settle is the [`anchor::MatchAnchor`] seam (sans-IO engine has no builder).

pub mod anchor;
pub mod match_channel;
pub mod peer;
pub mod play_match;
pub mod relay_channel;
pub mod relay_envelope;
pub mod relay_ws;
pub mod signer_durable;

/// A match seat as assigned by the relay's `match.found` (`role: "A" | "B"`). The per-game
/// `GameProfile` decides which seat hosts the tunnel + submits settle (blackjack = dealer/`B`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Role {
    A,
    B,
}

impl Role {
    pub fn seat(self) -> tunnel_harness::Seat {
        match self {
            Role::A => tunnel_harness::Seat::A,
            Role::B => tunnel_harness::Seat::B,
        }
    }
}

/// The match assignment a transport hands to [`play_match::play_match`]: which relay match, this
/// bot's seat, and the opponent's wallet label. Transport-agnostic (WS or in-process bus).
#[derive(Clone, Debug)]
pub struct MatchInfo {
    pub match_id: String,
    pub role: Role,
    pub opponent_wallet: String,
}
