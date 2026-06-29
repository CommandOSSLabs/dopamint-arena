//! Command-line surface for the swarm bench binary. Parses the local fleet flags,
//! resolves `--workers auto`, and rejects unsupported transport/anchor modes with
//! explanatory errors rather than silently ignoring them.

use clap::{CommandFactory, Parser};
use sui_tunnel_anchor::SuiOpenBatchingConfig;
use tunnel_core::protocol_id::{BLACKJACK_BET_V1, PORTED_PROTOCOL_IDS};

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
pub enum AnchorMode {
    Memory,
    Sui,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TranscriptRecorderMode {
    None,
    Memory,
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
    /// Tunnel anchor implementation (`Memory` by default).
    pub anchor_mode: AnchorMode,
    /// Transcript recorder implementation (`None` by default).
    pub transcript_recorder: TranscriptRecorderMode,
    /// Sui anchor configuration, present only when `anchor_mode == Sui`.
    pub sui_anchor: Option<SuiAnchorOpts>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SuiAnchorOpts {
    pub graphql_url: String,
    pub backend_url: String,
    pub package_id: String,
    pub tunnel_coin_type: String,
    pub funder_priv_key: String,
    pub funder_stake_coin_id: String,
    pub open_batching: SuiOpenBatchingConfig,
}

/// Raw clap layout. Validated and lowered into `BenchOpts` by `parse`.
#[derive(Parser, Debug)]
#[command(
    no_binary_name = true,
    disable_help_flag = false,
    about = "Run the local memory-anchored tunnel fleet benchmark.",
    long_about = "Run the local memory-anchored tunnel fleet benchmark.\n\n\
The bench drives two in-process PartyRuntime instances per match and reports \
throughput, frame bytes, match counts, and resource usage. It uses the memory \
anchor by default, runs CPU-local with local frame transport, and submits no \
chain transactions.",
    after_help = "Examples:\n  \
fleet-bench --anchor memory --bench-mode per-match-signers --matches 50 --scenario golden --frame-codec postcard\n  \
fleet-bench --bench-mode compare-signers --matches 1000 --frame-codec json\n  \
fleet-bench --bench-mode pre-initialized-signers --matches 1000 --frame-codec bcs\n  \
fleet-bench --protocol-id blackjack.v2 --matches 100 --scenario varied --transcript-recorder memory\n\n\
Bench mode values:\n  \
per-match-signers: create signer material inside each measured match\n  \
pre-initialized-signers: create all signer material before the timed run\n  \
compare-signers: run per-match-signers first, then pre-initialized-signers\n\n\
Protocol IDs:\n  \
fleet-bench executes every ported Rust protocol ID:\n  \
api_credits.v1, battleship.v1, battleship.series.v1, blackjack.bet.v1,\n  \
blackjack.duel.v1, blackjack.v2, bomb_it.v1, bomb_it.series.v1, caro.v1,\n  \
caro.series.v1, chat.v1, cross.v1, cross.series.v1, payments.v1,\n  \
quantum_poker.v2, tic_tac_toe.v1, tic_tac_toe.series.v1,\n  \
world_canvas.cell.v1, world_canvas.stroke.v1\n\n\
Frame codec values:\n  \
json: TS-parity wire for bot-vs-user and regression baselines\n  \
bcs: fixed-width Sui-native binary wire for bot-vs-bot comparisons\n  \
postcard: compact default candidate for bot-vs-bot\n\n\
Anchor values:\n  \
memory: in-memory tunnel anchor for local throughput runs; no chain IO\n\n\
sui: Sui Tunnel anchor for sponsored open and settle transactions\n\n\
Transcript recorder values:\n  \
none: do not retain committed transition transcripts\n  \
memory: retain committed transitions in memory during each match; useful for measuring recorder overhead"
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
    /// Tunnel anchor implementation.
    #[arg(long, default_value = "memory", value_name = "memory|sui")]
    anchor: String,
    /// Transcript recorder implementation: none or memory.
    #[arg(
        long = "transcript-recorder",
        default_value = "none",
        value_name = "none|memory"
    )]
    transcript_recorder: String,
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
    /// Sui GraphQL endpoint used by --anchor sui.
    #[arg(long = "sui-graphql-url", value_name = "URL")]
    sui_graphql_url: Option<String>,
    /// Dopamint tunnel-manager backend base URL used by --anchor sui.
    #[arg(long = "sui-backend-url", value_name = "URL")]
    sui_backend_url: Option<String>,
    /// Published Sui Tunnel package id used by --anchor sui.
    #[arg(long = "sui-package-id", value_name = "OBJECT_ID")]
    sui_package_id: Option<String>,
    /// Move coin type for the Sui Tunnel<T> object.
    #[arg(
        long = "sui-tunnel-coin-type",
        default_value = "0x2::sui::SUI",
        value_name = "TYPE"
    )]
    sui_tunnel_coin_type: String,
    /// Sui bech32 private key for the funder wallet used by --anchor sui.
    #[arg(long = "sui-funder-priv-key", value_name = "BECH32")]
    sui_funder_priv_key: Option<String>,
    /// Funder-owned stake coin object used by --anchor sui.
    #[arg(long = "sui-funder-stake-coin-id", value_name = "OBJECT_ID")]
    sui_funder_stake_coin_id: Option<String>,
    /// Maximum Sui sponsored open requests per future PTB batch.
    #[arg(long = "sui-open-batch-size", default_value_t = 50, value_name = "N")]
    sui_open_batch_size: usize,
    /// Future Sui open PTB flush interval in milliseconds.
    #[arg(
        long = "sui-open-batch-flush-ms",
        default_value_t = 250,
        value_name = "MS"
    )]
    sui_open_batch_flush_ms: u64,
    /// Maximum future Sui open request wait time in milliseconds.
    #[arg(
        long = "sui-open-batch-max-wait-ms",
        default_value_t = 1_000,
        value_name = "MS"
    )]
    sui_open_batch_max_wait_ms: u64,
    /// Disable future Sui sponsored open PTB batching.
    #[arg(long = "sui-disable-open-batching")]
    sui_disable_open_batching: bool,
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
    let protocol_id = PORTED_PROTOCOL_IDS
        .iter()
        .copied()
        .find(|id| *id == raw.protocol_id)
        .expect("ported protocol id was validated");

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

    let anchor_mode = match raw.anchor.as_str() {
        "memory" => AnchorMode::Memory,
        "sui" => AnchorMode::Sui,
        other => return Err(format!("--anchor must be memory|sui, got {other}")),
    };

    let transcript_recorder = match raw.transcript_recorder.as_str() {
        "none" => TranscriptRecorderMode::None,
        "memory" => TranscriptRecorderMode::Memory,
        other => {
            return Err(format!(
                "--transcript-recorder must be none|memory, got {other}"
            ))
        }
    };

    let sui_anchor = if anchor_mode == AnchorMode::Sui {
        if transcript_recorder != TranscriptRecorderMode::Memory {
            return Err("--anchor sui requires --transcript-recorder memory".to_string());
        }
        let mut missing = Vec::new();
        if raw.sui_graphql_url.is_none() {
            missing.push("--sui-graphql-url");
        }
        if raw.sui_backend_url.is_none() {
            missing.push("--sui-backend-url");
        }
        if raw.sui_package_id.is_none() {
            missing.push("--sui-package-id");
        }
        if raw.sui_funder_priv_key.is_none() {
            missing.push("--sui-funder-priv-key");
        }
        if raw.sui_funder_stake_coin_id.is_none() {
            missing.push("--sui-funder-stake-coin-id");
        }
        if !missing.is_empty() {
            return Err(format!("--anchor sui requires {}", missing.join(", ")));
        }
        if raw.sui_open_batch_size == 0 {
            return Err("--sui-open-batch-size must be greater than 0".to_string());
        }
        if raw.sui_open_batch_size > 50 {
            return Err("--sui-open-batch-size must be <= 50".to_string());
        }
        if raw.sui_open_batch_flush_ms == 0 {
            return Err("--sui-open-batch-flush-ms must be greater than 0".to_string());
        }
        if raw.sui_open_batch_max_wait_ms < raw.sui_open_batch_flush_ms {
            return Err(
                "--sui-open-batch-max-wait-ms must be greater than or equal to --sui-open-batch-flush-ms"
                    .to_string(),
            );
        }
        Some(SuiAnchorOpts {
            graphql_url: raw.sui_graphql_url.unwrap(),
            backend_url: raw.sui_backend_url.unwrap(),
            package_id: raw.sui_package_id.unwrap(),
            tunnel_coin_type: raw.sui_tunnel_coin_type,
            funder_priv_key: raw.sui_funder_priv_key.unwrap(),
            funder_stake_coin_id: raw.sui_funder_stake_coin_id.unwrap(),
            open_batching: SuiOpenBatchingConfig {
                enabled: !raw.sui_disable_open_batching,
                max_batch_size: raw.sui_open_batch_size,
                flush_interval_ms: raw.sui_open_batch_flush_ms,
                max_wait_ms: raw.sui_open_batch_max_wait_ms,
            },
        })
    } else {
        None
    };

    Ok(BenchOpts {
        workers,
        duration_secs: raw.duration,
        matches: raw.matches,
        bench_mode,
        protocol_id,
        scenario,
        frame_codec,
        anchor_mode,
        transcript_recorder,
        sui_anchor,
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
            "--anchor",
            "memory",
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
    }

    #[test]
    fn all_ported_protocol_ids_are_executable() {
        for id in PORTED_PROTOCOL_IDS {
            let o = parse_v(&["--protocol-id", id]).unwrap();
            assert_eq!(o.protocol_id, *id);
        }
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
    fn anchor_memory_selects_memory_anchor() {
        assert_eq!(
            parse_v(&["--anchor", "memory"]).unwrap().anchor_mode,
            AnchorMode::Memory
        );
    }

    #[test]
    fn anchor_sui_requires_transcript_recorder_and_config() {
        let err = parse_v(&["--anchor", "sui"]).unwrap_err();
        assert!(err.contains("transcript-recorder"), "{err}");

        let err = parse_v(&["--anchor", "sui", "--transcript-recorder", "memory"]).unwrap_err();
        assert!(err.contains("sui-graphql-url"), "{err}");
        assert!(err.contains("sui-funder-priv-key"), "{err}");
        assert!(err.contains("sui-funder-stake-coin-id"), "{err}");
    }

    #[test]
    fn anchor_sui_parses_graphql_and_funder_options() {
        let o = parse_v(&[
            "--anchor",
            "sui",
            "--transcript-recorder",
            "memory",
            "--sui-graphql-url",
            "https://sui.example/graphql",
            "--sui-backend-url",
            "https://backend.example",
            "--sui-package-id",
            "0xabc",
            "--sui-funder-priv-key",
            "suiprivkey1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
            "--sui-funder-stake-coin-id",
            "0xcoin",
        ])
        .unwrap();

        assert_eq!(o.anchor_mode, AnchorMode::Sui);
        let sui = o.sui_anchor.expect("sui config");
        assert_eq!(sui.graphql_url, "https://sui.example/graphql");
        assert_eq!(sui.backend_url, "https://backend.example");
        assert_eq!(sui.package_id, "0xabc");
        assert_eq!(sui.tunnel_coin_type, "0x2::sui::SUI");
        assert_eq!(
            sui.funder_priv_key,
            "suiprivkey1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq"
        );
        assert_eq!(sui.funder_stake_coin_id, "0xcoin");
    }

    #[test]
    fn anchor_sui_open_batching_defaults_to_enabled_conservative_limits() {
        let opts = parse(vec![
            "--anchor".into(),
            "sui".into(),
            "--transcript-recorder".into(),
            "memory".into(),
            "--sui-graphql-url".into(),
            "http://graphql".into(),
            "--sui-backend-url".into(),
            "http://backend".into(),
            "--sui-package-id".into(),
            "0x2".into(),
            "--sui-funder-priv-key".into(),
            "suiprivkey1example".into(),
            "--sui-funder-stake-coin-id".into(),
            "0x7".into(),
        ]);
        let opts = opts.expect("parse sui opts");
        let sui = opts.sui_anchor.expect("sui opts");
        assert!(sui.open_batching.enabled);
        assert_eq!(sui.open_batching.max_batch_size, 50);
        assert_eq!(sui.open_batching.flush_interval_ms, 250);
        assert_eq!(sui.open_batching.max_wait_ms, 1000);
    }

    #[test]
    fn anchor_sui_open_batching_flags_override_defaults() {
        let opts = parse(vec![
            "--anchor".into(),
            "sui".into(),
            "--transcript-recorder".into(),
            "memory".into(),
            "--sui-graphql-url".into(),
            "http://graphql".into(),
            "--sui-backend-url".into(),
            "http://backend".into(),
            "--sui-package-id".into(),
            "0x2".into(),
            "--sui-funder-priv-key".into(),
            "suiprivkey1example".into(),
            "--sui-funder-stake-coin-id".into(),
            "0x7".into(),
            "--sui-open-batch-size".into(),
            "25".into(),
            "--sui-open-batch-flush-ms".into(),
            "100".into(),
            "--sui-open-batch-max-wait-ms".into(),
            "500".into(),
        ]);
        let opts = opts.expect("parse sui opts");
        let sui = opts.sui_anchor.expect("sui opts");
        assert_eq!(sui.open_batching.max_batch_size, 25);
        assert_eq!(sui.open_batching.flush_interval_ms, 100);
        assert_eq!(sui.open_batching.max_wait_ms, 500);
    }

    #[test]
    fn anchor_sui_open_batching_can_be_disabled() {
        let opts = parse_v(&[
            "--anchor",
            "sui",
            "--transcript-recorder",
            "memory",
            "--sui-graphql-url",
            "http://graphql",
            "--sui-backend-url",
            "http://backend",
            "--sui-package-id",
            "0x2",
            "--sui-funder-priv-key",
            "suiprivkey1example",
            "--sui-funder-stake-coin-id",
            "0x7",
            "--sui-disable-open-batching",
        ])
        .expect("parse sui opts");
        let sui = opts.sui_anchor.expect("sui opts");
        assert!(!sui.open_batching.enabled);
    }

    #[test]
    fn anchor_sui_open_batching_rejects_invalid_limits() {
        let base = [
            "--anchor",
            "sui",
            "--transcript-recorder",
            "memory",
            "--sui-graphql-url",
            "http://graphql",
            "--sui-backend-url",
            "http://backend",
            "--sui-package-id",
            "0x2",
            "--sui-funder-priv-key",
            "suiprivkey1example",
            "--sui-funder-stake-coin-id",
            "0x7",
        ];

        let mut zero_batch_size = base.to_vec();
        zero_batch_size.extend(["--sui-open-batch-size", "0"]);
        let err = parse_v(&zero_batch_size).unwrap_err();
        assert!(err.contains("sui-open-batch-size"), "{err}");

        let mut oversized_batch = base.to_vec();
        oversized_batch.extend(["--sui-open-batch-size", "51"]);
        let err = parse_v(&oversized_batch).unwrap_err();
        assert!(err.contains("sui-open-batch-size"), "{err}");

        let mut zero_flush_ms = base.to_vec();
        zero_flush_ms.extend(["--sui-open-batch-flush-ms", "0"]);
        let err = parse_v(&zero_flush_ms).unwrap_err();
        assert!(err.contains("sui-open-batch-flush-ms"), "{err}");

        let mut max_wait_before_flush = base.to_vec();
        max_wait_before_flush.extend([
            "--sui-open-batch-flush-ms",
            "250",
            "--sui-open-batch-max-wait-ms",
            "249",
        ]);
        let err = parse_v(&max_wait_before_flush).unwrap_err();
        assert!(err.contains("sui-open-batch-max-wait-ms"), "{err}");
    }

    #[test]
    fn offchain_shortcut_is_not_supported() {
        let err = parse_v(&["--offchain"]).unwrap_err();
        assert!(
            err.contains("offchain"),
            "message should name the removed flag: {err}"
        );
    }

    #[test]
    fn transcript_recorder_defaults_to_none_and_parses_memory() {
        assert_eq!(
            parse_v(&[]).unwrap().transcript_recorder,
            TranscriptRecorderMode::None
        );
        assert_eq!(
            parse_v(&["--transcript-recorder", "memory"])
                .unwrap()
                .transcript_recorder,
            TranscriptRecorderMode::Memory
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

        assert!(help.contains("Run the local memory-anchored tunnel fleet benchmark"));
        assert!(help.contains("Examples:"));
        assert!(help.contains(
            "fleet-bench --anchor memory --bench-mode per-match-signers --matches 50 --scenario golden --frame-codec postcard"
        ));
        assert!(help.contains(
            "fleet-bench --protocol-id blackjack.v2 --matches 100 --scenario varied --transcript-recorder memory"
        ));
        assert!(help.contains("json: TS-parity wire for bot-vs-user"));
        assert!(help.contains("postcard: compact default candidate for bot-vs-bot"));
        assert!(help.contains("per-match-signers|pre-initialized-signers|compare-signers"));
        assert!(help.contains("fleet-bench executes every ported Rust protocol ID"));
        assert!(!help.contains("fleet-bench currently executes"));
        assert!(help.contains("blackjack.bet.v1"));
        assert!(help.contains("json|bcs|postcard"));
        assert!(
            help.contains("memory: in-memory tunnel anchor for local throughput runs; no chain IO")
        );
        assert!(help.contains("memory: retain committed transitions in memory during each match"));
        assert!(help.contains("none|memory"));
    }
}
