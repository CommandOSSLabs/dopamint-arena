//! The `GET /v1/mp` control sub-protocol (spec §4). `#[serde(tag = "type")]` external
//! tagging matches the wire table; dotted message names use explicit `rename`.
//! `rename_all_fields = "camelCase"` makes struct-variant FIELDS camelCase (the
//! enum-level `rename_all` only renames the variant tag), matching the SDK wire (ADR-0002).

use serde::{Deserialize, Serialize};

/// Messages the client sends to the server.
#[derive(Debug, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ClientMsg {
    /// Authenticate: prove control of `pubkey` (which the client claims is `wallet`)
    /// by signing the server-issued `nonce`. See `auth.rs` for verification.
    Connect {
        wallet: String,
        pubkey: String,
        sig: String,
        nonce: String,
    },
    #[serde(rename = "queue.join")]
    QueueJoin { game: String },
    #[serde(rename = "queue.leave")]
    QueueLeave,
    #[serde(rename = "challenge.create")]
    ChallengeCreate { target_wallet: String, game: String },
    #[serde(rename = "challenge.accept")]
    ChallengeAccept { match_id: String },
    #[serde(rename = "challenge.decline")]
    ChallengeDecline { match_id: String },
    #[serde(rename = "party.hello")]
    PartyHello {
        match_id: String,
        ephemeral_pubkey: String,
        wallet_sig: String,
    },
    #[serde(rename = "tunnel.opened")]
    TunnelOpened { match_id: String, tunnel_id: String },
    /// OPAQUE move/ack frame to forward to the other seat. `payload` is never parsed.
    Relay { match_id: String, payload: String },
    #[serde(rename = "watchtower.checkpoint")]
    WatchtowerCheckpoint {
        match_id: String,
        nonce: String,
        party_a_balance: String,
        party_b_balance: String,
        state_hash: String,
        sig_a: String,
        sig_b: String,
    },
}

/// Messages the server sends to the client.
#[derive(Debug, Serialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ServerMsg {
    /// One-time nonce the client must sign in `connect`.
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
    // emitted in a later phase; part of the FE wire contract
    #[allow(dead_code)]
    #[serde(rename = "queue.timeout")]
    QueueTimeout {
        match_id: String,
    },
    #[serde(rename = "challenge.incoming")]
    ChallengeIncoming {
        match_id: String,
        from_wallet: String,
        game: String,
    },
    // emitted in a later phase; part of the FE wire contract
    #[allow(dead_code)]
    #[serde(rename = "match.active")]
    MatchActive {
        match_id: String,
    },
    Relay {
        match_id: String,
        payload: String,
    },
    Error {
        code: String,
        message: String,
    },
}

impl ServerMsg {
    pub fn error(code: &str, message: &str) -> Self {
        ServerMsg::Error {
            code: code.to_owned(),
            message: message.to_owned(),
        }
    }
    /// JSON text for a `Message::Text` frame (infallible for these owned types).
    pub fn to_text(&self) -> String {
        serde_json::to_string(self).expect("ServerMsg serializes")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // The control wire MUST round-trip the exact dotted, camelCase shapes the FE sends.
    // A rename here is an integration break with the browser client.
    #[test]
    fn client_queue_join_deserializes_dotted_name() {
        let m: ClientMsg = serde_json::from_str(r#"{"type":"queue.join","game":"ttt"}"#).unwrap();
        assert_eq!(m, ClientMsg::QueueJoin { game: "ttt".into() });
    }

    // The relay payload is an opaque string the server never parses — an arbitrary
    // non-frame value round-trips verbatim through deserialization.
    #[test]
    fn client_relay_carries_opaque_payload_verbatim() {
        let raw = r#"{"type":"relay","matchId":"m1","payload":"opaque::not-a-frame::42"}"#;
        let m: ClientMsg = serde_json::from_str(raw).unwrap();
        match m {
            ClientMsg::Relay { match_id, payload } => {
                assert_eq!(match_id, "m1");
                assert_eq!(payload, "opaque::not-a-frame::42");
            }
            _ => panic!("expected relay"),
        }
    }

    // camelCase field rename must apply to struct-variant FIELDS, not just the tag.
    #[test]
    fn server_match_found_serializes_with_dotted_type() {
        let s = ServerMsg::MatchFound {
            match_id: "m1".into(),
            role: "A".into(),
            opponent_wallet: "0xb".into(),
            game: "ttt".into(),
        };
        let json = s.to_text();
        assert!(json.contains(r#""type":"match.found""#), "got {json}");
        assert!(json.contains(r#""opponentWallet":"0xb""#), "got {json}");
    }
}
