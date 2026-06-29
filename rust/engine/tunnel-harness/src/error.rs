//! Per-seam error types surfaced through `HarnessError`.

use crate::transcript::TranscriptError;

/// An illegal move or a broken protocol invariant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolError(pub String);

/// A transport failure on a `FrameTransport`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameTransportError {
    Closed,
    Transport(String),
}

/// A failure opening or settling a tunnel through the anchor (chain IO).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TunnelAnchorError {
    /// Sponsor/chain unreachable: retryable.
    Unavailable(String),
    /// Chain or verify-before-gas refused (ADR-0007): terminal.
    Rejected(String),
    /// The peer's settlement half disagrees: terminal.
    Mismatch(String),
    /// Idempotent close: the tunnel was already settled.
    AlreadySettled,
}

/// Anything that can end a party driver's run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HarnessError {
    Protocol(ProtocolError),
    FrameTransport(FrameTransportError),
    Anchor(TunnelAnchorError),
    /// A counterparty signature, hash, or balance check failed.
    Verification(String),
}

impl From<ProtocolError> for HarnessError {
    fn from(e: ProtocolError) -> Self {
        HarnessError::Protocol(e)
    }
}
impl From<FrameTransportError> for HarnessError {
    fn from(e: FrameTransportError) -> Self {
        HarnessError::FrameTransport(e)
    }
}
impl From<TunnelAnchorError> for HarnessError {
    fn from(e: TunnelAnchorError) -> Self {
        HarnessError::Anchor(e)
    }
}
impl From<TranscriptError> for HarnessError {
    fn from(e: TranscriptError) -> Self {
        HarnessError::Verification(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tunnel_anchor_error_maps_into_harness_anchor() {
        let e: HarnessError = TunnelAnchorError::AlreadySettled.into();
        assert_eq!(e, HarnessError::Anchor(TunnelAnchorError::AlreadySettled));
    }
}
