//! Generic frame codec. The Channel moves these bytes; the driver owns this codec.
//! Serde-based so it is generic over any protocol's Move. The SIGNED bytes are the
//! wire StateUpdate (tunnel-core), not this envelope.

use crate::Seat;
use serde::{de::DeserializeOwned, Deserialize, Serialize};

use crate::ChannelError;

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum WireSeat {
    A,
    B,
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

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MoveFrame<M> {
    pub nonce: u64,
    pub by: WireSeat,
    pub mv: M,
    pub timestamp: u64,
    #[serde(with = "hex_array_32")]
    pub state_hash: [u8; 32],
    pub party_a_balance: u64,
    pub party_b_balance: u64,
    #[serde(with = "hex_array_64")]
    pub sig_proposer: [u8; 64],
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AckFrame {
    pub nonce: u64,
    #[serde(with = "hex_array_64")]
    pub sig_responder: [u8; 64],
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Frame<M> {
    Move(MoveFrame<M>),
    Ack(AckFrame),
}

pub fn encode_frame<M: Serialize>(f: &Frame<M>) -> Vec<u8> {
    serde_json::to_vec(f).expect("frame serializes")
}

pub fn decode_frame<M: DeserializeOwned>(bytes: &[u8]) -> Result<Frame<M>, ChannelError> {
    serde_json::from_slice(bytes).map_err(|e| ChannelError::Transport(e.to_string()))
}

// Fixed-size byte arrays as lowercase hex strings (serde has no default for [u8; N>32]).
mod hex_array_32 {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &[u8; 32], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&hex::encode(v))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<[u8; 32], D::Error> {
        let s = String::deserialize(d)?;
        let mut out = [0u8; 32];
        hex::decode_to_slice(&s, &mut out).map_err(serde::de::Error::custom)?;
        Ok(out)
    }
}
mod hex_array_64 {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(v: &[u8; 64], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&hex::encode(v))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<[u8; 64], D::Error> {
        let s = String::deserialize(d)?;
        let mut out = [0u8; 64];
        hex::decode_to_slice(&s, &mut out).map_err(serde::de::Error::custom)?;
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Serialize, serde::Deserialize, PartialEq, Debug, Clone)]
    enum TestMove {
        Bet { amount: u64 },
        Stand,
    }

    #[test]
    fn move_frame_round_trips() {
        let f: Frame<TestMove> = Frame::Move(MoveFrame {
            nonce: 1,
            by: Seat::A.into(),
            mv: TestMove::Bet { amount: 25 },
            timestamp: 99,
            state_hash: [7u8; 32],
            party_a_balance: 200,
            party_b_balance: 200,
            sig_proposer: [0xab; 64],
        });
        let bytes = encode_frame(&f);
        let back: Frame<TestMove> = decode_frame(&bytes).unwrap();
        match back {
            Frame::Move(m) => {
                assert_eq!(m.nonce, 1);
                assert_eq!(Seat::from(m.by), Seat::A);
                assert_eq!(m.mv, TestMove::Bet { amount: 25 });
                assert_eq!(m.sig_proposer, [0xab; 64]);
            }
            _ => panic!("expected move"),
        }
    }

    #[test]
    fn ack_frame_round_trips() {
        let f: Frame<TestMove> = Frame::Ack(AckFrame {
            nonce: 7,
            sig_responder: [0xcd; 64],
        });
        let back: Frame<TestMove> = decode_frame(&encode_frame(&f)).unwrap();
        match back {
            Frame::Ack(a) => assert_eq!(a.nonce, 7),
            _ => panic!("expected ack"),
        }
    }
}
