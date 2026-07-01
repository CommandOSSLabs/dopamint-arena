//! `fleet-bench` swarm bench binary. Parses flags, runs the tunnel swarm under a
//! resource sampler, and prints the loadbench-shaped report.

use std::io::IsTerminal;

use fleet_bench::cli::{
    self, AnchorMode, ColorMode, ConcurrencyMode, SignerInitMode, TranscriptRecorderMode,
};
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

    if opts.trace {
        let env_filter = tracing_subscriber::EnvFilter::new(
            "fleet_bench=debug,sui_tunnel_anchor=debug,tunnel_harness=info",
        );
        tracing_subscriber::fmt().with_env_filter(env_filter).init();
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
fn duration_guard_for_run(opts: &cli::BenchOpts) -> u64 {
    match opts.tunnel_concurrency {
        ConcurrencyMode::Auto => opts.duration_secs,
        ConcurrencyMode::Fixed(_) => 0,
    }
}

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
    let duration_guard_secs = duration_guard_for_run(opts);
    let sampler = resources::start(250, opts.workers);
    let outcome = match opts.tunnel_concurrency {
        ConcurrencyMode::Auto => swarm::run_steady_state(
            opts.workers,
            duration_guard_secs,
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
            duration_guard_secs,
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
            duration_guard_secs,
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
            sui_anchor: None::<SuiSponsoredAnchorOpts>,
        }
    }

    #[test]
    fn fixed_concurrency_runs_without_duration_guard() {
        assert_eq!(
            duration_guard_for_run(&opts(ConcurrencyMode::Fixed(1000))),
            0
        );
    }

    #[test]
    fn auto_concurrency_uses_duration_guard() {
        assert_eq!(duration_guard_for_run(&opts(ConcurrencyMode::Auto)), 15);
    }
}
