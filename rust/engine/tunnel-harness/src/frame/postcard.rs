//! `PostcardFrameCodec`: whole-frame Postcard. Varint-encodes nonce/timestamp/
//! balances and keeps bot-vs-bot frames compact while carrying consensus fields
//! verbatim.

use super::{CodecError, FrameCodec, TunnelFrame};

/// Compact binary codec (`postcard.v1`). A zero-sized default codec.
#[derive(Default, Clone, Copy)]
pub struct PostcardFrameCodec;

impl<M: serde::Serialize + serde::de::DeserializeOwned> FrameCodec<M> for PostcardFrameCodec {
    fn id(&self) -> &str {
        "postcard.v1"
    }

    fn encode(&self, frame: &TunnelFrame<M>) -> Vec<u8> {
        postcard::to_allocvec(frame).expect("frame is postcard-serializable")
    }

    fn decode(&self, bytes: &[u8]) -> Result<TunnelFrame<M>, CodecError> {
        postcard::from_bytes(bytes).map_err(|e| CodecError::Malformed(e.to_string()))
    }
}
