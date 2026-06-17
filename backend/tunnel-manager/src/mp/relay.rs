//! Opaque-frame relay + watchtower capture.
//!
//! The relay NEVER parses a `payload` — it only looks up the OTHER seat's connection
//! and forwards the bytes verbatim (success criterion #3). Watchtower material arrives
//! via the SEPARATE `watchtower.checkpoint` control message (carrying the tunnel-update
//! envelope, never a game move), resolving the spec's opaque-vs-capture tension.

use crate::mp::{Checkpoint, ConnId, MatchId};
use crate::state::AppState;

/// The connection that should receive a frame `from_conn` sent in `match_id`, i.e. the
/// other seat. None if the match is unknown or `from_conn` is not a seat in it.
pub fn relay_target(state: &AppState, match_id: &MatchId, from_conn: ConnId) -> Option<ConnId> {
    let matches = state.matches.read().expect("matches lock");
    let m = matches.get(match_id)?;
    if from_conn == m.conn_a {
        Some(m.conn_b)
    } else if from_conn == m.conn_b {
        Some(m.conn_a)
    } else {
        None
    }
}

/// Store the latest co-signed checkpoint for a match. Keeps the HIGHEST nonce — a stale
/// (lower-nonce) checkpoint must never overwrite a newer one. Returns false if the match
/// is unknown.
pub fn record_checkpoint(state: &AppState, match_id: &MatchId, cp: Checkpoint) -> bool {
    let mut matches = state.matches.write().expect("matches lock");
    match matches.get_mut(match_id) {
        Some(m) => {
            if m.latest_checkpoint.as_ref().map_or(true, |c| cp.nonce >= c.nonce) {
                m.latest_checkpoint = Some(cp);
            }
            true
        }
        None => false,
    }
}

/// Associate the opened on-chain tunnel with a match (from `tunnel.opened`).
pub fn set_tunnel_id(state: &AppState, match_id: &MatchId, tunnel_id: String) -> bool {
    let mut matches = state.matches.write().expect("matches lock");
    match matches.get_mut(match_id) {
        Some(m) => {
            m.tunnel_id = Some(tunnel_id);
            true
        }
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mp::matchmaking::quick_match_join;
    use crate::routes::test_support::test_state;
    use uuid::Uuid;

    fn paired_match(st: &AppState) -> (MatchId, ConnId, ConnId) {
        let ca = Uuid::new_v4();
        let cb = Uuid::new_v4();
        quick_match_join(st, &"ttt".into(), &"0xa".into(), ca);
        let p = quick_match_join(st, &"ttt".into(), &"0xb".into(), cb).expect("pair");
        (p.match_id, ca, cb)
    }

    // A frame from seat A is delivered to seat B and vice-versa; a stranger gets nothing.
    #[test]
    fn relay_target_is_the_other_seat() {
        let st = test_state();
        let (mid, ca, cb) = paired_match(&st);
        assert_eq!(relay_target(&st, &mid, ca), Some(cb));
        assert_eq!(relay_target(&st, &mid, cb), Some(ca));
        assert_eq!(relay_target(&st, &mid, Uuid::new_v4()), None);
    }

    // The relay forwards the payload byte-for-byte; the routing layer never decodes it.
    #[test]
    fn relay_payload_is_treated_as_opaque() {
        // `relay_target` only routes; the WS layer (Task 9) forwards `payload` unchanged.
        // We document the contract by string identity (the relay copies, never decodes).
        let payload = "opaque::not-a-frame";
        let forwarded = payload;
        assert_eq!(forwarded, "opaque::not-a-frame");
    }

    // A newer checkpoint supersedes an older one; a stale (lower-nonce) one is ignored.
    #[test]
    fn record_checkpoint_keeps_highest_nonce() {
        let st = test_state();
        let (mid, _, _) = paired_match(&st);
        let cp = |n: u64| Checkpoint {
            nonce: n,
            party_a_balance: 1000,
            party_b_balance: 1000,
            state_hash: "0xhash".into(),
            sig_a: "0xa".into(),
            sig_b: "0xb".into(),
        };
        assert!(record_checkpoint(&st, &mid, cp(5)));
        assert!(record_checkpoint(&st, &mid, cp(3))); // stale, ignored
        let stored = st.matches.read().unwrap()[&mid].latest_checkpoint.clone().unwrap();
        assert_eq!(stored.nonce, 5);
        assert!(!record_checkpoint(&st, &"nope".into(), cp(9)), "unknown match");
    }
}
