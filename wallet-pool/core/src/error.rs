//! Core error types for `wallet-pool-core`.
//!
//! All display messages are intentionally free of secret material.

use thiserror::Error;

/// Errors returned by the sync, sans-IO wallet pool core.
#[derive(Debug, Error, PartialEq)]
pub enum Error {
    /// The access value could not unlock the sealed envelope.
    #[error("wrong access value")]
    WrongAccessValue,

    /// A caller-supplied argument was invalid.
    #[error("invalid input: {0}")]
    InvalidInput(String),

    /// A pool blob could not be parsed or validated.
    #[error("invalid blob: {0}")]
    InvalidBlob(String),

    /// The requested network does not match the pool's network.
    #[error("network mismatch: expected {expected}, got {got}")]
    NetworkMismatch { expected: String, got: String },

    /// The requested account has been disabled.
    #[error("account disabled: {address}")]
    AccountDisabled { address: String },

    /// A member was not found by the supplied selector.
    #[error("member not found by {by}")]
    MemberNotFound { by: String },

    /// The master account could not be retrieved.
    #[error("master account not retrievable")]
    MasterNotRetrievable,
}

/// Convenient alias for core results.
pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_display_contains_no_secrets() {
        let cases: Vec<(Error, &str)> = vec![
            (Error::WrongAccessValue, "wrong access value"),
            (
                Error::InvalidInput("bad option".into()),
                "invalid input: bad option",
            ),
            (
                Error::InvalidBlob("missing field".into()),
                "invalid blob: missing field",
            ),
            (
                Error::NetworkMismatch {
                    expected: "mainnet".into(),
                    got: "testnet".into(),
                },
                "network mismatch: expected mainnet, got testnet",
            ),
            (
                Error::AccountDisabled {
                    address: "0xabc".into(),
                },
                "account disabled: 0xabc",
            ),
            (
                Error::MemberNotFound {
                    by: "address=0x123".into(),
                },
                "member not found by address=0x123",
            ),
            (
                Error::MasterNotRetrievable,
                "master account not retrievable",
            ),
        ];

        for (err, expected) in cases {
            let message = err.to_string();
            assert!(
                !message.contains("secret") && !message.contains("password") && !message.contains("key"),
                "error message '{message}' may leak secret material"
            );
            assert_eq!(message, expected);
        }
    }
}
