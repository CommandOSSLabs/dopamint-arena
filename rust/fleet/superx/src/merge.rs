//! Fleet-level rollup of a run's per-swarm reports.
//!
//! The daemon collects one [`SwarmReport`] per spawned `run-swarm` process and
//! folds them into a single [`RunAggregate`] describing the whole run. Counts
//! sum; CPU cores sum (each swarm reports its own average core usage, so the
//! fleet's core footprint is the sum); RSS is the peak across swarms (they run
//! as separate processes sharing a machine — the high-water mark, not a sum);
//! throughput is recomputed against the run's wall clock.

use crate::proto::RunAggregateWire;
use crate::swarm::report::{SwarmReport, move_tps};

/// Aggregated result of a run's swarm reports. The daemon fills this once every
/// swarm report is collected; it mirrors [`crate::proto::RunAggregateWire`].
#[derive(Clone, Debug, PartialEq)]
pub struct RunAggregate {
    pub swarms: u64,
    pub tunnels_opened: u64,
    pub tunnels_settled: u64,
    pub tunnels_failed: u64,
    pub tunnels_aborted: u64,
    pub moves: u64,
    pub wall_ms: u128,
    /// Fleet throughput: total moves over the run's wall clock (not the sum of
    /// per-swarm windows, which overlap for concurrent modes).
    pub wall_move_tps: f64,
    /// Sum of per-swarm average core usage — the fleet's aggregate CPU footprint.
    pub cpu_cores_avg: f64,
    /// Peak resident-set size across swarms (max, not sum).
    pub rss_peak_bytes: u64,
}

impl RunAggregate {
    /// Project onto the serde wire type carried in `List`/`Watch` responses.
    pub fn to_wire(&self) -> RunAggregateWire {
        RunAggregateWire {
            swarms: self.swarms,
            tunnels_opened: self.tunnels_opened,
            tunnels_settled: self.tunnels_settled,
            tunnels_failed: self.tunnels_failed,
            tunnels_aborted: self.tunnels_aborted,
            moves: self.moves,
            wall_ms: self.wall_ms,
            wall_move_tps: self.wall_move_tps,
            cpu_cores_avg: self.cpu_cores_avg,
            rss_peak_bytes: self.rss_peak_bytes,
        }
    }
}

/// Fold per-swarm reports into a fleet-level aggregate against the run's wall
/// clock. `wall_ms` is measured by the daemon around the whole swarm set, so it
/// governs `wall_move_tps` rather than any single swarm's `elapsed_ms`.
pub fn merge(reports: &[SwarmReport], wall_ms: u128) -> RunAggregate {
    let mut agg = RunAggregate {
        swarms: reports.len() as u64,
        tunnels_opened: 0,
        tunnels_settled: 0,
        tunnels_failed: 0,
        tunnels_aborted: 0,
        moves: 0,
        wall_ms,
        wall_move_tps: 0.0,
        cpu_cores_avg: 0.0,
        rss_peak_bytes: 0,
    };
    for r in reports {
        agg.tunnels_opened += r.tunnels_opened;
        agg.tunnels_settled += r.tunnels_settled;
        agg.tunnels_failed += r.tunnels_failed;
        agg.tunnels_aborted += r.tunnels_aborted;
        agg.moves += r.moves;
        agg.cpu_cores_avg += r.cpu_cores_avg;
        agg.rss_peak_bytes = agg.rss_peak_bytes.max(r.rss_peak_bytes);
    }
    agg.wall_move_tps = move_tps(agg.moves, wall_ms);
    agg
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(moves: u64, settled: u64, cpu_cores: f64, rss: u64) -> SwarmReport {
        SwarmReport {
            run_id: "run-7".to_string(),
            swarm_index: 0,
            swarm_count: 2,
            protocol_id: "blackjack.v2".to_string(),
            scenario: "golden".to_string(),
            tunnels_opened: settled,
            tunnels_settled: settled,
            tunnels_failed: 0,
            tunnels_aborted: 0,
            moves,
            bytes: 0,
            elapsed_ms: 1_000,
            open_ms: 100,
            play_ms: 800,
            settle_ms: 100,
            wall_move_tps: 0.0,
            cpu_cores_avg: cpu_cores,
            cpu_util_p50_pct: 0.0,
            rss_peak_bytes: rss,
        }
    }

    #[test]
    fn merge_sums_counts_peaks_rss_and_computes_wall_tps() {
        let reports = vec![
            report(2_000, 4, 1.5, 100 * 1_048_576),
            report(2_000, 4, 2.0, 250 * 1_048_576),
        ];

        // The run's wall clock spans the whole swarm set; per-swarm windows
        // overlap for concurrent modes, so tps is recomputed against it.
        let agg = merge(&reports, 2_000);

        assert_eq!(agg.swarms, 2);
        assert_eq!(agg.tunnels_opened, 8);
        assert_eq!(agg.tunnels_settled, 8);
        assert_eq!(agg.moves, 4_000);
        // 4000 moves / 2000ms => 2000 move-TPS against the run wall clock.
        assert_eq!(agg.wall_move_tps, 2_000.0);
        // Cores sum across swarms.
        assert_eq!(agg.cpu_cores_avg, 3.5);
        // RSS is the peak, not the sum.
        assert_eq!(agg.rss_peak_bytes, 250 * 1_048_576);
    }

    #[test]
    fn merge_of_empty_is_zeroed() {
        let agg = merge(&[], 0);
        assert_eq!(agg.swarms, 0);
        assert_eq!(agg.moves, 0);
        assert_eq!(agg.wall_move_tps, 0.0);
        assert_eq!(agg.rss_peak_bytes, 0);
    }
}
