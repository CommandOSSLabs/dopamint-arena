//! `fleet-bench` swarm bench binary. Parses flags, runs the rayon fleet under a
//! resource sampler, and prints the loadbench-shaped report.

use fleet_bench::cli::{self, AnchorMode, SignerInitMode};
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

    let (outcome, res) = match opts.signer_init_mode {
        SignerInitMode::PerMatch => {
            let sampler = resources::start(250, opts.workers);
            let outcome = swarm::run_fresh_keys(
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
            (outcome, sampler.stop())
        }
        SignerInitMode::PreInitialized => {
            let sampler = resources::start(250, opts.workers);
            let outcome = swarm::run_preinitialized_signers(
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
            (outcome, sampler.stop())
        }
    };
    print!("{}", report::render(&opts, &outcome, &res));
}
