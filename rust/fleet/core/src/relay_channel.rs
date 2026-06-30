//! `RelayChannel` — the `tunnel_harness::FrameTransport` seam over a [`RelayTransport`].
//!
//! The party runtime hands `FrameTransport::send` its already-codec-encoded inner frame bytes
//! (TS-compatible, from the default `JsonFrameCodec`). We wrap them in the relay envelope
//! ([`crate::relay_envelope`]) before the transport forwards them, and unwrap on the way back.
//! No frame-field translation — the codec already speaks the TS wire.

use crate::relay_envelope;
use crate::relay_ws::RelayTransport;
use tunnel_harness::{FrameTransport, FrameTransportError};

pub struct RelayChannel<T: RelayTransport> {
    transport: T,
}

impl<T: RelayTransport> RelayChannel<T> {
    pub fn new(transport: T) -> RelayChannel<T> {
        RelayChannel { transport }
    }
}

impl<T: RelayTransport> FrameTransport for RelayChannel<T> {
    async fn send(&self, bytes: Vec<u8>) -> Result<(), FrameTransportError> {
        let payload = relay_envelope::wrap(&bytes)
            .map_err(|e| FrameTransportError::Transport(format!("relay wrap: {e}")))?;
        self.transport.send_payload(payload.into_bytes()).await
    }

    async fn recv(&self) -> Result<Option<Vec<u8>>, FrameTransportError> {
        match self.transport.recv_payload().await? {
            Some(payload) => {
                let inner = relay_envelope::unwrap(&payload)
                    .map_err(|e| FrameTransportError::Transport(format!("relay unwrap: {e}")))?;
                Ok(Some(inner))
            }
            None => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::relay_ws::MockTransport;

    // An inner frame (TS-format bytes, as the codec emits) survives the relay round-trip:
    // wrapped into the envelope on send, unwrapped back to identical bytes on recv.
    #[tokio::test]
    async fn an_inner_frame_survives_the_relay_round_trip() {
        let (ta, tb) = MockTransport::pair();
        let ca = RelayChannel::new(ta);
        let cb = RelayChannel::new(tb);

        let inner = br#"{"kind":"move","nonce":"3","by":"B","move":{"action":"stand"}}"#.to_vec();
        ca.send(inner.clone()).await.unwrap();
        assert_eq!(cb.recv().await.unwrap().unwrap(), inner);
    }

    #[tokio::test]
    async fn recv_yields_none_when_transport_closes() {
        let (ta, tb) = MockTransport::pair();
        let cb = RelayChannel::new(tb);
        drop(ta);
        assert_eq!(cb.recv().await.unwrap(), None);
    }
}
