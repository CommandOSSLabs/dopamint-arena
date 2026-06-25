//! The two PvP wire frames and their JSON envelope codec — byte-identical to
//! `sui-tunnel-ts/src/core/distributedFrame.ts::encodeFrame`. u64 fields are decimal
//! strings; hashes/signatures are lowercase hex; `move` nests as `{"action":...}` with
//! `amount` a JSON number for bets. The SIGNED state-update bytes are produced separately
//! by `engine::wire::serialize_state_update`; this codec is only the transport envelope.

use crate::game::blackjack::{BjMove, Party};

pub struct MoveFrame {
    pub nonce: u64,
    pub by: Party,
    pub mv: BjMove,
    pub timestamp: u64,
    pub state_hash: [u8; 32],
    pub party_a_balance: u64,
    pub party_b_balance: u64,
    pub sig_proposer: [u8; 64],
}

pub struct AckFrame {
    pub nonce: u64,
    pub sig_responder: [u8; 64],
}

pub enum Frame {
    Move(MoveFrame),
    Ack(AckFrame),
}

fn party_str(p: Party) -> &'static str {
    match p {
        Party::A => "A",
        Party::B => "B",
    }
}

fn move_json(mv: &BjMove) -> String {
    match mv {
        BjMove::Bet { amount } => format!("{{\"action\":\"bet\",\"amount\":{amount}}}"),
        BjMove::Hit => "{\"action\":\"hit\"}".to_string(),
        BjMove::Stand => "{\"action\":\"stand\"}".to_string(),
    }
}

/// Compact JSON, field order identical to the TS `encodeFrame`. Built by hand (not derived)
/// so the exact key order and string/number typing are guaranteed.
pub fn encode_frame(f: &Frame) -> Vec<u8> {
    match f {
        Frame::Move(m) => format!(
            "{{\"kind\":\"move\",\"nonce\":\"{}\",\"by\":\"{}\",\"move\":{},\"timestamp\":\"{}\",\"stateHash\":\"{}\",\"partyABalance\":\"{}\",\"partyBBalance\":\"{}\",\"sigProposer\":\"{}\"}}",
            m.nonce, party_str(m.by), move_json(&m.mv), m.timestamp,
            hex::encode(m.state_hash), m.party_a_balance, m.party_b_balance, hex::encode(m.sig_proposer),
        ).into_bytes(),
        Frame::Ack(a) => format!(
            "{{\"kind\":\"ack\",\"nonce\":\"{}\",\"sigResponder\":\"{}\"}}",
            a.nonce, hex::encode(a.sig_responder),
        ).into_bytes(),
    }
}

/// Parse a frame. Uses serde_json's Value for tolerance (key order irrelevant on decode).
pub fn decode_frame(bytes: &[u8]) -> Result<Frame, String> {
    let v: serde_json::Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    let kind = v
        .get("kind")
        .and_then(|k| k.as_str())
        .ok_or("missing kind")?;
    let nonce: u64 = v
        .get("nonce")
        .and_then(|n| n.as_str())
        .ok_or("missing nonce")?
        .parse()
        .map_err(|_| "bad nonce")?;
    match kind {
        "ack" => {
            let sig = parse_sig64(
                v.get("sigResponder")
                    .and_then(|s| s.as_str())
                    .ok_or("missing sigResponder")?,
            )?;
            Ok(Frame::Ack(AckFrame {
                nonce,
                sig_responder: sig,
            }))
        }
        "move" => {
            let by = match v.get("by").and_then(|b| b.as_str()).ok_or("missing by")? {
                "A" => Party::A,
                "B" => Party::B,
                other => return Err(format!("bad party {other}")),
            };
            let mv_obj = v.get("move").ok_or("missing move")?;
            let action = mv_obj
                .get("action")
                .and_then(|a| a.as_str())
                .ok_or("missing action")?;
            let mv = match action {
                "bet" => BjMove::Bet {
                    amount: mv_obj
                        .get("amount")
                        .and_then(|a| a.as_u64())
                        .ok_or("missing amount")?,
                },
                "hit" => BjMove::Hit,
                "stand" => BjMove::Stand,
                other => return Err(format!("bad action {other}")),
            };
            let timestamp: u64 = v
                .get("timestamp")
                .and_then(|t| t.as_str())
                .ok_or("missing timestamp")?
                .parse()
                .map_err(|_| "bad timestamp")?;
            let state_hash = parse_hash32(
                v.get("stateHash")
                    .and_then(|s| s.as_str())
                    .ok_or("missing stateHash")?,
            )?;
            let party_a_balance: u64 = v
                .get("partyABalance")
                .and_then(|s| s.as_str())
                .ok_or("missing partyABalance")?
                .parse()
                .map_err(|_| "bad balA")?;
            let party_b_balance: u64 = v
                .get("partyBBalance")
                .and_then(|s| s.as_str())
                .ok_or("missing partyBBalance")?
                .parse()
                .map_err(|_| "bad balB")?;
            let sig_proposer = parse_sig64(
                v.get("sigProposer")
                    .and_then(|s| s.as_str())
                    .ok_or("missing sigProposer")?,
            )?;
            Ok(Frame::Move(MoveFrame {
                nonce,
                by,
                mv,
                timestamp,
                state_hash,
                party_a_balance,
                party_b_balance,
                sig_proposer,
            }))
        }
        other => Err(format!("unknown frame kind: {other}")),
    }
}

fn parse_hash32(s: &str) -> Result<[u8; 32], String> {
    let mut out = [0u8; 32];
    hex::decode_to_slice(s, &mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

fn parse_sig64(s: &str) -> Result<[u8; 64], String> {
    let mut out = [0u8; 64];
    hex::decode_to_slice(s, &mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::blackjack::{BjMove, Party};

    #[test]
    fn move_frame_encodes_to_exact_json() {
        let f = Frame::Move(MoveFrame {
            nonce: 1,
            by: Party::A,
            mv: BjMove::Bet { amount: 25 },
            timestamp: 1234567890,
            state_hash: std::array::from_fn(|i| (i + 1) as u8),
            party_a_balance: 200,
            party_b_balance: 200,
            sig_proposer: [0xab; 64],
        });
        let json = String::from_utf8(encode_frame(&f)).unwrap();
        let expected = format!(
            "{{\"kind\":\"move\",\"nonce\":\"1\",\"by\":\"A\",\"move\":{{\"action\":\"bet\",\"amount\":25}},\"timestamp\":\"1234567890\",\"stateHash\":\"{}\",\"partyABalance\":\"200\",\"partyBBalance\":\"200\",\"sigProposer\":\"{}\"}}",
            hex::encode((1u8..=32).collect::<Vec<u8>>()),
            hex::encode([0xab; 64]),
        );
        assert_eq!(json, expected);
    }

    #[test]
    fn hit_move_has_no_amount_field() {
        let f = Frame::Move(MoveFrame {
            nonce: 2,
            by: Party::B,
            mv: BjMove::Hit,
            timestamp: 0,
            state_hash: [0; 32],
            party_a_balance: 1,
            party_b_balance: 2,
            sig_proposer: [0; 64],
        });
        let json = String::from_utf8(encode_frame(&f)).unwrap();
        assert!(json.contains("\"move\":{\"action\":\"hit\"}"));
        assert!(!json.contains("amount"));
    }

    #[test]
    fn ack_frame_round_trips() {
        let f = Frame::Ack(AckFrame {
            nonce: 7,
            sig_responder: [0xcd; 64],
        });
        let bytes = encode_frame(&f);
        assert_eq!(
            String::from_utf8(bytes.clone()).unwrap(),
            format!(
                "{{\"kind\":\"ack\",\"nonce\":\"7\",\"sigResponder\":\"{}\"}}",
                hex::encode([0xcd; 64])
            )
        );
        match decode_frame(&bytes).unwrap() {
            Frame::Ack(a) => {
                assert_eq!(a.nonce, 7);
                assert_eq!(a.sig_responder, [0xcd; 64]);
            }
            _ => panic!("expected ack"),
        }
    }

    #[test]
    fn move_frame_round_trips() {
        let f = Frame::Move(MoveFrame {
            nonce: 9,
            by: Party::A,
            mv: BjMove::Stand,
            timestamp: 5,
            state_hash: std::array::from_fn(|i| i as u8),
            party_a_balance: 10,
            party_b_balance: 20,
            sig_proposer: [1; 64],
        });
        let bytes = encode_frame(&f);
        match decode_frame(&bytes).unwrap() {
            Frame::Move(m) => {
                assert_eq!(m.nonce, 9);
                assert!(matches!(m.by, Party::A));
                assert!(matches!(m.mv, BjMove::Stand));
                assert_eq!(m.party_b_balance, 20);
            }
            _ => panic!("expected move"),
        }
    }
}
