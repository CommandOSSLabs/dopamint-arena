//! WS live runners: connect to the relay, wait to be matched, and drive `fleet_core::play_match`
//! over the WebSocket transport. The transport-agnostic orchestration lives in `fleet-core` on the
//! merged `tunnel_harness::PartyDriver` (PR #131); this is the WS-client deployment's thin entry
//! (ADR-0024). The co-located game-server supplies its own bus-channel runner instead.

use std::sync::Arc;

use anyhow::Result;
use tunnel_blackjack::{Blackjack, BlackjackStrategy};
use tunnel_harness::{
    DriverOutcome, MoveStrategy, NullTranscriptRecorder, Protocol, Signer, TranscriptRecorder,
    TunnelAnchor,
};

use crate::relay_client::{RelayConfig, RelayConnection, WsRelayTransport};
use fleet_core::match_channel::MatchChannel;
use fleet_core::play_match::{play_match, GameProfile, BLACKJACK};
use fleet_core::signer_durable::DurableSigner;

/// Generic live runner for ANY game: connect, wait to be matched, play one match over the live WS
/// driving the supplied `protocol` + `strategy`, bracketed on-chain by `anchor` and tapped by
/// `recorder`. Adding a game = call this with that game's `GameProfile` + protocol + `MoveStrategy`.
#[allow(clippy::too_many_arguments)]
pub async fn run_live_match<P, S, Strat, A, R>(
    config: &RelayConfig,
    connect_signer: &S,
    match_signer: DurableSigner,
    anchor: A,
    recorder: R,
    profile: &GameProfile,
    protocol: P,
    strategy: Strat,
) -> Result<DriverOutcome>
where
    P: Protocol,
    S: Signer,
    Strat: MoveStrategy<P>,
    A: TunnelAnchor + Send + Sync,
    R: TranscriptRecorder<P::Move> + Send + Sync,
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
        recorder,
    )
    .await
}

/// Blackjack live runner — a thin wrapper over [`run_live_match`] driving [`BlackjackStrategy`],
/// transcript-less (`NullTranscriptRecorder`). The `anchor` is the on-chain seam (an
/// `InMemoryAnchor` completes a full match only against an in-process peer sharing it; a real match
/// against the browser uses a Sui / relay-bridged anchor).
pub async fn run_live_blackjack<S: Signer, A: TunnelAnchor + Send + Sync>(
    config: &RelayConfig,
    connect_signer: &S,
    match_signer: DurableSigner,
    anchor: A,
) -> Result<DriverOutcome> {
    run_live_match(
        config,
        connect_signer,
        match_signer,
        anchor,
        NullTranscriptRecorder,
        &BLACKJACK,
        Blackjack,
        BlackjackStrategy,
    )
    .await
}
