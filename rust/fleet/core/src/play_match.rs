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
use tunnel_quantum_poker::{QuantumPoker, QuantumPokerStrategy};

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

/// Blackjack profile: stake 1000 MTPS each (0 decimals → integer `1000`), matching the FE PvP
/// hook's `DEFAULT_STAKE` so the bot's pre-created tunnel and the user's deposit agree on the
/// initial off-chain balances (a divergent stake would break co-signing). Must be ≥ `MIN_BET` (25)
/// or `is_terminal` fires at the initial state and the match settles with zero moves. Match length
/// is bounded by the protocol's `ROUND_CAP`, not the bankroll. (No host — see [`GameProfile`].)
pub const BLACKJACK: GameProfile = GameProfile {
    game_id: "blackjack",
    stake_each: 1000,
};

/// Quantum Poker profile: stake 5000 MTPS per seat (the bankroll), ante 50 per hand, 50-hand cap —
/// matching the FE PvP hook (`POKER_BUYIN = 5000`, `HAND_CAP = 50`, default `ANTE = 50`) so the
/// bot's pre-created tunnel and the user's deposit agree on the initial off-chain balances and the
/// per-hand wager unit. Real MTPS only moves at open/settle; intra-match bets draw against the
/// staked bankroll off-chain, exactly as the tunnel protocol already does.
pub const QUANTUM_POKER: GameProfile = GameProfile {
    game_id: "quantum_poker",
    stake_each: 5000,
};

/// Look up the [`GameProfile`] for a game id, or `None` if the fleet has no wired profile for it.
/// The arena allocate path uses this to find the per-seat stake for the opener (ADR-0028); adding a
/// game is a new `const` here + an arm in [`play_game`]'s dispatch.
pub fn profile_for(game: &str) -> Option<GameProfile> {
    match game {
        "blackjack" => Some(BLACKJACK),
        "quantum_poker" => Some(QUANTUM_POKER),
        _ => None,
    }
}

/// Per-hand ante for the fleet bot's quantum poker. Matches the TS protocol's default `ANTE` (50n),
/// which every FE caller uses (no FE caller passes a custom ante). Kept separate from
/// [`QUANTUM_POKER`] because the ante is a protocol-construction param, not a stake.
const QUANTUM_POKER_ANTE: u64 = 50;

/// Hand cap for the fleet bot's quantum poker, matching the FE `HAND_CAP = 50n`.
const QUANTUM_POKER_HAND_CAP: u64 = 50;

/// Drive one match of ANY game to completion over the relay, on the merged `PartyDriver`.
/// `signer` is this bot's fresh per-match ephemeral key; `match_info.role` is its seat; the
/// `anchor` brackets the on-chain open/settle (its impl decides off-chain vs Sui vs relay-bridged);
/// `recorder` taps the transcript (use `NullTranscriptRecorder` when not archiving).
#[allow(clippy::too_many_arguments)] // game + match + transport + anchor + signer + recorder seams
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

/// Quantum Poker: a thin wrapper over [`play_match`] driving [`QuantumPokerStrategy`] over the
/// commit-reveal v2 protocol. The ante scales the chip economy to the whole-token bankroll; it
/// defaults to the FE's `ANTE` (50) so the bot co-signs against the unchanged FE.
pub async fn play_quantum_poker<T, A, R>(
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
    R: TranscriptRecorder<<QuantumPoker as Protocol>::Move> + Send + Sync,
{
    let info = MatchInfo {
        match_id: String::new(),
        role,
        opponent_wallet: opponent_wallet.to_owned(),
    };
    play_match(
        QuantumPoker::with_ante(QUANTUM_POKER_HAND_CAP, QUANTUM_POKER_ANTE),
        QuantumPokerStrategy::new(fleet_seed(role)),
        &QUANTUM_POKER,
        &info,
        channel,
        anchor,
        signer,
        recorder,
    )
    .await
}

/// A stable-per-role seed for the poker strategy, so a bot's play is deterministic per match seat
/// but distinct across seats. Not cryptographic — the per-match co-signing key is the secret.
fn fleet_seed(role: Role) -> u64 {
    match role {
        Role::A => 0xa11ce,
        Role::B => 0xb0b_5eed,
    }
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
