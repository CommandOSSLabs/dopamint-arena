//! `GET /v1/fleet` — the fleet bot control socket (ADR-0023). A bot connects, `register`s with
//! its game + ephemeral pubkey, then receives `Reserved` / `Opened` pushes as users allocate it.
//! One registration per socket; the socket closing ends the bot's match and unregisters it.
//!
//! This is the backend↔fleet seam only (no game frames — those ride `/v1/mp` like any player).

use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures::{SinkExt, StreamExt};
use tokio::sync::mpsc;

use crate::fleet::{BotHandle, FleetClientMsg};
use crate::state::SharedState;

/// Mirrors `/v1/mp`'s server-driven keepalive: a half-open idle socket (a bot waiting for a
/// reservation) would otherwise be reaped by the ALB. Kept under the proxy idle timeout.
const KEEPALIVE_PING_INTERVAL: Duration = Duration::from_secs(30);

pub async fn fleet_upgrade(State(state): State<SharedState>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| handle_fleet_socket(socket, state))
}

async fn handle_fleet_socket(socket: WebSocket, state: SharedState) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel();
    let mut bot_id: Option<u64> = None;

    let mut keepalive = tokio::time::interval(KEEPALIVE_PING_INTERVAL);
    keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut ping_unanswered = false;

    loop {
        tokio::select! {
            _ = keepalive.tick() => {
                if ping_unanswered {
                    break; // last ping never got a pong → bot is gone
                }
                ping_unanswered = true;
                if sink.send(Message::Ping(Vec::new())).await.is_err() {
                    break;
                }
            }
            outbound = rx.recv() => {
                match outbound {
                    Some(msg) => {
                        let text = serde_json::to_string(&msg).unwrap_or_default();
                        if sink.send(Message::Text(text)).await.is_err() {
                            break;
                        }
                    }
                    None => break,
                }
            }
            inbound = stream.next() => {
                let text = match inbound {
                    Some(Ok(Message::Text(t))) => t,
                    Some(Ok(Message::Pong(_))) => {
                        ping_unanswered = false;
                        continue;
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(_)) => continue,
                };
                match serde_json::from_str::<FleetClientMsg>(&text) {
                    // One registration per socket; a re-register on an already-registered socket
                    // is ignored (the bot reconnects for its next match instead).
                    Ok(FleetClientMsg::Register { game, eph_pubkey, address })
                        if bot_id.is_none() =>
                    {
                        bot_id = Some(state.fleet.register(
                            &game,
                            BotHandle { eph_pubkey, address, ctrl: tx.clone() },
                        ));
                    }
                    _ => continue,
                }
            }
        }
    }

    if let Some(id) = bot_id {
        state.fleet.unregister(id);
    }
}
