//! In-memory paired frame transport for self-play. Each end sends into the other's queue.

use super::FrameTransport;
use crate::FrameTransportError;
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver, UnboundedSender};
use tokio::sync::Mutex;

pub struct InMemoryFrameTransport {
    outbound: UnboundedSender<Vec<u8>>,
    inbound: Mutex<UnboundedReceiver<Vec<u8>>>,
}

impl InMemoryFrameTransport {
    /// Two ends wired together: a.send -> b.recv and b.send -> a.recv.
    pub fn pair() -> (InMemoryFrameTransport, InMemoryFrameTransport) {
        let (tx_ab, rx_ab) = unbounded_channel();
        let (tx_ba, rx_ba) = unbounded_channel();
        let a = InMemoryFrameTransport {
            outbound: tx_ab,
            inbound: Mutex::new(rx_ba),
        };
        let b = InMemoryFrameTransport {
            outbound: tx_ba,
            inbound: Mutex::new(rx_ab),
        };
        (a, b)
    }
}

impl FrameTransport for InMemoryFrameTransport {
    async fn send(&self, bytes: Vec<u8>) -> Result<(), FrameTransportError> {
        self.outbound
            .send(bytes)
            .map_err(|_| FrameTransportError::Closed)
    }

    async fn recv(&self) -> Result<Option<Vec<u8>>, FrameTransportError> {
        Ok(self.inbound.lock().await.recv().await)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn paired_ends_deliver_in_order() {
        let (a, b) = InMemoryFrameTransport::pair();
        a.send(b"hello".to_vec()).await.unwrap();
        a.send(b"world".to_vec()).await.unwrap();
        assert_eq!(b.recv().await.unwrap().unwrap(), b"hello");
        assert_eq!(b.recv().await.unwrap().unwrap(), b"world");
    }

    #[tokio::test]
    async fn recv_returns_none_when_peer_dropped() {
        let (a, b) = InMemoryFrameTransport::pair();
        drop(a);
        assert_eq!(b.recv().await.unwrap(), None);
    }
}
