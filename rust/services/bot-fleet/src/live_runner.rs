//! WS live runners: connect to the relay, wait to be matched, and drive `fleet_core::play_match`
//! over the WebSocket transport. The transport-agnostic orchestration lives in `fleet-core`; this
//! is the WS-client deployment's thin entry (ADR-0024). The co-located game-server supplies its own
//! bus-channel runner instead.

use std::sync::Arc;

use anyhow::Result;
use tunnel_blackjack::{Blackjack, BlackjackStrategy};
use tunnel_harness::{MoveStrategy, Protocol, Signer};

use crate::relay_client::{RelayConfig, RelayConnection, WsRelayTransport};
use fleet_core::anchor::MatchAnchor;
use fleet_core::match_channel::MatchChannel;
use fleet_core::play_match::{play_match, GameProfile, MatchOutcome, BLACKJACK};
use fleet_core::signer_durable::DurableSigner;

/// Generic live runner for ANY game: connect, wait to be matched, play one match over the live WS
/// driving the supplied `protocol` + `strategy`. Adding a game = call this with that game's
/// `GameProfile` + protocol + `MoveStrategy` (e.g. `BlackjackStrategy`).
pub async fn run_live_match<P, S, Strat, A>(
    config: &RelayConfig,
    connect_signer: &S,
    match_signer: DurableSigner,
    anchor: &A,
    profile: &GameProfile,
    protocol: P,
    strategy: Strat,
) -> Result<MatchOutcome>
where
    P: Protocol,
    S: Signer,
    Strat: MoveStrategy<P>,
    A: MatchAnchor,
{
    let conn = RelayConnection::connect_and_join(config, connect_signer, profile.game_id).await?;
    let info = conn.await_match().await?;
    let channel = MatchChannel::new(WsRelayTransport::new(Arc::new(conn), info.match_id.clone()));
    play_match(
        protocol,
        strategy,
        profile,
        &info,
        channel,
        anchor,
        match_signer,
    )
    .await
}

/// Blackjack live runner — a thin wrapper over [`run_live_match`] driving [`BlackjackStrategy`].
pub async fn run_live_blackjack<S: Signer, A: MatchAnchor>(
    config: &RelayConfig,
    connect_signer: &S,
    match_signer: DurableSigner,
    anchor: &A,
) -> Result<MatchOutcome> {
    run_live_match(
        config,
        connect_signer,
        match_signer,
        anchor,
        &BLACKJACK,
        Blackjack,
        BlackjackStrategy,
    )
    .await
}
