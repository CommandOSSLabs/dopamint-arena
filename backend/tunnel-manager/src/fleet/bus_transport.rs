//! In-process relay transport for co-located fleet bots (ADR-0024).
//!
//! The co-located game-server runs bots as virtual bus connections instead of WebSocket clients:
//! a bot registers a `ConnId` + client channel on the relay [`crate::store::Bus`] (no socket), is
//! assigned a seat, and drives `fleet_core::play_match` over a [`BusRelayTransport`] — the
//! in-process mirror of bot-fleet's `WsRelayTransport`. This removes the bot's WS hop (the capacity
//! win at 5000 CCU: ~40k → ~5k sockets). Correctness is identical because outbound relay routing
//! reuses the SAME [`crate::mp::ws::relay_to_other`] the human WS path uses, so move-counting and
//! seat routing stay in exact parity — the relay still never signs.
//!
//! The co-located [`crate::fleet::colocated`] supervisor constructs these to play arena matches.
//! `conn_ref`/`await_match` round out the connection's mirror of the WS `RelayConnection` for the
//! queue/`MatchRecord` association the boss completes; they're test-exercised but not yet on the
//! arena runtime path, hence their item-level dead-code allows.

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{bail, Result};
use tokio::sync::{mpsc, Mutex};
use tunnel_harness::FrameTransportError;
use uuid::Uuid;

use fleet_core::relay_ws::RelayTransport;
use fleet_core::{MatchInfo, Role};

use crate::mp::protocol::ServerMsg;
use crate::mp::{ConnId, MatchRecord};
use crate::state::SharedState;
use crate::store::{ConnRef, CtrlMsg};

/// A fleet bot's virtual connection on the relay bus: a registered `ConnId` + client channel, with
/// NO socket. Frames the relay would write to a socket arrive on `inbound`; the bot reads them
/// here. The in-process analog of bot-fleet's `RelayConnection`.
pub struct BusRelayConnection {
    state: SharedState,
    conn_id: ConnId,
    /// Server-bound frames `Bus::deliver` routes to this conn: MatchFound, Relay, PeerDropped.
    inbound: Mutex<mpsc::UnboundedReceiver<String>>,
    /// Held (undrained) so `Bus::populate`'s ctrl sends never fail — a bot keeps no relay cache, so
    /// evict/populate are irrelevant to it, but the bus must find a live sender registered.
    _ctrl_rx: mpsc::UnboundedReceiver<CtrlMsg>,
}

impl BusRelayConnection {
    /// Register a fresh virtual connection on the bus. The returned `Arc` owns the conn; dropping it
    /// unregisters (the analog of the WS task's disconnect cleanup).
    pub fn register(state: SharedState) -> Arc<BusRelayConnection> {
        let conn_id = Uuid::new_v4();
        let (client_tx, inbound) = mpsc::unbounded_channel();
        let (ctrl_tx, _ctrl_rx) = mpsc::unbounded_channel();
        state.bus.register(conn_id, client_tx, ctrl_tx);
        Arc::new(BusRelayConnection {
            state,
            conn_id,
            inbound: Mutex::new(inbound),
            _ctrl_rx,
        })
    }

    /// This connection's `ConnRef` — the seat identity to put in a `MatchRecord`. The arena
    /// scaffold doesn't wire the record yet (no human conn captured); the boss's association uses it.
    #[allow(dead_code)]
    pub fn conn_ref(&self) -> ConnRef {
        ConnRef {
            instance_id: self.state.bus.instance_id().to_owned(),
            conn_id: self.conn_id,
        }
    }

    /// Wait for matchmaking to pair us, returning the seat assignment. Mirrors
    /// `RelayConnection::await_match` over the WS — the queue-flow entry (the arena flow gets its
    /// match via the `BotPool` `Opened` push instead), kept for when that path is wired.
    #[allow(dead_code)]
    pub async fn await_match(&self) -> Result<MatchInfo> {
        loop {
            match self.recv_server_msg().await {
                Some(ServerMsg::MatchFound {
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
                Some(ServerMsg::Error { code, message }) => bail!("relay error: {code} {message}"),
                Some(_) => continue,
                None => bail!("bus closed before match.found"),
            }
        }
    }

    /// Next inbound server frame, decoded. `None` when this connection's channel closes. The bus
    /// carries our own server-serialized frames, so a decode miss is a bug we skip, not peer input.
    async fn recv_server_msg(&self) -> Option<ServerMsg> {
        let text = self.inbound.lock().await.recv().await?;
        serde_json::from_str(&text).ok()
    }
}

impl Drop for BusRelayConnection {
    fn drop(&mut self) {
        self.state.bus.unregister(self.conn_id);
    }
}

/// A [`RelayTransport`] over the in-process bus, scoped to one match. `send_payload` routes through
/// the SAME [`crate::mp::ws::relay_to_other`] the human WS path uses (so move-counting + seat
/// routing are identical); `recv_payload` yields the next inbound `Relay` payload for this match
/// and ends the channel on peer-drop / close.
pub struct BusRelayTransport {
    conn: Arc<BusRelayConnection>,
    match_id: String,
    /// Per-match record cache for routing, exactly as the WS connection task holds — the store is
    /// hit at most once per match for `relay_to_other`.
    cache: Mutex<HashMap<String, MatchRecord>>,
}

impl BusRelayTransport {
    pub fn new(conn: Arc<BusRelayConnection>, match_id: String) -> BusRelayTransport {
        BusRelayTransport {
            conn,
            match_id,
            cache: Mutex::new(HashMap::new()),
        }
    }
}

impl RelayTransport for BusRelayTransport {
    async fn send_payload(&self, payload: Vec<u8>) -> Result<(), FrameTransportError> {
        let payload = String::from_utf8(payload)
            .map_err(|e| FrameTransportError::Transport(format!("payload not UTF-8: {e}")))?;
        let mut cache = self.cache.lock().await;
        crate::mp::ws::relay_to_other(
            &self.conn.state,
            &mut cache,
            self.conn.conn_id,
            self.match_id.clone(),
            payload,
        )
        .await;
        Ok(())
    }

    async fn recv_payload(&self) -> Result<Option<Vec<u8>>, FrameTransportError> {
        loop {
            match self.conn.recv_server_msg().await {
                Some(ServerMsg::Relay { match_id, payload }) if match_id == self.match_id => {
                    return Ok(Some(payload.into_bytes()));
                }
                // Other-match frames shouldn't arrive (one match per virtual conn); ignore.
                Some(ServerMsg::Relay { .. }) => continue,
                // Opponent left or the connection ended → end the match channel.
                Some(ServerMsg::PeerDropped { .. }) | None => return Ok(None),
                Some(_) => continue,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use fleet_core::anchor::NoopAnchor;
    use fleet_core::match_channel::MatchChannel;
    use fleet_core::play_match::{play_blackjack, BLACKJACK};
    use fleet_core::signer_durable::DurableSigner;

    // Two virtual bus connections complete a full co-signed blackjack match over the REAL relay bus
    // (LocalBus + the shared `relay_to_other` routing) — the co-located analog of the WS
    // `BOT_COUNT=2` test. Proves the `BusRelayTransport` seam carries the whole orchestration
    // (hello exchange → NoopAnchor open → co-signed play → settle) without a WebSocket. A
    // regression that breaks bus routing or the payload round-trip fails here, not in production.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn full_match_completes_over_the_bus() {
        let state = AppState::in_memory_for_test();
        let conn_a = BusRelayConnection::register(state.clone());
        let conn_b = BusRelayConnection::register(state.clone());

        // Pre-create the match so `relay_to_other` can route seat A ↔ seat B by their `ConnRef`s
        // (Increment 3 will create this via matchmaking/arena; here we wire it directly).
        let match_id = "m-bus-1";
        state
            .mp
            .put_match(
                match_id,
                MatchRecord {
                    game: "blackjack".into(),
                    seat_a: "0xhumanA".into(),
                    seat_b: "0xbotB".into(),
                    conn_a: conn_a.conn_ref(),
                    conn_b: conn_b.conn_ref(),
                    tunnel_id: None,
                    latest_checkpoint: None,
                },
            )
            .await;

        let cha = MatchChannel::new(BusRelayTransport::new(conn_a.clone(), match_id.into()));
        let chb = MatchChannel::new(BusRelayTransport::new(conn_b.clone(), match_id.into()));
        let anchor = NoopAnchor;

        let sa: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let sb: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);

        let (ra, rb) = tokio::join!(
            play_blackjack(
                cha,
                &anchor,
                DurableSigner::from_secret(&sa),
                Role::A,
                "0xbotB"
            ),
            play_blackjack(
                chb,
                &anchor,
                DurableSigner::from_secret(&sb),
                Role::B,
                "0xhumanA"
            ),
        );

        let a = ra.expect("seat A completes the match over the bus");
        let b = rb.expect("seat B completes the match over the bus");
        let total = 2 * BLACKJACK.stake_each;
        assert_eq!(
            a.final_balances.sum(),
            total,
            "stakes conserved over the bus"
        );
        assert_eq!(
            a.final_balances, b.final_balances,
            "both seats agree on the outcome"
        );
        assert!(a.moves > 0, "match progressed over the bus transport");
        assert!(
            b.settle_digest.is_some(),
            "dealer (role B) submitted settle"
        );
        assert!(a.settle_digest.is_none(), "player (role A) does not settle");
    }

    // `await_match` decodes a delivered `match.found` into the seat assignment — the entry the
    // supervisor (Increment 3) drives before handing the match to `play_match`.
    #[tokio::test]
    async fn await_match_decodes_match_found() {
        let state = AppState::in_memory_for_test();
        let conn = BusRelayConnection::register(state.clone());
        state
            .bus
            .deliver(
                &conn.conn_ref(),
                ServerMsg::MatchFound {
                    match_id: "m1".into(),
                    role: "B".into(),
                    opponent_wallet: "0xhuman".into(),
                    game: "blackjack".into(),
                }
                .to_text(),
            )
            .await;
        let info = conn.await_match().await.expect("await_match resolves");
        assert_eq!(info.match_id, "m1");
        assert_eq!(info.role, Role::B);
        assert_eq!(info.opponent_wallet, "0xhuman");
    }
}
