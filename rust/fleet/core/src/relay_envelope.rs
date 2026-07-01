//! The relay envelope: the bot↔relay transport layer over the seat's wire frames.
//!
//! The seat's default `JsonFrameCodec` already emits inner frames byte-identical to the TS
//! `distributedFrame.ts` `encodeFrame` (u64 as decimal strings, hex bytes, TS-compatible `move`
//! fragment), so NO field translation is needed here — that is the codec's job. The only
//! transport concern left is the relay envelope
//! `{ "t": "frame", "kind": <move|ack>, "data": <inner-frame-json-string> }` that the backend
//! forwards opaquely and the TS `mpClient` unwraps (mirrors `wrapInnerFrameJson` /
//! `innerFrameJsonFromRawBytes` in distributedFrame.ts). We wrap on send, unwrap on recv.

use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};

/// Wrap a seat-produced inner frame into the relay payload string the relay forwards and the TS
/// peer accepts. `kind` is lifted onto the envelope so the relay can count moves without parsing
/// `data` (matches distributedFrame.ts `wrapInnerFrameJson`).
pub fn wrap(inner_frame: &[u8]) -> Result<String> {
    let v: Value = serde_json::from_slice(inner_frame).context("inner frame is not JSON")?;
    let kind = v
        .get("kind")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("inner frame has no `kind`"))?;
    let data = std::str::from_utf8(inner_frame).context("inner frame is not UTF-8")?;
    Ok(serde_json::to_string(
        &json!({ "t": "frame", "kind": kind, "data": data }),
    )?)
}

/// Extract the inner frame bytes the seat decodes from a relay payload envelope.
pub fn unwrap(relay_payload: &[u8]) -> Result<Vec<u8>> {
    let env: Value = serde_json::from_slice(relay_payload).context("relay payload is not JSON")?;
    if env.get("t").and_then(Value::as_str) != Some("frame") {
        bail!("not a relay frame envelope");
    }
    let data = env
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("relay envelope has no `data` string"))?;
    Ok(data.as_bytes().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    // A seat inner frame (TS-compatible JSON from JsonFrameCodec) round-trips through the relay
    // envelope, and the envelope lifts `kind` so the relay can count moves.
    #[test]
    fn inner_frame_round_trips_through_the_relay_envelope() {
        let inner = br#"{"kind":"move","nonce":"1","by":"A","move":{"action":"bet","amount":25}}"#;
        let payload = wrap(inner).unwrap();
        let env: Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(env["t"], "frame");
        assert_eq!(env["kind"], "move", "kind lifted for relay move-counting");
        assert_eq!(unwrap(payload.as_bytes()).unwrap(), inner);
    }

    #[test]
    fn ack_frame_round_trips_through_the_relay_envelope() {
        let inner = br#"{"kind":"ack","nonce":"7","sigResponder":"cdcd"}"#;
        let payload = wrap(inner).unwrap();
        let env: Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(env["kind"], "ack");
        assert_eq!(unwrap(payload.as_bytes()).unwrap(), inner);
    }

    #[test]
    fn unwrap_rejects_a_non_envelope_payload() {
        assert!(unwrap(br#"{"foo":"bar"}"#).is_err());
    }
}
