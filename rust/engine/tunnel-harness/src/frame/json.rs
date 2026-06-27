//! `JsonFrameCodec`: byte-identical to `sui-tunnel-ts/src/core/distributedFrame.ts`.
//! The envelope is hand-written to hold exact key order and string/number typing;
//! the `move` sub-object is serialized through the move's serde impl.

use std::io::Write as _;

use super::{
    hex32_field, hex64_field, u64_field, AckFrame, CodecError, FrameCodec, MoveFrame, TunnelFrame,
    WireSeat,
};

/// The reference codec: compact JSON byte-identical to `distributedFrame.ts`.
/// A zero-sized default codec.
#[derive(Default, Clone, Copy)]
pub struct JsonFrameCodec;

impl<M: serde::Serialize + serde::de::DeserializeOwned> FrameCodec<M> for JsonFrameCodec {
    fn id(&self) -> &str {
        "json.distributed.v1"
    }

    fn encode(&self, frame: &TunnelFrame<M>) -> Vec<u8> {
        let mut out = Vec::with_capacity(256);
        match frame {
            TunnelFrame::Move(m) => {
                // Hand-written so key order and string/number typing exactly match
                // distributedFrame.ts; the move fragment is owned by serde.
                write!(
                    out,
                    "{{\"kind\":\"move\",\"nonce\":\"{}\",\"by\":\"{}\",\"move\":",
                    m.nonce,
                    m.by.as_str()
                )
                .unwrap();
                serde_json::to_writer(&mut out, &m.mv).expect("move serializes to json");
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
                let mv: M = serde_json::from_value(mv_value.clone())
                    .map_err(|e| CodecError::Malformed(e.to_string()))?;
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
