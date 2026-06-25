//! Console report, format-parity with the loadbench swarm output. Pure string
//! building — the binary prints the result. Headline lines describe the simple
//! runner; the optimized runner's TPS is appended on the move-TPS line.

use crate::cli::BenchOpts;
use crate::fleet::resources::ResourceSummary;
use crate::fleet::swarm::SwarmOutcome;

const PREFIX: &str = "[local/offchain]";

pub fn move_tps(moves: u64, elapsed_ms: u128) -> f64 {
    if elapsed_ms == 0 {
        return 0.0;
    }
    (moves as f64) * 1000.0 / (elapsed_ms as f64)
}

fn rate_per_sec(count: u64, elapsed_ms: u128) -> f64 {
    if elapsed_ms == 0 {
        return 0.0;
    }
    (count as f64) * 1000.0 / (elapsed_ms as f64)
}

fn mb(bytes: f64) -> u64 {
    (bytes / 1_048_576.0).round() as u64
}

pub fn format_resources(r: &ResourceSummary) -> String {
    format!(
        "cpu avg={:.1} cores ({:.0}%) peak={:.1} cores ({:.0}%), rss avg={}MB peak={}MB, samples={}",
        r.cpu_cores_avg,
        r.cpu_pct_avg,
        r.cpu_cores_peak,
        r.cpu_pct_peak,
        mb(r.rss_avg_bytes),
        mb(r.rss_peak_bytes as f64),
        r.samples,
    )
}

pub fn render(
    opts: &BenchOpts,
    simple: &SwarmOutcome,
    optimized: Option<&SwarmOutcome>,
    res: &ResourceSummary,
) -> String {
    let secs = simple.elapsed_ms as f64 / 1000.0;
    let tps = move_tps(simple.moves, simple.elapsed_ms);
    let tps_line = match optimized {
        Some(o) => format!(
            "{PREFIX} aggregate move-TPS: {:.1}   (optimized: {:.1})",
            tps,
            move_tps(o.moves, o.elapsed_ms)
        ),
        None => format!("{PREFIX} aggregate move-TPS: {:.1}", tps),
    };
    format!(
        "{PREFIX} fleet: workers={}\n\
         {PREFIX} swarm: {} moves over {} matches in {:.1}s\n\
         {PREFIX} tunnels settled: {} ({:.1}/s)\n\
         {tps_line}\n\
         {PREFIX} resources: {}\n",
        opts.workers,
        simple.moves,
        simple.matches_claimed,
        secs,
        simple.tunnels_settled,
        rate_per_sec(simple.tunnels_settled, simple.elapsed_ms),
        format_resources(res),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{BenchOpts, Runner};
    use crate::fleet::resources::ResourceSummary;
    use crate::fleet::swarm::SwarmOutcome;

    fn opts(workers: usize, runner: Runner) -> BenchOpts {
        BenchOpts {
            workers,
            duration_secs: 15,
            matches: None,
            runner,
        }
    }

    fn outcome(moves: u64, matches: u64, ms: u128) -> SwarmOutcome {
        SwarmOutcome {
            moves,
            bytes: 75982 * matches,
            tunnels_settled: matches,
            matches_claimed: matches,
            elapsed_ms: ms,
        }
    }

    fn res() -> ResourceSummary {
        ResourceSummary {
            cpu_cores_avg: 11.2,
            cpu_cores_peak: 12.0,
            cpu_pct_avg: 93.0,
            cpu_pct_peak: 100.0,
            rss_avg_bytes: 58.0 * 1_048_576.0,
            rss_peak_bytes: 63 * 1_048_576,
            samples: 30,
        }
    }

    #[allow(non_snake_case)]
    #[test]
    fn move_tps_matches_ratePerSec() {
        assert_eq!(move_tps(481234, 15000), 32082.266666666666);
    }

    #[test]
    fn format_resources_matches_loadbench_shape() {
        assert_eq!(
            format_resources(&res()),
            "cpu avg=11.2 cores (93%) peak=12.0 cores (100%), rss avg=58MB peak=63MB, samples=30"
        );
    }

    #[test]
    fn render_single_runner_has_no_parenthetical() {
        let s = render(
            &opts(12, Runner::Simple),
            &outcome(481234, 3366, 15000),
            None,
            &res(),
        );
        assert!(s.contains("[local/offchain] fleet: workers=12\n"));
        assert!(s.contains("[local/offchain] swarm: 481234 moves over 3366 matches in 15.0s\n"));
        assert!(s.contains("[local/offchain] tunnels settled: 3366 (224.4/s)\n"));
        assert!(s.contains("[local/offchain] aggregate move-TPS: 32082.3\n"));
        assert!(!s.contains("optimized:"));
        assert!(s.contains("[local/offchain] resources: cpu avg=11.2 cores"));
    }

    #[test]
    fn render_both_appends_optimized_tps() {
        let opt = outcome(616000, 4308, 15000); // ~41066.7 TPS
        let s = render(
            &opts(12, Runner::Both),
            &outcome(481234, 3366, 15000),
            Some(&opt),
            &res(),
        );
        assert!(s.contains("aggregate move-TPS: 32082.3   (optimized: 41066.7)\n"));
    }
}
