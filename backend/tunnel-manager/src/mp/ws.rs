//! `GET /v1/mp` WebSocket: upgrade -> issue a `challenge` nonce -> authenticate on
//! `connect` -> register presence + an outbound channel -> drive matchmaking/relay.
//! Each socket gets a writer task fed by an mpsc channel so any handler can push to it.

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::mp::protocol::{ClientMsg, ServerMsg};
use crate::mp::{auth, matchmaking, relay, Checkpoint, ConnId};
use crate::state::{AppState, SharedState};

pub async fn mp_upgrade(State(state): State<SharedState>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: SharedState) {
    let conn_id: ConnId = Uuid::new_v4();
    let (mut sink, mut stream) = socket.split();

    // Outbound channel: handlers push JSON strings; this task writes them to the socket.
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            if sink.send(Message::Text(text)).await.is_err() {
                break;
            }
        }
    });

    // Issue the connect challenge. The conn id (unique per socket) is the single-use nonce.
    let nonce = conn_id.to_string();
    let _ = tx.send(ServerMsg::Challenge { nonce: nonce.clone() }.to_text());

    let mut wallet: Option<String> = None;

    while let Some(Ok(msg)) = stream.next().await {
        let text = match msg {
            Message::Text(t) => t,
            Message::Close(_) => break,
            _ => continue, // ignore binary/ping/pong at the control layer
        };
        let client_msg = match serde_json::from_str::<ClientMsg>(&text) {
            Ok(m) => m,
            Err(_) => {
                let _ = tx.send(ServerMsg::error("bad_message", "unparseable control message").to_text());
                continue;
            }
        };
        if let Err(code) = handle_message(&state, &tx, conn_id, &nonce, &mut wallet, client_msg) {
            let _ = tx.send(ServerMsg::error(code, code).to_text());
        }
    }

    // Cleanup on disconnect.
    if let Some(w) = wallet {
        state.presence.write().expect("presence lock").remove(&w);
    }
    state.conns.write().expect("conns lock").remove(&conn_id);
    writer.abort();
}

/// Dispatch one control message. Returns Err(code) on a domain error; the caller relays it.
fn handle_message(
    state: &Arc<AppState>,
    tx: &mpsc::UnboundedSender<String>,
    conn_id: ConnId,
    nonce: &str,
    wallet: &mut Option<String>,
    msg: ClientMsg,
) -> Result<(), &'static str> {
    match msg {
        ClientMsg::Connect { wallet: w, pubkey, sig, nonce: claimed } => {
            if claimed != nonce {
                return Err("bad_nonce");
            }
            if !auth::verify_ed25519(&pubkey, nonce.as_bytes(), &sig) {
                return Err("bad_signature");
            }
            state.presence.write().expect("presence lock").insert(w.clone(), conn_id);
            state.conns.write().expect("conns lock").insert(conn_id, tx.clone());
            *wallet = Some(w);
            Ok(())
        }
        other => {
            // All other messages require an authenticated wallet.
            let w = wallet.as_ref().ok_or("not_authenticated")?.clone();
            handle_authed(state, conn_id, &w, other)
        }
    }
}

fn handle_authed(
    state: &Arc<AppState>,
    conn_id: ConnId,
    wallet: &str,
    msg: ClientMsg,
) -> Result<(), &'static str> {
    match msg {
        ClientMsg::QueueJoin { game } => {
            if let Some(p) = matchmaking::quick_match_join(state, &game, &wallet.to_string(), conn_id) {
                push(state, p.record.conn_a, ServerMsg::MatchFound {
                    match_id: p.match_id.clone(),
                    role: "A".into(),
                    opponent_wallet: p.record.seat_b.clone(),
                    game: p.record.game.clone(),
                });
                push(state, p.record.conn_b, ServerMsg::MatchFound {
                    match_id: p.match_id,
                    role: "B".into(),
                    opponent_wallet: p.record.seat_a,
                    game: p.record.game,
                });
            }
            Ok(())
        }
        ClientMsg::QueueLeave => {
            let games: Vec<String> = state.queues.read().expect("queues lock").keys().cloned().collect();
            for g in games {
                matchmaking::quick_match_leave(state, &g, &wallet.to_string());
            }
            Ok(())
        }
        ClientMsg::ChallengeCreate { target_wallet, game } => {
            // Check presence FIRST — don't persist a dangling invite for an offline target.
            let target_conn = state.presence.read().expect("presence lock").get(&target_wallet).copied();
            let Some(tc) = target_conn else { return Err("target_offline") };
            let mid = matchmaking::challenge_create(state, &wallet.to_string(), conn_id, &target_wallet, &game);
            push(state, tc, ServerMsg::ChallengeIncoming {
                match_id: mid,
                from_wallet: wallet.to_string(),
                game,
            });
            Ok(())
        }
        ClientMsg::ChallengeAccept { match_id } => {
            match matchmaking::challenge_accept(state, &match_id, &wallet.to_string(), conn_id) {
                Some(p) => {
                    push(state, p.record.conn_a, ServerMsg::MatchFound {
                        match_id: p.match_id.clone(),
                        role: "A".into(),
                        opponent_wallet: p.record.seat_b.clone(),
                        game: p.record.game.clone(),
                    });
                    push(state, p.record.conn_b, ServerMsg::MatchFound {
                        match_id: p.match_id,
                        role: "B".into(),
                        opponent_wallet: p.record.seat_a,
                        game: p.record.game,
                    });
                    Ok(())
                }
                None => Err("unknown_invite"),
            }
        }
        ClientMsg::ChallengeDecline { match_id } => {
            state.invites.write().expect("invites lock").remove(&match_id);
            Ok(())
        }
        ClientMsg::PartyHello { match_id, ephemeral_pubkey, wallet_sig } => {
            // Forward the wallet-attested ephemeral key to the opponent verbatim so EACH
            // client verifies the other's attestation (spec §4). The server never parses it.
            let envelope = serde_json::json!({
                "type": "party.hello",
                "matchId": match_id,
                "ephemeralPubkey": ephemeral_pubkey,
                "walletSig": wallet_sig,
            })
            .to_string();
            forward_to_other(state, &match_id, conn_id, &envelope);
            Ok(())
        }
        ClientMsg::TunnelOpened { match_id, tunnel_id } => {
            relay::set_tunnel_id(state, &match_id, tunnel_id);
            Ok(())
        }
        ClientMsg::Relay { match_id, payload } => {
            let envelope = ServerMsg::Relay { match_id: match_id.clone(), payload }.to_text();
            forward_to_other(state, &match_id, conn_id, &envelope);
            Ok(())
        }
        ClientMsg::WatchtowerCheckpoint {
            match_id,
            nonce,
            party_a_balance,
            party_b_balance,
            state_hash,
            sig_a,
            sig_b,
        } => {
            let cp = Checkpoint {
                nonce: nonce.parse().map_err(|_| "bad_checkpoint")?,
                party_a_balance: party_a_balance.parse().map_err(|_| "bad_checkpoint")?,
                party_b_balance: party_b_balance.parse().map_err(|_| "bad_checkpoint")?,
                state_hash,
                sig_a,
                sig_b,
            };
            relay::record_checkpoint(state, &match_id, cp);
            Ok(())
        }
        ClientMsg::Connect { .. } => Err("already_connected"),
    }
}

fn forward_to_other(state: &Arc<AppState>, match_id: &str, from: ConnId, text: &str) {
    if let Some(target) = relay::relay_target(state, &match_id.to_string(), from) {
        if let Some(tx) = state.conns.read().expect("conns lock").get(&target) {
            let _ = tx.send(text.to_owned());
        }
    }
}

fn push(state: &Arc<AppState>, conn: ConnId, msg: ServerMsg) {
    if let Some(tx) = state.conns.read().expect("conns lock").get(&conn) {
        let _ = tx.send(msg.to_text());
    }
}
