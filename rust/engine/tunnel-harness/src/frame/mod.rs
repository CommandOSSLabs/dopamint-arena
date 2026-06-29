//! The off-chain tunnel frame and its pluggable wire codec.
//!
//! `TunnelFrame<M>` is the generic state-frame envelope exchanged between two
//! seats (nonce, agreed balances, state hash, co-signatures) carrying a single
//! protocol-specific `move: M`. The core (`PartyRuntime`) builds a `TunnelFrame`
//! and hands it to an injected `FrameCodec`, so the state machine is wire-agnostic;
//! the `FrameTransport` only ever moves the resulting opaque bytes.
//!
//! The reference `JsonFrameCodec` is byte-identical to
//! `sui-tunnel-ts/src/core/distributedFrame.ts`: u64 fields are decimal strings,
//! byte arrays are lowercase hex, and the per-game `move` sub-object is produced by
//! the move's serde implementation. That parity is what lets a Rust bot and a TS player
//! interoperate over the same frame transport. The SIGNED bytes are the tunnel-core
//! `StateUpdate` (produced separately and frozen) — this codec is only the envelope.

use std::fmt;

use crate::{HarnessError, Seat};
use serde::{Deserialize, Serialize};
use serde_big_array::BigArray;

mod bcs;
mod json;
mod postcard;
pub use bcs::BcsFrameCodec;
pub use json::JsonFrameCodec;
pub use postcard::PostcardFrameCodec;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub enum WireSeat {
    A,
    B,
}

impl WireSeat {
    pub(crate) fn as_str(self) -> &'static str {
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
#[derive(Serialize, Deserialize)]
pub struct MoveFrame<M> {
    pub nonce: u64,
    pub by: WireSeat,
    pub mv: M,
    pub timestamp: u64,
    pub state_hash: [u8; 32],
    pub party_a_balance: u64,
    pub party_b_balance: u64,
    #[serde(with = "BigArray")]
    pub sig_proposer: [u8; 64],
}

/// The responder's co-signature over the same state_update message.
#[derive(Serialize, Deserialize)]
pub struct AckFrame {
    pub nonce: u64,
    #[serde(with = "BigArray")]
    pub sig_responder: [u8; 64],
}

/// The two off-chain frames exchanged over a tunnel frame transport.
#[derive(Serialize, Deserialize)]
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

/// Whole-frame wire codec, injected into `PartyRuntime` so the core is wire-agnostic.
/// Both ends of a frame transport MUST use a compatible codec; `id()` lets a receiver
/// select/validate the right one.
pub trait FrameCodec<M>: Send + Sync {
    /// Stable identifier for this wire format (e.g. "json.distributed.v1").
    fn id(&self) -> &str;
    fn encode(&self, frame: &TunnelFrame<M>) -> Vec<u8>;
    fn decode(&self, bytes: &[u8]) -> Result<TunnelFrame<M>, CodecError>;
}

/// A u64 carried as a JSON decimal string (the distributedFrame convention).
pub(crate) fn u64_field(v: &serde_json::Value, name: &'static str) -> Result<u64, CodecError> {
    v.get(name)
        .and_then(|x| x.as_str())
        .ok_or(CodecError::MissingField(name))?
        .parse()
        .map_err(|_| CodecError::BadField(name))
}

pub(crate) fn hex32_field(
    v: &serde_json::Value,
    name: &'static str,
) -> Result<[u8; 32], CodecError> {
    let s = v
        .get(name)
        .and_then(|x| x.as_str())
        .ok_or(CodecError::MissingField(name))?;
    let mut out = [0u8; 32];
    hex::decode_to_slice(s, &mut out).map_err(|_| CodecError::BadField(name))?;
    Ok(out)
}

pub(crate) fn hex64_field(
    v: &serde_json::Value,
    name: &'static str,
) -> Result<[u8; 64], CodecError> {
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

    // A minimal move to exercise the generic codec. Uses derived (externally-tagged)
    // serde; TS parity is a blackjack-crate concern, not the harness's.
    #[derive(PartialEq, Debug, serde::Serialize, serde::Deserialize)]
    enum TestMove {
        Bet { amount: u64 },
        Stand,
    }

    fn decode_move<C: FrameCodec<TestMove>>(c: &C, bytes: &[u8]) -> MoveFrame<TestMove> {
        match c.decode(bytes).unwrap() {
            TunnelFrame::Move(m) => m,
            _ => panic!("expected move"),
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
        assert!(json.contains("\"move\":\"Stand\""));
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

    #[test]
    fn bcs_move_and_ack_round_trip() {
        let mv: TunnelFrame<TestMove> = TunnelFrame::Move(MoveFrame {
            nonce: 3,
            by: WireSeat::B,
            mv: TestMove::Bet { amount: 75 },
            timestamp: 42,
            state_hash: [9u8; 32],
            party_a_balance: 150,
            party_b_balance: 250,
            sig_proposer: [0x11; 64],
        });
        let bytes = super::bcs::BcsFrameCodec.encode(&mv);
        let decoded: TunnelFrame<TestMove> = super::bcs::BcsFrameCodec.decode(&bytes).unwrap();
        match decoded {
            TunnelFrame::Move(m) => {
                assert_eq!(m.nonce, 3);
                assert_eq!(m.mv, TestMove::Bet { amount: 75 });
                assert_eq!(m.state_hash, [9u8; 32]);
                assert_eq!(m.sig_proposer, [0x11; 64]);
                assert_eq!(m.party_b_balance, 250);
            }
            _ => panic!("expected move"),
        }

        let ack: TunnelFrame<TestMove> = TunnelFrame::Ack(AckFrame {
            nonce: 8,
            sig_responder: [0x22; 64],
        });
        let bytes = super::bcs::BcsFrameCodec.encode(&ack);
        let decoded: TunnelFrame<TestMove> = super::bcs::BcsFrameCodec.decode(&bytes).unwrap();
        match decoded {
            TunnelFrame::Ack(a) => {
                assert_eq!(a.nonce, 8);
                assert_eq!(a.sig_responder, [0x22; 64]);
            }
            _ => panic!("expected ack"),
        }
    }

    #[test]
    fn bcs_rejects_garbage() {
        assert!(matches!(
            FrameCodec::<TestMove>::decode(&super::bcs::BcsFrameCodec, &[0xff, 0xff, 0xff]),
            Err(CodecError::Malformed(_))
        ));
    }

    #[test]
    fn postcard_move_round_trips_and_is_smaller_than_json() {
        let f: TunnelFrame<TestMove> = TunnelFrame::Move(MoveFrame {
            nonce: 5,
            by: WireSeat::A,
            mv: TestMove::Bet { amount: 100 },
            timestamp: 7,
            state_hash: [1u8; 32],
            party_a_balance: 200,
            party_b_balance: 200,
            sig_proposer: [0x33; 64],
        });
        let pc = super::postcard::PostcardFrameCodec.encode(&f);
        let js = JsonFrameCodec.encode(&f);
        assert!(
            pc.len() < js.len(),
            "postcard {} !< json {}",
            pc.len(),
            js.len()
        );
        let decoded: TunnelFrame<TestMove> =
            super::postcard::PostcardFrameCodec.decode(&pc).unwrap();
        match decoded {
            TunnelFrame::Move(m) => {
                assert_eq!(m.nonce, 5);
                assert_eq!(m.mv, TestMove::Bet { amount: 100 });
                assert_eq!(m.sig_proposer, [0x33; 64]);
            }
            _ => panic!("expected move"),
        }
    }

    #[test]
    fn postcard_rejects_truncated() {
        assert!(matches!(
            FrameCodec::<TestMove>::decode(&super::postcard::PostcardFrameCodec, &[0x00]),
            Err(CodecError::Malformed(_))
        ));
    }

    #[test]
    fn all_codecs_carry_identical_consensus_fields() {
        let frame: TunnelFrame<TestMove> = TunnelFrame::Move(MoveFrame {
            nonce: 11,
            by: WireSeat::A,
            mv: TestMove::Bet { amount: 500 },
            timestamp: 1234,
            state_hash: [0x5a; 32],
            party_a_balance: 175,
            party_b_balance: 225,
            sig_proposer: [0x7e; 64],
        });

        let j = decode_move(&JsonFrameCodec, &JsonFrameCodec.encode(&frame));
        let b = decode_move(
            &super::bcs::BcsFrameCodec,
            &super::bcs::BcsFrameCodec.encode(&frame),
        );
        let p = decode_move(
            &super::postcard::PostcardFrameCodec,
            &super::postcard::PostcardFrameCodec.encode(&frame),
        );

        for got in [&j, &b, &p] {
            assert_eq!(got.nonce, 11);
            assert_eq!(got.mv, TestMove::Bet { amount: 500 });
            assert_eq!(got.timestamp, 1234);
            assert_eq!(got.state_hash, [0x5a; 32]);
            assert_eq!(got.party_a_balance, 175);
            assert_eq!(got.party_b_balance, 225);
            assert_eq!(got.sig_proposer, [0x7e; 64]);
        }

        let jb = JsonFrameCodec.encode(&frame).len();
        let bb = super::bcs::BcsFrameCodec.encode(&frame).len();
        let pb = super::postcard::PostcardFrameCodec.encode(&frame).len();
        assert!(bb < jb && pb < jb, "json={jb} bcs={bb} postcard={pb}");
    }
}
