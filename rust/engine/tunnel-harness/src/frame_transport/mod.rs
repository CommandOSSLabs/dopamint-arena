//! The FrameTransport seam: opaque async byte transport. Protocol-agnostic by construction.
pub mod in_memory;

use crate::FrameTransportError;

pub trait FrameTransport: Send + Sync + 'static {
    fn send(
        &self,
        bytes: Vec<u8>,
    ) -> impl std::future::Future<Output = Result<(), FrameTransportError>> + Send;

    /// Next inbound frame bytes, or `None` when the transport is closed.
    fn recv(
        &self,
    ) -> impl std::future::Future<Output = Result<Option<Vec<u8>>, FrameTransportError>> + Send;
}
