//! Async wallet pool built on top of `wallet-pool-core`.

pub mod client;
pub mod error;
pub mod fund;
pub mod key_cache;
pub mod rpc;
pub mod sign;
pub mod store;

pub use client::{
    AddMembersOptions, AddMembersResult, BalanceOptions, By, CacheMode, CreateOptions,
    CreateResult, FundBatchOptions, FundOptions, ListOptions, OpenOptions, PoolSummary,
    SetEnabledOptions, SignAndExecuteOptions, WalletBalanceMap, WalletPool, WalletPoolHandle,
};
pub use wallet_pool_core::blob::{Network, WalletEntry, WalletRole};
pub use wallet_pool_core::filter::{Filter, Pagination, Sort, SortField};

#[cfg(test)]
mod tests {
    use crate::error::Error;

    #[test]
    fn core_error_converts() {
        let core_err = wallet_pool_core::error::Error::WrongAccessValue;
        let err: Error = core_err.into();
        assert!(err.to_string().contains("core error"));
    }
}
