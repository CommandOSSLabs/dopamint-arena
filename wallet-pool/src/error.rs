//! Async error types for `wallet-pool`.
//!
//! All display messages are intentionally free of secret material.

use thiserror::Error;

/// Errors returned by the async `wallet-pool` layer.
#[derive(Debug, Error)]
pub enum Error {
    /// An error originating from the sync, sans-IO core.
    #[error("core error: {0}")]
    Core(#[from] wallet_pool_core::error::Error),

    /// The underlying storage layer failed.
    #[error("store error: {0}")]
    Store(String),

    /// An RPC call failed.
    #[error("rpc error: {0}")]
    Rpc(String),

    /// A faucet request failed.
    #[error("faucet error: {0}")]
    Faucet(String),

    /// A transaction could not be built, signed, or submitted.
    #[error("transaction error: {0}")]
    Transaction(String),

    /// The pool member does not hold enough funds for the requested operation.
    #[error("insufficient funds: {0}")]
    InsufficientFunds(String),

    /// A caller-supplied argument was invalid.
    #[error("invalid input: {0}")]
    InvalidInput(String),
}

/// Convenient alias for async `wallet-pool` results.
pub type Result<T> = std::result::Result<T, Error>;
