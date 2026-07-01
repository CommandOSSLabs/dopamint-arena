//! Console report, format-parity with the loadbench swarm output. Pure string
//! building — the binary prints the result.

use crate::cli::BenchOpts;
use crate::resources::ResourceSummary;
use crate::swarm::SwarmOutcome;

const PREFIX: &str = "[local/memory]";

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

pub fn frame_codec_id(codec: crate::cli::FrameCodecKind) -> &'static str {
    use crate::cli::FrameCodecKind;
    match codec {
        FrameCodecKind::Json => "json.distributed.v1",
        FrameCodecKind::Bcs => "bcs.v1",
        FrameCodecKind::Postcard => "postcard.v1",
    }
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

/// Share of wall time spent on per-match setup rather than play; 0 when no
/// timing was collected.
pub fn setup_overhead_pct(o: &SwarmOutcome) -> f64 {
    if o.total_ns_total == 0 {
        return 0.0;
    }
    let overhead = o.total_ns_total.saturating_sub(o.play_ns_total) as f64;
    overhead / o.total_ns_total as f64 * 100.0
}

/// Wall move-TPS scaled up by (total / play) to isolate match play from setup
/// overhead; falls back to wall TPS when no timing was collected.
pub fn play_only_tps(o: &SwarmOutcome) -> f64 {
    let tps = move_tps(o.moves, o.elapsed_ms);
    if o.play_ns_total == 0 {
        tps
    } else {
        tps * (o.total_ns_total as f64 / o.play_ns_total as f64)
    }
}

/// Headline metrics for one protocol's bench run, collected across a
/// multi-protocol invocation to build the comparison summary.
#[derive(Clone, Debug)]
pub struct ProtocolRunSummary {
    pub protocol_id: &'static str,
    pub headline_tps: f64,
    pub play_only_tps: f64,
    pub matches: u64,
    pub tunnels_settled: u64,
    pub moves: u64,
    pub setup_overhead_pct: f64,
    pub elapsed_ms: u128,
}

impl ProtocolRunSummary {
    /// Derives the summary row from a protocol's headline window.
    pub fn from_run(protocol_id: &'static str, simple: &SwarmOutcome) -> Self {
        Self {
            protocol_id,
            headline_tps: move_tps(simple.moves, simple.elapsed_ms),
            play_only_tps: play_only_tps(simple),
            matches: simple.matches_claimed,
            tunnels_settled: simple.tunnels_settled,
            moves: simple.moves,
            setup_overhead_pct: setup_overhead_pct(simple),
            elapsed_ms: simple.elapsed_ms,
        }
    }
}

/// Comparison table + aggregate totals across the protocols that ran. Resources
/// are not aggregated: averaging CPU/RSS across heterogeneous sequential runs
/// isn't meaningful, so they stay in each per-protocol block.
pub fn render_summary(opts: &BenchOpts, rows: &[ProtocolRunSummary]) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "{PREFIX} summary: {} protocols, frame-codec {}, workers {}\n",
        rows.len(),
        frame_codec_id(opts.frame_codec),
        opts.workers,
    ));

    let id_width = rows
        .iter()
        .map(|r| r.protocol_id.len())
        .max()
        .unwrap_or(0)
        .max("protocol-id".len());

    let header = format!(
        "{PREFIX} {:<id_width$}  {:>12}  {:>12}  {:>9}  {:>9}  {:>9}",
        "protocol-id", "move-TPS", "play-TPS", "matches", "settled", "setup%",
    );
    out.push_str(&header);
    out.push('\n');

    for r in rows {
        let row = format!(
            "{PREFIX} {:<id_width$}  {:>12.1}  {:>12.1}  {:>9}  {:>9}  {:>8.1}%",
            r.protocol_id,
            r.headline_tps,
            r.play_only_tps,
            r.matches,
            r.tunnels_settled,
            r.setup_overhead_pct,
        );
        out.push_str(&row);
        out.push('\n');
    }

    let total_matches: u64 = rows.iter().map(|r| r.matches).sum();
    let total_moves: u64 = rows.iter().map(|r| r.moves).sum();
    let total_settled: u64 = rows.iter().map(|r| r.tunnels_settled).sum();
    let total_ms: u128 = rows.iter().map(|r| r.elapsed_ms).sum();
    out.push_str(&format!(
        "{PREFIX} aggregate: {total_moves} moves over {total_matches} matches, \
         {total_settled} tunnels settled, {:.1}s wall\n",
        total_ms as f64 / 1000.0,
    ));

    out
}

pub fn render(
    opts: &BenchOpts,
    protocol_id: &str,
    simple: &SwarmOutcome,
    res: &ResourceSummary,
) -> String {
    let secs = simple.elapsed_ms as f64 / 1000.0;
    let tps = move_tps(simple.moves, simple.elapsed_ms);
    let tps_line = format!("{PREFIX} aggregate move-TPS: {:.1}", tps);

    format!(
        "{PREFIX} fleet: workers={}\n\
         {PREFIX} protocol-id: {}\n\
         {PREFIX} frame-codec: {}\n\
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
        protocol_id,
        frame_codec_id(opts.frame_codec),
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
        setup_overhead_pct(simple),
        play_only_tps(simple),
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
    use crate::cli::{AnchorMode, BenchOpts, SignerInitMode, TranscriptRecorderMode};
    use crate::resources::ResourceSummary;
    use crate::swarm::SwarmOutcome;

    fn opts(workers: usize, signer_init_mode: SignerInitMode) -> BenchOpts {
        BenchOpts {
            workers,
            duration_secs: 15,
            matches: None,
            signer_init_mode,
            protocol_ids: vec![tunnel_core::protocol_id::BLACKJACK_BET_V1],
            scenario: crate::cli::ScenarioMode::Golden,
            frame_codec: crate::cli::FrameCodecKind::Json,
            anchor_mode: AnchorMode::Memory,
            transcript_recorder: TranscriptRecorderMode::None,
            sui_anchor: None,
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
            moves_dist: crate::stats::Distribution::default(),
            play_ns_dist: crate::stats::Distribution::default(),
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
    fn render_emits_headline_metrics() {
        let s = render(
            &opts(12, SignerInitMode::PerMatch),
            "blackjack.bet.v1",
            &outcome(481234, 3366, 15000),
            &res(),
        );
        assert!(s.contains("[local/memory] fleet: workers=12\n"));
        assert!(s.contains("[local/memory] swarm: 481234 moves over 3366 matches in 15.0s\n"));
        assert!(s.contains("[local/memory] tunnels settled: 3366 (224.4/s)\n"));
        assert!(s.contains("[local/memory] aggregate move-TPS: 32082.3\n"));
        assert!(s.contains("[local/memory] resources: cpu avg=11.2 cores"));
    }

    #[test]
    fn render_golden_new_metrics() {
        use crate::stats::summarize;
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
        let s = render(
            &opts(1, SignerInitMode::PerMatch),
            "blackjack.bet.v1",
            &o,
            &res(),
        );
        assert!(s.contains("[local/memory] tunnels opened: 3"), "got:\n{s}");
        assert!(
            s.contains("[local/memory] matches conducted: 3"),
            "got:\n{s}"
        );
        // golden scenario: all matches are 143 moves
        assert!(
            s.contains("[local/memory] moves/match: avg=143.0 p50=143.0"),
            "got:\n{s}"
        );
        // (1e9 - 8e8) / 1e9 * 100 = 20.0%
        assert!(
            s.contains("[local/memory] setup overhead: 20.0%"),
            "got:\n{s}"
        );
        // play-only TPS = 429.0 * (1e9 / 8e8) = 429.0 * 1.25 = 536.25
        assert!(
            s.contains("[local/memory] play-only move-TPS: 536."),
            "got:\n{s}"
        );
        // avg play-loop: (266e6 + 267e6 + 267e6) / 3 / 1000 ≈ 266666.7 µs
        assert!(
            s.contains("[local/memory] play-loop µs: avg=266666."),
            "got:\n{s}"
        );
        assert!(
            s.contains("[local/memory] protocol-id: blackjack.bet.v1"),
            "got:\n{s}"
        );
        assert!(
            s.contains("[local/memory] frame-codec: json.distributed.v1"),
            "got:\n{s}"
        );
    }

    #[test]
    fn summary_table_lists_each_protocol_and_aggregate() {
        let rows = vec![
            ProtocolRunSummary::from_run("caro.v1", &outcome(1000, 10, 2000)),
            ProtocolRunSummary::from_run("blackjack.v2", &outcome(2000, 20, 3000)),
        ];
        let s = render_summary(&opts(8, SignerInitMode::PerMatch), &rows);
        assert!(
            s.contains("[local/memory] summary: 2 protocols"),
            "got:\n{s}"
        );
        assert!(s.contains("caro.v1"), "got:\n{s}");
        assert!(s.contains("blackjack.v2"), "got:\n{s}");
        assert!(!s.contains("preinit-TPS"), "got:\n{s}");

        // Header and every data row must share the same width so columns line up.
        let lines: Vec<&str> = s.lines().collect();
        let header = lines
            .iter()
            .find(|l| l.contains("move-TPS"))
            .expect("header row");
        for id in ["caro.v1", "blackjack.v2"] {
            let row = lines.iter().find(|l| l.contains(id)).expect("data row");
            assert_eq!(
                row.chars().count(),
                header.chars().count(),
                "column widths drifted:\n{header}\n{row}"
            );
        }
        assert!(
            s.contains("aggregate: 3000 moves over 30 matches, 30 tunnels settled, 5.0s wall"),
            "got:\n{s}"
        );
    }

    #[test]
    fn frame_codec_id_matches_codec_impls() {
        use crate::cli::FrameCodecKind;
        use tunnel_harness::{BcsFrameCodec, FrameCodec, JsonFrameCodec, PostcardFrameCodec};

        assert_eq!(
            frame_codec_id(FrameCodecKind::Json),
            FrameCodec::<tunnel_blackjack::BjMove>::id(&JsonFrameCodec)
        );
        assert_eq!(
            frame_codec_id(FrameCodecKind::Bcs),
            FrameCodec::<tunnel_blackjack::BjMove>::id(&BcsFrameCodec)
        );
        assert_eq!(
            frame_codec_id(FrameCodecKind::Postcard),
            FrameCodec::<tunnel_blackjack::BjMove>::id(&PostcardFrameCodec)
        );
    }
}
