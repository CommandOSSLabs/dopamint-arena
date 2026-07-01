//! Bot-fleet: the WS-client deployment of the serving fleet — server-side bots that play real
//! human users at blackjack over the relay as genuine two-party state-channel games (ADR-0024).
//!
//! The transport-agnostic orchestration (`play_match`, `MatchChannel`, the `RelayTransport` seam,
//! anchor, peer protocol, signer) lives in [`fleet_core`] and is shared with the co-located
//! game-server. This crate adds only the WebSocket transport: [`relay_client`] (`/v1/mp` connect +
//! matchmaking, `WsRelayTransport`), [`relay_wire`] (the wire mirror), and [`live_runner`] (connect
//! → match → drive `play_match`). The `fleet_core` modules are re-exported so `bot_fleet::…` paths
//! stay stable for the bins and tests.

pub mod live_runner;
pub mod relay_client;
pub mod relay_wire;

pub use fleet_core::{
    match_channel, peer, play_match, relay_channel, relay_envelope, relay_ws, signer_durable,
    MatchInfo, Role,
};
