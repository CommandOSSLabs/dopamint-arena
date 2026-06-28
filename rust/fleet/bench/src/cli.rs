//! Command-line surface for the swarm bench binary. Parses the local fleet flags,
//! resolves `--workers auto`, and rejects unsupported transport/anchor modes with
//! explanatory errors rather than silently ignoring them.

use clap::{CommandFactory, Parser};
use tunnel_core::protocol_id::{BLACKJACK_BET_V1, BLACKJACK_V2, PORTED_PROTOCOL_IDS};

const EXECUTABLE_PROTOCOL_IDS: &[&str] = &[BLACKJACK_BET_V1, BLACKJACK_V2];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BenchMode {
    PerMatchSigners,
    PreInitializedSigners,
    CompareSigners,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FrameCodecKind {
    Json,
    Bcs,
    Postcard,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ScenarioMode {
    Varied,
    Golden,
}

impl ScenarioMode {
    pub fn card_seed(self, match_index: u64) -> Option<u64> {
        match self {
            ScenarioMode::Varied => Some(match_index),
            ScenarioMode::Golden => None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct BenchOpts {
    pub workers: usize,
    pub duration_secs: u64,
    pub matches: Option<u64>,
    pub bench_mode: BenchMode,
    pub protocol_id: &'static str,
    /// Protocol scenario for generated matches (`Varied` by default).
    pub scenario: ScenarioMode,
    /// Wire codec used to serialize tunnel frames (`Json` by default).
    pub frame_codec: FrameCodecKind,
}

/// Raw clap layout. Validated and lowered into `BenchOpts` by `parse`.
#[derive(Parser, Debug)]
#[command(
    no_binary_name = true,
    disable_help_flag = false,
    about = "Run the local off-chain blackjack tunnel fleet benchmark.",
    long_about = "Run the local off-chain blackjack tunnel fleet benchmark.\n\n\
The bench drives two in-process PartyRuntime instances per match and reports \
throughput, frame bytes, match counts, and resource usage. It is CPU-local: \
no relay, no chain submission, and no network transport are used.",
    after_help = "Examples:\n  \
fleet-bench --bench-mode per-match-signers --matches 50 --scenario golden --frame-codec postcard\n  \
fleet-bench --bench-mode compare-signers --matches 1000 --frame-codec json\n  \
fleet-bench --bench-mode pre-initialized-signers --matches 1000 --frame-codec bcs\n\n\
Bench mode values:\n  \
per-match-signers: create signer material inside each measured match\n  \
pre-initialized-signers: create all signer material before the timed run\n  \
compare-signers: run per-match-signers first, then pre-initialized-signers\n\n\
Protocol IDs:\n  \
fleet-bench currently executes blackjack.bet.v1. Ported Rust protocol IDs are:\n  \
api_credits.v1, battleship.v1, battleship.series.v1, blackjack.bet.v1,\n  \
blackjack.duel.v1, blackjack.v2, bomb_it.v1, bomb_it.series.v1, caro.v1,\n  \
caro.series.v1, chat.v1, cross.v1, cross.series.v1, payments.v1,\n  \
quantum_poker.v2, tic_tac_toe.v1, tic_tac_toe.series.v1,\n  \
world_canvas.cell.v1, world_canvas.stroke.v1\n\n\
Frame codec values:\n  \
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
    /// Stop after exactly this many matches. Useful for golden regressions.
    #[arg(long, value_name = "N")]
    matches: Option<u64>,
    /// Measurement mode: per-match-signers, pre-initialized-signers, or compare-signers.
    #[arg(
        long = "bench-mode",
        default_value = "per-match-signers",
        value_name = "per-match-signers|pre-initialized-signers|compare-signers"
    )]
    bench_mode: String,
    /// Frame wire codec: json, bcs, or postcard.
    #[arg(
        long = "frame-codec",
        default_value = "json",
        value_name = "json|bcs|postcard"
    )]
    frame_codec: String,
    /// Protocol scenario: varied gameplay or the protocol's golden regression case.
    #[arg(long, default_value = "varied", value_name = "varied|golden")]
    scenario: String,
    /// Accepted and ignored — `--offchain` is the only supported anchor mode.
    #[allow(dead_code)]
    #[arg(long)]
    offchain: bool,
    #[arg(long, hide = true)]
    onchain: bool,
    /// Frame transport. Only `local` is implemented in this synchronous bench.
    #[arg(
        long = "frame-transport",
        default_value = "local",
        value_name = "local"
    )]
    frame_transport: String,
    /// Protocol ID to execute.
    #[arg(long = "protocol-id", default_value = BLACKJACK_BET_V1, value_name = "ID")]
    protocol_id: String,
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

    if raw.onchain {
        return Err("--onchain is not supported in this build (see Plan 6)".to_string());
    }
    if raw.frame_transport != "local" {
        return Err(format!(
            "--frame-transport {} is not supported in this build; only 'local' (see Plan 5)",
            raw.frame_transport
        ));
    }
    if !PORTED_PROTOCOL_IDS.contains(&raw.protocol_id.as_str()) {
        return Err(format!(
            "--protocol-id {} is not a ported Rust protocol ID; known IDs: {}",
            raw.protocol_id,
            PORTED_PROTOCOL_IDS.join(", ")
        ));
    }
    let protocol_id = match raw.protocol_id.as_str() {
        BLACKJACK_BET_V1 => BLACKJACK_BET_V1,
        BLACKJACK_V2 => BLACKJACK_V2,
        _ => {
            return Err(format!(
                "--protocol-id {} is ported but fleet-bench can currently execute only {}",
                raw.protocol_id,
                EXECUTABLE_PROTOCOL_IDS.join(", ")
            ));
        }
    };

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

    let bench_mode = match raw.bench_mode.as_str() {
        "per-match-signers" => BenchMode::PerMatchSigners,
        "pre-initialized-signers" => BenchMode::PreInitializedSigners,
        "compare-signers" => BenchMode::CompareSigners,
        other => {
            return Err(format!(
                "--bench-mode must be per-match-signers|pre-initialized-signers|compare-signers, got {other}"
            ))
        }
    };
    if matches!(
        bench_mode,
        BenchMode::PreInitializedSigners | BenchMode::CompareSigners
    ) && raw.matches.is_none()
    {
        return Err(format!(
            "--bench-mode {} requires --matches so the full signer pool can be created before timing",
            raw.bench_mode
        ));
    }

    let frame_codec = match raw.frame_codec.as_str() {
        "json" => FrameCodecKind::Json,
        "bcs" => FrameCodecKind::Bcs,
        "postcard" => FrameCodecKind::Postcard,
        other => {
            return Err(format!(
                "--frame-codec must be json|bcs|postcard, got {other}"
            ))
        }
    };

    let scenario = match raw.scenario.as_str() {
        "varied" => ScenarioMode::Varied,
        "golden" => ScenarioMode::Golden,
        other => return Err(format!("--scenario must be varied|golden, got {other}")),
    };

    Ok(BenchOpts {
        workers,
        duration_secs: raw.duration,
        matches: raw.matches,
        bench_mode,
        protocol_id,
        scenario,
        frame_codec,
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
        let o = parse_v(&[
            "--offchain",
            "--frame-transport",
            "local",
            "--protocol-id",
            "blackjack.bet.v1",
        ])
        .unwrap();
        assert_eq!(o.duration_secs, 15);
        assert_eq!(o.matches, None);
        assert_eq!(o.bench_mode, BenchMode::PerMatchSigners);
        assert_eq!(o.protocol_id, "blackjack.bet.v1");
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
    fn explicit_workers_matches_and_bench_mode() {
        let o = parse_v(&[
            "--workers",
            "1",
            "--matches",
            "10",
            "--bench-mode",
            "per-match-signers",
        ])
        .unwrap();
        assert_eq!(o.workers, 1);
        assert_eq!(o.matches, Some(10));
        assert_eq!(o.bench_mode, BenchMode::PerMatchSigners);
    }

    #[test]
    fn pre_initialized_signers_requires_matches() {
        let err = parse_v(&["--bench-mode", "pre-initialized-signers"]).unwrap_err();
        assert!(err.contains("--matches"), "got: {err}");
        assert!(parse_v(&["--bench-mode", "pre-initialized-signers", "--matches", "4"]).is_ok());
    }

    #[test]
    fn scenario_is_varied_by_default_and_golden_opts_in() {
        assert_eq!(
            parse_v(&["--bench-mode", "per-match-signers"])
                .unwrap()
                .scenario,
            ScenarioMode::Varied
        );
        assert_eq!(
            parse_v(&["--bench-mode", "per-match-signers", "--scenario", "golden"])
                .unwrap()
                .scenario,
            ScenarioMode::Golden
        );
    }

    #[test]
    fn removed_concurrency_is_rejected_by_clap() {
        let err = parse_v(&["--concurrency", "2"]).unwrap_err();
        assert!(
            err.contains("concurrency"),
            "message should name the flag: {err}"
        );
    }

    #[test]
    fn onchain_and_relay_are_rejected() {
        assert!(parse_v(&["--onchain"]).is_err());
        assert!(parse_v(&["--frame-transport", "relay"]).is_err());
        assert!(parse_v(&["--protocol-id", "poker.v1"]).is_err());
        assert!(parse_v(&["--protocol-id", "payments.v1"]).is_err());
    }

    #[test]
    fn blackjack_v2_protocol_id_is_executable() {
        let o = parse_v(&["--protocol-id", "blackjack.v2"]).unwrap();
        assert_eq!(o.protocol_id, "blackjack.v2");
    }

    #[test]
    fn frame_codec_defaults_to_json_and_parses_each_variant() {
        assert_eq!(
            parse_v(&["--bench-mode", "per-match-signers"])
                .unwrap()
                .frame_codec,
            FrameCodecKind::Json
        );
        assert_eq!(
            parse_v(&["--bench-mode", "per-match-signers", "--frame-codec", "bcs"])
                .unwrap()
                .frame_codec,
            FrameCodecKind::Bcs
        );
        assert_eq!(
            parse_v(&[
                "--bench-mode",
                "per-match-signers",
                "--frame-codec",
                "postcard"
            ])
            .unwrap()
            .frame_codec,
            FrameCodecKind::Postcard
        );
    }

    #[test]
    fn unknown_frame_codec_is_rejected_with_explanation() {
        let err = parse_v(&["--frame-codec", "protobuf"]).unwrap_err();
        assert!(
            err.contains("frame-codec"),
            "message should name the flag: {err}"
        );
    }

    #[test]
    fn help_documents_common_runs_and_value_meanings() {
        let help = help_text();

        assert!(help.contains("Run the local off-chain blackjack tunnel fleet benchmark"));
        assert!(help.contains("Examples:"));
        assert!(help.contains(
            "fleet-bench --bench-mode per-match-signers --matches 50 --scenario golden --frame-codec postcard"
        ));
        assert!(help.contains("json: TS-parity wire for bot-vs-user"));
        assert!(help.contains("postcard: compact default candidate for bot-vs-bot"));
        assert!(help.contains("per-match-signers|pre-initialized-signers|compare-signers"));
        assert!(help.contains("blackjack.bet.v1"));
        assert!(help.contains("json|bcs|postcard"));
    }
}
