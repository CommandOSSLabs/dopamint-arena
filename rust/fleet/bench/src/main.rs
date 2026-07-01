//! `fleet-bench` swarm bench binary. Parses flags, runs the tunnel swarm under a
//! resource sampler, and prints the loadbench-shaped report.

use std::io::IsTerminal;

// The swarm saturates every core with allocation-heavy per-move work; jemalloc's
// per-thread arenas remove the global-allocator lock contention that otherwise
// caps multi-threaded throughput. Bench-binary only — never linked into the
// engine or services. Excluded on MSVC, where jemalloc is unsupported.
#[cfg(not(target_env = "msvc"))]
#[global_allocator]
static GLOBAL: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

use fleet_bench::cli::{
    self, AnchorMode, ColorMode, ConcurrencyMode, SignerInitMode, TranscriptRecorderMode,
};
use fleet_bench::heartbeat::HeartbeatConfig;
use fleet_bench::party_driver::{
    build_sui_sponsored_bench_context, SuiSponsoredBenchContext, TunnelTelemetry,
};
use fleet_bench::report::{self, RenderStyle};
use fleet_bench::{resources, swarm};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--help" || arg == "-h") {
        print!("{}", cli::help_text());
        return;
    }

    let opts = match cli::parse(args) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };
    let render_style = match opts.color_mode {
        ColorMode::Always => RenderStyle::Color,
        ColorMode::Never => RenderStyle::Plain,
        ColorMode::Auto if std::io::stdout().is_terminal() => RenderStyle::Color,
        ColorMode::Auto => RenderStyle::Plain,
    };

    // Always install a subscriber writing to stderr so the report on stdout stays
    // clean. Without `--trace` we still surface `warn`+ so anchor-level failures
    // (RPC rate limits, transport stalls) that stall a swarm are diagnosable.
    let env_filter = if opts.trace {
        tracing_subscriber::EnvFilter::new(
            "fleet_bench=debug,sui_tunnel_anchor=debug,tunnel_harness=info",
        )
    } else {
        tracing_subscriber::EnvFilter::new("warn")
    };
    tracing_subscriber::fmt()
        .with_env_filter(env_filter)
        .with_writer(std::io::stderr)
        .init();

    let sui_context = match opts.anchor_mode {
        AnchorMode::Memory => None,
        AnchorMode::SuiSponsored => {
            match build_sui_sponsored_bench_context(opts.sui_anchor.as_ref()) {
                Ok(context) => Some(context),
                Err(e) => {
                    eprintln!("{e}");
                    std::process::exit(2);
                }
            }
        }
    };

    // Protocols run sequentially so they never contend for CPU; each gets its
    // own resource-sampling window and full per-protocol report block.
    let mut summaries = Vec::with_capacity(opts.protocol_ids.len());
    for protocol_id in &opts.protocol_ids {
        let (outcome, res) = run_protocol(&opts, sui_context.as_ref(), protocol_id);
        print!(
            "{}",
            report::render_with_style(&opts, protocol_id, &outcome, &res, render_style)
        );
        summaries.push(report::ProtocolRunSummary::from_run(protocol_id, &outcome));
    }

    if summaries.len() > 1 {
        print!(
            "{}",
            report::render_summary_with_style(&opts, &summaries, render_style)
        );
    }
}

/// Runs one protocol under its own resource-sampling window, returning the
/// headline outcome and its resources. `--tunnel-concurrency` is the maximum
/// number of in-flight tunnel lifecycles.
fn tunnel_pool_for_run(opts: &cli::BenchOpts) -> usize {
    match opts.tunnel_concurrency {
        ConcurrencyMode::Auto => ConcurrencyMode::auto_in_flight(opts.workers),
        ConcurrencyMode::Fixed(count) => count
            .try_into()
            .expect("fixed tunnel concurrency exceeds usize"),
    }
}

fn run_protocol(
    opts: &cli::BenchOpts,
    sui_context: Option<&SuiSponsoredBenchContext>,
    protocol_id: &'static str,
) -> (swarm::SwarmOutcome, resources::ResourceSummary) {
    let preinitialize = matches!(opts.signer_init_mode, SignerInitMode::PreInitialized);
    let heartbeat = resolve_heartbeat(opts, protocol_id);
    let telemetry = TunnelTelemetry {
        collect: opts.per_move_latency,
        record_transcript: matches!(opts.transcript_recorder, TranscriptRecorderMode::Memory),
        heartbeat,
    };
    let tunnel_pool = tunnel_pool_for_run(opts);
    let sampler = resources::start(250, opts.workers);
    let outcome = swarm::run_lifecycle_pipeline(
        opts.workers,
        opts.duration_secs,
        opts.moves,
        tunnel_pool,
        opts.scenario,
        opts.frame_codec,
        opts.anchor_mode,
        sui_context,
        protocol_id,
        opts.initial_balance,
        telemetry,
        preinitialize,
    );
    (outcome, sampler.stop())
}

fn resolve_heartbeat(opts: &cli::BenchOpts, protocol_id: &'static str) -> Option<HeartbeatConfig> {
    let setup = opts.heartbeat.as_ref()?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("heartbeat setup runtime");
    match runtime.block_on(setup.register(protocol_id)) {
        Ok(config) => Some(config),
        Err(error) => {
            eprintln!("{error}; continuing without heartbeat telemetry");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use fleet_bench::cli::{
        BenchOpts, ColorMode, FrameCodecKind, ScenarioMode, SuiSponsoredAnchorOpts,
    };

    fn opts(tunnel_concurrency: ConcurrencyMode) -> BenchOpts {
        BenchOpts {
            workers: 4,
            duration_secs: 15,
            moves: None,
            initial_balance: 200,
            tunnel_concurrency,
            per_move_latency: false,
            trace: false,
            signer_init_mode: SignerInitMode::PerTunnel,
            protocol_ids: vec![tunnel_core::protocol_id::BLACKJACK_V2],
            scenario: ScenarioMode::Varied,
            frame_codec: FrameCodecKind::Json,
            anchor_mode: AnchorMode::Memory,
            color_mode: ColorMode::Never,
            transcript_recorder: TranscriptRecorderMode::None,
            heartbeat: None,
            sui_anchor: None::<SuiSponsoredAnchorOpts>,
        }
    }

    #[test]
    fn fixed_concurrency_sets_lifecycle_pool_size() {
        assert_eq!(
            tunnel_pool_for_run(&opts(ConcurrencyMode::Fixed(1000))),
            1000
        );
    }

    #[test]
    fn auto_concurrency_derives_lifecycle_pool_from_workers() {
        assert_eq!(
            tunnel_pool_for_run(&opts(ConcurrencyMode::Auto)),
            ConcurrencyMode::auto_in_flight(4)
        );
    }
}
