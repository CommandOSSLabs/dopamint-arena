//! A run's resolved configuration and its per-mode `run-swarm` argv builder.
//!
//! A [`RunConfig`] is a [`StartRun`] plus the daemon's generated `run_id`.
//! [`swarm_args`] turns it into the argv for one swarm's hidden `run-swarm`
//! subprocess, applying the [`SpawnMode`]: `distribute` splits the numeric
//! `tunnels` target across swarms (remainder to the low indices), while
//! `replicate`/`sequential` forward the per-swarm target unchanged. It is pure
//! so the fan-out is unit-testable without spawning a process.

use crate::proto::{CohortWire, SpawnMode, StartRun};

/// Sui-sponsored anchor settings forwarded verbatim to each swarm's hidden
/// `run-swarm` subprocess.
///
/// These are the run-level `--sui-*` flags (connection, auth, and the Layer-2 PTB
/// pack sizes). [`RunConfig::from_start`] leaves this all-`None` so memory runs and
/// the `--`-passthrough (`extra`) path are unaffected; the daemon populates it per
/// run — Task D2's account pool fills the per-swarm funder/gas fields, so keeping
/// the connection identity structured here (rather than in opaque `extra`) is what
/// lets [`swarm_args`] override those per swarm. `Layer 2` batch sizes are distinct
/// from Layer-1 cohorts ([`CohortWire`]): cohort caps how many tunnels fly at once;
/// batch size caps how many the anchor packs into one PTB.
#[derive(Clone, Debug, Default)]
pub struct SuiRunConfig {
    pub rpc_url: Option<String>,
    pub backend_url: Option<String>,
    pub package_id: Option<String>,
    pub tunnel_coin_type: Option<String>,
    pub open_mode: Option<String>,
    pub settle_mode: Option<String>,
    pub funding_profile: Option<String>,
    pub stake_source: Option<String>,
    pub funder_priv_key: Option<String>,
    pub funder_stake_coin_id: Option<String>,
    /// `--sui-open-batch`: max sponsored opens the anchor packs into one PTB.
    pub open_batch: Option<usize>,
    /// `--sui-settle-batch`: max settles the anchor packs into one PTB.
    pub settle_batch: Option<usize>,
}

/// A run's resolved configuration: a client's [`StartRun`] with the daemon's
/// generated `run_id` folded in. Forwarded verbatim to each swarm except the
/// numeric targets [`swarm_args`] splits for `distribute`.
#[derive(Clone, Debug)]
pub struct RunConfig {
    pub run_id: String,
    pub mode: SpawnMode,
    pub swarms: u64,
    pub protocol: String,
    pub duration: std::time::Duration,
    pub until_stop: bool,
    pub tunnels: u64,
    pub scenario: String,
    pub anchor: String,
    pub initial_balance: u64,
    pub cohorts: CohortWire,
    pub extra: Vec<String>,
    /// Sink root (`http://<sink-addr>`) the daemon's heartbeat sink is bound at,
    /// or `None` when the daemon ran without `--sink-addr`. [`swarm_args`] appends
    /// `--heartbeat-url <root>/runs/<run_id>` so each swarm posts run-scoped
    /// telemetry the sink can fold back to this run.
    pub heartbeat_sink: Option<String>,
    /// Sui-sponsored anchor settings forwarded to each swarm. All-`None` for
    /// memory runs; the daemon populates it for `--anchor sui-sponsored`.
    pub sui: SuiRunConfig,
}

impl RunConfig {
    /// Fold a daemon-generated `run_id` into a client's [`StartRun`]. Telemetry is
    /// off by default; the daemon sets [`RunConfig::heartbeat_sink`] when it runs a
    /// sink.
    pub fn from_start(start: StartRun, run_id: String) -> Self {
        Self {
            run_id,
            mode: start.mode,
            swarms: start.swarms,
            protocol: start.protocol,
            duration: start.duration,
            until_stop: start.until_stop,
            tunnels: start.tunnels,
            scenario: start.scenario,
            anchor: start.anchor,
            initial_balance: start.initial_balance,
            cohorts: start.cohorts,
            extra: start.extra,
            heartbeat_sink: None,
            sui: SuiRunConfig::default(),
        }
    }
}

/// Split `total` into `n` shares, handing the `total % n` remainder to the
/// lowest indices so every unit is placed exactly once (sum of shares == total).
fn split_even(total: u64, n: u64, index: u64) -> u64 {
    let n = n.max(1);
    total / n + u64::from(index < total % n)
}

/// Build the argv (after the `run-swarm` subcommand token) for swarm
/// `swarm_index`. Always carries the run identity (`--run-id/--swarm-index/
/// --swarm-count`) and `--json`; `distribute` splits `--tunnels`, other modes
/// forward it unchanged. `until_stop` maps to `--duration 0` (no deadline).
pub fn swarm_args(cfg: &RunConfig, swarm_index: u64) -> Vec<String> {
    let tunnels = match cfg.mode {
        SpawnMode::Distribute => split_even(cfg.tunnels, cfg.swarms, swarm_index),
        SpawnMode::Replicate | SpawnMode::Sequential => cfg.tunnels,
    };
    let duration_secs = if cfg.until_stop { 0 } else { cfg.duration.as_secs() };

    let mut args = vec![
        "--run-id".to_string(),
        cfg.run_id.clone(),
        "--swarm-index".to_string(),
        swarm_index.to_string(),
        "--swarm-count".to_string(),
        cfg.swarms.to_string(),
        "--json".to_string(),
        "--tunnels".to_string(),
        tunnels.to_string(),
        "--protocol".to_string(),
        cfg.protocol.clone(),
        "--scenario".to_string(),
        cfg.scenario.clone(),
        "--anchor".to_string(),
        cfg.anchor.clone(),
        "--initial-balance".to_string(),
        cfg.initial_balance.to_string(),
        "--duration".to_string(),
        duration_secs.to_string(),
    ];
    if let Some(open_cohort) = cfg.cohorts.open_cohort {
        args.push("--open-cohort".to_string());
        args.push(open_cohort.to_string());
    }
    args.push("--open-spacing-ms".to_string());
    args.push(cfg.cohorts.open_spacing.as_millis().to_string());
    if let Some(settle_cohort) = cfg.cohorts.settle_cohort {
        args.push("--settle-cohort".to_string());
        args.push(settle_cohort.to_string());
    }
    args.push("--settle-spacing-ms".to_string());
    args.push(cfg.cohorts.settle_spacing.as_millis().to_string());
    // Run-scope the swarm's telemetry under the sink root so the sink folds every
    // heartbeat back to this run (the run id rides the URL path).
    if let Some(sink_root) = &cfg.heartbeat_sink {
        args.push("--heartbeat-url".to_string());
        args.push(format!(
            "{}/runs/{}",
            sink_root.trim_end_matches('/'),
            cfg.run_id
        ));
    }
    push_sui_args(&mut args, &cfg.sui);
    args.extend(cfg.extra.iter().cloned());
    args
}

/// Append the run's `--sui-*` flags for every field the daemon set. Only present
/// (`Some`) fields are emitted, so an unset knob keeps the `run-swarm` default
/// rather than forcing a value. Memory runs pass an all-`None` config and add
/// nothing.
fn push_sui_args(args: &mut Vec<String>, sui: &SuiRunConfig) {
    let mut push_str = |flag: &str, value: &Option<String>| {
        if let Some(value) = value {
            args.push(flag.to_string());
            args.push(value.clone());
        }
    };
    push_str("--sui-rpc-url", &sui.rpc_url);
    push_str("--sui-backend-url", &sui.backend_url);
    push_str("--sui-package-id", &sui.package_id);
    push_str("--sui-tunnel-coin-type", &sui.tunnel_coin_type);
    push_str("--sui-open-mode", &sui.open_mode);
    push_str("--sui-settle-mode", &sui.settle_mode);
    push_str("--sui-funding-profile", &sui.funding_profile);
    push_str("--sui-stake-source", &sui.stake_source);
    push_str("--sui-funder-priv-key", &sui.funder_priv_key);
    push_str("--sui-funder-stake-coin-id", &sui.funder_stake_coin_id);
    if let Some(open_batch) = sui.open_batch {
        args.push("--sui-open-batch".to_string());
        args.push(open_batch.to_string());
    }
    if let Some(settle_batch) = sui.settle_batch {
        args.push("--sui-settle-batch".to_string());
        args.push(settle_batch.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn sample_cohorts() -> CohortWire {
        CohortWire {
            open_cohort: Some(4),
            open_spacing: Duration::from_millis(5),
            settle_cohort: None,
            settle_spacing: Duration::ZERO,
        }
    }

    fn cfg(mode: SpawnMode, swarms: u64, tunnels: u64) -> RunConfig {
        RunConfig::from_start(
            StartRun {
                mode,
                swarms,
                protocol: "blackjack.v2".to_string(),
                duration: Duration::from_secs(30),
                until_stop: false,
                tunnels,
                scenario: "golden".to_string(),
                anchor: "memory".to_string(),
                initial_balance: 1_000,
                cohorts: sample_cohorts(),
                extra: vec!["--sui-rpc-url".to_string(), "http://x".to_string()],
            },
            "run-1".to_string(),
        )
    }

    /// Value following the first occurrence of `name` in an argv.
    fn flag<'a>(argv: &'a [String], name: &str) -> Option<&'a str> {
        argv.iter()
            .position(|a| a == name)
            .and_then(|i| argv.get(i + 1))
            .map(String::as_str)
    }

    #[test]
    fn replicate_forwards_tunnels_unchanged() {
        let c = cfg(SpawnMode::Replicate, 3, 12);
        for i in 0..3 {
            assert_eq!(flag(&swarm_args(&c, i), "--tunnels"), Some("12"));
        }
    }

    #[test]
    fn distribute_splits_tunnels_with_remainder_to_low() {
        let c = cfg(SpawnMode::Distribute, 3, 10);
        let per: Vec<u64> = (0..3)
            .map(|i| flag(&swarm_args(&c, i), "--tunnels").unwrap().parse().unwrap())
            .collect();
        assert_eq!(per, vec![4, 3, 3]);
        assert_eq!(per.iter().sum::<u64>(), 10);
    }

    #[test]
    fn sequential_maps_like_replicate() {
        let seq = cfg(SpawnMode::Sequential, 2, 7);
        let rep = cfg(SpawnMode::Replicate, 2, 7);
        for i in 0..2 {
            assert_eq!(
                flag(&swarm_args(&seq, i), "--tunnels"),
                flag(&swarm_args(&rep, i), "--tunnels")
            );
            assert_eq!(flag(&swarm_args(&seq, i), "--tunnels"), Some("7"));
        }
    }

    #[test]
    fn heartbeat_url_is_run_scoped_only_when_a_sink_is_set() {
        let mut c = cfg(SpawnMode::Distribute, 2, 4);
        // No sink configured: swarms run without live telemetry.
        assert_eq!(flag(&swarm_args(&c, 0), "--heartbeat-url"), None);
        // Sink configured: each swarm posts to `<root>/runs/<run_id>`, trailing
        // slash on the root notwithstanding.
        c.heartbeat_sink = Some("http://127.0.0.1:9000/".to_string());
        for i in 0..2 {
            assert_eq!(
                flag(&swarm_args(&c, i), "--heartbeat-url"),
                Some("http://127.0.0.1:9000/runs/run-1")
            );
        }
    }

    #[test]
    fn swarm_args_forward_every_sui_flag_and_batch_size() {
        let mut c = cfg(SpawnMode::Replicate, 2, 4);
        c.extra.clear();
        c.sui = SuiRunConfig {
            rpc_url: Some("https://rpc".to_string()),
            backend_url: Some("https://backend".to_string()),
            package_id: Some("0xpkg".to_string()),
            tunnel_coin_type: Some("0x2::sui::SUI".to_string()),
            open_mode: Some("sponsored-create-and-fund".to_string()),
            settle_mode: Some("backend-settle".to_string()),
            funding_profile: Some("single-funder".to_string()),
            stake_source: Some("coin-object".to_string()),
            funder_priv_key: Some("suiprivkey1abc".to_string()),
            funder_stake_coin_id: Some("0xcoin".to_string()),
            open_batch: Some(25),
            settle_batch: Some(40),
        };
        let a = swarm_args(&c, 0);
        assert_eq!(flag(&a, "--sui-rpc-url"), Some("https://rpc"));
        assert_eq!(flag(&a, "--sui-backend-url"), Some("https://backend"));
        assert_eq!(flag(&a, "--sui-package-id"), Some("0xpkg"));
        assert_eq!(flag(&a, "--sui-tunnel-coin-type"), Some("0x2::sui::SUI"));
        assert_eq!(flag(&a, "--sui-open-mode"), Some("sponsored-create-and-fund"));
        assert_eq!(flag(&a, "--sui-settle-mode"), Some("backend-settle"));
        assert_eq!(flag(&a, "--sui-funding-profile"), Some("single-funder"));
        assert_eq!(flag(&a, "--sui-stake-source"), Some("coin-object"));
        assert_eq!(flag(&a, "--sui-funder-priv-key"), Some("suiprivkey1abc"));
        assert_eq!(flag(&a, "--sui-funder-stake-coin-id"), Some("0xcoin"));
        assert_eq!(flag(&a, "--sui-open-batch"), Some("25"));
        assert_eq!(flag(&a, "--sui-settle-batch"), Some("40"));
    }

    #[test]
    fn memory_runs_forward_no_sui_flags() {
        let mut c = cfg(SpawnMode::Replicate, 1, 1);
        c.extra.clear();
        let a = swarm_args(&c, 0);
        assert!(
            !a.iter().any(|x| x.starts_with("--sui-")),
            "an all-None sui config must not emit any --sui-* flag: {a:?}"
        );
    }

    #[test]
    fn every_swarm_carries_identity_and_json() {
        let c = cfg(SpawnMode::Distribute, 4, 9);
        for i in 0..4 {
            let a = swarm_args(&c, i);
            assert_eq!(flag(&a, "--run-id"), Some("run-1"));
            let idx = i.to_string();
            assert_eq!(flag(&a, "--swarm-index"), Some(idx.as_str()));
            assert_eq!(flag(&a, "--swarm-count"), Some("4"));
            assert!(a.iter().any(|x| x == "--json"), "argv must carry --json");
        }
    }
}
