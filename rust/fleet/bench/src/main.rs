//! `fleet-bench` swarm bench binary. Parses flags, runs the tunnel swarm under a
//! resource sampler, and prints the loadbench-shaped report.

use std::io::IsTerminal;

use fleet_bench::cli::{
    self, AnchorMode, ColorMode, ConcurrencyMode, SignerInitMode, TranscriptRecorderMode,
};
use fleet_bench::party_driver::{
    build_sui_sponsored_bench_context, TunnelTelemetry, SuiSponsoredBenchContext,
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

    if opts.trace {
        tracing_subscriber::fmt()
            .with_env_filter(tracing_subscriber::EnvFilter::new("info"))
            .init();
    }

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
/// headline outcome and its resources. `--tunnel-concurrency auto` runs a
/// duration-led steady state; a fixed count runs exactly that many tunnels once.
fn run_protocol(
    opts: &cli::BenchOpts,
    sui_context: Option<&SuiSponsoredBenchContext>,
    protocol_id: &'static str,
) -> (swarm::SwarmOutcome, resources::ResourceSummary) {
    let preinitialize = matches!(opts.signer_init_mode, SignerInitMode::PreInitialized);
    let telemetry = TunnelTelemetry {
        collect: opts.per_move_latency,
        record_transcript: matches!(opts.transcript_recorder, TranscriptRecorderMode::Memory),
    };
    let sampler = resources::start(250, opts.workers);
    let outcome = match opts.tunnel_concurrency {
        ConcurrencyMode::Auto => swarm::run_steady_state(
            opts.workers,
            opts.duration_secs,
            ConcurrencyMode::auto_in_flight(opts.workers),
            opts.scenario,
            opts.frame_codec,
            opts.anchor_mode,
            sui_context,
            protocol_id,
            telemetry,
            preinitialize,
        ),
        ConcurrencyMode::Fixed(count) if preinitialize => swarm::run_preinitialized_signers(
            opts.workers,
            opts.duration_secs,
            count,
            opts.scenario,
            opts.frame_codec,
            opts.anchor_mode,
            sui_context,
            protocol_id,
            telemetry,
        ),
        ConcurrencyMode::Fixed(count) => swarm::run_concurrent_tunnels(
            opts.workers,
            opts.duration_secs,
            count,
            opts.scenario,
            opts.frame_codec,
            opts.anchor_mode,
            sui_context,
            protocol_id,
            telemetry,
        ),
    };
    (outcome, sampler.stop())
}
