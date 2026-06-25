//! `rustbench` swarm bench binary. Parses flags, runs the rayon fleet under a
//! resource sampler, and prints the loadbench-shaped report. Optimized runner is
//! wired in Task 6; until then `--runner optimized|both` runs the simple fleet
//! and reports it as the simple figure.

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

    // Simple runner window (the honest baseline). Sampler brackets the run.
    let sampler = resources::start(250);
    let simple = swarm::run_simple(opts.workers, opts.duration_secs, opts.matches);
    let res = sampler.stop();

    // Optimized runner is added in Task 6; for now report only the simple figure.
    let _ = Runner::Both;
    print!("{}", report::render(&opts, &simple, None, &res));
}
