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
    let (ctrl_tx, mut ctrl_rx) = mpsc::unbounded_channel::<String>();
    let nonce = conn_id.to_string();
    let _ = tx.send(
        ServerMsg::Challenge {
            nonce: nonce.clone(),
        }
        .to_text(),
    );

    let mut wallet: Option<String> = None;
    let mut joined_games: HashSet<String> = HashSet::new();
    let mut matches: std::collections::HashMap<String, MatchRecord> =
        std::collections::HashMap::new();

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
            evict = ctrl_rx.recv() => {
                // The ctrl channel never closes before the socket; on `None` the next loop
                // iteration drops out via another arm, so this only acts on a match-id.
                if let Some(match_id) = evict {
                    matches.remove(&match_id);
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
                    &ctrl_tx,
                    conn_id,
                    &nonce,
                    &mut wallet,
                    &mut joined_games,
                    &mut matches,
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

#[allow(clippy::too_many_arguments)] // per-connection state refs; no meaningful grouping
async fn handle_message(
    state: &SharedState,
    tx: &mpsc::UnboundedSender<String>,
    ctrl_tx: &mpsc::UnboundedSender<String>,
    conn_id: ConnId,
    nonce: &str,
    wallet: &mut Option<String>,
    joined: &mut HashSet<String>,
    matches: &mut std::collections::HashMap<String, MatchRecord>,
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
            state.bus.register(conn_id, tx.clone(), ctrl_tx.clone());
            state.mp.set_presence(&w, here(state, conn_id)).await;
            *wallet = Some(w);
            Ok(())
        }
        other => {
            let w = wallet.as_ref().ok_or("not_authenticated")?.clone();
            handle_authed(state, conn_id, &w, joined, matches, other).await
        }
    }
}

async fn handle_authed(
    state: &SharedState,
    conn_id: ConnId,
    wallet: &str,
    joined: &mut HashSet<String>,
    matches: &mut std::collections::HashMap<String, MatchRecord>,
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
            // PvP throughput: the relay is the one point that sees every move, so count
            // each co-signed MOVE here — one action per move, the off-chain nonce step,
            // parity with self-play's per-update heartbeat. The ACK half is a separate
            // frame and is skipped (else every move double-counts). Only the transport
            // envelope (`t`/`kind`) is read; the game-specific move payload stays opaque.
            // The match record is cached per-connection so the store is hit at most once.
            relay_to_other(state, matches, conn_id, match_id, payload).await;
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
        // Task 4 wires this up; reject until then so the compiler sees all arms.
        ClientMsg::Resume { .. } => Err("not_implemented"),
        ClientMsg::Connect { .. } => Err("already_connected"),
    }
}

/// Forward an opaque envelope to the OTHER seat of `match_id`, wherever it lives.
/// Used for the `party.hello` path where a per-connection cache is not available.
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

/// Relay a frame using a per-connection match cache: fetch the `MatchRecord` from the
/// store at most once per match, then route every subsequent frame from the in-task copy.
/// Removes both per-move Redis GETs (counting + forwarding). conn_a/conn_b are fixed at
/// match creation, so the cached copy is valid for the life of the connection.
async fn relay_to_other(
    state: &SharedState,
    cache: &mut std::collections::HashMap<String, MatchRecord>,
    from: ConnId,
    match_id: String,
    payload: String,
) {
    if !cache.contains_key(&match_id) {
        match state.mp.get_match(&match_id).await {
            Some(m) => {
                cache.insert(match_id.clone(), m);
            }
            None => return, // unknown match: drop, same as today's get_match None
        }
    }
    let m = &cache[&match_id];
    if relay_payload_is_move(&payload) {
        state.actions.incr(&m.game, 1);
    }
    let target = if m.conn_a.conn_id == from {
        m.conn_b.clone()
    } else if m.conn_b.conn_id == from {
        m.conn_a.clone()
    } else {
        return; // not a seat in this match
    };
    let envelope = ServerMsg::Relay { match_id, payload }.to_text();
    state.bus.deliver(&target, envelope).await;
}

/// True iff a relayed payload carries a co-signed MOVE frame. Fast path: read the outer
/// `kind` tag (the SDK stamps it) without touching the opaque `data`. Fallback: legacy
/// frames without the outer tag are detected by the old inner parse, so SDK/backend can
/// deploy independently. Either way the game-specific move payload is never inspected.
fn relay_payload_is_move(payload: &str) -> bool {
    let Ok(envelope) = serde_json::from_str::<serde_json::Value>(payload) else {
        return false;
    };
    if envelope.get("t").and_then(serde_json::Value::as_str) != Some("frame") {
        return false;
    }
    // Fast path: outer kind tag.
    if let Some(kind) = envelope.get("kind").and_then(serde_json::Value::as_str) {
        return kind == "move";
    }
    // Fallback: legacy frames carry kind only inside the opaque inner `data`.
    let Some(frame_json) = envelope.get("data").and_then(serde_json::Value::as_str) else {
        return false;
    };
    serde_json::from_str::<serde_json::Value>(frame_json)
        .ok()
        .and_then(|f| {
            f.get("kind")
                .and_then(serde_json::Value::as_str)
                .map(|k| k == "move")
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
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
        let (ctrl_tx, _ctrl_rx) = mpsc::unbounded_channel();
        state.bus.register(conn_id, tx, ctrl_tx);
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

    /// Build the relay envelope the SPA sends: an opaque `data` string wrapping a frame.
    fn relay_frame(kind: &str) -> String {
        let frame = serde_json::json!({ "kind": kind, "nonce": "1" }).to_string();
        serde_json::json!({ "t": "frame", "data": frame }).to_string()
    }

    // The fast path: an outer `kind` tag is read WITHOUT parsing the opaque inner `data`.
    // `data` is deliberately not valid JSON here — if the backend still tried to parse it,
    // move detection would fail. It must trust the outer tag.
    #[test]
    fn move_detection_reads_outer_kind_without_parsing_data() {
        let moved =
            serde_json::json!({ "t": "frame", "kind": "move", "data": "::opaque::" }).to_string();
        let acked =
            serde_json::json!({ "t": "frame", "kind": "ack", "data": "::opaque::" }).to_string();
        assert!(relay_payload_is_move(&moved), "outer kind=move counts");
        assert!(!relay_payload_is_move(&acked), "outer kind=ack does not");
    }

    // Throughput counting hinges on this discriminator: a MOVE is one action, an ACK is
    // the co-sign of that same move (not a new action), and peer/control messages aren't
    // game actions at all. Miscount any of these and PvP TPS is wrong.
    #[test]
    fn only_move_frames_count_as_actions() {
        assert!(
            relay_payload_is_move(&relay_frame("move")),
            "MOVE is an action"
        );
        assert!(!relay_payload_is_move(&relay_frame("ack")), "ACK is not");
        let hello = serde_json::json!({ "t": "hello", "ephemeralPubkey": "0xaa" }).to_string();
        assert!(
            !relay_payload_is_move(&hello),
            "peer messages are not actions"
        );
        assert!(
            !relay_payload_is_move("not json"),
            "malformed payload is not a move"
        );
    }

    // A second relay on the same match must NOT hit the store again: the per-connection
    // cache serves conn_a/conn_b after the first fetch. We prove it by overwriting the
    // store record after the first relay and asserting the second still routes correctly.
    #[tokio::test]
    async fn relay_uses_cached_match_after_first_fetch() {
        let state = test_state();
        let (conn_a, _rx_a) = make_conn_ref(&state);
        let (conn_b, mut rx_b) = make_conn_ref(&state);
        let inst = state.bus.instance_id().to_owned();
        let rec = MatchRecord {
            game: "ttt".into(),
            seat_a: "0xa".into(),
            seat_b: "0xb".into(),
            conn_a: ConnRef {
                instance_id: inst.clone(),
                conn_id: conn_a,
            },
            conn_b: ConnRef {
                instance_id: inst,
                conn_id: conn_b,
            },
            tunnel_id: None,
            latest_checkpoint: None,
        };
        state.mp.put_match("m1", rec).await;
        let mut cache: HashMap<String, MatchRecord> = HashMap::new();

        // first relay populates the cache and delivers to B
        relay_to_other(&state, &mut cache, conn_a, "m1".into(), "first".into()).await;
        assert!(rx_b.try_recv().is_ok(), "first relay delivers to B");
        // delete the authoritative record; the cache must still serve the route
        state
            .mp
            .put_match(
                "m1",
                MatchRecord {
                    game: "ttt".into(),
                    seat_a: "x".into(),
                    seat_b: "x".into(),
                    conn_a: ConnRef {
                        instance_id: "gone".into(),
                        conn_id: uuid::Uuid::nil(),
                    },
                    conn_b: ConnRef {
                        instance_id: "gone".into(),
                        conn_id: uuid::Uuid::nil(),
                    },
                    tunnel_id: None,
                    latest_checkpoint: None,
                },
            )
            .await;
        relay_to_other(&state, &mut cache, conn_a, "m1".into(), "second".into()).await;
        assert!(
            rx_b.try_recv().is_ok(),
            "second relay still routes from cache, not the overwritten store"
        );
    }

    // The behavior that was missing in PvP: a relayed MOVE must feed the actions counter
    // (so it shows up as TPS), while its ACK half must not double-count.
    #[tokio::test]
    async fn relayed_move_records_one_action_and_ack_does_not() {
        let state = test_state();
        let (conn_a, _rx_a) = make_conn_ref(&state);
        let (conn_b, _rx_b) = make_conn_ref(&state);
        let inst = state.bus.instance_id().to_owned();
        let rec = MatchRecord {
            game: "tictactoe".into(),
            seat_a: "0xa".into(),
            seat_b: "0xb".into(),
            conn_a: ConnRef {
                instance_id: inst.clone(),
                conn_id: conn_a,
            },
            conn_b: ConnRef {
                instance_id: inst,
                conn_id: conn_b,
            },
            tunnel_id: None,
            latest_checkpoint: None,
        };
        state.mp.put_match("m1", rec).await;
        let mut joined = HashSet::new();
        let mut matches = HashMap::new();

        handle_authed(
            &state,
            conn_a,
            "0xa",
            &mut joined,
            &mut matches,
            ClientMsg::Relay {
                match_id: "m1".into(),
                payload: relay_frame("move"),
            },
        )
        .await
        .unwrap();
        // Move is counted locally; drain into control before asserting.
        for (g, d) in state.actions.drain_deltas() {
            state.control.add_actions(&g, d).await;
        }
        assert_eq!(
            state.control.snapshot().await.total_actions,
            1,
            "a relayed MOVE must record one action"
        );

        handle_authed(
            &state,
            conn_b,
            "0xb",
            &mut joined,
            &mut matches,
            ClientMsg::Relay {
                match_id: "m1".into(),
                payload: relay_frame("ack"),
            },
        )
        .await
        .unwrap();
        // ACK must not produce any delta; drain should yield nothing.
        for (g, d) in state.actions.drain_deltas() {
            state.control.add_actions(&g, d).await;
        }
        assert_eq!(
            state.control.snapshot().await.total_actions,
            1,
            "the ACK half must not add a second action"
        );
    }
}
