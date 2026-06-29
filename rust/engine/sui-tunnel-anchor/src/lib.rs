use std::collections::HashMap;
use std::str::FromStr;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use base64::Engine as _;
use bech32::FromBase32;
use serde::{Deserialize, Serialize};
use sui_crypto::ed25519::Ed25519PrivateKey;
use sui_crypto::SuiSigner;
use sui_graphql::Client as GraphQlClient;
use sui_sdk_types::{
    Address, Argument, Command, Ed25519PublicKey, ExecutionStatus, Identifier, Input, MoveCall,
    Object, ObjectOut, ObjectReference, ObjectType, ProgrammableTransaction, SharedInput,
    SplitCoins, StructTag, Transaction, TransactionEffects, TransactionKind, TypeTag,
    UserSignature,
};
use tokio::sync::oneshot;
use tunnel_core::crypto::verify;
use tunnel_core::wire::{encode_settle_body, SettleBodyEntry, Settlement};
use tunnel_harness::{
    Balances, OpenedTunnel, Seat, SettledTunnel, SettlementMode, TunnelAnchor, TunnelAnchorError,
    TunnelOpenRequest, TunnelSettleRequest,
};

const SUI_PRIVATE_KEY_HRP: &str = "suiprivkey";
const ED25519_SCHEME_FLAG: u8 = 0x00;
const CLOCK_ADDRESS: &str = "0x0000000000000000000000000000000000000000000000000000000000000006";
const DEFAULT_TIMEOUT_MS: u64 = 600_000;

#[derive(Clone, Debug)]
pub struct SuiTunnelAnchorConfig {
    pub graphql_url: String,
    pub backend_url: String,
    pub package_id: String,
    pub tunnel_coin_type: String,
    pub funder_priv_key: String,
    pub funder_stake_coin_id: String,
}

#[derive(Clone)]
pub struct SuiTunnelAnchor {
    config: SuiTunnelAnchorConfig,
    funder: Ed25519PrivateKey,
    funder_address: Address,
    chain: Arc<dyn SuiChainClient>,
    backend: Arc<dyn SuiBackendClient>,
    inner: Arc<Mutex<AnchorState>>,
}

#[derive(Default)]
struct AnchorState {
    opens: HashMap<OpenKey, OpenRecord>,
    pending_settles: HashMap<String, PendingSettle>,
    settled: HashMap<String, SettledTunnel>,
}

#[derive(Clone, Hash, PartialEq, Eq)]
struct OpenKey {
    protocol: String,
    party_a: [u8; 32],
    party_b: [u8; 32],
}

#[derive(Clone)]
struct OpenRecord {
    tunnel_id: String,
    party_a: [u8; 32],
    party_b: [u8; 32],
    onchain_nonce: u64,
    created_at_ms: u64,
}

struct PendingSettle {
    request: TunnelSettleRequest,
    responder: oneshot::Sender<Result<SettledTunnel, TunnelAnchorError>>,
}

#[async_trait]
pub trait SuiChainClient: Send + Sync {
    async fn get_object_ref(&self, object_id: Address) -> Result<ObjectReference, String>;
    async fn get_object(&self, object_id: Address) -> Result<Option<Object>, String>;
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

pub struct GraphQlSuiChainClient {
    endpoint: String,
    http: reqwest::Client,
    client: GraphQlClient,
}

impl GraphQlSuiChainClient {
    pub fn new(endpoint: &str) -> Result<Self, String> {
        Ok(Self {
            endpoint: endpoint.to_string(),
            http: reqwest::Client::new(),
            client: GraphQlClient::new(endpoint).map_err(|e| e.to_string())?,
        })
    }
}

#[async_trait]
impl SuiChainClient for GraphQlSuiChainClient {
    async fn get_object_ref(&self, object_id: Address) -> Result<ObjectReference, String> {
        #[derive(Serialize)]
        struct GraphQlRequest<'a> {
            query: &'a str,
            variables: serde_json::Value,
        }
        #[derive(Deserialize)]
        struct GraphQlResponse {
            data: Option<ObjectData>,
            errors: Option<serde_json::Value>,
        }
        #[derive(Deserialize)]
        struct ObjectData {
            object: Option<ObjectRefData>,
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct ObjectRefData {
            version: u64,
            digest: String,
        }

        let body = GraphQlRequest {
            query: "query($id: SuiAddress!) { object(address: $id) { version digest } }",
            variables: serde_json::json!({ "id": object_id }),
        };
        let resp = self
            .http
            .post(&self.endpoint)
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = resp.status();
        let json: GraphQlResponse = resp.json().await.map_err(|e| e.to_string())?;
        if !status.is_success() || json.errors.is_some() {
            return Err(format!("graphql object ref read failed: {:?}", json.errors));
        }
        let object = json
            .data
            .and_then(|d| d.object)
            .ok_or_else(|| format!("object {object_id} not found"))?;
        let digest = object.digest.parse().map_err(|e| format!("{e}"))?;
        Ok(ObjectReference::new(object_id, object.version, digest))
    }

    async fn get_object(&self, object_id: Address) -> Result<Option<Object>, String> {
        self.client
            .get_object(object_id)
            .await
            .map_err(|e| e.to_string())
    }

    async fn execute_transaction(
        &self,
        transaction: &Transaction,
        signatures: &[UserSignature],
    ) -> Result<TransactionEffects, String> {
        let result = self
            .client
            .execute_transaction(transaction, signatures)
            .await
            .map_err(|e| e.to_string())?;
        result
            .effects
            .ok_or_else(|| "graphql execute returned no effects".to_string())
    }

    async fn get_transaction_effects(
        &self,
        digest: &str,
    ) -> Result<Option<TransactionEffects>, String> {
        self.client
            .get_transaction(digest)
            .await
            .map(|maybe| maybe.map(|tx| tx.effects))
            .map_err(|e| e.to_string())
    }

    async fn get_transaction_timestamp_ms(&self, digest: &str) -> Result<Option<u64>, String> {
        self.client
            .get_transaction(digest)
            .await
            .map(|maybe| maybe.map(|tx| tx.timestamp.timestamp_millis() as u64))
            .map_err(|e| e.to_string())
    }
}

impl SuiTunnelAnchor {
    pub fn new(config: SuiTunnelAnchorConfig) -> Result<Self, TunnelAnchorError> {
        let chain = GraphQlSuiChainClient::new(&config.graphql_url)
            .map_err(TunnelAnchorError::Unavailable)?;
        let backend = HttpSuiBackendClient::new(&config.backend_url);
        Self::with_clients(config, Arc::new(chain), Arc::new(backend))
    }

    pub fn with_chain(
        config: SuiTunnelAnchorConfig,
        chain: Arc<dyn SuiChainClient>,
    ) -> Result<Self, TunnelAnchorError> {
        let backend = HttpSuiBackendClient::new(&config.backend_url);
        Self::with_clients(config, chain, Arc::new(backend))
    }

    pub fn with_clients(
        config: SuiTunnelAnchorConfig,
        chain: Arc<dyn SuiChainClient>,
        backend: Arc<dyn SuiBackendClient>,
    ) -> Result<Self, TunnelAnchorError> {
        let funder = decode_sui_ed25519_bech32_private_key(&config.funder_priv_key)
            .map_err(TunnelAnchorError::Rejected)?;
        let funder_address = funder.public_key().derive_address();
        Ok(Self {
            config,
            funder,
            funder_address,
            chain,
            backend,
            inner: Arc::new(Mutex::new(AnchorState::default())),
        })
    }

    pub fn funder_address(&self) -> Address {
        self.funder_address
    }

    async fn open_once(
        &self,
        request: TunnelOpenRequest,
    ) -> Result<OpenedTunnel, TunnelAnchorError> {
        let key = OpenKey {
            protocol: request.protocol.as_str().to_string(),
            party_a: request.party_a,
            party_b: request.party_b,
        };
        if let Some(opened) = self.inner.lock().unwrap().opens.get(&key).cloned() {
            return Ok(OpenedTunnel {
                tunnel_id: opened.tunnel_id,
                onchain_nonce: opened.onchain_nonce,
                created_at_ms: Some(opened.created_at_ms),
                created: false,
            });
        }

        let stake_coin_id = parse_address(&self.config.funder_stake_coin_id)?;
        let stake_ref = self
            .chain
            .get_object_ref(stake_coin_id)
            .await
            .map_err(TunnelAnchorError::Unavailable)?;
        let kind = self.build_open_kind(&request, stake_ref)?;
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
            .map_err(|e| TunnelAnchorError::Rejected(format!("sign open tx: {e}")))?;
        let effects = match sponsor.provider.as_str() {
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
        };
        ensure_success(&effects)?;
        let tx_digest = transaction_digest(&effects);
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
        let tunnel_id = self.find_created_tunnel_id(&effects).await?;
        let record = OpenRecord {
            tunnel_id: tunnel_id.clone(),
            party_a: request.party_a,
            party_b: request.party_b,
            onchain_nonce: 0,
            created_at_ms,
        };
        self.inner.lock().unwrap().opens.insert(key, record);
        Ok(OpenedTunnel {
            tunnel_id,
            onchain_nonce: 0,
            created_at_ms: Some(created_at_ms),
            created: true,
        })
    }

    fn build_open_kind(
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
                "Sui anchor requires transcript_root settlement".into(),
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
        let body = self.backend.settle(first.tunnel_id.clone(), body).await?;
        Ok(SettledTunnel {
            digest: body.tx_digest,
            final_balances: Balances {
                a: first.party_a_balance,
                b: first.party_b_balance,
            },
        })
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

impl TunnelAnchor for SuiTunnelAnchor {
    fn settlement_mode(&self) -> SettlementMode {
        SettlementMode::TranscriptRoot
    }

    async fn open(&self, request: TunnelOpenRequest) -> Result<OpenedTunnel, TunnelAnchorError> {
        self.open_once(request).await
    }

    async fn settle(
        &self,
        request: TunnelSettleRequest,
    ) -> Result<SettledTunnel, TunnelAnchorError> {
        self.settle_once(request).await
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
        return Err(TunnelAnchorError::Rejected(format!(
            "{label} rejected with {status}: {}",
            String::from_utf8_lossy(&bytes)
        )));
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
            "open transaction failed: {other:?}"
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
    use std::sync::Mutex as StdMutex;
    use sui_sdk_types::{
        Digest, GasCostSummary, GasPayment, MoveStruct, ObjectData, ObjectReferenceWithOwner,
        Owner, TransactionEffectsV1, TransactionExpiration,
    };
    use tunnel_core::protocol_id::ProtocolId;
    use tunnel_core::wire::{serialize_settlement_with_root, Settlement};
    use tunnel_harness::{LocalSigner, Signer};

    #[derive(Default)]
    struct FakeChain {
        object_ref: StdMutex<Option<ObjectReference>>,
        objects: StdMutex<HashMap<Address, Object>>,
        effects: StdMutex<Option<TransactionEffects>>,
        transaction_effects: StdMutex<Option<TransactionEffects>>,
        transaction_timestamp_ms: StdMutex<Option<u64>>,
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

        async fn execute_transaction(
            &self,
            _transaction: &Transaction,
            signatures: &[UserSignature],
        ) -> Result<TransactionEffects, String> {
            *self.execute_signature_count.lock().unwrap() = Some(signatures.len());
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
        enoki_digest: StdMutex<Option<String>>,
        settle_digest: StdMutex<Option<String>>,
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
            *self.sponsor_sender.lock().unwrap() = Some(sender);
            *self.tx_kind_bytes.lock().unwrap() = Some(tx_kind_bytes);
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

    fn config() -> SuiTunnelAnchorConfig {
        SuiTunnelAnchorConfig {
            graphql_url: "http://graphql.invalid".into(),
            backend_url: "http://backend.invalid".into(),
            package_id: "0x2".into(),
            tunnel_coin_type: "0x2::sui::SUI".into(),
            funder_priv_key: test_bech32_key(),
            funder_stake_coin_id: "0x7".into(),
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

    fn tunnel_object(id: Address) -> Object {
        let tag = StructTag::new(
            Address::TWO,
            Identifier::new("tunnel").unwrap(),
            Identifier::new("Tunnel").unwrap(),
            vec![StructTag::sui().into()],
        );
        let mut contents = id.into_inner().to_vec();
        contents.extend([0u8; 8]);
        let move_struct = MoveStruct::new(tag, false, 1, contents).expect("valid move object");
        Object::new(
            ObjectData::Struct(move_struct),
            Owner::Shared(1),
            Digest::ZERO,
            0,
        )
    }

    fn success_effects(tunnel_id: Address) -> TransactionEffects {
        let created = ObjectReferenceWithOwner {
            reference: object_ref(tunnel_id),
            owner: Owner::Shared(1),
        };
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
            created: vec![created],
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
    ) -> Result<SuiTunnelAnchor, TunnelAnchorError> {
        SuiTunnelAnchor::with_clients(config(), chain, backend)
    }

    fn open_request() -> TunnelOpenRequest {
        let signer_a = LocalSigner::from_secret(&[1u8; 32]);
        let signer_b = LocalSigner::from_secret(&[2u8; 32]);
        TunnelOpenRequest {
            protocol: ProtocolId::parse("blackjack.bet.v1").unwrap(),
            party_a: signer_a.public_key(),
            party_b: signer_b.public_key(),
            initial: Balances { a: 7, b: 3 },
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

    #[tokio::test]
    async fn settler_sponsored_open_executes_with_graphql_and_extracts_tunnel_id() {
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
        *chain.transaction_timestamp_ms.lock().unwrap() = Some(1_770_000_000_123);

        let backend = Arc::new(FakeBackend::default());
        *backend.sponsor.lock().unwrap() = Some(SponsorResponse {
            provider: "settler".into(),
            tx_bytes: base64::engine::general_purpose::STANDARD.encode(bcs::to_bytes(&tx).unwrap()),
            sponsor_signature: Some(sponsor_signature),
            digest: None,
        });

        let anchor = anchor_with(chain.clone(), backend.clone()).expect("anchor");
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
            Some(anchor.funder_address().to_string())
        );
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

        let anchor = anchor_with(chain.clone(), backend.clone()).expect("anchor");
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

    #[tokio::test]
    async fn settle_posts_ts_compatible_binary_body_to_backend() {
        let chain = Arc::new(FakeChain::default());
        let backend = Arc::new(FakeBackend::default());
        *backend.settle_digest.lock().unwrap() = Some("DiG".into());
        let anchor = anchor_with(chain, backend.clone()).expect("anchor");

        let signer_a = LocalSigner::from_secret(&[1u8; 32]);
        let signer_b = LocalSigner::from_secret(&[2u8; 32]);
        anchor.inner.lock().unwrap().opens.insert(
            OpenKey {
                protocol: "blackjack.bet.v1".into(),
                party_a: signer_a.public_key(),
                party_b: signer_b.public_key(),
            },
            OpenRecord {
                tunnel_id: "0x1".into(),
                party_a: signer_a.public_key(),
                party_b: signer_b.public_key(),
                onchain_nonce: 0,
                created_at_ms: 1_234,
            },
        );

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
}
