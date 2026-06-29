//! Live WSS client to the deployed relay (`/v1/mp`).
//!
//! Drives the connect handshake — `Challenge → Connect(sign nonce) → queue.join` — then waits for
//! `match.found` and exposes the match's channel as a [`WsRelayTransport`] (a [`RelayTransport`]
//! the [`crate::match_channel::MatchChannel`] demultiplexes). The bot authenticates by signing the
//! server nonce with its identity ed25519 key; the per-match co-signing uses a separate ephemeral
//! key (see `play_match`).
//!
//! The WS is split so reads (the demux loop) and writes (frames + peer messages) can run
//! concurrently behind `&self`. Within a match only the demux loop reads, so the stream lock is
//! never contended; the sink lock serializes outbound frames.
//!
//! NB: against the *currently deployed* relay there is no `is_bot` flag yet (a relay-side change),
//! so a bot joining `queue.join` is paired by the existing quick-match.

use anyhow::{bail, Context, Result};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};
use tunnel_harness::{FrameTransportError, Signer};

use crate::relay_wire::{BotToRelay, RelayToBot};
use fleet_core::relay_ws::RelayTransport;
use fleet_core::{MatchInfo, Role};

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

pub struct RelayConfig {
    /// e.g. `wss://relay-dev.millionstps.io/v1/mp`
    pub ws_url: String,
    /// The bot's advertised wallet identity (unauthenticated label, by design).
    pub wallet: String,
}

pub struct RelayConnection {
    sink: Mutex<SplitSink<Ws, Message>>,
    stream: Mutex<SplitStream<Ws>>,
}

impl RelayConnection {
    /// Connect, complete the challenge/connect auth, and join `game`'s queue.
    pub async fn connect_and_join<S: Signer>(
        config: &RelayConfig,
        signer: &S,
        game: &str,
    ) -> Result<RelayConnection> {
        let (ws, _resp) = connect_async(&config.ws_url)
            .await
            .with_context(|| format!("connect {}", config.ws_url))?;
        let (sink, stream) = ws.split();
        let conn = RelayConnection {
            sink: Mutex::new(sink),
            stream: Mutex::new(stream),
        };

        let nonce = conn.await_challenge().await?;
        conn.send(&BotToRelay::Connect {
            wallet: config.wallet.clone(),
            pubkey: hex::encode(signer.public_key()),
            sig: hex::encode(signer.sign(nonce.as_bytes())),
            nonce,
        })
        .await?;
        conn.send(&BotToRelay::QueueJoin {
            game: game.to_owned(),
        })
        .await?;
        Ok(conn)
    }

    /// Wait for the relay to pair us, returning the match assignment.
    pub async fn await_match(&self) -> Result<MatchInfo> {
        loop {
            match self.recv().await? {
                Some(RelayToBot::MatchFound {
                    match_id,
                    role,
                    opponent_wallet,
                    ..
                }) => {
                    let role = match role.as_str() {
                        "A" => Role::A,
                        "B" => Role::B,
                        other => bail!("unknown role from relay: {other}"),
                    };
                    return Ok(MatchInfo {
                        match_id,
                        role,
                        opponent_wallet,
                    });
                }
                Some(RelayToBot::Error { code, message }) => bail!("relay error: {code} {message}"),
                Some(_) => continue,
                None => bail!("relay closed before match.found"),
            }
        }
    }

    async fn await_challenge(&self) -> Result<String> {
        loop {
            match self.recv().await? {
                Some(RelayToBot::Challenge { nonce }) => return Ok(nonce),
                Some(RelayToBot::Error { code, message }) => {
                    bail!("relay error before challenge: {code} {message}")
                }
                Some(_) => continue,
                None => bail!("relay closed before issuing a challenge"),
            }
        }
    }

    pub async fn send(&self, msg: &BotToRelay) -> Result<()> {
        self.sink
            .lock()
            .await
            .send(Message::Text(msg.to_text()))
            .await
            .context("ws send")
    }

    /// Next control message, or `None` when the socket closes. Non-text frames are skipped;
    /// inbound pings are answered with a pong.
    pub async fn recv(&self) -> Result<Option<RelayToBot>> {
        let mut stream = self.stream.lock().await;
        loop {
            match stream.next().await {
                Some(Ok(Message::Text(t))) => {
                    let msg: RelayToBot = serde_json::from_str(&t)
                        .with_context(|| format!("decode server msg: {t}"))?;
                    return Ok(Some(msg));
                }
                Some(Ok(Message::Ping(p))) => {
                    self.sink.lock().await.send(Message::Pong(p)).await.ok();
                }
                Some(Ok(Message::Close(_))) | None => return Ok(None),
                Some(Ok(_)) => continue,
                Some(Err(e)) => return Err(e).context("ws recv"),
            }
        }
    }
}

/// A [`RelayTransport`] over a live connection, scoped to one match: `send_payload` forwards a
/// `relay` frame for `match_id`; `recv_payload` yields the next inbound `relay` payload for it
/// (and ends the match on peer-drop / error / close). `MatchChannel` demuxes these payloads.
pub struct WsRelayTransport {
    conn: std::sync::Arc<RelayConnection>,
    match_id: String,
}

impl WsRelayTransport {
    pub fn new(conn: std::sync::Arc<RelayConnection>, match_id: String) -> WsRelayTransport {
        WsRelayTransport { conn, match_id }
    }
}

impl RelayTransport for WsRelayTransport {
    async fn send_payload(&self, payload: Vec<u8>) -> Result<(), FrameTransportError> {
        let payload = String::from_utf8(payload)
            .map_err(|e| FrameTransportError::Transport(format!("payload not UTF-8: {e}")))?;
        self.conn
            .send(&BotToRelay::Relay {
                match_id: self.match_id.clone(),
                payload,
            })
            .await
            .map_err(|e| FrameTransportError::Transport(format!("{e:#}")))
    }

    async fn recv_payload(&self) -> Result<Option<Vec<u8>>, FrameTransportError> {
        loop {
            let msg = self
                .conn
                .recv()
                .await
                .map_err(|e| FrameTransportError::Transport(format!("{e:#}")))?;
            match msg {
                Some(RelayToBot::Relay { match_id, payload }) if match_id == self.match_id => {
                    return Ok(Some(payload.into_bytes()));
                }
                // Other-match frames shouldn't arrive (one match per connection); ignore.
                Some(RelayToBot::Relay { .. }) => continue,
                // Opponent left or relay errored → end the match channel.
                Some(RelayToBot::PeerDropped { .. }) | Some(RelayToBot::Error { .. }) | None => {
                    return Ok(None);
                }
                Some(_) => continue,
            }
        }
    }
}
