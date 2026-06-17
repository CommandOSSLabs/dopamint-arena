//! Typed runtime configuration, loaded from environment variables.
//!
//! On-chain/Walrus vars are `Option`: Phase 0 consumes none of them, so the
//! service must boot without them. The phase that *uses* a var resolves it with
//! `Config::require` at service-construction time, which fails loud naming the
//! missing var — moving the "fail loudly" guarantee to the consuming boundary
//! instead of hard-failing Phase 0 on env it never reads.

// Most fields are consumed from Phase 1 (settler) / Phase 2 (Walrus) onward; only
// `bind_addr` is read in Phase 0. `derive(Debug)` does not count as a read for the
// dead-code lint, so allow it on the foundation until the consumers land.
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct Config {
    pub bind_addr: String,
    pub coin_type: String,
    pub sui_rpc_url: Option<String>,
    pub package_id: Option<String>,
    pub settler_key: Option<String>, // base64 ed25519 secret of the gas/settler account
    pub walrus_publisher_url: Option<String>,
    pub walrus_aggregator_url: Option<String>,
    pub redis_cache_url: Option<String>,
    pub redis_pubsub_url: Option<String>,
    pub instance_id: Option<String>,
}

impl Config {
    /// Load from env. Only `bind_addr`/`coin_type` have defaults; the rest are
    /// optional here and validated by `require` when a phase consumes them.
    pub fn from_env() -> anyhow::Result<Self> {
        let opt = |key: &str| std::env::var(key).ok();
        Ok(Self {
            bind_addr: std::env::var("TUNNEL_MANAGER_ADDR")
                .unwrap_or_else(|_| "0.0.0.0:8080".into()),
            coin_type: std::env::var("TUNNEL_COIN_TYPE").unwrap_or_else(|_| "0x2::sui::SUI".into()),
            sui_rpc_url: opt("SUI_RPC_URL"),
            package_id: opt("TUNNEL_PACKAGE_ID"),
            settler_key: opt("SUI_SETTLER_KEY"),
            walrus_publisher_url: opt("WALRUS_PUBLISHER_URL"),
            walrus_aggregator_url: opt("WALRUS_AGGREGATOR_URL"),
            redis_cache_url: opt("REDIS_CACHE_URL"),
            redis_pubsub_url: opt("REDIS_PUBSUB_URL"),
            instance_id: opt("INSTANCE_ID"),
        })
    }

    /// Resolve a phase-required var, failing loud with its name. Called at service
    /// construction (e.g. building the settler in Phase 1) — not at startup.
    #[allow(dead_code)] // first caller lands in Phase 1 (settler construction)
    pub fn require<'a>(name: &str, value: &'a Option<String>) -> anyhow::Result<&'a str> {
        value
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("missing required env var: {name}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Phase 0 consumes no on-chain/Walrus config, so it must boot without it:
    // defaults apply and the optional vars stay unset.
    #[test]
    fn from_env_boots_without_onchain_vars() {
        for k in [
            "SUI_RPC_URL",
            "TUNNEL_PACKAGE_ID",
            "SUI_SETTLER_KEY",
            "WALRUS_PUBLISHER_URL",
            "WALRUS_AGGREGATOR_URL",
            "TUNNEL_MANAGER_ADDR",
        ] {
            std::env::remove_var(k);
        }
        let c = Config::from_env().expect("Phase 0 boots without on-chain env");
        assert_eq!(c.bind_addr, "0.0.0.0:8080");
        assert_eq!(c.coin_type, "0x2::sui::SUI");
        assert!(c.sui_rpc_url.is_none());
    }

    #[test]
    fn from_env_reads_redis_and_instance() {
        std::env::set_var("REDIS_CACHE_URL", "rediss://cache:6379");
        let c = Config::from_env().unwrap();
        assert_eq!(c.redis_cache_url.as_deref(), Some("rediss://cache:6379"));
        std::env::remove_var("REDIS_CACHE_URL");
    }

    // The fail-loud guarantee lives at the consuming boundary: `require` must name
    // the missing var so a misconfigured deploy fails clearly when it wires the feature.
    #[test]
    fn require_names_the_missing_var() {
        let err = Config::require("SUI_RPC_URL", &None)
            .unwrap_err()
            .to_string();
        assert!(err.contains("SUI_RPC_URL"), "got: {err}");
    }
}
