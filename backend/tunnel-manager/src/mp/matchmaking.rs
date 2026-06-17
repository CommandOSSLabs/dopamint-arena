//! Quick-Match queueing + Challenge invites. Both front doors converge on a `MatchRecord`.
//! Pure over `AppState` (no IO) — the WS layer supplies conn ids and pushes the results.

use uuid::Uuid;

use crate::mp::{ConnId, DirectedInvite, GameId, MatchId, MatchRecord, Waiting, Wallet};
use crate::state::AppState;

/// A freshly paired match plus the id assigned to it.
pub struct Paired {
    pub match_id: MatchId,
    pub record: MatchRecord,
}

/// Join the Quick-Match queue for `game`. If a different player is already waiting,
/// pair them (FIFO) and return the new match; otherwise park this player and return None.
/// Seat assignment is deterministic: the earlier waiter is seat A.
pub fn quick_match_join(
    state: &AppState,
    game: &GameId,
    wallet: &Wallet,
    conn: ConnId,
) -> Option<Paired> {
    let mut queues = state.queues.write().expect("queues lock");
    let q = queues.entry(game.clone()).or_default();
    // Drop any stale entry for the same wallet so a reconnect re-queues cleanly.
    q.retain(|w| &w.wallet != wallet);
    if let Some(front) = q.pop_front() {
        let record = MatchRecord {
            game: game.clone(),
            seat_a: front.wallet.clone(),
            seat_b: wallet.clone(),
            conn_a: front.conn,
            conn_b: conn,
            tunnel_id: None,
            latest_checkpoint: None,
        };
        let match_id = new_match_id();
        state
            .matches
            .write()
            .expect("matches lock")
            .insert(match_id.clone(), record.clone());
        Some(Paired { match_id, record })
    } else {
        q.push_back(Waiting { wallet: wallet.clone(), conn });
        None
    }
}

/// Remove a wallet from a game's queue (idempotent).
pub fn quick_match_leave(state: &AppState, game: &GameId, wallet: &Wallet) {
    if let Some(q) = state.queues.write().expect("queues lock").get_mut(game) {
        q.retain(|w| &w.wallet != wallet);
    }
}

/// Record a directed invite; returns its match id. The WS layer delivers
/// `challenge.incoming` to the target if it is in `presence`.
pub fn challenge_create(
    state: &AppState,
    from: &Wallet,
    from_conn: ConnId,
    to: &Wallet,
    game: &GameId,
) -> MatchId {
    let match_id = new_match_id();
    state.invites.write().expect("invites lock").insert(
        match_id.clone(),
        DirectedInvite {
            from: from.clone(),
            to: to.clone(),
            game: game.clone(),
            from_conn,
        },
    );
    match_id
}

/// Accept an invite: consume it and create the match (inviter = seat A). Returns the
/// paired record, or None if the invite is unknown/already consumed or `accepter` is
/// not the invited wallet.
pub fn challenge_accept(
    state: &AppState,
    match_id: &MatchId,
    accepter: &Wallet,
    accepter_conn: ConnId,
) -> Option<Paired> {
    let invite = {
        let mut invites = state.invites.write().expect("invites lock");
        match invites.get(match_id) {
            Some(inv) if &inv.to == accepter => invites.remove(match_id).unwrap(),
            _ => return None,
        }
    };
    let record = MatchRecord {
        game: invite.game.clone(),
        seat_a: invite.from.clone(),
        seat_b: accepter.clone(),
        conn_a: invite.from_conn,
        conn_b: accepter_conn,
        tunnel_id: None,
        latest_checkpoint: None,
    };
    state
        .matches
        .write()
        .expect("matches lock")
        .insert(match_id.clone(), record.clone());
    Some(Paired { match_id: match_id.clone(), record })
}

fn new_match_id() -> MatchId {
    format!("match_{}", Uuid::new_v4().simple())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::routes::test_support::test_state;

    fn conn() -> ConnId {
        Uuid::new_v4()
    }

    // First joiner waits; second joiner pairs. The earlier waiter is seat A.
    #[test]
    fn quick_match_pairs_the_second_joiner() {
        let st = test_state();
        let c1 = conn();
        let c2 = conn();
        assert!(quick_match_join(&st, &"ttt".into(), &"0xa".into(), c1).is_none());
        let paired = quick_match_join(&st, &"ttt".into(), &"0xb".into(), c2).expect("pair");
        assert_eq!(paired.record.seat_a, "0xa");
        assert_eq!(paired.record.seat_b, "0xb");
        assert_eq!(paired.record.conn_a, c1);
        assert!(st.matches.read().unwrap().contains_key(&paired.match_id));
        assert!(st.queues.read().unwrap()["ttt"].is_empty(), "queue drained on pair");
    }

    // Players queued for DIFFERENT games never pair with each other.
    #[test]
    fn quick_match_is_per_game() {
        let st = test_state();
        assert!(quick_match_join(&st, &"ttt".into(), &"0xa".into(), conn()).is_none());
        assert!(quick_match_join(&st, &"chess".into(), &"0xb".into(), conn()).is_none());
    }

    // Challenge: create stores an invite; only the invited wallet can accept.
    #[test]
    fn challenge_accept_requires_the_invited_wallet() {
        let st = test_state();
        let mid = challenge_create(&st, &"0xa".into(), conn(), &"0xb".into(), &"ttt".into());
        assert!(challenge_accept(&st, &mid, &"0xWRONG".into(), conn()).is_none());
        let paired = challenge_accept(&st, &mid, &"0xb".into(), conn()).expect("accept");
        assert_eq!(paired.record.seat_a, "0xa");
        assert_eq!(paired.record.seat_b, "0xb");
        assert!(st.invites.read().unwrap().is_empty(), "invite consumed");
    }
}
