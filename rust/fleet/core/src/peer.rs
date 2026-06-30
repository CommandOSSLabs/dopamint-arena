//! The per-match peer protocol multiplexed over the relay's `Relay{match_id, payload}` frames.
//!
//! The TS frontend (`mpClient.ts` / `usePvpBlackjack.ts`) does NOT use the `party.hello`
//! control message (that server path is dark). Instead every per-match message — the ephemeral
//! key exchange, the tunnel-opened announcement, the game move/ack frames, and the settlement
//! halves — rides the relay `payload` as a `t`-tagged JSON object. The bot must speak the same
//! protocol. A `payload` is therefore one of:
//!   * `{"t":"frame", "kind":..., "data":...}` — a game move/ack (handled by the seat runtime
//!     via [`crate::relay_envelope`]); classified here as [`Incoming::Frame`].
//!   * a control [`PeerMsg`]: `hello` / `stake` / `opened` / `settle` / `closed`.
//!
//! The FE also sends `stop` (user abort); the bot has no variant for it, so [`classify`] returns an
//! error and the demux drops it — the match ends on terminal state regardless.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// A control peer message (everything on the relay channel that is NOT a game frame).
/// Field names are camelCase to match the TS `PeerMessage` union.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum PeerMsg {
    /// Ephemeral-key exchange. `ephemeral_pubkey` is the sender's per-match co-signing pubkey
    /// (hex). Each side sends one and learns the opponent's (the runtime's `opponent_pk`).
    Hello { ephemeral_pubkey: String },
    /// Buy-in announcement: the sender's seat stake (initial balance). The FE exchanges these after
    /// `hello` to agree on the (possibly asymmetric) starting balances, and BUFFERS an early one.
    Stake { amount: u64 },
    /// Dealer (role B) announces the on-chain tunnel it opened. The FE does NOT buffer this — it must
    /// arrive after the peer is awaiting it (the dealer's on-chain create normally provides that gap).
    Opened { tunnel_id: String },
    /// A settlement half: the sender's co-signature over the final state + transcript root (hex).
    Settle { sig: String, root: String },
    /// The cooperative-close digest, sent after one side submits the settle on-chain.
    Closed { digest: String },
}

impl PeerMsg {
    pub fn to_payload(&self) -> String {
        serde_json::to_string(self).expect("PeerMsg serializes")
    }
}

/// What an inbound relay `payload` is, after demultiplexing on `t`.
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    /// A game move/ack frame — the original payload bytes go to the seat transport unchanged
    /// (`relay_envelope::unwrap` strips the envelope when the runtime reads them).
    Frame(Vec<u8>),
    /// A control peer message.
    Peer(PeerMsg),
}

/// Classify an inbound relay `payload`: a `t:"frame"` is a game frame, anything else a control
/// message. Errors only on payloads that are neither (malformed / unknown control `t`).
pub fn classify(payload: &[u8]) -> Result<Incoming> {
    let v: serde_json::Value =
        serde_json::from_slice(payload).context("relay payload is not JSON")?;
    match v.get("t").and_then(serde_json::Value::as_str) {
        Some("frame") => Ok(Incoming::Frame(payload.to_vec())),
        Some(_) => {
            let msg: PeerMsg = serde_json::from_slice(payload).context("unknown peer message")?;
            Ok(Incoming::Peer(msg))
        }
        None => anyhow::bail!("relay payload has no `t` tag"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_round_trips_camelcase() {
        let m = PeerMsg::Hello {
            ephemeral_pubkey: "ab12".into(),
        };
        let s = m.to_payload();
        assert!(s.contains(r#""t":"hello""#), "{s}");
        assert!(s.contains(r#""ephemeralPubkey":"ab12""#), "{s}");
        assert_eq!(serde_json::from_str::<PeerMsg>(&s).unwrap(), m);
    }

    #[test]
    fn settle_and_opened_round_trip() {
        for m in [
            PeerMsg::Opened {
                tunnel_id: "0xabc".into(),
            },
            PeerMsg::Settle {
                sig: "cd".into(),
                root: "ef".into(),
            },
        ] {
            assert_eq!(serde_json::from_str::<PeerMsg>(&m.to_payload()).unwrap(), m);
        }
    }

    // The `stake` wire shape must match the FE (`{t:"stake", amount:<number>}`) byte-for-byte: the
    // bot announces its buy-in here and the FE blocks awaiting it, so a tag/field drift hangs the
    // handshake before any move.
    #[test]
    fn stake_matches_the_fe_wire_shape() {
        let m = PeerMsg::Stake { amount: 100 };
        let s = m.to_payload();
        assert!(s.contains(r#""t":"stake""#), "{s}");
        assert!(s.contains(r#""amount":100"#), "{s}");
        assert_eq!(serde_json::from_str::<PeerMsg>(&s).unwrap(), m);
    }

    #[test]
    fn classify_routes_frames_vs_control() {
        let frame = br#"{"t":"frame","kind":"move","data":"{}"}"#;
        assert_eq!(classify(frame).unwrap(), Incoming::Frame(frame.to_vec()));

        let hello = br#"{"t":"hello","ephemeralPubkey":"ab"}"#;
        assert_eq!(
            classify(hello).unwrap(),
            Incoming::Peer(PeerMsg::Hello {
                ephemeral_pubkey: "ab".into()
            })
        );
    }

    #[test]
    fn classify_rejects_untagged_or_unknown() {
        assert!(classify(br#"{"no":"tag"}"#).is_err());
        assert!(classify(br#"{"t":"bogus"}"#).is_err());
    }
}
