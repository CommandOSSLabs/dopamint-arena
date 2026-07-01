//! The relay-bridged [`TunnelAnchor`]: a co-located bot's chain-IO bracket for a genuine
//! two-party arena match — "our layer on top of the boss's harness" (ADR-0024/0025).
//!
//! The boss's `PartyDriver` brackets every match `open → move loop → settle`, delegating the chain
//! IO to a [`TunnelAnchor`]. His shipped impls don't fit OUR genuine two-party flow:
//!   * `InMemoryAnchor` pairs both settle halves *in-process* — right for bot-vs-bot self-play, wrong
//!     for a remote (browser) half.
//!   * `SuiSponsoredAnchor` *creates* the tunnel and funds *both* seats from one key — self-play.
//!
//! In the arena flow the tunnel is created out of band at allocate (the fleet creates + funds seat B,
//! ADR-0025) and the user funds seat A with a deposit-only PTB. So this anchor:
//!   * `open()` RESOLVES the already-created tunnel — returns its id, no chain call — and emits the
//!     bot's party-B handshake (`stake` + `opened`) so the human FE, which blocks on them, proceeds.
//!   * `settle()` EMITS the bot's co-signed half as a [`PeerMsg::Settle`] over the relay; the human
//!     FE pairs it with its own half and submits the cooperative close via `POST /settle`. The bot
//!     is a protocol-faithful peer, exactly like the other human in a human-vs-human PvP match — it
//!     never submits the close itself.
//!
//! `settlement_mode()` is [`SettlementMode::TranscriptRoot`] to match the FE and `/settle`, which
//! sign/submit `close_cooperative_with_root` (v2). The driver therefore requires a real transcript
//! recorder (the arena uses `StreamingRootRecorder`, which computes the root incrementally), not
//! `NullTranscriptRecorder`.

use std::sync::Arc;

use tunnel_harness::{
    Balances, OpenedTunnel, SettledTunnel, SettlementMode, TunnelAnchor, TunnelAnchorError,
    TunnelOpenRequest, TunnelSettleRequest,
};

use fleet_core::peer::PeerMsg;

use crate::fleet::bus_transport::BusRelayConnection;

/// Brackets one arena match's chain IO for the bot seat, bridging the boss's `TunnelAnchor` to the
/// relay. Holds the pre-created tunnel id and the bot's relay presence (to route the settle half).
pub struct RelayBridgedAnchor {
    /// The tunnel the fleet pre-created + funded seat B for at allocate (ADR-0025). `open()` returns
    /// this verbatim; the bot never creates a tunnel during play.
    tunnel_id: String,
    /// The bot's virtual relay connection — routes the settle half to the human seat over the same
    /// bus path game frames take. Shared with the match's `BusRelayTransport` (frames) via `Arc`.
    conn: Arc<BusRelayConnection>,
    /// The relay match id this anchor settles, used for `relay_to_other` routing.
    match_id: String,
    /// The tunnel's on-chain `created_at` (ms). The FE signs its settlement half with
    /// `timestamp = created_at` (it reads the same field on-chain), so `open()` surfaces this to the
    /// driver as `OpenedTunnel::created_at_ms` and the bot signs the SAME value — without it the two
    /// halves commit to different `timestamp` bytes and never combine. Read once at allocate by the
    /// [`crate::fleet::arena_opener::ArenaTunnelOpener`].
    created_at_ms: u64,
}

impl RelayBridgedAnchor {
    pub fn new(
        tunnel_id: String,
        conn: Arc<BusRelayConnection>,
        match_id: String,
        created_at_ms: u64,
    ) -> RelayBridgedAnchor {
        RelayBridgedAnchor {
            tunnel_id,
            conn,
            match_id,
            created_at_ms,
        }
    }
}

/// The FE-facing settlement-half wire — the TS `PeerMessage` `settleHalf` variant. Kept distinct from
/// the inbound-routable [`PeerMsg`] enum on purpose: the bot only EMITS this shape (the human's
/// inbound `settleHalf` is never consumed and stays dropped by `classify`), so making it a `PeerMsg`
/// variant would needlessly flip the demux from dropping that frame to routing it. Field casing +
/// encoding mirror exactly what the FE sends: camelCase keys, hex `sig`/`transcriptRoot` (TS
/// `bytesToHex`), decimal-string numerics (TS `.toString()`).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FeSettleHalf {
    t: &'static str,
    party_a_balance: String,
    party_b_balance: String,
    final_nonce: String,
    timestamp: String,
    transcript_root: String,
    sig: String,
}

impl TunnelAnchor for RelayBridgedAnchor {
    fn settlement_mode(&self) -> SettlementMode {
        // The FE signs settlement_v2 (transcript root) and `/settle` submits
        // `close_cooperative_with_root`, so the bot's half must commit to the same root.
        SettlementMode::TranscriptRoot
    }

    async fn open(&self, request: TunnelOpenRequest) -> Result<OpenedTunnel, TunnelAnchorError> {
        // Be a faithful party-B peer to the human FE's handshake (hello → stake → opened): the FE
        // (party A) blocks awaiting our seat stake and tunnel announcement before the move loop. This
        // runs right after `play_match`'s hello exchange. Fire-and-forget: the FE buffers an early
        // `stake`. NOTE: the FE does NOT buffer `opened` today — in human PvP the dealer's on-chain
        // create delays it past the FE's await; the bot has no such gap, so T14 must add `opened`
        // buffering to the arena FE. We send our seat-B stake = the initial balance for party B.
        self.conn
            .send_to_peer(
                &self.match_id,
                PeerMsg::Stake {
                    amount: request.initial.b,
                }
                .to_payload(),
            )
            .await;
        self.conn
            .send_to_peer(
                &self.match_id,
                PeerMsg::Opened {
                    tunnel_id: self.tunnel_id.clone(),
                }
                .to_payload(),
            )
            .await;
        // Resolve the pre-created tunnel; never create on-chain here. `onchain_nonce: 0` assumes a
        // freshly created+funded tunnel with no prior co-signed state (deposits fund seats but do not
        // advance the off-chain state nonce), so the cooperative close signs nonce 1 — matching the
        // FE. RE-VERIFY against the real tunnel when the funded-account opener lands: if the open PTB
        // leaves nonce ≠ 0, this must read the real on-chain nonce or the close is rejected.
        Ok(OpenedTunnel {
            tunnel_id: self.tunnel_id.clone(),
            onchain_nonce: 0,
            // Surface the on-chain createdAt so the driver signs `timestamp = created_at`, matching
            // the FE half (see the `created_at_ms` field doc). `None`/`0` would sign a different ts.
            created_at_ms: Some(self.created_at_ms),
            created: false,
        })
    }

    async fn settle(
        &self,
        request: TunnelSettleRequest,
    ) -> Result<SettledTunnel, TunnelAnchorError> {
        // v2 settlement: the bot's half must carry the transcript root the FE also signs.
        let root = request.transcript_root.ok_or_else(|| {
            TunnelAnchorError::Rejected("arena settle requires a transcript root (v2)".into())
        })?;
        // Emit our co-signing half in the FE's `settleHalf` wire shape (TS `PeerMessage`): the browser
        // pairs it with its own half (`combineSettlementWithRoot`) and submits the cooperative close.
        // The FE reads only `sig`+`transcriptRoot`, but we send the full half the FE itself sends so the
        // wire stays symmetric. `sig`/root are lowercase no-`0x` hex (TS `bytesToHex`); balances/nonce/
        // timestamp are decimal strings (TS `.toString()`). This is NOT `PeerMsg::Settle` (tag
        // `settle`): every FE hook waits on tag `settleHalf`, so the old tag deadlocked the handshake.
        let half = FeSettleHalf {
            t: "settleHalf",
            party_a_balance: request.party_a_balance.to_string(),
            party_b_balance: request.party_b_balance.to_string(),
            final_nonce: request.final_nonce.to_string(),
            timestamp: request.timestamp.to_string(),
            transcript_root: hex::encode(root),
            sig: hex::encode(request.signature),
        };
        self.conn
            .send_to_peer(
                &self.match_id,
                serde_json::to_string(&half).expect("FeSettleHalf serializes"),
            )
            .await;
        // The human FE pairs this half with its own and submits the cooperative close; the bot does
        // not submit. Return the agreed balances; the on-chain digest is unknown on this side.
        Ok(SettledTunnel {
            digest: String::new(),
            final_balances: Balances {
                a: request.party_a_balance,
                b: request.party_b_balance,
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mp::protocol::ServerMsg;
    use crate::mp::MatchRecord;
    // NOTE: the settle golden parses the emitted JSON directly (asserting the FE `settleHalf` wire),
    // so `classify`/`PeerMsg::Settle` are deliberately NOT used here — see the test's comment.
    use crate::state::AppState;
    use tunnel_harness::Seat;

    // The anchor's `open` resolves the pre-created tunnel (no chain call): it returns the id it was
    // built with, reports it did NOT create the tunnel, and leaves nonce 0 so the close signs 1.
    #[tokio::test]
    async fn open_resolves_the_precreated_tunnel() {
        let state = AppState::in_memory_for_test();
        let conn = BusRelayConnection::register(state.clone());
        let anchor =
            RelayBridgedAnchor::new("0xtunnel".into(), conn, "m1".into(), 1_700_000_000_000);

        let opened = anchor
            .open(TunnelOpenRequest {
                protocol: tunnel_core::protocol_id::ProtocolId::parse("blackjack.v1").unwrap(),
                party_a: [1u8; 32],
                party_b: [2u8; 32],
                initial: Balances { a: 100, b: 100 },
            })
            .await
            .expect("open resolves");
        assert_eq!(opened.tunnel_id, "0xtunnel");
        assert!(
            !opened.created,
            "the fleet created the tunnel, not the anchor"
        );
        assert_eq!(opened.onchain_nonce, 0);
        // The driver signs `timestamp = created_at`; surfacing it here is what makes the bot's half
        // combine with the FE's (which signs the same on-chain createdAt).
        assert_eq!(opened.created_at_ms, Some(1_700_000_000_000));
    }

    // `settle` emits the bot's co-signed half to the human peer in the FE `settleHalf` wire — the
    // exact keys/values the browser's `waitPeer("settleHalf")` + `combineSettlementWithRoot` read.
    // This is the cross-language seam the genuine two-party close hinges on, so it asserts against the
    // TS `PeerMessage` shape (tag `settleHalf`, field `transcriptRoot`, decimal-string numerics), NOT
    // a Rust `PeerMsg` round-trip — the latter would pass even if the FE-facing wire drifted (the
    // self-assertion trap that let `settle`/`settleHalf` diverge unnoticed).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn settle_emits_the_co_signed_half_to_the_peer() {
        let state = AppState::in_memory_for_test();
        let bot_conn = BusRelayConnection::register(state.clone());
        let user_conn = BusRelayConnection::register(state.clone());

        // Wire the match so `relay_to_other` routes the bot's half to the user seat.
        let match_id = "m-settle";
        state
            .mp
            .put_match(
                match_id,
                MatchRecord {
                    game: "blackjack".into(),
                    seat_a: "0xuserA".into(),
                    seat_b: "0xbotB".into(),
                    conn_a: user_conn.conn_ref(),
                    conn_b: bot_conn.conn_ref(),
                    tunnel_id: Some("0xtunnel".into()),
                    latest_checkpoint: None,
                },
            )
            .await;

        let anchor = RelayBridgedAnchor::new(
            "0xtunnel".into(),
            bot_conn,
            match_id.into(),
            1_700_000_000_000,
        );
        let sig = [7u8; 64];
        let root = [9u8; 32];
        anchor
            .settle(TunnelSettleRequest {
                by: Seat::B,
                tunnel_id: "0xtunnel".into(),
                party_a_balance: 120,
                party_b_balance: 80,
                final_nonce: 1,
                timestamp: 42,
                signature: sig,
                transcript_root: Some(root),
                transcript_entries: Vec::new(),
            })
            .await
            .expect("settle emits");

        // The user seat receives a relay frame carrying the bot's settle half, byte-for-byte.
        let inbound = user_conn
            .recv_for_test()
            .await
            .expect("user receives the bot's settle");
        let ServerMsg::Relay { payload, .. } =
            serde_json::from_str::<ServerMsg>(&inbound).expect("relay frame")
        else {
            panic!("expected a Relay frame");
        };
        let half: serde_json::Value = serde_json::from_str(&payload).expect("settle half is JSON");
        assert_eq!(
            half["t"], "settleHalf",
            "FE waits on tag `settleHalf`, not `settle`"
        );
        assert_eq!(
            half["sig"],
            hex::encode(sig),
            "sig is the bot's half, lowercase no-0x hex (TS bytesToHex)"
        );
        assert_eq!(
            half["transcriptRoot"],
            hex::encode(root),
            "FE reads `transcriptRoot`, not `root`"
        );
        assert_eq!(
            half["partyABalance"], "120",
            "balances are decimal strings (TS toString)"
        );
        assert_eq!(half["partyBBalance"], "80");
        assert_eq!(half["finalNonce"], "1");
        assert_eq!(half["timestamp"], "42");
    }

    // v1 (rootless) settlement is rejected: the arena close is always v2, so a missing root is a
    // bug to fail loudly on, not silently emit an empty root the FE can't pair.
    #[tokio::test]
    async fn settle_without_root_is_rejected() {
        let state = AppState::in_memory_for_test();
        let conn = BusRelayConnection::register(state.clone());
        let anchor =
            RelayBridgedAnchor::new("0xtunnel".into(), conn, "m1".into(), 1_700_000_000_000);
        let err = anchor
            .settle(TunnelSettleRequest {
                by: Seat::B,
                tunnel_id: "0xtunnel".into(),
                party_a_balance: 100,
                party_b_balance: 100,
                final_nonce: 1,
                timestamp: 1,
                signature: [0u8; 64],
                transcript_root: None,
                transcript_entries: Vec::new(),
            })
            .await
            .expect_err("rootless settle must be rejected");
        assert!(matches!(err, TunnelAnchorError::Rejected(_)));
    }
}
