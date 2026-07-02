//! `run-swarm` argument surface and its mapping to a [`SwarmParams`].
//!
//! The daemon spawns one hidden `run-swarm` subprocess per swarm; these flags are
//! the wire between the daemon's per-mode argv builder and the staged pipeline.
//! `to_params` is a pure translation (flags -> [`SwarmParams`]) so it is unit
//! testable without spawning a process or building a runtime.

use std::time::Duration;

use clap::Args;
use sui_tunnel_anchor::{
    SuiFundingProfile, SuiOpenBatchingConfig, SuiOpenMode, SuiSettleMode, SuiStakeSource,
};

use crate::swarm::anchor::{ptb_batching, SuiAnchorOpts, SuiContext};
use crate::swarm::pipeline::{AnchorChoice, CohortConfig, HeartbeatConfig, SwarmParams};
use crate::swarm::protocol::{ProtocolKind, Scenario};

/// Worker-thread default: the machine's parallelism, or 1 when unknown.
fn default_workers() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
}

/// Flags for the hidden `run-swarm` subcommand. One invocation runs a single
/// swarm's staged open -> play -> settle pipeline and prints its report.
#[derive(Args, Debug)]
pub struct RunSwarmArgs {
    /// Run this swarm belongs to; folded into every tunnel id so concurrent runs
    /// never collide.
    #[arg(long)]
    run_id: String,
    /// This swarm's index within the run (0-based).
    #[arg(long)]
    swarm_index: u64,
    /// Total swarms in the run; sets the tunnel-id stride.
    #[arg(long)]
    swarm_count: u64,
    /// Tunnels this swarm opens, plays, and settles.
    #[arg(long)]
    tunnels: u64,
    /// Canonical protocol id (e.g. `blackjack.v2`, `payments.v1`).
    #[arg(long, default_value = "blackjack.v2")]
    protocol: String,
    /// Gameplay seed regime: `golden` (constant) or `varied` (per-tunnel).
    #[arg(long, default_value = "golden")]
    scenario: String,
    /// Per-seat opening stake.
    #[arg(long, default_value_t = 1_000_000)]
    initial_balance: u64,
    /// Chain backend: `memory` or `sui-sponsored`.
    #[arg(long, default_value = "memory")]
    anchor: String,
    /// Tokio worker threads for the swarm runtime.
    #[arg(long, default_value_t = default_workers())]
    workers: usize,
    /// Graceful play deadline in seconds; `0` disables the deadline.
    #[arg(long, default_value_t = 0)]
    duration: u64,
    /// Graceful per-tunnel move cap; unset runs to the protocol terminal.
    #[arg(long)]
    moves: Option<u64>,
    /// Max opens in flight concurrently; unset opens all at once.
    #[arg(long)]
    open_cohort: Option<usize>,
    /// Delay between open cohorts, milliseconds.
    #[arg(long, default_value_t = 0)]
    open_spacing_ms: u64,
    /// Max settles in flight concurrently; unset settles all at once.
    #[arg(long)]
    settle_cohort: Option<usize>,
    /// Delay between settle cohorts, milliseconds.
    #[arg(long, default_value_t = 0)]
    settle_spacing_ms: u64,
    /// Live-telemetry sink base URL; unset disables heartbeating.
    #[arg(long)]
    heartbeat_url: Option<String>,
    /// Heartbeat flush cadence, milliseconds.
    #[arg(long, default_value_t = 250)]
    heartbeat_flush_ms: u64,
    /// Emit the swarm report as JSON (for the daemon) instead of a human render.
    #[arg(long)]
    json: bool,

    // --- Sui sponsored anchor (`--anchor sui-sponsored`) ---
    /// Sui gRPC endpoint for sponsored opens.
    #[arg(long)]
    sui_rpc_url: Option<String>,
    /// Dopamint tunnel-manager base URL for sponsor + settle calls.
    #[arg(long)]
    sui_backend_url: Option<String>,
    /// Published Sui Tunnel package id.
    #[arg(long)]
    sui_package_id: Option<String>,
    /// Move coin type for the `Tunnel<T>` object.
    #[arg(long, default_value = "0x2::sui::SUI")]
    sui_tunnel_coin_type: String,
    /// Bech32 Sui private key for the single-funder profile.
    #[arg(long)]
    sui_funder_priv_key: Option<String>,
    /// Sui open flow.
    #[arg(long, default_value = "sponsored-create-and-fund")]
    sui_open_mode: String,
    /// Sui settle flow.
    #[arg(long, default_value = "backend-settle")]
    sui_settle_mode: String,
    /// Sui funding profile.
    #[arg(long, default_value = "single-funder")]
    sui_funding_profile: String,
    /// Stake source for the single-funder profile.
    #[arg(long, default_value = "address-balance")]
    sui_stake_source: String,
    /// Funder-owned stake coin object for `--sui-stake-source coin-object`.
    #[arg(long)]
    sui_funder_stake_coin_id: Option<String>,
    /// Layer-2 PTB pack size for opens: max sponsored opens packed into one PTB
    /// before submit; unset keeps the anchor default. Distinct from `--open-cohort`
    /// (Layer-1 pipeline concurrency).
    #[arg(long)]
    sui_open_batch: Option<usize>,
    /// Layer-2 PTB pack size for settles: max settles packed into one PTB before
    /// submit; unset keeps the anchor default. Distinct from `--settle-cohort`.
    #[arg(long)]
    sui_settle_batch: Option<usize>,
}

impl RunSwarmArgs {
    /// Whether the report should be emitted as JSON (daemon-parsed) rather than
    /// the human render. Read before [`to_params`](Self::to_params) consumes self.
    pub fn wants_json(&self) -> bool {
        self.json
    }

    /// Translate the parsed flags into a [`SwarmParams`]. Pure; the only fallible
    /// steps are protocol/scenario/anchor validation.
    pub fn to_params(self) -> Result<SwarmParams, String> {
        let protocol = ProtocolKind::from_id(&self.protocol)?;
        let scenario = match self.scenario.as_str() {
            "golden" => Scenario::Golden,
            "varied" => Scenario::Varied,
            other => return Err(format!("--scenario must be golden|varied, got {other}")),
        };
        let anchor = self.build_anchor()?;
        let cohorts = CohortConfig {
            open_cohort: self.open_cohort,
            open_spacing: Duration::from_millis(self.open_spacing_ms),
            settle_cohort: self.settle_cohort,
            settle_spacing: Duration::from_millis(self.settle_spacing_ms),
        };
        let heartbeat = self.heartbeat_url.map(|url| HeartbeatConfig {
            url,
            flush_ms: self.heartbeat_flush_ms,
        });
        Ok(SwarmParams {
            run_id: self.run_id,
            swarm_index: self.swarm_index,
            swarm_count: self.swarm_count,
            tunnels: self.tunnels,
            protocol,
            scenario,
            initial_balance: self.initial_balance,
            anchor,
            cohorts,
            workers: self.workers.max(1),
            duration_secs: self.duration,
            moves: self.moves,
            heartbeat,
            telemetry_collect: false,
        })
    }

    fn build_anchor(&self) -> Result<AnchorChoice, String> {
        match self.anchor.as_str() {
            "memory" => Ok(AnchorChoice::Memory),
            "sui-sponsored" | "sui" => Ok(AnchorChoice::Sui(self.build_sui_context()?)),
            other => Err(format!("--anchor must be memory|sui-sponsored, got {other}")),
        }
    }

    /// The Layer-2 PTB batch configs (open, settle) derived from
    /// `--sui-open-batch`/`--sui-settle-batch`. Split out so the mapping is
    /// unit-testable without constructing a live Sui anchor.
    fn sui_batching(&self) -> (SuiOpenBatchingConfig, SuiOpenBatchingConfig) {
        (
            ptb_batching(self.sui_open_batch),
            ptb_batching(self.sui_settle_batch),
        )
    }

    /// Build the shared sponsored Sui anchor from the `--sui-*` flags. The
    /// `--sui-open-batch`/`--sui-settle-batch` knobs set the Layer-2 PTB pack size
    /// (max entries per PTB); every other batching knob keeps its anchor default.
    fn build_sui_context(&self) -> Result<SuiContext, String> {
        let rpc_url = self
            .sui_rpc_url
            .clone()
            .ok_or("--sui-rpc-url is required for --anchor sui-sponsored")?;
        let backend_url = self
            .sui_backend_url
            .clone()
            .ok_or("--sui-backend-url is required for --anchor sui-sponsored")?;
        let package_id = self
            .sui_package_id
            .clone()
            .ok_or("--sui-package-id is required for --anchor sui-sponsored")?;
        let open_mode = match self.sui_open_mode.as_str() {
            "sponsored-create-and-fund" => SuiOpenMode::SponsoredCreateAndFund,
            "direct-create-and-fund" => SuiOpenMode::DirectCreateAndFund,
            other => return Err(format!("--sui-open-mode unsupported: {other}")),
        };
        let settle_mode = match self.sui_settle_mode.as_str() {
            "backend-settle" => SuiSettleMode::BackendSettle,
            "sponsored-settle" => SuiSettleMode::SponsoredSettle,
            "direct-settle" => SuiSettleMode::DirectSettle,
            other => return Err(format!("--sui-settle-mode unsupported: {other}")),
        };
        let funding_profile = match self.sui_funding_profile.as_str() {
            "single-funder" => {
                let priv_key = self
                    .sui_funder_priv_key
                    .clone()
                    .ok_or("--sui-funder-priv-key is required for single-funder")?;
                let stake_source = match self.sui_stake_source.as_str() {
                    "coin-object" => SuiStakeSource::CoinObject {
                        coin_id: self.sui_funder_stake_coin_id.clone().ok_or(
                            "--sui-funder-stake-coin-id is required for --sui-stake-source coin-object",
                        )?,
                    },
                    "address-balance" => SuiStakeSource::AddressBalance,
                    other => return Err(format!("--sui-stake-source unsupported: {other}")),
                };
                SuiFundingProfile::SingleFunder {
                    priv_key,
                    stake_source,
                }
            }
            other => return Err(format!("--sui-funding-profile unsupported: {other}")),
        };
        let (open_batching, settle_batching) = self.sui_batching();
        let opts = SuiAnchorOpts {
            rpc_url,
            backend_url,
            package_id,
            tunnel_coin_type: self.sui_tunnel_coin_type.clone(),
            open_mode,
            settle_mode,
            funding_profile,
            open_batching,
            settle_batching,
        };
        SuiContext::build(&opts)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Wrap the subcommand args in a throwaway top-level parser so we can exercise
    /// the real clap parsing path in a unit test.
    #[derive(clap::Parser)]
    struct TestCli {
        #[command(flatten)]
        args: RunSwarmArgs,
    }

    fn parse(argv: &[&str]) -> RunSwarmArgs {
        use clap::Parser;
        TestCli::parse_from(argv).args
    }

    #[test]
    fn golden_memory_args_map_to_params() {
        let args = parse(&[
            "run-swarm",
            "--run-id",
            "run-7",
            "--swarm-index",
            "1",
            "--swarm-count",
            "3",
            "--tunnels",
            "2",
            "--protocol",
            "blackjack.v2",
            "--scenario",
            "golden",
            "--anchor",
            "memory",
            "--moves",
            "50",
            "--open-cohort",
            "8",
            "--settle-spacing-ms",
            "5",
            "--json",
        ]);
        assert!(args.wants_json());

        let params = args.to_params().expect("golden memory params");
        assert_eq!(params.run_id, "run-7");
        assert_eq!(params.swarm_index, 1);
        assert_eq!(params.swarm_count, 3);
        assert_eq!(params.tunnels, 2);
        assert_eq!(params.protocol, ProtocolKind::BlackjackV2);
        assert_eq!(params.scenario, Scenario::Golden);
        assert_eq!(params.moves, Some(50));
        assert_eq!(params.cohorts.open_cohort, Some(8));
        assert_eq!(params.cohorts.settle_spacing, Duration::from_millis(5));
        assert!(matches!(params.anchor, AnchorChoice::Memory));
        assert!(params.heartbeat.is_none());
    }

    #[test]
    fn sui_batch_flags_map_to_ptb_pack_size() {
        let args = parse(&[
            "run-swarm",
            "--run-id",
            "r",
            "--swarm-index",
            "0",
            "--swarm-count",
            "1",
            "--tunnels",
            "1",
            "--sui-open-batch",
            "25",
            "--sui-settle-batch",
            "40",
        ]);
        let (open, settle) = args.sui_batching();
        assert_eq!(open.max_batch_size, 25);
        assert_eq!(settle.max_batch_size, 40);
    }

    #[test]
    fn sui_batch_defaults_to_anchor_pack_size_when_unset() {
        let args = parse(&[
            "run-swarm",
            "--run-id",
            "r",
            "--swarm-index",
            "0",
            "--swarm-count",
            "1",
            "--tunnels",
            "1",
        ]);
        let (open, settle) = args.sui_batching();
        let default = SuiOpenBatchingConfig::default();
        assert_eq!(open.max_batch_size, default.max_batch_size);
        assert_eq!(settle.max_batch_size, default.max_batch_size);
    }

    #[test]
    fn unknown_scenario_is_rejected() {
        let args = parse(&[
            "run-swarm",
            "--run-id",
            "r",
            "--swarm-index",
            "0",
            "--swarm-count",
            "1",
            "--tunnels",
            "1",
            "--scenario",
            "bogus",
        ]);
        assert!(args.to_params().is_err());
    }
}
