//! Console report, format-parity with the loadbench swarm output. Pure string
//! building — the binary prints the result.

use crate::cli::{AnchorMode, BenchOpts, TranscriptRecorderMode};
use crate::humanize;
use crate::resources::ResourceSummary;
use crate::swarm::SwarmOutcome;
use tunnel_telemetry::{Distribution, StageId};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RenderStyle {
    Plain,
    Color,
}

impl RenderStyle {
    fn title(self, text: impl AsRef<str>) -> String {
        self.paint("1;36", text)
    }

    fn section(self, text: impl AsRef<str>) -> String {
        self.paint("1", text)
    }

    fn secondary(self, text: impl AsRef<str>) -> String {
        self.paint("2", text)
    }

    fn paint(self, code: &str, text: impl AsRef<str>) -> String {
        match self {
            RenderStyle::Plain => text.as_ref().to_string(),
            RenderStyle::Color => format!("\u{1b}[{code}m{}\u{1b}[0m", text.as_ref()),
        }
    }
}

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

fn run_label(anchor_mode: AnchorMode) -> &'static str {
    match anchor_mode {
        AnchorMode::Memory => "local/memory",
        AnchorMode::SuiSponsored => "local/sui-sponsored",
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

/// Share of end-to-end time spent outside the move loop — anchor open + settle
/// (and, on Sui, chain round-trips) — as a percent of total e2e. `total_ns_total`
/// is summed full-tunnel e2e; `play_ns_total` is summed move-loop time. 0 when no
/// timing was collected.
///
/// Note: both spans are wall-clock, so under `--tunnel-concurrency auto`
/// oversubscription some scheduler-queue time leaks into this figure; the direct
/// `anchor open`/`anchor settle` latency rows are the precise open/settle cost.
pub fn setup_overhead_pct(o: &SwarmOutcome) -> f64 {
    if o.total_ns_total == 0 {
        return 0.0;
    }
    let overhead = o.total_ns_total.saturating_sub(o.play_ns_total) as f64;
    overhead / o.total_ns_total as f64 * 100.0
}

/// Move throughput during the lifecycle's move-production window; falls back to
/// the wall window for legacy callers that have not populated the lifecycle
/// window yet.
pub fn play_only_tps(o: &SwarmOutcome) -> f64 {
    if o.move_window_elapsed_ms == 0 {
        move_tps(o.moves, o.elapsed_ms)
    } else {
        move_tps(o.moves, o.move_window_elapsed_ms)
    }
}

fn stage_latency_line(label: &str, d: Distribution) -> Option<String> {
    if d.count == 0 {
        return None;
    }
    Some(format!(
        "  - {label}: p50={} p90={} avg={} peak={}",
        humanize::dur_ns(d.p50),
        humanize::dur_ns(d.p90),
        humanize::dur_ns(d.avg),
        humanize::dur_ns(d.peak),
    ))
}

fn tps_distribution_line(label: &str, d: &Distribution) -> Option<String> {
    if d.count == 0 {
        return None;
    }
    Some(format!(
        "  - {label}: p50={:.1} p90={:.1} avg={:.1} peak={:.1}",
        d.p50, d.p90, d.avg, d.peak,
    ))
}

fn ptb_batch_line(label: &str, count: u64, d: &Distribution) -> Option<String> {
    if count == 0 {
        return None;
    }
    Some(format!(
        "  - {label}: ptbs={} batch-size p50={:.1} p90={:.1} avg={:.1} peak={:.1}",
        humanize::count(count),
        d.p50,
        d.p90,
        d.avg,
        d.peak,
    ))
}

fn tx_digest_line(label: &str, tx_digests: &[String]) -> Option<String> {
    if tx_digests.is_empty() {
        return None;
    }
    Some(format!("  - {label} txDigests={}", tx_digests.join(", ")))
}

/// Headline metrics for one protocol's bench run, collected across a
/// multi-protocol invocation to build the comparison summary.
#[derive(Clone, Debug)]
pub struct ProtocolRunSummary {
    pub protocol_id: &'static str,
    pub headline_tps: f64,
    pub play_only_tps: f64,
    pub tunnels: u64,
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
            tunnels: simple.tunnels_claimed,
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
    render_summary_with_style(opts, rows, RenderStyle::Plain)
}

pub fn render_summary_with_style(
    opts: &BenchOpts,
    rows: &[ProtocolRunSummary],
    style: RenderStyle,
) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "{}\n{}\n\n",
        style.section(format!("Summary: {} protocols", rows.len())),
        style.secondary(format!(
            "  codec={}  workers={}",
            frame_codec_id(opts.frame_codec),
            opts.workers,
        )),
    ));

    out.push_str(&format!(
        "  - {:<id_width$}  {:>12}  {:>12}  {:>9}  {:>9}  {:>9}\n",
        "protocol-id",
        "move-TPS",
        "play-TPS",
        "tunnels",
        "settled",
        "setup%",
        id_width = rows
            .iter()
            .map(|r| r.protocol_id.len())
            .max()
            .unwrap_or(0)
            .max("protocol-id".len()),
    ));

    let id_width = rows
        .iter()
        .map(|r| r.protocol_id.len())
        .max()
        .unwrap_or(0)
        .max("protocol-id".len());

    for r in rows {
        let row = format!(
            "  - {:<id_width$}  {:>12.1}  {:>12.1}  {:>9}  {:>9}  {:>8.1}%",
            r.protocol_id,
            r.headline_tps,
            r.play_only_tps,
            humanize::count(r.tunnels),
            humanize::count(r.tunnels_settled),
            r.setup_overhead_pct,
        );
        out.push_str(&row);
        out.push('\n');
    }

    let total_tunnels: u64 = rows.iter().map(|r| r.tunnels).sum();
    let total_moves: u64 = rows.iter().map(|r| r.moves).sum();
    let total_settled: u64 = rows.iter().map(|r| r.tunnels_settled).sum();
    let total_ms: u128 = rows.iter().map(|r| r.elapsed_ms).sum();
    out.push_str(&format!(
        "  - aggregate: {} moves over {} tunnels, {} tunnels settled, {:.1}s wall\n",
        humanize::count(total_moves),
        humanize::count(total_tunnels),
        humanize::count(total_settled),
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
    render_with_style(opts, protocol_id, simple, res, RenderStyle::Plain)
}

pub fn render_with_style(
    opts: &BenchOpts,
    protocol_id: &str,
    simple: &SwarmOutcome,
    res: &ResourceSummary,
    style: RenderStyle,
) -> String {
    let secs = simple.elapsed_ms as f64 / 1000.0;
    let mut out = format!(
        "{}\n{}\n\n{}\n  - moves              {}\n  - tunnels            {}\n  - wall move-TPS      {:.1}\n  - play-only move-TPS {:.1}\n\n{}\n  - opened={}  closed={}  failed={}  aborted={}  open-rate={:.1}/s  close-rate={:.1}/s\n  - moves/tunnel p50={:.1} p90={:.1} avg={:.1} peak={:.1}\n",
        style.title(format!(
            "{} fleet-bench {protocol_id}",
            run_label(opts.anchor_mode)
        )),
        style.secondary(format!(
            "  codec={}  concurrency={}  workers={}  elapsed={:.1}s",
            frame_codec_id(opts.frame_codec),
            opts.tunnel_concurrency.label(),
            opts.workers,
            secs,
        )),
        style.section("Throughput"),
        humanize::count(simple.moves),
        humanize::count(simple.tunnels_claimed),
        move_tps(simple.moves, simple.elapsed_ms),
        play_only_tps(simple),
        style.section("Tunnels"),
        humanize::count(simple.tunnels_opened),
        humanize::count(simple.tunnels_settled),
        humanize::count(simple.tunnels_failed),
        humanize::count(simple.tunnels_aborted),
        rate_per_sec(simple.tunnels_opened, simple.open_active_elapsed_ms),
        rate_per_sec(simple.tunnels_settled, simple.settle_active_elapsed_ms),
        simple.moves_dist.p50,
        simple.moves_dist.p90,
        simple.moves_dist.avg,
        simple.moves_dist.peak,
    );

    if let Some(line) =
        tps_distribution_line("per-tunnel lane move-TPS", &simple.per_tunnel_tps_play)
    {
        out.push_str(&line);
        out.push('\n');
    }
    if let Some(line) = tps_distribution_line("per-tunnel lane e2e-TPS", &simple.per_tunnel_tps_e2e)
    {
        out.push_str(&line);
        out.push('\n');
    }

    out.push_str(&format!(
        "\n{}\n  - setup overhead {:.1}%\n  - play-loop p50={} p90={} avg={} peak={}\n",
        style.section("Latency"),
        setup_overhead_pct(simple),
        humanize::dur_ns(simple.play_ns_dist.p50),
        humanize::dur_ns(simple.play_ns_dist.p90),
        humanize::dur_ns(simple.play_ns_dist.avg),
        humanize::dur_ns(simple.play_ns_dist.peak),
    ));

    // Anchor open/settle are per-tunnel headline latencies — always shown.
    for (label, stage) in [
        ("anchor open", StageId::Open),
        ("anchor settle", StageId::Settle),
    ] {
        if let Some(line) = stage_latency_line(label, simple.telemetry.stage(stage)) {
            out.push_str(&line);
            out.push('\n');
        }
    }
    // Per-frame transport latency is the per-move breakdown — behind
    // `--per-move-latency`, which otherwise has no observable effect.
    if opts.per_move_latency {
        for (label, stage) in [
            ("transport send", StageId::FrameSend),
            ("transport recv", StageId::FrameRecv),
        ] {
            if let Some(line) = stage_latency_line(label, simple.telemetry.stage(stage)) {
                out.push_str(&line);
                out.push('\n');
            }
        }
    }
    if simple.sui_ptb_metrics.open_count > 0 || simple.sui_ptb_metrics.settle_count > 0 {
        out.push_str(&format!("\n{}\n", style.section("Sui PTBs")));
        if let Some(line) = ptb_batch_line(
            "open",
            simple.sui_ptb_metrics.open_count,
            &simple.sui_ptb_metrics.open_batch_size,
        ) {
            out.push_str(&line);
            out.push('\n');
        }
        if let Some(line) = tx_digest_line("open", &simple.sui_ptb_metrics.open_tx_digests) {
            out.push_str(&line);
            out.push('\n');
        }
        if let Some(line) = ptb_batch_line(
            "settle",
            simple.sui_ptb_metrics.settle_count,
            &simple.sui_ptb_metrics.settle_batch_size,
        ) {
            out.push_str(&line);
            out.push('\n');
        }
        if let Some(line) = tx_digest_line("settle", &simple.sui_ptb_metrics.settle_tx_digests) {
            out.push_str(&line);
            out.push('\n');
        }
    }
    if simple.gas_funder_mist > 0 || simple.gas_sponsor_mist > 0 {
        out.push_str(&format!(
            "\n{}\n  - gas funder={:.6} SUI sponsor={:.6} SUI\n",
            style.section("Spend"),
            simple.gas_funder_mist as f64 / 1_000_000_000.0,
            simple.gas_sponsor_mist as f64 / 1_000_000_000.0,
        ));
    }
    let export_stage = simple.telemetry.stage(StageId::RecorderExport);
    if export_stage.count > 0 || simple.transcript_export_bytes > 0 {
        out.push_str(&format!(
            "\n{}\n  - exported bytes={}\n",
            style.section("Transcript"),
            humanize::bytes(simple.transcript_export_bytes),
        ));
        if let Some(line) = stage_latency_line("export latency", export_stage) {
            out.push_str(&line);
            out.push('\n');
        }
    }
    // Recorder-record latency: per-move detail, shown only when a real recorder
    // runs — i.e. `--transcript-recorder memory` (or a root-settling anchor,
    // which forces it). With the no-op recorder these samples time an empty call,
    // so gating on the flag avoids printing misleading near-zero timings.
    let recorder_stage = simple.telemetry.stage(StageId::RecorderRecord);
    if recorder_stage.count > 0
        && opts.per_move_latency
        && opts.transcript_recorder == TranscriptRecorderMode::Memory
    {
        out.push_str(&format!(
            "  - recorder record p50={} p90={} avg={} peak={}\n",
            humanize::dur_ns(recorder_stage.p50),
            humanize::dur_ns(recorder_stage.p90),
            humanize::dur_ns(recorder_stage.avg),
            humanize::dur_ns(recorder_stage.peak),
        ));
    }

    out.push_str(&format!(
        "\n{}\n  - {}, threads={}, util_p50={:.1}%, util_p99={:.1}%, basis={}\n",
        style.section("Resources"),
        format_resources(res),
        res.threads,
        res.cpu_util_p50_pct,
        res.cpu_util_p99_pct,
        res.basis,
    ));

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{
        AnchorMode, BenchOpts, ColorMode, ConcurrencyMode, SignerInitMode, TranscriptRecorderMode,
    };
    use crate::resources::ResourceSummary;
    use crate::swarm::SwarmOutcome;

    fn opts(workers: usize, signer_init_mode: SignerInitMode) -> BenchOpts {
        BenchOpts {
            workers,
            duration_secs: 15,
            moves: None,
            initial_balance: crate::protocols::DEFAULT_BALANCE,
            tunnel_concurrency: ConcurrencyMode::Fixed(64),
            per_move_latency: false,
            trace: false,
            signer_init_mode,
            protocol_ids: vec![tunnel_core::protocol_id::BLACKJACK_BET_V1],
            scenario: crate::cli::ScenarioMode::Golden,
            frame_codec: crate::cli::FrameCodecKind::Json,
            anchor_mode: AnchorMode::Memory,
            color_mode: ColorMode::Never,
            transcript_recorder: TranscriptRecorderMode::None,
            sui_anchor: None,
        }
    }

    fn opts_with_anchor(anchor_mode: AnchorMode) -> BenchOpts {
        BenchOpts {
            anchor_mode,
            ..opts(4, SignerInitMode::PerTunnel)
        }
    }

    fn outcome(moves: u64, tunnels: u64, ms: u128) -> SwarmOutcome {
        SwarmOutcome {
            moves,
            bytes: 75982 * tunnels,
            tunnels_settled: tunnels,
            tunnels_opened: tunnels,
            tunnels_claimed: tunnels,
            elapsed_ms: ms,
            move_window_elapsed_ms: ms,
            open_active_elapsed_ms: ms,
            settle_active_elapsed_ms: ms,
            play_ns_total: 0,
            total_ns_total: 0,
            moves_dist: crate::stats::Distribution::default(),
            play_ns_dist: crate::stats::Distribution::default(),
            tunnels_failed: 0,
            tunnels_aborted: 0,
            per_tunnel_tps_play: crate::stats::Distribution::default(),
            per_tunnel_tps_e2e: crate::stats::Distribution::default(),
            telemetry: tunnel_telemetry::RunTelemetry::default(),
            gas_funder_mist: 0,
            gas_sponsor_mist: 0,
            transcript_export_bytes: 0,
            sui_ptb_metrics: crate::swarm::SuiPtbMetrics::default(),
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
            &opts(12, SignerInitMode::PerTunnel),
            "blackjack.bet.v1",
            &outcome(481234, 3366, 15000),
            &res(),
        );
        assert!(s.contains("local/memory fleet-bench blackjack.bet.v1\n"));
        assert!(
            s.contains("  codec=json.distributed.v1  concurrency=64  workers=12  elapsed=15.0s\n")
        );
        assert!(s.contains("Throughput\n"));
        assert!(s.contains("  - moves              481,234\n"));
        assert!(s.contains("  - tunnels            3,366\n"));
        assert!(s.contains("  - wall move-TPS      32082.3\n"));
        assert!(s.contains("  - cpu avg=11.2 cores"));
    }

    #[test]
    fn render_title_identifies_sui_sponsored_anchor() {
        let s = render(
            &opts_with_anchor(AnchorMode::SuiSponsored),
            "blackjack.v2",
            &outcome(2000, 20, 3000),
            &res(),
        );

        assert!(s.contains("local/sui-sponsored fleet-bench blackjack.v2"));
    }

    #[test]
    fn render_emits_sui_ptb_metrics() {
        let mut o = outcome(2000, 20, 3000);
        o.sui_ptb_metrics = crate::swarm::SuiPtbMetrics {
            open_count: 2,
            settle_count: 1,
            open_batch_size: crate::stats::summarize(&[2.0, 4.0]),
            settle_batch_size: crate::stats::summarize(&[3.0]),
            open_tx_digests: vec!["openA".into(), "openB".into()],
            settle_tx_digests: vec!["settleA".into()],
        };

        let s = render(
            &opts_with_anchor(AnchorMode::SuiSponsored),
            "blackjack.v2",
            &o,
            &res(),
        );

        assert!(s.contains("Sui PTBs"), "got:\n{s}");
        assert!(s.contains("open: ptbs=2 batch-size"), "got:\n{s}");
        assert!(s.contains("settle: ptbs=1 batch-size"), "got:\n{s}");
        assert!(s.contains("open txDigests=openA, openB"), "got:\n{s}");
        assert!(s.contains("settle txDigests=settleA"), "got:\n{s}");
    }

    #[test]
    fn render_golden_new_metrics() {
        use crate::stats::summarize;
        let o = SwarmOutcome {
            moves: 429,
            bytes: 75982 * 3,
            tunnels_settled: 3,
            tunnels_opened: 3,
            tunnels_claimed: 3,
            elapsed_ms: 1000,
            move_window_elapsed_ms: 1000,
            open_active_elapsed_ms: 1000,
            settle_active_elapsed_ms: 1000,
            // 800ms of play time, 1000ms total (20% setup overhead)
            play_ns_total: 800_000_000,
            total_ns_total: 1_000_000_000,
            moves_dist: summarize(&[143.0, 143.0, 143.0]),
            play_ns_dist: summarize(&[266_000_000.0, 267_000_000.0, 267_000_000.0]),
            tunnels_failed: 0,
            tunnels_aborted: 0,
            per_tunnel_tps_play: crate::stats::Distribution::default(),
            per_tunnel_tps_e2e: crate::stats::Distribution::default(),
            telemetry: tunnel_telemetry::RunTelemetry::default(),
            gas_funder_mist: 0,
            gas_sponsor_mist: 0,
            transcript_export_bytes: 0,
            sui_ptb_metrics: crate::swarm::SuiPtbMetrics::default(),
        };
        let s = render(
            &opts(1, SignerInitMode::PerTunnel),
            "blackjack.bet.v1",
            &o,
            &res(),
        );
        assert!(
            s.contains(
                "  - opened=3  closed=3  failed=0  aborted=0  open-rate=3.0/s  close-rate=3.0/s"
            ),
            "got:\n{s}"
        );
        assert!(s.contains("  - tunnels            3"), "got:\n{s}");
        // golden scenario: all tunnels are 143 moves
        assert!(
            s.contains("  - moves/tunnel p50=143.0 p90=143.0 avg=143.0 peak=143.0"),
            "got:\n{s}"
        );
        // (1e9 - 8e8) / 1e9 * 100 = 20.0%
        assert!(s.contains("  - setup overhead 20.0%"), "got:\n{s}");
        assert!(s.contains("  - play-only move-TPS 429.0"), "got:\n{s}");
        assert!(
            s.contains("  - play-loop p50=267.0ms p90=267.0ms avg=266.7ms peak=267.0ms"),
            "got:\n{s}"
        );
        assert!(
            s.contains("local/memory fleet-bench blackjack.bet.v1"),
            "got:\n{s}"
        );
        assert!(s.contains("codec=json.distributed.v1"), "got:\n{s}");
    }

    #[test]
    fn render_rates_use_lifecycle_active_windows() {
        let mut o = outcome(100, 10, 10_000);
        o.tunnels_opened = 4;
        o.tunnels_settled = 10;
        o.open_active_elapsed_ms = 2_000;
        o.settle_active_elapsed_ms = 5_000;

        let s = render(
            &opts(1, SignerInitMode::PerTunnel),
            "blackjack.bet.v1",
            &o,
            &res(),
        );

        assert!(
            s.contains(
                "  - opened=4  closed=10  failed=0  aborted=0  open-rate=2.0/s  close-rate=2.0/s"
            ),
            "got:\n{s}"
        );
    }

    #[test]
    fn play_only_tps_uses_move_window_elapsed() {
        let mut o = outcome(100, 1, 10_000);
        o.move_window_elapsed_ms = 2_000;
        o.play_ns_total = 1_000_000_000;
        o.total_ns_total = 10_000_000_000;

        assert_eq!(play_only_tps(&o), 50.0);
    }

    #[test]
    fn render_omits_anchor_rows_when_no_samples_and_humanizes_counts() {
        use crate::stats::summarize;
        let o = SwarmOutcome {
            moves: 36_465,
            bytes: 12_345_678,
            tunnels_settled: 255,
            tunnels_opened: 255,
            tunnels_claimed: 255,
            elapsed_ms: 8_400,
            move_window_elapsed_ms: 8_400,
            open_active_elapsed_ms: 8_400,
            settle_active_elapsed_ms: 8_400,
            play_ns_total: 8_000_000_000,
            total_ns_total: 8_100_000_000,
            moves_dist: summarize(&[143.0, 143.0]),
            play_ns_dist: summarize(&[31_000_000.0, 32_000_000.0]),
            tunnels_failed: 0,
            tunnels_aborted: 0,
            per_tunnel_tps_play: summarize(&[4_500.0, 4_700.0]),
            per_tunnel_tps_e2e: summarize(&[4_400.0, 4_600.0]),
            telemetry: tunnel_telemetry::RunTelemetry::default(),
            gas_funder_mist: 0,
            gas_sponsor_mist: 0,
            transcript_export_bytes: 0,
            sui_ptb_metrics: crate::swarm::SuiPtbMetrics::default(),
        };
        let s = render(
            &opts(10, SignerInitMode::PerTunnel),
            "blackjack.bet.v1",
            &o,
            &res(),
        );

        assert!(s.contains("moves              36,465"), "got:\n{s}");
        assert!(!s.contains("anchor open"), "got:\n{s}");
        assert!(
            s.contains("per-tunnel lane move-TPS: p50=4500.0 p90=4700.0 avg=4600.0 peak=4700.0"),
            "got:\n{s}"
        );
    }

    #[test]
    fn render_emits_optional_anchor_transport_and_transcript_metrics() {
        use tunnel_telemetry::{CollectingSink, StageCost, StageId, StageSample, TelemetrySink};

        let mut sink = CollectingSink::with_capacity(8);
        for (stage, dur_ns, bytes) in [
            (StageId::Open, 1_000_000, 0),
            (StageId::Settle, 2_000_000, 0),
            (StageId::FrameSend, 3_000, 12),
            (StageId::FrameRecv, 4_000, 34),
            (StageId::RecorderExport, 5_000, 49_408),
        ] {
            sink.record(StageSample {
                stage,
                dur_ns,
                cost: StageCost {
                    gas_mist: 0,
                    paid_by: None,
                    bytes,
                },
            });
        }

        let mut o = outcome(143, 1, 1000);
        o.telemetry = tunnel_telemetry::RunTelemetry::from_sinks(vec![sink]);
        o.transcript_export_bytes = 49_408;

        // Per-frame transport rows are behind --per-move-latency.
        let mut bench_opts = opts(1, SignerInitMode::PerTunnel);
        bench_opts.per_move_latency = true;
        let s = render(&bench_opts, "blackjack.bet.v1", &o, &res());

        assert!(
            s.contains("  - anchor open: p50=1.0ms p90=1.0ms avg=1.0ms peak=1.0ms"),
            "got:\n{s}"
        );
        assert!(
            s.contains("  - anchor settle: p50=2.0ms p90=2.0ms avg=2.0ms peak=2.0ms"),
            "got:\n{s}"
        );
        assert!(
            s.contains("  - transport send: p50=3.0us p90=3.0us avg=3.0us peak=3.0us"),
            "got:\n{s}"
        );
        assert!(
            s.contains("  - transport recv: p50=4.0us p90=4.0us avg=4.0us peak=4.0us"),
            "got:\n{s}"
        );
        assert!(s.contains("Transcript"), "got:\n{s}");
        assert!(s.contains("  - exported bytes=48.2KB"), "got:\n{s}");
        assert!(
            s.contains("  - export latency: p50=5.0us p90=5.0us avg=5.0us peak=5.0us"),
            "got:\n{s}"
        );
    }

    #[test]
    fn per_move_latency_flag_gates_the_transport_breakdown() {
        use tunnel_telemetry::{CollectingSink, StageCost, StageId, StageSample, TelemetrySink};

        let mut sink = CollectingSink::with_capacity(2);
        sink.record(StageSample {
            stage: StageId::FrameSend,
            dur_ns: 3_000,
            cost: StageCost {
                gas_mist: 0,
                paid_by: None,
                bytes: 12,
            },
        });
        let mut o = outcome(143, 1, 1000);
        o.telemetry = tunnel_telemetry::RunTelemetry::from_sinks(vec![sink]);

        let mut off = opts(1, SignerInitMode::PerTunnel);
        off.per_move_latency = false;
        assert!(
            !render(&off, "x", &o, &res()).contains("transport send"),
            "transport rows must be hidden without --per-move-latency"
        );

        let mut on = opts(1, SignerInitMode::PerTunnel);
        on.per_move_latency = true;
        assert!(
            render(&on, "x", &o, &res()).contains("transport send"),
            "--per-move-latency must surface the transport breakdown"
        );
    }

    #[test]
    fn summary_table_lists_each_protocol_and_aggregate() {
        let rows = vec![
            ProtocolRunSummary::from_run("caro.v1", &outcome(1000, 10, 2000)),
            ProtocolRunSummary::from_run("blackjack.v2", &outcome(2000, 20, 3000)),
        ];
        let s = render_summary(&opts(8, SignerInitMode::PerTunnel), &rows);
        assert!(s.contains("Summary: 2 protocols"), "got:\n{s}");
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
            s.contains("- aggregate: 3,000 moves over 30 tunnels, 30 tunnels settled, 5.0s wall"),
            "got:\n{s}"
        );
    }

    #[test]
    fn render_with_color_emits_ansi_for_title_and_sections() {
        let s = render_with_style(
            &opts(12, SignerInitMode::PerTunnel),
            "blackjack.bet.v1",
            &outcome(481234, 3366, 15000),
            &res(),
            RenderStyle::Color,
        );

        assert!(s.contains("\u{1b}[1;36mlocal/memory fleet-bench blackjack.bet.v1\u{1b}[0m"));
        assert!(s.contains("\u{1b}[1mThroughput\u{1b}[0m"));
        assert!(s.contains("  - moves              481,234"));
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
