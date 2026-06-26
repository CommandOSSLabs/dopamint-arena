//! A no-op anchor for off-chain runs: records nothing on-chain, returns fake digests.
//! The settlement it is handed is still independently verifiable by the caller.

use super::{
    Anchor, Challenge, CoSignedSettlement, DisputeEvidence, OpenParams, TunnelHandle, TxDigest,
};
use crate::AnchorError;

pub struct NoopAnchor;

impl Anchor for NoopAnchor {
    async fn open(&self, p: OpenParams) -> Result<TunnelHandle, AnchorError> {
        Ok(TunnelHandle {
            tunnel_id: p.tunnel_id,
        })
    }
    async fn settle(&self, s: &CoSignedSettlement) -> Result<TxDigest, AnchorError> {
        Ok(TxDigest(format!("noop-settle:{}", s.settlement.tunnel_id)))
    }
    async fn dispute(&self, _e: DisputeEvidence) -> Result<TxDigest, AnchorError> {
        Ok(TxDigest("noop-dispute".into()))
    }
    async fn challenge(&self, _c: Challenge) -> Result<TxDigest, AnchorError> {
        Ok(TxDigest("noop-challenge".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Balances;

    #[tokio::test]
    async fn open_echoes_tunnel_id() {
        let h = NoopAnchor
            .open(OpenParams {
                tunnel_id: "0xab".into(),
                initial: Balances { a: 1, b: 1 },
            })
            .await
            .unwrap();
        assert_eq!(h.tunnel_id, "0xab");
    }
}
