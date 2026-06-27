//! `BcsFrameCodec`: whole-frame BCS, Sui-native and fixed-width. Bot-vs-bot only:
//! no TS peer, no parity constraint, and no consensus recomputation here.

use super::{CodecError, FrameCodec, TunnelFrame};

/// Canonical binary codec (`bcs.v1`). A zero-sized default codec.
#[derive(Default, Clone, Copy)]
pub struct BcsFrameCodec;

impl<M: serde::Serialize + serde::de::DeserializeOwned> FrameCodec<M> for BcsFrameCodec {
    fn id(&self) -> &str {
        "bcs.v1"
    }

    fn encode(&self, frame: &TunnelFrame<M>) -> Vec<u8> {
        bcs::to_bytes(frame).expect("frame is bcs-serializable")
    }

    fn decode(&self, bytes: &[u8]) -> Result<TunnelFrame<M>, CodecError> {
        bcs::from_bytes(bytes).map_err(|e| CodecError::Malformed(e.to_string()))
    }
}
