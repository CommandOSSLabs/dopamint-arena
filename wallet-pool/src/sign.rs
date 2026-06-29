//! Sign and execute a programmable transaction block.

use crate::error::{Error, Result};
use crate::rpc::{Coin, ExecuteResponse, SuiRpc};
use sui_crypto::ed25519::Ed25519PrivateKey;
use sui_crypto::SuiSigner;
use sui_sdk_types::Address;
use wallet_pool_core::crypto::KeyPair;

const DEFAULT_GAS_BUDGET: u64 = 50_000_000;
const DEFAULT_GAS_PRICE: u64 = 1_000;
const SUI_COIN_TYPE: &str = "0x2::sui::SUI";

/// Options for signing and executing a transaction.
#[derive(Clone, Debug)]
pub struct SignOptions {
    /// The programmable transaction block to wrap, sign, and execute.
    pub ptb: sui_sdk_types::ProgrammableTransaction,

    /// Whether to poll the RPC until transaction effects are available.
    pub await_effects: bool,
}

/// Wrap `opts.ptb` in a [`sui_sdk_types::Transaction`], sign it with `keypair`,
/// and execute it via `rpc`.
///
/// Gas payment objects are selected from the sender's owned SUI coins. A single
/// coin is used when it covers [`DEFAULT_GAS_BUDGET`]; otherwise coins are
/// combined until the budget is met.
pub async fn sign_and_execute(
    rpc: &dyn SuiRpc,
    keypair: &KeyPair,
    sender: &str,
    opts: SignOptions,
) -> Result<String> {
    let sender = Address::from_hex(sender)
        .map_err(|e| Error::InvalidInput(format!("invalid sender address: {e}")))?;

    let gas_coins = rpc.get_coins(&sender.to_hex(), SUI_COIN_TYPE).await?;
    let gas_payment_objects = select_gas_coins(gas_coins, DEFAULT_GAS_BUDGET)?;

    let transaction = sui_sdk_types::Transaction {
        kind: sui_sdk_types::TransactionKind::ProgrammableTransaction(opts.ptb),
        sender,
        gas_payment: sui_sdk_types::GasPayment {
            objects: gas_payment_objects,
            owner: sender,
            price: DEFAULT_GAS_PRICE,
            budget: DEFAULT_GAS_BUDGET,
        },
        expiration: sui_sdk_types::TransactionExpiration::None,
    };

    let tx_bytes = bcs::to_bytes(&transaction)
        .map_err(|e| Error::Transaction(format!("failed to serialize transaction: {e}")))?;

    let signer = Ed25519PrivateKey::new(keypair.secret_key());
    let signature = signer
        .sign_transaction(&transaction)
        .map_err(|e| Error::Transaction(format!("failed to sign transaction: {e}")))?;
    let signatures = vec![signature.to_bytes()];

    let ExecuteResponse { digest, .. } = rpc.execute_transaction(&tx_bytes, signatures).await?;

    if opts.await_effects {
        rpc.wait_for_transaction(&digest).await?;
    }

    Ok(digest)
}

/// Convert an RPC [`Coin`] into an [`ObjectReference`] for use as gas payment.
fn coin_to_object_ref(coin: &Coin) -> Result<sui_sdk_types::ObjectReference> {
    let object_id = Address::from_hex(&coin.object_id).map_err(|e| {
        Error::Transaction(format!(
            "invalid gas coin object id {}: {e}",
            coin.object_id
        ))
    })?;
    let digest = coin
        .digest
        .parse::<sui_sdk_types::Digest>()
        .map_err(|e| Error::Transaction(format!("invalid gas coin digest {}: {e}", coin.digest)))?;

    Ok(sui_sdk_types::ObjectReference::new(
        object_id,
        coin.version,
        digest,
    ))
}

/// Select one or more SUI coins whose combined balance covers `budget`.
///
/// Coins are sorted by descending balance so a single large coin is preferred
/// over combining many small coins.
fn select_gas_coins(coins: Vec<Coin>, budget: u64) -> Result<Vec<sui_sdk_types::ObjectReference>> {
    if coins.is_empty() {
        return Err(Error::InsufficientFunds(
            "no SUI gas coins available".into(),
        ));
    }

    let mut coins = coins;
    coins.sort_by_key(|coin| std::cmp::Reverse(coin.balance));

    let mut selected = Vec::new();
    let mut total = 0u64;
    for coin in &coins {
        total += coin.balance;
        selected.push(coin_to_object_ref(coin)?);
        if total >= budget {
            return Ok(selected);
        }
    }

    Err(Error::InsufficientFunds(format!(
        "SUI balance {total} is less than gas budget {budget}"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::ExecuteResponse;
    use async_trait::async_trait;
    use std::sync::{Arc, Mutex};

    /// A recorded RPC call made to the mock client.
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct RecordedCall {
        pub method: String,
        pub address: String,
    }

    /// Test-only RPC client that records `execute_transaction` arguments.
    #[derive(Clone, Debug)]
    pub struct MockRpc {
        state: Arc<Mutex<MockState>>,
    }

    #[derive(Clone, Debug, Default)]
    struct MockState {
        calls: Vec<RecordedCall>,
        coins: Vec<Coin>,
        execute_response: Option<ExecuteResponse>,
        wait_ok: bool,
        recorded_execute: Option<(Vec<u8>, Vec<Vec<u8>>)>,
    }

    impl MockRpc {
        pub fn new(execute_response: Option<ExecuteResponse>, wait_ok: bool) -> Self {
            Self {
                state: Arc::new(Mutex::new(MockState {
                    calls: Vec::new(),
                    coins: Vec::new(),
                    execute_response,
                    wait_ok,
                    recorded_execute: None,
                })),
            }
        }

        pub fn with_coins(self, coins: Vec<Coin>) -> Self {
            self.state.lock().unwrap().coins = coins;
            self
        }

        pub fn calls(&self) -> Vec<RecordedCall> {
            self.state.lock().unwrap().calls.clone()
        }

        pub fn recorded_execute(&self) -> Option<(Vec<u8>, Vec<Vec<u8>>)> {
            self.state.lock().unwrap().recorded_execute.clone()
        }
    }

    #[async_trait]
    impl SuiRpc for MockRpc {
        async fn get_all_balances(&self, address: &str) -> Result<Vec<crate::rpc::Balance>> {
            let mut state = self.state.lock().unwrap();
            state.calls.push(RecordedCall {
                method: "get_all_balances".into(),
                address: address.into(),
            });
            Ok(Vec::new())
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
            tx_bytes: &[u8],
            signatures: Vec<Vec<u8>>,
        ) -> Result<ExecuteResponse> {
            let mut state = self.state.lock().unwrap();
            state.calls.push(RecordedCall {
                method: "execute_transaction".into(),
                address: String::new(),
            });
            state.recorded_execute = Some((tx_bytes.to_vec(), signatures));
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
            Ok(())
        }
    }

    fn keypair() -> KeyPair {
        wallet_pool_core::crypto::keypair_from_secret(&[1u8; 32])
    }

    fn sender() -> String {
        wallet_pool_core::crypto::ed25519_address(&keypair().public_key())
    }

    fn empty_ptb() -> sui_sdk_types::ProgrammableTransaction {
        sui_sdk_types::ProgrammableTransaction {
            inputs: Vec::new(),
            commands: Vec::new(),
        }
    }

    fn gas_coin(balance: u64) -> Coin {
        // Object IDs and digests must be valid hex/base58 strings. Use fixed
        // values that satisfy parsing for the happy-path tests.
        gas_coin_with_index(balance, 1)
    }

    fn gas_coin_with_index(balance: u64, index: u8) -> Coin {
        Coin {
            coin_type: SUI_COIN_TYPE.into(),
            object_id: format!("0x{:064x}", index),
            version: 1,
            digest: sui_sdk_types::Digest::ZERO.to_string(),
            balance,
        }
    }

    #[tokio::test]
    async fn sign_and_execute_calls_execute_transaction_with_expected_shape() {
        let rpc = MockRpc::new(
            Some(ExecuteResponse {
                digest: "txdigest".into(),
                effects: None,
            }),
            false,
        )
        .with_coins(vec![gas_coin(DEFAULT_GAS_BUDGET)]);

        let opts = SignOptions {
            ptb: empty_ptb(),
            await_effects: false,
        };

        let digest = sign_and_execute(&rpc, &keypair(), &sender(), opts)
            .await
            .unwrap();

        assert_eq!(digest, "txdigest");

        let calls = rpc.calls();
        assert!(
            calls.iter().any(|c| c.method == "execute_transaction"),
            "execute_transaction should be called"
        );
        assert!(
            !calls.iter().any(|c| c.method == "wait_for_transaction"),
            "wait_for_transaction should not be called when await_effects is false"
        );

        let (tx_bytes, signatures) = rpc.recorded_execute().expect("execute should be recorded");
        assert!(!tx_bytes.is_empty(), "tx_bytes should be non-empty");
        assert_eq!(signatures.len(), 1, "exactly one signature is required");
        assert_eq!(
            signatures[0].len(),
            1 + 64 + 32,
            "signature is flag+sig+pubkey"
        );

        // Verify the transaction BCS deserializes and wraps the expected PTB.
        let transaction: sui_sdk_types::Transaction = bcs::from_bytes(&tx_bytes).unwrap();
        let sui_sdk_types::TransactionKind::ProgrammableTransaction(ptb) = &transaction.kind else {
            panic!("expected programmable transaction");
        };
        assert!(ptb.inputs.is_empty());
        assert!(ptb.commands.is_empty());
        assert_eq!(
            transaction.sender.to_hex().trim_start_matches("0x"),
            sender().trim_start_matches("0x")
        );
        assert!(
            !transaction.gas_payment.objects.is_empty(),
            "gas payment objects should be populated"
        );
        assert_eq!(transaction.gas_payment.owner, transaction.sender);
        assert_eq!(transaction.gas_payment.budget, DEFAULT_GAS_BUDGET);
    }

    #[tokio::test]
    async fn sign_and_execute_waits_for_effects_when_requested() {
        let rpc = MockRpc::new(
            Some(ExecuteResponse {
                digest: "txdigest".into(),
                effects: None,
            }),
            true,
        )
        .with_coins(vec![gas_coin(DEFAULT_GAS_BUDGET)]);

        let opts = SignOptions {
            ptb: empty_ptb(),
            await_effects: true,
        };

        let digest = sign_and_execute(&rpc, &keypair(), &sender(), opts)
            .await
            .unwrap();

        assert_eq!(digest, "txdigest");

        let calls = rpc.calls();
        assert!(
            calls.iter().any(|c| c.method == "execute_transaction"),
            "execute_transaction should be called"
        );
        assert!(
            calls.iter().any(|c| c.method == "wait_for_transaction"),
            "wait_for_transaction should be called when await_effects is true"
        );
    }

    #[tokio::test]
    async fn sign_and_execute_returns_error_for_invalid_sender() {
        let rpc = MockRpc::new(None, false);

        let opts = SignOptions {
            ptb: empty_ptb(),
            await_effects: false,
        };

        let err = sign_and_execute(&rpc, &keypair(), "not-an-address", opts)
            .await
            .expect_err("should fail with invalid sender");

        assert!(
            matches!(err, Error::InvalidInput(_)),
            "expected InvalidInput, got {err}"
        );
        assert!(
            !rpc.calls()
                .iter()
                .any(|c| c.method == "execute_transaction"),
            "execute_transaction should not be called"
        );
    }

    #[tokio::test]
    async fn sign_and_execute_calls_get_coins_for_sui_gas() {
        let rpc = MockRpc::new(
            Some(ExecuteResponse {
                digest: "txdigest".into(),
                effects: None,
            }),
            false,
        )
        .with_coins(vec![gas_coin(DEFAULT_GAS_BUDGET)]);

        let opts = SignOptions {
            ptb: empty_ptb(),
            await_effects: false,
        };

        let digest = sign_and_execute(&rpc, &keypair(), &sender(), opts)
            .await
            .unwrap();
        assert_eq!(digest, "txdigest");

        let calls = rpc.calls();
        assert!(
            calls
                .iter()
                .any(|c| c.method == "get_coins" && c.address == sender()),
            "get_coins should be called for the sender"
        );
    }

    #[test]
    fn select_gas_coins_combines_multiple_small_coins_to_meet_budget() {
        let coins = vec![
            gas_coin_with_index(20_000_000, 1),
            gas_coin_with_index(20_000_000, 2),
            gas_coin_with_index(20_000_000, 3),
        ];

        let selected = select_gas_coins(coins, DEFAULT_GAS_BUDGET).unwrap();

        assert_eq!(
            selected.len(),
            3,
            "all three small coins should be combined"
        );
    }

    #[test]
    fn select_gas_coins_returns_insufficient_funds_when_no_coins_meet_budget() {
        let coins = vec![
            gas_coin_with_index(20_000_000, 1),
            gas_coin_with_index(20_000_000, 2),
        ];

        let err = select_gas_coins(coins, DEFAULT_GAS_BUDGET).expect_err("should fail");

        assert!(
            matches!(err, Error::InsufficientFunds(_)),
            "expected InsufficientFunds, got {err}"
        );
    }
}
