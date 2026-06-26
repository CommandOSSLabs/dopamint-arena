//! The Anchor seam: on-chain lifecycle (open / settle / dispute / challenge).
//! Protocol-agnostic: operates only on wire types (Settlement, co-signed updates).
pub mod noop;

use crate::{AnchorError, Balances};
use tunnel_core::wire::Settlement;

pub struct OpenParams {
    pub tunnel_id: String,
    pub initial: Balances,
}

pub struct TunnelHandle {
    pub tunnel_id: String,
}

/// A fully co-signed terminal settlement, ready to submit on-chain.
pub struct CoSignedSettlement {
    pub settlement: Settlement,
    pub transcript_root: [u8; 32],
    pub sig_a: [u8; 64],
    pub sig_b: [u8; 64],
}

/// A newer co-signed state submitted to beat a stale one. Wire bytes + both sigs.
pub struct DisputeEvidence {
    pub state_update_msg: Vec<u8>,
    pub sig_a: [u8; 64],
    pub sig_b: [u8; 64],
}

/// A challenge against a posted state (same shape as dispute evidence here).
pub struct Challenge {
    pub state_update_msg: Vec<u8>,
    pub sig_a: [u8; 64],
    pub sig_b: [u8; 64],
}

/// An opaque on-chain tx identifier.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TxDigest(pub String);

pub trait Anchor: Send + Sync + 'static {
    fn open(
        &self,
        p: OpenParams,
    ) -> impl std::future::Future<Output = Result<TunnelHandle, AnchorError>> + Send;

    fn settle(
        &self,
        s: &CoSignedSettlement,
    ) -> impl std::future::Future<Output = Result<TxDigest, AnchorError>> + Send;

    fn dispute(
        &self,
        e: DisputeEvidence,
    ) -> impl std::future::Future<Output = Result<TxDigest, AnchorError>> + Send;

    fn challenge(
        &self,
        c: Challenge,
    ) -> impl std::future::Future<Output = Result<TxDigest, AnchorError>> + Send;
}
