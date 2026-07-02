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
//! recorder (e.g. `InMemoryTranscriptRecorder`), not `NullTranscriptRecorder`.

use std::sync::{Arc, Mutex};

use tokio::sync::mpsc;
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
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FeSettleHalf {
    t: &'static str,
    party_a_balance: String,
    party_b_balance: String,
    final_nonce: String,
    timestamp: String,
    transcript_root: String,
    sig: String,
}

impl FeSettleHalf {
    /// The FE-facing JSON the browser's `waitPeer("settleHalf")` + `combineSettlementWithRoot` read.
    /// Infallible: every field is already a `String`/`&'static str`.
    pub(crate) fn to_wire(&self) -> String {
        serde_json::to_string(self).expect("FeSettleHalf serializes")
    }
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
        self.conn.send_to_peer(&self.match_id, half.to_wire()).await;
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

/// The inbound `forfeit` frame from the human FE (Task 4): the human concedes the whole pot
/// (`partyABalance:"0"`, `partyBBalance:"<total>"`), co-signing the half with party A's per-match
/// ephemeral key. Field casing + encoding mirror [`FeSettleHalf`]: camelCase keys, decimal-string
/// numerics (TS `.toString()`), lowercase no-`0x` hex `sig`/`transcriptRoot` (TS `bytesToHex`).
/// Deserialize-only — the bot never emits this shape. The `t` tag is matched during routing
/// ([`ForfeitWatch::observe`]), so it is not modeled here (serde ignores it).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ForfeitFrame {
    party_a_balance: String,
    party_b_balance: String,
    final_nonce: String,
    timestamp: String,
    transcript_root: String,
    sig: String,
}

/// Why the bot refused to co-sign a proposed forfeit half. Every variant is a hard REJECT: the bot
/// leaves the match unsettled rather than sign an unsafe or unauthorized close (fail-closed). This
/// is money-handling — a wrong co-sign hands funds away, so each guard is explicit.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ForfeitCosignError {
    /// A wire field couldn't be parsed (bad decimal, bad hex, or wrong byte length).
    Malformed(String),
    /// `party_a_balance + party_b_balance != total`: the split doesn't conserve the funded pot.
    ConservationViolated { sum: u64, total: u64 },
    /// `party_b_balance < bot_entitled`: the split leaves the bot below its entitled share.
    BotUnderpaid {
        party_b_balance: u64,
        bot_entitled: u64,
    },
    /// The half's signature doesn't verify against party A's key — not an authorized forfeit.
    HumanSignatureInvalid,
}

fn parse_u64(s: &str, field: &str) -> Result<u64, ForfeitCosignError> {
    s.parse::<u64>()
        .map_err(|_| ForfeitCosignError::Malformed(format!("{field} is not a u64: {s:?}")))
}

fn parse_hex_array<const N: usize>(s: &str, field: &str) -> Result<[u8; N], ForfeitCosignError> {
    let bytes = hex::decode(s)
        .map_err(|_| ForfeitCosignError::Malformed(format!("{field} is not lowercase hex")))?;
    <[u8; N]>::try_from(bytes)
        .map_err(|_| ForfeitCosignError::Malformed(format!("{field} must be {N} bytes")))
}

/// Co-sign a human `forfeit` half. On success returns the bot's half in the FE `settleHalf` wire
/// (the SAME balances/nonce/timestamp/root, re-signed with the bot key) for the FE to combine
/// (`combineSettlementWithRoot`) and submit via `POST /settle`. The bot signs ONLY a safe,
/// authorized split, in order:
///   1. balances conserve the pot (`a + b == total`);
///   2. the bot is no worse off (`b >= bot_entitled`; a forfeit passes `bot_entitled == total`, so
///      combined with (1) this forces `a == 0, b == total` — the whole pot to the bot);
///   3. the human's half verifies against party A's key over the rebuilt canonical bytes.
///
/// The canonical bytes are `serialize_settlement_with_root` — byte-identical to the TS/Move v2
/// settlement (shared golden), so both halves combine into `close_cooperative_with_root`.
pub(crate) fn cosign_forfeit(
    frame: &ForfeitFrame,
    tunnel_id: &str,
    total: u64,
    bot_entitled: u64,
    party_a_pk: &[u8; 32],
    bot_signer: &impl tunnel_harness::Signer,
) -> Result<FeSettleHalf, ForfeitCosignError> {
    let party_a_balance = parse_u64(&frame.party_a_balance, "partyABalance")?;
    let party_b_balance = parse_u64(&frame.party_b_balance, "partyBBalance")?;
    let final_nonce = parse_u64(&frame.final_nonce, "finalNonce")?;
    let timestamp = parse_u64(&frame.timestamp, "timestamp")?;
    let root = parse_hex_array::<32>(&frame.transcript_root, "transcriptRoot")?;
    let human_sig = parse_hex_array::<64>(&frame.sig, "sig")?;

    // (1) Conserve the pot. `checked_add` so a crafted overflow can't wrap around to `total`.
    let sum = party_a_balance.checked_add(party_b_balance).ok_or(
        ForfeitCosignError::ConservationViolated {
            sum: u64::MAX,
            total,
        },
    )?;
    if sum != total {
        return Err(ForfeitCosignError::ConservationViolated { sum, total });
    }
    // (2) Never accept a split leaving the bot below its entitled share (forfeit ⇒ the whole pot).
    if party_b_balance < bot_entitled {
        return Err(ForfeitCosignError::BotUnderpaid {
            party_b_balance,
            bot_entitled,
        });
    }

    // Rebuild the canonical v2 bytes the human signed; verify their half before co-signing. The
    // tunnel id comes from our own reservation (a valid Sui object id), so serialization won't panic.
    let settlement = tunnel_core::wire::Settlement {
        tunnel_id: tunnel_id.to_owned(),
        party_a_balance,
        party_b_balance,
        final_nonce,
        timestamp,
    };
    let canonical = tunnel_core::wire::serialize_settlement_with_root(&settlement, &root);
    if !tunnel_core::crypto::verify(party_a_pk, &canonical, &human_sig) {
        return Err(ForfeitCosignError::HumanSignatureInvalid);
    }

    // (3) Co-sign the identical bytes with the bot's per-match key.
    let bot_sig = bot_signer.sign(&canonical);
    Ok(FeSettleHalf {
        t: "settleHalf",
        party_a_balance: party_a_balance.to_string(),
        party_b_balance: party_b_balance.to_string(),
        final_nonce: final_nonce.to_string(),
        timestamp: timestamp.to_string(),
        transcript_root: hex::encode(root),
        sig: hex::encode(bot_sig),
    })
}

/// Taps a co-located arena match's inbound relay stream to (a) capture party A's ephemeral
/// co-signing pubkey from the `hello` frame and (b) tee off a `forfeit` frame so the bot can react
/// mid-match. Installed on the match's [`crate::fleet::bus_transport::BusRelayTransport`]; the game
/// `MatchChannel` demux — which would DROP the unknown `forfeit` tag — never has to know about it.
///
/// Party A's pubkey is captured from `hello` (not the reservation, which never carries it: the human's
/// ephemeral key is minted client-side at open). Without it the forfeit half can't be verified, so the
/// bot fails closed.
pub(crate) struct ForfeitWatch {
    forfeit_tx: mpsc::UnboundedSender<String>,
    party_a_pk: Arc<Mutex<Option<[u8; 32]>>>,
}

/// The bot driver's end of a [`ForfeitWatch`]: the forfeit-frame receiver to `select!` on against
/// `play_game`, and the shared cell holding party A's captured ephemeral pubkey.
pub(crate) struct ForfeitInbox {
    pub(crate) forfeit_rx: mpsc::UnboundedReceiver<String>,
    pub(crate) party_a_pk: Arc<Mutex<Option<[u8; 32]>>>,
}

impl ForfeitWatch {
    /// Build a watch (installed on the transport) plus the [`ForfeitInbox`] the bot driver holds.
    pub(crate) fn new() -> (ForfeitWatch, ForfeitInbox) {
        let (forfeit_tx, forfeit_rx) = mpsc::unbounded_channel();
        let party_a_pk = Arc::new(Mutex::new(None));
        (
            ForfeitWatch {
                forfeit_tx,
                party_a_pk: party_a_pk.clone(),
            },
            ForfeitInbox {
                forfeit_rx,
                party_a_pk,
            },
        )
    }

    /// Inspect one inbound relay payload. Returns `true` iff it was a `forfeit` frame (teed to the
    /// bot driver and MUST NOT be forwarded to the game demux). A `hello` frame's ephemeral pubkey is
    /// captured as a side effect and passed through (`false`) — the demux still needs it for the key
    /// exchange. Everything else passes through untouched.
    pub(crate) fn observe(&self, payload: &str) -> bool {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) else {
            return false;
        };
        match v.get("t").and_then(serde_json::Value::as_str) {
            Some("hello") => {
                if let Some(pk) = v
                    .get("ephemeralPubkey")
                    .and_then(serde_json::Value::as_str)
                    .and_then(|h| hex::decode(h).ok())
                    .and_then(|b| <[u8; 32]>::try_from(b).ok())
                {
                    *self.party_a_pk.lock().expect("forfeit watch pk mutex") = Some(pk);
                }
                false
            }
            // Unbounded send never blocks; a closed rx (driver gone) just means the match ended.
            Some("forfeit") => {
                let _ = self.forfeit_tx.send(payload.to_owned());
                true
            }
            _ => false,
        }
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

    // ---- forfeit co-sign (Task 2) ----------------------------------------------------------------
    //
    // The bot co-signs the SAME canonical `settlement_v2` bytes the human signed, so both halves
    // combine into `close_cooperative_with_root`. These are pure-logic tests over `cosign_forfeit`
    // (no relay/bus), asserting the money-safety gate and byte-for-byte parity of the emitted half.

    use tunnel_core::crypto::verify;
    use tunnel_core::wire::{serialize_settlement_with_root, Settlement};
    use tunnel_harness::{LocalSigner, Signer};

    // Party A's ephemeral key (the one that would be exchanged via `hello` and baked into the tunnel).
    fn party_a_key() -> LocalSigner {
        LocalSigner::from_secret(&std::array::from_fn(|i| (i as u8) + 1))
    }

    // Canonical v2 bytes for a settlement — the shared message both halves sign.
    fn canonical_bytes(
        tunnel: &str,
        a: u64,
        b: u64,
        nonce: u64,
        ts: u64,
        root: &[u8; 32],
    ) -> Vec<u8> {
        serialize_settlement_with_root(
            &Settlement {
                tunnel_id: tunnel.into(),
                party_a_balance: a,
                party_b_balance: b,
                final_nonce: nonce,
                timestamp: ts,
            },
            root,
        )
    }

    // The watcher's demux contract: a game frame flows through untouched, a `hello` flows through but
    // its ephemeral pubkey is captured (the bot has no other on-file source for party A's key), and a
    // `forfeit` is swallowed (kept from the game demux, which would drop it) and teed to the driver.
    #[test]
    fn forfeit_watch_captures_hello_pubkey_and_tees_forfeit() {
        let (watch, mut inbox) = ForfeitWatch::new();

        // A game frame passes straight through and never touches the pubkey cell.
        assert!(!watch.observe(r#"{"t":"frame","kind":"move","data":"{}"}"#));
        assert!(inbox.party_a_pk.lock().unwrap().is_none());

        // A hello passes through (the demux still needs it) but its pubkey is captured for verifying.
        let pk = [3u8; 32];
        let hello = format!(r#"{{"t":"hello","ephemeralPubkey":"{}"}}"#, hex::encode(pk));
        assert!(
            !watch.observe(&hello),
            "hello must still reach the game demux"
        );
        assert_eq!(*inbox.party_a_pk.lock().unwrap(), Some(pk));

        // A forfeit is swallowed (true) and teed to the driver verbatim.
        let forfeit = r#"{"t":"forfeit","partyABalance":"0","partyBBalance":"2000","finalNonce":"1","timestamp":"42","transcriptRoot":"00","sig":"00"}"#;
        assert!(
            watch.observe(forfeit),
            "forfeit must be swallowed, not forwarded to the demux"
        );
        assert_eq!(inbox.forfeit_rx.try_recv().unwrap(), forfeit);
    }

    // A genuine forfeit `(0, total)` with a valid human signature co-signs cleanly, and the bot's
    // half is byte-identical (same balances/nonce/timestamp/root) and verifies over the SAME bytes —
    // so `combineSettlementWithRoot` + the on-chain close accept both halves. This is the golden path.
    #[test]
    fn cosign_forfeit_produces_a_combinable_bot_half() {
        let tunnel = "0xab";
        let total: u64 = 2000;
        let root = [9u8; 32];
        let party_a = party_a_key();
        let a_pk = party_a.public_key();

        let canonical = canonical_bytes(tunnel, 0, total, 1, 42, &root);
        let human_sig = party_a.sign(&canonical);

        let frame = ForfeitFrame {
            party_a_balance: "0".into(),
            party_b_balance: total.to_string(),
            final_nonce: "1".into(),
            timestamp: "42".into(),
            transcript_root: hex::encode(root),
            sig: hex::encode(human_sig),
        };

        let bot = LocalSigner::from_secret(&[7u8; 32]);
        // Forfeit → the bot is entitled to the whole pot (`bot_entitled == total`).
        let half = cosign_forfeit(&frame, tunnel, total, total, &a_pk, &bot)
            .expect("a genuine (0,total) forfeit with a valid human sig is safe to co-sign");

        assert_eq!(half.t, "settleHalf", "FE waits on tag `settleHalf`");
        assert_eq!(half.party_a_balance, "0");
        assert_eq!(half.party_b_balance, total.to_string());
        assert_eq!(half.final_nonce, "1");
        assert_eq!(half.timestamp, "42");
        assert_eq!(half.transcript_root, hex::encode(root));

        let bot_sig: [u8; 64] = hex::decode(&half.sig).unwrap().try_into().unwrap();
        assert!(
            verify(&bot.public_key(), &canonical, &bot_sig),
            "the bot half must sign the identical canonical bytes",
        );
        assert!(
            verify(&a_pk, &canonical, &human_sig),
            "the human half verifies over the same bytes ⇒ combine/close succeeds",
        );
    }

    // A split that CONSERVES the pot (500 + 1500 == 2000) but hands the human 500 back leaves the bot
    // worse off than a true forfeit (which entitles it to the whole pot). Even with a valid human
    // signature it must be rejected — the money-safety floor, not just conservation.
    #[test]
    fn cosign_forfeit_rejects_a_split_that_underpays_the_bot() {
        let tunnel = "0xab";
        let total: u64 = 2000;
        let root = [9u8; 32];
        let party_a = party_a_key();
        let a_pk = party_a.public_key();

        let canonical = canonical_bytes(tunnel, 500, 1500, 1, 42, &root);
        let human_sig = party_a.sign(&canonical);
        let frame = ForfeitFrame {
            party_a_balance: "500".into(),
            party_b_balance: "1500".into(),
            final_nonce: "1".into(),
            timestamp: "42".into(),
            transcript_root: hex::encode(root),
            sig: hex::encode(human_sig),
        };

        let bot = LocalSigner::from_secret(&[7u8; 32]);
        let err = cosign_forfeit(&frame, tunnel, total, total, &a_pk, &bot)
            .expect_err("a split underpaying the bot must never be co-signed");
        assert!(
            matches!(err, ForfeitCosignError::BotUnderpaid { .. }),
            "got {err:?}"
        );
    }

    // Balances that don't sum to the funded total (inflated pot) are refused before any signing — the
    // bot never signs non-conserving state (the chain would reject it, and it must not be trusted).
    #[test]
    fn cosign_forfeit_rejects_a_non_conserving_split() {
        let tunnel = "0xab";
        let total: u64 = 2000;
        let root = [9u8; 32];
        let party_a = party_a_key();
        let a_pk = party_a.public_key();

        let canonical = canonical_bytes(tunnel, 0, 3000, 1, 42, &root);
        let human_sig = party_a.sign(&canonical);
        let frame = ForfeitFrame {
            party_a_balance: "0".into(),
            party_b_balance: "3000".into(),
            final_nonce: "1".into(),
            timestamp: "42".into(),
            transcript_root: hex::encode(root),
            sig: hex::encode(human_sig),
        };

        let bot = LocalSigner::from_secret(&[7u8; 32]);
        let err = cosign_forfeit(&frame, tunnel, total, total, &a_pk, &bot)
            .expect_err("a non-conserving split must be rejected");
        assert!(
            matches!(err, ForfeitCosignError::ConservationViolated { .. }),
            "got {err:?}"
        );
    }

    // A correct `(0, total)` split but signed by a key OTHER than party A's is not an authorized
    // forfeit — the bot must not co-sign an unverifiable half.
    #[test]
    fn cosign_forfeit_rejects_a_forged_human_half() {
        let tunnel = "0xab";
        let total: u64 = 2000;
        let root = [9u8; 32];
        let a_pk = party_a_key().public_key();
        let impostor = LocalSigner::from_secret(&[200u8; 32]);

        let canonical = canonical_bytes(tunnel, 0, total, 1, 42, &root);
        let forged = impostor.sign(&canonical);
        let frame = ForfeitFrame {
            party_a_balance: "0".into(),
            party_b_balance: total.to_string(),
            final_nonce: "1".into(),
            timestamp: "42".into(),
            transcript_root: hex::encode(root),
            sig: hex::encode(forged),
        };

        let bot = LocalSigner::from_secret(&[7u8; 32]);
        let err = cosign_forfeit(&frame, tunnel, total, total, &a_pk, &bot)
            .expect_err("a half not signed by party A must be rejected");
        assert!(
            matches!(err, ForfeitCosignError::HumanSignatureInvalid),
            "got {err:?}"
        );
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
