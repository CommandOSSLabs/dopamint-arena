//! The concrete chain backends behind one enum. `InnerAnchor` mirrors the bench's
//! private `BenchAnchorInner` but is `pub` to this crate so the staging anchor
//! (Task A8) and settle manager (Task A7) can drive either the in-memory anchor or
//! a per-tunnel-scoped sponsored Sui anchor through a single type.

use std::sync::Arc;

use sui_tunnel_anchor::{
    SuiFundingProfile, SuiOpenBatchingConfig, SuiOpenIntentAnchor, SuiOpenIntentId, SuiOpenMode,
    SuiSettleMode, SuiSponsoredAnchor, SuiSponsoredAnchorConfig,
};
use tunnel_harness::{
    InMemoryAnchor, OpenedTunnel, Seat, SettledTunnel, SettlementMode, TunnelAnchor,
    TunnelAnchorError, TunnelOpenRequest, TunnelSettleRequest,
};

use crate::swarm::gates::PreOpenGate;
use crate::swarm::settle_manager::SettleManager;

/// One tunnel's chain backend. Cloneable and cheap: both variants hold shared
/// handles (`InMemoryAnchor` is `Arc`-backed; `SuiOpenIntentAnchor` scopes a shared
/// `SuiSponsoredAnchor`).
#[derive(Clone)]
pub enum InnerAnchor {
    Memory(InMemoryAnchor),
    Sui(SuiOpenIntentAnchor),
}

impl InnerAnchor {
    /// Settlement bytes this backend requires — delegated so the driver signs the
    /// right shape (rootless v1 for memory, transcript-root v2 for Sui).
    pub fn settlement_mode(&self) -> SettlementMode {
        match self {
            Self::Memory(a) => a.settlement_mode(),
            Self::Sui(a) => a.settlement_mode(),
        }
    }

    pub async fn open(
        &self,
        request: TunnelOpenRequest,
    ) -> Result<OpenedTunnel, TunnelAnchorError> {
        match self {
            Self::Memory(a) => a.open(request).await,
            Self::Sui(a) => a.open(request).await,
        }
    }

    pub async fn settle(
        &self,
        request: TunnelSettleRequest,
    ) -> Result<SettledTunnel, TunnelAnchorError> {
        match self {
            Self::Memory(a) => a.settle(request).await,
            Self::Sui(a) => a.settle(request).await,
        }
    }
}

/// Run-level configuration for the sponsored Sui anchor. Mirrors the bench's
/// `SuiSponsoredAnchorOpts` (`rust/fleet/bench/src/cli.rs`) so a single run builds
/// one `SuiSponsoredAnchor` that every tunnel scopes via [`SuiContext::scoped`].
#[derive(Clone, Debug)]
pub struct SuiAnchorOpts {
    pub rpc_url: String,
    pub backend_url: String,
    pub package_id: String,
    pub tunnel_coin_type: String,
    pub open_mode: SuiOpenMode,
    pub settle_mode: SuiSettleMode,
    pub funding_profile: SuiFundingProfile,
    pub open_batching: SuiOpenBatchingConfig,
    pub settle_batching: SuiOpenBatchingConfig,
}

/// Run-level handle to one shared sponsored Sui anchor. Built once per run; each
/// tunnel derives its own open-intent-scoped anchor from it so open idempotency is
/// keyed per tunnel while the batch executors and gas cache stay shared.
#[derive(Clone)]
pub struct SuiContext(Arc<SuiSponsoredAnchor>);

impl SuiContext {
    /// Construct the shared anchor from run options. Mirrors
    /// `build_sui_sponsored_bench_context` (`rust/fleet/bench/src/party_driver.rs:61`);
    /// forwards both `open_batching` and `settle_batching` into the anchor config.
    pub fn build(opts: &SuiAnchorOpts) -> Result<Self, String> {
        let anchor = SuiSponsoredAnchor::new(SuiSponsoredAnchorConfig {
            rpc_url: opts.rpc_url.clone(),
            backend_url: opts.backend_url.clone(),
            package_id: opts.package_id.clone(),
            tunnel_coin_type: opts.tunnel_coin_type.clone(),
            open_mode: opts.open_mode,
            settle_mode: opts.settle_mode,
            funding_profile: opts.funding_profile.clone(),
            open_batching: opts.open_batching.clone(),
            settle_batching: opts.settle_batching.clone(),
        })
        .map_err(|err| format!("sponsored Sui anchor config: {err:?}"))?;
        Ok(Self(Arc::new(anchor)))
    }

    /// Derive the per-tunnel open-intent-scoped anchor. Mirrors
    /// `scoped_sui_anchor_for_tunnel` (`rust/fleet/bench/src/party_driver.rs:90`):
    /// the label is the tunnel id, so open idempotency is scoped per tunnel.
    pub fn scoped(&self, tunnel_id: &str) -> SuiOpenIntentAnchor {
        self.0.for_open_intent(SuiOpenIntentId::from_label(tunnel_id))
    }
}

/// The [`TunnelAnchor`] each [`PartyDriver`](tunnel_harness) in a swarm is handed.
/// It brackets one seat of one tunnel with the swarm-wide staging barriers:
/// `open` opens through the inner backend then parks on the [`PreOpenGate`] until
/// the whole swarm is open (play cannot begin until every tunnel has opened);
/// `settle` hands off to the shared [`SettleManager`], which holds every seat
/// behind the settle barrier and drains the pairs in waves. Cheap to construct —
/// it only clones shared handles — so the pipeline builds one per seat.
pub struct StagingAnchor {
    inner: Arc<InnerAnchor>,
    /// Which seat of the tunnel this anchor drives; only seat A counts the tunnel
    /// into the open gate so the barrier target matches the tunnel count.
    seat: Seat,
    open_gate: Arc<PreOpenGate>,
    settle: Arc<SettleManager>,
}

impl StagingAnchor {
    pub fn new(
        inner: Arc<InnerAnchor>,
        seat: Seat,
        open_gate: Arc<PreOpenGate>,
        settle: Arc<SettleManager>,
    ) -> Self {
        Self {
            inner,
            seat,
            open_gate,
            settle,
        }
    }
}

impl TunnelAnchor for StagingAnchor {
    fn settlement_mode(&self) -> SettlementMode {
        self.inner.settlement_mode()
    }

    async fn open(
        &self,
        request: TunnelOpenRequest,
    ) -> Result<OpenedTunnel, TunnelAnchorError> {
        let opened = self.inner.open(request).await?;
        // Open barrier: hold both seats between open and play until the whole
        // swarm is open. Seat A counts the tunnel once; both seats then park.
        // Mirrors the bench warm-up barrier (`rust/fleet/bench/src/party_driver.rs`).
        if self.seat == Seat::A {
            self.open_gate.mark_opened();
        }
        self.open_gate.wait().await;
        Ok(opened)
    }

    async fn settle(
        &self,
        request: TunnelSettleRequest,
    ) -> Result<SettledTunnel, TunnelAnchorError> {
        self.settle.submit(self.seat, request).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tunnel_core::protocol_id::ProtocolId;
    use tunnel_harness::{Balances, InMemoryAnchor, TunnelOpenRequest};

    #[tokio::test]
    async fn memory_inner_opens_and_settles() {
        let a = InnerAnchor::Memory(InMemoryAnchor::default());
        let opened = a
            .open(TunnelOpenRequest {
                protocol: ProtocolId::parse("payments.v1").unwrap(),
                party_a: [1u8; 32],
                party_b: [2u8; 32],
                initial: Balances { a: 100, b: 100 },
            })
            .await
            .unwrap();
        assert!(!opened.tunnel_id.is_empty());
    }
}
