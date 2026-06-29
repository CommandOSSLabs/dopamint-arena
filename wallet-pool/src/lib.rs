//! Async wallet pool built on top of `wallet-pool-core`.

pub mod error;
pub mod fund;
pub mod key_cache;
pub mod rpc;
pub mod store;

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
