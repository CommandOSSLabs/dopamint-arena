//! `play_blackjack` — the per-match orchestration a bot runs after `match.found`:
//! ephemeral-key exchange → on-chain open/fund (via [`MatchAnchor`]) → co-signed play over the
//! demuxed transport → settle (seam; role B submits).
//!
//! The settle-half handshake + transcript root + on-chain submit live in the `MatchAnchor` impl
//! (`SuiAnchor`), because the sans-IO engine exposes no settlement builder; here settlement is the
//! seam call after a conserved terminal. With [`crate::anchor::NoopAnchor`] this drives a full
//! off-chain match end to end.

use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use tunnel_blackjack::Blackjack;
use tunnel_harness::{
    Balances, PartyDriver, PartyRuntime, RandomMoveStrategy, Signer, TunnelContext,
};

use crate::anchor::MatchAnchor;
use crate::match_channel::MatchChannel;
use crate::peer::PeerMsg;
use crate::relay_client::{RelayConfig, RelayConnection, WsRelayTransport};
use crate::relay_ws::RelayTransport;
use crate::signer_durable::DurableSigner;
use crate::Role;

/// Per-tunnel move budget (matches the canonical MAX_MOVES_PER_TUNNEL ceiling).
const MAX_MOVES: u64 = 100_000;

pub struct MatchOutcome {
    pub tunnel_id: String,
    pub moves: u64,
    pub final_balances: Balances,
    /// `Some(digest)` when this bot (role B) submitted the cooperative settle.
    pub settle_digest: Option<String>,
}

/// Drive one blackjack match to completion. `signer` is the bot's fresh per-match ephemeral key.
pub async fn play_blackjack<T: RelayTransport, A: MatchAnchor>(
    mut channel: MatchChannel<T>,
    anchor: &A,
    signer: DurableSigner,
    role: Role,
    opponent_wallet: &str,
    stake_each: u64,
    move_seed: u64,
) -> Result<MatchOutcome> {
    let my_pk = signer.public_key();

    // 1. Ephemeral-key exchange: announce ours, learn the opponent's (the runtime's opponent_pk).
    channel
        .send_peer(&PeerMsg::Hello {
            ephemeral_pubkey: hex::encode(my_pk),
        })
        .await
        .map_err(|e| anyhow!("send hello: {e:?}"))?;
    let opp_pk = recv_hello(&channel).await?;

    // 2. On-chain open/fund/activate (seam). Role B opens + announces; role A waits for `opened`.
    let tunnel_id = match role {
        Role::B => {
            let opened = anchor
                .open_as_dealer(my_pk, opp_pk, opponent_wallet)
                .await?;
            channel
                .send_peer(&PeerMsg::Opened {
                    tunnel_id: opened.tunnel_id.clone(),
                })
                .await
                .map_err(|e| anyhow!("send opened: {e:?}"))?;
            opened.tunnel_id
        }
        Role::A => recv_opened(&channel).await?,
    };
    anchor.fund_and_await_active(&tunnel_id, role).await?;

    // 3. Co-signed play over the demuxed frame transport.
    let ctx = TunnelContext {
        tunnel_id: tunnel_id.clone(),
        initial: Balances {
            a: stake_each,
            b: stake_each,
        },
        seat: role.seat(),
    };
    let runtime = PartyRuntime::new(Blackjack, signer, opp_pk, ctx);
    let driver = PartyDriver::new(
        runtime,
        RandomMoveStrategy::new(Arc::new(Blackjack), move_seed),
        channel.take_frame_transport(),
    );
    let mut ts = 1u64;
    let outcome = driver
        .run(MAX_MOVES, move || {
            ts += 1;
            ts
        })
        .await
        .map_err(|e| anyhow!("party driver run: {e:?}"))?;

    // 4. Settle (seam). Role B submits the cooperative close; the settle-half exchange + transcript
    //    root live in the MatchAnchor impl. NoopAnchor no-ops.
    let settle_digest = match role {
        Role::B => Some(anchor.settle(&tunnel_id, &[]).await?),
        Role::A => None,
    };

    Ok(MatchOutcome {
        tunnel_id,
        moves: outcome.moves,
        final_balances: outcome.final_balances,
        settle_digest,
    })
}

/// End-to-end live runner: connect to the relay, wait to be matched, and play one blackjack match
/// to completion over the live WS. `connect_signer` is the bot's identity key (answers the connect
/// challenge); `match_signer` is the fresh per-match ephemeral co-signing key.
pub async fn run_live_blackjack<S: Signer, A: MatchAnchor>(
    config: &RelayConfig,
    connect_signer: &S,
    match_signer: DurableSigner,
    anchor: &A,
    stake_each: u64,
    move_seed: u64,
) -> Result<MatchOutcome> {
    let conn = RelayConnection::connect_and_join(config, connect_signer, "blackjack").await?;
    let info = conn.await_match().await?;
    let conn = std::sync::Arc::new(conn);
    let channel = MatchChannel::new(WsRelayTransport::new(conn, info.match_id.clone()));
    play_blackjack(
        channel,
        anchor,
        match_signer,
        info.role,
        &info.opponent_wallet,
        stake_each,
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
