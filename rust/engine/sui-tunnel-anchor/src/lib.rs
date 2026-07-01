use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::str::FromStr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use base64::Engine as _;
use bech32::FromBase32;
use serde::{Deserialize, Serialize};
use sui_crypto::ed25519::Ed25519PrivateKey;
use sui_crypto::SuiSigner;
use sui_rpc::client::{Client as GrpcClient, ResponseExt};
use sui_rpc::field::{FieldMask, FieldMaskUtil};
use sui_rpc::proto::sui::rpc::v2::{
    ExecuteTransactionRequest, GetEpochRequest, GetObjectRequest, GetTransactionRequest,
    Transaction as ProtoTransaction, UserSignature as ProtoUserSignature,
};
use sui_sdk_types::{
    Address, Argument, Command, Digest, Ed25519PublicKey, ExecutionStatus, FundsWithdrawal,
    GasPayment, Identifier, Input, MoveCall, Object, ObjectOut, ObjectReference, ObjectType, Owner,
    ProgrammableTransaction, SharedInput, SplitCoins, StructTag, Transaction, TransactionEffects,
    TransactionExpiration, TransactionKind, TypeTag, UserSignature, WithdrawFrom,
};
use tokio::sync::{mpsc, oneshot};
use tunnel_core::crypto::{blake2b256, verify};
use tunnel_core::wire::{encode_settle_body, SettleBodyEntry, Settlement};
use tunnel_harness::{
    Balances, OpenedTunnel, Seat, SettledTunnel, SettlementMode, TunnelAnchor, TunnelAnchorError,
    TunnelOpenRequest, TunnelSettleRequest,
};

const SUI_PRIVATE_KEY_HRP: &str = "suiprivkey";
const ED25519_SCHEME_FLAG: u8 = 0x00;
const CLOCK_ADDRESS: &str = "0x0000000000000000000000000000000000000000000000000000000000000006";
const DEFAULT_TIMEOUT_MS: u64 = 600_000;
const MAX_SPONSORED_OPEN_BATCH_SIZE: usize = 255;
const MAX_SPONSORED_SETTLE_BATCH_SIZE: usize = 681;
const DEFAULT_DIRECT_GAS_BUDGET_MIST: u64 = 1_000_000_000;

/// Accumulated gas spend (MIST) split by who paid: the funder wallet
/// (`SingleFunder`) or the backend sponsor.
#[derive(Debug, Default)]
struct CostMeter {
    gas_funder_mist: AtomicU64,
    gas_sponsor_mist: AtomicU64,
}

impl CostMeter {
    fn add(&self, paid_by_funder: bool, mist: u64) {
        if paid_by_funder {
            self.gas_funder_mist.fetch_add(mist, Ordering::Relaxed);
        } else {
            self.gas_sponsor_mist.fetch_add(mist, Ordering::Relaxed);
        }
    }

    fn snapshot(&self) -> AnchorCostSnapshot {
        AnchorCostSnapshot {
            gas_funder_mist: self.gas_funder_mist.load(Ordering::Relaxed),
            gas_sponsor_mist: self.gas_sponsor_mist.load(Ordering::Relaxed),
        }
    }
}

/// Point-in-time view of cumulative gas spend on a `SuiSponsoredAnchor`.
#[derive(Clone, Copy, Debug, Default)]
pub struct AnchorCostSnapshot {
    /// MIST charged to the funder wallet (open transactions when
    /// `SuiFundingProfile::SingleFunder` pays).
    pub gas_funder_mist: u64,
    /// MIST charged to the backend sponsor (all settle transactions and open
    /// transactions paid by the sponsor).
    pub gas_sponsor_mist: u64,
}

/// Net MIST consumed by a transaction: computation + storage − rebate.
fn net_gas_mist(effects: &TransactionEffects) -> u64 {
    let g = effects.gas_summary();
    (g.computation_cost + g.storage_cost).saturating_sub(g.storage_rebate)
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SuiOpenBatchingConfig {
    pub enabled: bool,
    pub max_batch_size: usize,
    pub flush_interval_ms: u64,
}

impl Default for SuiOpenBatchingConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            max_batch_size: MAX_SPONSORED_OPEN_BATCH_SIZE,
            flush_interval_ms: 250,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SuiStakeSource {
    CoinObject { coin_id: String },
    AddressBalance,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SuiOpenMode {
    SponsoredCreateAndFund,
    DirectCreateAndFund,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SuiSettleMode {
    BackendSettle,
    SponsoredSettle,
    DirectSettle,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SuiFundingProfile {
    SingleFunder {
        priv_key: String,
        stake_source: SuiStakeSource,
    },
}

impl SuiFundingProfile {
    fn single_funder_priv_key(&self) -> &str {
        match self {
            SuiFundingProfile::SingleFunder { priv_key, .. } => priv_key,
        }
    }

    fn stake_source(&self) -> &SuiStakeSource {
        match self {
            SuiFundingProfile::SingleFunder { stake_source, .. } => stake_source,
        }
    }
}

#[derive(Clone, Debug)]
pub struct SuiSponsoredAnchorConfig {
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

#[derive(Clone)]
pub struct SuiSponsoredAnchor {
    config: SuiSponsoredAnchorConfig,
    funder: Ed25519PrivateKey,
    funder_address: Address,
    chain: Arc<dyn SuiChainClient>,
    backend: Arc<dyn SuiBackendClient>,
    inner: Arc<Mutex<AnchorState>>,
    open_batch_executor: Option<SuiOpenBatchExecutor>,
    settle_batch_executor: Option<SuiSettleBatchExecutor>,
    cost: Arc<CostMeter>,
    direct_tx_nonce: Arc<AtomicU64>,
}

/// Stable pre-chain identity for one open intent. The confirmed Sui `tunnel_id`
/// remains the canonical settlement id; this only scopes open idempotency.
#[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
pub struct SuiOpenIntentId([u8; 32]);

impl SuiOpenIntentId {
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub fn from_label(label: impl AsRef<[u8]>) -> Self {
        Self(blake2b256(label.as_ref()))
    }
}

#[derive(Clone)]
pub struct SuiOpenIntentAnchor {
    inner: Arc<SuiSponsoredAnchor>,
    intent_id: SuiOpenIntentId,
}

impl SuiOpenIntentAnchor {
    pub fn intent_id(&self) -> SuiOpenIntentId {
        self.intent_id
    }
}

#[derive(Clone)]
struct SuiSponsoredAnchorShared {
    config: SuiSponsoredAnchorConfig,
    funder: Ed25519PrivateKey,
    funder_address: Address,
    chain: Arc<dyn SuiChainClient>,
    backend: Arc<dyn SuiBackendClient>,
    inner: Arc<Mutex<AnchorState>>,
    cost: Arc<CostMeter>,
    direct_tx_nonce: Arc<AtomicU64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AddressBalanceGasContext {
    pub reference_gas_price: u64,
    pub epoch: u64,
    pub chain_id: Digest,
}

#[derive(Default)]
struct AnchorState {
    opens: HashMap<OpenKey, OpenRecord>,
    pending_settles: HashMap<String, PendingSettle>,
    settled: HashMap<String, SettledTunnel>,
}

#[derive(Clone, Hash, PartialEq, Eq)]
struct OpenKey {
    intent_id: SuiOpenIntentId,
}

#[derive(Clone, Hash, PartialEq, Eq)]
struct OpenPartyIdentity {
    party_a_address: Address,
    party_a_public_key: [u8; 32],
    party_a_signature_type: u8,
    party_b_address: Address,
    party_b_public_key: [u8; 32],
    party_b_signature_type: u8,
}

impl OpenPartyIdentity {
    fn from_request(request: &TunnelOpenRequest) -> Self {
        Self {
            party_a_address: Ed25519PublicKey::new(request.party_a).derive_address(),
            party_a_public_key: request.party_a,
            party_a_signature_type: ED25519_SCHEME_FLAG,
            party_b_address: Ed25519PublicKey::new(request.party_b).derive_address(),
            party_b_public_key: request.party_b,
            party_b_signature_type: ED25519_SCHEME_FLAG,
        }
    }
}

#[derive(Clone)]
struct OpenRecord {
    tunnel_id: String,
    party_a: [u8; 32],
    party_b: [u8; 32],
    onchain_nonce: u64,
    created_at_ms: u64,
    request: OpenRequestFingerprint,
}

#[derive(Clone, PartialEq, Eq)]
struct OpenRequestFingerprint {
    protocol: String,
    party_a: [u8; 32],
    party_b: [u8; 32],
    initial: Balances,
}

impl OpenRequestFingerprint {
    fn from_request(request: &TunnelOpenRequest) -> Self {
        Self {
            protocol: request.protocol.as_str().to_string(),
            party_a: request.party_a,
            party_b: request.party_b,
            initial: request.initial,
        }
    }
}

struct PendingSettle {
    request: TunnelSettleRequest,
    responder: oneshot::Sender<Result<SettledTunnel, TunnelAnchorError>>,
}

struct OpenBatchItem {
    key: OpenKey,
    request: TunnelOpenRequest,
    responder: oneshot::Sender<Result<OpenedTunnel, TunnelAnchorError>>,
    enqueued_at: Instant,
}

#[derive(Clone)]
struct PreparedSettle {
    tunnel_id: String,
    party_a_balance: u64,
    party_b_balance: u64,
    timestamp: u64,
    root: [u8; 32],
    sig_a: [u8; 64],
    sig_b: [u8; 64],
}

struct SettleBatchItem {
    prepared: PreparedSettle,
    responder: oneshot::Sender<Result<SettledTunnel, TunnelAnchorError>>,
    enqueued_at: Instant,
}

struct OpenBatchGroup {
    key: OpenKey,
    request: TunnelOpenRequest,
    responders: Vec<oneshot::Sender<Result<OpenedTunnel, TunnelAnchorError>>>,
}

enum OpenBatchAttemptError {
    Retryable(TunnelAnchorError),
    Final(TunnelAnchorError),
}

fn open_batch_attempt_error(error: TunnelAnchorError) -> OpenBatchAttemptError {
    match error {
        TunnelAnchorError::Unavailable(_) => OpenBatchAttemptError::Retryable(error),
        _ => OpenBatchAttemptError::Final(error),
    }
}

#[derive(Clone)]
struct SuiOpenBatchExecutor {
    sender: mpsc::UnboundedSender<OpenBatchItem>,
}

#[derive(Clone)]
struct SuiSettleBatchExecutor {
    sender: mpsc::UnboundedSender<SettleBatchItem>,
}

#[async_trait]
pub trait SuiChainClient: Send + Sync {
    async fn get_object_ref(&self, object_id: Address) -> Result<ObjectReference, String>;
    async fn get_object(&self, object_id: Address) -> Result<Option<Object>, String>;
    async fn address_balance_gas_context(&self) -> Result<AddressBalanceGasContext, String>;
    async fn execute_transaction(
        &self,
        transaction: &Transaction,
        signatures: &[UserSignature],
    ) -> Result<TransactionEffects, String>;
    async fn get_transaction_effects(
        &self,
        digest: &str,
    ) -> Result<Option<TransactionEffects>, String>;
    async fn get_transaction_timestamp_ms(&self, digest: &str) -> Result<Option<u64>, String>;
}

#[async_trait]
pub trait SuiBackendClient: Send + Sync {
    async fn sponsor_open(
        &self,
        sender: String,
        tx_kind_bytes: String,
    ) -> Result<SponsorResponse, TunnelAnchorError>;
    async fn execute_enoki(
        &self,
        digest: String,
        signature: String,
    ) -> Result<String, TunnelAnchorError>;
    async fn settle(
        &self,
        tunnel_id: String,
        body: Vec<u8>,
    ) -> Result<SettleResponse, TunnelAnchorError>;
}

pub struct HttpSuiBackendClient {
    base_url: String,
    http: reqwest::Client,
}

impl HttpSuiBackendClient {
    pub fn new(base_url: &str) -> Self {
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            http: reqwest::Client::new(),
        }
    }
}

#[async_trait]
impl SuiBackendClient for HttpSuiBackendClient {
    async fn sponsor_open(
        &self,
        sender: String,
        tx_kind_bytes: String,
    ) -> Result<SponsorResponse, TunnelAnchorError> {
        let url = format!("{}/v1/sponsor", self.base_url);
        let resp = self
            .http
            .post(url)
            .json(&SponsorRequest {
                sender,
                tx_kind_bytes,
            })
            .send()
            .await
            .map_err(|e| TunnelAnchorError::Unavailable(e.to_string()))?;
        read_json_response(resp, "sponsor").await
    }

    async fn execute_enoki(
        &self,
        digest: String,
        signature: String,
    ) -> Result<String, TunnelAnchorError> {
        let url = format!("{}/v1/sponsor/execute", self.base_url);
        let resp = self
            .http
            .post(url)
            .json(&SponsorExecuteRequest { digest, signature })
            .send()
            .await
            .map_err(|e| TunnelAnchorError::Unavailable(e.to_string()))?;
        let body: SponsorExecuteResponse = read_json_response(resp, "sponsor execute").await?;
        Ok(body.digest)
    }

    async fn settle(
        &self,
        tunnel_id: String,
        body: Vec<u8>,
    ) -> Result<SettleResponse, TunnelAnchorError> {
        let url = format!("{}/v1/tunnels/{}/settle", self.base_url, tunnel_id);
        let resp = self
            .http
            .post(url)
            .header("content-type", "application/octet-stream")
            .body(body)
            .send()
            .await
            .map_err(|e| TunnelAnchorError::Unavailable(e.to_string()))?;
        read_json_response(resp, "settle").await
    }
}

/// Chain client backed by the Sui gRPC fullnode API (`sui-rpc`).
///
/// The anchor only issues point lookups (object refs, single objects, single
/// transactions) and transaction execution — no aggregate queries — so the gRPC
/// `LedgerService`/`TransactionExecutionService` cover every call directly. The
/// tonic `Client` is cheap to clone (channel is `Arc`-backed), so each `&self`
/// call clones it to obtain the `&mut` service stub it needs.
pub struct GrpcSuiChainClient {
    endpoint: String,
    // Built lazily on first call: the anchor is constructed outside any Tokio
    // runtime (the bench's `main` is sync), but every chain call runs inside one,
    // and the tonic channel must be created under a runtime. One `OnceCell` keeps
    // `new` runtime-free while still reusing a single channel across calls.
    client: tokio::sync::OnceCell<GrpcClient>,
}

impl GrpcSuiChainClient {
    pub fn new(endpoint: &str) -> Result<Self, String> {
        Ok(Self {
            endpoint: endpoint.to_string(),
            client: tokio::sync::OnceCell::new(),
        })
    }

    async fn client(&self) -> Result<GrpcClient, String> {
        self.client
            .get_or_try_init(|| async {
                GrpcClient::new(self.endpoint.clone()).map_err(|e| e.to_string())
            })
            .await
            .cloned()
    }
}

#[async_trait]
impl SuiChainClient for GrpcSuiChainClient {
    async fn get_object_ref(&self, object_id: Address) -> Result<ObjectReference, String> {
        // Default read mask is `object_id,version,digest` — exactly an ObjectReference.
        let response = self
            .client()
            .await?
            .ledger_client()
            .get_object(GetObjectRequest::new(&object_id))
            .await
            .map_err(|status| status.to_string())?
            .into_inner();
        let object = response
            .object_opt()
            .ok_or_else(|| format!("object {object_id} not found"))?;
        let version = object
            .version_opt()
            .ok_or_else(|| format!("object {object_id} missing version"))?;
        let digest = object
            .digest_opt()
            .ok_or_else(|| format!("object {object_id} missing digest"))?
            .parse()
            .map_err(|e| format!("{e}"))?;
        Ok(ObjectReference::new(object_id, version, digest))
    }

    async fn get_object(&self, object_id: Address) -> Result<Option<Object>, String> {
        let request = GetObjectRequest::new(&object_id).with_read_mask(FieldMask::from_paths([
            "object_id",
            "version",
            "digest",
            "owner",
            "object_type",
            "has_public_transfer",
            "contents",
            "previous_transaction",
            "storage_rebate",
            "bcs",
        ]));
        let response = match self
            .client()
            .await?
            .ledger_client()
            .get_object(request)
            .await
        {
            Ok(response) => response.into_inner(),
            Err(status) if status.code() == tonic::Code::NotFound => return Ok(None),
            Err(status) => return Err(status.to_string()),
        };
        let Some(object) = response.object_opt() else {
            return Ok(None);
        };
        let object = Object::try_from(object).map_err(|e| format!("{e}"))?;
        Ok(Some(object))
    }

    async fn address_balance_gas_context(&self) -> Result<AddressBalanceGasContext, String> {
        let request = GetEpochRequest::latest()
            .with_read_mask(FieldMask::from_paths(["epoch", "reference_gas_price"]));
        let response = self
            .client()
            .await?
            .ledger_client()
            .get_epoch(request)
            .await
            .map_err(|status| status.to_string())?;
        let chain_id = response
            .chain_id()
            .ok_or_else(|| "get_epoch response missing chain id".to_string())?;
        let header_epoch = response.epoch();
        let epoch = response.into_inner().epoch;
        let epoch = epoch.ok_or_else(|| "get_epoch response missing epoch".to_string())?;
        Ok(AddressBalanceGasContext {
            reference_gas_price: epoch
                .reference_gas_price_opt()
                .ok_or_else(|| "get_epoch response missing reference gas price".to_string())?,
            epoch: epoch
                .epoch_opt()
                .or(header_epoch)
                .ok_or_else(|| "get_epoch response missing current epoch number".to_string())?,
            chain_id,
        })
    }

    async fn execute_transaction(
        &self,
        transaction: &Transaction,
        signatures: &[UserSignature],
    ) -> Result<TransactionEffects, String> {
        let request = ExecuteTransactionRequest::new(ProtoTransaction::from(transaction.clone()))
            .with_signatures(
                signatures
                    .iter()
                    .cloned()
                    .map(ProtoUserSignature::from)
                    .collect::<Vec<_>>(),
            )
            .with_read_mask(FieldMask::from_paths(["effects", "checkpoint"]));
        // Wait for checkpoint inclusion (read-your-writes): the open flow then
        // reads this tx's checkpoint timestamp and its created objects by id,
        // which only become visible once the tx is checkpointed on this node.
        // Mirrors the finality wait the prior GraphQL client performed; raw
        // `execute_transaction` returns pre-checkpoint and would race those reads.
        let response = self
            .client()
            .await?
            .execute_transaction_and_wait_for_checkpoint(
                request,
                Duration::from_millis(DEFAULT_TIMEOUT_MS),
            )
            .await
            .map_err(|e| e.to_string())?
            .into_inner();
        let effects = response
            .transaction_opt()
            .and_then(|tx| tx.effects_opt())
            .ok_or_else(|| "grpc execute returned no effects".to_string())?;
        TransactionEffects::try_from(effects).map_err(|e| format!("{e}"))
    }

    async fn get_transaction_effects(
        &self,
        digest: &str,
    ) -> Result<Option<TransactionEffects>, String> {
        let digest: Digest = digest.parse().map_err(|e| format!("{e}"))?;
        let request =
            GetTransactionRequest::new(&digest).with_read_mask(FieldMask::from_paths(["effects"]));
        let response = match self
            .client()
            .await?
            .ledger_client()
            .get_transaction(request)
            .await
        {
            Ok(response) => response.into_inner(),
            Err(status) if status.code() == tonic::Code::NotFound => return Ok(None),
            Err(status) => return Err(status.to_string()),
        };
        let Some(effects) = response.transaction_opt().and_then(|tx| tx.effects_opt()) else {
            return Ok(None);
        };
        Ok(Some(
            TransactionEffects::try_from(effects).map_err(|e| format!("{e}"))?,
        ))
    }

    async fn get_transaction_timestamp_ms(&self, digest: &str) -> Result<Option<u64>, String> {
        let digest: Digest = digest.parse().map_err(|e| format!("{e}"))?;
        let request = GetTransactionRequest::new(&digest)
            .with_read_mask(FieldMask::from_paths(["timestamp"]));
        let response = match self
            .client()
            .await?
            .ledger_client()
            .get_transaction(request)
            .await
        {
            Ok(response) => response.into_inner(),
            Err(status) if status.code() == tonic::Code::NotFound => return Ok(None),
            Err(status) => return Err(status.to_string()),
        };
        let Some(timestamp) = response.transaction_opt().and_then(|tx| tx.timestamp_opt()) else {
            return Ok(None);
        };
        let millis =
            timestamp.seconds.max(0) as u64 * 1_000 + (timestamp.nanos.max(0) as u64) / 1_000_000;
        Ok(Some(millis))
    }
}

impl SuiSponsoredAnchorShared {
    fn anchor_for_executor(&self) -> SuiSponsoredAnchor {
        let mut config = self.config.clone();
        config.open_batching.enabled = false;
        SuiSponsoredAnchor {
            config,
            funder: self.funder.clone(),
            funder_address: self.funder_address,
            chain: self.chain.clone(),
            backend: self.backend.clone(),
            inner: self.inner.clone(),
            open_batch_executor: None,
            settle_batch_executor: None,
            cost: self.cost.clone(),
            direct_tx_nonce: self.direct_tx_nonce.clone(),
        }
    }

    async fn flush_open_batch(&self, items: Vec<OpenBatchItem>) {
        self.anchor_for_executor().execute_open_batch(items).await;
    }

    async fn flush_settle_batch(&self, items: Vec<SettleBatchItem>) {
        self.anchor_for_executor().execute_settle_batch(items).await;
    }
}

impl SuiOpenBatchExecutor {
    fn new(shared: SuiSponsoredAnchorShared) -> Result<Self, TunnelAnchorError> {
        let (sender, receiver) = mpsc::unbounded_channel();
        std::thread::Builder::new()
            .name("sui-open-batch-executor".into())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("build Sui open batch runtime");
                runtime.block_on(run_open_batch_worker(shared, receiver));
            })
            .map_err(|e| {
                TunnelAnchorError::Unavailable(format!("start open batch executor: {e}"))
            })?;
        Ok(Self { sender })
    }

    async fn submit(
        &self,
        key: OpenKey,
        request: TunnelOpenRequest,
    ) -> Result<OpenedTunnel, TunnelAnchorError> {
        let (responder, receiver) = oneshot::channel();
        self.sender
            .send(OpenBatchItem {
                key,
                request,
                responder,
                enqueued_at: Instant::now(),
            })
            .map_err(|_| TunnelAnchorError::Unavailable("open batch executor stopped".into()))?;
        receiver.await.unwrap_or_else(|_| {
            Err(TunnelAnchorError::Unavailable(
                "open batch executor stopped".into(),
            ))
        })
    }
}

impl SuiSettleBatchExecutor {
    fn new(shared: SuiSponsoredAnchorShared) -> Result<Self, TunnelAnchorError> {
        let (sender, receiver) = mpsc::unbounded_channel();
        std::thread::Builder::new()
            .name("sui-settle-batch-executor".into())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("build Sui settle batch runtime");
                runtime.block_on(run_settle_batch_worker(shared, receiver));
            })
            .map_err(|e| {
                TunnelAnchorError::Unavailable(format!("start settle batch executor: {e}"))
            })?;
        Ok(Self { sender })
    }

    async fn submit(&self, prepared: PreparedSettle) -> Result<SettledTunnel, TunnelAnchorError> {
        let (responder, receiver) = oneshot::channel();
        self.sender
            .send(SettleBatchItem {
                prepared,
                responder,
                enqueued_at: Instant::now(),
            })
            .map_err(|_| TunnelAnchorError::Unavailable("settle batch executor stopped".into()))?;
        receiver.await.unwrap_or_else(|_| {
            Err(TunnelAnchorError::Unavailable(
                "settle batch executor stopped".into(),
            ))
        })
    }
}

async fn run_open_batch_worker(
    shared: SuiSponsoredAnchorShared,
    mut receiver: mpsc::UnboundedReceiver<OpenBatchItem>,
) {
    let mut pending = Vec::new();
    let max_batch_size = shared.config.open_batching.max_batch_size.max(1);

    loop {
        if pending.is_empty() {
            let Some(item) = receiver.recv().await else {
                break;
            };
            pending.push(item);
        }

        if pending.len() >= max_batch_size {
            shared.flush_open_batch(std::mem::take(&mut pending)).await;
            continue;
        }

        let deadline = open_batch_deadline(&pending, &shared.config.open_batching);
        tokio::select! {
            maybe_item = receiver.recv() => {
                match maybe_item {
                    Some(item) => pending.push(item),
                    None => {
                        shared.flush_open_batch(std::mem::take(&mut pending)).await;
                        break;
                    }
                }
            }
            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => {
                shared.flush_open_batch(std::mem::take(&mut pending)).await;
            }
        }
    }
}

async fn run_settle_batch_worker(
    shared: SuiSponsoredAnchorShared,
    mut receiver: mpsc::UnboundedReceiver<SettleBatchItem>,
) {
    let mut pending = Vec::new();
    let max_batch_size = shared.config.settle_batching.max_batch_size.max(1);

    loop {
        if pending.is_empty() {
            let Some(item) = receiver.recv().await else {
                break;
            };
            pending.push(item);
        }

        if pending.len() >= max_batch_size {
            shared
                .flush_settle_batch(std::mem::take(&mut pending))
                .await;
            continue;
        }

        let deadline = settle_batch_deadline(&pending, &shared.config.settle_batching);
        tokio::select! {
            maybe_item = receiver.recv() => {
                match maybe_item {
                    Some(item) => pending.push(item),
                    None => {
                        shared.flush_settle_batch(std::mem::take(&mut pending)).await;
                        break;
                    }
                }
            }
            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)) => {
                shared.flush_settle_batch(std::mem::take(&mut pending)).await;
            }
        }
    }
}

fn open_batch_deadline(items: &[OpenBatchItem], config: &SuiOpenBatchingConfig) -> Instant {
    let newest = items
        .iter()
        .map(|item| item.enqueued_at)
        .max()
        .unwrap_or_else(Instant::now);
    newest + Duration::from_millis(config.flush_interval_ms)
}

fn settle_batch_deadline(items: &[SettleBatchItem], config: &SuiOpenBatchingConfig) -> Instant {
    let newest = items
        .iter()
        .map(|item| item.enqueued_at)
        .max()
        .unwrap_or_else(Instant::now);
    newest + Duration::from_millis(config.flush_interval_ms)
}

fn send_open_group_result(
    responders: Vec<oneshot::Sender<Result<OpenedTunnel, TunnelAnchorError>>>,
    result: Result<OpenedTunnel, TunnelAnchorError>,
) {
    match result {
        Ok(opened) => {
            let tunnel_id = opened.tunnel_id.clone();
            let onchain_nonce = opened.onchain_nonce;
            let created_at_ms = opened.created_at_ms;
            let mut responders = responders.into_iter();
            if let Some(responder) = responders.next() {
                let _ = responder.send(Ok(opened));
            }
            for responder in responders {
                let _ = responder.send(Ok(OpenedTunnel {
                    tunnel_id: tunnel_id.clone(),
                    onchain_nonce,
                    created_at_ms,
                    created: false,
                }));
            }
        }
        Err(error) => {
            for responder in responders {
                let _ = responder.send(Err(error.clone()));
            }
        }
    }
}

fn clone_open_request(request: &TunnelOpenRequest) -> TunnelOpenRequest {
    TunnelOpenRequest {
        protocol: request.protocol.clone(),
        party_a: request.party_a,
        party_b: request.party_b,
        initial: request.initial,
    }
}

impl SuiSponsoredAnchor {
    pub fn new(config: SuiSponsoredAnchorConfig) -> Result<Self, TunnelAnchorError> {
        let chain =
            GrpcSuiChainClient::new(&config.rpc_url).map_err(TunnelAnchorError::Unavailable)?;
        let backend = HttpSuiBackendClient::new(&config.backend_url);
        Self::with_clients(config, Arc::new(chain), Arc::new(backend))
    }

    pub fn with_chain(
        config: SuiSponsoredAnchorConfig,
        chain: Arc<dyn SuiChainClient>,
    ) -> Result<Self, TunnelAnchorError> {
        let backend = HttpSuiBackendClient::new(&config.backend_url);
        Self::with_clients(config, chain, Arc::new(backend))
    }

    pub fn with_clients(
        config: SuiSponsoredAnchorConfig,
        chain: Arc<dyn SuiChainClient>,
        backend: Arc<dyn SuiBackendClient>,
    ) -> Result<Self, TunnelAnchorError> {
        let funder =
            decode_sui_ed25519_bech32_private_key(config.funding_profile.single_funder_priv_key())
                .map_err(TunnelAnchorError::Rejected)?;
        let funder_address = funder.public_key().derive_address();
        let inner = Arc::new(Mutex::new(AnchorState::default()));
        let cost = Arc::new(CostMeter::default());
        let direct_tx_nonce = Arc::new(AtomicU64::new(0));
        let shared = SuiSponsoredAnchorShared {
            config: config.clone(),
            funder: funder.clone(),
            funder_address,
            chain: chain.clone(),
            backend: backend.clone(),
            inner: inner.clone(),
            cost: cost.clone(),
            direct_tx_nonce: direct_tx_nonce.clone(),
        };
        let open_batch_executor = if config.open_batching.enabled {
            Some(SuiOpenBatchExecutor::new(shared.clone())?)
        } else {
            None
        };
        let settle_batch_executor = if config.settle_batching.enabled
            && config.settle_mode != SuiSettleMode::BackendSettle
        {
            Some(SuiSettleBatchExecutor::new(shared)?)
        } else {
            None
        };
        Ok(Self {
            config,
            funder,
            funder_address,
            chain,
            backend,
            inner,
            open_batch_executor,
            settle_batch_executor,
            cost,
            direct_tx_nonce,
        })
    }

    pub fn funder_address(&self) -> Address {
        self.funder_address
    }

    /// Returns a point-in-time snapshot of cumulative gas spend.
    pub fn cost_snapshot(&self) -> AnchorCostSnapshot {
        self.cost.snapshot()
    }

    pub fn for_open_intent(self: &Arc<Self>, intent_id: SuiOpenIntentId) -> SuiOpenIntentAnchor {
        SuiOpenIntentAnchor {
            inner: self.clone(),
            intent_id,
        }
    }

    fn open_gas_paid_by_funder(&self) -> bool {
        matches!(self.config.open_mode, SuiOpenMode::DirectCreateAndFund)
    }

    fn settle_gas_paid_by_funder(&self) -> bool {
        matches!(self.config.settle_mode, SuiSettleMode::DirectSettle)
    }

    async fn open_with_intent(
        &self,
        intent_id: SuiOpenIntentId,
        request: TunnelOpenRequest,
    ) -> Result<OpenedTunnel, TunnelAnchorError> {
        let key = OpenKey { intent_id };
        if let Some(opened) = self.cached_open(&key, &request)? {
            return Ok(opened);
        }

        if self.config.open_batching.enabled {
            let executor = self.open_batch_executor.as_ref().ok_or_else(|| {
                TunnelAnchorError::Unavailable("open batch executor stopped".into())
            })?;
            return executor.submit(key, request).await;
        }

        self.open_single_uncached(key, request).await
    }

    async fn open_single_uncached(
        &self,
        key: OpenKey,
        request: TunnelOpenRequest,
    ) -> Result<OpenedTunnel, TunnelAnchorError> {
        let kind = self.build_open_kind_for_config(&request).await?;
        let effects = self.execute_open_kind(kind).await?;
        self.cost
            .add(self.open_gas_paid_by_funder(), net_gas_mist(&effects));
        let (tunnel_id, created_at_ms) = self.opened_from_effects(&effects).await?;
        let record = OpenRecord {
            tunnel_id: tunnel_id.clone(),
            party_a: request.party_a,
            party_b: request.party_b,
            onchain_nonce: 0,
            created_at_ms,
            request: OpenRequestFingerprint::from_request(&request),
        };
        self.inner.lock().unwrap().opens.insert(key, record);
        Ok(OpenedTunnel {
            tunnel_id,
            onchain_nonce: 0,
            created_at_ms: Some(created_at_ms),
            created: true,
        })
    }

    async fn execute_open_batch(&self, items: Vec<OpenBatchItem>) {
        let started = Instant::now();
        tracing::debug!(items = items.len(), "sui open batch start");
        let mut uncached_items = Vec::new();
        for item in items {
            match self.cached_open(&item.key, &item.request) {
                Ok(Some(opened)) => {
                    let _ = item.responder.send(Ok(opened));
                }
                Ok(None) => uncached_items.push(item),
                Err(error) => {
                    let _ = item.responder.send(Err(error));
                }
            }
        }

        if uncached_items.is_empty() {
            tracing::debug!(
                elapsed_ms = started.elapsed().as_millis(),
                "sui open batch satisfied from cache"
            );
            return;
        }

        let mut groups: Vec<OpenBatchGroup> = Vec::new();
        let mut group_indexes: HashMap<OpenKey, usize> = HashMap::new();
        for item in uncached_items {
            if let Some(index) = group_indexes.get(&item.key).copied() {
                if OpenRequestFingerprint::from_request(&groups[index].request)
                    == OpenRequestFingerprint::from_request(&item.request)
                {
                    groups[index].responders.push(item.responder);
                } else {
                    let _ = item.responder.send(Err(TunnelAnchorError::Rejected(
                        "open intent reused with different open request".into(),
                    )));
                }
            } else {
                let index = groups.len();
                group_indexes.insert(item.key.clone(), index);
                groups.push(OpenBatchGroup {
                    key: item.key,
                    request: item.request,
                    responders: vec![item.responder],
                });
            }
        }

        let mut identity_counts: HashMap<OpenPartyIdentity, usize> = HashMap::new();
        for group in &groups {
            *identity_counts
                .entry(OpenPartyIdentity::from_request(&group.request))
                .or_default() += 1;
        }

        let mut safe_groups = Vec::new();
        let mut single_groups = Vec::new();
        for group in groups {
            let identity = OpenPartyIdentity::from_request(&group.request);
            if identity_counts.get(&identity).copied().unwrap_or_default() == 1 {
                safe_groups.push(group);
            } else {
                single_groups.push(group);
            }
        }

        let single_group_count = single_groups.len();
        for group in single_groups {
            let result = self.open_single_uncached(group.key, group.request).await;
            send_open_group_result(group.responders, result);
        }

        tracing::debug!(
            safe_groups = safe_groups.len(),
            single_groups = single_group_count,
            elapsed_ms = started.elapsed().as_millis(),
            "sui open batch grouped"
        );
        self.execute_open_groups_or_split(safe_groups).await;
        tracing::debug!(
            elapsed_ms = started.elapsed().as_millis(),
            "sui open batch done"
        );
    }

    fn execute_open_groups_or_split(
        &self,
        mut groups: Vec<OpenBatchGroup>,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(async move {
            match groups.len() {
                0 => {}
                1 => {
                    let group = groups.pop().expect("one open group");
                    let result = self.open_single_uncached(group.key, group.request).await;
                    send_open_group_result(group.responders, result);
                }
                _ => {
                    let keys = groups
                        .iter()
                        .map(|group| group.key.clone())
                        .collect::<Vec<_>>();
                    let requests = groups
                        .iter()
                        .map(|group| clone_open_request(&group.request))
                        .collect::<Vec<_>>();

                    match self.open_batched_uncached(&keys, &requests).await {
                        Ok(opened) => {
                            tracing::debug!(
                                groups = groups.len(),
                                "sui open batch attempt resolved"
                            );
                            for (group, opened) in groups.into_iter().zip(opened) {
                                send_open_group_result(group.responders, Ok(opened));
                            }
                        }
                        Err(OpenBatchAttemptError::Retryable(error)) => {
                            tracing::debug!(
                                groups = groups.len(),
                                ?error,
                                "sui open batch attempt retryable; splitting"
                            );
                            let right_groups = groups.split_off(groups.len() / 2);
                            self.execute_open_groups_or_split(groups).await;
                            self.execute_open_groups_or_split(right_groups).await;
                        }
                        Err(OpenBatchAttemptError::Final(error)) => {
                            tracing::warn!(
                                groups = groups.len(),
                                ?error,
                                "sui open batch attempt failed"
                            );
                            for group in groups {
                                send_open_group_result(group.responders, Err(error.clone()));
                            }
                        }
                    }
                }
            }
        })
    }

    fn cached_open(
        &self,
        key: &OpenKey,
        request: &TunnelOpenRequest,
    ) -> Result<Option<OpenedTunnel>, TunnelAnchorError> {
        let opened = self.inner.lock().unwrap().opens.get(key).cloned();
        let Some(opened) = opened else {
            return Ok(None);
        };
        if opened.request != OpenRequestFingerprint::from_request(request) {
            return Err(TunnelAnchorError::Rejected(
                "open intent reused with different open request".into(),
            ));
        }
        Ok(Some(OpenedTunnel {
            tunnel_id: opened.tunnel_id,
            onchain_nonce: opened.onchain_nonce,
            created_at_ms: Some(opened.created_at_ms),
            created: false,
        }))
    }

    async fn open_batched_uncached(
        &self,
        keys: &[OpenKey],
        requests: &[TunnelOpenRequest],
    ) -> Result<Vec<OpenedTunnel>, OpenBatchAttemptError> {
        let started = Instant::now();
        tracing::debug!(requests = requests.len(), "sui open batch build start");
        let kind = self
            .build_batched_open_kind_for_config(requests)
            .await
            .map_err(OpenBatchAttemptError::Final)?;
        tracing::debug!(
            requests = requests.len(),
            elapsed_ms = started.elapsed().as_millis(),
            "sui open batch execute start"
        );
        let effects = self
            .execute_open_kind(kind)
            .await
            .map_err(open_batch_attempt_error)?;
        self.cost
            .add(self.open_gas_paid_by_funder(), net_gas_mist(&effects));
        tracing::debug!(
            requests = requests.len(),
            elapsed_ms = started.elapsed().as_millis(),
            "sui open batch execute done"
        );
        ensure_success(&effects).map_err(OpenBatchAttemptError::Retryable)?;
        let opened = self
            .map_created_tunnels_to_open_requests(&effects, requests)
            .await
            .map_err(OpenBatchAttemptError::Final)?;
        tracing::debug!(
            requests = requests.len(),
            elapsed_ms = started.elapsed().as_millis(),
            "sui open batch map done"
        );

        let mut results = Vec::with_capacity(requests.len());
        let mut state = self.inner.lock().unwrap();
        for ((key, request), (tunnel_id, created_at_ms)) in
            keys.iter().cloned().zip(requests.iter()).zip(opened)
        {
            let record = OpenRecord {
                tunnel_id: tunnel_id.clone(),
                party_a: request.party_a,
                party_b: request.party_b,
                onchain_nonce: 0,
                created_at_ms,
                request: OpenRequestFingerprint::from_request(request),
            };
            state.opens.insert(key, record);
            results.push(OpenedTunnel {
                tunnel_id,
                onchain_nonce: 0,
                created_at_ms: Some(created_at_ms),
                created: true,
            });
        }
        Ok(results)
    }

    async fn execute_open_kind(
        &self,
        kind: TransactionKind,
    ) -> Result<TransactionEffects, TunnelAnchorError> {
        match self.config.open_mode {
            SuiOpenMode::SponsoredCreateAndFund => self.execute_sponsored_kind(kind).await,
            SuiOpenMode::DirectCreateAndFund => self.execute_direct_kind(kind).await,
        }
    }

    async fn execute_sponsored_kind(
        &self,
        kind: TransactionKind,
    ) -> Result<TransactionEffects, TunnelAnchorError> {
        let tx_kind_bytes = base64::engine::general_purpose::STANDARD
            .encode(bcs::to_bytes(&kind).map_err(|e| TunnelAnchorError::Rejected(e.to_string()))?);
        let sponsor = self
            .backend
            .sponsor_open(self.funder_address.to_string(), tx_kind_bytes)
            .await?;
        let tx_bytes = base64::engine::general_purpose::STANDARD
            .decode(&sponsor.tx_bytes)
            .map_err(|e| TunnelAnchorError::Rejected(format!("bad sponsored tx bytes: {e}")))?;
        let tx: Transaction = bcs::from_bytes(&tx_bytes)
            .map_err(|e| TunnelAnchorError::Rejected(format!("bad sponsored transaction: {e}")))?;
        let user_sig = self
            .funder
            .sign_transaction(&tx)
            .map_err(|e| TunnelAnchorError::Rejected(format!("sign sponsored tx: {e}")))?;
        Ok(match sponsor.provider.as_str() {
            "settler" => {
                let sponsor_sig = sponsor
                    .sponsor_signature
                    .as_deref()
                    .ok_or_else(|| {
                        TunnelAnchorError::Rejected("settler sponsor missing signature".into())
                    })
                    .and_then(decode_user_signature)?;
                self.chain
                    .execute_transaction(&tx, &[user_sig, sponsor_sig])
                    .await
                    .map_err(TunnelAnchorError::Unavailable)?
            }
            "enoki" => {
                let digest = sponsor.digest.as_deref().ok_or_else(|| {
                    TunnelAnchorError::Rejected("enoki sponsor missing digest".into())
                })?;
                let digest = self
                    .backend
                    .execute_enoki(digest.to_string(), user_sig.to_base64())
                    .await?;
                self.chain
                    .get_transaction_effects(&digest)
                    .await
                    .map_err(TunnelAnchorError::Unavailable)?
                    .ok_or_else(|| {
                        TunnelAnchorError::Unavailable(format!("transaction {digest} not found"))
                    })?
            }
            other => {
                return Err(TunnelAnchorError::Rejected(format!(
                    "unknown sponsor provider {other}"
                )))
            }
        })
    }

    async fn execute_direct_kind(
        &self,
        kind: TransactionKind,
    ) -> Result<TransactionEffects, TunnelAnchorError> {
        let gas = self
            .chain
            .address_balance_gas_context()
            .await
            .map_err(TunnelAnchorError::Unavailable)?;
        let nonce = self.next_direct_tx_nonce()?;
        let tx = Transaction {
            kind,
            sender: self.funder_address,
            gas_payment: GasPayment {
                objects: Vec::new(),
                owner: self.funder_address,
                price: gas.reference_gas_price,
                budget: DEFAULT_DIRECT_GAS_BUDGET_MIST,
            },
            expiration: TransactionExpiration::ValidDuring {
                min_epoch: Some(gas.epoch),
                max_epoch: Some(gas.epoch),
                min_timestamp: None,
                max_timestamp: None,
                chain: gas.chain_id,
                nonce,
            },
        };
        let user_sig = self
            .funder
            .sign_transaction(&tx)
            .map_err(|e| TunnelAnchorError::Rejected(format!("sign direct tx: {e}")))?;
        self.chain
            .execute_transaction(&tx, &[user_sig])
            .await
            .map_err(TunnelAnchorError::Unavailable)
    }

    fn next_direct_tx_nonce(&self) -> Result<u32, TunnelAnchorError> {
        let nonce = self.direct_tx_nonce.fetch_add(1, Ordering::Relaxed);
        u32::try_from(nonce).map_err(|_| {
            TunnelAnchorError::Rejected("direct address-balance gas nonce exhausted".into())
        })
    }

    async fn opened_from_effects(
        &self,
        effects: &TransactionEffects,
    ) -> Result<(String, u64), TunnelAnchorError> {
        ensure_success(effects)?;
        let tx_digest = transaction_digest(effects);
        let created_at_ms = self
            .chain
            .get_transaction_timestamp_ms(&tx_digest)
            .await
            .map_err(TunnelAnchorError::Unavailable)?
            .ok_or_else(|| {
                TunnelAnchorError::Unavailable(format!(
                    "transaction {tx_digest} timestamp not found"
                ))
            })?;
        let tunnel_id = self.find_created_tunnel_id(effects).await?;
        Ok((tunnel_id, created_at_ms))
    }

    async fn map_created_tunnels_to_open_requests(
        &self,
        effects: &TransactionEffects,
        requests: &[TunnelOpenRequest],
    ) -> Result<Vec<(String, u64)>, TunnelAnchorError> {
        let started = Instant::now();
        ensure_success(effects)?;
        let tx_digest = transaction_digest(effects);
        let created_at_ms = self
            .chain
            .get_transaction_timestamp_ms(&tx_digest)
            .await
            .map_err(TunnelAnchorError::Unavailable)?
            .ok_or_else(|| {
                TunnelAnchorError::Unavailable(format!(
                    "transaction {tx_digest} timestamp not found"
                ))
            })?;

        let created_ids = created_object_ids(effects);
        tracing::debug!(
            requests = requests.len(),
            created_objects = created_ids.len(),
            elapsed_ms = started.elapsed().as_millis(),
            "sui open batch object mapping start"
        );
        let mut matched_results = vec![None; requests.len()];
        let mut tunnel_count = 0usize;
        for object_id in created_ids {
            let Some(object) = self
                .chain
                .get_object(object_id)
                .await
                .map_err(TunnelAnchorError::Unavailable)?
            else {
                continue;
            };
            if self.is_tunnel_object(&object)? {
                tunnel_count += 1;
                let parties = parse_tunnel_parties(&object)?;
                let matching_requests = requests
                    .iter()
                    .enumerate()
                    .filter_map(|(request_index, request)| {
                        parties
                            .matches_open_request(request)
                            .then_some(request_index)
                    })
                    .collect::<Vec<_>>();

                if matching_requests.len() > 1 {
                    return Err(TunnelAnchorError::Rejected(format!(
                        "created Tunnel object {object_id} matches multiple open requests"
                    )));
                }
                let Some(request_index) = matching_requests.first().copied() else {
                    return Err(TunnelAnchorError::Rejected(format!(
                        "created Tunnel object {object_id} matches no open request"
                    )));
                };
                if matched_results[request_index].is_some() {
                    return Err(TunnelAnchorError::Rejected(format!(
                        "multiple created Tunnel objects match open request {request_index}"
                    )));
                }
                matched_results[request_index] = Some((object_id.to_string(), created_at_ms));
            }
        }
        if tunnel_count != requests.len() {
            return Err(TunnelAnchorError::Rejected(format!(
                "open batch created {} Tunnel objects for {} requests",
                tunnel_count,
                requests.len()
            )));
        }
        tracing::debug!(
            requests = requests.len(),
            tunnel_count,
            elapsed_ms = started.elapsed().as_millis(),
            "sui open batch object mapping done"
        );

        matched_results
            .into_iter()
            .enumerate()
            .map(|(request_index, result)| {
                result.ok_or_else(|| {
                    TunnelAnchorError::Rejected(format!(
                        "open request {request_index} matched no created Tunnel object"
                    ))
                })
            })
            .collect()
    }

    fn tunnel_coin_type(&self) -> Result<TypeTag, TunnelAnchorError> {
        let coin_struct = StructTag::from_str(&self.config.tunnel_coin_type)
            .map_err(|e| TunnelAnchorError::Rejected(format!("invalid Sui coin type: {e}")))?;
        Ok(TypeTag::from(coin_struct))
    }

    async fn build_open_kind_for_config(
        &self,
        request: &TunnelOpenRequest,
    ) -> Result<TransactionKind, TunnelAnchorError> {
        if self.config.open_mode == SuiOpenMode::DirectCreateAndFund {
            return self.build_open_kind_from_address_balance(request);
        }
        match self.config.funding_profile.stake_source() {
            SuiStakeSource::CoinObject { coin_id } => {
                let stake_coin_id = parse_address(coin_id)?;
                let stake_ref = self
                    .chain
                    .get_object_ref(stake_coin_id)
                    .await
                    .map_err(TunnelAnchorError::Unavailable)?;
                self.build_open_kind_from_coin_object(request, stake_ref)
            }
            SuiStakeSource::AddressBalance => self.build_open_kind(request),
        }
    }

    async fn build_batched_open_kind_for_config(
        &self,
        requests: &[TunnelOpenRequest],
    ) -> Result<TransactionKind, TunnelAnchorError> {
        if self.config.open_mode == SuiOpenMode::DirectCreateAndFund {
            return self.build_batched_open_kind_from_address_balance(requests);
        }
        match self.config.funding_profile.stake_source() {
            SuiStakeSource::CoinObject { coin_id } => {
                let stake_coin_id = parse_address(coin_id)?;
                let stake_ref = self
                    .chain
                    .get_object_ref(stake_coin_id)
                    .await
                    .map_err(TunnelAnchorError::Unavailable)?;
                self.build_batched_open_kind_from_coin_object(requests, stake_ref)
            }
            SuiStakeSource::AddressBalance => self.build_batched_open_kind(requests),
        }
    }

    fn build_open_kind(
        &self,
        request: &TunnelOpenRequest,
    ) -> Result<TransactionKind, TunnelAnchorError> {
        match self.config.funding_profile.stake_source() {
            SuiStakeSource::AddressBalance => self.build_open_kind_from_address_balance(request),
            SuiStakeSource::CoinObject { .. } => Err(TunnelAnchorError::Rejected(
                "coin-object stake source requires a resolved stake coin object".into(),
            )),
        }
    }

    fn build_open_kind_from_coin_object(
        &self,
        request: &TunnelOpenRequest,
        stake_ref: ObjectReference,
    ) -> Result<TransactionKind, TunnelAnchorError> {
        let package = parse_address(&self.config.package_id)?;
        let coin_struct = StructTag::from_str(&self.config.tunnel_coin_type)
            .map_err(|e| TunnelAnchorError::Rejected(format!("invalid Sui coin type: {e}")))?;
        let coin_type = TypeTag::from(coin_struct);
        let clock = Address::from_str(CLOCK_ADDRESS).expect("static clock address");
        let party_a_address = Ed25519PublicKey::new(request.party_a).derive_address();
        let party_b_address = Ed25519PublicKey::new(request.party_b).derive_address();
        let inputs = vec![
            Input::ImmutableOrOwned(stake_ref),
            pure(&request.initial.a)?,
            pure(&request.initial.b)?,
            pure(&party_a_address)?,
            pure(&request.party_a.to_vec())?,
            pure(&ED25519_SCHEME_FLAG)?,
            pure(&party_b_address)?,
            pure(&request.party_b.to_vec())?,
            pure(&ED25519_SCHEME_FLAG)?,
            pure(&DEFAULT_TIMEOUT_MS)?,
            pure(&0u64)?,
            Input::Shared(SharedInput::new(clock, 1, false)),
        ];
        let split = Command::SplitCoins(SplitCoins {
            coin: Argument::Input(0),
            amounts: vec![Argument::Input(1), Argument::Input(2)],
        });
        let call = Command::MoveCall(MoveCall {
            package,
            module: Identifier::new("tunnel")
                .map_err(|e| TunnelAnchorError::Rejected(e.to_string()))?,
            function: Identifier::new("create_and_fund")
                .map_err(|e| TunnelAnchorError::Rejected(e.to_string()))?,
            type_arguments: vec![coin_type],
            arguments: vec![
                Argument::Input(3),
                Argument::Input(4),
                Argument::Input(5),
                Argument::Input(6),
                Argument::Input(7),
                Argument::Input(8),
                Argument::NestedResult(0, 0),
                Argument::NestedResult(0, 1),
                Argument::Input(9),
                Argument::Input(10),
                Argument::Input(11),
            ],
        });
        Ok(TransactionKind::ProgrammableTransaction(
            ProgrammableTransaction {
                inputs,
                commands: vec![split, call],
            },
        ))
    }

    fn build_open_kind_from_address_balance(
        &self,
        request: &TunnelOpenRequest,
    ) -> Result<TransactionKind, TunnelAnchorError> {
        let package = parse_address(&self.config.package_id)?;
        let coin_type = self.tunnel_coin_type()?;
        let clock = Address::from_str(CLOCK_ADDRESS).expect("static clock address");
        let party_a_address = Ed25519PublicKey::new(request.party_a).derive_address();
        let party_b_address = Ed25519PublicKey::new(request.party_b).derive_address();
        let total = request
            .initial
            .a
            .checked_add(request.initial.b)
            .ok_or_else(|| TunnelAnchorError::Rejected("open stake total overflows u64".into()))?;
        let inputs = vec![
            Input::FundsWithdrawal(FundsWithdrawal::new(
                total,
                coin_type.clone(),
                WithdrawFrom::Sender,
            )),
            pure(&request.initial.a)?,
            pure(&request.initial.b)?,
            pure(&party_a_address)?,
            pure(&request.party_a.to_vec())?,
            pure(&ED25519_SCHEME_FLAG)?,
            pure(&party_b_address)?,
            pure(&request.party_b.to_vec())?,
            pure(&ED25519_SCHEME_FLAG)?,
            pure(&DEFAULT_TIMEOUT_MS)?,
            pure(&0u64)?,
            Input::Shared(SharedInput::new(clock, 1, false)),
        ];
        let redeem = Command::MoveCall(MoveCall {
            package: Address::TWO,
            module: Identifier::new("coin")
                .map_err(|e| TunnelAnchorError::Rejected(e.to_string()))?,
            function: Identifier::new("redeem_funds")
                .map_err(|e| TunnelAnchorError::Rejected(e.to_string()))?,
            type_arguments: vec![coin_type.clone()],
            arguments: vec![Argument::Input(0)],
        });
        let split = Command::SplitCoins(SplitCoins {
            coin: Argument::Result(0),
            amounts: vec![Argument::Input(1), Argument::Input(2)],
        });
        let call = Command::MoveCall(MoveCall {
            package,
            module: Identifier::new("tunnel")
                .map_err(|e| TunnelAnchorError::Rejected(e.to_string()))?,
            function: Identifier::new("create_and_fund")
                .map_err(|e| TunnelAnchorError::Rejected(e.to_string()))?,
            type_arguments: vec![coin_type.clone()],
            arguments: vec![
                Argument::Input(3),
                Argument::Input(4),
                Argument::Input(5),
                Argument::Input(6),
                Argument::Input(7),
                Argument::Input(8),
                Argument::NestedResult(1, 0),
                Argument::NestedResult(1, 1),
                Argument::Input(9),
                Argument::Input(10),
                Argument::Input(11),
            ],
        });
        let destroy_zero = Command::MoveCall(MoveCall {
            package: Address::TWO,
            module: Identifier::new("coin")
                .map_err(|e| TunnelAnchorError::Rejected(e.to_string()))?,
            function: Identifier::new("destroy_zero")
                .map_err(|e| TunnelAnchorError::Rejected(e.to_string()))?,
            type_arguments: vec![coin_type],
            arguments: vec![Argument::Result(0)],
        });
        Ok(TransactionKind::ProgrammableTransaction(
            ProgrammableTransaction {
                inputs,
                commands: vec![redeem, split, call, destroy_zero],
            },
        ))
    }

    #[allow(dead_code)]
    fn build_batched_open_kind(
        &self,
        requests: &[TunnelOpenRequest],
    ) -> Result<TransactionKind, TunnelAnchorError> {
        match self.config.funding_profile.stake_source() {
            SuiStakeSource::AddressBalance => {
                self.build_batched_open_kind_from_address_balance(requests)
            }
            SuiStakeSource::CoinObject { .. } => Err(TunnelAnchorError::Rejected(
                "coin-object stake source requires a resolved stake coin object".into(),
            )),
        }
    }

    fn build_batched_open_kind_from_coin_object(
        &self,
        requests: &[TunnelOpenRequest],
        stake_ref: ObjectReference,
    ) -> Result<TransactionKind, TunnelAnchorError> {
        if requests.is_empty() {
            return Err(TunnelAnchorError::Rejected("open batch is empty".into()));
        }
        if requests.len() > MAX_SPONSORED_OPEN_BATCH_SIZE {
            return Err(TunnelAnchorError::Rejected("open batch too large".into()));
        }
        let command_count = 1 + requests.len();
        if command_count >= 1024 {
            return Err(TunnelAnchorError::Rejected(
                "open batch exceeds PTB command limit".into(),
            ));
        }
        let event_count = 4 * requests.len();
        if event_count > 1024 {
            return Err(TunnelAnchorError::Rejected(
                "open batch exceeds event limit".into(),
            ));
        }

        let package = parse_address(&self.config.package_id)?;
        let coin_struct = StructTag::from_str(&self.config.tunnel_coin_type)
            .map_err(|e| TunnelAnchorError::Rejected(format!("invalid Sui coin type: {e}")))?;
        let coin_type = TypeTag::from(coin_struct);
        let clock = Address::from_str(CLOCK_ADDRESS).expect("static clock address");

        let mut inputs = Vec::with_capacity(2 + requests.len() * 10);
        inputs.push(Input::ImmutableOrOwned(stake_ref));
        for request in requests {
            inputs.push(pure(&request.initial.a)?);
            inputs.push(pure(&request.initial.b)?);
        }
        for request in requests {
            let party_a_address = Ed25519PublicKey::new(request.party_a).derive_address();
            let party_b_address = Ed25519PublicKey::new(request.party_b).derive_address();
            inputs.push(pure(&party_a_address)?);
            inputs.push(pure(&request.party_a.to_vec())?);
            inputs.push(pure(&ED25519_SCHEME_FLAG)?);
            inputs.push(pure(&party_b_address)?);
            inputs.push(pure(&request.party_b.to_vec())?);
            inputs.push(pure(&ED25519_SCHEME_FLAG)?);
            inputs.push(pure(&DEFAULT_TIMEOUT_MS)?);
            inputs.push(pure(&0u64)?);
        }
        let clock_input = inputs.len();
        inputs.push(Input::Shared(SharedInput::new(clock, 1, false)));

        let split_amounts = (0..requests.len() * 2)
            .map(|offset| input_argument(1 + offset))
            .collect::<Result<Vec<_>, _>>()?;
        let split = Command::SplitCoins(SplitCoins {
            coin: Argument::Input(0),
            amounts: split_amounts,
        });

        let mut commands = Vec::with_capacity(command_count);
        commands.push(split);
        let metadata_start = 1 + requests.len() * 2;
        for request_index in 0..requests.len() {
            let request_input = metadata_start + request_index * 8;
            let coin_a = request_index * 2;
            let coin_b = coin_a + 1;
            commands.push(Command::MoveCall(MoveCall {
                package,
                module: Identifier::new("tunnel")
                    .map_err(|e| TunnelAnchorError::Rejected(e.to_string()))?,
                function: Identifier::new("create_and_fund")
                    .map_err(|e| TunnelAnchorError::Rejected(e.to_string()))?,
                type_arguments: vec![coin_type.clone()],
                arguments: vec![
                    input_argument(request_input)?,
                    input_argument(request_input + 1)?,
                    input_argument(request_input + 2)?,
                    input_argument(request_input + 3)?,
                    input_argument(request_input + 4)?,
                    input_argument(request_input + 5)?,
                    nested_result_argument(0, coin_a)?,
                    nested_result_argument(0, coin_b)?,
                    input_argument(request_input + 6)?,
                    input_argument(request_input + 7)?,
                    input_argument(clock_input)?,
                ],
            }));
        }

        Ok(TransactionKind::ProgrammableTransaction(
            ProgrammableTransaction { inputs, commands },
        ))
    }

    fn build_batched_open_kind_from_address_balance(
        &self,
        requests: &[TunnelOpenRequest],
    ) -> Result<TransactionKind, TunnelAnchorError> {
        if requests.is_empty() {
            return Err(TunnelAnchorError::Rejected("open batch is empty".into()));
        }
        if requests.len() > MAX_SPONSORED_OPEN_BATCH_SIZE {
            return Err(TunnelAnchorError::Rejected("open batch too large".into()));
        }
        let command_count = 3 + requests.len();
        if command_count >= 1024 {
            return Err(TunnelAnchorError::Rejected(
                "open batch exceeds PTB command limit".into(),
            ));
        }
        let event_count = 4 * requests.len();
        if event_count > 1024 {
            return Err(TunnelAnchorError::Rejected(
                "open batch exceeds event limit".into(),
            ));
        }

        let package = parse_address(&self.config.package_id)?;
        let coin_type = self.tunnel_coin_type()?;
        let clock = Address::from_str(CLOCK_ADDRESS).expect("static clock address");
        let total = requests.iter().try_fold(0u64, |total, request| {
            let request_total = request
                .initial
                .a
                .checked_add(request.initial.b)
                .ok_or_else(|| {
                    TunnelAnchorError::Rejected("open stake total overflows u64".into())
                })?;
            total.checked_add(request_total).ok_or_else(|| {
                TunnelAnchorError::Rejected("open batch stake total overflows u64".into())
            })
        })?;

        let mut inputs = Vec::with_capacity(2 + requests.len() * 10);
        inputs.push(Input::FundsWithdrawal(FundsWithdrawal::new(
            total,
            coin_type.clone(),
            WithdrawFrom::Sender,
        )));
        for request in requests {
            inputs.push(pure(&request.initial.a)?);
            inputs.push(pure(&request.initial.b)?);
        }
        for request in requests {
            let party_a_address = Ed25519PublicKey::new(request.party_a).derive_address();
            let party_b_address = Ed25519PublicKey::new(request.party_b).derive_address();
            inputs.push(pure(&party_a_address)?);
            inputs.push(pure(&request.party_a.to_vec())?);
            inputs.push(pure(&ED25519_SCHEME_FLAG)?);
            inputs.push(pure(&party_b_address)?);
            inputs.push(pure(&request.party_b.to_vec())?);
            inputs.push(pure(&ED25519_SCHEME_FLAG)?);
            inputs.push(pure(&DEFAULT_TIMEOUT_MS)?);
            inputs.push(pure(&0u64)?);
        }
        let clock_input = inputs.len();
        inputs.push(Input::Shared(SharedInput::new(clock, 1, false)));

        let redeem = Command::MoveCall(MoveCall {
            package: Address::TWO,
            module: Identifier::new("coin")
                .map_err(|e| TunnelAnchorError::Rejected(e.to_string()))?,
            function: Identifier::new("redeem_funds")
                .map_err(|e| TunnelAnchorError::Rejected(e.to_string()))?,
            type_arguments: vec![coin_type.clone()],
            arguments: vec![Argument::Input(0)],
        });
        let split_amounts = (0..requests.len() * 2)
            .map(|offset| input_argument(1 + offset))
            .collect::<Result<Vec<_>, _>>()?;
        let split = Command::SplitCoins(SplitCoins {
            coin: Argument::Result(0),
            amounts: split_amounts,
        });

        let mut commands = Vec::with_capacity(command_count);
        commands.push(redeem);
        commands.push(split);
        let metadata_start = 1 + requests.len() * 2;
        for request_index in 0..requests.len() {
            let request_input = metadata_start + request_index * 8;
            let coin_a = request_index * 2;
            let coin_b = coin_a + 1;
            commands.push(Command::MoveCall(MoveCall {
                package,
                module: Identifier::new("tunnel")
                    .map_err(|e| TunnelAnchorError::Rejected(e.to_string()))?,
                function: Identifier::new("create_and_fund")
                    .map_err(|e| TunnelAnchorError::Rejected(e.to_string()))?,
                type_arguments: vec![coin_type.clone()],
                arguments: vec![
                    input_argument(request_input)?,
                    input_argument(request_input + 1)?,
                    input_argument(request_input + 2)?,
                    input_argument(request_input + 3)?,
                    input_argument(request_input + 4)?,
                    input_argument(request_input + 5)?,
                    nested_result_argument(1, coin_a)?,
                    nested_result_argument(1, coin_b)?,
                    input_argument(request_input + 6)?,
                    input_argument(request_input + 7)?,
                    input_argument(clock_input)?,
                ],
            }));
        }
        commands.push(Command::MoveCall(MoveCall {
            package: Address::TWO,
            module: Identifier::new("coin")
                .map_err(|e| TunnelAnchorError::Rejected(e.to_string()))?,
            function: Identifier::new("destroy_zero")
                .map_err(|e| TunnelAnchorError::Rejected(e.to_string()))?,
            type_arguments: vec![coin_type],
            arguments: vec![Argument::Result(0)],
        }));

        Ok(TransactionKind::ProgrammableTransaction(
            ProgrammableTransaction { inputs, commands },
        ))
    }

    async fn find_created_tunnel_id(
        &self,
        effects: &TransactionEffects,
    ) -> Result<String, TunnelAnchorError> {
        for object_id in created_object_ids(effects) {
            let Some(object) = self
                .chain
                .get_object(object_id)
                .await
                .map_err(TunnelAnchorError::Unavailable)?
            else {
                continue;
            };
            if self.is_tunnel_object(&object)? {
                return Ok(object_id.to_string());
            }
        }
        Err(TunnelAnchorError::Rejected(
            "open transaction created no Tunnel object".into(),
        ))
    }

    fn is_tunnel_object(&self, object: &Object) -> Result<bool, TunnelAnchorError> {
        let package = parse_address(&self.config.package_id)?;
        let ObjectType::Struct(tag) = object.object_type() else {
            return Ok(false);
        };
        Ok(tag.address() == &package
            && tag.module().as_str() == "tunnel"
            && tag.name().as_str() == "Tunnel")
    }

    async fn settle_once(
        &self,
        request: TunnelSettleRequest,
    ) -> Result<SettledTunnel, TunnelAnchorError> {
        if request.transcript_root.is_none() {
            return Err(TunnelAnchorError::Rejected(
                "sponsored Sui anchor requires transcript_root settlement".into(),
            ));
        }
        let pending = {
            let mut state = self.inner.lock().unwrap();
            if let Some(settled) = state.settled.get(&request.tunnel_id) {
                return Ok(settled.clone());
            }
            state.pending_settles.remove(&request.tunnel_id)
        };
        let Some(pending) = pending else {
            let (tx, rx) = oneshot::channel();
            {
                let mut state = self.inner.lock().unwrap();
                state.pending_settles.insert(
                    request.tunnel_id.clone(),
                    PendingSettle {
                        request,
                        responder: tx,
                    },
                );
            }
            return rx.await.unwrap_or_else(|_| {
                Err(TunnelAnchorError::Unavailable(
                    "settle pairing dropped".into(),
                ))
            });
        };
        let result = self.submit_paired_settle(&pending.request, &request).await;
        let _ = pending.responder.send(result.clone());
        if let Ok(settled) = &result {
            self.inner
                .lock()
                .unwrap()
                .settled
                .insert(pending.request.tunnel_id.clone(), settled.clone());
        }
        result
    }

    async fn submit_paired_settle(
        &self,
        first: &TunnelSettleRequest,
        second: &TunnelSettleRequest,
    ) -> Result<SettledTunnel, TunnelAnchorError> {
        let record = self.open_record_for(&first.tunnel_id)?;
        let (sig_a, sig_b) = verify_paired_settle(first, second, &record)?;
        let root = first
            .transcript_root
            .ok_or_else(|| TunnelAnchorError::Rejected("missing transcript root".into()))?;
        let settlement = Settlement {
            tunnel_id: first.tunnel_id.clone(),
            party_a_balance: first.party_a_balance,
            party_b_balance: first.party_b_balance,
            final_nonce: first.final_nonce,
            timestamp: first.timestamp,
        };
        let entries: Vec<SettleBodyEntry> = first
            .transcript_entries
            .iter()
            .map(|entry| SettleBodyEntry {
                message: entry.message.clone(),
                sig_a: entry.sig_a,
                sig_b: entry.sig_b,
            })
            .collect();
        let body = encode_settle_body(&settlement, &root, &sig_a, &sig_b, &entries);
        if self.config.settle_mode != SuiSettleMode::BackendSettle {
            let prepared = PreparedSettle {
                tunnel_id: first.tunnel_id.clone(),
                party_a_balance: first.party_a_balance,
                party_b_balance: first.party_b_balance,
                timestamp: first.timestamp,
                root,
                sig_a,
                sig_b,
            };
            if let Some(executor) = &self.settle_batch_executor {
                return executor.submit(prepared).await;
            }
            let mut settled = self.execute_prepared_settle_batch(vec![prepared]).await?;
            return settled
                .pop()
                .ok_or_else(|| TunnelAnchorError::Unavailable("empty settle batch result".into()));
        }
        let body = self.backend.settle(first.tunnel_id.clone(), body).await?;
        // Settle gas is metered post-hoc from the on-chain effects. If they
        // can't be fetched (RPC error, or not yet indexed), warn instead of
        // silently dropping the spend — an unmetered settle understates the gas
        // total, and a silent gap is worse than a visible one.
        match self.chain.get_transaction_effects(&body.tx_digest).await {
            Ok(Some(settle_effects)) => {
                self.cost.add(false, net_gas_mist(&settle_effects));
            }
            Ok(None) => {
                tracing::warn!(
                    tx_digest = %body.tx_digest,
                    "settle gas unmetered: transaction effects not yet available"
                );
            }
            Err(err) => {
                tracing::warn!(
                    tx_digest = %body.tx_digest,
                    error = ?err,
                    "settle gas unmetered: failed to fetch transaction effects"
                );
            }
        }
        Ok(SettledTunnel {
            digest: body.tx_digest,
            final_balances: Balances {
                a: first.party_a_balance,
                b: first.party_b_balance,
            },
        })
    }

    async fn execute_settle_batch(&self, items: Vec<SettleBatchItem>) {
        if items.is_empty() {
            return;
        }
        let prepared = items
            .iter()
            .map(|item| item.prepared.clone())
            .collect::<Vec<_>>();
        let result = self.execute_prepared_settle_batch(prepared).await;
        match result {
            Ok(settled) => {
                for (item, settled) in items.into_iter().zip(settled) {
                    let _ = item.responder.send(Ok(settled));
                }
            }
            Err(error) => {
                for item in items {
                    let _ = item.responder.send(Err(error.clone()));
                }
            }
        }
    }

    async fn execute_prepared_settle_batch(
        &self,
        prepared: Vec<PreparedSettle>,
    ) -> Result<Vec<SettledTunnel>, TunnelAnchorError> {
        let kind = self.build_batched_settle_kind(&prepared).await?;
        let effects = match self.config.settle_mode {
            SuiSettleMode::BackendSettle => unreachable!(),
            SuiSettleMode::SponsoredSettle => self.execute_sponsored_kind(kind).await?,
            SuiSettleMode::DirectSettle => self.execute_direct_kind(kind).await?,
        };
        ensure_success(&effects)?;
        self.cost
            .add(self.settle_gas_paid_by_funder(), net_gas_mist(&effects));
        let digest = transaction_digest(&effects);
        Ok(prepared
            .into_iter()
            .map(|settle| SettledTunnel {
                digest: digest.clone(),
                final_balances: Balances {
                    a: settle.party_a_balance,
                    b: settle.party_b_balance,
                },
            })
            .collect())
    }

    async fn build_batched_settle_kind(
        &self,
        prepared: &[PreparedSettle],
    ) -> Result<TransactionKind, TunnelAnchorError> {
        if prepared.is_empty() {
            return Err(TunnelAnchorError::Rejected("settle batch is empty".into()));
        }
        if prepared.len() > MAX_SPONSORED_SETTLE_BATCH_SIZE {
            return Err(TunnelAnchorError::Rejected("settle batch too large".into()));
        }
        if prepared.len() >= 1024 {
            return Err(TunnelAnchorError::Rejected(
                "settle batch exceeds PTB command limit".into(),
            ));
        }

        let package = parse_address(&self.config.package_id)?;
        let coin_type = self.tunnel_coin_type()?;
        let clock = Address::from_str(CLOCK_ADDRESS).expect("static clock address");
        let mut inputs = Vec::with_capacity(prepared.len() * 7 + 1);
        for settle in prepared {
            let tunnel_id = parse_address(&settle.tunnel_id)?;
            let tunnel = self
                .chain
                .get_object(tunnel_id)
                .await
                .map_err(TunnelAnchorError::Unavailable)?
                .ok_or_else(|| {
                    TunnelAnchorError::Unavailable(format!(
                        "settle tunnel object {} not found",
                        settle.tunnel_id
                    ))
                })?;
            let Owner::Shared(initial_shared_version) = *tunnel.owner() else {
                return Err(TunnelAnchorError::Rejected(format!(
                    "settle tunnel object {} is not shared",
                    settle.tunnel_id
                )));
            };
            inputs.push(Input::Shared(SharedInput::new(
                tunnel_id,
                initial_shared_version,
                true,
            )));
            inputs.push(pure(&settle.party_a_balance)?);
            inputs.push(pure(&settle.party_b_balance)?);
            inputs.push(pure(&settle.sig_a.to_vec())?);
            inputs.push(pure(&settle.sig_b.to_vec())?);
            inputs.push(pure(&settle.timestamp)?);
            inputs.push(pure(&settle.root.to_vec())?);
        }
        let clock_input = inputs.len();
        inputs.push(Input::Shared(SharedInput::new(clock, 1, false)));

        let mut commands = Vec::with_capacity(prepared.len());
        for settle_index in 0..prepared.len() {
            let input_start = settle_index * 7;
            commands.push(Command::MoveCall(MoveCall {
                package,
                module: Identifier::new("tunnel")
                    .map_err(|e| TunnelAnchorError::Rejected(e.to_string()))?,
                function: Identifier::new("entry_close_cooperative_with_root")
                    .map_err(|e| TunnelAnchorError::Rejected(e.to_string()))?,
                type_arguments: vec![coin_type.clone()],
                arguments: vec![
                    input_argument(input_start)?,
                    input_argument(input_start + 1)?,
                    input_argument(input_start + 2)?,
                    input_argument(input_start + 3)?,
                    input_argument(input_start + 4)?,
                    input_argument(input_start + 5)?,
                    input_argument(input_start + 6)?,
                    input_argument(clock_input)?,
                ],
            }));
        }

        Ok(TransactionKind::ProgrammableTransaction(
            ProgrammableTransaction { inputs, commands },
        ))
    }

    fn open_record_for(&self, tunnel_id: &str) -> Result<OpenRecord, TunnelAnchorError> {
        self.inner
            .lock()
            .unwrap()
            .opens
            .values()
            .find(|record| record.tunnel_id == tunnel_id)
            .cloned()
            .ok_or_else(|| TunnelAnchorError::Rejected(format!("unknown open tunnel {tunnel_id}")))
    }
}

impl TunnelAnchor for SuiOpenIntentAnchor {
    fn settlement_mode(&self) -> SettlementMode {
        SettlementMode::TranscriptRoot
    }

    async fn open(&self, request: TunnelOpenRequest) -> Result<OpenedTunnel, TunnelAnchorError> {
        self.inner.open_with_intent(self.intent_id, request).await
    }

    async fn settle(
        &self,
        request: TunnelSettleRequest,
    ) -> Result<SettledTunnel, TunnelAnchorError> {
        self.inner.settle_once(request).await
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SponsorRequest {
    sender: String,
    tx_kind_bytes: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SponsorResponse {
    pub provider: String,
    pub tx_bytes: String,
    pub sponsor_signature: Option<String>,
    pub digest: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SponsorExecuteRequest {
    digest: String,
    signature: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SponsorExecuteResponse {
    digest: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettleResponse {
    pub tx_digest: String,
}

async fn read_json_response<T: for<'de> Deserialize<'de>>(
    resp: reqwest::Response,
    label: &str,
) -> Result<T, TunnelAnchorError> {
    let status = resp.status();
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| TunnelAnchorError::Unavailable(e.to_string()))?;
    if !status.is_success() {
        let message = format!(
            "{label} rejected with {status}: {}",
            String::from_utf8_lossy(&bytes)
        );
        if status == reqwest::StatusCode::REQUEST_TIMEOUT
            || status == reqwest::StatusCode::TOO_MANY_REQUESTS
            || status.is_server_error()
        {
            return Err(TunnelAnchorError::Unavailable(message));
        }
        return Err(TunnelAnchorError::Rejected(message));
    }
    serde_json::from_slice(&bytes)
        .map_err(|e| TunnelAnchorError::Rejected(format!("{label} response decode: {e}")))
}

fn verify_paired_settle(
    first: &TunnelSettleRequest,
    second: &TunnelSettleRequest,
    record: &OpenRecord,
) -> Result<([u8; 64], [u8; 64]), TunnelAnchorError> {
    if first.tunnel_id != second.tunnel_id
        || first.party_a_balance != second.party_a_balance
        || first.party_b_balance != second.party_b_balance
        || first.final_nonce != second.final_nonce
        || first.timestamp != second.timestamp
        || first.transcript_root != second.transcript_root
    {
        return Err(TunnelAnchorError::Mismatch(
            "settlement halves disagree".into(),
        ));
    }
    if first.by == second.by {
        return Err(TunnelAnchorError::Mismatch(
            "settlement halves came from the same seat".into(),
        ));
    }
    let root = first
        .transcript_root
        .ok_or_else(|| TunnelAnchorError::Rejected("missing transcript root".into()))?;
    let settlement = Settlement {
        tunnel_id: first.tunnel_id.clone(),
        party_a_balance: first.party_a_balance,
        party_b_balance: first.party_b_balance,
        final_nonce: first.final_nonce,
        timestamp: first.timestamp,
    };
    let msg = tunnel_core::wire::serialize_settlement_with_root(&settlement, &root);
    let (a, b) = match (first.by, second.by) {
        (Seat::A, Seat::B) => (first.signature, second.signature),
        (Seat::B, Seat::A) => (second.signature, first.signature),
        _ => unreachable!(),
    };
    if !verify(&record.party_a, &msg, &a) {
        return Err(TunnelAnchorError::Rejected(
            "invalid party A settlement signature".into(),
        ));
    }
    if !verify(&record.party_b, &msg, &b) {
        return Err(TunnelAnchorError::Rejected(
            "invalid party B settlement signature".into(),
        ));
    }
    Ok((a, b))
}

#[derive(Debug, PartialEq, Eq)]
struct TunnelParties {
    party_a_address: Address,
    party_a_public_key: Vec<u8>,
    party_a_signature_type: u8,
    party_b_address: Address,
    party_b_public_key: Vec<u8>,
    party_b_signature_type: u8,
}

impl TunnelParties {
    fn matches_open_request(&self, request: &TunnelOpenRequest) -> bool {
        self.party_a_address == Ed25519PublicKey::new(request.party_a).derive_address()
            && self.party_a_public_key == request.party_a
            && self.party_a_signature_type == ED25519_SCHEME_FLAG
            && self.party_b_address == Ed25519PublicKey::new(request.party_b).derive_address()
            && self.party_b_public_key == request.party_b
            && self.party_b_signature_type == ED25519_SCHEME_FLAG
    }
}

fn parse_tunnel_parties(object: &Object) -> Result<TunnelParties, TunnelAnchorError> {
    let move_struct = object.as_struct().ok_or_else(|| {
        TunnelAnchorError::Rejected("Tunnel object payload is not a Move struct".into())
    })?;
    let contents = move_struct.contents();
    let mut offset = 0usize;

    let _id = read_tunnel_address(contents, &mut offset, "id")?;
    read_tunnel_u64(contents, &mut offset, "version")?;
    let party_a_address = read_tunnel_address(contents, &mut offset, "party_a.address")?;
    let party_a_public_key = read_tunnel_bytes(contents, &mut offset, "party_a.public_key")?;
    let party_a_signature_type = read_tunnel_u8(contents, &mut offset, "party_a.signature_type")?;
    let party_b_address = read_tunnel_address(contents, &mut offset, "party_b.address")?;
    let party_b_public_key = read_tunnel_bytes(contents, &mut offset, "party_b.public_key")?;
    let party_b_signature_type = read_tunnel_u8(contents, &mut offset, "party_b.signature_type")?;

    Ok(TunnelParties {
        party_a_address,
        party_a_public_key,
        party_a_signature_type,
        party_b_address,
        party_b_public_key,
        party_b_signature_type,
    })
}

fn read_tunnel_address(
    contents: &[u8],
    offset: &mut usize,
    field: &str,
) -> Result<Address, TunnelAnchorError> {
    let end = offset.checked_add(Address::LENGTH).ok_or_else(|| {
        TunnelAnchorError::Rejected(format!("Tunnel object field {field} offset overflow"))
    })?;
    let bytes = contents.get(*offset..end).ok_or_else(|| {
        TunnelAnchorError::Rejected(format!("Tunnel object field {field} is truncated"))
    })?;
    let mut address = [0u8; Address::LENGTH];
    address.copy_from_slice(bytes);
    *offset = end;
    Ok(Address::new(address))
}

fn read_tunnel_u64(
    contents: &[u8],
    offset: &mut usize,
    field: &str,
) -> Result<u64, TunnelAnchorError> {
    let end = offset.checked_add(8).ok_or_else(|| {
        TunnelAnchorError::Rejected(format!("Tunnel object field {field} offset overflow"))
    })?;
    let bytes = contents.get(*offset..end).ok_or_else(|| {
        TunnelAnchorError::Rejected(format!("Tunnel object field {field} is truncated"))
    })?;
    let mut value = [0u8; 8];
    value.copy_from_slice(bytes);
    *offset = end;
    Ok(u64::from_le_bytes(value))
}

fn read_tunnel_u8(
    contents: &[u8],
    offset: &mut usize,
    field: &str,
) -> Result<u8, TunnelAnchorError> {
    let value = *contents.get(*offset).ok_or_else(|| {
        TunnelAnchorError::Rejected(format!("Tunnel object field {field} is truncated"))
    })?;
    *offset += 1;
    Ok(value)
}

fn read_tunnel_bytes(
    contents: &[u8],
    offset: &mut usize,
    field: &str,
) -> Result<Vec<u8>, TunnelAnchorError> {
    let length = read_bcs_sequence_length(contents, offset, field)?;
    let end = offset.checked_add(length).ok_or_else(|| {
        TunnelAnchorError::Rejected(format!("Tunnel object field {field} length overflow"))
    })?;
    let bytes = contents.get(*offset..end).ok_or_else(|| {
        TunnelAnchorError::Rejected(format!("Tunnel object field {field} is truncated"))
    })?;
    *offset = end;
    Ok(bytes.to_vec())
}

fn read_bcs_sequence_length(
    contents: &[u8],
    offset: &mut usize,
    field: &str,
) -> Result<usize, TunnelAnchorError> {
    let mut value = 0usize;
    let mut shift = 0u32;

    loop {
        let byte = *contents.get(*offset).ok_or_else(|| {
            TunnelAnchorError::Rejected(format!(
                "Tunnel object field {field} has truncated BCS length"
            ))
        })?;
        *offset += 1;

        let chunk = usize::from(byte & 0x7f).checked_shl(shift).ok_or_else(|| {
            TunnelAnchorError::Rejected(format!(
                "Tunnel object field {field} BCS length is too large"
            ))
        })?;
        value = value.checked_add(chunk).ok_or_else(|| {
            TunnelAnchorError::Rejected(format!("Tunnel object field {field} BCS length overflows"))
        })?;

        if byte & 0x80 == 0 {
            return Ok(value);
        }
        shift += 7;
        if shift >= usize::BITS {
            return Err(TunnelAnchorError::Rejected(format!(
                "Tunnel object field {field} BCS length is too large"
            )));
        }
    }
}

fn created_object_ids(effects: &TransactionEffects) -> Vec<Address> {
    match effects {
        TransactionEffects::V1(v1) => v1
            .created
            .iter()
            .map(|created| created.reference.object_id().to_owned())
            .collect(),
        TransactionEffects::V2(v2) => v2
            .changed_objects
            .iter()
            .filter_map(
                |change| match (&change.id_operation, &change.output_state) {
                    (sui_sdk_types::IdOperation::Created, ObjectOut::ObjectWrite { .. })
                    | (sui_sdk_types::IdOperation::Created, ObjectOut::PackageWrite { .. }) => {
                        Some(change.object_id)
                    }
                    _ => None,
                },
            )
            .collect(),
    }
}

fn transaction_digest(effects: &TransactionEffects) -> String {
    match effects {
        TransactionEffects::V1(v1) => v1.transaction_digest.to_string(),
        TransactionEffects::V2(v2) => v2.transaction_digest.to_string(),
    }
}

fn ensure_success(effects: &TransactionEffects) -> Result<(), TunnelAnchorError> {
    match effects.status() {
        ExecutionStatus::Success => Ok(()),
        other => Err(TunnelAnchorError::Rejected(format!(
            "Sui transaction failed: {other:?}"
        ))),
    }
}

fn parse_address(s: &str) -> Result<Address, TunnelAnchorError> {
    Address::from_str(s)
        .map_err(|e| TunnelAnchorError::Rejected(format!("invalid address {s}: {e}")))
}

fn pure<T: Serialize>(value: &T) -> Result<Input, TunnelAnchorError> {
    bcs::to_bytes(value)
        .map(Input::Pure)
        .map_err(|e| TunnelAnchorError::Rejected(format!("bcs pure input: {e}")))
}

fn input_argument(index: usize) -> Result<Argument, TunnelAnchorError> {
    let index = u16::try_from(index)
        .map_err(|_| TunnelAnchorError::Rejected("PTB input index exceeds u16".into()))?;
    Ok(Argument::Input(index))
}

fn nested_result_argument(command: usize, result: usize) -> Result<Argument, TunnelAnchorError> {
    let command = u16::try_from(command)
        .map_err(|_| TunnelAnchorError::Rejected("PTB command index exceeds u16".into()))?;
    let result = u16::try_from(result)
        .map_err(|_| TunnelAnchorError::Rejected("PTB result index exceeds u16".into()))?;
    Ok(Argument::NestedResult(command, result))
}

fn decode_user_signature(s: &str) -> Result<UserSignature, TunnelAnchorError> {
    UserSignature::from_base64(s)
        .map_err(|e| TunnelAnchorError::Rejected(format!("bad sponsor signature: {e}")))
}

pub fn decode_sui_ed25519_bech32_private_key(input: &str) -> Result<Ed25519PrivateKey, String> {
    let (hrp, data, _variant) = bech32::decode(input).map_err(|e| e.to_string())?;
    if hrp != SUI_PRIVATE_KEY_HRP {
        return Err(format!("expected {SUI_PRIVATE_KEY_HRP} bech32 private key"));
    }
    let bytes = Vec::<u8>::from_base32(&data).map_err(|e| e.to_string())?;
    if bytes.len() != 33 {
        return Err(format!("expected 33 key bytes, got {}", bytes.len()));
    }
    if bytes[0] != ED25519_SCHEME_FLAG {
        return Err("only Ed25519 Sui bech32 private keys are supported".into());
    }
    let mut secret = [0u8; 32];
    secret.copy_from_slice(&bytes[1..]);
    Ok(Ed25519PrivateKey::new(secret))
}

#[cfg(test)]
mod tests {
    use super::*;
    use bech32::ToBase32;
    use std::collections::VecDeque;
    use std::sync::Mutex as StdMutex;
    use sui_sdk_types::{
        Digest, ExecutionError, GasCostSummary, GasPayment, MoveStruct, ObjectData,
        ObjectReferenceWithOwner, Owner, TransactionEffectsV1, TransactionExpiration,
    };
    use tunnel_core::protocol_id::ProtocolId;
    use tunnel_core::wire::{serialize_settlement_with_root, Settlement};
    use tunnel_harness::{LocalSigner, Signer};

    #[derive(Default)]
    struct FakeChain {
        object_ref: StdMutex<Option<ObjectReference>>,
        objects: StdMutex<HashMap<Address, Object>>,
        effects: StdMutex<Option<TransactionEffects>>,
        effects_queue: StdMutex<VecDeque<TransactionEffects>>,
        transaction_effects: StdMutex<Option<TransactionEffects>>,
        transaction_timestamp_ms: StdMutex<Option<u64>>,
        gas_selection: StdMutex<Option<(Address, u64, Vec<Address>)>>,
        executed_transaction: StdMutex<Option<Transaction>>,
        execute_call_count: StdMutex<usize>,
        execute_signature_count: StdMutex<Option<usize>>,
        transaction_digest_read: StdMutex<Option<String>>,
        timestamp_digest_read: StdMutex<Option<String>>,
    }

    #[async_trait]
    impl SuiChainClient for FakeChain {
        async fn get_object_ref(&self, _object_id: Address) -> Result<ObjectReference, String> {
            self.object_ref
                .lock()
                .unwrap()
                .clone()
                .ok_or_else(|| "missing object ref".into())
        }

        async fn get_object(&self, object_id: Address) -> Result<Option<Object>, String> {
            Ok(self.objects.lock().unwrap().get(&object_id).cloned())
        }

        async fn address_balance_gas_context(&self) -> Result<AddressBalanceGasContext, String> {
            Ok(AddressBalanceGasContext {
                reference_gas_price: 1,
                epoch: 7,
                chain_id: Digest::ZERO,
            })
        }

        async fn execute_transaction(
            &self,
            transaction: &Transaction,
            signatures: &[UserSignature],
        ) -> Result<TransactionEffects, String> {
            *self.executed_transaction.lock().unwrap() = Some(transaction.clone());
            *self.execute_call_count.lock().unwrap() += 1;
            *self.execute_signature_count.lock().unwrap() = Some(signatures.len());
            if let Some(effects) = self.effects_queue.lock().unwrap().pop_front() {
                return Ok(effects);
            }
            self.effects
                .lock()
                .unwrap()
                .clone()
                .ok_or_else(|| "missing effects".into())
        }

        async fn get_transaction_effects(
            &self,
            digest: &str,
        ) -> Result<Option<TransactionEffects>, String> {
            *self.transaction_digest_read.lock().unwrap() = Some(digest.to_string());
            Ok(self.transaction_effects.lock().unwrap().clone())
        }

        async fn get_transaction_timestamp_ms(&self, digest: &str) -> Result<Option<u64>, String> {
            *self.timestamp_digest_read.lock().unwrap() = Some(digest.to_string());
            Ok(*self.transaction_timestamp_ms.lock().unwrap())
        }
    }

    #[derive(Default)]
    struct FakeBackend {
        sponsor: StdMutex<Option<SponsorResponse>>,
        sponsor_results: StdMutex<VecDeque<Result<SponsorResponse, TunnelAnchorError>>>,
        sponsor_queue: StdMutex<VecDeque<SponsorResponse>>,
        enoki_digest: StdMutex<Option<String>>,
        settle_digest: StdMutex<Option<String>>,
        sponsor_call_count: StdMutex<usize>,
        sponsor_sender: StdMutex<Option<String>>,
        tx_kind_bytes: StdMutex<Option<String>>,
        enoki_execute: StdMutex<Option<(String, String)>>,
        settle_body: StdMutex<Option<Vec<u8>>>,
    }

    #[async_trait]
    impl SuiBackendClient for FakeBackend {
        async fn sponsor_open(
            &self,
            sender: String,
            tx_kind_bytes: String,
        ) -> Result<SponsorResponse, TunnelAnchorError> {
            *self.sponsor_call_count.lock().unwrap() += 1;
            *self.sponsor_sender.lock().unwrap() = Some(sender);
            *self.tx_kind_bytes.lock().unwrap() = Some(tx_kind_bytes);
            if let Some(result) = self.sponsor_results.lock().unwrap().pop_front() {
                return result;
            }
            if let Some(response) = self.sponsor_queue.lock().unwrap().pop_front() {
                return Ok(response);
            }
            self.sponsor
                .lock()
                .unwrap()
                .take()
                .ok_or_else(|| TunnelAnchorError::Unavailable("missing sponsor response".into()))
        }

        async fn execute_enoki(
            &self,
            digest: String,
            signature: String,
        ) -> Result<String, TunnelAnchorError> {
            *self.enoki_execute.lock().unwrap() = Some((digest, signature));
            self.enoki_digest.lock().unwrap().clone().ok_or_else(|| {
                TunnelAnchorError::Unavailable("missing enoki execute response".into())
            })
        }

        async fn settle(
            &self,
            _tunnel_id: String,
            body: Vec<u8>,
        ) -> Result<SettleResponse, TunnelAnchorError> {
            *self.settle_body.lock().unwrap() = Some(body);
            let tx_digest =
                self.settle_digest.lock().unwrap().clone().ok_or_else(|| {
                    TunnelAnchorError::Unavailable("missing settle response".into())
                })?;
            Ok(SettleResponse { tx_digest })
        }
    }

    fn test_bech32_key() -> String {
        let mut bytes = vec![ED25519_SCHEME_FLAG];
        bytes.extend([7u8; 32]);
        bech32::encode(
            SUI_PRIVATE_KEY_HRP,
            bytes.to_base32(),
            bech32::Variant::Bech32,
        )
        .expect("encode test key")
    }

    fn config() -> SuiSponsoredAnchorConfig {
        SuiSponsoredAnchorConfig {
            rpc_url: "http://rpc.invalid".into(),
            backend_url: "http://backend.invalid".into(),
            package_id: "0x2".into(),
            tunnel_coin_type: "0x2::sui::SUI".into(),
            open_mode: SuiOpenMode::SponsoredCreateAndFund,
            settle_mode: SuiSettleMode::BackendSettle,
            funding_profile: SuiFundingProfile::SingleFunder {
                priv_key: test_bech32_key(),
                stake_source: SuiStakeSource::CoinObject {
                    coin_id: "0x7".into(),
                },
            },
            open_batching: SuiOpenBatchingConfig::default(),
            settle_batching: SuiOpenBatchingConfig {
                max_batch_size: MAX_SPONSORED_SETTLE_BATCH_SIZE,
                ..Default::default()
            },
        }
    }

    fn address_balance_config() -> SuiSponsoredAnchorConfig {
        SuiSponsoredAnchorConfig {
            funding_profile: SuiFundingProfile::SingleFunder {
                priv_key: test_bech32_key(),
                stake_source: SuiStakeSource::AddressBalance,
            },
            ..config()
        }
    }

    fn test_transaction() -> Transaction {
        Transaction {
            kind: TransactionKind::ProgrammableTransaction(ProgrammableTransaction {
                inputs: Vec::new(),
                commands: Vec::new(),
            }),
            sender: Address::ZERO,
            gas_payment: GasPayment {
                objects: Vec::new(),
                owner: Address::ZERO,
                price: 1,
                budget: 1,
            },
            expiration: TransactionExpiration::None,
        }
    }

    fn object_ref(id: Address) -> ObjectReference {
        ObjectReference::new(id, 1, Digest::ZERO)
    }

    fn assert_address_balance_gas_transaction(chain: &FakeChain, owner: Address) {
        assert!(
            chain.gas_selection.lock().unwrap().is_none(),
            "direct modes must not select explicit gas coins"
        );
        let tx = chain
            .executed_transaction
            .lock()
            .unwrap()
            .clone()
            .expect("executed transaction");
        assert!(tx.gas_payment.objects.is_empty());
        assert_eq!(tx.gas_payment.owner, owner);
        assert_eq!(tx.gas_payment.budget, DEFAULT_DIRECT_GAS_BUDGET_MIST);
        assert!(matches!(
            tx.expiration,
            TransactionExpiration::ValidDuring {
                min_epoch: Some(7),
                max_epoch: Some(7),
                chain: Digest::ZERO,
                ..
            }
        ));
    }

    fn executed_move_call_count(chain: &FakeChain, function_name: &str) -> usize {
        let tx = chain
            .executed_transaction
            .lock()
            .unwrap()
            .clone()
            .expect("executed transaction");
        let TransactionKind::ProgrammableTransaction(ptb) = tx.kind else {
            panic!("expected PTB");
        };
        ptb.commands
            .iter()
            .filter(|command| {
                matches!(
                    command,
                    Command::MoveCall(call) if call.function.as_str() == function_name
                )
            })
            .count()
    }

    fn sponsored_kind_move_call_count(backend: &FakeBackend, function_name: &str) -> usize {
        let tx_kind_bytes = backend
            .tx_kind_bytes
            .lock()
            .unwrap()
            .clone()
            .expect("sponsored tx kind");
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(tx_kind_bytes)
            .expect("decode tx kind");
        let kind: TransactionKind = bcs::from_bytes(&bytes).expect("tx kind bcs");
        let TransactionKind::ProgrammableTransaction(ptb) = kind else {
            panic!("expected PTB");
        };
        ptb.commands
            .iter()
            .filter(|command| {
                matches!(
                    command,
                    Command::MoveCall(call) if call.function.as_str() == function_name
                )
            })
            .count()
    }

    fn tunnel_object(id: Address) -> Object {
        tunnel_object_with_contents(id, {
            let mut contents = id.into_inner().to_vec();
            contents.extend([0u8; 8]);
            contents
        })
    }

    fn tunnel_object_for_request(id: Address, request: &TunnelOpenRequest) -> Object {
        let mut contents = id.into_inner().to_vec();
        contents.extend(1u64.to_le_bytes());
        contents.extend(
            Ed25519PublicKey::new(request.party_a)
                .derive_address()
                .into_inner(),
        );
        contents.extend(bcs::to_bytes(&request.party_a.to_vec()).unwrap());
        contents.push(ED25519_SCHEME_FLAG);
        contents.extend(
            Ed25519PublicKey::new(request.party_b)
                .derive_address()
                .into_inner(),
        );
        contents.extend(bcs::to_bytes(&request.party_b.to_vec()).unwrap());
        contents.push(ED25519_SCHEME_FLAG);
        tunnel_object_with_contents(id, contents)
    }

    fn tunnel_object_with_contents(_id: Address, contents: Vec<u8>) -> Object {
        let tag = StructTag::new(
            Address::TWO,
            Identifier::new("tunnel").unwrap(),
            Identifier::new("Tunnel").unwrap(),
            vec![StructTag::sui().into()],
        );
        let move_struct = MoveStruct::new(tag, false, 1, contents).expect("valid move object");
        Object::new(
            ObjectData::Struct(move_struct),
            Owner::Shared(1),
            Digest::ZERO,
            0,
        )
    }

    fn success_effects(tunnel_id: Address) -> TransactionEffects {
        success_effects_with_created(vec![tunnel_id])
    }

    fn success_effects_with_created(tunnel_ids: Vec<Address>) -> TransactionEffects {
        let created = tunnel_ids
            .into_iter()
            .map(|tunnel_id| ObjectReferenceWithOwner {
                reference: object_ref(tunnel_id),
                owner: Owner::Shared(1),
            })
            .collect();
        let gas_object = ObjectReferenceWithOwner {
            reference: object_ref(Address::ZERO),
            owner: Owner::Address(Address::ZERO),
        };
        TransactionEffects::V1(Box::new(TransactionEffectsV1 {
            status: ExecutionStatus::Success,
            epoch: 0,
            gas_used: GasCostSummary::default(),
            modified_at_versions: Vec::new(),
            consensus_objects: Vec::new(),
            transaction_digest: Digest::ZERO,
            created,
            mutated: Vec::new(),
            unwrapped: Vec::new(),
            deleted: Vec::new(),
            unwrapped_then_deleted: Vec::new(),
            wrapped: Vec::new(),
            gas_object,
            events_digest: None,
            dependencies: Vec::new(),
        }))
    }

    fn failed_effects() -> TransactionEffects {
        let gas_object = ObjectReferenceWithOwner {
            reference: object_ref(Address::ZERO),
            owner: Owner::Address(Address::ZERO),
        };
        TransactionEffects::V1(Box::new(TransactionEffectsV1 {
            status: ExecutionStatus::Failure {
                error: ExecutionError::InsufficientGas,
                command: None,
            },
            epoch: 0,
            gas_used: GasCostSummary::default(),
            modified_at_versions: Vec::new(),
            consensus_objects: Vec::new(),
            transaction_digest: Digest::ZERO,
            created: Vec::new(),
            mutated: Vec::new(),
            unwrapped: Vec::new(),
            deleted: Vec::new(),
            unwrapped_then_deleted: Vec::new(),
            wrapped: Vec::new(),
            gas_object,
            events_digest: None,
            dependencies: Vec::new(),
        }))
    }

    fn anchor_with(
        chain: Arc<FakeChain>,
        backend: Arc<FakeBackend>,
    ) -> Result<SuiSponsoredAnchor, TunnelAnchorError> {
        SuiSponsoredAnchor::with_clients(config(), chain, backend)
    }

    fn intent(byte: u8) -> SuiOpenIntentId {
        SuiOpenIntentId::from_bytes([byte; 32])
    }

    fn scoped_anchor(anchor: SuiSponsoredAnchor, byte: u8) -> SuiOpenIntentAnchor {
        Arc::new(anchor).for_open_intent(intent(byte))
    }

    fn scoped_pair(anchor: SuiSponsoredAnchor) -> (SuiOpenIntentAnchor, SuiOpenIntentAnchor) {
        let shared = Arc::new(anchor);
        (
            shared.for_open_intent(intent(1)),
            shared.for_open_intent(intent(2)),
        )
    }

    fn open_request_with_secrets(
        party_a_secret: [u8; 32],
        party_b_secret: [u8; 32],
        initial: Balances,
    ) -> TunnelOpenRequest {
        let signer_a = LocalSigner::from_secret(&party_a_secret);
        let signer_b = LocalSigner::from_secret(&party_b_secret);
        TunnelOpenRequest {
            protocol: ProtocolId::parse("blackjack.bet.v1").unwrap(),
            party_a: signer_a.public_key(),
            party_b: signer_b.public_key(),
            initial,
        }
    }

    fn open_request() -> TunnelOpenRequest {
        open_request_with_secrets([1u8; 32], [2u8; 32], Balances { a: 7, b: 3 })
    }

    fn open_request_with_protocol(protocol: &str) -> TunnelOpenRequest {
        let mut request = open_request();
        request.protocol = ProtocolId::parse(protocol).unwrap();
        request
    }

    fn prepared_settle(tunnel_id: impl Into<String>) -> PreparedSettle {
        PreparedSettle {
            tunnel_id: tunnel_id.into(),
            party_a_balance: 7,
            party_b_balance: 3,
            timestamp: 1234,
            root: [0xaa; 32],
            sig_a: [0x11; 64],
            sig_b: [0x22; 64],
        }
    }

    fn programmable(kind: TransactionKind) -> ProgrammableTransaction {
        match kind {
            TransactionKind::ProgrammableTransaction(ptb) => ptb,
            other => panic!("expected PTB, got {other:?}"),
        }
    }

    #[test]
    fn direct_ptb_default_gas_budget_is_large_enough_for_batches() {
        const { assert!(DEFAULT_DIRECT_GAS_BUDGET_MIST >= 1_000_000_000) };
    }

    #[test]
    fn open_batch_deadline_waits_from_newest_item() {
        let now = Instant::now();
        let (responder_a, _receiver_a) = oneshot::channel();
        let (responder_b, _receiver_b) = oneshot::channel();
        let items = vec![
            OpenBatchItem {
                key: OpenKey {
                    intent_id: intent(1),
                },
                request: open_request(),
                responder: responder_a,
                enqueued_at: now,
            },
            OpenBatchItem {
                key: OpenKey {
                    intent_id: intent(2),
                },
                request: open_request(),
                responder: responder_b,
                enqueued_at: now + Duration::from_millis(10),
            },
        ];
        let config = SuiOpenBatchingConfig {
            enabled: true,
            max_batch_size: 255,
            flush_interval_ms: 25,
        };

        assert_eq!(
            open_batch_deadline(&items, &config),
            now + Duration::from_millis(35)
        );
    }

    #[test]
    fn settle_batch_default_limit_is_681() {
        let config = config();

        assert_eq!(config.open_batching.max_batch_size, 255);
        assert_eq!(config.settle_batching.max_batch_size, 681);
    }

    #[test]
    fn settle_batch_deadline_waits_from_newest_item() {
        let now = Instant::now();
        let (responder_a, _receiver_a) = oneshot::channel();
        let (responder_b, _receiver_b) = oneshot::channel();
        let items = vec![
            SettleBatchItem {
                prepared: prepared_settle("0x1"),
                responder: responder_a,
                enqueued_at: now,
            },
            SettleBatchItem {
                prepared: prepared_settle("0x2"),
                responder: responder_b,
                enqueued_at: now + Duration::from_millis(10),
            },
        ];
        let config = SuiOpenBatchingConfig {
            enabled: true,
            max_batch_size: 681,
            flush_interval_ms: 25,
        };

        assert_eq!(
            settle_batch_deadline(&items, &config),
            now + Duration::from_millis(35)
        );
    }

    #[tokio::test]
    async fn settle_batch_rejects_more_than_681_prepared_requests() {
        let anchor = SuiSponsoredAnchor::with_clients(
            config(),
            Arc::new(FakeChain::default()),
            Arc::new(FakeBackend::default()),
        )
        .expect("anchor");
        let prepared = (0..=MAX_SPONSORED_SETTLE_BATCH_SIZE)
            .map(|index| prepared_settle(format!("0x{:x}", index + 1)))
            .collect::<Vec<_>>();

        let error = anchor
            .build_batched_settle_kind(&prepared)
            .await
            .expect_err("oversized settle batch should be rejected");

        assert!(
            matches!(
                error,
                TunnelAnchorError::Rejected(ref message)
                    if message.contains("settle batch") && message.contains("too large")
            ),
            "{error:?}"
        );
    }

    #[test]
    fn address_balance_open_kind_redeems_sender_funds_without_stake_coin_object() {
        let chain = Arc::new(FakeChain::default());
        let backend = Arc::new(FakeBackend::default());
        let anchor = SuiSponsoredAnchor::with_clients(address_balance_config(), chain, backend)
            .expect("anchor");
        let request = open_request();

        let ptb = programmable(anchor.build_open_kind(&request).expect("open kind"));
        assert!(matches!(
            ptb.inputs.first(),
            Some(Input::FundsWithdrawal(withdrawal))
                if withdrawal.source() == WithdrawFrom::Sender
                    && withdrawal.amount() == Some(request.initial.sum())
        ));
        assert!(!ptb
            .inputs
            .iter()
            .any(|input| matches!(input, Input::ImmutableOrOwned(_))));
        assert!(matches!(
            &ptb.commands[0],
            Command::MoveCall(call)
                if call.package == Address::TWO
                    && call.module.as_str() == "coin"
                    && call.function.as_str() == "redeem_funds"
        ));
        assert!(matches!(
            &ptb.commands[1],
            Command::SplitCoins(split) if split.coin == Argument::Result(0)
        ));
        assert!(ptb.commands.iter().any(|command| matches!(
            command,
            Command::MoveCall(call)
                if call.package == Address::TWO
                    && call.module.as_str() == "coin"
                    && call.function.as_str() == "destroy_zero"
        )));
    }

    #[test]
    fn address_balance_batch_open_kind_redeems_total_sender_funds_once() {
        let chain = Arc::new(FakeChain::default());
        let backend = Arc::new(FakeBackend::default());
        let anchor = SuiSponsoredAnchor::with_clients(address_balance_config(), chain, backend)
            .expect("anchor");
        let req_a = open_request_with_secrets([1u8; 32], [2u8; 32], Balances { a: 7, b: 3 });
        let req_b = open_request_with_secrets([3u8; 32], [4u8; 32], Balances { a: 11, b: 5 });
        let total = req_a.initial.sum() + req_b.initial.sum();

        let ptb = programmable(
            anchor
                .build_batched_open_kind(&[req_a, req_b])
                .expect("batched kind"),
        );
        assert!(matches!(
            ptb.inputs.first(),
            Some(Input::FundsWithdrawal(withdrawal))
                if withdrawal.source() == WithdrawFrom::Sender
                    && withdrawal.amount() == Some(total)
        ));
        assert!(matches!(
            &ptb.commands[0],
            Command::MoveCall(call)
                if call.package == Address::TWO
                    && call.module.as_str() == "coin"
                    && call.function.as_str() == "redeem_funds"
        ));
        assert!(matches!(
            &ptb.commands[1],
            Command::SplitCoins(split)
                if split.coin == Argument::Result(0) && split.amounts.len() == 4
        ));
        let create_calls = ptb
            .commands
            .iter()
            .filter(|command| {
                matches!(
                    command,
                    Command::MoveCall(call)
                        if call.module.as_str() == "tunnel"
                            && call.function.as_str() == "create_and_fund"
                )
            })
            .count();
        assert_eq!(create_calls, 2);
    }

    fn settler_open_fixture(
        tunnel_id: Address,
        created_at_ms: u64,
    ) -> (Arc<FakeChain>, Arc<FakeBackend>) {
        let tx = test_transaction();
        let sponsor_key = Ed25519PrivateKey::new([8u8; 32]);
        let sponsor_signature = sponsor_key.sign_transaction(&tx).unwrap().to_base64();
        let chain = Arc::new(FakeChain::default());
        *chain.object_ref.lock().unwrap() = Some(object_ref(Address::from_str("0x7").unwrap()));
        chain
            .objects
            .lock()
            .unwrap()
            .insert(tunnel_id, tunnel_object(tunnel_id));
        *chain.effects.lock().unwrap() = Some(success_effects(tunnel_id));
        *chain.transaction_timestamp_ms.lock().unwrap() = Some(created_at_ms);

        let backend = Arc::new(FakeBackend::default());
        *backend.sponsor.lock().unwrap() = Some(SponsorResponse {
            provider: "settler".into(),
            tx_bytes: base64::engine::general_purpose::STANDARD.encode(bcs::to_bytes(&tx).unwrap()),
            sponsor_signature: Some(sponsor_signature),
            digest: None,
        });

        (chain, backend)
    }

    // Plain `#[test]` (no Tokio runtime) on purpose: the bench builds the anchor
    // from a sync `main`, so the gRPC client must construct without a running
    // runtime. Eager tonic channel creation here would panic — this guards the
    // lazy `OnceCell` init that keeps `new` runtime-free.
    #[test]
    fn grpc_chain_client_constructs_without_tokio_runtime() {
        let client = GrpcSuiChainClient::new("http://127.0.0.1:1");
        assert!(client.is_ok());
    }

    // Opt-in live integration smoke against a real Sui testnet fullnode. Excluded
    // from the default suite (network IO, non-deterministic); run explicitly:
    //   cargo test -p sui-tunnel-anchor --ignored grpc_smoke_reads_live_testnet
    // Exercises every read path + the proto -> sui_sdk_types conversions and the
    // read masks that can only be validated against a node.
    #[tokio::test]
    #[ignore = "hits the live Sui testnet fullnode; run with --ignored"]
    async fn grpc_smoke_reads_live_testnet() {
        let client = GrpcSuiChainClient::new("https://mysten-rpc.testnet.sui.io:443")
            .expect("construct grpc client");
        let clock: Address = CLOCK_ADDRESS.parse().expect("clock address");

        // get_object_ref: default read mask (object_id,version,digest) + digest parse.
        let clock_ref = client.get_object_ref(clock).await.expect("get_object_ref");
        assert_eq!(clock_ref.object_id(), &clock);
        assert!(clock_ref.version() > 0, "clock must have a real version");

        // get_object: full read mask + proto -> sui_sdk_types::Object conversion.
        let clock_obj = client
            .get_object(clock)
            .await
            .expect("get_object")
            .expect("clock object exists");

        // The clock is touched every checkpoint, so its previous transaction is a
        // real, recently-checkpointed digest — ideal for the transaction reads.
        let digest = clock_obj.previous_transaction().to_string();

        // get_transaction_effects: the TryFrom needs effects.bcs in the response,
        // which the parent "effects" mask path must pull in.
        client
            .get_transaction_effects(&digest)
            .await
            .expect("get_transaction_effects")
            .expect("effects for the clock's previous tx");

        // get_transaction_timestamp_ms: checkpoint timestamp present + sane (epoch-ms).
        let ts = client
            .get_transaction_timestamp_ms(&digest)
            .await
            .expect("get_transaction_timestamp_ms")
            .expect("timestamp present");
        assert!(
            ts > 1_600_000_000_000,
            "timestamp should be epoch-ms after 2020"
        );

        // NotFound mapping: a nonexistent object id resolves to Ok(None), not Err.
        let missing: Address = "0x00000000000000000000000000000000000000000000000000000000deadbeef"
            .parse()
            .expect("missing address");
        assert!(client
            .get_object(missing)
            .await
            .expect("get_object missing")
            .is_none());
    }

    // Opt-in live reproduction of the fleet-bench wiring: one shared client and
    // one shared multi-threaded runtime, with many OS threads each blocking on a
    // chain read concurrently. Guards the channel-affinity hazard — a single
    // tonic channel cached in the client must serve every worker, not strand on
    // whichever thread built it. A multi-threaded runtime (the bench's choice)
    // keeps the channel's background task always polled; the per-call timeout
    // turns a regression (stranded channel) into a fast failure instead of a hang.
    #[test]
    #[ignore = "hits the live Sui testnet fullnode; run with --ignored"]
    fn grpc_shared_channel_serves_concurrent_workers() {
        let runtime = std::sync::Arc::new(
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .worker_threads(2)
                .build()
                .expect("runtime"),
        );
        let client = Arc::new(
            GrpcSuiChainClient::new("https://mysten-rpc.testnet.sui.io:443").expect("client"),
        );
        let clock: Address = CLOCK_ADDRESS.parse().expect("clock address");

        let workers: Vec<_> = (0..8)
            .map(|_| {
                let runtime = runtime.clone();
                let client = client.clone();
                std::thread::spawn(move || {
                    runtime.block_on(async {
                        tokio::time::timeout(Duration::from_secs(20), client.get_object_ref(clock))
                            .await
                            .expect("chain read did not strand")
                            .expect("get_object_ref")
                    })
                })
            })
            .collect();

        for worker in workers {
            let object_ref = worker.join().expect("worker thread");
            assert_eq!(object_ref.object_id(), &clock);
            assert!(object_ref.version() > 0);
        }
    }

    #[test]
    fn decodes_sui_bech32_ed25519_private_key() {
        let encoded = test_bech32_key();
        let key = decode_sui_ed25519_bech32_private_key(&encoded).expect("decode key");
        assert_eq!(
            key.public_key(),
            Ed25519PrivateKey::new([7u8; 32]).public_key()
        );
    }

    #[test]
    fn batched_open_kind_uses_one_split_and_one_move_call_per_tunnel() {
        let chain = Arc::new(FakeChain::default());
        let backend = Arc::new(FakeBackend::default());
        let anchor = anchor_with(chain, backend).expect("anchor");
        let stake_ref = object_ref(Address::from_str("0x7").unwrap());
        let requests = vec![
            open_request_with_secrets([1u8; 32], [2u8; 32], Balances { a: 7, b: 3 }),
            open_request_with_secrets([3u8; 32], [4u8; 32], Balances { a: 11, b: 5 }),
        ];
        let kind = anchor
            .build_batched_open_kind_from_coin_object(&requests, stake_ref)
            .expect("kind");
        let TransactionKind::ProgrammableTransaction(ptb) = kind else {
            panic!("expected programmable transaction");
        };
        assert_eq!(ptb.commands.len(), 3);
        assert!(matches!(ptb.commands[0], Command::SplitCoins(_)));
        assert!(matches!(ptb.commands[1], Command::MoveCall(_)));
        assert!(matches!(ptb.commands[2], Command::MoveCall(_)));
    }

    #[tokio::test]
    async fn settler_sponsored_open_executes_with_grpc_and_extracts_tunnel_id() {
        let tunnel_id = Address::from_str("0x42").unwrap();
        let (chain, backend) = settler_open_fixture(tunnel_id, 1_770_000_000_123);

        let shared = Arc::new(anchor_with(chain.clone(), backend.clone()).expect("anchor"));
        let anchor = shared.for_open_intent(intent(1));
        let opened = anchor.open(open_request()).await.expect("open");

        assert_eq!(opened.tunnel_id, tunnel_id.to_string());
        assert_eq!(opened.created_at_ms, Some(1_770_000_000_123));
        assert_eq!(
            *chain.timestamp_digest_read.lock().unwrap(),
            Some(Digest::ZERO.to_string())
        );
        assert_eq!(*chain.execute_signature_count.lock().unwrap(), Some(2));
        assert!(backend.tx_kind_bytes.lock().unwrap().as_ref().is_some());
        assert_eq!(
            *backend.sponsor_sender.lock().unwrap(),
            Some(shared.funder_address().to_string())
        );
    }

    #[tokio::test]
    async fn disabled_open_batching_config_preserves_single_open_behavior() {
        let tunnel_id = Address::from_str("0x42").unwrap();
        let (chain, backend) = settler_open_fixture(tunnel_id, 1_770_000_000_123);

        let mut config = config();
        config.open_batching = SuiOpenBatchingConfig {
            enabled: false,
            ..Default::default()
        };
        let anchor = scoped_anchor(
            SuiSponsoredAnchor::with_clients(config, chain.clone(), backend).expect("anchor"),
            1,
        );
        let opened = anchor.open(open_request()).await.expect("open");

        assert_eq!(opened.tunnel_id, tunnel_id.to_string());
        assert_eq!(opened.created_at_ms, Some(1_770_000_000_123));
        assert_eq!(*chain.execute_signature_count.lock().unwrap(), Some(2));
    }

    #[tokio::test]
    async fn direct_open_executes_with_funder_gas_and_skips_sponsor_api() {
        let tunnel_id = Address::from_str("0x42").unwrap();
        let chain = Arc::new(FakeChain::default());
        chain
            .objects
            .lock()
            .unwrap()
            .insert(tunnel_id, tunnel_object(tunnel_id));
        *chain.effects.lock().unwrap() = Some(success_effects(tunnel_id));
        *chain.transaction_timestamp_ms.lock().unwrap() = Some(1_770_000_000_123);

        let backend = Arc::new(FakeBackend::default());
        let mut config = config();
        config.open_mode = SuiOpenMode::DirectCreateAndFund;
        config.open_batching = SuiOpenBatchingConfig {
            enabled: false,
            ..Default::default()
        };
        let shared = Arc::new(
            SuiSponsoredAnchor::with_clients(config, chain.clone(), backend.clone())
                .expect("anchor"),
        );
        let anchor = shared.for_open_intent(intent(1));

        let opened = anchor.open(open_request()).await.expect("open");

        assert_eq!(opened.tunnel_id, tunnel_id.to_string());
        assert_eq!(*backend.sponsor_call_count.lock().unwrap(), 0);
        assert_eq!(*chain.execute_signature_count.lock().unwrap(), Some(1));
        assert_eq!(executed_move_call_count(&chain, "redeem_funds"), 1);
        assert_eq!(executed_move_call_count(&chain, "create_and_fund"), 1);
        assert_address_balance_gas_transaction(&chain, shared.funder_address());
    }

    #[tokio::test]
    async fn direct_open_batches_create_and_fund_ptbs() {
        let first_tunnel = Address::from_str("0x42").unwrap();
        let second_tunnel = Address::from_str("0x43").unwrap();
        let first_request =
            open_request_with_secrets([1u8; 32], [2u8; 32], Balances { a: 7, b: 3 });
        let second_request =
            open_request_with_secrets([3u8; 32], [4u8; 32], Balances { a: 11, b: 5 });

        let chain = Arc::new(FakeChain::default());
        chain.objects.lock().unwrap().insert(
            first_tunnel,
            tunnel_object_for_request(first_tunnel, &first_request),
        );
        chain.objects.lock().unwrap().insert(
            second_tunnel,
            tunnel_object_for_request(second_tunnel, &second_request),
        );
        *chain.effects.lock().unwrap() = Some(success_effects_with_created(vec![
            first_tunnel,
            second_tunnel,
        ]));
        *chain.transaction_timestamp_ms.lock().unwrap() = Some(1_770_000_000_123);

        let backend = Arc::new(FakeBackend::default());
        let mut config = config();
        config.open_mode = SuiOpenMode::DirectCreateAndFund;
        config.open_batching = SuiOpenBatchingConfig {
            enabled: true,
            max_batch_size: 2,
            flush_interval_ms: 60_000,
        };
        let shared = Arc::new(
            SuiSponsoredAnchor::with_clients(config, chain.clone(), backend.clone())
                .expect("anchor"),
        );
        let first_anchor = shared.for_open_intent(intent(1));
        let second_anchor = shared.for_open_intent(intent(2));

        let (first, second) = tokio::join!(
            first_anchor.open(first_request),
            second_anchor.open(second_request),
        );

        assert_eq!(
            first.expect("first open").tunnel_id,
            first_tunnel.to_string()
        );
        assert_eq!(
            second.expect("second open").tunnel_id,
            second_tunnel.to_string()
        );
        assert_eq!(*backend.sponsor_call_count.lock().unwrap(), 0);
        assert_eq!(*chain.execute_call_count.lock().unwrap(), 1);
        assert_eq!(*chain.execute_signature_count.lock().unwrap(), Some(1));
        assert_eq!(executed_move_call_count(&chain, "redeem_funds"), 1);
        assert_eq!(executed_move_call_count(&chain, "create_and_fund"), 2);
        assert_address_balance_gas_transaction(&chain, shared.funder_address());
    }

    #[tokio::test]
    async fn scoped_open_intent_distinguishes_same_parties_and_protocol() {
        let first_tunnel = Address::from_str("0x42").unwrap();
        let second_tunnel = Address::from_str("0x43").unwrap();
        let tx = test_transaction();
        let sponsor_key = Ed25519PrivateKey::new([8u8; 32]);
        let sponsor_signature = sponsor_key.sign_transaction(&tx).unwrap().to_base64();

        let chain = Arc::new(FakeChain::default());
        *chain.object_ref.lock().unwrap() = Some(object_ref(Address::from_str("0x7").unwrap()));
        chain
            .objects
            .lock()
            .unwrap()
            .insert(first_tunnel, tunnel_object(first_tunnel));
        chain
            .objects
            .lock()
            .unwrap()
            .insert(second_tunnel, tunnel_object(second_tunnel));
        chain
            .effects_queue
            .lock()
            .unwrap()
            .push_back(success_effects(first_tunnel));
        chain
            .effects_queue
            .lock()
            .unwrap()
            .push_back(success_effects(second_tunnel));
        *chain.transaction_timestamp_ms.lock().unwrap() = Some(1_770_000_000_123);

        let backend = Arc::new(FakeBackend::default());
        backend
            .sponsor_queue
            .lock()
            .unwrap()
            .push_back(SponsorResponse {
                provider: "settler".into(),
                tx_bytes: base64::engine::general_purpose::STANDARD
                    .encode(bcs::to_bytes(&tx).unwrap()),
                sponsor_signature: Some(sponsor_signature.clone()),
                digest: None,
            });
        backend
            .sponsor_queue
            .lock()
            .unwrap()
            .push_back(SponsorResponse {
                provider: "settler".into(),
                tx_bytes: base64::engine::general_purpose::STANDARD
                    .encode(bcs::to_bytes(&tx).unwrap()),
                sponsor_signature: Some(sponsor_signature),
                digest: None,
            });

        let shared = Arc::new(anchor_with(chain, backend.clone()).expect("anchor"));
        let first = shared
            .for_open_intent(intent(1))
            .open(open_request())
            .await
            .expect("first open");
        let second = shared
            .for_open_intent(intent(2))
            .open(open_request())
            .await
            .expect("second open");

        assert_ne!(first.tunnel_id, second.tunnel_id);
        assert_eq!(
            *backend.sponsor_call_count.lock().unwrap(),
            2,
            "distinct scoped intents must execute distinct opens"
        );
    }

    #[tokio::test]
    async fn repeated_scoped_intent_with_different_request_is_rejected() {
        let tunnel_id = Address::from_str("0x42").unwrap();
        let (chain, backend) = settler_open_fixture(tunnel_id, 1_770_000_000_123);
        let anchor = scoped_anchor(anchor_with(chain, backend).expect("anchor"), 1);

        let first = open_request();
        let _ = anchor.open(first).await.expect("first open");

        let mut changed = open_request();
        changed.initial = Balances { a: 700, b: 300 };
        let err = match anchor.open(changed).await {
            Ok(_) => panic!("changed request unexpectedly opened"),
            Err(err) => err,
        };

        assert!(matches!(
            err,
            TunnelAnchorError::Rejected(message) if message.contains("open intent reused")
        ));
    }

    #[tokio::test]
    async fn batched_open_resolves_each_caller_with_matching_tunnel_id() {
        let tx = test_transaction();
        let sponsor_key = Ed25519PrivateKey::new([8u8; 32]);
        let sponsor_signature = sponsor_key.sign_transaction(&tx).unwrap().to_base64();
        let tunnel_a = Address::from_str("0x42").unwrap();
        let tunnel_b = Address::from_str("0x43").unwrap();
        let req_a = open_request_with_secrets([1u8; 32], [2u8; 32], Balances { a: 7, b: 3 });
        let req_b = open_request_with_secrets([3u8; 32], [4u8; 32], Balances { a: 11, b: 5 });

        let chain = Arc::new(FakeChain::default());
        *chain.object_ref.lock().unwrap() = Some(object_ref(Address::from_str("0x7").unwrap()));
        chain
            .objects
            .lock()
            .unwrap()
            .insert(tunnel_a, tunnel_object_for_request(tunnel_a, &req_a));
        chain
            .objects
            .lock()
            .unwrap()
            .insert(tunnel_b, tunnel_object_for_request(tunnel_b, &req_b));
        *chain.effects.lock().unwrap() =
            Some(success_effects_with_created(vec![tunnel_a, tunnel_b]));
        *chain.transaction_timestamp_ms.lock().unwrap() = Some(1_770_000_000_789);

        let backend = Arc::new(FakeBackend::default());
        *backend.sponsor.lock().unwrap() = Some(SponsorResponse {
            provider: "settler".into(),
            tx_bytes: base64::engine::general_purpose::STANDARD.encode(bcs::to_bytes(&tx).unwrap()),
            sponsor_signature: Some(sponsor_signature),
            digest: None,
        });

        let mut config = config();
        config.open_batching = SuiOpenBatchingConfig {
            enabled: true,
            max_batch_size: 2,
            flush_interval_ms: 10_000,
        };
        let (anchor_a, anchor_b) = scoped_pair(
            SuiSponsoredAnchor::with_clients(config, chain, backend.clone()).expect("anchor"),
        );

        let (opened_a, opened_b) = tokio::join!(anchor_a.open(req_a), anchor_b.open(req_b));
        let opened_a = opened_a.expect("open a");
        let opened_b = opened_b.expect("open b");

        assert_eq!(opened_a.tunnel_id, tunnel_a.to_string());
        assert_eq!(opened_b.tunnel_id, tunnel_b.to_string());
        assert_eq!(*backend.sponsor_call_count.lock().unwrap(), 1);
    }

    #[tokio::test]
    async fn batched_open_maps_out_of_order_created_objects() {
        let tx = test_transaction();
        let sponsor_key = Ed25519PrivateKey::new([8u8; 32]);
        let sponsor_signature = sponsor_key.sign_transaction(&tx).unwrap().to_base64();
        let tunnel_a = Address::from_str("0x42").unwrap();
        let tunnel_b = Address::from_str("0x43").unwrap();
        let req_a = open_request_with_secrets([1u8; 32], [2u8; 32], Balances { a: 7, b: 3 });
        let req_b = open_request_with_secrets([3u8; 32], [4u8; 32], Balances { a: 11, b: 5 });

        let chain = Arc::new(FakeChain::default());
        *chain.object_ref.lock().unwrap() = Some(object_ref(Address::from_str("0x7").unwrap()));
        chain
            .objects
            .lock()
            .unwrap()
            .insert(tunnel_a, tunnel_object_for_request(tunnel_a, &req_a));
        chain
            .objects
            .lock()
            .unwrap()
            .insert(tunnel_b, tunnel_object_for_request(tunnel_b, &req_b));
        *chain.effects.lock().unwrap() =
            Some(success_effects_with_created(vec![tunnel_b, tunnel_a]));
        *chain.transaction_timestamp_ms.lock().unwrap() = Some(1_770_000_000_789);

        let backend = Arc::new(FakeBackend::default());
        *backend.sponsor.lock().unwrap() = Some(SponsorResponse {
            provider: "settler".into(),
            tx_bytes: base64::engine::general_purpose::STANDARD.encode(bcs::to_bytes(&tx).unwrap()),
            sponsor_signature: Some(sponsor_signature),
            digest: None,
        });

        let mut config = config();
        config.open_batching = SuiOpenBatchingConfig {
            enabled: true,
            max_batch_size: 2,
            flush_interval_ms: 10_000,
        };
        let (anchor_a, anchor_b) = scoped_pair(
            SuiSponsoredAnchor::with_clients(config, chain, backend.clone()).expect("anchor"),
        );

        let (opened_a, opened_b) = tokio::join!(anchor_a.open(req_a), anchor_b.open(req_b));
        let opened_a = opened_a.expect("open a");
        let opened_b = opened_b.expect("open b");

        assert_eq!(opened_a.tunnel_id, tunnel_a.to_string());
        assert_eq!(opened_b.tunnel_id, tunnel_b.to_string());
        assert_eq!(*backend.sponsor_call_count.lock().unwrap(), 1);
    }

    #[tokio::test]
    async fn batched_open_avoids_party_identity_ambiguous_requests() {
        let tx = test_transaction();
        let sponsor_key = Ed25519PrivateKey::new([8u8; 32]);
        let sponsor_signature = sponsor_key.sign_transaction(&tx).unwrap().to_base64();
        let sponsor_response = || SponsorResponse {
            provider: "settler".into(),
            tx_bytes: base64::engine::general_purpose::STANDARD.encode(bcs::to_bytes(&tx).unwrap()),
            sponsor_signature: Some(sponsor_signature.clone()),
            digest: None,
        };
        let tunnel_a = Address::from_str("0x42").unwrap();
        let tunnel_b = Address::from_str("0x43").unwrap();
        let req_a = open_request_with_protocol("blackjack.bet.v1");
        let req_b = open_request_with_protocol("poker.bet.v1");

        let chain = Arc::new(FakeChain::default());
        *chain.object_ref.lock().unwrap() = Some(object_ref(Address::from_str("0x7").unwrap()));
        chain
            .objects
            .lock()
            .unwrap()
            .insert(tunnel_a, tunnel_object_for_request(tunnel_a, &req_a));
        chain
            .objects
            .lock()
            .unwrap()
            .insert(tunnel_b, tunnel_object_for_request(tunnel_b, &req_b));
        chain
            .effects_queue
            .lock()
            .unwrap()
            .extend([success_effects(tunnel_a), success_effects(tunnel_b)]);
        *chain.transaction_timestamp_ms.lock().unwrap() = Some(1_770_000_000_789);

        let backend = Arc::new(FakeBackend::default());
        backend
            .sponsor_queue
            .lock()
            .unwrap()
            .extend([sponsor_response(), sponsor_response()]);

        let mut config = config();
        config.open_batching = SuiOpenBatchingConfig {
            enabled: true,
            max_batch_size: 2,
            flush_interval_ms: 10_000,
        };
        let (anchor_a, anchor_b) = scoped_pair(
            SuiSponsoredAnchor::with_clients(config, chain, backend.clone()).expect("anchor"),
        );

        let (opened_a, opened_b) = tokio::join!(anchor_a.open(req_a), anchor_b.open(req_b));
        let opened_a = opened_a.expect("open a");
        let opened_b = opened_b.expect("open b");

        assert_eq!(opened_a.tunnel_id, tunnel_a.to_string());
        assert_eq!(opened_b.tunnel_id, tunnel_b.to_string());
        assert_eq!(*backend.sponsor_call_count.lock().unwrap(), 2);
    }

    #[tokio::test]
    async fn batched_open_coalesces_duplicate_open_keys() {
        let tx = test_transaction();
        let sponsor_key = Ed25519PrivateKey::new([8u8; 32]);
        let sponsor_signature = sponsor_key.sign_transaction(&tx).unwrap().to_base64();
        let tunnel_id = Address::from_str("0x42").unwrap();

        let chain = Arc::new(FakeChain::default());
        *chain.object_ref.lock().unwrap() = Some(object_ref(Address::from_str("0x7").unwrap()));
        chain
            .objects
            .lock()
            .unwrap()
            .insert(tunnel_id, tunnel_object(tunnel_id));
        *chain.effects.lock().unwrap() = Some(success_effects(tunnel_id));
        *chain.transaction_timestamp_ms.lock().unwrap() = Some(1_770_000_000_999);

        let backend = Arc::new(FakeBackend::default());
        *backend.sponsor.lock().unwrap() = Some(SponsorResponse {
            provider: "settler".into(),
            tx_bytes: base64::engine::general_purpose::STANDARD.encode(bcs::to_bytes(&tx).unwrap()),
            sponsor_signature: Some(sponsor_signature),
            digest: None,
        });

        let mut config = config();
        config.open_batching = SuiOpenBatchingConfig {
            enabled: true,
            max_batch_size: 2,
            flush_interval_ms: 10_000,
        };
        let anchor = scoped_anchor(
            SuiSponsoredAnchor::with_clients(config, chain, backend.clone()).expect("anchor"),
            1,
        );
        let req_a = open_request();
        let req_b = open_request();

        let (opened_a, opened_b) = tokio::join!(anchor.open(req_a), anchor.open(req_b));
        let opened_a = opened_a.expect("open a");
        let opened_b = opened_b.expect("open b");

        assert_eq!(opened_a.tunnel_id, tunnel_id.to_string());
        assert_eq!(opened_b.tunnel_id, tunnel_id.to_string());
        assert_ne!(opened_a.created, opened_b.created);
        assert!(opened_a.created || opened_b.created);
        assert_eq!(*backend.sponsor_call_count.lock().unwrap(), 1);
    }

    #[tokio::test]
    async fn batched_open_splits_failed_batch() {
        let tx = test_transaction();
        let sponsor_key = Ed25519PrivateKey::new([8u8; 32]);
        let sponsor_signature = sponsor_key.sign_transaction(&tx).unwrap().to_base64();
        let sponsor_response = || SponsorResponse {
            provider: "settler".into(),
            tx_bytes: base64::engine::general_purpose::STANDARD.encode(bcs::to_bytes(&tx).unwrap()),
            sponsor_signature: Some(sponsor_signature.clone()),
            digest: None,
        };
        let tunnel_a = Address::from_str("0x42").unwrap();
        let req_a = open_request_with_secrets([1u8; 32], [2u8; 32], Balances { a: 7, b: 3 });
        let req_b = open_request_with_secrets([3u8; 32], [4u8; 32], Balances { a: 11, b: 5 });

        let chain = Arc::new(FakeChain::default());
        *chain.object_ref.lock().unwrap() = Some(object_ref(Address::from_str("0x7").unwrap()));
        chain
            .objects
            .lock()
            .unwrap()
            .insert(tunnel_a, tunnel_object_for_request(tunnel_a, &req_a));
        chain.effects_queue.lock().unwrap().extend([
            failed_effects(),
            success_effects(tunnel_a),
            failed_effects(),
        ]);
        *chain.transaction_timestamp_ms.lock().unwrap() = Some(1_770_000_000_789);

        let backend = Arc::new(FakeBackend::default());
        backend.sponsor_queue.lock().unwrap().extend([
            sponsor_response(),
            sponsor_response(),
            sponsor_response(),
        ]);

        let mut config = config();
        config.open_batching = SuiOpenBatchingConfig {
            enabled: true,
            max_batch_size: 2,
            flush_interval_ms: 10_000,
        };
        let (anchor_a, anchor_b) = scoped_pair(
            SuiSponsoredAnchor::with_clients(config, chain, backend.clone()).expect("anchor"),
        );

        let (opened_a, opened_b) = tokio::join!(anchor_a.open(req_a), anchor_b.open(req_b));

        assert_eq!(opened_a.unwrap().tunnel_id, tunnel_a.to_string());
        let Err(error_b) = opened_b else {
            panic!("open b unexpectedly succeeded");
        };
        assert!(matches!(error_b, TunnelAnchorError::Rejected(_)));
        assert_eq!(*backend.sponsor_call_count.lock().unwrap(), 3);
    }

    #[tokio::test]
    async fn batched_open_splits_retryable_sponsor_failures() {
        let tx = test_transaction();
        let sponsor_key = Ed25519PrivateKey::new([8u8; 32]);
        let sponsor_signature = sponsor_key.sign_transaction(&tx).unwrap().to_base64();
        let sponsor_response = || SponsorResponse {
            provider: "settler".into(),
            tx_bytes: base64::engine::general_purpose::STANDARD.encode(bcs::to_bytes(&tx).unwrap()),
            sponsor_signature: Some(sponsor_signature.clone()),
            digest: None,
        };
        let tunnel_a = Address::from_str("0x42").unwrap();
        let tunnel_b = Address::from_str("0x43").unwrap();
        let req_a = open_request_with_secrets([1u8; 32], [2u8; 32], Balances { a: 7, b: 3 });
        let req_b = open_request_with_secrets([3u8; 32], [4u8; 32], Balances { a: 11, b: 5 });

        let chain = Arc::new(FakeChain::default());
        *chain.object_ref.lock().unwrap() = Some(object_ref(Address::from_str("0x7").unwrap()));
        chain
            .objects
            .lock()
            .unwrap()
            .insert(tunnel_a, tunnel_object_for_request(tunnel_a, &req_a));
        chain
            .objects
            .lock()
            .unwrap()
            .insert(tunnel_b, tunnel_object_for_request(tunnel_b, &req_b));
        chain
            .effects_queue
            .lock()
            .unwrap()
            .extend([success_effects(tunnel_a), success_effects(tunnel_b)]);
        *chain.transaction_timestamp_ms.lock().unwrap() = Some(1_770_000_000_789);

        let backend = Arc::new(FakeBackend::default());
        backend.sponsor_results.lock().unwrap().extend([
            Err(TunnelAnchorError::Unavailable("rate limited".into())),
            Ok(sponsor_response()),
            Ok(sponsor_response()),
        ]);

        let mut config = config();
        config.open_batching = SuiOpenBatchingConfig {
            enabled: true,
            max_batch_size: 2,
            flush_interval_ms: 10_000,
        };
        let (anchor_a, anchor_b) = scoped_pair(
            SuiSponsoredAnchor::with_clients(config, chain, backend.clone()).expect("anchor"),
        );

        let (opened_a, opened_b) = tokio::join!(anchor_a.open(req_a), anchor_b.open(req_b));

        assert_eq!(opened_a.unwrap().tunnel_id, tunnel_a.to_string());
        assert_eq!(opened_b.unwrap().tunnel_id, tunnel_b.to_string());
        assert_eq!(*backend.sponsor_call_count.lock().unwrap(), 3);
    }

    #[tokio::test]
    async fn batched_open_does_not_retry_after_successful_batch_mapping_failure() {
        let tx = test_transaction();
        let sponsor_key = Ed25519PrivateKey::new([8u8; 32]);
        let sponsor_signature = sponsor_key.sign_transaction(&tx).unwrap().to_base64();
        let tunnel_a = Address::from_str("0x42").unwrap();
        let tunnel_b = Address::from_str("0x43").unwrap();
        let req_a = open_request_with_secrets([1u8; 32], [2u8; 32], Balances { a: 7, b: 3 });
        let req_b = open_request_with_secrets([3u8; 32], [4u8; 32], Balances { a: 11, b: 5 });

        let chain = Arc::new(FakeChain::default());
        *chain.object_ref.lock().unwrap() = Some(object_ref(Address::from_str("0x7").unwrap()));
        *chain.effects.lock().unwrap() =
            Some(success_effects_with_created(vec![tunnel_a, tunnel_b]));
        *chain.transaction_timestamp_ms.lock().unwrap() = Some(1_770_000_000_789);

        let backend = Arc::new(FakeBackend::default());
        *backend.sponsor.lock().unwrap() = Some(SponsorResponse {
            provider: "settler".into(),
            tx_bytes: base64::engine::general_purpose::STANDARD.encode(bcs::to_bytes(&tx).unwrap()),
            sponsor_signature: Some(sponsor_signature),
            digest: None,
        });

        let mut config = config();
        config.open_batching = SuiOpenBatchingConfig {
            enabled: true,
            max_batch_size: 2,
            flush_interval_ms: 10_000,
        };
        let (anchor_a, anchor_b) = scoped_pair(
            SuiSponsoredAnchor::with_clients(config, chain, backend.clone()).expect("anchor"),
        );

        let (opened_a, opened_b) = tokio::join!(anchor_a.open(req_a), anchor_b.open(req_b));

        assert!(opened_a.is_err());
        assert!(opened_b.is_err());
        assert_eq!(*backend.sponsor_call_count.lock().unwrap(), 1);
    }

    #[tokio::test]
    async fn enoki_sponsored_open_executes_through_backend_then_reads_transaction() {
        let tx = test_transaction();
        let tunnel_id = Address::from_str("0x43").unwrap();
        let chain = Arc::new(FakeChain::default());
        *chain.object_ref.lock().unwrap() = Some(object_ref(Address::from_str("0x7").unwrap()));
        chain
            .objects
            .lock()
            .unwrap()
            .insert(tunnel_id, tunnel_object(tunnel_id));
        *chain.transaction_effects.lock().unwrap() = Some(success_effects(tunnel_id));
        *chain.transaction_timestamp_ms.lock().unwrap() = Some(1_770_000_000_456);

        let backend = Arc::new(FakeBackend::default());
        *backend.sponsor.lock().unwrap() = Some(SponsorResponse {
            provider: "enoki".into(),
            tx_bytes: base64::engine::general_purpose::STANDARD.encode(bcs::to_bytes(&tx).unwrap()),
            sponsor_signature: None,
            digest: Some("HANDLE".into()),
        });
        *backend.enoki_digest.lock().unwrap() = Some("EXECUTED".into());

        let anchor = scoped_anchor(
            anchor_with(chain.clone(), backend.clone()).expect("anchor"),
            1,
        );
        let opened = anchor.open(open_request()).await.expect("open");

        assert_eq!(opened.tunnel_id, tunnel_id.to_string());
        assert_eq!(opened.created_at_ms, Some(1_770_000_000_456));
        assert_eq!(
            *chain.transaction_digest_read.lock().unwrap(),
            Some("EXECUTED".into())
        );
        assert_eq!(
            *chain.timestamp_digest_read.lock().unwrap(),
            Some(Digest::ZERO.to_string())
        );
        assert_eq!(
            backend
                .enoki_execute
                .lock()
                .unwrap()
                .as_ref()
                .map(|(digest, _)| digest.clone()),
            Some("HANDLE".into())
        );
    }

    #[test]
    fn paired_rootful_settlement_verifies_seat_signatures() {
        let signer_a = LocalSigner::from_secret(&[1u8; 32]);
        let signer_b = LocalSigner::from_secret(&[2u8; 32]);
        let record = OpenRecord {
            tunnel_id: "0x1".into(),
            party_a: signer_a.public_key(),
            party_b: signer_b.public_key(),
            onchain_nonce: 0,
            created_at_ms: 1_234,
            request: OpenRequestFingerprint {
                protocol: "blackjack.bet.v1".into(),
                party_a: signer_a.public_key(),
                party_b: signer_b.public_key(),
                initial: Balances { a: 7, b: 3 },
            },
        };

        let root = [0xaa; 32];
        let settlement = Settlement {
            tunnel_id: "0x1".into(),
            party_a_balance: 7,
            party_b_balance: 3,
            final_nonce: 1,
            timestamp: 1234,
        };
        let msg = serialize_settlement_with_root(&settlement, &root);
        let entry = tunnel_harness::TranscriptSettleEntry {
            message: vec![0x33; 4],
            sig_a: [0x44; 64],
            sig_b: [0x55; 64],
        };
        let half_a = TunnelSettleRequest {
            tunnel_id: "0x1".into(),
            by: Seat::A,
            party_a_balance: 7,
            party_b_balance: 3,
            final_nonce: 1,
            timestamp: 1234,
            signature: signer_a.sign(&msg),
            transcript_root: Some(root),
            transcript_entries: vec![entry.clone()],
        };
        let half_b = TunnelSettleRequest {
            tunnel_id: "0x1".into(),
            by: Seat::B,
            party_a_balance: 7,
            party_b_balance: 3,
            final_nonce: 1,
            timestamp: 1234,
            signature: signer_b.sign(&msg),
            transcript_root: Some(root),
            transcript_entries: vec![entry],
        };

        let (sig_a, sig_b) =
            verify_paired_settle(&half_a, &half_b, &record).expect("settlement verifies");
        assert_eq!(sig_a, signer_a.sign(&msg));
        assert_eq!(sig_b, signer_b.sign(&msg));
    }

    fn success_effects_with_nonzero_gas(tunnel_id: Address) -> TransactionEffects {
        let gas_object = ObjectReferenceWithOwner {
            reference: object_ref(Address::ZERO),
            owner: Owner::Address(Address::ZERO),
        };
        TransactionEffects::V1(Box::new(TransactionEffectsV1 {
            status: ExecutionStatus::Success,
            epoch: 0,
            gas_used: GasCostSummary {
                computation_cost: 500_000,
                storage_cost: 1_000_000,
                storage_rebate: 200_000,
                non_refundable_storage_fee: 0,
            },
            modified_at_versions: Vec::new(),
            consensus_objects: Vec::new(),
            transaction_digest: Digest::ZERO,
            created: vec![ObjectReferenceWithOwner {
                reference: object_ref(tunnel_id),
                owner: Owner::Shared(1),
            }],
            mutated: Vec::new(),
            unwrapped: Vec::new(),
            deleted: Vec::new(),
            unwrapped_then_deleted: Vec::new(),
            wrapped: Vec::new(),
            gas_object,
            events_digest: None,
            dependencies: Vec::new(),
        }))
    }

    fn paired_settle_requests(
        tunnel_id: &str,
    ) -> (
        TunnelSettleRequest,
        TunnelSettleRequest,
        LocalSigner,
        LocalSigner,
    ) {
        let signer_a = LocalSigner::from_secret(&[1u8; 32]);
        let signer_b = LocalSigner::from_secret(&[2u8; 32]);
        let root = [0xaa; 32];
        let settlement = Settlement {
            tunnel_id: tunnel_id.into(),
            party_a_balance: 7,
            party_b_balance: 3,
            final_nonce: 1,
            timestamp: 1234,
        };
        let msg = serialize_settlement_with_root(&settlement, &root);
        let entry = tunnel_harness::TranscriptSettleEntry {
            message: vec![0x33; 4],
            sig_a: [0x44; 64],
            sig_b: [0x55; 64],
        };
        let half_a = TunnelSettleRequest {
            tunnel_id: tunnel_id.into(),
            by: Seat::A,
            party_a_balance: 7,
            party_b_balance: 3,
            final_nonce: 1,
            timestamp: 1234,
            signature: signer_a.sign(&msg),
            transcript_root: Some(root),
            transcript_entries: vec![entry.clone()],
        };
        let half_b = TunnelSettleRequest {
            tunnel_id: tunnel_id.into(),
            by: Seat::B,
            party_a_balance: 7,
            party_b_balance: 3,
            final_nonce: 1,
            timestamp: 1234,
            signature: signer_b.sign(&msg),
            transcript_root: Some(root),
            transcript_entries: vec![entry],
        };
        (half_a, half_b, signer_a, signer_b)
    }

    fn insert_open_record(
        anchor: &SuiSponsoredAnchor,
        intent_id: SuiOpenIntentId,
        tunnel_id: &str,
        signer_a: &LocalSigner,
        signer_b: &LocalSigner,
    ) {
        anchor.inner.lock().unwrap().opens.insert(
            OpenKey { intent_id },
            OpenRecord {
                tunnel_id: tunnel_id.into(),
                party_a: signer_a.public_key(),
                party_b: signer_b.public_key(),
                onchain_nonce: 0,
                created_at_ms: 1_234,
                request: OpenRequestFingerprint {
                    protocol: "blackjack.bet.v1".into(),
                    party_a: signer_a.public_key(),
                    party_b: signer_b.public_key(),
                    initial: Balances { a: 7, b: 3 },
                },
            },
        );
    }

    #[tokio::test]
    async fn open_accumulates_gas_into_meter() {
        let tunnel_id = Address::from_str("0x42").unwrap();
        let tx = test_transaction();
        let sponsor_key = Ed25519PrivateKey::new([8u8; 32]);
        let sponsor_signature = sponsor_key.sign_transaction(&tx).unwrap().to_base64();

        let chain = Arc::new(FakeChain::default());
        *chain.object_ref.lock().unwrap() = Some(object_ref(Address::from_str("0x7").unwrap()));
        chain
            .objects
            .lock()
            .unwrap()
            .insert(tunnel_id, tunnel_object(tunnel_id));
        *chain.effects.lock().unwrap() = Some(success_effects_with_nonzero_gas(tunnel_id));
        *chain.transaction_timestamp_ms.lock().unwrap() = Some(1_000);

        let backend = Arc::new(FakeBackend::default());
        *backend.sponsor.lock().unwrap() = Some(SponsorResponse {
            provider: "settler".into(),
            tx_bytes: base64::engine::general_purpose::STANDARD.encode(bcs::to_bytes(&tx).unwrap()),
            sponsor_signature: Some(sponsor_signature),
            digest: None,
        });

        let mut config = config();
        config.open_batching = SuiOpenBatchingConfig {
            enabled: false,
            ..Default::default()
        };
        let shared =
            Arc::new(SuiSponsoredAnchor::with_clients(config, chain, backend).expect("anchor"));
        let anchor = shared.for_open_intent(intent(1));

        let before = shared.cost_snapshot();
        let _ = anchor.open(open_request()).await.expect("open");
        let after = shared.cost_snapshot();

        assert!(
            after.gas_funder_mist + after.gas_sponsor_mist
                > before.gas_funder_mist + before.gas_sponsor_mist,
            "meter must advance after open: before={:?} after={:?}",
            before,
            after,
        );
    }

    #[tokio::test]
    async fn settle_posts_ts_compatible_binary_body_to_backend() {
        let chain = Arc::new(FakeChain::default());
        let backend = Arc::new(FakeBackend::default());
        *backend.settle_digest.lock().unwrap() = Some("DiG".into());
        let shared = Arc::new(anchor_with(chain, backend.clone()).expect("anchor"));

        let signer_a = LocalSigner::from_secret(&[1u8; 32]);
        let signer_b = LocalSigner::from_secret(&[2u8; 32]);
        shared.inner.lock().unwrap().opens.insert(
            OpenKey {
                intent_id: intent(1),
            },
            OpenRecord {
                tunnel_id: "0x1".into(),
                party_a: signer_a.public_key(),
                party_b: signer_b.public_key(),
                onchain_nonce: 0,
                created_at_ms: 1_234,
                request: OpenRequestFingerprint {
                    protocol: "blackjack.bet.v1".into(),
                    party_a: signer_a.public_key(),
                    party_b: signer_b.public_key(),
                    initial: Balances { a: 7, b: 3 },
                },
            },
        );
        let anchor = shared.for_open_intent(intent(1));

        let root = [0xaa; 32];
        let settlement = Settlement {
            tunnel_id: "0x1".into(),
            party_a_balance: 7,
            party_b_balance: 3,
            final_nonce: 1,
            timestamp: 1234,
        };
        let msg = serialize_settlement_with_root(&settlement, &root);
        let entry = tunnel_harness::TranscriptSettleEntry {
            message: vec![0x33; 4],
            sig_a: [0x44; 64],
            sig_b: [0x55; 64],
        };
        let half_a = TunnelSettleRequest {
            tunnel_id: "0x1".into(),
            by: Seat::A,
            party_a_balance: 7,
            party_b_balance: 3,
            final_nonce: 1,
            timestamp: 1234,
            signature: signer_a.sign(&msg),
            transcript_root: Some(root),
            transcript_entries: vec![entry.clone()],
        };
        let half_b = TunnelSettleRequest {
            tunnel_id: "0x1".into(),
            by: Seat::B,
            party_a_balance: 7,
            party_b_balance: 3,
            final_nonce: 1,
            timestamp: 1234,
            signature: signer_b.sign(&msg),
            transcript_root: Some(root),
            transcript_entries: vec![entry],
        };

        let (a, b) = tokio::join!(anchor.settle(half_a), anchor.settle(half_b));
        assert_eq!(a.expect("settle A").digest, "DiG");
        assert_eq!(b.expect("settle B").digest, "DiG");
        let body = backend
            .settle_body
            .lock()
            .unwrap()
            .clone()
            .expect("settle body");
        assert_eq!(body[0], tunnel_core::wire::SETTLE_BODY_VERSION);
        assert_eq!(u64::from_be_bytes(body[33..41].try_into().unwrap()), 7);
        assert_eq!(u64::from_be_bytes(body[41..49].try_into().unwrap()), 3);
        assert_eq!(body[65..97], root);
        assert_eq!(u32::from_be_bytes(body[225..229].try_into().unwrap()), 1);
    }

    #[tokio::test]
    async fn sponsored_settle_builds_ptb_and_uses_sponsor_api() {
        let tunnel_id = Address::from_str("0x1").unwrap();
        let tx = test_transaction();
        let sponsor_key = Ed25519PrivateKey::new([8u8; 32]);
        let sponsor_signature = sponsor_key.sign_transaction(&tx).unwrap().to_base64();
        let chain = Arc::new(FakeChain::default());
        chain
            .objects
            .lock()
            .unwrap()
            .insert(tunnel_id, tunnel_object(tunnel_id));
        *chain.effects.lock().unwrap() = Some(success_effects_with_created(Vec::new()));

        let backend = Arc::new(FakeBackend::default());
        *backend.sponsor.lock().unwrap() = Some(SponsorResponse {
            provider: "settler".into(),
            tx_bytes: base64::engine::general_purpose::STANDARD.encode(bcs::to_bytes(&tx).unwrap()),
            sponsor_signature: Some(sponsor_signature),
            digest: None,
        });

        let mut config = config();
        config.settle_mode = SuiSettleMode::SponsoredSettle;
        let shared = Arc::new(
            SuiSponsoredAnchor::with_clients(config, chain.clone(), backend.clone())
                .expect("anchor"),
        );
        let (half_a, half_b, signer_a, signer_b) = paired_settle_requests("0x1");
        insert_open_record(&shared, intent(1), "0x1", &signer_a, &signer_b);
        let anchor = shared.for_open_intent(intent(1));

        let (a, b) = tokio::join!(anchor.settle(half_a), anchor.settle(half_b));

        assert_eq!(a.expect("settle A").digest, Digest::ZERO.to_string());
        assert_eq!(b.expect("settle B").digest, Digest::ZERO.to_string());
        assert_eq!(*backend.sponsor_call_count.lock().unwrap(), 1);
        assert!(backend.settle_body.lock().unwrap().is_none());
        assert_eq!(*chain.execute_signature_count.lock().unwrap(), Some(2));
        assert!(backend.tx_kind_bytes.lock().unwrap().as_ref().is_some());
    }

    #[tokio::test]
    async fn direct_settle_builds_ptb_and_executes_with_funder_signature() {
        let tunnel_id = Address::from_str("0x1").unwrap();
        let chain = Arc::new(FakeChain::default());
        chain
            .objects
            .lock()
            .unwrap()
            .insert(tunnel_id, tunnel_object(tunnel_id));
        *chain.effects.lock().unwrap() = Some(success_effects_with_created(Vec::new()));

        let backend = Arc::new(FakeBackend::default());
        let mut config = config();
        config.settle_mode = SuiSettleMode::DirectSettle;
        let shared = Arc::new(
            SuiSponsoredAnchor::with_clients(config, chain.clone(), backend.clone())
                .expect("anchor"),
        );
        let (half_a, half_b, signer_a, signer_b) = paired_settle_requests("0x1");
        insert_open_record(&shared, intent(1), "0x1", &signer_a, &signer_b);
        let anchor = shared.for_open_intent(intent(1));

        let (a, b) = tokio::join!(anchor.settle(half_a), anchor.settle(half_b));

        assert_eq!(a.expect("settle A").digest, Digest::ZERO.to_string());
        assert_eq!(b.expect("settle B").digest, Digest::ZERO.to_string());
        assert_eq!(*backend.sponsor_call_count.lock().unwrap(), 0);
        assert!(backend.settle_body.lock().unwrap().is_none());
        assert_eq!(*chain.execute_signature_count.lock().unwrap(), Some(1));
        assert_address_balance_gas_transaction(&chain, shared.funder_address());
    }

    #[tokio::test]
    async fn direct_settle_batches_multiple_ready_ptbs() {
        let first_tunnel = Address::from_str("0x1").unwrap();
        let second_tunnel = Address::from_str("0x2").unwrap();
        let chain = Arc::new(FakeChain::default());
        chain
            .objects
            .lock()
            .unwrap()
            .insert(first_tunnel, tunnel_object(first_tunnel));
        chain
            .objects
            .lock()
            .unwrap()
            .insert(second_tunnel, tunnel_object(second_tunnel));
        *chain.effects.lock().unwrap() = Some(success_effects_with_created(Vec::new()));

        let backend = Arc::new(FakeBackend::default());
        let mut config = config();
        config.settle_mode = SuiSettleMode::DirectSettle;
        config.settle_batching = SuiOpenBatchingConfig {
            enabled: true,
            max_batch_size: 2,
            flush_interval_ms: 60_000,
        };
        let shared = Arc::new(
            SuiSponsoredAnchor::with_clients(config, chain.clone(), backend.clone())
                .expect("anchor"),
        );
        let (first_a, first_b, first_signer_a, first_signer_b) = paired_settle_requests("0x1");
        let (second_a, second_b, second_signer_a, second_signer_b) = paired_settle_requests("0x2");
        insert_open_record(&shared, intent(1), "0x1", &first_signer_a, &first_signer_b);
        insert_open_record(
            &shared,
            intent(2),
            "0x2",
            &second_signer_a,
            &second_signer_b,
        );
        let first_anchor = shared.for_open_intent(intent(1));
        let second_anchor = shared.for_open_intent(intent(2));

        let (first_a, first_b, second_a, second_b) = tokio::join!(
            first_anchor.settle(first_a),
            first_anchor.settle(first_b),
            second_anchor.settle(second_a),
            second_anchor.settle(second_b),
        );

        assert_eq!(first_a.expect("first A").digest, Digest::ZERO.to_string());
        assert_eq!(first_b.expect("first B").digest, Digest::ZERO.to_string());
        assert_eq!(second_a.expect("second A").digest, Digest::ZERO.to_string());
        assert_eq!(second_b.expect("second B").digest, Digest::ZERO.to_string());
        assert_eq!(*backend.sponsor_call_count.lock().unwrap(), 0);
        assert_eq!(*chain.execute_call_count.lock().unwrap(), 1);
        assert_eq!(*chain.execute_signature_count.lock().unwrap(), Some(1));
        assert_eq!(
            executed_move_call_count(&chain, "entry_close_cooperative_with_root"),
            2
        );
        assert_address_balance_gas_transaction(&chain, shared.funder_address());
    }

    #[tokio::test]
    async fn sponsored_settle_batches_multiple_ready_ptbs() {
        let first_tunnel = Address::from_str("0x1").unwrap();
        let second_tunnel = Address::from_str("0x2").unwrap();
        let tx = test_transaction();
        let sponsor_key = Ed25519PrivateKey::new([8u8; 32]);
        let sponsor_signature = sponsor_key.sign_transaction(&tx).unwrap().to_base64();
        let chain = Arc::new(FakeChain::default());
        chain
            .objects
            .lock()
            .unwrap()
            .insert(first_tunnel, tunnel_object(first_tunnel));
        chain
            .objects
            .lock()
            .unwrap()
            .insert(second_tunnel, tunnel_object(second_tunnel));
        *chain.effects.lock().unwrap() = Some(success_effects_with_created(Vec::new()));

        let backend = Arc::new(FakeBackend::default());
        *backend.sponsor.lock().unwrap() = Some(SponsorResponse {
            provider: "settler".into(),
            tx_bytes: base64::engine::general_purpose::STANDARD.encode(bcs::to_bytes(&tx).unwrap()),
            sponsor_signature: Some(sponsor_signature),
            digest: None,
        });

        let mut config = config();
        config.settle_mode = SuiSettleMode::SponsoredSettle;
        config.settle_batching = SuiOpenBatchingConfig {
            enabled: true,
            max_batch_size: 2,
            flush_interval_ms: 60_000,
        };
        let shared = Arc::new(
            SuiSponsoredAnchor::with_clients(config, chain.clone(), backend.clone())
                .expect("anchor"),
        );
        let (first_a, first_b, first_signer_a, first_signer_b) = paired_settle_requests("0x1");
        let (second_a, second_b, second_signer_a, second_signer_b) = paired_settle_requests("0x2");
        insert_open_record(&shared, intent(1), "0x1", &first_signer_a, &first_signer_b);
        insert_open_record(
            &shared,
            intent(2),
            "0x2",
            &second_signer_a,
            &second_signer_b,
        );
        let first_anchor = shared.for_open_intent(intent(1));
        let second_anchor = shared.for_open_intent(intent(2));

        let (first_a, first_b, second_a, second_b) = tokio::join!(
            first_anchor.settle(first_a),
            first_anchor.settle(first_b),
            second_anchor.settle(second_a),
            second_anchor.settle(second_b),
        );

        assert_eq!(first_a.expect("first A").digest, Digest::ZERO.to_string());
        assert_eq!(first_b.expect("first B").digest, Digest::ZERO.to_string());
        assert_eq!(second_a.expect("second A").digest, Digest::ZERO.to_string());
        assert_eq!(second_b.expect("second B").digest, Digest::ZERO.to_string());
        assert_eq!(*backend.sponsor_call_count.lock().unwrap(), 1);
        assert_eq!(*chain.execute_call_count.lock().unwrap(), 1);
        assert_eq!(*chain.execute_signature_count.lock().unwrap(), Some(2));
        assert_eq!(
            sponsored_kind_move_call_count(&backend, "entry_close_cooperative_with_root"),
            2
        );
    }
}
