//! Thin Sui JSON-RPC wrapper used by the async `wallet-pool` crate.
//!
//! The wrapper is intentionally small: it keeps HTTP connection pooling via
//! `reqwest::Client` and exposes only the handful of JSON-RPC methods the pool
//! needs (balances, coins, execution, faucet). Responses are parsed with
//! `serde_json::Value` so the crate does not depend on a heavy Sui RPC client.

use crate::error::{Error, Result};
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde_json::Value;
use std::time::Duration;
use tokio::time::sleep;

/// Summary of a single coin type balance returned by `suix_getAllBalances`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Balance {
    pub coin_type: String,
    pub coin_object_count: u64,
    pub total_balance: u64,
}

/// A single owned coin object returned by `suix_getCoins`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Coin {
    pub coin_type: String,
    pub object_id: String,
    pub version: u64,
    pub digest: String,
    pub balance: u64,
}

/// Result of a successful `sui_executeTransactionBlock` call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecuteResponse {
    pub digest: String,
    pub effects: Option<Value>,
}

/// Async abstraction over Sui RPC calls.
///
/// All implementations must be `Send + Sync` so they can be shared across
/// threads inside an `Arc<dyn SuiRpc>`.
#[async_trait]
pub trait SuiRpc: Send + Sync {
    /// Return all coin-type balances for `address`.
    async fn get_all_balances(&self, address: &str) -> Result<Vec<Balance>>;

    /// Return the first page of coins of type `coin_type` owned by `owner`.
    async fn get_coins(&self, owner: &str, coin_type: &str) -> Result<Vec<Coin>>;

    /// Execute a signed transaction and return its digest and effects, if any.
    async fn execute_transaction(
        &self,
        tx_bytes: &[u8],
        signatures: Vec<Vec<u8>>,
    ) -> Result<ExecuteResponse>;

    /// Poll `sui_getTransactionBlock` until the transaction effects are present
    /// or a timeout is reached.
    async fn wait_for_transaction(&self, digest: &str) -> Result<()>;

    /// Request SUI from a faucet for `address`.
    async fn faucet_request(&self, address: &str) -> Result<()>;
}

/// Production implementation backed by `reqwest`.
#[derive(Clone, Debug)]
pub struct ReqwestRpc {
    client: reqwest::Client,
    rpc_url: String,
    faucet_url: Option<String>,
}

impl ReqwestRpc {
    /// Create an RPC client that posts JSON-RPC calls to `rpc_url`.
    pub fn new(rpc_url: impl Into<String>) -> Self {
        Self {
            client: reqwest::Client::new(),
            rpc_url: rpc_url.into(),
            faucet_url: None,
        }
    }

    /// Set the faucet URL used by [`SuiRpc::faucet_request`].
    pub fn with_faucet_url(mut self, faucet_url: impl Into<String>) -> Self {
        self.faucet_url = Some(faucet_url.into());
        self
    }

    /// Make a JSON-RPC 2.0 call and return the `result` field.
    async fn call(&self, method: &str, params: Vec<Value>) -> Result<Value> {
        let body = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        });

        let response = self
            .client
            .post(&self.rpc_url)
            .json(&body)
            .send()
            .await
            .map_err(|e| Error::Rpc(format!("{method} request failed: {e}")))?;

        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|e| Error::Rpc(format!("{method} body read failed: {e}")))?;

        if !status.is_success() {
            return Err(Error::Rpc(format!("{method} HTTP {status}: {text}")));
        }

        let json: Value = serde_json::from_str(&text)
            .map_err(|e| Error::Rpc(format!("{method} invalid JSON: {e}")))?;

        if let Some(err) = json.get("error") {
            return Err(Error::Rpc(format!("{method} error: {err}")));
        }

        Ok(json["result"].clone())
    }
}

#[async_trait]
impl SuiRpc for ReqwestRpc {
    async fn get_all_balances(&self, address: &str) -> Result<Vec<Balance>> {
        let result = self
            .call("suix_getAllBalances", vec![Value::String(address.into())])
            .await?;

        let array = result
            .as_array()
            .ok_or_else(|| Error::Rpc("getAllBalances result is not an array".into()))?;

        array.iter().map(parse_balance).collect()
    }

    async fn get_coins(&self, owner: &str, coin_type: &str) -> Result<Vec<Coin>> {
        let result = self
            .call(
                "suix_getCoins",
                vec![
                    Value::String(owner.into()),
                    Value::String(coin_type.into()),
                    Value::Null,
                    Value::Null,
                ],
            )
            .await?;

        let data = result
            .get("data")
            .and_then(Value::as_array)
            .ok_or_else(|| Error::Rpc("getCoins result missing data array".into()))?;

        data.iter().map(parse_coin).collect()
    }

    async fn execute_transaction(
        &self,
        tx_bytes: &[u8],
        signatures: Vec<Vec<u8>>,
    ) -> Result<ExecuteResponse> {
        let tx_b64 = B64.encode(tx_bytes);
        let sigs: Vec<Value> = signatures
            .into_iter()
            .map(|s| Value::String(B64.encode(s)))
            .collect();

        let result = self
            .call(
                "sui_executeTransactionBlock",
                vec![
                    Value::String(tx_b64),
                    Value::Array(sigs),
                    serde_json::json!({"showEffects": true}),
                    Value::String("WaitForLocalExecution".into()),
                ],
            )
            .await?;

        let digest = result
            .get("digest")
            .and_then(Value::as_str)
            .ok_or_else(|| Error::Rpc("executeTransactionBlock missing digest".into()))?
            .to_string();

        let effects = result.get("effects").cloned();

        Ok(ExecuteResponse { digest, effects })
    }

    async fn wait_for_transaction(&self, digest: &str) -> Result<()> {
        const MAX_RETRIES: usize = 60;
        const INTERVAL: Duration = Duration::from_secs(1);

        for attempt in 0..MAX_RETRIES {
            let result = self
                .call(
                    "sui_getTransactionBlock",
                    vec![
                        Value::String(digest.into()),
                        serde_json::json!({"showEffects": true}),
                    ],
                )
                .await;

            match result {
                Ok(value) => {
                    if value.get("effects").is_some_and(|v| !v.is_null()) {
                        return Ok(());
                    }
                }
                Err(e) => {
                    // On the first call the transaction may not yet be known;
                    // keep polling. On the last attempt surface the error.
                    if attempt == MAX_RETRIES - 1 {
                        return Err(e);
                    }
                }
            }

            sleep(INTERVAL).await;
        }

        Err(Error::Rpc(format!(
            "transaction {digest} effects not available after {MAX_RETRIES}s"
        )))
    }

    async fn faucet_request(&self, address: &str) -> Result<()> {
        let url = self
            .faucet_url
            .as_ref()
            .ok_or_else(|| Error::Faucet("no faucet URL configured".into()))?;

        let body = serde_json::json!({
            "FixedAmountRequest": {
                "recipient": address,
            }
        });

        let response = self
            .client
            .post(format!("{url}/v1/gas"))
            .json(&body)
            .send()
            .await
            .map_err(|e| Error::Faucet(format!("faucet request failed: {e}")))?;

        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(Error::Faucet(format!("faucet HTTP {status}: {text}")));
        }

        Ok(())
    }
}

fn parse_balance(value: &Value) -> Result<Balance> {
    let coin_type = value
        .get("coinType")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Rpc("balance missing coinType".into()))?
        .to_string();

    let coin_object_count = value
        .get("coinObjectCount")
        .map(parse_u64)
        .transpose()?
        .unwrap_or(0);

    let total_balance = value
        .get("totalBalance")
        .map(parse_u64)
        .transpose()?
        .unwrap_or(0);

    Ok(Balance {
        coin_type,
        coin_object_count,
        total_balance,
    })
}

fn parse_coin(value: &Value) -> Result<Coin> {
    let coin_type = value
        .get("coinType")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Rpc("coin missing coinType".into()))?
        .to_string();

    let object_id = value
        .get("coinObjectId")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Rpc("coin missing coinObjectId".into()))?
        .to_string();

    let version = value
        .get("version")
        .map(parse_u64)
        .transpose()?
        .unwrap_or(0);

    let digest = value
        .get("digest")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Rpc("coin missing digest".into()))?
        .to_string();

    let balance = value
        .get("balance")
        .map(parse_u64)
        .transpose()?
        .unwrap_or(0);

    Ok(Coin {
        coin_type,
        object_id,
        version,
        digest,
        balance,
    })
}

/// Parse a JSON value that may be a string or number into a `u64`.
fn parse_u64(value: &Value) -> Result<u64> {
    if let Some(n) = value.as_u64() {
        return Ok(n);
    }
    if let Some(s) = value.as_str() {
        return s
            .parse()
            .map_err(|e| Error::Rpc(format!("invalid u64 '{s}': {e}")));
    }
    Err(Error::Rpc(format!("expected u64, got {value}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    /// A recorded RPC call made to the mock client.
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct RecordedCall {
        pub method: String,
        pub address: String,
    }

    /// Test-only RPC client that records calls and returns canned responses.
    #[derive(Clone, Debug)]
    pub struct MockRpc {
        state: Arc<Mutex<MockState>>,
    }

    #[derive(Clone, Debug, Default)]
    struct MockState {
        calls: Vec<RecordedCall>,
        balances: Vec<Balance>,
        coins: Vec<Coin>,
        execute_response: Option<ExecuteResponse>,
        wait_ok: bool,
        faucet_ok: bool,
    }

    impl MockRpc {
        pub fn new(
            balances: Vec<Balance>,
            coins: Vec<Coin>,
            execute_response: Option<ExecuteResponse>,
            wait_ok: bool,
            faucet_ok: bool,
        ) -> Self {
            Self {
                state: Arc::new(Mutex::new(MockState {
                    calls: Vec::new(),
                    balances,
                    coins,
                    execute_response,
                    wait_ok,
                    faucet_ok,
                })),
            }
        }

        pub fn calls(&self) -> Vec<RecordedCall> {
            self.state.lock().unwrap().calls.clone()
        }
    }

    #[async_trait]
    impl SuiRpc for MockRpc {
        async fn get_all_balances(&self, address: &str) -> Result<Vec<Balance>> {
            let mut state = self.state.lock().unwrap();
            state.calls.push(RecordedCall {
                method: "get_all_balances".into(),
                address: address.into(),
            });
            Ok(state.balances.clone())
        }

        async fn get_coins(&self, owner: &str, _coin_type: &str) -> Result<Vec<Coin>> {
            let mut state = self.state.lock().unwrap();
            state.calls.push(RecordedCall {
                method: "get_coins".into(),
                address: owner.into(),
            });
            Ok(state.coins.clone())
        }

        async fn execute_transaction(
            &self,
            _tx_bytes: &[u8],
            _signatures: Vec<Vec<u8>>,
        ) -> Result<ExecuteResponse> {
            let mut state = self.state.lock().unwrap();
            state.calls.push(RecordedCall {
                method: "execute_transaction".into(),
                address: String::new(),
            });
            state
                .execute_response
                .clone()
                .ok_or_else(|| Error::Rpc("no canned execute response".into()))
        }

        async fn wait_for_transaction(&self, digest: &str) -> Result<()> {
            let mut state = self.state.lock().unwrap();
            state.calls.push(RecordedCall {
                method: "wait_for_transaction".into(),
                address: digest.into(),
            });
            if state.wait_ok {
                Ok(())
            } else {
                Err(Error::Rpc("wait_for_transaction canned failure".into()))
            }
        }

        async fn faucet_request(&self, address: &str) -> Result<()> {
            let mut state = self.state.lock().unwrap();
            state.calls.push(RecordedCall {
                method: "faucet_request".into(),
                address: address.into(),
            });
            if state.faucet_ok {
                Ok(())
            } else {
                Err(Error::Faucet("faucet_request canned failure".into()))
            }
        }
    }

    #[tokio::test]
    async fn mock_rpc_records_get_all_balances_call() {
        let address = "0x1234";
        let balance = Balance {
            coin_type: "0x2::sui::SUI".into(),
            coin_object_count: 3,
            total_balance: 1_000_000,
        };
        let rpc = MockRpc::new(vec![balance.clone()], vec![], None, false, false);

        let got = rpc.get_all_balances(address).await.unwrap();

        assert_eq!(got, vec![balance]);
        assert_eq!(
            rpc.calls(),
            vec![RecordedCall {
                method: "get_all_balances".into(),
                address: address.into(),
            }]
        );
    }

    #[tokio::test]
    async fn reqwest_rpc_can_be_instantiated() {
        let _rpc =
            ReqwestRpc::new("http://localhost:9000").with_faucet_url("http://localhost:9123");
    }

    #[test]
    fn parse_u64_accepts_number_and_string() {
        assert_eq!(parse_u64(&json!(42)).unwrap(), 42);
        assert_eq!(parse_u64(&json!("42")).unwrap(), 42);
    }

    #[test]
    fn parse_u64_rejects_invalid_values() {
        assert!(parse_u64(&json!("not a number")).is_err());
        assert!(parse_u64(&json!(-1)).is_err());
        assert!(parse_u64(&json!(null)).is_err());
        assert!(parse_u64(&json!({})).is_err());
    }

    #[test]
    fn parse_balance_extracts_all_fields() {
        let value = json!({
            "coinType": "0x2::sui::SUI",
            "coinObjectCount": 3,
            "totalBalance": "1000000",
        });

        let got = parse_balance(&value).unwrap();

        assert_eq!(
            got,
            Balance {
                coin_type: "0x2::sui::SUI".into(),
                coin_object_count: 3,
                total_balance: 1_000_000,
            }
        );
    }

    #[test]
    fn parse_balance_defaults_missing_numeric_fields() {
        let value = json!({ "coinType": "0x2::sui::SUI" });

        let got = parse_balance(&value).unwrap();

        assert_eq!(
            got,
            Balance {
                coin_type: "0x2::sui::SUI".into(),
                coin_object_count: 0,
                total_balance: 0,
            }
        );
    }

    #[test]
    fn parse_balance_requires_coin_type() {
        assert!(parse_balance(&json!({ "coinObjectCount": 1 })).is_err());
    }

    #[test]
    fn parse_coin_extracts_all_fields() {
        let value = json!({
            "coinType": "0x2::sui::SUI",
            "coinObjectId": "0xabc",
            "version": "5",
            "digest": "txDgQ...",
            "balance": 1234,
        });

        let got = parse_coin(&value).unwrap();

        assert_eq!(
            got,
            Coin {
                coin_type: "0x2::sui::SUI".into(),
                object_id: "0xabc".into(),
                version: 5,
                digest: "txDgQ...".into(),
                balance: 1234,
            }
        );
    }

    #[test]
    fn parse_coin_defaults_missing_version_and_balance() {
        let value = json!({
            "coinType": "0x2::sui::SUI",
            "coinObjectId": "0xabc",
            "digest": "txDgQ...",
        });

        let got = parse_coin(&value).unwrap();

        assert_eq!(got.version, 0);
        assert_eq!(got.balance, 0);
    }

    #[test]
    fn parse_coin_requires_coin_type_object_id_and_digest() {
        assert!(parse_coin(&json!({ "coinObjectId": "0xabc", "digest": "d" })).is_err());
        assert!(parse_coin(&json!({ "coinType": "t", "digest": "d" })).is_err());
        assert!(parse_coin(&json!({ "coinType": "t", "coinObjectId": "0xabc" })).is_err());
    }

    #[tokio::test]
    async fn mock_rpc_records_get_coins_call() {
        let owner = "0xowner";
        let coin = Coin {
            coin_type: "0x2::sui::SUI".into(),
            object_id: "0xabc".into(),
            version: 1,
            digest: "d".into(),
            balance: 100,
        };
        let rpc = MockRpc::new(vec![], vec![coin.clone()], None, false, false);

        let got = rpc.get_coins(owner, "0x2::sui::SUI").await.unwrap();

        assert_eq!(got, vec![coin]);
        assert_eq!(
            rpc.calls(),
            vec![RecordedCall {
                method: "get_coins".into(),
                address: owner.into(),
            }]
        );
    }

    #[tokio::test]
    async fn mock_rpc_records_execute_transaction_call() {
        let response = ExecuteResponse {
            digest: "tx".into(),
            effects: Some(json!({ "status": { "status": "success" } })),
        };
        let rpc = MockRpc::new(vec![], vec![], Some(response.clone()), false, false);

        let got = rpc
            .execute_transaction(b"tx", vec![b"sig".to_vec()])
            .await
            .unwrap();

        assert_eq!(got, response);
        assert_eq!(
            rpc.calls(),
            vec![RecordedCall {
                method: "execute_transaction".into(),
                address: String::new(),
            }]
        );
    }

    #[tokio::test]
    async fn mock_rpc_execute_transaction_errors_without_response() {
        let rpc = MockRpc::new(vec![], vec![], None, false, false);

        assert!(rpc.execute_transaction(b"tx", vec![]).await.is_err());
    }

    #[tokio::test]
    async fn mock_rpc_records_wait_for_transaction_call() {
        let digest = "d";
        let rpc = MockRpc::new(vec![], vec![], None, true, false);

        rpc.wait_for_transaction(digest).await.unwrap();

        assert_eq!(
            rpc.calls(),
            vec![RecordedCall {
                method: "wait_for_transaction".into(),
                address: digest.into(),
            }]
        );
    }

    #[tokio::test]
    async fn mock_rpc_wait_for_transaction_respects_wait_ok() {
        let rpc = MockRpc::new(vec![], vec![], None, false, false);

        assert!(rpc.wait_for_transaction("d").await.is_err());
    }

    #[tokio::test]
    async fn mock_rpc_records_faucet_request_call() {
        let address = "0xaddr";
        let rpc = MockRpc::new(vec![], vec![], None, false, true);

        rpc.faucet_request(address).await.unwrap();

        assert_eq!(
            rpc.calls(),
            vec![RecordedCall {
                method: "faucet_request".into(),
                address: address.into(),
            }]
        );
    }

    #[tokio::test]
    async fn mock_rpc_faucet_request_respects_faucet_ok() {
        let rpc = MockRpc::new(vec![], vec![], None, false, false);

        assert!(rpc.faucet_request("0xaddr").await.is_err());
    }
}
