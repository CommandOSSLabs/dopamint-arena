//! `rustbench` swarm bench binary. Parses flags, runs the rayon fleet under a
//! resource sampler, and prints the loadbench-shaped report.

use rustbench::cli::{self, Runner};
use rustbench::fleet::{resources, swarm};
use rustbench::report;

fn main() {
    let opts = match cli::parse(std::env::args().skip(1)) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(2);
        }
    };

    // Headline runner: fresh per-match keys (apples-to-apples with loadbench's
    // harness) or the fixed-key simple runner. fn-pointer annotation coerces
    // both fn items to one type.
    // TODO(task-6): replace CardMode::Deterministic with opts.card_mode.
    let run_headline: fn(usize, u64, Option<u64>, swarm::CardMode) -> swarm::SwarmOutcome =
        if opts.fresh_keys {
            swarm::run_fresh_keys
        } else {
            swarm::run_simple
        };

    let (simple, optimized, res) = match opts.runner {
        Runner::Simple => {
            let sampler = resources::start(250);
            let simple = run_headline(
                opts.workers,
                opts.duration_secs,
                opts.matches,
                swarm::CardMode::Deterministic,
            );
            (simple, None, sampler.stop())
        }
        Runner::Optimized => {
            let sampler = resources::start(250);
            let optimized = swarm::run_optimized(
                opts.workers,
                opts.duration_secs,
                opts.matches,
                swarm::CardMode::Deterministic,
            );
            // Report the optimized window as the headline; no parenthetical.
            (optimized, None, sampler.stop())
        }
        Runner::Both => {
            // Simple window first (the resources line describes it), then optimized.
            let sampler = resources::start(250);
            let simple = run_headline(
                opts.workers,
                opts.duration_secs,
                opts.matches,
                swarm::CardMode::Deterministic,
            );
            let res = sampler.stop();
            let optimized = swarm::run_optimized(
                opts.workers,
                opts.duration_secs,
                opts.matches,
                swarm::CardMode::Deterministic,
            );
            (simple, Some(optimized), res)
        }
    };
    print!(
        "{}",
        report::render(&opts, &simple, optimized.as_ref(), &res)
    );
}
