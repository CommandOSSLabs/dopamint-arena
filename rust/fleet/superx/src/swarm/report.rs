//! Per-swarm report: a serde-stable JSON record plus a human render. Pure data
//! shaping — the `run-swarm` worker prints the result and the daemon parses the
//! JSON back into a [`SwarmReport`] to aggregate a run.
//!
//! Extends the bench's `JsonReport` shape with the swarm identity (`run_id`,
//! `swarm_index`, `swarm_count`) and the three staged phase windows (`open_ms`,
//! `play_ms`, `settle_ms`) that the staged pipeline measures.

use serde::{Deserialize, Serialize};

use crate::swarm::pipeline::{SwarmOutcome, SwarmParams};
use crate::swarm::protocol::Scenario;
use crate::swarm::resources::ResourceSummary;

/// Wall-clock move throughput: total moves over the full elapsed window
/// (open + play + settle). Returns 0 for a zero-length window rather than a NaN.
pub fn move_tps(moves: u64, elapsed_ms: u128) -> f64 {
    if elapsed_ms == 0 {
        return 0.0;
    }
    (moves as f64) * 1000.0 / (elapsed_ms as f64)
}

fn scenario_label(scenario: Scenario) -> &'static str {
    match scenario {
        Scenario::Golden => "golden",
        Scenario::Varied => "varied",
    }
}

/// JSON-stable record of one swarm run. Serialized by the `run-swarm` worker and
/// deserialized by the daemon to aggregate a run; keep field names stable.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SwarmReport {
    pub run_id: String,
    pub swarm_index: u64,
    pub swarm_count: u64,
    pub protocol_id: String,
    pub scenario: String,
    pub tunnels_opened: u64,
    pub tunnels_settled: u64,
    pub tunnels_failed: u64,
    pub tunnels_aborted: u64,
    pub moves: u64,
    pub bytes: u64,
    pub elapsed_ms: u128,
    pub open_ms: u128,
    pub play_ms: u128,
    pub settle_ms: u128,
    pub wall_move_tps: f64,
    pub cpu_cores_avg: f64,
    pub cpu_util_p50_pct: f64,
    pub rss_peak_bytes: u64,
}

/// Fold a swarm's params, outcome, and resource summary into the JSON record.
pub fn build_report(p: &SwarmParams, o: &SwarmOutcome, res: &ResourceSummary) -> SwarmReport {
    SwarmReport {
        run_id: p.run_id.clone(),
        swarm_index: p.swarm_index,
        swarm_count: p.swarm_count,
        protocol_id: p.protocol.id().to_string(),
        scenario: scenario_label(p.scenario).to_string(),
        tunnels_opened: o.tunnels_opened,
        tunnels_settled: o.tunnels_settled,
        tunnels_failed: o.tunnels_failed,
        tunnels_aborted: o.tunnels_aborted,
        moves: o.moves,
        bytes: o.bytes,
        elapsed_ms: o.elapsed_ms,
        open_ms: o.open_ms,
        play_ms: o.play_ms,
        settle_ms: o.settle_ms,
        wall_move_tps: move_tps(o.moves, o.elapsed_ms),
        cpu_cores_avg: res.cpu_cores_avg,
        cpu_util_p50_pct: res.cpu_util_p50_pct,
        rss_peak_bytes: res.rss_peak_bytes,
    }
}

/// Human-readable one-swarm summary for the terminal (no `--json`).
pub fn render_human(r: &SwarmReport) -> String {
    format!(
        "swarm {}/{} run={} {} [{}]\n\
         Throughput\n\
         \x20 - moves              {}\n\
         \x20 - wall move-TPS      {:.1}\n\
         Tunnels\n\
         \x20 - opened={}  settled={}  failed={}  aborted={}\n\
         Phases\n\
         \x20 - open={}ms  play={}ms  settle={}ms  elapsed={}ms\n\
         Resources\n\
         \x20 - cpu avg={:.1} cores, util_p50={:.1}%, rss peak={}MB\n",
        r.swarm_index,
        r.swarm_count,
        r.run_id,
        r.protocol_id,
        r.scenario,
        r.moves,
        r.wall_move_tps,
        r.tunnels_opened,
        r.tunnels_settled,
        r.tunnels_failed,
        r.tunnels_aborted,
        r.open_ms,
        r.play_ms,
        r.settle_ms,
        r.elapsed_ms,
        r.cpu_cores_avg,
        r.cpu_util_p50_pct,
        r.rss_peak_bytes / 1_048_576,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::swarm::pipeline::{AnchorChoice, CohortConfig, SwarmParams};
    use crate::swarm::protocol::{ProtocolKind, Scenario};
    use crate::swarm::stats::Distribution;

    fn params() -> SwarmParams {
        SwarmParams {
            run_id: "run-7".into(),
            swarm_index: 1,
            swarm_count: 4,
            tunnels: 8,
            protocol: ProtocolKind::BlackjackV2,
            scenario: Scenario::Golden,
            initial_balance: 1_000_000,
            anchor: AnchorChoice::Memory,
            cohorts: CohortConfig::unbounded(),
            workers: 2,
            duration_secs: 30,
            moves: None,
            heartbeat: None,
            telemetry_collect: false,
        }
    }

    fn outcome() -> SwarmOutcome {
        SwarmOutcome {
            tunnels_opened: 8,
            tunnels_settled: 8,
            tunnels_failed: 0,
            tunnels_aborted: 0,
            moves: 4_000,
            bytes: 123_456,
            elapsed_ms: 2_000,
            open_ms: 300,
            play_ms: 1_400,
            settle_ms: 300,
            play_ns_dist: Distribution::default(),
            per_tunnel_tps: Distribution::default(),
        }
    }

    fn resources() -> ResourceSummary {
        ResourceSummary {
            cpu_cores_avg: 3.5,
            cpu_util_p50_pct: 87.5,
            rss_peak_bytes: 64 * 1_048_576,
            ..Default::default()
        }
    }

    #[test]
    fn build_report_computes_wall_tps_and_carries_identity() {
        let report = build_report(&params(), &outcome(), &resources());

        // 4000 moves / 2000ms => 2000 move-TPS.
        assert_eq!(report.wall_move_tps, 2_000.0);
        assert_eq!(report.run_id, "run-7");
        assert_eq!(report.swarm_index, 1);
        assert_eq!(report.swarm_count, 4);
        assert_eq!(report.protocol_id, "blackjack.v2");
        assert_eq!(report.scenario, "golden");
        assert_eq!(report.open_ms, 300);
        assert_eq!(report.play_ms, 1_400);
        assert_eq!(report.settle_ms, 300);
        assert_eq!(report.rss_peak_bytes, 64 * 1_048_576);
    }

    #[test]
    fn swarm_report_round_trips_through_serde() {
        let report = build_report(&params(), &outcome(), &resources());
        let json = serde_json::to_string(&report).expect("serialize");
        let back: SwarmReport = serde_json::from_str(&json).expect("deserialize");

        assert_eq!(back.run_id, report.run_id);
        assert_eq!(back.moves, report.moves);
        assert_eq!(back.wall_move_tps, report.wall_move_tps);
        assert_eq!(back.settle_ms, report.settle_ms);
        assert_eq!(back.tunnels_settled, report.tunnels_settled);
    }
}
