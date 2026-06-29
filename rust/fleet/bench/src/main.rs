//! `fleet-bench` swarm bench binary. Parses flags, runs the rayon fleet under a
//! resource sampler, and prints the loadbench-shaped report.

use fleet_bench::cli::{self, AnchorMode, BenchMode};
use fleet_bench::party_driver::build_sui_sponsored_bench_context;
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

    let (simple, preinitialized, res) = match opts.bench_mode {
        BenchMode::PerMatchSigners => {
            let sampler = resources::start(250, opts.workers);
            let simple = swarm::run_fresh_keys(
                opts.workers,
                opts.duration_secs,
                opts.matches,
                opts.scenario,
                opts.frame_codec,
                opts.anchor_mode,
                sui_context.as_ref(),
                opts.transcript_recorder,
                opts.protocol_id,
            );
            (simple, None, sampler.stop())
        }
        BenchMode::PreInitializedSigners => {
            let sampler = resources::start(250, opts.workers);
            let preinitialized = swarm::run_preinitialized_signers(
                opts.workers,
                opts.duration_secs,
                opts.matches.expect("validated by cli"),
                opts.scenario,
                opts.frame_codec,
                opts.anchor_mode,
                sui_context.as_ref(),
                opts.transcript_recorder,
                opts.protocol_id,
            );
            // Report the steady-state window as the headline; no parenthetical.
            (preinitialized, None, sampler.stop())
        }
        BenchMode::CompareSigners => {
            // Per-match signer window first (the resources line describes it), then
            // the steady-state pre-initialized signer window.
            let sampler = resources::start(250, opts.workers);
            let simple = swarm::run_fresh_keys(
                opts.workers,
                opts.duration_secs,
                opts.matches,
                opts.scenario,
                opts.frame_codec,
                opts.anchor_mode,
                sui_context.as_ref(),
                opts.transcript_recorder,
                opts.protocol_id,
            );
            let res = sampler.stop();
            let preinitialized = swarm::run_preinitialized_signers(
                opts.workers,
                opts.duration_secs,
                opts.matches.expect("validated by cli"),
                opts.scenario,
                opts.frame_codec,
                opts.anchor_mode,
                sui_context.as_ref(),
                opts.transcript_recorder,
                opts.protocol_id,
            );
            (simple, Some(preinitialized), res)
        }
    };
    print!(
        "{}",
        report::render(&opts, &simple, preinitialized.as_ref(), &res)
    );
}
