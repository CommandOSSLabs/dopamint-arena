//! `fleet-bench` swarm bench binary. Parses flags, runs the rayon fleet under a
//! resource sampler, and prints the loadbench-shaped report.

use fleet_bench::cli::{self, BenchMode};
use fleet_bench::report;
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

    // Headline path: fresh per-match signers (apples-to-apples with loadbench's
    // harness) or a reused fixed signer pair. fn-pointer annotation coerces both
    // fn items to one type.
    let run_headline: fn(
        usize,
        u64,
        Option<u64>,
        cli::ScenarioMode,
        cli::FrameCodecKind,
    ) -> swarm::SwarmOutcome = if opts.reuse_signers {
        swarm::run_simple
    } else {
        swarm::run_fresh_keys
    };

    let (simple, optimized, res) = match opts.bench_mode {
        BenchMode::Baseline => {
            let sampler = resources::start(250, opts.workers);
            let simple = run_headline(
                opts.workers,
                opts.duration_secs,
                opts.matches,
                opts.scenario,
                opts.frame_codec,
            );
            (simple, None, sampler.stop())
        }
        BenchMode::CachedSigners => {
            let sampler = resources::start(250, opts.workers);
            let optimized = swarm::run_optimized(
                opts.workers,
                opts.duration_secs,
                opts.matches,
                opts.scenario,
                opts.frame_codec,
            );
            // Report the optimized window as the headline; no parenthetical.
            (optimized, None, sampler.stop())
        }
        BenchMode::Compare => {
            // Simple window first (the resources line describes it), then optimized.
            let sampler = resources::start(250, opts.workers);
            let simple = run_headline(
                opts.workers,
                opts.duration_secs,
                opts.matches,
                opts.scenario,
                opts.frame_codec,
            );
            let res = sampler.stop();
            let optimized = swarm::run_optimized(
                opts.workers,
                opts.duration_secs,
                opts.matches,
                opts.scenario,
                opts.frame_codec,
            );
            (simple, Some(optimized), res)
        }
    };
    print!(
        "{}",
        report::render(&opts, &simple, optimized.as_ref(), &res)
    );
}
