//! Per-seam error types surfaced through `HarnessError`.

/// An illegal move or a broken protocol invariant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolError(pub String);

/// A transport failure on a `FrameTransport`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameTransportError {
    Closed,
    Transport(String),
}

/// A failure submitting to or reading from the anchor (chain).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnchorError(pub String);

/// Anything that can end a party driver's run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HarnessError {
    Protocol(ProtocolError),
    FrameTransport(FrameTransportError),
    Anchor(AnchorError),
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
impl From<AnchorError> for HarnessError {
    fn from(e: AnchorError) -> Self {
        HarnessError::Anchor(e)
    }
}
