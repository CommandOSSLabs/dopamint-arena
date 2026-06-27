//! Command-line surface for the swarm bench binary. Parses the loadbench-style
//! flags, resolves `--workers auto`, and rejects flags this build does not yet
//! support (relay/onchain/concurrency/…) with explanatory errors rather than
//! silently ignoring them.

use clap::{CommandFactory, Parser};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Runner {
    Simple,
    Optimized,
    Both,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CodecKind {
    Json,
    Bcs,
    Postcard,
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
    /// Card distribution mode for the swarm (`Varied` by default).
    pub card_mode: crate::swarm::CardMode,
    /// Wire codec used to serialize tunnel frames (`Json` by default).
    pub codec: CodecKind,
}

/// Raw clap layout. Validated and lowered into `BenchOpts` by `parse`.
#[derive(Parser, Debug)]
#[command(
    no_binary_name = true,
    disable_help_flag = false,
    about = "Run the local off-chain blackjack tunnel fleet benchmark.",
    long_about = "Run the local off-chain blackjack tunnel fleet benchmark.\n\n\
The bench drives two in-process TunnelSeat instances per match and reports \
throughput, frame bytes, match counts, and resource usage. It is CPU-local: \
no relay, no chain submission, and no network transport are used.",
    after_help = "Examples:\n  \
fleet-bench --runner simple --matches 50 --deterministic --codec postcard\n  \
fleet-bench --runner both --duration 15 --codec json\n  \
fleet-bench --runner optimized --matches 1000 --fixed-keys --codec bcs\n\n\
Runner values:\n  \
simple: fresh SeatKit per match unless --fixed-keys is set\n  \
optimized: cached per-worker SeatKit\n  \
both: run simple first, then optimized, and report both TPS values\n\n\
Codec values:\n  \
json: TS-parity wire for bot-vs-user and regression baselines\n  \
bcs: fixed-width Sui-native binary wire for bot-vs-bot comparisons\n  \
postcard: compact default candidate for bot-vs-bot"
)]
struct Raw {
    /// Number of rayon workers, or `auto` to use available CPU parallelism.
    #[arg(long, default_value = "auto", value_name = "auto|N")]
    workers: String,
    /// Time-bounded run length in seconds. Ignored once --matches is exhausted.
    #[arg(long, default_value_t = 15, value_name = "SECONDS")]
    duration: u64,
    /// Stop after exactly this many matches. Useful for deterministic regressions.
    #[arg(long, value_name = "N")]
    matches: Option<u64>,
    /// Runner implementation to benchmark: simple, optimized, or both.
    #[arg(long, default_value = "both", value_name = "simple|optimized|both")]
    runner: String,
    /// Frame wire codec: json, bcs, or postcard.
    #[arg(long, default_value = "json", value_name = "json|bcs|postcard")]
    codec: String,
    /// Use fixed seat keys (opt out of the default fresh-per-match keygen).
    #[arg(long)]
    fixed_keys: bool,
    /// Replay the fixed golden 143-move match every time (opt out of varied cards).
    #[arg(long)]
    deterministic: bool,
    /// Accepted and ignored — `--offchain` is the only supported anchor mode.
    #[allow(dead_code)]
    #[arg(long)]
    offchain: bool,
    #[arg(long, hide = true)]
    onchain: bool,
    /// Channel transport. Only `local` is implemented in this synchronous bench.
    #[arg(long, default_value = "local", value_name = "local")]
    channel: String,
    /// Game protocol. Only `blackjack` is implemented by fleet-bench.
    #[arg(long, default_value = "blackjack", value_name = "blackjack")]
    game: String,
    /// Removed: meaningless in the synchronous CPU path. Present so we can
    /// reject it with a clear message instead of a generic "unexpected arg".
    #[arg(long)]
    concurrency: Option<u64>,
}

pub fn help_text() -> String {
    let mut help = Vec::new();
    Raw::command()
        .write_long_help(&mut help)
        .expect("help renders");
    String::from_utf8(help).expect("clap help is utf8")
}

pub fn parse(args: impl IntoIterator<Item = String>) -> Result<BenchOpts, String> {
    let raw = Raw::try_parse_from(args).map_err(|e| e.to_string())?;

    if raw.concurrency.is_some() {
        return Err("--concurrency is not supported: fleet-bench runs matches \
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

    let codec = match raw.codec.as_str() {
        "json" => CodecKind::Json,
        "bcs" => CodecKind::Bcs,
        "postcard" => CodecKind::Postcard,
        other => return Err(format!("--codec must be json|bcs|postcard, got {other}")),
    };

    Ok(BenchOpts {
        workers,
        duration_secs: raw.duration,
        matches: raw.matches,
        runner,
        fresh_keys: !raw.fixed_keys,
        card_mode: if raw.deterministic {
            crate::swarm::CardMode::Deterministic
        } else {
            crate::swarm::CardMode::Varied
        },
        codec,
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
    fn fresh_keys_is_default_on_and_fixed_keys_opts_out() {
        assert!(parse_v(&["--runner", "simple"]).unwrap().fresh_keys);
        assert!(
            !parse_v(&["--runner", "simple", "--fixed-keys"])
                .unwrap()
                .fresh_keys
        );
    }

    #[test]
    fn gameplay_is_varied_by_default_and_deterministic_opts_in() {
        use crate::swarm::CardMode;
        assert_eq!(
            parse_v(&["--runner", "simple"]).unwrap().card_mode,
            CardMode::Varied
        );
        assert_eq!(
            parse_v(&["--runner", "simple", "--deterministic"])
                .unwrap()
                .card_mode,
            CardMode::Deterministic
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

    #[test]
    fn codec_defaults_to_json_and_parses_each_variant() {
        assert_eq!(
            parse_v(&["--runner", "simple"]).unwrap().codec,
            CodecKind::Json
        );
        assert_eq!(
            parse_v(&["--runner", "simple", "--codec", "bcs"])
                .unwrap()
                .codec,
            CodecKind::Bcs
        );
        assert_eq!(
            parse_v(&["--runner", "simple", "--codec", "postcard"])
                .unwrap()
                .codec,
            CodecKind::Postcard
        );
    }

    #[test]
    fn unknown_codec_is_rejected_with_explanation() {
        let err = parse_v(&["--codec", "protobuf"]).unwrap_err();
        assert!(err.contains("codec"), "message should name the flag: {err}");
    }

    #[test]
    fn help_documents_common_runs_and_value_meanings() {
        let help = help_text();

        assert!(help.contains("Run the local off-chain blackjack tunnel fleet benchmark"));
        assert!(help.contains("Examples:"));
        assert!(help
            .contains("fleet-bench --runner simple --matches 50 --deterministic --codec postcard"));
        assert!(help.contains("json: TS-parity wire for bot-vs-user"));
        assert!(help.contains("postcard: compact default candidate for bot-vs-bot"));
        assert!(help.contains("simple|optimized|both"));
        assert!(help.contains("json|bcs|postcard"));
    }
}
