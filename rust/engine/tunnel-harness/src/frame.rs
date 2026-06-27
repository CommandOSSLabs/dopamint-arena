//! The off-chain tunnel frame and its pluggable wire codec.
//!
//! `TunnelFrame<M>` is the generic state-channel envelope exchanged between two
//! seats (nonce, agreed balances, state hash, co-signatures) carrying a single
//! protocol-specific `move: M`. The core (`TunnelSeat`) builds a `TunnelFrame`
//! and hands it to an injected `FrameCodec`, so the state machine is wire-agnostic;
//! the `Channel` only ever moves the resulting opaque bytes.
//!
//! The reference `JsonFrameCodec` is byte-identical to
//! `sui-tunnel-ts/src/core/distributedFrame.ts`: u64 fields are decimal strings,
//! byte arrays are lowercase hex, and the per-game `move` sub-object is produced by
//! the protocol's `MoveCodec`. That parity is what lets a Rust bot and a TS player
//! interoperate over the same channel. The SIGNED bytes are the tunnel-core
//! `StateUpdate` (produced separately and frozen) — this codec is only the envelope.

use std::fmt;
use std::io::Write as _;

use crate::{HarnessError, Seat};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum WireSeat {
    A,
    B,
}

impl WireSeat {
    fn as_str(self) -> &'static str {
        match self {
            WireSeat::A => "A",
            WireSeat::B => "B",
        }
    }
}

impl From<Seat> for WireSeat {
    fn from(s: Seat) -> Self {
        match s {
            Seat::A => WireSeat::A,
            Seat::B => WireSeat::B,
        }
    }
}
impl From<WireSeat> for Seat {
    fn from(s: WireSeat) -> Self {
        match s {
            WireSeat::A => Seat::A,
            WireSeat::B => Seat::B,
        }
    }
}

/// A proposed move + the proposer's signature half over the state_update message.
pub struct MoveFrame<M> {
    pub nonce: u64,
    pub by: WireSeat,
    pub mv: M,
    pub timestamp: u64,
    pub state_hash: [u8; 32],
    pub party_a_balance: u64,
    pub party_b_balance: u64,
    pub sig_proposer: [u8; 64],
}

/// The responder's co-signature over the same state_update message.
pub struct AckFrame {
    pub nonce: u64,
    pub sig_responder: [u8; 64],
}

/// The two off-chain frames exchanged over a tunnel channel.
pub enum TunnelFrame<M> {
    Move(MoveFrame<M>),
    Ack(AckFrame),
}

/// A frame failed to decode from wire bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodecError {
    /// The bytes are not the expected JSON shape.
    Malformed(String),
    /// A required field was absent.
    MissingField(&'static str),
    /// A field was present but invalid (bad enum tag, bad hex, unparseable int).
    BadField(&'static str),
}

impl fmt::Display for CodecError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CodecError::Malformed(e) => write!(f, "malformed frame: {e}"),
            CodecError::MissingField(name) => write!(f, "missing field: {name}"),
            CodecError::BadField(name) => write!(f, "bad field: {name}"),
        }
    }
}
impl std::error::Error for CodecError {}

impl From<CodecError> for HarnessError {
    fn from(e: CodecError) -> Self {
        HarnessError::Verification(e.to_string())
    }
}

/// Per-game move ⇄ canonical JSON-fragment bytes. The fragment is embedded
/// literally inside the frame envelope, so it stays byte-compatible with the TS
/// move codec (e.g. blackjack `{"action":"bet","amount":25}`). Both ends of a
/// channel must agree on this mapping.
pub trait MoveCodec: Sized {
    /// Append this move's canonical JSON fragment to `out`.
    fn encode(&self, out: &mut Vec<u8>);
    /// Parse a move from its raw JSON-fragment bytes.
    fn decode(fragment: &[u8]) -> Result<Self, CodecError>;
}

/// Whole-frame wire codec, injected into `TunnelSeat` so the core is wire-agnostic.
/// Both ends of a channel MUST use a compatible codec; `id()` lets a receiver
/// select/validate the right one.
pub trait FrameCodec<M>: Send + Sync {
    /// Stable identifier for this wire format (e.g. "json.distributed.v1").
    fn id(&self) -> &str;
    fn encode(&self, frame: &TunnelFrame<M>) -> Vec<u8>;
    fn decode(&self, bytes: &[u8]) -> Result<TunnelFrame<M>, CodecError>;
}

/// The reference codec: compact JSON byte-identical to `distributedFrame.ts`.
/// u64 fields are decimal strings, byte arrays lowercase hex, fixed key order; the
/// `move` sub-object is delegated to `M: MoveCodec`. A zero-sized default codec.
#[derive(Default, Clone, Copy)]
pub struct JsonFrameCodec;

impl<M: MoveCodec> FrameCodec<M> for JsonFrameCodec {
    fn id(&self) -> &str {
        "json.distributed.v1"
    }

    fn encode(&self, frame: &TunnelFrame<M>) -> Vec<u8> {
        let mut out = Vec::with_capacity(256);
        match frame {
            TunnelFrame::Move(m) => {
                // Hand-written so key order and string/number typing exactly match
                // distributedFrame.ts; the move fragment is owned by the MoveCodec.
                write!(
                    out,
                    "{{\"kind\":\"move\",\"nonce\":\"{}\",\"by\":\"{}\",\"move\":",
                    m.nonce,
                    m.by.as_str()
                )
                .unwrap();
                m.mv.encode(&mut out);
                write!(
                    out,
                    ",\"timestamp\":\"{}\",\"stateHash\":\"{}\",\"partyABalance\":\"{}\",\"partyBBalance\":\"{}\",\"sigProposer\":\"{}\"}}",
                    m.timestamp,
                    hex::encode(m.state_hash),
                    m.party_a_balance,
                    m.party_b_balance,
                    hex::encode(m.sig_proposer),
                )
                .unwrap();
            }
            TunnelFrame::Ack(a) => {
                write!(
                    out,
                    "{{\"kind\":\"ack\",\"nonce\":\"{}\",\"sigResponder\":\"{}\"}}",
                    a.nonce,
                    hex::encode(a.sig_responder),
                )
                .unwrap();
            }
        }
        out
    }

    fn decode(&self, bytes: &[u8]) -> Result<TunnelFrame<M>, CodecError> {
        let v: serde_json::Value =
            serde_json::from_slice(bytes).map_err(|e| CodecError::Malformed(e.to_string()))?;
        let kind = v
            .get("kind")
            .and_then(|k| k.as_str())
            .ok_or(CodecError::MissingField("kind"))?;
        let nonce = u64_field(&v, "nonce")?;
        match kind {
            "ack" => Ok(TunnelFrame::Ack(AckFrame {
                nonce,
                sig_responder: hex64_field(&v, "sigResponder")?,
            })),
            "move" => {
                let by = match v
                    .get("by")
                    .and_then(|b| b.as_str())
                    .ok_or(CodecError::MissingField("by"))?
                {
                    "A" => WireSeat::A,
                    "B" => WireSeat::B,
                    _ => return Err(CodecError::BadField("by")),
                };
                let mv_value = v.get("move").ok_or(CodecError::MissingField("move"))?;
                // Re-serialize the parsed `move` sub-object back to bytes for the
                // MoveCodec. Decode reads fields by name, so key order is irrelevant.
                let mv_bytes = serde_json::to_vec(mv_value)
                    .map_err(|e| CodecError::Malformed(e.to_string()))?;
                let mv = M::decode(&mv_bytes)?;
                Ok(TunnelFrame::Move(MoveFrame {
                    nonce,
                    by,
                    mv,
                    timestamp: u64_field(&v, "timestamp")?,
                    state_hash: hex32_field(&v, "stateHash")?,
                    party_a_balance: u64_field(&v, "partyABalance")?,
                    party_b_balance: u64_field(&v, "partyBBalance")?,
                    sig_proposer: hex64_field(&v, "sigProposer")?,
                }))
            }
            _ => Err(CodecError::BadField("kind")),
        }
    }
}

/// A u64 carried as a JSON decimal string (the distributedFrame convention).
fn u64_field(v: &serde_json::Value, name: &'static str) -> Result<u64, CodecError> {
    v.get(name)
        .and_then(|x| x.as_str())
        .ok_or(CodecError::MissingField(name))?
        .parse()
        .map_err(|_| CodecError::BadField(name))
}

fn hex32_field(v: &serde_json::Value, name: &'static str) -> Result<[u8; 32], CodecError> {
    let s = v
        .get(name)
        .and_then(|x| x.as_str())
        .ok_or(CodecError::MissingField(name))?;
    let mut out = [0u8; 32];
    hex::decode_to_slice(s, &mut out).map_err(|_| CodecError::BadField(name))?;
    Ok(out)
}

fn hex64_field(v: &serde_json::Value, name: &'static str) -> Result<[u8; 64], CodecError> {
    let s = v
        .get(name)
        .and_then(|x| x.as_str())
        .ok_or(CodecError::MissingField(name))?;
    let mut out = [0u8; 64];
    hex::decode_to_slice(s, &mut out).map_err(|_| CodecError::BadField(name))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // A minimal move with a canonical JSON fragment, to exercise the generic codec.
    #[derive(PartialEq, Debug)]
    enum TestMove {
        Bet { amount: u64 },
        Stand,
    }

    impl MoveCodec for TestMove {
        fn encode(&self, out: &mut Vec<u8>) {
            match self {
                TestMove::Bet { amount } => {
                    write!(out, "{{\"action\":\"bet\",\"amount\":{amount}}}").unwrap()
                }
                TestMove::Stand => out.extend_from_slice(b"{\"action\":\"stand\"}"),
            }
        }
        fn decode(fragment: &[u8]) -> Result<Self, CodecError> {
            let v: serde_json::Value = serde_json::from_slice(fragment)
                .map_err(|e| CodecError::Malformed(e.to_string()))?;
            match v.get("action").and_then(|a| a.as_str()) {
                Some("bet") => Ok(TestMove::Bet {
                    amount: v
                        .get("amount")
                        .and_then(|a| a.as_u64())
                        .ok_or(CodecError::MissingField("amount"))?,
                }),
                Some("stand") => Ok(TestMove::Stand),
                Some(_) => Err(CodecError::BadField("action")),
                None => Err(CodecError::MissingField("action")),
            }
        }
    }

    #[test]
    fn move_frame_round_trips() {
        let f: TunnelFrame<TestMove> = TunnelFrame::Move(MoveFrame {
            nonce: 1,
            by: WireSeat::A,
            mv: TestMove::Bet { amount: 25 },
            timestamp: 99,
            state_hash: [7u8; 32],
            party_a_balance: 200,
            party_b_balance: 200,
            sig_proposer: [0xab; 64],
        });
        let bytes = JsonFrameCodec.encode(&f);
        let decoded: TunnelFrame<TestMove> = JsonFrameCodec.decode(&bytes).unwrap();
        match decoded {
            TunnelFrame::Move(m) => {
                assert_eq!(m.nonce, 1);
                assert_eq!(Seat::from(m.by), Seat::A);
                assert_eq!(m.mv, TestMove::Bet { amount: 25 });
                assert_eq!(m.timestamp, 99);
                assert_eq!(m.party_b_balance, 200);
                assert_eq!(m.sig_proposer, [0xab; 64]);
            }
            _ => panic!("expected move"),
        }
    }

    #[test]
    fn ack_frame_round_trips() {
        let f: TunnelFrame<TestMove> = TunnelFrame::Ack(AckFrame {
            nonce: 7,
            sig_responder: [0xcd; 64],
        });
        let bytes = JsonFrameCodec.encode(&f);
        assert_eq!(
            String::from_utf8(bytes.clone()).unwrap(),
            format!(
                "{{\"kind\":\"ack\",\"nonce\":\"7\",\"sigResponder\":\"{}\"}}",
                hex::encode([0xcd; 64])
            )
        );
        let decoded: TunnelFrame<TestMove> = JsonFrameCodec.decode(&bytes).unwrap();
        match decoded {
            TunnelFrame::Ack(a) => {
                assert_eq!(a.nonce, 7);
                assert_eq!(a.sig_responder, [0xcd; 64]);
            }
            _ => panic!("expected ack"),
        }
    }

    #[test]
    fn stand_move_has_no_amount() {
        let f: TunnelFrame<TestMove> = TunnelFrame::Move(MoveFrame {
            nonce: 2,
            by: WireSeat::B,
            mv: TestMove::Stand,
            timestamp: 0,
            state_hash: [0; 32],
            party_a_balance: 1,
            party_b_balance: 2,
            sig_proposer: [0; 64],
        });
        let json = String::from_utf8(JsonFrameCodec.encode(&f)).unwrap();
        assert!(json.contains("\"move\":{\"action\":\"stand\"}"));
        assert!(!json.contains("amount"));
        assert!(json.contains("\"by\":\"B\""));
    }

    #[test]
    fn decode_rejects_malformed() {
        assert!(matches!(
            FrameCodec::<TestMove>::decode(&JsonFrameCodec, b"not json"),
            Err(CodecError::Malformed(_))
        ));
    }
}
