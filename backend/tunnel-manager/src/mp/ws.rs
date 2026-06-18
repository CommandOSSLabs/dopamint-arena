//! `GET /v1/mp` WebSocket. Upgrade → challenge → connect-auth → register presence + a local
//! outbound channel via Bus → drive matchmaking/relay through MpStore + Bus::deliver.
use std::collections::HashSet;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::mp::protocol::{ClientMsg, ServerMsg};
use crate::mp::{auth, Checkpoint, ConnId, DirectedInvite, MatchRecord, Waiting};
use crate::state::SharedState;
use crate::store::ConnRef;

pub async fn mp_upgrade(State(state): State<SharedState>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

fn new_match_id() -> String {
    format!("match_{}", Uuid::new_v4().simple())
}
fn here(state: &SharedState, conn: ConnId) -> ConnRef {
    ConnRef {
        instance_id: state.bus.instance_id().to_owned(),
        conn_id: conn,
    }
}

/// Quick-match: seat A = the earlier waiter (opponent); seat B = the late joiner.
fn build_quick_match(
    game: &str,
    opponent: Waiting,
    me_wallet: &str,
    me_conn: ConnRef,
) -> (String, MatchRecord) {
    let match_id = new_match_id();
    let rec = MatchRecord {
        game: game.to_owned(),
        seat_a: opponent.wallet.clone(),
        seat_b: me_wallet.to_owned(),
        conn_a: opponent.conn,
        conn_b: me_conn,
        tunnel_id: None,
        latest_checkpoint: None,
    };
    (match_id, rec)
}

/// Challenge-match: seat A = the inviter; seat B = the accepter.
fn build_challenge_match(
    inv: &DirectedInvite,
    accepter_wallet: &str,
    accepter_conn: ConnRef,
) -> MatchRecord {
    MatchRecord {
        game: inv.game.clone(),
        seat_a: inv.from.clone(),
        seat_b: accepter_wallet.to_owned(),
        conn_a: inv.from_conn.clone(),
        conn_b: accepter_conn,
        tunnel_id: None,
        latest_checkpoint: None,
    }
}

/// Server-driven keepalive cadence (RFC 6455 control frames). Browsers can't
/// originate Ping frames and auto-answer Pong below the app layer, so liveness
/// has to be server-side. A tick that finds the previous ping still unanswered
/// means the peer vanished (a half-open socket the browser/ALB can't surface),
/// so we drop the connection and run the cleanup below. Kept well under the ALB
/// idle timeout so the proxy never reaps a live-but-quiet match.
const KEEPALIVE_PING_INTERVAL: Duration = Duration::from_secs(30);

async fn handle_socket(socket: WebSocket, state: SharedState) {
    let conn_id: ConnId = Uuid::new_v4();
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let nonce = conn_id.to_string();
    let _ = tx.send(
        ServerMsg::Challenge {
            nonce: nonce.clone(),
        }
        .to_text(),
    );

    let mut wallet: Option<String> = None;
    let mut joined_games: HashSet<String> = HashSet::new();

    let mut keepalive = tokio::time::interval(KEEPALIVE_PING_INTERVAL);
    // A stall in `handle_message` must not burst-fire catch-up ticks and trip the
    // unanswered-ping check on a connection that is actually alive.
    keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut ping_unanswered = false;

    // Single loop owns the sink, so reads, queued outbound, and keepalive pings
    // never contend; pong replies arrive on the read half and clear the flag.
    loop {
        tokio::select! {
            _ = keepalive.tick() => {
                if ping_unanswered {
                    break; // last ping never got a pong → peer is gone
                }
                ping_unanswered = true;
                if sink.send(Message::Ping(Vec::new())).await.is_err() {
                    break;
                }
            }
            outbound = rx.recv() => {
                match outbound {
                    Some(text) => {
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
                let client_msg = match serde_json::from_str::<ClientMsg>(&text) {
                    Ok(m) => m,
                    Err(_) => {
                        let _ = tx.send(
                            ServerMsg::error("bad_message", "unparseable control message")
                                .to_text(),
                        );
                        continue;
                    }
                };
                if let Err(code) = handle_message(
                    &state,
                    &tx,
                    conn_id,
                    &nonce,
                    &mut wallet,
                    &mut joined_games,
                    client_msg,
                )
                .await
                {
                    let _ = tx.send(ServerMsg::error(code, code).to_text());
                }
            }
        }
    }

    // Disconnect cleanup: conditional presence clear + leave every joined queue.
    if let Some(w) = wallet {
        state.mp.clear_presence_if(&w, conn_id).await;
        for g in joined_games {
            state.mp.leave_queue(&g, &w).await;
        }
    }
    state.bus.unregister(conn_id);
}

async fn handle_message(
    state: &SharedState,
    tx: &mpsc::UnboundedSender<String>,
    conn_id: ConnId,
    nonce: &str,
    wallet: &mut Option<String>,
    joined: &mut HashSet<String>,
    msg: ClientMsg,
) -> Result<(), &'static str> {
    match msg {
        ClientMsg::Connect {
            wallet: w,
            pubkey,
            sig,
            nonce: claimed,
        } => {
            if claimed != nonce {
                return Err("bad_nonce");
            }
            if !auth::verify_ed25519(&pubkey, nonce.as_bytes(), &sig) {
                return Err("bad_signature");
            }
            state.bus.register(conn_id, tx.clone());
            state.mp.set_presence(&w, here(state, conn_id)).await;
            *wallet = Some(w);
            Ok(())
        }
        other => {
            let w = wallet.as_ref().ok_or("not_authenticated")?.clone();
            handle_authed(state, conn_id, &w, joined, other).await
        }
    }
}

async fn handle_authed(
    state: &SharedState,
    conn_id: ConnId,
    wallet: &str,
    joined: &mut HashSet<String>,
    msg: ClientMsg,
) -> Result<(), &'static str> {
    match msg {
        ClientMsg::QueueJoin { game } => {
            joined.insert(game.clone());
            let me = Waiting {
                wallet: wallet.to_owned(),
                conn: here(state, conn_id),
            };
            if let Some(opp) = state.mp.join_or_pair(&game, me).await {
                let (match_id, rec) = build_quick_match(&game, opp, wallet, here(state, conn_id));
                state.mp.put_match(&match_id, rec.clone()).await;
                state
                    .bus
                    .deliver(
                        &rec.conn_a,
                        ServerMsg::MatchFound {
                            match_id: match_id.clone(),
                            role: "A".into(),
                            opponent_wallet: rec.seat_b.clone(),
                            game: game.clone(),
                        }
                        .to_text(),
                    )
                    .await;
                state
                    .bus
                    .deliver(
                        &rec.conn_b,
                        ServerMsg::MatchFound {
                            match_id,
                            role: "B".into(),
                            opponent_wallet: rec.seat_a,
                            game,
                        }
                        .to_text(),
                    )
                    .await;
            }
            Ok(())
        }
        ClientMsg::QueueLeave => {
            for g in joined.drain() {
                state.mp.leave_queue(&g, wallet).await;
            }
            Ok(())
        }
        ClientMsg::ChallengeCreate {
            target_wallet,
            game,
        } => {
            let Some(target) = state.mp.get_presence(&target_wallet).await else {
                return Err("target_offline");
            };
            let match_id = new_match_id();
            state
                .mp
                .put_invite(
                    &match_id,
                    DirectedInvite {
                        from: wallet.to_owned(),
                        to: target_wallet.clone(),
                        game: game.clone(),
                        from_conn: here(state, conn_id),
                    },
                )
                .await;
            state
                .bus
                .deliver(
                    &target,
                    ServerMsg::ChallengeIncoming {
                        match_id,
                        from_wallet: wallet.to_owned(),
                        game,
                    }
                    .to_text(),
                )
                .await;
            Ok(())
        }
        ClientMsg::ChallengeAccept { match_id } => {
            let Some(inv) = state.mp.take_invite(&match_id, wallet).await else {
                return Err("unknown_invite");
            };
            let rec = build_challenge_match(&inv, wallet, here(state, conn_id));
            state.mp.put_match(&match_id, rec.clone()).await;
            state
                .bus
                .deliver(
                    &rec.conn_a,
                    ServerMsg::MatchFound {
                        match_id: match_id.clone(),
                        role: "A".into(),
                        opponent_wallet: rec.seat_b.clone(),
                        game: rec.game.clone(),
                    }
                    .to_text(),
                )
                .await;
            state
                .bus
                .deliver(
                    &rec.conn_b,
                    ServerMsg::MatchFound {
                        match_id,
                        role: "B".into(),
                        opponent_wallet: rec.seat_a,
                        game: rec.game,
                    }
                    .to_text(),
                )
                .await;
            Ok(())
        }
        ClientMsg::ChallengeDecline { match_id } => {
            state.mp.drop_invite(&match_id).await;
            Ok(())
        }
        ClientMsg::PartyHello {
            match_id,
            ephemeral_pubkey,
            wallet_sig,
        } => {
            let envelope = serde_json::json!({
                "type": "party.hello", "matchId": match_id,
                "ephemeralPubkey": ephemeral_pubkey, "walletSig": wallet_sig,
            })
            .to_string();
            forward_to_other(state, &match_id, conn_id, envelope).await;
            Ok(())
        }
        ClientMsg::TunnelOpened {
            match_id,
            tunnel_id,
        } => {
            state.mp.set_tunnel_id(&match_id, &tunnel_id).await;
            Ok(())
        }
        ClientMsg::Relay { match_id, payload } => {
            let envelope = ServerMsg::Relay {
                match_id: match_id.clone(),
                payload,
            }
            .to_text();
            forward_to_other(state, &match_id, conn_id, envelope).await;
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
            state.mp.record_checkpoint(&match_id, cp).await;
            Ok(())
        }
        ClientMsg::Connect { .. } => Err("already_connected"),
    }
}

/// Forward an opaque envelope to the OTHER seat of `match_id`, wherever it lives.
async fn forward_to_other(state: &SharedState, match_id: &str, from: ConnId, text: String) {
    let Some(m) = state.mp.get_match(match_id).await else {
        return;
    };
    let target = if m.conn_a.conn_id == from {
        Some(m.conn_b)
    } else if m.conn_b.conn_id == from {
        Some(m.conn_a)
    } else {
        None
    };
    if let Some(t) = target {
        state.bus.deliver(&t, text).await;
    }
}

#[cfg(test)]
mod tests {
    use tokio::sync::mpsc;
    use uuid::Uuid;

    use super::*;
    use crate::mp::MatchRecord;
    use crate::routes::test_support::test_state;
    use crate::store::ConnRef;

    // Keepalive is server-driven (RFC 6455): a browser can't originate pings, so
    // without this the ALB reaps a quiet-but-live match. The immediate first
    // interval tick lets us assert it in milliseconds instead of a full period —
    // a regression that drops the server ping fails here, not in production.
    #[tokio::test]
    async fn server_originates_keepalive_ping_frame() {
        use axum::routing::get;
        use axum::Router;
        use tokio_tungstenite::tungstenite::Message as WsMessage;

        let app = Router::new()
            .route("/v1/mp", get(mp_upgrade))
            .with_state(test_state());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let (mut ws, _) = tokio_tungstenite::connect_async(format!("ws://{addr}/v1/mp"))
            .await
            .expect("ws connect");

        // Ignore the app-level challenge text; require a Ping control frame promptly.
        let saw_ping = tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(Ok(frame)) = ws.next().await {
                if matches!(frame, WsMessage::Ping(_)) {
                    return true;
                }
            }
            false
        })
        .await
        .expect("server must send a ping before the timeout");

        assert!(saw_ping, "server must originate a WS Ping for keepalive");
    }

    fn make_conn_ref(state: &SharedState) -> (ConnId, mpsc::UnboundedReceiver<String>) {
        let conn_id = Uuid::new_v4();
        let (tx, rx) = mpsc::unbounded_channel();
        state.bus.register(conn_id, tx);
        (conn_id, rx)
    }

    // Seat A → B, seat B → A, stranger → neither. Covers relay_target_is_the_other_seat.
    #[tokio::test]
    async fn relay_routes_to_the_opposite_seat() {
        let state = test_state();
        let (conn_a, mut rx_a) = make_conn_ref(&state);
        let (conn_b, mut rx_b) = make_conn_ref(&state);
        let (conn_x, mut rx_x) = make_conn_ref(&state);

        let inst = state.bus.instance_id().to_owned();
        let ref_a = ConnRef {
            instance_id: inst.clone(),
            conn_id: conn_a,
        };
        let ref_b = ConnRef {
            instance_id: inst.clone(),
            conn_id: conn_b,
        };
        let rec = MatchRecord {
            game: "chess".into(),
            seat_a: "0xa".into(),
            seat_b: "0xb".into(),
            conn_a: ref_a,
            conn_b: ref_b,
            tunnel_id: None,
            latest_checkpoint: None,
        };
        state.mp.put_match("m1", rec).await;

        // A sends → B receives
        forward_to_other(&state, "m1", conn_a, "hello_from_a".into()).await;
        assert_eq!(rx_b.try_recv().unwrap(), "hello_from_a");
        assert!(rx_a.try_recv().is_err());

        // B sends → A receives
        forward_to_other(&state, "m1", conn_b, "hello_from_b".into()).await;
        assert_eq!(rx_a.try_recv().unwrap(), "hello_from_b");
        assert!(rx_b.try_recv().is_err());

        // Stranger sends → nobody receives
        forward_to_other(&state, "m1", conn_x, "intrude".into()).await;
        assert!(rx_a.try_recv().is_err());
        assert!(rx_b.try_recv().is_err());
        assert!(rx_x.try_recv().is_err());
    }

    // Quick-match: the earlier waiter (opponent) is seat A; the late joiner is seat B.
    #[test]
    fn quick_match_seat_a_is_earlier_waiter() {
        let conn_opp = ConnRef {
            instance_id: "i".into(),
            conn_id: Uuid::new_v4(),
        };
        let conn_me = ConnRef {
            instance_id: "i".into(),
            conn_id: Uuid::new_v4(),
        };
        let opponent = Waiting {
            wallet: "0xearly".into(),
            conn: conn_opp.clone(),
        };

        let (_, rec) = build_quick_match("chess", opponent, "0xlate", conn_me.clone());

        assert_eq!(rec.seat_a, "0xearly", "seat A must be the earlier waiter");
        assert_eq!(rec.seat_b, "0xlate", "seat B must be the late joiner");
        assert_eq!(
            rec.conn_a, conn_opp,
            "conn_a must be the opponent's ConnRef"
        );
        assert_eq!(rec.conn_b, conn_me, "conn_b must be the joiner's ConnRef");
    }

    // Challenge-match: the inviter is seat A; the accepter is seat B.
    #[test]
    fn challenge_match_seat_a_is_inviter() {
        let conn_inviter = ConnRef {
            instance_id: "i".into(),
            conn_id: Uuid::new_v4(),
        };
        let conn_accepter = ConnRef {
            instance_id: "i".into(),
            conn_id: Uuid::new_v4(),
        };
        let inv = DirectedInvite {
            from: "0xinviter".into(),
            to: "0xaccepter".into(),
            game: "ttt".into(),
            from_conn: conn_inviter.clone(),
        };

        let rec = build_challenge_match(&inv, "0xaccepter", conn_accepter.clone());

        assert_eq!(rec.seat_a, "0xinviter", "seat A must be the inviter");
        assert_eq!(rec.seat_b, "0xaccepter", "seat B must be the accepter");
        assert_eq!(
            rec.conn_a, conn_inviter,
            "conn_a must be the inviter's ConnRef"
        );
        assert_eq!(
            rec.conn_b, conn_accepter,
            "conn_b must be the accepter's ConnRef"
        );
    }
}
