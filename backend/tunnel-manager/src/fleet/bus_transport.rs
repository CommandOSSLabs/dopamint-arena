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
//! The co-located [`crate::fleet::colocated`] supervisor constructs these to play arena matches:
//! `conn_ref` is bound into the match by the [`crate::fleet::arena_rendezvous`], and `send_to_peer`
//! carries the bot's settle half for [`crate::fleet::arena_anchor`]. `await_match` mirrors the WS
//! `RelayConnection`'s queue entry for the matchmaking path (the arena flow gets its match via the
//! `BotPool` `Opened` push instead), so it stays test-exercised behind an item-level dead-code allow.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Result};
use tokio::sync::{mpsc, Mutex};
use tunnel_harness::FrameTransportError;
use uuid::Uuid;

use fleet_core::relay_ws::RelayTransport;
use fleet_core::{MatchInfo, Role};

use crate::fleet::arena_anchor::ForfeitWatch;
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

    /// This connection's `ConnRef` — the seat identity the arena rendezvous binds into the match's
    /// `MatchRecord` (party B) so `relay_to_other` can route the human seat's frames here.
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

    /// Route a control payload to this match's peer over the SAME [`crate::mp::ws::relay_to_other`]
    /// path game frames take. Used by [`crate::fleet::arena_anchor::RelayBridgedAnchor`] to emit the
    /// bot's settle half — the bot is not the frame transport but must still speak the peer protocol
    /// to the human seat. A fresh routing cache is fine: the anchor emits once per match, and a
    /// control payload (`t != "frame"`) is never counted as a move, exactly like a human peer's.
    pub async fn send_to_peer(&self, match_id: &str, payload: String) {
        let mut cache = HashMap::new();
        crate::mp::ws::relay_to_other(
            &self.state,
            &mut cache,
            self.conn_id,
            match_id.to_owned(),
            payload,
        )
        .await;
    }

    /// Next raw inbound frame text, for tests that assert what the relay routed to this conn.
    #[cfg(test)]
    pub async fn recv_for_test(&self) -> Option<String> {
        self.inbound.lock().await.recv().await
    }
}

impl Drop for BusRelayConnection {
    fn drop(&mut self) {
        self.state.bus.unregister(self.conn_id);
    }
}

/// How long a parked bot waits for a dropped human to resume before ending the match. Bounded
/// (unlike the FE's 1h settlement grace) because a parked bot still holds an in-flight fleet slot
/// against the per-game cap — a human who never returns must free it. A browser reload reconnects in
/// seconds, so this is generous headroom, not the expected wait.
const PEER_RESUME_GRACE: Duration = Duration::from_secs(60);

/// Whether a relay payload is a game frame (`{"t":"frame",…}`) rather than a peer control message
/// (settle half, hello, …). Only frames are safe to re-emit on resume: a MOVE/ACK is idempotent (the
/// FE dedupes by nonce), whereas replaying a settle half could disturb the settlement handshake.
fn is_frame_payload(payload: &str) -> bool {
    serde_json::from_str::<serde_json::Value>(payload)
        .ok()
        .and_then(|v| v.get("t").and_then(|t| t.as_str()).map(|t| t == "frame"))
        .unwrap_or(false)
}

/// A [`RelayTransport`] over the in-process bus, scoped to one match. `send_payload` routes through
/// the SAME [`crate::mp::ws::relay_to_other`] the human WS path uses (so move-counting + seat
/// routing are identical); `recv_payload` yields the next inbound `Relay` payload for this match.
///
/// Resume-aware (ADR-0028 lifecycle): a human's `peer.dropped` does NOT collapse the match — the bot
/// parks (keeping itself and its per-match co-signing key alive) until they `peer.resumed` or the
/// [`PEER_RESUME_GRACE`] elapses. On resume it re-emits its last frame so the reconnected human
/// re-ACKs, so a reload mid-match continues instead of killing the game.
pub struct BusRelayTransport {
    conn: Arc<BusRelayConnection>,
    match_id: String,
    /// Per-match record cache for routing, exactly as the WS connection task holds — the store is
    /// hit at most once per match for `relay_to_other`.
    cache: Mutex<HashMap<String, MatchRecord>>,
    /// False while the human seat is dropped (parked, awaiting resume); gates the grace timeout.
    peer_online: AtomicBool,
    /// The last game frame we sent, re-emitted on resume so the reconnected human re-ACKs it.
    last_frame: Mutex<Option<Vec<u8>>>,
    /// Grace to wait for a dropped human before ending the match; injectable so tests run fast.
    resume_grace: Duration,
    /// Co-located arena only: tees a mid-match `forfeit` frame to the bot driver (and captures party
    /// A's `hello` pubkey). `None` for plain bot-vs-bot bus play, which never forfeits.
    forfeit_watch: Option<ForfeitWatch>,
}

impl BusRelayTransport {
    /// A co-located arena bot always installs a [`ForfeitWatch`]: it intercepts the human's mid-match
    /// `forfeit` frame so the bot can co-sign the cooperative close (ADR-0024 / Task 2), and captures
    /// party A's `hello` pubkey for verifying that half.
    pub fn with_forfeit_watch(
        conn: Arc<BusRelayConnection>,
        match_id: String,
        watch: ForfeitWatch,
    ) -> BusRelayTransport {
        Self::build(conn, match_id, PEER_RESUME_GRACE, Some(watch))
    }

    /// A watchless transport, for the bot-vs-bot bus tests (which never forfeit). Production goes
    /// through [`BusRelayTransport::with_forfeit_watch`].
    #[cfg(test)]
    pub fn new(conn: Arc<BusRelayConnection>, match_id: String) -> BusRelayTransport {
        Self::build(conn, match_id, PEER_RESUME_GRACE, None)
    }

    #[cfg(test)]
    fn with_resume_grace(
        conn: Arc<BusRelayConnection>,
        match_id: String,
        resume_grace: Duration,
    ) -> BusRelayTransport {
        Self::build(conn, match_id, resume_grace, None)
    }

    fn build(
        conn: Arc<BusRelayConnection>,
        match_id: String,
        resume_grace: Duration,
        forfeit_watch: Option<ForfeitWatch>,
    ) -> BusRelayTransport {
        BusRelayTransport {
            conn,
            match_id,
            cache: Mutex::new(HashMap::new()),
            peer_online: AtomicBool::new(true),
            last_frame: Mutex::new(None),
            resume_grace,
            forfeit_watch,
        }
    }

    /// The human resumed on a (possibly new) connection. The relay rebinds their seat and evicts our
    /// stale relay cache as SEPARATE ops, so don't depend on that ordering — drop our own routing
    /// cache here so the resend (and every later send) re-reads the record's new `conn_a`, then
    /// re-emit our last frame to that reconnected seat.
    async fn on_peer_resumed(&self) {
        let mut cache = self.cache.lock().await;
        cache.remove(&self.match_id);
        let last = self.last_frame.lock().await.clone();
        if let Some(frame) = last {
            if let Ok(payload) = String::from_utf8(frame) {
                crate::mp::ws::relay_to_other(
                    &self.conn.state,
                    &mut cache,
                    self.conn.conn_id,
                    self.match_id.clone(),
                    payload,
                )
                .await;
            }
        }
    }
}

impl RelayTransport for BusRelayTransport {
    async fn send_payload(&self, payload: Vec<u8>) -> Result<(), FrameTransportError> {
        let payload = String::from_utf8(payload)
            .map_err(|e| FrameTransportError::Transport(format!("payload not UTF-8: {e}")))?;
        tracing::debug!(match_id = %self.match_id, head = %&payload[..payload.len().min(120)], "bus tx (bot→peer)");
        {
            let mut cache = self.cache.lock().await;
            crate::mp::ws::relay_to_other(
                &self.conn.state,
                &mut cache,
                self.conn.conn_id,
                self.match_id.clone(),
                payload.clone(),
            )
            .await;
        }
        // Remember the last game frame so a resume can re-emit it to the reconnected human.
        if is_frame_payload(&payload) {
            *self.last_frame.lock().await = Some(payload.into_bytes());
        }
        Ok(())
    }

    async fn recv_payload(&self) -> Result<Option<Vec<u8>>, FrameTransportError> {
        loop {
            // While the human is parked (dropped, awaiting resume) bound the wait so a human who
            // never returns can't pin this bot's in-flight fleet slot forever; online → wait freely.
            let msg = if self.peer_online.load(Ordering::Relaxed) {
                self.conn.recv_server_msg().await
            } else {
                match tokio::time::timeout(self.resume_grace, self.conn.recv_server_msg()).await {
                    Ok(m) => m,
                    Err(_) => return Ok(None), // grace expired while parked → end the match
                }
            };
            match msg {
                Some(ServerMsg::Relay { match_id, payload }) if match_id == self.match_id => {
                    // A `forfeit` frame is teed to the bot's co-sign watcher and swallowed here — the
                    // game demux would drop the unknown tag anyway; a `hello` is sniffed for party A's
                    // pubkey and passed through. Everything else flows to the demux unchanged.
                    if let Some(watch) = &self.forfeit_watch {
                        if watch.observe(&payload) {
                            continue;
                        }
                    }
                    tracing::debug!(match_id = %self.match_id, head = %&payload[..payload.len().min(120)], "bus rx (peer→bot)");
                    return Ok(Some(payload.into_bytes()));
                }
                // Other-match frames shouldn't arrive (one match per virtual conn); ignore.
                Some(ServerMsg::Relay { .. }) => continue,
                // The human reloaded/disconnected. DON'T collapse the match — park and keep the bot
                // (and its co-signing key) alive so the game resumes when they reconnect.
                Some(ServerMsg::PeerDropped { .. }) => {
                    self.peer_online.store(false, Ordering::Relaxed);
                    continue;
                }
                // The human is back: re-route to their new conn and re-emit our last frame.
                Some(ServerMsg::PeerResumed { .. }) => {
                    self.peer_online.store(true, Ordering::Relaxed);
                    self.on_peer_resumed().await;
                    continue;
                }
                // The bus connection itself closed → end the match channel.
                None => return Ok(None),
                Some(_) => continue,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::AppState;
    use fleet_core::match_channel::MatchChannel;
    use fleet_core::play_match::{play_blackjack, BLACKJACK};
    use fleet_core::signer_durable::DurableSigner;
    use tunnel_harness::{InMemoryAnchor, NullTranscriptRecorder};

    // Two virtual bus connections complete a full co-signed blackjack match over the REAL relay bus
    // (LocalBus + the shared `relay_to_other` routing) — the co-located analog of the WS
    // `BOT_COUNT=2` test. Proves the `BusRelayTransport` seam carries the whole orchestration on the
    // merged `PartyDriver` (hello exchange → anchor open → co-signed play → settle PAIRING) without
    // a WebSocket. Both seats share one `InMemoryAnchor`, so both returning Ok means the cooperative
    // close verified. A regression in bus routing or the payload round-trip fails here.
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
        // One shared anchor so the two seats' settle halves pair (open idempotent, settle paired).
        let anchor = InMemoryAnchor::new();

        let sa: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let sb: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);

        let (ra, rb) = tokio::join!(
            play_blackjack(
                cha,
                anchor.clone(),
                DurableSigner::from_secret(&sa),
                Role::A,
                "0xbotB",
                NullTranscriptRecorder,
            ),
            play_blackjack(
                chb,
                anchor.clone(),
                DurableSigner::from_secret(&sb),
                Role::B,
                "0xhumanA",
                NullTranscriptRecorder,
            ),
        );

        let a = ra.expect("seat A completes open → play → settle over the bus");
        let b = rb.expect("seat B completes open → play → settle over the bus");
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
        // Both Ok ⇒ the shared anchor PAIRED the two settle halves over the bus: cooperative close
        // verified, not just the move loop.
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

    // A human `peer.dropped` must NOT collapse the bot's match (the old `Ok(None)` bug that killed the
    // bot on reload). The transport parks: a frame arriving after the drop is still delivered, so the
    // game continues when the human reconnects. The regression this whole change fixes.
    #[tokio::test]
    async fn peer_dropped_parks_instead_of_ending_the_match() {
        let state = AppState::in_memory_for_test();
        let conn = BusRelayConnection::register(state.clone());
        let match_id = "m-park";
        let transport = BusRelayTransport::new(conn.clone(), match_id.into());

        // Human drops, then (after reconnecting) sends a frame. A collapsing transport would have
        // returned None on the drop; the parking one skips it and delivers the frame.
        let frame_env = r#"{"t":"frame","kind":"move","data":"{}"}"#;
        state
            .bus
            .deliver(
                &conn.conn_ref(),
                ServerMsg::PeerDropped {
                    match_id: match_id.into(),
                }
                .to_text(),
            )
            .await;
        state
            .bus
            .deliver(
                &conn.conn_ref(),
                ServerMsg::Relay {
                    match_id: match_id.into(),
                    payload: frame_env.into(),
                }
                .to_text(),
            )
            .await;

        let got = transport.recv_payload().await.expect("recv ok");
        assert_eq!(
            got.as_deref(),
            Some(frame_env.as_bytes()),
            "parked past the drop and delivered the next frame instead of ending the match",
        );
    }

    // On `peer.resumed` the bot re-emits its last frame to the reconnected human so they re-ACK it —
    // the piece that makes a mid-move reload continue instead of stalling on a lost ACK.
    #[tokio::test]
    async fn peer_resumed_resends_last_frame_to_the_reconnected_human() {
        let state = AppState::in_memory_for_test();
        let bot = BusRelayConnection::register(state.clone());
        let human = BusRelayConnection::register(state.clone());
        let match_id = "m-resume";
        state
            .mp
            .put_match(
                match_id,
                MatchRecord {
                    game: "blackjack".into(),
                    seat_a: "0xhuman".into(),
                    seat_b: "0xbot".into(),
                    conn_a: human.conn_ref(),
                    conn_b: bot.conn_ref(),
                    tunnel_id: None,
                    latest_checkpoint: None,
                },
            )
            .await;
        let transport = BusRelayTransport::new(bot.clone(), match_id.into());

        // Bot proposes a MOVE (captured as last_frame + routed to the human).
        let move_env = r#"{"t":"frame","kind":"move","data":"{}"}"#;
        transport
            .send_payload(move_env.as_bytes().to_vec())
            .await
            .expect("send ok");
        let first = human.recv_for_test().await.expect("human gets the move");
        assert!(first.contains("move"), "original move routed to the human");

        // Human reloaded and resumed. Processing PeerResumed re-emits the MOVE, then recv_payload
        // parks awaiting the human's re-ACK — so bound it with a timeout and assert the resend landed.
        state
            .bus
            .deliver(
                &bot.conn_ref(),
                ServerMsg::PeerResumed {
                    match_id: match_id.into(),
                    seat: "A".into(),
                    conn_ref: human.conn_ref(),
                }
                .to_text(),
            )
            .await;
        let _ = tokio::time::timeout(Duration::from_millis(100), transport.recv_payload()).await;

        let resent = tokio::time::timeout(Duration::from_millis(200), human.recv_for_test())
            .await
            .expect("resend delivered, no hang")
            .expect("human gets the resent move");
        assert!(
            resent.contains("relay") && resent.contains("move"),
            "resume re-emitted the bot's last frame to the reconnected human: {resent}",
        );
    }

    // A human who never returns must not pin the bot's in-flight fleet slot forever: after the grace
    // the parked match ends (freeing the slot). Uses a short injected grace so the test runs fast.
    #[tokio::test]
    async fn grace_expiry_ends_a_parked_match_when_the_human_never_returns() {
        let state = AppState::in_memory_for_test();
        let conn = BusRelayConnection::register(state.clone());
        let match_id = "m-grace";
        let transport = BusRelayTransport::with_resume_grace(
            conn.clone(),
            match_id.into(),
            Duration::from_millis(50),
        );

        state
            .bus
            .deliver(
                &conn.conn_ref(),
                ServerMsg::PeerDropped {
                    match_id: match_id.into(),
                }
                .to_text(),
            )
            .await;
        let got = transport.recv_payload().await.expect("recv ok");
        assert_eq!(
            got, None,
            "grace expiry ends the parked match so the fleet slot frees"
        );
    }
}
