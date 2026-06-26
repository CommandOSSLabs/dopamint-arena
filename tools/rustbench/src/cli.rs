//! Command-line surface for the swarm bench binary. Parses the loadbench-style
//! flags, resolves `--workers auto`, and rejects flags this build does not yet
//! support (relay/onchain/concurrency/…) with explanatory errors rather than
//! silently ignoring them.

use clap::Parser;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Runner {
    Simple,
    Optimized,
    Both,
}

#[derive(Clone, Debug)]
pub struct BenchOpts {
    pub workers: usize,
    pub duration_secs: u64,
    pub matches: Option<u64>,
    pub runner: Runner,
    /// Generate two fresh ed25519 keypairs per match (mirrors loadbench's
    /// per-match `generateKeyPairSync`) for an apples-to-apples harness number.
    pub fresh_keys: bool,
}

/// Raw clap layout. Validated and lowered into `BenchOpts` by `parse`.
#[derive(Parser, Debug)]
#[command(no_binary_name = true, disable_help_flag = false)]
struct Raw {
    #[arg(long, default_value = "auto")]
    workers: String,
    #[arg(long, default_value_t = 15)]
    duration: u64,
    #[arg(long)]
    matches: Option<u64>,
    #[arg(long, default_value = "both")]
    runner: String,
    /// Generate fresh keys per match (apples-to-apples with loadbench's harness).
    #[arg(long)]
    fresh_keys: bool,
    /// Accepted and ignored — `--offchain` is the only supported anchor mode.
    #[allow(dead_code)]
    #[arg(long)]
    offchain: bool,
    #[arg(long)]
    onchain: bool,
    #[arg(long, default_value = "local")]
    channel: String,
    #[arg(long, default_value = "blackjack")]
    game: String,
    /// Removed: meaningless in the synchronous CPU path. Present so we can
    /// reject it with a clear message instead of a generic "unexpected arg".
    #[arg(long)]
    concurrency: Option<u64>,
}

pub fn parse(args: impl IntoIterator<Item = String>) -> Result<BenchOpts, String> {
    let raw = Raw::try_parse_from(args).map_err(|e| e.to_string())?;

    if raw.concurrency.is_some() {
        return Err("--concurrency is not supported: rustbench runs matches \
                    synchronously per thread, so there is no per-worker concurrency \
                    to set (drop the flag)."
            .to_string());
    }
    if raw.onchain {
        return Err("--onchain is not supported in this build (see Plan 6)".to_string());
    }
    if raw.channel != "local" {
        return Err(format!(
            "--channel {} is not supported in this build; only 'local' (see Plan 5)",
            raw.channel
        ));
    }
    if raw.game != "blackjack" {
        return Err(format!(
            "--game {} is not supported in this build; only 'blackjack'",
            raw.game
        ));
    }

    let workers = if raw.workers == "auto" {
        std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1)
    } else {
        raw.workers.parse::<usize>().map_err(|_| {
            format!(
                "--workers must be a positive integer or 'auto', got {}",
                raw.workers
            )
        })?
    };
    if workers == 0 {
        return Err("--workers must be at least 1".to_string());
    }

    let runner = match raw.runner.as_str() {
        "simple" => Runner::Simple,
        "optimized" => Runner::Optimized,
        "both" => Runner::Both,
        other => {
            return Err(format!(
                "--runner must be simple|optimized|both, got {other}"
            ))
        }
    };

    Ok(BenchOpts {
        workers,
        duration_secs: raw.duration,
        matches: raw.matches,
        runner,
        fresh_keys: raw.fresh_keys,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_v(args: &[&str]) -> Result<BenchOpts, String> {
        parse(args.iter().map(|s| s.to_string()))
    }

    #[test]
    fn parses_the_headline_bun_command_line() {
        let o = parse_v(&["--offchain", "--channel", "local", "--game", "blackjack"]).unwrap();
        assert_eq!(o.duration_secs, 15);
        assert_eq!(o.matches, None);
        assert_eq!(o.runner, Runner::Both);
        assert!(o.workers >= 1);
    }

    #[test]
    fn workers_auto_resolves_to_core_count() {
        let o = parse_v(&["--workers", "auto"]).unwrap();
        assert_eq!(
            o.workers,
            std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(1)
        );
    }

    #[test]
    fn explicit_workers_and_matches_and_runner() {
        let o = parse_v(&["--workers", "1", "--matches", "10", "--runner", "simple"]).unwrap();
        assert_eq!(o.workers, 1);
        assert_eq!(o.matches, Some(10));
        assert_eq!(o.runner, Runner::Simple);
    }

    #[test]
    fn fresh_keys_flag_parses_and_defaults_off() {
        assert!(!parse_v(&["--runner", "simple"]).unwrap().fresh_keys);
        assert!(
            parse_v(&["--runner", "simple", "--fresh-keys"])
                .unwrap()
                .fresh_keys
        );
    }

    #[test]
    fn concurrency_is_rejected_with_explanation() {
        let err = parse_v(&["--concurrency", "2"]).unwrap_err();
        assert!(
            err.contains("concurrency"),
            "message should name the flag: {err}"
        );
    }

    #[test]
    fn onchain_and_relay_are_rejected() {
        assert!(parse_v(&["--onchain"]).is_err());
        assert!(parse_v(&["--channel", "relay"]).is_err());
        assert!(parse_v(&["--game", "poker"]).is_err());
    }
}
