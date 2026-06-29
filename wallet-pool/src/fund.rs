//! Build and execute a fund PTB that splits the master's `Coin<T>` into
//! per-recipient amounts and transfers them.

use crate::error::{Error, Result};
use crate::rpc::{ExecuteResponse, SuiRpc};
use sui_crypto::ed25519::Ed25519PrivateKey;
use sui_crypto::SuiSigner;
use sui_sdk_types::Address;
use sui_transaction_builder::{ObjectInput, TransactionBuilder};
use wallet_pool_core::crypto::KeyPair;

const SUI_COIN_TYPE: &str = "0x2::sui::SUI";
const GAS_BUDGET: u64 = 50_000_000;
const GAS_PRICE: u64 = 1_000;

/// Options for building a fund transaction.
#[derive(Clone, Debug)]
pub struct FundOptions {
    /// Fully-qualified coin type to split and transfer (e.g. `0x2::sui::SUI`).
    pub coin_type: String,

    /// Amount of `Coin<T>` each recipient receives.
    pub amount_per_recipient: u64,

    /// Recipient Sui addresses, each receiving one split coin.
    pub recipients: Vec<String>,

    /// Whether to poll the RPC until transaction effects are available.
    pub await_effects: bool,
}

/// Build, sign, and execute a single PTB that funds `opts.recipients` with
/// `opts.amount_per_recipient` of `opts.coin_type`.
///
/// For SUI the selected coin also pays gas. For other coin types a separate
/// SUI gas coin is selected from the same master address.
pub async fn fund(
    rpc: &dyn SuiRpc,
    master_keypair: &KeyPair,
    master_address: &str,
    opts: FundOptions,
) -> Result<String> {
    if opts.recipients.is_empty() {
        return Err(Error::InvalidInput(
            "at least one recipient is required".into(),
        ));
    }
    if opts.amount_per_recipient == 0 {
        return Err(Error::InvalidInput(
            "amount_per_recipient must be greater than zero".into(),
        ));
    }

    let sender = Address::from_hex(master_address)
        .map_err(|e| Error::InvalidInput(format!("invalid master address: {e}")))?;

    let total_amount = opts
        .amount_per_recipient
        .checked_mul(opts.recipients.len() as u64)
        .ok_or_else(|| Error::InvalidInput("total amount overflows u64".into()))?;

    let coins = rpc.get_coins(master_address, &opts.coin_type).await?;

    let is_sui = opts.coin_type == SUI_COIN_TYPE;
    let required_coin_balance = if is_sui {
        total_amount
            .checked_add(GAS_BUDGET)
            .ok_or_else(|| Error::InvalidInput("required balance overflows u64".into()))?
    } else {
        total_amount
    };

    let selected_coin = coins
        .into_iter()
        .find(|c| c.balance >= required_coin_balance)
        .ok_or_else(|| {
            Error::InsufficientFunds(format!(
                "no {} coin with balance >= {}",
                opts.coin_type, required_coin_balance
            ))
        })?;

    let mut tx = TransactionBuilder::new();
    tx.set_sender(sender);
    tx.set_gas_budget(GAS_BUDGET);
    tx.set_gas_price(GAS_PRICE);

    let coin_arg = if is_sui {
        tx.add_gas_objects([ObjectInput::owned(
            object_id_from_str(&selected_coin.object_id)?,
            selected_coin.version,
            digest_from_str(&selected_coin.digest)?,
        )]);
        tx.gas()
    } else {
        let gas_coins = rpc.get_coins(master_address, SUI_COIN_TYPE).await?;
        let gas_coin = gas_coins
            .into_iter()
            .find(|c| c.balance >= GAS_BUDGET)
            .ok_or_else(|| {
                Error::InsufficientFunds(format!("no SUI gas coin with balance >= {}", GAS_BUDGET))
            })?;

        tx.add_gas_objects([ObjectInput::owned(
            object_id_from_str(&gas_coin.object_id)?,
            gas_coin.version,
            digest_from_str(&gas_coin.digest)?,
        )]);
        tx.object(ObjectInput::owned(
            object_id_from_str(&selected_coin.object_id)?,
            selected_coin.version,
            digest_from_str(&selected_coin.digest)?,
        ))
    };

    let amounts: Vec<_> = (0..opts.recipients.len())
        .map(|_| tx.pure(&opts.amount_per_recipient))
        .collect();
    let split_coins = tx.split_coins(coin_arg, amounts);

    for (coin, recipient) in split_coins.into_iter().zip(opts.recipients.iter()) {
        let recipient_addr = Address::from_hex(recipient).map_err(|e| {
            Error::InvalidInput(format!("invalid recipient address {recipient}: {e}"))
        })?;
        let recipient_arg = tx.pure(&recipient_addr);
        tx.transfer_objects(vec![coin], recipient_arg);
    }

    let transaction = tx
        .try_build()
        .map_err(|e| Error::Transaction(format!("failed to build PTB: {e}")))?;

    let tx_bytes = bcs::to_bytes(&transaction)
        .map_err(|e| Error::Transaction(format!("failed to serialize transaction: {e}")))?;

    let signer = Ed25519PrivateKey::new(master_keypair.secret_key());
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

fn object_id_from_str(s: &str) -> Result<Address> {
    Address::from_hex(s).map_err(|e| Error::InvalidInput(format!("invalid object id {s}: {e}")))
}

fn digest_from_str(s: &str) -> Result<sui_sdk_types::Digest> {
    sui_sdk_types::Digest::from_base58(s)
        .map_err(|e| Error::InvalidInput(format!("invalid digest {s}: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::{Balance, Coin, ExecuteResponse};
    use async_trait::async_trait;
    use std::sync::{Arc, Mutex};

    /// A recorded RPC call made to the mock client.
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub struct RecordedCall {
        pub method: String,
        pub owner: String,
        pub coin_type: Option<String>,
    }

    /// Test-only RPC client that records calls and returns canned responses.
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
        pub fn new(
            coins: Vec<Coin>,
            execute_response: Option<ExecuteResponse>,
            wait_ok: bool,
        ) -> Self {
            Self {
                state: Arc::new(Mutex::new(MockState {
                    calls: Vec::new(),
                    coins,
                    execute_response,
                    wait_ok,
                    recorded_execute: None,
                })),
            }
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
        async fn get_all_balances(&self, address: &str) -> Result<Vec<Balance>> {
            let mut state = self.state.lock().unwrap();
            state.calls.push(RecordedCall {
                method: "get_all_balances".into(),
                owner: address.into(),
                coin_type: None,
            });
            Ok(Vec::new())
        }

        async fn get_coins(&self, owner: &str, coin_type: &str) -> Result<Vec<Coin>> {
            let mut state = self.state.lock().unwrap();
            state.calls.push(RecordedCall {
                method: "get_coins".into(),
                owner: owner.into(),
                coin_type: Some(coin_type.into()),
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
                owner: String::new(),
                coin_type: None,
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
                owner: digest.into(),
                coin_type: None,
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
                owner: address.into(),
                coin_type: None,
            });
            Ok(())
        }
    }

    fn sui_coin(balance: u64) -> Coin {
        Coin {
            coin_type: SUI_COIN_TYPE.into(),
            object_id: "0x1111111111111111111111111111111111111111111111111111111111111111".into(),
            version: 1,
            digest: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA".into(),
            balance,
        }
    }

    fn master_keypair() -> KeyPair {
        wallet_pool_core::crypto::keypair_from_secret(&[1u8; 32])
    }

    fn master_address() -> String {
        wallet_pool_core::crypto::ed25519_address(&master_keypair().public_key())
    }

    #[tokio::test]
    async fn fund_calls_get_coins_and_executes_transaction() {
        let address = master_address();
        let recipient = "0x2222222222222222222222222222222222222222222222222222222222222222";
        let rpc = MockRpc::new(
            vec![sui_coin(1_000_000_000)],
            Some(ExecuteResponse {
                digest: "txdigest".into(),
                effects: None,
            }),
            false,
        );

        let opts = FundOptions {
            coin_type: SUI_COIN_TYPE.into(),
            amount_per_recipient: 100_000_000,
            recipients: vec![recipient.into()],
            await_effects: false,
        };

        let digest = fund(&rpc, &master_keypair(), &address, opts).await.unwrap();

        assert_eq!(digest, "txdigest");

        let calls = rpc.calls();
        let get_coins = calls
            .iter()
            .find(|c| c.method == "get_coins")
            .expect("get_coins should be called");
        assert_eq!(get_coins.owner, address);
        assert_eq!(get_coins.coin_type.as_deref(), Some(SUI_COIN_TYPE));

        let execute = calls
            .iter()
            .find(|c| c.method == "execute_transaction")
            .expect("execute_transaction should be called");
        assert_eq!(execute.owner, "");

        let (tx_bytes, signatures) = rpc.recorded_execute().expect("execute should be recorded");
        assert!(!tx_bytes.is_empty(), "tx_bytes should be non-empty");
        assert_eq!(signatures.len(), 1, "exactly one signature is required");
        assert_eq!(
            signatures[0].len(),
            1 + 64 + 32,
            "signature is flag+sig+pubkey"
        );

        // Verify the transaction BCS deserializes and has the expected commands.
        let transaction: sui_sdk_types::Transaction = bcs::from_bytes(&tx_bytes).unwrap();
        let sui_sdk_types::TransactionKind::ProgrammableTransaction(ptb) = &transaction.kind else {
            panic!("expected programmable transaction");
        };
        assert_eq!(
            ptb.commands.len(),
            2,
            "expected split_coins + transfer_objects"
        );
    }

    #[tokio::test]
    async fn fund_returns_insufficient_funds() {
        let address = master_address();
        let recipient = "0x2222222222222222222222222222222222222222222222222222222222222222";
        let rpc = MockRpc::new(
            vec![sui_coin(1_000)],
            Some(ExecuteResponse {
                digest: "txdigest".into(),
                effects: None,
            }),
            false,
        );

        let opts = FundOptions {
            coin_type: SUI_COIN_TYPE.into(),
            amount_per_recipient: 100_000_000,
            recipients: vec![recipient.into()],
            await_effects: false,
        };

        let err = fund(&rpc, &master_keypair(), &address, opts)
            .await
            .expect_err("should fail with insufficient funds");

        assert!(
            matches!(err, Error::InsufficientFunds(_)),
            "expected InsufficientFunds, got {err}"
        );
        assert!(
            rpc.calls()
                .iter()
                .all(|c| c.method != "execute_transaction"),
            "execute_transaction should not be called"
        );
    }
}
