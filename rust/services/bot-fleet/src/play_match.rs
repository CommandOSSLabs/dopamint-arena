//! Generic per-match orchestration a bot runs after `match.found`, for ANY game protocol:
//! ephemeral-key exchange → on-chain open/fund (via [`MatchAnchor`]) → co-signed play over the
//! demuxed transport → settle. The game-specific bits are *data* — a [`GameProfile`] (id, host
//! seat, stake) plus the [`Protocol`] and its [`MoveStrategy`] — so **adding a game is a value,
//! not a new function**. The thin wrappers (`play_blackjack`, `run_live_blackjack`) just supply it.
//!
//! The settle-half handshake + transcript root + on-chain submit live in the `MatchAnchor` impl
//! (`SuiAnchor`), because the sans-IO engine exposes no settlement builder; here settlement is the
//! seam call after a conserved terminal. With [`crate::anchor::NoopAnchor`] this drives a full
//! off-chain match end to end.

use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use tunnel_blackjack::Blackjack;
use tunnel_harness::{
    Balances, MoveStrategy, PartyDriver, PartyRuntime, Protocol, RandomMoveStrategy, Signer,
    TunnelContext,
};

use crate::anchor::MatchAnchor;
use crate::match_channel::MatchChannel;
use crate::peer::PeerMsg;
use crate::relay_client::{MatchInfo, RelayConfig, RelayConnection, WsRelayTransport};
use crate::relay_ws::RelayTransport;
use crate::signer_durable::DurableSigner;
use crate::Role;

/// Per-tunnel move budget (matches the canonical MAX_MOVES_PER_TUNNEL ceiling).
const MAX_MOVES: u64 = 100_000;

/// The static per-game config — everything that differs between games. Adding a game is one of
/// these plus a `Protocol` (e.g. tic-tac-toe: `{ game_id: "tictactoe", host: Role::A, stake_each: 10 }`).
#[derive(Clone, Copy, Debug)]
pub struct GameProfile {
    /// The matchmaking queue id (`queue.join`), matching the FE's game id.
    pub game_id: &'static str,
    /// The seat that opens the tunnel + submits the cooperative settle (blackjack = dealer/`B`;
    /// generic PvP = `A`).
    pub host: Role,
    pub stake_each: u64,
}

pub struct MatchOutcome {
    pub tunnel_id: String,
    pub moves: u64,
    pub final_balances: Balances,
    /// `Some(digest)` when this bot was the host and submitted the cooperative settle.
    pub settle_digest: Option<String>,
}

/// Drive one match of ANY game to completion. `signer` is the bot's fresh per-match ephemeral key;
/// `role` is this bot's seat (from `match.found`); `profile` carries the per-game conventions.
pub async fn play_match<P, Strat, T, A>(
    protocol: P,
    strategy: Strat,
    profile: &GameProfile,
    match_info: &MatchInfo,
    mut channel: MatchChannel<T>,
    anchor: &A,
    signer: DurableSigner,
) -> Result<MatchOutcome>
where
    P: Protocol,
    Strat: MoveStrategy<P>,
    T: RelayTransport,
    A: MatchAnchor,
{
    let my_pk = signer.public_key();
    let role = match_info.role;

    // 1. Ephemeral-key exchange: announce ours, learn the opponent's (the runtime's opponent_pk).
    channel
        .send_peer(&PeerMsg::Hello {
            ephemeral_pubkey: hex::encode(my_pk),
        })
        .await
        .map_err(|e| anyhow!("send hello: {e:?}"))?;
    let opp_pk = recv_hello(&channel).await?;

    // 2. On-chain open/fund/activate (seam). The host opens + announces; the guest waits.
    let tunnel_id = if role == profile.host {
        let opened = anchor
            .open(my_pk, opp_pk, &match_info.opponent_wallet)
            .await?;
        channel
            .send_peer(&PeerMsg::Opened {
                tunnel_id: opened.tunnel_id.clone(),
            })
            .await
            .map_err(|e| anyhow!("send opened: {e:?}"))?;
        opened.tunnel_id
    } else {
        recv_opened(&channel).await?
    };
    anchor.fund_and_await_active(&tunnel_id, role).await?;

    // 3. Co-signed play over the demuxed frame transport.
    let ctx = TunnelContext {
        tunnel_id: tunnel_id.clone(),
        initial: Balances {
            a: profile.stake_each,
            b: profile.stake_each,
        },
        seat: role.seat(),
    };
    let runtime = PartyRuntime::new(protocol, signer, opp_pk, ctx);
    let driver = PartyDriver::new(runtime, strategy, channel.take_frame_transport());
    let mut ts = 1u64;
    let outcome = driver
        .run(MAX_MOVES, move || {
            ts += 1;
            ts
        })
        .await
        .map_err(|e| anyhow!("party driver run: {e:?}"))?;

    // 4. Settle (seam). The host submits; the settle-half exchange + transcript root live in the
    //    MatchAnchor impl. NoopAnchor no-ops.
    let settle_digest = if role == profile.host {
        Some(anchor.settle(&tunnel_id, &[]).await?)
    } else {
        None
    };

    Ok(MatchOutcome {
        tunnel_id,
        moves: outcome.moves,
        final_balances: outcome.final_balances,
        settle_digest,
    })
}

/// Blackjack profile: dealer (role B) hosts, stake 100.
pub const BLACKJACK: GameProfile = GameProfile {
    game_id: "blackjack",
    host: Role::B,
    stake_each: 100,
};

/// Blackjack: a thin wrapper over the generic [`play_match`]. Another game is the same one call
/// with its profile + protocol, e.g. `play_match(TicTacToe, strat, &TICTACTOE, &info, ch, a, s)`.
pub async fn play_blackjack<T: RelayTransport, A: MatchAnchor>(
    channel: MatchChannel<T>,
    anchor: &A,
    signer: DurableSigner,
    role: Role,
    opponent_wallet: &str,
    move_seed: u64,
) -> Result<MatchOutcome> {
    let info = MatchInfo {
        match_id: String::new(),
        role,
        opponent_wallet: opponent_wallet.to_owned(),
    };
    play_match(
        Blackjack,
        RandomMoveStrategy::new(Arc::new(Blackjack), move_seed),
        &BLACKJACK,
        &info,
        channel,
        anchor,
        signer,
    )
    .await
}

/// Generic live runner for ANY game: connect, wait to be matched, play one match over the live WS
/// using the default `RandomMoveStrategy`. `make_protocol` produces fresh protocol handles (the
/// protocol structs aren't `Clone`) — one for the runtime, one for the strategy. Adding a game =
/// call this with that game's `GameProfile` + protocol.
pub async fn run_live_match<P, S, A>(
    config: &RelayConfig,
    connect_signer: &S,
    match_signer: DurableSigner,
    anchor: &A,
    profile: &GameProfile,
    make_protocol: impl Fn() -> P,
    move_seed: u64,
) -> Result<MatchOutcome>
where
    P: Protocol,
    S: Signer,
    A: MatchAnchor,
{
    let conn = RelayConnection::connect_and_join(config, connect_signer, profile.game_id).await?;
    let info = conn.await_match().await?;
    let channel = MatchChannel::new(WsRelayTransport::new(Arc::new(conn), info.match_id.clone()));
    let strategy = RandomMoveStrategy::new(Arc::new(make_protocol()), move_seed);
    play_match(
        make_protocol(),
        strategy,
        profile,
        &info,
        channel,
        anchor,
        match_signer,
    )
    .await
}

/// Blackjack live runner — a thin wrapper over [`run_live_match`].
pub async fn run_live_blackjack<S: Signer, A: MatchAnchor>(
    config: &RelayConfig,
    connect_signer: &S,
    match_signer: DurableSigner,
    anchor: &A,
    move_seed: u64,
) -> Result<MatchOutcome> {
    run_live_match(
        config,
        connect_signer,
        match_signer,
        anchor,
        &BLACKJACK,
        || Blackjack,
        move_seed,
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

async fn recv_opened<T: RelayTransport>(ch: &MatchChannel<T>) -> Result<String> {
    loop {
        match ch.recv_peer().await {
            Some(PeerMsg::Opened { tunnel_id }) => return Ok(tunnel_id),
            Some(_) => continue,
            None => bail!("channel closed before tunnel opened"),
        }
    }
}
