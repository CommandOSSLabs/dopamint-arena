//! Command-line surface for the swarm bench binary. Parses the local fleet flags,
//! resolves `--workers auto`, and rejects unsupported transport/anchor modes with
//! explanatory errors rather than silently ignoring them.

use crate::heartbeat::HeartbeatSetup;
use clap::{CommandFactory, Parser};
use sui_tunnel_anchor::{
    SuiFundingProfile, SuiOpenBatchingConfig, SuiOpenMode, SuiSettleMode, SuiStakeSource,
};
use tunnel_blackjack::MIN_BET as BLACKJACK_BET_MIN_BET;
use tunnel_core::protocol_id::{BLACKJACK_BET_V1, PORTED_PROTOCOL_IDS};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SignerInitMode {
    PerTunnel,
    PreInitialized,
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
    SuiSponsored,
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

/// Maximum number of tunnel lifecycles to keep in flight.
/// - `Auto`: duration-led steady state — keep a worker-sized pool of tunnels in
///   flight, relaunching as they finish, for the full `--duration`.
/// - `Fixed(n)`: keep at most `n` tunnel lifecycles in flight until the global
///   duration ends launches or the move cap stops production, then drain open tunnels.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ConcurrencyMode {
    Auto,
    Fixed(u64),
}

impl ConcurrencyMode {
    /// Human label for the report header (`auto` or the fixed count).
    pub fn label(self) -> String {
        match self {
            ConcurrencyMode::Auto => "auto".to_string(),
            ConcurrencyMode::Fixed(n) => n.to_string(),
        }
    }

    /// In-flight tunnel pool for `Auto`, derived from the worker count: ~1.5×
    /// workers (min 2) so cores stay busy across the per-move `recv` await points
    /// without oversubscribing.
    pub fn auto_in_flight(workers: usize) -> usize {
        (workers * 3).div_ceil(2).max(2)
    }
}

/// Tunnel lifecycle shape. `Churn` is the default interleaved pool; `Warmup`
/// pre-opens the whole initial fleet behind a barrier before play begins.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BenchMode {
    Churn,
    Warmup,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ColorMode {
    Auto,
    Always,
    Never,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MoveTarget {
    Count(u64),
    Max,
}

impl ScenarioMode {
    pub fn card_seed(self, tunnel_index: u64) -> Option<u64> {
        match self {
            ScenarioMode::Varied => Some(tunnel_index),
            ScenarioMode::Golden => None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct BenchOpts {
    pub workers: usize,
    pub duration_secs: u64,
    /// Optional graceful move target across the benchmark run.
    pub moves: Option<MoveTarget>,
    /// Per-seat initial tunnel balance. Total Sui open deposit is twice this.
    pub initial_balance: u64,
    /// Tunnel lifecycle pool size: `auto` or a fixed in-flight count.
    pub tunnel_concurrency: ConcurrencyMode,
    /// Tunnel lifecycle shape (`churn` or `warmup`).
    pub bench_mode: BenchMode,
    /// Warm-up open barrier timeout in seconds.
    pub warmup_timeout_secs: u64,
    /// Emit a machine-readable JSON report to stdout.
    pub json: bool,
    /// Show the per-move latency breakdown — per-frame transport send/recv (and
    /// recorder-record, when a real recorder runs) latency rows. Off by default.
    pub per_move_latency: bool,
    /// Emit coarse-boundary tracing to the console (off by default).
    pub trace: bool,
    pub signer_init_mode: SignerInitMode,
    /// Protocols to run, in the order the user listed them (or
    /// `PORTED_PROTOCOL_IDS` order for `all`). Always non-empty; runs execute
    /// sequentially so they don't contend for CPU.
    pub protocol_ids: Vec<&'static str>,
    /// Protocol scenario for generated tunnels (`Varied` by default).
    pub scenario: ScenarioMode,
    /// Wire codec used to serialize tunnel frames (`Json` by default).
    pub frame_codec: FrameCodecKind,
    /// Tunnel anchor implementation (`Memory` by default).
    pub anchor_mode: AnchorMode,
    /// ANSI color mode for the console report.
    pub color_mode: ColorMode,
    /// Transcript recorder implementation (`None` by default).
    pub transcript_recorder: TranscriptRecorderMode,
    /// Optional heartbeat setup for backend live stats; resolved before timing.
    pub heartbeat: Option<HeartbeatSetup>,
    /// Sponsored Sui anchor configuration, present only when `anchor_mode == SuiSponsored`.
    pub sui_anchor: Option<SuiSponsoredAnchorOpts>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SuiSponsoredAnchorOpts {
    pub rpc_url: String,
    pub backend_url: String,
    pub package_id: String,
    pub tunnel_coin_type: String,
    pub open_mode: SuiOpenMode,
    pub settle_mode: SuiSettleMode,
    pub funding_profile: SuiFundingProfile,
    pub open_batching: SuiOpenBatchingConfig,
    pub settle_batching: SuiOpenBatchingConfig,
}

/// Raw clap layout. Validated and lowered into `BenchOpts` by `parse`.
#[derive(Parser, Debug)]
#[command(
    no_binary_name = true,
    disable_help_flag = false,
    about = "Run the local memory-anchored tunnel fleet benchmark.",
    long_about = "Run the local memory-anchored tunnel fleet benchmark.\n\n\
The bench drives two in-process PartyRuntime instances per tunnel and reports \
throughput, frame bytes, tunnel counts, and resource usage. It uses the memory \
anchor by default, runs CPU-local with local frame transport, and submits no \
chain transactions.",
    after_help = "Examples:\n  \
fleet-bench --anchor memory --signer-init-mode per-tunnel --tunnel-concurrency 50 --scenario golden --frame-codec postcard\n  \
fleet-bench --signer-init-mode pre-initialized --tunnel-concurrency 1000 --frame-codec bcs\n  \
fleet-bench --protocol-ids blackjack.v2 --tunnel-concurrency 100 --scenario varied --transcript-recorder memory\n  \
fleet-bench --protocol-ids blackjack.v2 --initial-balance 1 --anchor sui-sponsored --tunnel-concurrency 255\n  \
fleet-bench --protocol-ids caro.v1,blackjack.v2 --tunnel-concurrency 100\n  \
fleet-bench --protocol-ids all --tunnel-concurrency 50\n\n\
Signer init mode values:\n  \
per-tunnel: create signer material inside each measured tunnel\n  \
pre-initialized: create all signer material before the timed run\n\n\
Protocol IDs:\n  \
--protocol-ids takes one ID, a comma-separated list, or `all`; listed\n  \
protocols run sequentially with a comparison summary at the end. Ported IDs:\n  \
api_credits.v1, battleship.v1, battleship.series.v1, blackjack.bet.v1,\n  \
blackjack.duel.v1, blackjack.v2, bomb_it.v1, bomb_it.series.v1, caro.v1,\n  \
caro.series.v1, chat.v1, cross.v1, cross.series.v1, payments.v1,\n  \
quantum_poker.v2, tic_tac_toe.v1, tic_tac_toe.series.v1,\n  \
world_canvas.cell.v1, world_canvas.stroke.v1\n\n\
Frame codec values:\n  \
json: TS-parity wire for bot-vs-user and regression baselines\n  \
bcs: fixed-width Sui-native binary wire for bot-vs-bot comparisons\n  \
postcard: compact default candidate for bot-vs-bot\n\n\
Initial balance:\n  \
--initial-balance is the per-seat tunnel balance; total open deposit is twice this value.\n  \
Some protocols have larger minimums, e.g. blackjack.bet.v1 requires 25.\n\n\
Color values:\n  \
auto: colorize when stdout is a terminal\n  \
always: force ANSI color\n  \
never: disable ANSI color\n\n\
Anchor values:\n  \
memory: in-memory tunnel anchor for local throughput runs; no chain IO\n\n  \
sui-sponsored: Sui Tunnel anchor for Sui-backed open and settlement flows\n  \
sui: backwards-compatible alias for sui-sponsored\n\n\
Sui sponsored anchor flags:\n  \
--sui-rpc-url: Sui gRPC endpoint used to execute/read sponsored open transactions\n  \
--sui-backend-url: Dopamint tunnel-manager URL used for sponsor and settlement HTTP calls\n  \
--sui-package-id: published Sui Tunnel package id containing tunnel::create_and_fund<T>\n  \
--sui-tunnel-coin-type: Move coin type for Tunnel<T>; defaults to 0x2::sui::SUI\n  \
--sui-open-mode sponsored-create-and-fund: build tunnel::create_and_fund<T> PTBs for opens\n  \
--sui-open-mode direct-create-and-fund: build the same open PTBs and pay gas from the funder wallet\n  \
--sui-settle-mode backend-settle: submit the TS-compatible settlement body to /v1/tunnels/{id}/settle\n  \
--sui-settle-mode sponsored-settle: build the settlement PTB locally and execute it through the sponsor API\n  \
--sui-settle-mode direct-settle: build the settlement PTB locally and pay gas from the funder wallet\n  \
--sui-funding-profile single-funder: one bech32 Sui private key funds both seats\n  \
--sui-funder-priv-key: bech32 Sui private key required by single-funder\n  \
--sui-stake-source coin-object: split both stakes from --sui-funder-stake-coin-id\n  \
--sui-stake-source address-balance: withdraw the total stake from the sender balance\n  \
--sui-open-batch-size: max sponsored open requests per PTB batch; default 255, maximum 255\n  \
--sui-open-batch-flush-ms: open batch idle debounce in milliseconds; default 250\n  \
--sui-open-batch-max-in-flight: max open PTB flushes executing at once; default 4\n  \
--sui-open-batch-gap-ms: minimum gap between starting open PTB flushes; default 0\n  \
--sui-disable-open-batching: execute each sponsored open request without the batch queue\n\n\
--sui-settle-batch-size: max PTB settle requests per batch; default 681, maximum 681\n  \
--sui-settle-batch-flush-ms: settle batch idle debounce in milliseconds; default 250\n  \
--sui-settle-batch-max-in-flight: max settle PTB flushes executing at once; default 4\n  \
--sui-settle-batch-gap-ms: minimum gap between starting settle PTB flushes; default 0\n  \
--sui-disable-settle-batching: execute each PTB settlement without the batch queue\n\n\
Transcript recorder values:\n  \
none: do not retain committed transition transcripts\n  \
memory: retain committed transitions in memory during each tunnel; useful for measuring recorder overhead\n\n\
Heartbeat flags:\n  \
--heartbeat-url registers a stats session before timing starts, then attaches the existing /heartbeat API\n  \
as fire-and-forget telemetry. Heartbeat POSTs are never awaited by the move loop or elapsed timer."
)]
struct Raw {
    /// Number of Tokio runtime worker threads, or `auto` to use available CPU parallelism.
    #[arg(long, default_value = "auto", value_name = "auto|N")]
    workers: String,
    /// Duration before new tunnel launches stop and in-flight tunnels drain.
    #[arg(long, default_value_t = 15, value_name = "SECONDS")]
    duration: u64,
    /// Optional graceful move target across the benchmark run, or `max`.
    #[arg(long = "moves", value_name = "N|max")]
    moves: Option<String>,
    /// Per-seat initial tunnel balance. Total open deposit is twice this.
    #[arg(long = "initial-balance", default_value_t = 200, value_name = "N")]
    initial_balance: u64,
    /// Tunnel lifecycle pool size: `auto` or a fixed in-flight count.
    #[arg(
        long = "tunnel-concurrency",
        default_value = "auto",
        value_name = "auto|N"
    )]
    tunnel_concurrency: String,
    /// Tunnel lifecycle shape: churn or warmup.
    #[arg(
        long = "bench-mode",
        default_value = "churn",
        value_name = "churn|warmup"
    )]
    bench_mode: String,
    /// Warm-up open barrier timeout in seconds (warmup mode only).
    #[arg(long = "warmup-timeout", default_value_t = 120, value_name = "SECONDS")]
    warmup_timeout: u64,
    /// Emit a machine-readable JSON report to stdout instead of the text report.
    #[arg(long = "json", default_value_t = false)]
    json: bool,
    /// Show the per-move latency breakdown (per-frame transport send/recv rows).
    #[arg(long = "per-move-latency", default_value_t = false)]
    per_move_latency: bool,
    /// Emit coarse-boundary tracing to the console (default off).
    #[arg(long = "trace", default_value_t = false)]
    trace: bool,
    /// Signer initialization timing: per-tunnel or pre-initialized.
    #[arg(
        long = "signer-init-mode",
        default_value = "per-tunnel",
        value_name = "per-tunnel|pre-initialized"
    )]
    signer_init_mode: String,
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
    #[arg(long, default_value = "memory", value_name = "memory|sui-sponsored")]
    anchor: String,
    /// ANSI color output.
    #[arg(long, default_value = "auto", value_name = "auto|always|never")]
    color: String,
    /// Transcript recorder implementation: none or memory.
    #[arg(
        long = "transcript-recorder",
        default_value = "none",
        value_name = "none|memory"
    )]
    transcript_recorder: String,
    /// Tunnel-manager base URL for fire-and-forget heartbeat telemetry.
    #[arg(long = "heartbeat-url", value_name = "URL")]
    heartbeat_url: Option<String>,
    /// Heartbeat aggregation cadence in milliseconds.
    #[arg(long = "heartbeat-flush-ms", default_value_t = 1000, value_name = "MS")]
    heartbeat_flush_ms: u64,
    #[arg(long, hide = true)]
    onchain: bool,
    /// Frame transport. Only `local` is implemented in this synchronous bench.
    #[arg(
        long = "frame-transport",
        default_value = "local",
        value_name = "local"
    )]
    frame_transport: String,
    /// Protocol IDs to execute, comma-separated, or `all` for every ported ID.
    #[arg(
        long = "protocol-ids",
        default_value = BLACKJACK_BET_V1,
        value_name = "ID[,ID...]|all"
    )]
    protocol_ids: String,
    /// Sui gRPC endpoint used by --anchor sui-sponsored.
    #[arg(long = "sui-rpc-url", value_name = "URL")]
    sui_rpc_url: Option<String>,
    /// Dopamint tunnel-manager backend base URL used by --anchor sui-sponsored.
    #[arg(long = "sui-backend-url", value_name = "URL")]
    sui_backend_url: Option<String>,
    /// Published Sui Tunnel package id used by --anchor sui-sponsored.
    #[arg(long = "sui-package-id", value_name = "OBJECT_ID")]
    sui_package_id: Option<String>,
    /// Move coin type for the Sui Tunnel<T> object.
    #[arg(
        long = "sui-tunnel-coin-type",
        default_value = "0x2::sui::SUI",
        value_name = "TYPE"
    )]
    sui_tunnel_coin_type: String,
    /// Sui bech32 private key for the single-funder profile.
    #[arg(long = "sui-funder-priv-key", value_name = "BECH32")]
    sui_funder_priv_key: Option<String>,
    /// Sui open flow used by --anchor sui-sponsored.
    #[arg(
        long = "sui-open-mode",
        default_value = "sponsored-create-and-fund",
        value_name = "sponsored-create-and-fund|direct-create-and-fund"
    )]
    sui_open_mode: String,
    /// Sui settle flow used by --anchor sui-sponsored.
    #[arg(
        long = "sui-settle-mode",
        default_value = "backend-settle",
        value_name = "backend-settle|sponsored-settle|direct-settle"
    )]
    sui_settle_mode: String,
    /// Funding profile used by --anchor sui-sponsored.
    #[arg(
        long = "sui-funding-profile",
        default_value = "single-funder",
        value_name = "single-funder"
    )]
    sui_funding_profile: String,
    /// Stake funding source used by the single-funder profile.
    #[arg(
        long = "sui-stake-source",
        default_value = "address-balance",
        value_name = "coin-object|address-balance"
    )]
    sui_stake_source: String,
    /// Funder-owned stake coin object used when --sui-stake-source=coin-object.
    #[arg(long = "sui-funder-stake-coin-id", value_name = "OBJECT_ID")]
    sui_funder_stake_coin_id: Option<String>,
    /// Maximum Sui sponsored open requests per PTB batch.
    #[arg(long = "sui-open-batch-size", default_value_t = 255, value_name = "N")]
    sui_open_batch_size: usize,
    /// Sui open PTB batch idle debounce in milliseconds.
    #[arg(
        long = "sui-open-batch-flush-ms",
        default_value_t = 250,
        value_name = "MS"
    )]
    sui_open_batch_flush_ms: u64,
    /// Maximum Sui open PTB flushes executing concurrently.
    #[arg(
        long = "sui-open-batch-max-in-flight",
        default_value_t = 4,
        value_name = "N"
    )]
    sui_open_batch_max_in_flight: usize,
    /// Minimum delay between starting Sui open PTB flushes.
    #[arg(long = "sui-open-batch-gap-ms", default_value_t = 0, value_name = "MS")]
    sui_open_batch_gap_ms: u64,
    /// Disable Sui sponsored open PTB batching.
    #[arg(long = "sui-disable-open-batching")]
    sui_disable_open_batching: bool,
    /// Maximum Sui PTB settle requests per batch.
    #[arg(
        long = "sui-settle-batch-size",
        default_value_t = 681,
        value_name = "N"
    )]
    sui_settle_batch_size: usize,
    /// Sui settle PTB batch idle debounce in milliseconds.
    #[arg(
        long = "sui-settle-batch-flush-ms",
        default_value_t = 250,
        value_name = "MS"
    )]
    sui_settle_batch_flush_ms: u64,
    /// Maximum Sui settle PTB flushes executing concurrently.
    #[arg(
        long = "sui-settle-batch-max-in-flight",
        default_value_t = 4,
        value_name = "N"
    )]
    sui_settle_batch_max_in_flight: usize,
    /// Minimum delay between starting Sui settle PTB flushes.
    #[arg(
        long = "sui-settle-batch-gap-ms",
        default_value_t = 0,
        value_name = "MS"
    )]
    sui_settle_batch_gap_ms: u64,
    /// Disable Sui PTB settlement batching.
    #[arg(long = "sui-disable-settle-batching")]
    sui_disable_settle_batching: bool,
}

/// Resolves the raw `--protocol-ids` value into the ordered, de-duplicated set
/// of ported protocol IDs to run. `all` (only valid alone) expands to every
/// ported ID in declaration order.
fn resolve_protocol_ids(raw: &str) -> Result<Vec<&'static str>, String> {
    let tokens: Vec<&str> = raw
        .split(',')
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .collect();
    if tokens.is_empty() {
        return Err("--protocol-ids requires at least one protocol ID".to_string());
    }
    if tokens.contains(&"all") {
        if tokens.len() != 1 {
            return Err("--protocol-ids 'all' cannot be combined with other IDs".to_string());
        }
        return Ok(PORTED_PROTOCOL_IDS.to_vec());
    }

    let mut resolved: Vec<&'static str> = Vec::with_capacity(tokens.len());
    for token in tokens {
        let id = PORTED_PROTOCOL_IDS
            .iter()
            .copied()
            .find(|id| *id == token)
            .ok_or_else(|| {
                format!(
                    "--protocol-ids: {} is not a ported Rust protocol ID; known IDs: {}",
                    token,
                    PORTED_PROTOCOL_IDS.join(", ")
                )
            })?;
        if resolved.contains(&id) {
            return Err(format!("--protocol-ids contains duplicate ID: {id}"));
        }
        resolved.push(id);
    }
    Ok(resolved)
}

fn parse_move_target(raw: &str) -> Result<MoveTarget, String> {
    if raw == "max" {
        return Ok(MoveTarget::Max);
    }
    let moves = raw
        .parse::<u64>()
        .map_err(|_| format!("--moves must be a positive integer or 'max', got {raw}"))?;
    if moves == 0 {
        return Err("--moves must be greater than 0".to_string());
    }
    Ok(MoveTarget::Count(moves))
}

fn minimum_initial_balance(protocol_id: &str) -> u64 {
    match protocol_id {
        BLACKJACK_BET_V1 => BLACKJACK_BET_MIN_BET,
        _ => 1,
    }
}

fn validate_initial_balance(
    protocol_ids: &[&'static str],
    initial_balance: u64,
) -> Result<(), String> {
    if initial_balance == 0 {
        return Err("--initial-balance must be greater than 0".to_string());
    }
    if let Some((protocol_id, minimum)) = protocol_ids
        .iter()
        .copied()
        .map(|protocol_id| (protocol_id, minimum_initial_balance(protocol_id)))
        .find(|(_, minimum)| initial_balance < *minimum)
    {
        return Err(format!(
            "--initial-balance {initial_balance} is too small for {protocol_id}; minimum is {minimum}"
        ));
    }
    Ok(())
}

pub fn help_text() -> String {
    let mut help = Vec::new();
    // The after-help embeds hand-formatted example lines wider than 100 cols.
    // clap only reflows them when its `wrap_help` feature is on, which the full
    // workspace enables transitively (sui-indexer) while a scoped fleet-bench
    // build does not — so unpinned width makes the help nondeterministic. Pin to
    // 0 (source formatting, no reflow) to render the authored layout verbatim.
    Raw::command()
        .term_width(0)
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
    let protocol_ids = resolve_protocol_ids(&raw.protocol_ids)?;

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
    let moves = raw.moves.as_deref().map(parse_move_target).transpose()?;
    validate_initial_balance(&protocol_ids, raw.initial_balance)?;

    let signer_init_mode = match raw.signer_init_mode.as_str() {
        "per-tunnel" => SignerInitMode::PerTunnel,
        "pre-initialized" => SignerInitMode::PreInitialized,
        other => {
            return Err(format!(
                "--signer-init-mode must be per-tunnel|pre-initialized, got {other}"
            ))
        }
    };
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
        "sui" | "sui-sponsored" => AnchorMode::SuiSponsored,
        other => {
            return Err(format!(
                "--anchor must be memory|sui-sponsored, got {other}"
            ))
        }
    };

    let color_mode = match raw.color.as_str() {
        "auto" => ColorMode::Auto,
        "always" => ColorMode::Always,
        "never" => ColorMode::Never,
        other => return Err(format!("--color must be auto|always|never, got {other}")),
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

    let heartbeat = parse_heartbeat_setup(raw.heartbeat_url, raw.heartbeat_flush_ms)?;

    let sui_anchor = if anchor_mode == AnchorMode::SuiSponsored {
        let mut missing = Vec::new();
        if raw.sui_rpc_url.is_none() {
            missing.push("--sui-rpc-url");
        }
        if raw.sui_backend_url.is_none() {
            missing.push("--sui-backend-url");
        }
        if raw.sui_package_id.is_none() {
            missing.push("--sui-package-id");
        }
        let open_mode = match raw.sui_open_mode.as_str() {
            "sponsored-create-and-fund" => SuiOpenMode::SponsoredCreateAndFund,
            "direct-create-and-fund" => SuiOpenMode::DirectCreateAndFund,
            other => {
                return Err(format!(
                    "--sui-open-mode must be sponsored-create-and-fund or direct-create-and-fund, got {other}"
                ))
            }
        };
        let settle_mode = match raw.sui_settle_mode.as_str() {
            "backend-settle" => SuiSettleMode::BackendSettle,
            "sponsored-settle" => SuiSettleMode::SponsoredSettle,
            "direct-settle" => SuiSettleMode::DirectSettle,
            other => {
                return Err(format!(
                    "--sui-settle-mode must be backend-settle, sponsored-settle, or direct-settle, got {other}"
                ))
            }
        };
        let funding_profile = match raw.sui_funding_profile.as_str() {
            "single-funder" => {
                if raw.sui_funder_priv_key.is_none() {
                    missing.push("--sui-funder-priv-key");
                }
                let stake_source = match raw.sui_stake_source.as_str() {
                    "coin-object" => match raw.sui_funder_stake_coin_id.clone() {
                        Some(coin_id) => Some(SuiStakeSource::CoinObject { coin_id }),
                        None => {
                            missing.push("--sui-funder-stake-coin-id");
                            None
                        }
                    },
                    "address-balance" => Some(SuiStakeSource::AddressBalance),
                    other => {
                        return Err(format!(
                            "--sui-stake-source must be coin-object|address-balance, got {other}"
                        ))
                    }
                };
                if missing.is_empty() {
                    Some(SuiFundingProfile::SingleFunder {
                        priv_key: raw
                            .sui_funder_priv_key
                            .expect("single-funder private key was validated"),
                        stake_source: stake_source
                            .expect("single-funder stake source was validated"),
                    })
                } else {
                    None
                }
            }
            other => {
                return Err(format!(
                    "--sui-funding-profile must be single-funder, got {other}"
                ))
            }
        };
        if !missing.is_empty() {
            return Err(format!(
                "--anchor {} requires {}",
                raw.anchor,
                missing.join(", ")
            ));
        }
        let funding_profile = funding_profile.expect("sponsored Sui funding profile was validated");
        if raw.sui_open_batch_size == 0 {
            return Err("--sui-open-batch-size must be greater than 0".to_string());
        }
        if raw.sui_open_batch_size > 255 {
            return Err("--sui-open-batch-size must be <= 255".to_string());
        }
        if raw.sui_open_batch_flush_ms == 0 {
            return Err("--sui-open-batch-flush-ms must be greater than 0".to_string());
        }
        if raw.sui_open_batch_max_in_flight == 0 {
            return Err("--sui-open-batch-max-in-flight must be greater than 0".to_string());
        }
        if raw.sui_settle_batch_size == 0 {
            return Err("--sui-settle-batch-size must be greater than 0".to_string());
        }
        if raw.sui_settle_batch_size > 681 {
            return Err("--sui-settle-batch-size must be <= 681".to_string());
        }
        if raw.sui_settle_batch_flush_ms == 0 {
            return Err("--sui-settle-batch-flush-ms must be greater than 0".to_string());
        }
        if raw.sui_settle_batch_max_in_flight == 0 {
            return Err("--sui-settle-batch-max-in-flight must be greater than 0".to_string());
        }
        Some(SuiSponsoredAnchorOpts {
            rpc_url: raw.sui_rpc_url.unwrap(),
            backend_url: raw.sui_backend_url.unwrap(),
            package_id: raw.sui_package_id.unwrap(),
            tunnel_coin_type: raw.sui_tunnel_coin_type,
            open_mode,
            settle_mode,
            funding_profile,
            open_batching: SuiOpenBatchingConfig {
                enabled: !raw.sui_disable_open_batching,
                max_batch_size: raw.sui_open_batch_size,
                flush_interval_ms: raw.sui_open_batch_flush_ms,
                max_concurrent_flushes: raw.sui_open_batch_max_in_flight,
                flush_spacing_ms: raw.sui_open_batch_gap_ms,
            },
            settle_batching: SuiOpenBatchingConfig {
                enabled: !raw.sui_disable_settle_batching,
                max_batch_size: raw.sui_settle_batch_size,
                flush_interval_ms: raw.sui_settle_batch_flush_ms,
                max_concurrent_flushes: raw.sui_settle_batch_max_in_flight,
                flush_spacing_ms: raw.sui_settle_batch_gap_ms,
            },
        })
    } else {
        None
    };

    let tunnel_concurrency = match raw.tunnel_concurrency.as_str() {
        "auto" => ConcurrencyMode::Auto,
        other => {
            let n = other.parse::<u64>().map_err(|_| {
                format!("--tunnel-concurrency must be 'auto' or a positive integer, got {other}")
            })?;
            if n == 0 {
                return Err("--tunnel-concurrency must be at least 1".to_string());
            }
            ConcurrencyMode::Fixed(n)
        }
    };
    let bench_mode = match raw.bench_mode.as_str() {
        "churn" => BenchMode::Churn,
        "warmup" => BenchMode::Warmup,
        other => return Err(format!("--bench-mode must be churn|warmup, got {other}")),
    };
    if raw.warmup_timeout == 0 {
        return Err("--warmup-timeout must be greater than 0".to_string());
    }

    Ok(BenchOpts {
        workers,
        duration_secs: raw.duration,
        moves,
        initial_balance: raw.initial_balance,
        tunnel_concurrency,
        bench_mode,
        warmup_timeout_secs: raw.warmup_timeout,
        json: raw.json,
        per_move_latency: raw.per_move_latency,
        trace: raw.trace,
        signer_init_mode,
        protocol_ids,
        scenario,
        frame_codec,
        anchor_mode,
        color_mode,
        transcript_recorder,
        heartbeat,
        sui_anchor,
    })
}

fn parse_heartbeat_setup(
    base_url: Option<String>,
    flush_interval_ms: u64,
) -> Result<Option<HeartbeatSetup>, String> {
    if flush_interval_ms == 0 {
        return Err("--heartbeat-flush-ms must be greater than 0".to_string());
    }
    let Some(base_url) = base_url else {
        return Ok(None);
    };

    Ok(Some(HeartbeatSetup {
        base_url: base_url.trim_end_matches('/').to_owned(),
        flush_interval_ms,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_v(args: &[&str]) -> Result<BenchOpts, String> {
        parse(args.iter().map(|s| s.to_string()))
    }

    fn sui_anchor_args() -> Vec<&'static str> {
        vec![
            "--anchor",
            "sui-sponsored",
            "--transcript-recorder",
            "memory",
            "--sui-rpc-url",
            "http://rpc",
            "--sui-backend-url",
            "http://backend",
            "--sui-package-id",
            "0x2",
            "--sui-funder-priv-key",
            "suiprivkey1example",
            "--sui-funder-stake-coin-id",
            "0x7",
        ]
    }

    #[test]
    fn parses_global_move_limit() {
        let opts = parse_v(&["--moves", "1000000"]).unwrap();

        assert_eq!(opts.moves, Some(MoveTarget::Count(1_000_000)));
    }

    #[test]
    fn parses_heartbeat_config() {
        let opts = parse_v(&[
            "--heartbeat-url",
            "http://manager/",
            "--heartbeat-flush-ms",
            "250",
        ])
        .unwrap();
        let heartbeat = opts.heartbeat.expect("heartbeat setup");

        assert_eq!(heartbeat.base_url, "http://manager");
        assert_eq!(heartbeat.flush_interval_ms, 250);
    }

    #[test]
    fn heartbeat_session_flags_are_internal_setup_now() {
        let err = parse_v(&[
            "--heartbeat-url",
            "http://manager",
            "--heartbeat-session-id",
            "sess-1",
        ])
        .unwrap_err();

        assert!(err.contains("unexpected argument"), "{err}");
        assert!(err.contains("--heartbeat-session-id"), "{err}");
    }

    #[test]
    fn parses_max_move_target() {
        let opts = parse_v(&["--moves", "max"]).unwrap();

        assert_eq!(opts.moves, Some(MoveTarget::Max));
    }

    #[test]
    fn parses_bench_mode_and_warmup_timeout() {
        let o = parse_v(&["--bench-mode", "warmup", "--warmup-timeout", "30"]).unwrap();

        assert_eq!(o.bench_mode, BenchMode::Warmup);
        assert_eq!(o.warmup_timeout_secs, 30);
        assert!(parse_v(&["--bench-mode", "bogus"]).is_err());
        assert!(parse_v(&["--warmup-timeout", "0"]).is_err());
    }

    #[test]
    fn bench_mode_defaults_to_churn() {
        let o = parse_v(&[]).unwrap();

        assert_eq!(o.bench_mode, BenchMode::Churn);
        assert_eq!(o.warmup_timeout_secs, 120);
        assert!(!o.json);
    }

    #[test]
    fn rejects_zero_global_move_limit() {
        let err = parse_v(&["--moves", "0"]).unwrap_err();

        assert!(err.contains("--moves must be greater than 0"), "{err}");
    }

    #[test]
    fn initial_balance_one_is_allowed_for_blackjack_v2() {
        let opts = parse_v(&["--protocol-ids", "blackjack.v2", "--initial-balance", "1"])
            .expect("blackjack.v2 supports a one-unit per-seat initial balance");

        assert_eq!(opts.initial_balance, 1);
    }

    #[test]
    fn initial_balance_rejects_protocols_with_larger_minimums() {
        let err = parse_v(&["--initial-balance", "1"]).unwrap_err();

        assert!(err.contains("blackjack.bet.v1"), "{err}");
        assert!(err.contains("25"), "{err}");
    }

    #[test]
    fn rejects_zero_initial_balance() {
        let err =
            parse_v(&["--protocol-ids", "blackjack.v2", "--initial-balance", "0"]).unwrap_err();

        assert!(
            err.contains("--initial-balance must be greater than 0"),
            "{err}"
        );
    }

    #[test]
    fn sui_batching_uses_flush_without_max_wait() {
        let opts = parse_v(&sui_anchor_args()).expect("parse sui opts");
        let sui = opts.sui_anchor.expect("sui opts");

        assert_eq!(sui.open_batching.max_batch_size, 255);
        assert_eq!(sui.open_batching.flush_interval_ms, 250);
        assert_eq!(sui.settle_batching.max_batch_size, 681);
        assert_eq!(sui.settle_batching.flush_interval_ms, 250);
    }

    #[test]
    fn max_wait_batch_flags_are_removed() {
        let mut open_max_wait = sui_anchor_args();
        open_max_wait.extend(["--sui-open-batch-max-wait-ms", "1000"]);
        let err = parse_v(&open_max_wait).unwrap_err();
        assert!(err.contains("unexpected argument"), "{err}");
        assert!(err.contains("--sui-open-batch-max-wait-ms"), "{err}");

        let mut settle_max_wait = sui_anchor_args();
        settle_max_wait.extend(["--sui-settle-batch-max-wait-ms", "1000"]);
        let err = parse_v(&settle_max_wait).unwrap_err();
        assert!(err.contains("unexpected argument"), "{err}");
        assert!(err.contains("--sui-settle-batch-max-wait-ms"), "{err}");
    }

    #[test]
    fn settle_batch_limit_allows_681_and_rejects_682() {
        let mut max_settle_batch = sui_anchor_args();
        max_settle_batch.extend(["--sui-settle-batch-size", "681"]);
        parse_v(&max_settle_batch).expect("681 settle batch size should parse");

        let mut oversized_settle_batch = sui_anchor_args();
        oversized_settle_batch.extend(["--sui-settle-batch-size", "682"]);
        let err = parse_v(&oversized_settle_batch).unwrap_err();
        assert!(
            err.contains("--sui-settle-batch-size must be <= 681"),
            "{err}"
        );
    }

    #[test]
    fn parses_the_headline_bun_command_line() {
        let o = parse_v(&[
            "--anchor",
            "memory",
            "--frame-transport",
            "local",
            "--protocol-ids",
            "blackjack.bet.v1",
        ])
        .unwrap();
        assert_eq!(o.duration_secs, 15);
        assert_eq!(o.tunnel_concurrency, ConcurrencyMode::Auto);
        assert_eq!(o.signer_init_mode, SignerInitMode::PerTunnel);
        assert_eq!(o.protocol_ids, vec!["blackjack.bet.v1"]);
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
    fn explicit_workers_concurrency_and_signer_init_mode() {
        let o = parse_v(&[
            "--workers",
            "1",
            "--tunnel-concurrency",
            "10",
            "--signer-init-mode",
            "per-tunnel",
        ])
        .unwrap();
        assert_eq!(o.workers, 1);
        assert_eq!(o.tunnel_concurrency, ConcurrencyMode::Fixed(10));
        assert_eq!(o.signer_init_mode, SignerInitMode::PerTunnel);
    }

    #[test]
    fn color_mode_defaults_to_auto_and_parses_overrides() {
        assert_eq!(parse_v(&[]).unwrap().color_mode, ColorMode::Auto);
        assert_eq!(
            parse_v(&["--color", "always"]).unwrap().color_mode,
            ColorMode::Always
        );
        assert_eq!(
            parse_v(&["--color", "never"]).unwrap().color_mode,
            ColorMode::Never
        );
        let err = parse_v(&["--color", "sometimes"]).unwrap_err();
        assert!(err.contains("--color must be auto|always|never"), "{err}");
    }

    #[test]
    fn pre_initialized_signers_uses_tunnel_concurrency_as_pool_size() {
        // tunnel_concurrency defaults to auto; an explicit count pins the
        // in-flight lifecycle pool and drives the pre-initialized signer pool.
        let o = parse_v(&["--signer-init-mode", "pre-initialized"]).unwrap();
        assert_eq!(o.signer_init_mode, SignerInitMode::PreInitialized);
        assert_eq!(o.tunnel_concurrency, ConcurrencyMode::Auto);
        let o = parse_v(&[
            "--signer-init-mode",
            "pre-initialized",
            "--tunnel-concurrency",
            "4",
        ])
        .unwrap();
        assert_eq!(o.tunnel_concurrency, ConcurrencyMode::Fixed(4));
    }

    #[test]
    fn scenario_is_varied_by_default_and_golden_opts_in() {
        assert_eq!(
            parse_v(&["--signer-init-mode", "per-tunnel"])
                .unwrap()
                .scenario,
            ScenarioMode::Varied
        );
        assert_eq!(
            parse_v(&["--signer-init-mode", "per-tunnel", "--scenario", "golden"])
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
        assert!(parse_v(&["--protocol-ids", "poker.v1"]).is_err());
    }

    #[test]
    fn all_ported_protocol_ids_are_executable() {
        for id in PORTED_PROTOCOL_IDS {
            let o = parse_v(&["--protocol-ids", id]).unwrap();
            assert_eq!(o.protocol_ids, vec![*id]);
        }
    }

    #[test]
    fn comma_separated_ids_run_in_listed_order() {
        let o = parse_v(&["--protocol-ids", "caro.v1, blackjack.v2 ,battleship.v1"]).unwrap();
        assert_eq!(
            o.protocol_ids,
            vec!["caro.v1", "blackjack.v2", "battleship.v1"]
        );
    }

    #[test]
    fn all_expands_to_every_ported_id_in_order() {
        let o = parse_v(&["--protocol-ids", "all"]).unwrap();
        assert_eq!(o.protocol_ids, PORTED_PROTOCOL_IDS.to_vec());
    }

    #[test]
    fn all_cannot_be_combined_with_other_ids() {
        let err = parse_v(&["--protocol-ids", "all,caro.v1"]).unwrap_err();
        assert!(err.contains("all"), "got: {err}");
    }

    #[test]
    fn duplicate_ids_are_rejected() {
        let err = parse_v(&["--protocol-ids", "caro.v1,caro.v1"]).unwrap_err();
        assert!(err.contains("duplicate"), "got: {err}");
    }

    #[test]
    fn empty_protocol_ids_are_rejected() {
        let err = parse_v(&["--protocol-ids", " , "]).unwrap_err();
        assert!(err.contains("at least one"), "got: {err}");
    }

    #[test]
    fn unknown_id_in_a_list_names_the_offender() {
        let err = parse_v(&["--protocol-ids", "caro.v1,poker.v1"]).unwrap_err();
        assert!(err.contains("poker.v1"), "got: {err}");
    }

    #[test]
    fn frame_codec_defaults_to_json_and_parses_each_variant() {
        assert_eq!(
            parse_v(&["--signer-init-mode", "per-tunnel"])
                .unwrap()
                .frame_codec,
            FrameCodecKind::Json
        );
        assert_eq!(
            parse_v(&["--signer-init-mode", "per-tunnel", "--frame-codec", "bcs"])
                .unwrap()
                .frame_codec,
            FrameCodecKind::Bcs
        );
        assert_eq!(
            parse_v(&[
                "--signer-init-mode",
                "per-tunnel",
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
    fn anchor_sui_sponsored_is_the_preferred_sui_anchor_name() {
        let o = parse_v(&[
            "--anchor",
            "sui-sponsored",
            "--transcript-recorder",
            "memory",
            "--sui-rpc-url",
            "https://sui.example/rpc",
            "--sui-backend-url",
            "https://backend.example",
            "--sui-package-id",
            "0xabc",
            "--sui-funder-priv-key",
            "suiprivkey1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
            "--sui-stake-source",
            "coin-object",
            "--sui-funder-stake-coin-id",
            "0xcoin",
        ])
        .unwrap();

        assert_eq!(o.anchor_mode, AnchorMode::SuiSponsored);
        let sui = o.sui_anchor.expect("sui config");
        assert_eq!(sui.open_mode, SuiOpenMode::SponsoredCreateAndFund);
        assert_eq!(sui.settle_mode, SuiSettleMode::BackendSettle);
        assert_eq!(
            sui.funding_profile,
            SuiFundingProfile::SingleFunder {
                priv_key:
                    "suiprivkey1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq"
                        .into(),
                stake_source: SuiStakeSource::CoinObject {
                    coin_id: "0xcoin".into()
                }
            }
        );
    }

    #[test]
    fn anchor_sui_accepts_direct_and_sponsored_composition_modes() {
        let o = parse_v(&[
            "--anchor",
            "sui-sponsored",
            "--transcript-recorder",
            "memory",
            "--sui-rpc-url",
            "https://sui.example/rpc",
            "--sui-backend-url",
            "https://backend.example",
            "--sui-package-id",
            "0xabc",
            "--sui-funder-priv-key",
            "suiprivkey1example",
            "--sui-funder-stake-coin-id",
            "0xcoin",
            "--sui-open-mode",
            "direct-create-and-fund",
            "--sui-settle-mode",
            "sponsored-settle",
        ])
        .unwrap();

        let sui = o.sui_anchor.expect("sui config");
        assert_eq!(sui.open_mode, SuiOpenMode::DirectCreateAndFund);
        assert_eq!(sui.settle_mode, SuiSettleMode::SponsoredSettle);

        let direct_settle = parse_v(&[
            "--anchor",
            "sui-sponsored",
            "--transcript-recorder",
            "memory",
            "--sui-rpc-url",
            "https://sui.example/rpc",
            "--sui-backend-url",
            "https://backend.example",
            "--sui-package-id",
            "0xabc",
            "--sui-funder-priv-key",
            "suiprivkey1example",
            "--sui-funder-stake-coin-id",
            "0xcoin",
            "--sui-settle-mode",
            "direct-settle",
        ])
        .unwrap();

        let sui = direct_settle.sui_anchor.expect("sui config");
        assert_eq!(sui.settle_mode, SuiSettleMode::DirectSettle);
    }

    #[test]
    fn anchor_sui_alias_lowers_to_sui_sponsored_for_backwards_compatibility() {
        let o = parse_v(&[
            "--anchor",
            "sui",
            "--transcript-recorder",
            "memory",
            "--sui-rpc-url",
            "https://sui.example/rpc",
            "--sui-backend-url",
            "https://backend.example",
            "--sui-package-id",
            "0xabc",
            "--sui-funder-priv-key",
            "suiprivkey1example",
            "--sui-funder-stake-coin-id",
            "0xcoin",
        ])
        .unwrap();

        assert_eq!(o.anchor_mode, AnchorMode::SuiSponsored);
    }

    #[test]
    fn anchor_sui_rejects_unknown_composition_modes() {
        let base = [
            "--anchor",
            "sui-sponsored",
            "--transcript-recorder",
            "memory",
            "--sui-rpc-url",
            "https://sui.example/rpc",
            "--sui-backend-url",
            "https://backend.example",
            "--sui-package-id",
            "0xabc",
            "--sui-funder-priv-key",
            "suiprivkey1example",
            "--sui-funder-stake-coin-id",
            "0xcoin",
        ];

        let mut bad_open = base.to_vec();
        bad_open.extend(["--sui-open-mode", "backend-create-and-fund"]);
        let err = parse_v(&bad_open).unwrap_err();
        assert!(err.contains("sui-open-mode"), "{err}");

        let mut bad_settle = base.to_vec();
        bad_settle.extend(["--sui-settle-mode", "direct-ptb"]);
        let err = parse_v(&bad_settle).unwrap_err();
        assert!(err.contains("sui-settle-mode"), "{err}");

        let mut bad_funding = base.to_vec();
        bad_funding.extend(["--sui-funding-profile", "per-seat"]);
        let err = parse_v(&bad_funding).unwrap_err();
        assert!(err.contains("sui-funding-profile"), "{err}");
    }

    #[test]
    fn anchor_sui_requires_chain_config_not_transcript_recorder() {
        let err = parse_v(&["--anchor", "sui"]).unwrap_err();
        assert!(err.contains("sui-rpc-url"), "{err}");
        assert!(err.contains("sui-funder-priv-key"), "{err}");

        let err = parse_v(&["--anchor", "sui", "--transcript-recorder", "memory"]).unwrap_err();
        assert!(err.contains("sui-rpc-url"), "{err}");
        assert!(err.contains("sui-funder-priv-key"), "{err}");
    }

    #[test]
    fn anchor_sui_allows_transcript_recorder_none() {
        let o = parse_v(&[
            "--anchor",
            "sui",
            "--transcript-recorder",
            "none",
            "--sui-rpc-url",
            "https://sui.example/rpc",
            "--sui-backend-url",
            "https://backend.example",
            "--sui-package-id",
            "0xabc",
            "--sui-funder-priv-key",
            "suiprivkey1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
            "--sui-stake-source",
            "address-balance",
        ])
        .unwrap();

        assert_eq!(o.transcript_recorder, TranscriptRecorderMode::None);
        assert_eq!(o.anchor_mode, AnchorMode::SuiSponsored);
        assert!(o.sui_anchor.is_some());
    }

    #[test]
    fn anchor_sui_address_balance_stake_source_does_not_require_stake_coin_id() {
        let o = parse_v(&[
            "--anchor",
            "sui",
            "--transcript-recorder",
            "memory",
            "--sui-rpc-url",
            "https://sui.example/rpc",
            "--sui-backend-url",
            "https://backend.example",
            "--sui-package-id",
            "0xabc",
            "--sui-funder-priv-key",
            "suiprivkey1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
            "--sui-stake-source",
            "address-balance",
        ])
        .unwrap();

        let sui = o.sui_anchor.expect("sui config");
        assert_eq!(
            sui.funding_profile,
            SuiFundingProfile::SingleFunder {
                priv_key:
                    "suiprivkey1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq"
                        .into(),
                stake_source: SuiStakeSource::AddressBalance,
            }
        );
    }

    #[test]
    fn anchor_sui_coin_object_stake_source_requires_stake_coin_id() {
        let err = parse_v(&[
            "--anchor",
            "sui",
            "--transcript-recorder",
            "memory",
            "--sui-rpc-url",
            "https://sui.example/rpc",
            "--sui-backend-url",
            "https://backend.example",
            "--sui-package-id",
            "0xabc",
            "--sui-funder-priv-key",
            "suiprivkey1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
            "--sui-stake-source",
            "coin-object",
        ])
        .unwrap_err();

        assert!(err.contains("sui-funder-stake-coin-id"), "{err}");
    }

    #[test]
    fn anchor_sui_parses_rpc_and_funder_options() {
        let o = parse_v(&[
            "--anchor",
            "sui",
            "--transcript-recorder",
            "memory",
            "--sui-rpc-url",
            "https://sui.example/rpc",
            "--sui-backend-url",
            "https://backend.example",
            "--sui-package-id",
            "0xabc",
            "--sui-funder-priv-key",
            "suiprivkey1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq",
            "--sui-stake-source",
            "coin-object",
            "--sui-funder-stake-coin-id",
            "0xcoin",
        ])
        .unwrap();

        assert_eq!(o.anchor_mode, AnchorMode::SuiSponsored);
        let sui = o.sui_anchor.expect("sui config");
        assert_eq!(sui.rpc_url, "https://sui.example/rpc");
        assert_eq!(sui.backend_url, "https://backend.example");
        assert_eq!(sui.package_id, "0xabc");
        assert_eq!(sui.tunnel_coin_type, "0x2::sui::SUI");
        assert_eq!(sui.open_mode, SuiOpenMode::SponsoredCreateAndFund);
        assert_eq!(sui.settle_mode, SuiSettleMode::BackendSettle);
        assert_eq!(
            sui.funding_profile,
            SuiFundingProfile::SingleFunder {
                priv_key:
                    "suiprivkey1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq"
                        .into(),
                stake_source: SuiStakeSource::CoinObject {
                    coin_id: "0xcoin".into()
                }
            }
        );
    }

    #[test]
    fn anchor_sui_ptb_batching_defaults_to_enabled_conservative_limits() {
        let opts = parse(vec![
            "--anchor".into(),
            "sui".into(),
            "--transcript-recorder".into(),
            "memory".into(),
            "--sui-rpc-url".into(),
            "http://rpc".into(),
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
        assert_eq!(sui.open_batching.max_batch_size, 255);
        assert_eq!(sui.open_batching.flush_interval_ms, 250);
        assert_eq!(sui.open_batching.max_concurrent_flushes, 4);
        assert_eq!(sui.open_batching.flush_spacing_ms, 0);
        assert!(sui.settle_batching.enabled);
        assert_eq!(sui.settle_batching.max_batch_size, 681);
        assert_eq!(sui.settle_batching.flush_interval_ms, 250);
        assert_eq!(sui.settle_batching.max_concurrent_flushes, 4);
        assert_eq!(sui.settle_batching.flush_spacing_ms, 0);
    }

    #[test]
    fn anchor_sui_ptb_batching_flags_override_defaults() {
        let opts = parse(vec![
            "--anchor".into(),
            "sui".into(),
            "--transcript-recorder".into(),
            "memory".into(),
            "--sui-rpc-url".into(),
            "http://rpc".into(),
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
            "--sui-open-batch-max-in-flight".into(),
            "2".into(),
            "--sui-open-batch-gap-ms".into(),
            "15".into(),
            "--sui-settle-batch-size".into(),
            "15".into(),
            "--sui-settle-batch-flush-ms".into(),
            "75".into(),
            "--sui-settle-batch-max-in-flight".into(),
            "3".into(),
            "--sui-settle-batch-gap-ms".into(),
            "20".into(),
        ]);
        let opts = opts.expect("parse sui opts");
        let sui = opts.sui_anchor.expect("sui opts");
        assert_eq!(sui.open_batching.max_batch_size, 25);
        assert_eq!(sui.open_batching.flush_interval_ms, 100);
        assert_eq!(sui.open_batching.max_concurrent_flushes, 2);
        assert_eq!(sui.open_batching.flush_spacing_ms, 15);
        assert_eq!(sui.settle_batching.max_batch_size, 15);
        assert_eq!(sui.settle_batching.flush_interval_ms, 75);
        assert_eq!(sui.settle_batching.max_concurrent_flushes, 3);
        assert_eq!(sui.settle_batching.flush_spacing_ms, 20);
    }

    #[test]
    fn anchor_sui_ptb_batching_can_be_disabled() {
        let opts = parse_v(&[
            "--anchor",
            "sui",
            "--transcript-recorder",
            "memory",
            "--sui-rpc-url",
            "http://rpc",
            "--sui-backend-url",
            "http://backend",
            "--sui-package-id",
            "0x2",
            "--sui-funder-priv-key",
            "suiprivkey1example",
            "--sui-funder-stake-coin-id",
            "0x7",
            "--sui-disable-open-batching",
            "--sui-disable-settle-batching",
        ])
        .expect("parse sui opts");
        let sui = opts.sui_anchor.expect("sui opts");
        assert!(!sui.open_batching.enabled);
        assert!(!sui.settle_batching.enabled);
    }

    #[test]
    fn anchor_sui_ptb_batching_rejects_invalid_limits() {
        let base = [
            "--anchor",
            "sui",
            "--transcript-recorder",
            "memory",
            "--sui-rpc-url",
            "http://rpc",
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
        oversized_batch.extend(["--sui-open-batch-size", "256"]);
        let err = parse_v(&oversized_batch).unwrap_err();
        assert!(err.contains("sui-open-batch-size"), "{err}");

        let mut zero_flush_ms = base.to_vec();
        zero_flush_ms.extend(["--sui-open-batch-flush-ms", "0"]);
        let err = parse_v(&zero_flush_ms).unwrap_err();
        assert!(err.contains("sui-open-batch-flush-ms"), "{err}");

        let mut zero_settle_batch_size = base.to_vec();
        zero_settle_batch_size.extend(["--sui-settle-batch-size", "0"]);
        let err = parse_v(&zero_settle_batch_size).unwrap_err();
        assert!(err.contains("sui-settle-batch-size"), "{err}");

        let mut oversized_settle_batch = base.to_vec();
        oversized_settle_batch.extend(["--sui-settle-batch-size", "682"]);
        let err = parse_v(&oversized_settle_batch).unwrap_err();
        assert!(err.contains("sui-settle-batch-size"), "{err}");

        let mut zero_settle_flush_ms = base.to_vec();
        zero_settle_flush_ms.extend(["--sui-settle-batch-flush-ms", "0"]);
        let err = parse_v(&zero_settle_flush_ms).unwrap_err();
        assert!(err.contains("sui-settle-batch-flush-ms"), "{err}");

        let mut zero_open_max_in_flight = base.to_vec();
        zero_open_max_in_flight.extend(["--sui-open-batch-max-in-flight", "0"]);
        let err = parse_v(&zero_open_max_in_flight).unwrap_err();
        assert!(err.contains("sui-open-batch-max-in-flight"), "{err}");

        let mut zero_settle_max_in_flight = base.to_vec();
        zero_settle_max_in_flight.extend(["--sui-settle-batch-max-in-flight", "0"]);
        let err = parse_v(&zero_settle_max_in_flight).unwrap_err();
        assert!(err.contains("sui-settle-batch-max-in-flight"), "{err}");
    }

    #[test]
    fn parses_tunnel_concurrency_and_flags() {
        let o = parse_v(&[
            "--tunnel-concurrency",
            "255",
            "--per-move-latency",
            "--trace",
        ])
        .unwrap();
        assert_eq!(o.tunnel_concurrency, ConcurrencyMode::Fixed(255));
        assert!(o.per_move_latency);
        assert!(o.trace);
    }

    #[test]
    fn tunnel_concurrency_auto_is_default_and_numbers_pin_pool_size() {
        assert_eq!(
            parse_v(&[]).unwrap().tunnel_concurrency,
            ConcurrencyMode::Auto
        );
        assert_eq!(
            parse_v(&["--tunnel-concurrency", "auto"])
                .unwrap()
                .tunnel_concurrency,
            ConcurrencyMode::Auto
        );
        assert_eq!(
            parse_v(&["--tunnel-concurrency", "128"])
                .unwrap()
                .tunnel_concurrency,
            ConcurrencyMode::Fixed(128)
        );
        let err = parse_v(&["--tunnel-concurrency", "0"]).unwrap_err();
        assert!(err.contains("at least 1"), "{err}");
        let err = parse_v(&["--tunnel-concurrency", "lots"]).unwrap_err();
        assert!(err.contains("auto"), "{err}");
    }

    #[test]
    fn matches_flag_is_gone() {
        assert!(parse_v(&["--matches", "10"]).is_err());
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
            "fleet-bench --anchor memory --signer-init-mode per-tunnel --tunnel-concurrency 50 --scenario golden --frame-codec postcard"
        ));
        assert!(help.contains(
            "fleet-bench --protocol-ids blackjack.v2 --tunnel-concurrency 100 --scenario varied --transcript-recorder memory"
        ));
        assert!(help.contains("json: TS-parity wire for bot-vs-user"));
        assert!(help.contains("postcard: compact default candidate for bot-vs-bot"));
        assert!(help.contains("per-tunnel|pre-initialized"));
        assert!(help.contains("--protocol-ids takes one ID, a comma-separated list, or `all`"));
        assert!(help
            .contains("fleet-bench --protocol-ids caro.v1,blackjack.v2 --tunnel-concurrency 100"));
        assert!(help.contains("fleet-bench --protocol-ids all --tunnel-concurrency 50"));
        assert!(help.contains("blackjack.bet.v1"));
        assert!(help.contains("json|bcs|postcard"));
        assert!(
            help.contains("memory: in-memory tunnel anchor for local throughput runs; no chain IO")
        );
        assert!(help.contains("memory: retain committed transitions in memory during each tunnel"));
        assert!(help.contains("none|memory"));
    }

    #[test]
    fn help_documents_sui_sponsored_composition_flags() {
        let help = help_text();

        assert!(help.contains("--anchor <memory|sui-sponsored>"));
        assert!(help.contains("  sui-sponsored: Sui Tunnel anchor"));
        assert!(help.contains("  sui: backwards-compatible alias for sui-sponsored"));
        assert!(help.contains("--sui-open-mode <sponsored-create-and-fund|direct-create-and-fund>"));
        assert!(help.contains("sponsored-create-and-fund: build tunnel::create_and_fund<T>"));
        assert!(help.contains("direct-create-and-fund: build the same open PTBs"));
        assert!(help.contains("--sui-settle-mode <backend-settle|sponsored-settle|direct-settle>"));
        assert!(help.contains("backend-settle: submit the TS-compatible settlement body"));
        assert!(help.contains("sponsored-settle: build the settlement PTB locally"));
        assert!(help.contains("direct-settle: build the settlement PTB locally"));
        assert!(help.contains("--sui-funding-profile <single-funder>"));
        assert!(help.contains("single-funder: one bech32 Sui private key funds both seats"));
        assert!(help.contains("--sui-stake-source <coin-object|address-balance>"));
        assert!(help.contains("coin-object: split both stakes from --sui-funder-stake-coin-id"));
        assert!(help.contains("address-balance: withdraw the total stake from the sender balance"));
        assert!(help.contains("--initial-balance"));
        assert!(help.contains("total open deposit is twice this value"));
        assert!(help.contains("--sui-open-batch-size <N>"));
        assert!(help.contains("default 255, maximum 255"));
        assert!(help.contains("--sui-open-batch-flush-ms <MS>"));
        assert!(help.contains("--sui-disable-open-batching"));
        assert!(help.contains("--sui-settle-batch-size <N>"));
        assert!(help.contains("default 681, maximum 681"));
        assert!(help.contains("--sui-settle-batch-flush-ms <MS>"));
        assert!(help.contains("--sui-disable-settle-batching"));
    }
}
