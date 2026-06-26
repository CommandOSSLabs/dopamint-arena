//! Per-seam error types surfaced through `HarnessError`.

/// An illegal move or a broken protocol invariant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolError(pub String);

/// A transport failure on a `Channel`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChannelError {
    Closed,
    Transport(String),
}

/// A failure submitting to or reading from the anchor (chain).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AnchorError(pub String);

/// Anything that can end a driver's run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HarnessError {
    Protocol(ProtocolError),
    Channel(ChannelError),
    Anchor(AnchorError),
    /// A counterparty signature, hash, or balance check failed.
    Verification(String),
}

impl From<ProtocolError> for HarnessError {
    fn from(e: ProtocolError) -> Self {
        HarnessError::Protocol(e)
    }
}
impl From<ChannelError> for HarnessError {
    fn from(e: ChannelError) -> Self {
        HarnessError::Channel(e)
    }
}
impl From<AnchorError> for HarnessError {
    fn from(e: AnchorError) -> Self {
        HarnessError::Anchor(e)
    }
}
