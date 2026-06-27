//! The Channel seam: opaque async byte transport. Protocol-agnostic by construction.
pub mod in_memory;

use tunnel_harness::ChannelError;

pub trait Channel: Send + Sync + 'static {
    fn send(
        &self,
        bytes: Vec<u8>,
    ) -> impl std::future::Future<Output = Result<(), ChannelError>> + Send;

    /// Next inbound frame bytes, or `None` when the channel is closed.
    fn recv(
        &self,
    ) -> impl std::future::Future<Output = Result<Option<Vec<u8>>, ChannelError>> + Send;
}
