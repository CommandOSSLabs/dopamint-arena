//! A run's resolved configuration and its per-mode `run-swarm` argv builder.
//!
//! A [`RunConfig`] is a [`StartRun`] plus the daemon's generated `run_id`.
//! [`swarm_args`] turns it into the argv for one swarm's hidden `run-swarm`
//! subprocess, applying the [`SpawnMode`]: `distribute` splits the numeric
//! `tunnels` target across swarms (remainder to the low indices), while
//! `replicate`/`sequential` forward the per-swarm target unchanged. It is pure
//! so the fan-out is unit-testable without spawning a process.

use crate::proto::{CohortWire, SpawnMode, StartRun};

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
}

impl RunConfig {
    /// Fold a daemon-generated `run_id` into a client's [`StartRun`].
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
    args.extend(cfg.extra.iter().cloned());
    args
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
