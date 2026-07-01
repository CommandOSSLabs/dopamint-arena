//! The subset of the `/v1/mp` control wire the bot speaks, mirrored from
//! `backend/tunnel-manager/src/mp/protocol.rs`. We mirror (not depend on tunnel-manager) to
//! avoid pulling its axum/fred/sui dependency tree; the parity test below pins the exact wire
//! shapes the deployed relay sends/accepts, so a drift here is caught, not shipped.

use serde::{Deserialize, Serialize};

/// Messages the bot sends to the relay. Wire: `{ "type": <tag>, ...camelCase fields }`.
#[derive(Debug, Serialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum BotToRelay {
    /// Prove control of `pubkey` (claimed as `wallet`) by signing the server `nonce`.
    Connect {
        wallet: String,
        pubkey: String,
        sig: String,
        nonce: String,
    },
    #[serde(rename = "queue.join")]
    QueueJoin { game: String },
    #[serde(rename = "party.hello")]
    PartyHello {
        match_id: String,
        ephemeral_pubkey: String,
        wallet_sig: String,
    },
    /// Opaque co-signed frame to forward to the human seat. `payload` is the TS relay
    /// envelope produced by [`crate::relay_envelope::wrap`].
    Relay { match_id: String, payload: String },
}

/// Messages the relay sends to the bot.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RelayToBot {
    /// One-time nonce the bot must sign in `connect`.
    Challenge {
        nonce: String,
    },
    #[serde(rename = "match.found")]
    MatchFound {
        match_id: String,
        role: String,
        opponent_wallet: String,
        game: String,
    },
    Relay {
        match_id: String,
        payload: String,
    },
    #[serde(rename = "peer.dropped")]
    PeerDropped {
        match_id: String,
    },
    Error {
        code: String,
        message: String,
    },
    /// Any other server message (resume.ok, peer.resumed, challenge.incoming, …) the bot
    /// does not act on. Capturing it keeps deserialization total instead of erroring.
    #[serde(other)]
    Other,
}

impl BotToRelay {
    pub fn to_text(&self) -> String {
        serde_json::to_string(self).expect("BotToRelay serializes")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Pins the exact wire the deployed relay accepts (see protocol.rs tests).
    #[test]
    fn connect_serializes_with_camelcase_and_type_tag() {
        let s = BotToRelay::Connect {
            wallet: "0xbot".into(),
            pubkey: "ab".into(),
            sig: "cd".into(),
            nonce: "n1".into(),
        }
        .to_text();
        assert!(s.contains(r#""type":"connect""#), "{s}");
        assert!(s.contains(r#""wallet":"0xbot""#), "{s}");
        assert!(s.contains(r#""pubkey":"ab""#), "{s}");
    }

    #[test]
    fn queue_join_uses_the_dotted_name() {
        let s = BotToRelay::QueueJoin {
            game: "blackjack".into(),
        }
        .to_text();
        assert_eq!(s, r#"{"type":"queue.join","game":"blackjack"}"#);
    }

    #[test]
    fn relay_send_uses_camelcase_match_id() {
        let s = BotToRelay::Relay {
            match_id: "m1".into(),
            payload: "p".into(),
        }
        .to_text();
        assert!(s.contains(r#""type":"relay""#), "{s}");
        assert!(s.contains(r#""matchId":"m1""#), "{s}");
    }

    #[test]
    fn party_hello_uses_dotted_name_and_camelcase() {
        let s = BotToRelay::PartyHello {
            match_id: "m1".into(),
            ephemeral_pubkey: "ep".into(),
            wallet_sig: "ws".into(),
        }
        .to_text();
        assert!(s.contains(r#""type":"party.hello""#), "{s}");
        assert!(s.contains(r#""ephemeralPubkey":"ep""#), "{s}");
        assert!(s.contains(r#""walletSig":"ws""#), "{s}");
    }

    #[test]
    fn challenge_deserializes() {
        let m: RelayToBot = serde_json::from_str(r#"{"type":"challenge","nonce":"abc"}"#).unwrap();
        assert_eq!(
            m,
            RelayToBot::Challenge {
                nonce: "abc".into()
            }
        );
    }

    #[test]
    fn match_found_deserializes_camelcase() {
        let raw = r#"{"type":"match.found","matchId":"m1","role":"A","opponentWallet":"0xh","game":"blackjack"}"#;
        let m: RelayToBot = serde_json::from_str(raw).unwrap();
        assert_eq!(
            m,
            RelayToBot::MatchFound {
                match_id: "m1".into(),
                role: "A".into(),
                opponent_wallet: "0xh".into(),
                game: "blackjack".into(),
            }
        );
    }

    #[test]
    fn unknown_server_message_is_total_not_an_error() {
        let m: RelayToBot = serde_json::from_str(r#"{"type":"resume.ok","matchId":"m1"}"#).unwrap();
        assert_eq!(m, RelayToBot::Other);
    }
}
