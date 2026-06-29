//! The relay transport seam: moves opaque relay-payload bytes for ONE match.
//!
//! A `RelayChannel` ([`crate::relay_channel`]) sits on top of this, bridging harness frames
//! to/from the TS relay-payload format. The real impl (`TungsteniteTransport`, Task 7) speaks
//! `/v1/mp` to the live relay and demuxes inbound `Relay{match_id, payload}` envelopes by
//! match. `MockTransport` is the in-process pair used to test the channel/bridge/driver stack
//! without a network.

use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio::sync::Mutex;
use tunnel_harness::FrameTransportError;

/// Opaque per-match payload transport. The payload bytes are exactly the relay `payload`
/// string (`{t:"frame",kind,data}`) the backend forwards verbatim.
pub trait RelayTransport: Send + Sync + 'static {
    fn send_payload(
        &self,
        payload: Vec<u8>,
    ) -> impl std::future::Future<Output = Result<(), FrameTransportError>> + Send;

    /// Next inbound payload, or `None` when the match/transport is closed.
    fn recv_payload(
        &self,
    ) -> impl std::future::Future<Output = Result<Option<Vec<u8>>, FrameTransportError>> + Send;
}

/// Two ends wired together for in-process tests: a.send -> b.recv and b.send -> a.recv.
pub struct MockTransport {
    outbound: UnboundedSender<Vec<u8>>,
    inbound: Mutex<UnboundedReceiver<Vec<u8>>>,
}

impl MockTransport {
    pub fn pair() -> (MockTransport, MockTransport) {
        let (tx_ab, rx_ab) = unbounded_channel();
        let (tx_ba, rx_ba) = unbounded_channel();
        let a = MockTransport {
            outbound: tx_ab,
            inbound: Mutex::new(rx_ba),
        };
        let b = MockTransport {
            outbound: tx_ba,
            inbound: Mutex::new(rx_ab),
        };
        (a, b)
    }
}

impl RelayTransport for MockTransport {
    async fn send_payload(&self, payload: Vec<u8>) -> Result<(), FrameTransportError> {
        self.outbound
            .send(payload)
            .map_err(|_| FrameTransportError::Closed)
    }

    async fn recv_payload(&self) -> Result<Option<Vec<u8>>, FrameTransportError> {
        Ok(self.inbound.lock().await.recv().await)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn paired_ends_deliver_payloads_in_order() {
        let (a, b) = MockTransport::pair();
        a.send_payload(b"one".to_vec()).await.unwrap();
        a.send_payload(b"two".to_vec()).await.unwrap();
        assert_eq!(b.recv_payload().await.unwrap().unwrap(), b"one");
        assert_eq!(b.recv_payload().await.unwrap().unwrap(), b"two");
    }

    #[tokio::test]
    async fn recv_returns_none_when_peer_dropped() {
        let (a, b) = MockTransport::pair();
        drop(a);
        assert_eq!(b.recv_payload().await.unwrap(), None);
    }
}
