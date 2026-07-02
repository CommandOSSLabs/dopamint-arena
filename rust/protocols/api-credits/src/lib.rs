//! API credits protocol: client A prepays, then each metered call shifts a fixed
//! amount to provider B. Mirrors `sui-tunnel-ts/src/protocol/apiCredits.ts`.

use tunnel_core::codec::u64_to_be_bytes;
use tunnel_harness::{Balances, Protocol, ProtocolError, Seat, TunnelContext};

pub mod strategy;
pub use strategy::ApiCreditsStrategy;

const DOMAIN: &[u8] = b"sui_tunnel::proto::api_credits.v1";

#[derive(Clone, Debug)]
pub struct ApiCreditsState {
    pub client: u64,
    pub provider: u64,
    pub total: u64,
    pub calls: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApiCreditsMove {
    Call,
}

impl serde::Serialize for ApiCreditsMove {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let mut m = s.serialize_map(Some(1))?;
        match self {
            ApiCreditsMove::Call => m.serialize_entry("kind", "call")?,
        }
        m.end()
    }
}

impl<'de> serde::Deserialize<'de> for ApiCreditsMove {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        use serde::de::Error as _;
        let v = serde_json::Value::deserialize(d)?;
        match v.get("kind").and_then(|k| k.as_str()) {
            Some("call") => Ok(ApiCreditsMove::Call),
            _ => Err(D::Error::custom("unknown api credits move kind")),
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct ApiCredits {
    cost_per_call: u64,
}

impl ApiCredits {
    pub fn new(cost_per_call: u64) -> Result<Self, ProtocolError> {
        if cost_per_call == 0 {
            return Err(ProtocolError("costPerCall must be positive".into()));
        }
        Ok(ApiCredits { cost_per_call })
    }

    pub fn cost_per_call(&self) -> u64 {
        self.cost_per_call
    }
}

impl Protocol for ApiCredits {
    type State = ApiCreditsState;
    type Move = ApiCreditsMove;

    fn name(&self) -> &str {
        "api_credits.v1"
    }

    fn initial_state(&self, ctx: &TunnelContext) -> ApiCreditsState {
        ApiCreditsState {
            client: ctx.initial.a,
            provider: ctx.initial.b,
            total: ctx.initial.sum(),
            calls: 0,
        }
    }

    fn apply_move(
        &self,
        state: &ApiCreditsState,
        mv: &ApiCreditsMove,
        by: Seat,
    ) -> Result<ApiCreditsState, ProtocolError> {
        if by != Seat::A {
            return Err(ProtocolError("only the client (A) makes calls".into()));
        }
        match mv {
            ApiCreditsMove::Call => {}
        }
        if state.client < self.cost_per_call {
            return Err(ProtocolError(
                "out of credits: remaining balance can't cover a call".into(),
            ));
        }
        Ok(ApiCreditsState {
            client: state.client - self.cost_per_call,
            provider: state.provider + self.cost_per_call,
            total: state.total,
            calls: state.calls + 1,
        })
    }

    fn encode_state(&self, state: &ApiCreditsState) -> Vec<u8> {
        let mut out = Vec::with_capacity(DOMAIN.len() + 24);
        out.extend_from_slice(DOMAIN);
        out.extend_from_slice(&u64_to_be_bytes(state.client));
        out.extend_from_slice(&u64_to_be_bytes(state.provider));
        out.extend_from_slice(&u64_to_be_bytes(state.calls));
        out
    }

    fn balances(&self, state: &ApiCreditsState) -> Balances {
        Balances {
            a: state.client,
            b: state.provider,
        }
    }

    fn is_terminal(&self, state: &ApiCreditsState) -> bool {
        state.client < self.cost_per_call
    }

    fn can_gracefully_close(&self, _state: &ApiCreditsState) -> bool {
        true
    }

    fn sample_move(
        &self,
        state: &ApiCreditsState,
        seat: Seat,
        _rng: &mut dyn FnMut() -> f64,
    ) -> Option<ApiCreditsMove> {
        if seat != Seat::A || self.is_terminal(state) {
            return None;
        }
        Some(ApiCreditsMove::Call)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_api_credit_state_is_gracefully_closeable() {
        let protocol = ApiCredits { cost_per_call: 1 };
        let ctx = TunnelContext {
            tunnel_id: "0xapi".into(),
            initial: Balances { a: 10, b: 0 },
            seat: Seat::A,
        };
        let state = protocol.initial_state(&ctx);

        assert!(protocol.can_gracefully_close(&state));
        assert!(!protocol.is_terminal(&state));
    }
}
