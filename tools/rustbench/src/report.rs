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

    let setup_overhead_pct = if simple.total_ns_total == 0 {
        0.0
    } else {
        let overhead = simple.total_ns_total.saturating_sub(simple.play_ns_total) as f64;
        overhead / simple.total_ns_total as f64 * 100.0
    };

    // Scale wall TPS up by (total / play) to isolate match play from setup overhead.
    // If no timing data was collected, return wall TPS unscaled.
    let play_only_tps = if simple.play_ns_total == 0 {
        tps
    } else {
        tps * (simple.total_ns_total as f64 / simple.play_ns_total as f64)
    };

    format!(
        "{PREFIX} fleet: workers={}\n\
         {PREFIX} swarm: {} moves over {} matches in {:.1}s\n\
         {PREFIX} tunnels settled: {} ({:.1}/s)\n\
         {PREFIX} tunnels opened: {}\n\
         {PREFIX} matches conducted: {}\n\
         {PREFIX} moves/match: avg={:.1} p50={:.1} p90={:.1} p99={:.1} peak={:.1}\n\
         {PREFIX} setup overhead: {:.1}%\n\
         {tps_line}\n\
         {PREFIX} play-only move-TPS: {:.1}\n\
         {PREFIX} play-loop µs: avg={:.1} p50={:.1} p99={:.1}\n\
         {PREFIX} resources: {}, threads={}, util_p50={:.1}%, util_p99={:.1}%, basis={}\n",
        opts.workers,
        simple.moves,
        simple.matches_claimed,
        secs,
        simple.tunnels_settled,
        rate_per_sec(simple.tunnels_settled, simple.elapsed_ms),
        simple.tunnels_opened,
        simple.matches_claimed,
        simple.moves_dist.avg,
        simple.moves_dist.p50,
        simple.moves_dist.p90,
        simple.moves_dist.p99,
        simple.moves_dist.peak,
        setup_overhead_pct,
        play_only_tps,
        simple.play_ns_dist.avg / 1_000.0,
        simple.play_ns_dist.p50 / 1_000.0,
        simple.play_ns_dist.p99 / 1_000.0,
        format_resources(res),
        res.threads,
        res.cpu_util_p50_pct,
        res.cpu_util_p99_pct,
        res.basis,
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
            fresh_keys: true,
            card_mode: crate::fleet::swarm::CardMode::Deterministic,
        }
    }

    fn outcome(moves: u64, matches: u64, ms: u128) -> SwarmOutcome {
        SwarmOutcome {
            moves,
            bytes: 75982 * matches,
            tunnels_settled: matches,
            tunnels_opened: matches,
            matches_claimed: matches,
            elapsed_ms: ms,
            play_ns_total: 0,
            total_ns_total: 0,
            moves_dist: crate::fleet::stats::Distribution::default(),
            play_ns_dist: crate::fleet::stats::Distribution::default(),
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
            ..Default::default()
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

    #[test]
    fn render_golden_new_metrics() {
        use crate::fleet::stats::summarize;
        let o = SwarmOutcome {
            moves: 429,
            bytes: 75982 * 3,
            tunnels_settled: 3,
            tunnels_opened: 3,
            matches_claimed: 3,
            elapsed_ms: 1000,
            // 800ms of play time, 1000ms total (20% setup overhead)
            play_ns_total: 800_000_000,
            total_ns_total: 1_000_000_000,
            moves_dist: summarize(&[143.0, 143.0, 143.0]),
            play_ns_dist: summarize(&[266_000_000.0, 267_000_000.0, 267_000_000.0]),
        };
        let s = render(&opts(1, Runner::Simple), &o, None, &res());
        assert!(
            s.contains("[local/offchain] tunnels opened: 3"),
            "got:\n{s}"
        );
        assert!(
            s.contains("[local/offchain] matches conducted: 3"),
            "got:\n{s}"
        );
        // deterministic mode: all matches are 143 moves
        assert!(
            s.contains("[local/offchain] moves/match: avg=143.0 p50=143.0"),
            "got:\n{s}"
        );
        // (1e9 - 8e8) / 1e9 * 100 = 20.0%
        assert!(
            s.contains("[local/offchain] setup overhead: 20.0%"),
            "got:\n{s}"
        );
        // play-only TPS = 429.0 * (1e9 / 8e8) = 429.0 * 1.25 = 536.25
        assert!(
            s.contains("[local/offchain] play-only move-TPS: 536."),
            "got:\n{s}"
        );
        // avg play-loop: (266e6 + 267e6 + 267e6) / 3 / 1000 ≈ 266666.7 µs
        assert!(
            s.contains("[local/offchain] play-loop µs: avg=266666."),
            "got:\n{s}"
        );
    }
}
