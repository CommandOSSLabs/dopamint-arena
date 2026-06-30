//! Arena match rendezvous: binds the two relay connections for one allocate-minted match — the
//! user's WS connection and the co-located bot's virtual bus connection — and completes the
//! `MatchRecord` so [`crate::mp::ws::relay_to_other`] can route between them.
//!
//! This is a JOIN-BY-MATCHID, never matchmaking. The user funded a SPECIFIC tunnel bound to a
//! SPECIFIC bot at allocate (ADR-0025); pairing them with an arbitrary queue peer would settle
//! against the wrong tunnel. The two connections arrive asynchronously and in EITHER order (the bot
//! after `/v1/arena/opened` drives `play_arena_match`; the user when its browser connects `/v1/mp`),
//! so completion fires on whichever binds second — structurally the parked-waiter case the human
//! path's `create_and_announce_match` already handles, but keyed by the pre-minted id with fixed
//! seats (user = party A, bot = party B).
//!
//! Completion mirrors the human path: `put_match` + `MatchFound` to the user + cache `populate`. The
//! bot waits on a oneshot (it must not send its hello before routing is live, or the frame is
//! dropped and the handshake deadlocks); the user waits passively for `MatchFound`.

use std::collections::HashMap;
use std::sync::Mutex;

use tokio::sync::oneshot;

use crate::mp::protocol::ServerMsg;
use crate::mp::MatchRecord;
use crate::state::SharedState;
use crate::store::ConnRef;

/// One match awaiting both of its connections. Seeded at allocate with the metadata known then; the
/// two `conn_*` slots fill as each side binds.
struct PendingMatch {
    game: String,
    /// Party A wallet — the user who allocated (authorizes the join).
    seat_a: String,
    /// Party B identity — the reserved bot's on-chain address.
    seat_b: String,
    tunnel_id: String,
    /// The user's WS connection (party A); set by [`ArenaRendezvous::bind_user`].
    conn_a: Option<ConnRef>,
    /// The bot's virtual bus connection (party B); set by [`ArenaRendezvous::bind_bot`].
    conn_b: Option<ConnRef>,
    /// Resolved once both connections are bound and the match is live, waking the bot to play. Set
    /// when the bot binds first; `None` once consumed or if the user bound first.
    bot_ready: Option<oneshot::Sender<()>>,
}

/// Per-instance rendezvous for arena matches, mirroring [`crate::fleet::BotPool`]'s ownership: a
/// shared `AppState` field used through `&self`, internally synchronized. The lock guards only map
/// mutation; the completion IO (`put_match`/`deliver`/`populate`) runs after the guard is dropped.
#[derive(Default)]
pub struct ArenaRendezvous {
    pending: Mutex<HashMap<String, PendingMatch>>,
}

impl ArenaRendezvous {
    /// Seed a pending match at allocate, before either side connects. Overwrites any prior entry for
    /// a re-allocated id (its stale half-binding is abandoned, same as a dropped reservation).
    pub fn seed(
        &self,
        match_id: &str,
        game: &str,
        user_wallet: &str,
        bot_address: &str,
        tunnel_id: &str,
    ) {
        self.pending.lock().unwrap().insert(
            match_id.to_owned(),
            PendingMatch {
                game: game.to_owned(),
                seat_a: user_wallet.to_owned(),
                seat_b: bot_address.to_owned(),
                tunnel_id: tunnel_id.to_owned(),
                conn_a: None,
                conn_b: None,
                bot_ready: None,
            },
        );
    }

    /// The co-located bot binds its relay connection. Returns a receiver that resolves once the user
    /// also joins and the match is live — the bot awaits it before sending its first frame. If the
    /// user already joined (user-first), completion runs here and the receiver is pre-resolved. An
    /// unknown match id resolves the receiver to `Err` (sender dropped) so the bot aborts, not hangs.
    pub async fn bind_bot(
        &self,
        state: &SharedState,
        match_id: &str,
        conn_b: ConnRef,
    ) -> oneshot::Receiver<()> {
        let (tx, rx) = oneshot::channel();
        let ready = {
            let mut g = self.pending.lock().unwrap();
            match g.get_mut(match_id) {
                None => return rx, // unknown id: tx drops → rx resolves Err → bot aborts
                Some(p) => {
                    p.conn_b = Some(conn_b);
                    p.bot_ready = Some(tx);
                    if p.conn_a.is_some() {
                        g.remove(match_id) // user-first: complete now
                    } else {
                        None // bot-first: park until the user joins
                    }
                }
            }
        };
        if let Some(pending) = ready {
            complete(state, match_id, pending).await;
        }
        rx
    }

    /// The user's WS connection joins by match id (the `arena.join` control message). Fills party A
    /// and, if the bot is already present, completes the match. `false` if the id is unknown or the
    /// joining wallet is not the allocator (a foreign join attempt).
    pub async fn bind_user(
        &self,
        state: &SharedState,
        match_id: &str,
        conn_a: ConnRef,
        wallet: &str,
    ) -> bool {
        let ready = {
            let mut g = self.pending.lock().unwrap();
            match g.get_mut(match_id) {
                None => return false,
                Some(p) => {
                    if p.seat_a != wallet {
                        return false; // only the user who allocated may join this match
                    }
                    p.conn_a = Some(conn_a);
                    if p.conn_b.is_some() {
                        g.remove(match_id) // bot-first: complete now
                    } else {
                        None // user-first: park until the bot binds
                    }
                }
            }
        };
        if let Some(pending) = ready {
            complete(state, match_id, pending).await;
        }
        true
    }

    /// Drop a pending match that never completed (the bot's match ended, or it gave up waiting). A
    /// no-op once completed (the entry was removed at completion).
    pub fn forget(&self, match_id: &str) {
        self.pending.lock().unwrap().remove(match_id);
    }
}

/// Persist the completed `MatchRecord`, announce it to the user, warm the user's relay cache, and
/// wake the bot. Runs only with both connections bound (the second binder removed the entry).
async fn complete(state: &SharedState, match_id: &str, pending: PendingMatch) {
    let conn_a = pending.conn_a.expect("conn_a bound at completion");
    let conn_b = pending.conn_b.expect("conn_b bound at completion");
    let rec = MatchRecord {
        game: pending.game.clone(),
        seat_a: pending.seat_a.clone(),
        seat_b: pending.seat_b.clone(),
        conn_a: conn_a.clone(),
        conn_b,
        tunnel_id: Some(pending.tunnel_id.clone()),
        latest_checkpoint: None,
    };
    state.mp.put_match(match_id, rec.clone()).await;
    // Only the user (party A) needs `MatchFound` — the bot got its match via the pool `Opened` push
    // and is woken by the oneshot below. The user is always party A in the arena flow.
    state
        .bus
        .deliver(
            &conn_a,
            ServerMsg::MatchFound {
                match_id: match_id.to_owned(),
                role: "A".into(),
                opponent_wallet: pending.seat_b.clone(),
                game: pending.game.clone(),
            }
            .to_text(),
        )
        .await;
    state.bus.populate(&conn_a, match_id, &rec).await;
    if let Some(tx) = pending.bot_ready {
        let _ = tx.send(()); // bot may have aborted; ignore a closed receiver
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use uuid::Uuid;

    fn conn_ref(state: &SharedState) -> ConnRef {
        ConnRef {
            instance_id: state.bus.instance_id().to_owned(),
            conn_id: Uuid::new_v4(),
        }
    }

    // Bot binds first, then the user joins: completion fires on the user's bind, the MatchRecord is
    // persisted with fixed seats (user = A, bot = B) + the tunnel, and the bot's parked receiver
    // resolves so it can start playing. This is the common ordering (bot is notified `Opened` before
    // the browser connects).
    #[tokio::test]
    async fn bot_first_then_user_completes_and_wakes_bot() {
        let state = AppState::in_memory_for_test();
        let rdv = ArenaRendezvous::default();
        rdv.seed("m1", "blackjack", "0xuser", "0xbot", "0xtunnel");

        let mut bot_ready = rdv.bind_bot(&state, "m1", conn_ref(&state)).await;
        assert!(
            bot_ready.try_recv().is_err(),
            "bot parks until the user joins"
        );

        assert!(
            rdv.bind_user(&state, "m1", conn_ref(&state), "0xuser")
                .await,
            "the allocating user joins"
        );
        bot_ready
            .await
            .expect("bot is woken once the match is live");

        let rec = state.mp.get_match("m1").await.expect("match persisted");
        assert_eq!(rec.seat_a, "0xuser");
        assert_eq!(rec.seat_b, "0xbot");
        assert_eq!(rec.tunnel_id.as_deref(), Some("0xtunnel"));
    }

    // User joins first (browser connected before the bot was notified), then the bot binds:
    // completion fires on the bot's bind and its receiver is already resolved.
    #[tokio::test]
    async fn user_first_then_bot_completes_immediately() {
        let state = AppState::in_memory_for_test();
        let rdv = ArenaRendezvous::default();
        rdv.seed("m2", "blackjack", "0xuser", "0xbot", "0xtunnel");

        assert!(
            rdv.bind_user(&state, "m2", conn_ref(&state), "0xuser")
                .await
        );
        let bot_ready = rdv.bind_bot(&state, "m2", conn_ref(&state)).await;
        bot_ready
            .await
            .expect("bot wakes immediately when the user joined first");
        assert!(state.mp.get_match("m2").await.is_some());
    }

    // A foreign wallet cannot hijack another user's allocated match.
    #[tokio::test]
    async fn user_join_rejects_foreign_wallet() {
        let state = AppState::in_memory_for_test();
        let rdv = ArenaRendezvous::default();
        rdv.seed("m3", "blackjack", "0xowner", "0xbot", "0xtunnel");
        assert!(
            !rdv.bind_user(&state, "m3", conn_ref(&state), "0xattacker")
                .await,
            "only the allocator may join"
        );
    }

    // Binding the bot to an unseeded/unknown match id resolves the receiver to Err so the bot aborts
    // and re-registers instead of hanging on a match that will never complete.
    #[tokio::test]
    async fn bind_unknown_match_aborts_the_bot() {
        let state = AppState::in_memory_for_test();
        let rdv = ArenaRendezvous::default();
        let ready = rdv.bind_bot(&state, "ghost", conn_ref(&state)).await;
        assert!(
            ready.await.is_err(),
            "unknown match id must not leave the bot parked"
        );
    }
}
