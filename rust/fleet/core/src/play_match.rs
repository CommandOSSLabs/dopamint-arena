//! Per-match orchestration a bot runs after `match.found`, layered on the merged
//! `tunnel_harness::PartyDriver` (PR #131). The driver now brackets the whole match —
//! `anchor.open` → co-signed move loop → `anchor.settle` — so our job shrinks to the relay-side
//! ephemeral-key exchange (learn the opponent's co-signing pubkey) and then handing the driver our
//! demuxed frame transport + the chosen [`tunnel_harness::TunnelAnchor`].
//!
//! Adding a game is still data: a [`GameProfile`] (id + stake) plus the [`Protocol`] and its
//! [`MoveStrategy`]. The anchor is the swap point: `InMemoryAnchor` drives a full off-chain match
//! (bot-vs-bot, both seats sharing one anchor instance); the Sui anchor / a relay-bridged anchor is
//! the on-chain genuine-two-party path.

use anyhow::{anyhow, bail, Context, Result};
use tunnel_blackjack::{Blackjack, BlackjackStrategy};
use tunnel_harness::{
    Balances, DriverOutcome, MoveStrategy, PartyDriver, Protocol, SeatParts, Signer,
    TranscriptRecorder, TunnelAnchor,
};

use crate::match_channel::MatchChannel;
use crate::peer::PeerMsg;
use crate::relay_ws::RelayTransport;
use crate::signer_durable::DurableSigner;
use crate::{MatchInfo, Role};

/// Per-tunnel move budget (matches the canonical MAX_MOVES_PER_TUNNEL ceiling).
const MAX_MOVES: u64 = 100_000;

/// The static per-game config. `host` is gone vs the pre-merge harness: the merged `TunnelAnchor`
/// is symmetric (both seats `open` idempotently and `settle` their own half), so no seat is "the
/// opener". What remains differs between games: the matchmaking id and the per-seat stake.
#[derive(Clone, Copy, Debug)]
pub struct GameProfile {
    /// The matchmaking queue id (`queue.join`), matching the FE's game id.
    pub game_id: &'static str,
    pub stake_each: u64,
}

/// Blackjack profile: stake 100 each. (No host — see [`GameProfile`].)
pub const BLACKJACK: GameProfile = GameProfile {
    game_id: "blackjack",
    stake_each: 100,
};

/// Drive one match of ANY game to completion over the relay, on the merged `PartyDriver`.
/// `signer` is this bot's fresh per-match ephemeral key; `match_info.role` is its seat; the
/// `anchor` brackets the on-chain open/settle (its impl decides off-chain vs Sui vs relay-bridged);
/// `recorder` taps the transcript (use `NullTranscriptRecorder` when not archiving).
pub async fn play_match<P, Strat, T, A, R>(
    protocol: P,
    strategy: Strat,
    profile: &GameProfile,
    match_info: &MatchInfo,
    mut channel: MatchChannel<T>,
    anchor: A,
    signer: DurableSigner,
    recorder: R,
) -> Result<DriverOutcome>
where
    P: Protocol,
    Strat: MoveStrategy<P>,
    T: RelayTransport,
    A: TunnelAnchor + Send + Sync,
    R: TranscriptRecorder<P::Move> + Send + Sync,
{
    // 1. Ephemeral-key exchange over the relay: announce ours, learn the opponent's co-signing pk.
    //    (The merged driver expects `opponent_pk` up front; the relay peer protocol supplies it.)
    let my_pk = signer.public_key();
    channel
        .send_peer(&PeerMsg::Hello {
            ephemeral_pubkey: hex::encode(my_pk),
        })
        .await
        .map_err(|e| anyhow!("send hello: {e:?}"))?;
    let opponent_pk = recv_hello(&channel).await?;

    // 2. Hand the driver the demuxed frame transport + the anchor; it opens, plays, and settles.
    let parts = SeatParts {
        protocol,
        signer,
        opponent_pk,
        initial: Balances {
            a: profile.stake_each,
            b: profile.stake_each,
        },
        seat: match_info.role.seat(),
    };
    let driver = PartyDriver::new(
        parts,
        strategy,
        channel.take_frame_transport(),
        anchor,
        recorder,
    );
    let mut ts = 1u64;
    let (outcome, _recorder) = driver
        .run(MAX_MOVES, move || {
            ts += 1;
            ts
        })
        .await
        .map_err(|e| anyhow!("party driver run: {e:?}"))?;
    Ok(outcome)
}

/// Blackjack: a thin wrapper over [`play_match`] driving the real basic-strategy [`BlackjackStrategy`].
pub async fn play_blackjack<T, A, R>(
    channel: MatchChannel<T>,
    anchor: A,
    signer: DurableSigner,
    role: Role,
    opponent_wallet: &str,
    recorder: R,
) -> Result<DriverOutcome>
where
    T: RelayTransport,
    A: TunnelAnchor + Send + Sync,
    R: TranscriptRecorder<<Blackjack as Protocol>::Move> + Send + Sync,
{
    let info = MatchInfo {
        match_id: String::new(),
        role,
        opponent_wallet: opponent_wallet.to_owned(),
    };
    play_match(
        Blackjack,
        BlackjackStrategy,
        &BLACKJACK,
        &info,
        channel,
        anchor,
        signer,
        recorder,
    )
    .await
}

async fn recv_hello<T: RelayTransport>(ch: &MatchChannel<T>) -> Result<[u8; 32]> {
    loop {
        match ch.recv_peer().await {
            Some(PeerMsg::Hello { ephemeral_pubkey }) => {
                let bytes = hex::decode(&ephemeral_pubkey).context("opponent hello pubkey hex")?;
                return bytes
                    .as_slice()
                    .try_into()
                    .map_err(|_| anyhow!("opponent pubkey not 32 bytes"));
            }
            Some(_) => continue, // ignore other control messages until the hello arrives
            None => bail!("channel closed before opponent hello"),
        }
    }
}
