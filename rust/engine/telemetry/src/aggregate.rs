//! Merge per-tunnel `CollectingSink`s into per-stage distributions and totals.
//! Runs AFTER the timed region, so cost here never touches benchmark latency.

use std::collections::HashMap;

use crate::sink::{AnchorPayer, CollectingSink, StageId};
use crate::stats::{summarize, Distribution};

#[derive(Clone, Debug, Default)]
pub struct RunTelemetry {
    stages: HashMap<StageIdKey, Distribution>,
    gas_funder_mist: u64,
    gas_sponsor_mist: u64,
    export_bytes_total: u64,
}

type StageIdKey = u8;

fn key(stage: StageId) -> StageIdKey {
    stage as u8
}

impl RunTelemetry {
    pub fn from_sinks(sinks: Vec<CollectingSink>) -> Self {
        let mut by_stage: HashMap<StageIdKey, Vec<f64>> = HashMap::new();
        let mut gas_funder_mist = 0u64;
        let mut gas_sponsor_mist = 0u64;
        let mut export_bytes_total = 0u64;

        for sink in &sinks {
            for s in sink.samples() {
                by_stage
                    .entry(key(s.stage))
                    .or_default()
                    .push(s.dur_ns as f64);
                match s.cost.paid_by {
                    Some(AnchorPayer::Funder) => gas_funder_mist += s.cost.gas_mist,
                    Some(AnchorPayer::Sponsor) => gas_sponsor_mist += s.cost.gas_mist,
                    None => {}
                }
                if s.stage == StageId::RecorderExport {
                    export_bytes_total += s.cost.bytes;
                }
            }
        }

        let stages = by_stage
            .into_iter()
            .map(|(k, vals)| (k, summarize(&vals)))
            .collect();

        Self {
            stages,
            gas_funder_mist,
            gas_sponsor_mist,
            export_bytes_total,
        }
    }

    pub fn stage(&self, stage: StageId) -> Distribution {
        self.stages.get(&key(stage)).cloned().unwrap_or_default()
    }
    pub fn count(&self, stage: StageId) -> u64 {
        self.stages.get(&key(stage)).map(|d| d.count).unwrap_or(0)
    }
    pub fn gas_mist(&self, payer: AnchorPayer) -> u64 {
        match payer {
            AnchorPayer::Funder => self.gas_funder_mist,
            AnchorPayer::Sponsor => self.gas_sponsor_mist,
        }
    }
    pub fn export_bytes_total(&self) -> u64 {
        self.export_bytes_total
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sink::{
        AnchorPayer, CollectingSink, StageCost, StageId, StageSample, TelemetrySink,
    };

    #[test]
    fn aggregates_open_latency_distribution_and_gas_by_payer() {
        let mut s = CollectingSink::with_capacity(4);
        s.record(StageSample {
            stage: StageId::Open,
            dur_ns: 100_000_000,
            cost: StageCost {
                gas_mist: 1000,
                paid_by: Some(AnchorPayer::Funder),
                bytes: 0,
            },
        });
        s.record(StageSample {
            stage: StageId::Open,
            dur_ns: 300_000_000,
            cost: StageCost {
                gas_mist: 500,
                paid_by: Some(AnchorPayer::Sponsor),
                bytes: 0,
            },
        });
        let run = RunTelemetry::from_sinks(vec![s]);
        assert_eq!(run.count(StageId::Open), 2);
        assert_eq!(run.stage(StageId::Open).peak, 300_000_000.0);
        assert_eq!(run.gas_mist(AnchorPayer::Funder), 1000);
        assert_eq!(run.gas_mist(AnchorPayer::Sponsor), 500);
    }

    #[test]
    fn export_bytes_total_counts_only_recorder_export_samples() {
        let mut s = CollectingSink::with_capacity(3);
        // Two RecorderExport samples — both bytes should be summed.
        s.record(StageSample {
            stage: StageId::RecorderExport,
            dur_ns: 1,
            cost: StageCost {
                gas_mist: 0,
                paid_by: None,
                bytes: 1234,
            },
        });
        s.record(StageSample {
            stage: StageId::RecorderExport,
            dur_ns: 1,
            cost: StageCost {
                gas_mist: 0,
                paid_by: None,
                bytes: 766,
            },
        });
        // A non-RecorderExport sample with bytes — must NOT be counted.
        s.record(StageSample {
            stage: StageId::FrameSend,
            dur_ns: 1,
            cost: StageCost {
                gas_mist: 0,
                paid_by: None,
                bytes: 9999,
            },
        });
        let run = RunTelemetry::from_sinks(vec![s]);
        assert_eq!(run.export_bytes_total(), 1234 + 766);
    }

    #[test]
    fn missing_stage_yields_empty_distribution() {
        let run = RunTelemetry::from_sinks(vec![CollectingSink::with_capacity(0)]);
        assert_eq!(run.count(StageId::Settle), 0);
        assert_eq!(run.stage(StageId::Settle).count, 0);
    }
}
