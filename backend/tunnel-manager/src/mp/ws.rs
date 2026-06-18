//! `GET /v1/mp` WebSocket. Upgrade → challenge → connect-auth → register presence + a local
//! outbound channel via Bus → drive matchmaking/relay through MpStore + Bus::deliver.
use std::collections::{HashMap, HashSet};
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

/// Cached routing decision for a single connection after matchmaking.
/// Lets the relay path avoid a Redis lookup on every move.
#[derive(Clone, Debug)]
struct MatchRouting {
    match_id: String,
    game: String,
    opponent: ConnRef,
}

/// Mutable per-connection state carried across WebSocket messages.
#[derive(Default)]
struct ConnState {
    wallet: Option<String>,
    joined_games: HashSet<String>,
    match_routing: Option<MatchRouting>,
    /// Batched action-counter increments for this connection, flushed to `ControlStore` every
    /// 100 ms and on disconnect so the hot-path MOVE relay never blocks on a store write.
    pending_actions: HashMap<String, u64>,
}

fn here(state: &SharedState, conn: ConnId) -> ConnRef {
    ConnRef {
        instance_id: state.bus.instance_id().to_owned(),
        conn_id: conn,
    }
}

/// Returns the ConnRef of the other seat in `rec`, or `None` if `conn_id` is not a seat.
fn other_seat(rec: &MatchRecord, conn_id: ConnId) -> Option<ConnRef> {
    if rec.conn_a.conn_id == conn_id {
        Some(rec.conn_b.clone())
    } else if rec.conn_b.conn_id == conn_id {
        Some(rec.conn_a.clone())
    } else {
        None
    }
}

/// Seeds `conn_state.match_routing` from a freshly created match record.
fn seed_match_routing(
    conn_state: &mut ConnState,
    conn_id: ConnId,
    match_id: String,
    game: String,
    rec: &MatchRecord,
) {
    if let Some(opponent) = other_seat(rec, conn_id) {
        conn_state.match_routing = Some(MatchRouting {
            match_id,
            game,
            opponent,
        });
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

    let mut conn_state = ConnState {
        wallet: None,
        joined_games: HashSet::new(),
        match_routing: None,
        pending_actions: HashMap::new(),
    };

    let mut keepalive = tokio::time::interval(KEEPALIVE_PING_INTERVAL);
    let mut flush_interval = tokio::time::interval(Duration::from_millis(100));
    flush_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // A stall in `handle_message` must not burst-fire catch-up ticks and trip the
    // unanswered-ping check on a connection that is actually alive.
    keepalive.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut ping_unanswered = false;

    // Single loop owns the sink, so reads, queued outbound, keepalive pings,
    // and batched action-counter flushes never contend.
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
            _ = flush_interval.tick() => {
                for (game, count) in conn_state.pending_actions.drain() {
                    state.control.add_actions_batch(&game, count as i64).await;
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
                    &mut conn_state,
                    client_msg,
                )
                .await
                {
                    let _ = tx.send(ServerMsg::error(code, code).to_text());
                }
            }
        }
    }

    // Flush any remaining batched actions before cleanup so moves are not lost.
    for (game, count) in conn_state.pending_actions.drain() {
        state.control.add_actions_batch(&game, count as i64).await;
    }

    // Disconnect cleanup: conditional presence clear + leave every joined queue.
    if let Some(w) = conn_state.wallet {
        state.mp.clear_presence_if(&w, conn_id).await;
        for g in conn_state.joined_games {
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
    conn_state: &mut ConnState,
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
            conn_state.wallet = Some(w);
            Ok(())
        }
        other => {
            let w = conn_state
                .wallet
                .as_ref()
                .ok_or("not_authenticated")?
                .clone();
            handle_authed(state, conn_id, &w, conn_state, other).await
        }
    }
}

async fn handle_authed(
    state: &SharedState,
    conn_id: ConnId,
    wallet: &str,
    conn_state: &mut ConnState,
    msg: ClientMsg,
) -> Result<(), &'static str> {
    match msg {
        ClientMsg::QueueJoin { game } => {
            conn_state.joined_games.insert(game.clone());
            let me = Waiting {
                wallet: wallet.to_owned(),
                conn: here(state, conn_id),
            };
            if let Some(opp) = state.mp.join_or_pair(&game, me).await {
                let (match_id, rec) = build_quick_match(&game, opp, wallet, here(state, conn_id));
                state.mp.put_match(&match_id, rec.clone()).await;
                seed_match_routing(conn_state, conn_id, match_id.clone(), game.clone(), &rec);
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
            for g in conn_state.joined_games.drain() {
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
            seed_match_routing(
                conn_state,
                conn_id,
                match_id.clone(),
                rec.game.clone(),
                &rec,
            );
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
            let routing = if let Some(r) = conn_state
                .match_routing
                .as_ref()
                .filter(|r| r.match_id == match_id)
            {
                r.clone()
            } else if let Some(m) = state.mp.get_match(&match_id).await {
                let Some(opponent) = other_seat(&m, conn_id) else {
                    return Ok(());
                };
                MatchRouting {
                    match_id: match_id.clone(),
                    game: m.game.clone(),
                    opponent,
                }
            } else {
                return Ok(());
            };
            conn_state.match_routing = Some(routing.clone());

            if relay_payload_is_move(&payload) {
                *conn_state
                    .pending_actions
                    .entry(routing.game.clone())
                    .or_insert(0) += 1;
            }
            let envelope = ServerMsg::Relay {
                match_id: match_id.clone(),
                payload,
            }
            .to_text();
            state.bus.deliver(&routing.opponent, envelope).await;
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
    if let Some(t) = other_seat(&m, from) {
        state.bus.deliver(&t, text).await;
    }
}

/// True iff a relayed payload carries a co-signed MOVE frame (not an ACK or a peer
/// message). Drives PvP throughput counting: one MOVE = one action = the off-chain nonce
/// step. Reads only the transport envelope (`t`) and the frame discriminator (`kind`) —
/// the game-specific move payload is never inspected. Any malformed/foreign payload
/// counts as "not a move" so the relay stays best-effort and game-agnostic.
fn relay_payload_is_move(payload: &str) -> bool {
    let Ok(envelope) = serde_json::from_str::<serde_json::Value>(payload) else {
        return false;
    };
    if envelope.get("t").and_then(serde_json::Value::as_str) != Some("frame") {
        return false;
    }
    let Some(frame_json) = envelope.get("data").and_then(serde_json::Value::as_str) else {
        return false;
    };
    // The inner frame is a JSON string produced by the SDK without extra whitespace.
    // This is a deliberate hot-path heuristic: it avoids a second full parse by checking
    // for the exact `"kind":"move"` substring. Payloads that do not follow this
    // serialization are treated best-effort as "not a move".
    frame_json.starts_with(r#"{"kind":"move""#) || frame_json.contains(r#""kind":"move""#)
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

    async fn flush_pending_actions(
        control: &std::sync::Arc<dyn crate::store::ControlStore>,
        conn_state: &mut ConnState,
    ) {
        for (game, count) in conn_state.pending_actions.drain() {
            control.add_actions_batch(&game, count as i64).await;
        }
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

    // The behavior that was missing in PvP: a relayed MOVE must feed the actions counter
    // (so it shows up as TPS), while its ACK half must not double-count. Each connection
    // must carry its own routing cache so the relay actually reaches the opposite seat.
    #[tokio::test]
    async fn relayed_move_records_one_action_and_ack_does_not() {
        let state = test_state();
        let (conn_a, mut rx_a) = make_conn_ref(&state);
        let (conn_b, mut rx_b) = make_conn_ref(&state);
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

        let mut conn_state_a = ConnState::default();
        handle_authed(
            &state,
            conn_a,
            "0xa",
            &mut conn_state_a,
            ClientMsg::Relay {
                match_id: "m1".into(),
                payload: relay_frame("move"),
            },
        )
        .await
        .unwrap();
        flush_pending_actions(&state.control, &mut conn_state_a).await;
        assert_eq!(
            state.control.snapshot().await.total_actions,
            1,
            "a relayed MOVE must record one action"
        );
        assert!(rx_b.try_recv().is_ok(), "MOVE must be delivered to seat B");
        assert!(rx_a.try_recv().is_err(), "MOVE must not echo to seat A");
        let a_routing = conn_state_a
            .match_routing
            .as_ref()
            .expect("A's cache must be populated by fallback");
        assert_eq!(a_routing.match_id, "m1");
        assert_eq!(a_routing.game, "tictactoe");
        assert_eq!(a_routing.opponent.conn_id, conn_b);

        let mut conn_state_b = ConnState::default();
        handle_authed(
            &state,
            conn_b,
            "0xb",
            &mut conn_state_b,
            ClientMsg::Relay {
                match_id: "m1".into(),
                payload: relay_frame("ack"),
            },
        )
        .await
        .unwrap();
        flush_pending_actions(&state.control, &mut conn_state_b).await;
        assert_eq!(
            state.control.snapshot().await.total_actions,
            1,
            "the ACK half must not add a second action"
        );
        assert!(rx_a.try_recv().is_ok(), "ACK must be delivered to seat A");
        assert!(rx_b.try_recv().is_err(), "ACK must not echo to seat B");
        let b_routing = conn_state_b
            .match_routing
            .as_ref()
            .expect("B's cache must be populated by fallback");
        assert_eq!(b_routing.match_id, "m1");
        assert_eq!(b_routing.game, "tictactoe");
        assert_eq!(b_routing.opponent.conn_id, conn_a);
    }

    // Cache-hit path: a Relay whose ConnState already holds the routing must reach the
    // cached opponent and count the action without touching the store.
    #[tokio::test]
    async fn cache_hit_relay_routes_without_fallback() {
        let state = test_state();
        let (conn_a, mut rx_a) = make_conn_ref(&state);
        let (conn_b, mut rx_b) = make_conn_ref(&state);
        let inst = state.bus.instance_id().to_owned();

        // Intentionally no MatchRecord in the store: the only path is the cache.
        let mut conn_state_a = ConnState {
            wallet: None,
            joined_games: HashSet::new(),
            match_routing: Some(MatchRouting {
                match_id: "m1".into(),
                game: "tictactoe".into(),
                opponent: ConnRef {
                    instance_id: inst,
                    conn_id: conn_b,
                },
            }),
            pending_actions: HashMap::new(),
        };

        handle_authed(
            &state,
            conn_a,
            "0xa",
            &mut conn_state_a,
            ClientMsg::Relay {
                match_id: "m1".into(),
                payload: relay_frame("move"),
            },
        )
        .await
        .unwrap();
        flush_pending_actions(&state.control, &mut conn_state_a).await;

        assert_eq!(
            state.control.snapshot().await.total_actions,
            1,
            "cache-hit MOVE must record one action"
        );
        assert!(
            rx_b.try_recv().is_ok(),
            "cache-hit MOVE must reach cached opponent"
        );
        assert!(
            rx_a.try_recv().is_err(),
            "cache-hit MOVE must not echo to sender"
        );
    }

    // A stale or mismatched cache must not prevent a Relay for a different match from
    // falling back to the store and updating the cache to the correct route.
    #[tokio::test]
    async fn relay_cache_miss_falls_back_and_updates_cache() {
        let state = test_state();
        let (conn_a, mut rx_a) = make_conn_ref(&state);
        let (conn_b, mut rx_b) = make_conn_ref(&state);
        let (conn_c, mut rx_c) = make_conn_ref(&state);
        let inst = state.bus.instance_id().to_owned();

        state
            .mp
            .put_match(
                "m1",
                MatchRecord {
                    game: "tictactoe".into(),
                    seat_a: "0xa".into(),
                    seat_b: "0xb".into(),
                    conn_a: ConnRef {
                        instance_id: inst.clone(),
                        conn_id: conn_a,
                    },
                    conn_b: ConnRef {
                        instance_id: inst.clone(),
                        conn_id: conn_b,
                    },
                    tunnel_id: None,
                    latest_checkpoint: None,
                },
            )
            .await;

        state
            .mp
            .put_match(
                "m2",
                MatchRecord {
                    game: "chess".into(),
                    seat_a: "0xa".into(),
                    seat_b: "0xc".into(),
                    conn_a: ConnRef {
                        instance_id: inst.clone(),
                        conn_id: conn_a,
                    },
                    conn_b: ConnRef {
                        instance_id: inst,
                        conn_id: conn_c,
                    },
                    tunnel_id: None,
                    latest_checkpoint: None,
                },
            )
            .await;

        // A's cache points to B from m1, but it relays a move for m2.
        let mut conn_state_a = ConnState {
            wallet: None,
            joined_games: HashSet::new(),
            match_routing: Some(MatchRouting {
                match_id: "m1".into(),
                game: "tictactoe".into(),
                opponent: ConnRef {
                    instance_id: "other-instance".into(),
                    conn_id: conn_b,
                },
            }),
            pending_actions: HashMap::new(),
        };

        handle_authed(
            &state,
            conn_a,
            "0xa",
            &mut conn_state_a,
            ClientMsg::Relay {
                match_id: "m2".into(),
                payload: relay_frame("move"),
            },
        )
        .await
        .unwrap();

        assert!(
            rx_c.try_recv().is_ok(),
            "m2 MOVE must reach m2 opponent (C)"
        );
        assert!(
            rx_a.try_recv().is_err(),
            "sender must not receive its own relay"
        );
        assert!(
            rx_b.try_recv().is_err(),
            "cached m1 opponent must not receive m2 relay"
        );

        let routing = conn_state_a
            .match_routing
            .as_ref()
            .expect("cache must be updated to m2");
        assert_eq!(routing.match_id, "m2");
        assert_eq!(routing.game, "chess");
        assert_eq!(routing.opponent.conn_id, conn_c);
    }

    // QueueJoin populates the local connection's cache immediately. The opponent lazily
    // populates its own cache on its first Relay fallback.
    #[tokio::test]
    async fn queue_join_populates_local_routing() {
        let state = test_state();
        let (conn_a, mut _rx_a) = make_conn_ref(&state);
        let (conn_b, mut _rx_b) = make_conn_ref(&state);

        let mut conn_state_a = ConnState::default();
        handle_authed(
            &state,
            conn_a,
            "0xa",
            &mut conn_state_a,
            ClientMsg::QueueJoin { game: "ttt".into() },
        )
        .await
        .unwrap();
        assert!(
            conn_state_a.match_routing.is_none(),
            "waiter has no routing yet"
        );

        let mut conn_state_b = ConnState::default();
        handle_authed(
            &state,
            conn_b,
            "0xb",
            &mut conn_state_b,
            ClientMsg::QueueJoin { game: "ttt".into() },
        )
        .await
        .unwrap();

        let b_routing = conn_state_b
            .match_routing
            .as_ref()
            .expect("joiner must have routing after pairing");
        assert_eq!(b_routing.game, "ttt");
        assert_eq!(b_routing.opponent.conn_id, conn_a);
    }

    // ChallengeAccept populates the accepter's local cache immediately. The inviter
    // lazily populates its own cache on its first Relay fallback.
    #[tokio::test]
    async fn challenge_accept_populates_local_routing() {
        let state = test_state();
        let (conn_inviter, mut _rx_inviter) = make_conn_ref(&state);
        let (conn_accepter, mut rx_accepter) = make_conn_ref(&state);

        state
            .mp
            .set_presence("0xinviter", here(&state, conn_inviter))
            .await;
        state
            .mp
            .set_presence("0xaccepter", here(&state, conn_accepter))
            .await;

        let mut conn_state_inviter = ConnState::default();
        handle_authed(
            &state,
            conn_inviter,
            "0xinviter",
            &mut conn_state_inviter,
            ClientMsg::ChallengeCreate {
                target_wallet: "0xaccepter".into(),
                game: "ttt".into(),
            },
        )
        .await
        .unwrap();

        let incoming = rx_accepter.try_recv().expect("accepter receives challenge");
        let incoming_json: serde_json::Value = serde_json::from_str(&incoming).unwrap();
        let match_id = incoming_json["matchId"]
            .as_str()
            .expect("challenge has matchId")
            .to_owned();

        let mut conn_state_accepter = ConnState::default();
        handle_authed(
            &state,
            conn_accepter,
            "0xaccepter",
            &mut conn_state_accepter,
            ClientMsg::ChallengeAccept {
                match_id: match_id.clone(),
            },
        )
        .await
        .unwrap();

        let acc_routing = conn_state_accepter
            .match_routing
            .as_ref()
            .expect("accepter must have routing after accept");
        assert_eq!(acc_routing.match_id, match_id);
        assert_eq!(acc_routing.game, "ttt");
        assert_eq!(acc_routing.opponent.conn_id, conn_inviter);
    }
}
