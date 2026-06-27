//! The on-chain seam for a bot match: open/fund/activate the tunnel and submit the cooperative
//! settle. The #98 engine is sans-IO and has no `Anchor` trait, so the bot owns this boundary.
//!
//! Per the FE flow: role B (dealer) opens+funds the shared tunnel and announces it; role A
//! deposits; play is gated on on-chain activation; role B submits the co-signed settle. A real
//! `SuiAnchor` (reusing tunnel-manager's `sui.rs`, gas-sponsored via Enoki) implements this for
//! real stakes; [`NoopAnchor`] is the off-chain/exhibition stand-in that lets the transport
//! orchestration run end-to-end without touching the chain.

use anyhow::Result;

use crate::Role;

/// What the dealer's open produced (or, for the player, what it learned via the `opened` peer
/// message): the on-chain tunnel id used in the signed state-update.
#[derive(Debug, Clone)]
pub struct OpenedTunnel {
    pub tunnel_id: String,
}

/// The on-chain lifecycle a bot match depends on. All methods are async (real impls hit Sui RPC).
pub trait MatchAnchor: Send + Sync {
    /// Role B only: create+fund the shared tunnel for `(my, opponent)` ephemeral pubkeys and
    /// return its id. Role A never calls this — it receives the id via the `opened` peer message.
    fn open_as_dealer(
        &self,
        my_eph_pubkey: [u8; 32],
        opp_eph_pubkey: [u8; 32],
        opponent_wallet: &str,
    ) -> impl std::future::Future<Output = Result<OpenedTunnel>> + Send;

    /// Both roles: ensure our stake is deposited and the tunnel is active before play. Role A
    /// deposits here; role B already funded both sides at open. Resolves once active.
    fn fund_and_await_active(
        &self,
        tunnel_id: &str,
        role: Role,
    ) -> impl std::future::Future<Output = Result<()>> + Send;

    /// Role B only: submit the co-signed cooperative settle on-chain, returning the tx digest.
    fn settle(
        &self,
        tunnel_id: &str,
        co_signed: &[u8],
    ) -> impl std::future::Future<Output = Result<String>> + Send;
}

/// Off-chain stand-in: no chain calls. The dealer's "open" mints a deterministic dummy tunnel id
/// (valid hex, so the signed state-update encodes), activation is instant, settle is a no-op.
/// Lets two bots play a full co-signed match over the relay protocol without real stakes.
pub struct NoopAnchor;

impl MatchAnchor for NoopAnchor {
    async fn open_as_dealer(
        &self,
        _my_eph_pubkey: [u8; 32],
        _opp_eph_pubkey: [u8; 32],
        _opponent_wallet: &str,
    ) -> Result<OpenedTunnel> {
        Ok(OpenedTunnel {
            tunnel_id: "0xab".into(),
        })
    }

    async fn fund_and_await_active(&self, _tunnel_id: &str, _role: Role) -> Result<()> {
        Ok(())
    }

    async fn settle(&self, tunnel_id: &str, _co_signed: &[u8]) -> Result<String> {
        Ok(format!("noop-settle:{tunnel_id}"))
    }
}
