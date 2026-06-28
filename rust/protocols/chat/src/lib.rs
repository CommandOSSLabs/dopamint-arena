//! Chat protocol: unbounded transcript folded into a rolling digest, with
//! optional tips between parties. Mirrors `sui-tunnel-ts/src/protocol/chat.ts`.

use tunnel_core::codec::u64_to_be_bytes;
use tunnel_core::crypto::blake2b256;
use tunnel_harness::{Balances, Protocol, ProtocolError, Seat, TunnelContext};

pub mod strategy;
pub use strategy::ChatStrategy;

const DOMAIN: &[u8] = b"sui_tunnel::proto::chat.v1";

#[derive(Clone, Debug)]
pub struct ChatState {
    pub transcript_digest: [u8; 32],
    pub message_count: u64,
    pub last_sender: Option<Seat>,
    pub balance_a: u64,
    pub balance_b: u64,
    pub total: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChatMove {
    pub text: String,
    pub tip: Option<u64>,
}

impl ChatMove {
    pub fn plain(text: impl Into<String>) -> Self {
        ChatMove {
            text: text.into(),
            tip: None,
        }
    }
}

impl serde::Serialize for ChatMove {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let len = if self.tip.is_some() { 3 } else { 2 };
        let mut m = s.serialize_map(Some(len))?;
        m.serialize_entry("kind", "msg")?;
        m.serialize_entry("text", &self.text)?;
        if let Some(tip) = self.tip {
            m.serialize_entry("tip", &tip)?;
        }
        m.end()
    }
}

impl<'de> serde::Deserialize<'de> for ChatMove {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        use serde::de::Error as _;
        let v = serde_json::Value::deserialize(d)?;
        if v.get("kind").and_then(|k| k.as_str()) != Some("msg") {
            return Err(D::Error::custom("unknown chat move kind"));
        }
        let text = v
            .get("text")
            .and_then(|t| t.as_str())
            .ok_or_else(|| D::Error::custom("chat move missing text"))?
            .to_string();
        let tip = match v.get("tip") {
            Some(t) => Some(
                t.as_u64()
                    .ok_or_else(|| D::Error::custom("chat tip must be u64"))?,
            ),
            None => None,
        };
        Ok(ChatMove { text, tip })
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Chat;

fn party_byte(seat: Seat) -> u8 {
    match seat {
        Seat::A => 0x01,
        Seat::B => 0x02,
    }
}

fn fold_message(prev: &[u8; 32], by: Seat, text: &str) -> [u8; 32] {
    let message_bytes = text.as_bytes();
    let mut delta_input = Vec::with_capacity(1 + 8 + message_bytes.len());
    delta_input.push(party_byte(by));
    delta_input.extend_from_slice(&u64_to_be_bytes(message_bytes.len() as u64));
    delta_input.extend_from_slice(message_bytes);
    let delta = blake2b256(&delta_input);

    let mut digest_input = Vec::with_capacity(64);
    digest_input.extend_from_slice(prev);
    digest_input.extend_from_slice(&delta);
    blake2b256(&digest_input)
}

impl Protocol for Chat {
    type State = ChatState;
    type Move = ChatMove;

    fn name(&self) -> &str {
        "chat.v1"
    }

    fn initial_state(&self, ctx: &TunnelContext) -> ChatState {
        ChatState {
            transcript_digest: [0u8; 32],
            message_count: 0,
            last_sender: None,
            balance_a: ctx.initial.a,
            balance_b: ctx.initial.b,
            total: ctx.initial.sum(),
        }
    }

    fn apply_move(
        &self,
        state: &ChatState,
        mv: &ChatMove,
        by: Seat,
    ) -> Result<ChatState, ProtocolError> {
        if mv.text.is_empty() {
            return Err(ProtocolError("chat message must be non-empty".into()));
        }

        let mut balance_a = state.balance_a;
        let mut balance_b = state.balance_b;
        if let Some(tip) = mv.tip {
            match by {
                Seat::A => {
                    if tip > state.balance_a {
                        return Err(ProtocolError(format!(
                            "tip {tip} exceeds A balance {}",
                            state.balance_a
                        )));
                    }
                    balance_a -= tip;
                    balance_b += tip;
                }
                Seat::B => {
                    if tip > state.balance_b {
                        return Err(ProtocolError(format!(
                            "tip {tip} exceeds B balance {}",
                            state.balance_b
                        )));
                    }
                    balance_b -= tip;
                    balance_a += tip;
                }
            }
        }

        Ok(ChatState {
            transcript_digest: fold_message(&state.transcript_digest, by, &mv.text),
            message_count: state.message_count + 1,
            last_sender: Some(by),
            balance_a,
            balance_b,
            total: state.total,
        })
    }

    fn encode_state(&self, state: &ChatState) -> Vec<u8> {
        let mut out = Vec::with_capacity(DOMAIN.len() + 32 + 24);
        out.extend_from_slice(DOMAIN);
        out.extend_from_slice(&state.transcript_digest);
        out.extend_from_slice(&u64_to_be_bytes(state.message_count));
        out.extend_from_slice(&u64_to_be_bytes(state.balance_a));
        out.extend_from_slice(&u64_to_be_bytes(state.balance_b));
        out
    }

    fn balances(&self, state: &ChatState) -> Balances {
        Balances {
            a: state.balance_a,
            b: state.balance_b,
        }
    }

    fn is_terminal(&self, _state: &ChatState) -> bool {
        false
    }

    fn sample_move(
        &self,
        state: &ChatState,
        seat: Seat,
        rng: &mut dyn FnMut() -> f64,
    ) -> Option<ChatMove> {
        let text = format!("msg{}", state.message_count);
        let balance = match seat {
            Seat::A => state.balance_a,
            Seat::B => state.balance_b,
        };
        if balance > 0 && rng() < 0.25 {
            let cap = balance.min(10);
            let tip = 1 + (rng() * cap as f64).floor() as u64;
            return Some(ChatMove {
                text,
                tip: Some(tip),
            });
        }
        Some(ChatMove { text, tip: None })
    }
}
