//! The instrumentation seam. `TelemetrySink` is held by generic type parameter
//! so `NullSink` monomorphizes to nothing on the hot path (no `dyn`, no branch).

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum StageId {
    Open,
    Settle,
    Play,
    Move,
    FrameSend,
    FrameRecv,
    RecorderRecord,
    RecorderExport,
}

/// Who paid the on-chain gas. In sponsored mode the sponsor pays; with a
/// single funder key the funder pays. Keeps "what WE spent" honest.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AnchorPayer {
    Funder,
    Sponsor,
}

/// Per-stage specifics. Latency-only stages leave this at default.
#[derive(Clone, Copy, Debug, Default)]
pub struct StageCost {
    pub gas_mist: u64,
    pub paid_by: Option<AnchorPayer>,
    pub bytes: u64,
}

#[derive(Clone, Copy, Debug)]
pub struct StageSample {
    pub stage: StageId,
    pub dur_ns: u64,
    pub cost: StageCost,
}

pub trait TelemetrySink {
    fn record(&mut self, sample: StageSample);
    /// Hot-path guard: skip even building a sample when disabled.
    fn enabled(&self) -> bool;
}

/// Zero-cost sink. With `S = NullSink`, instrumented wrappers compile to the
/// inner call plus nothing.
#[derive(Clone, Copy, Debug, Default)]
pub struct NullSink;

impl TelemetrySink for NullSink {
    #[inline(always)]
    fn record(&mut self, _sample: StageSample) {}
    #[inline(always)]
    fn enabled(&self) -> bool {
        false
    }
}

#[derive(Clone, Debug, Default)]
pub struct CollectingSink {
    samples: Vec<StageSample>,
    sample_limit: usize,
    enabled: bool,
}

impl CollectingSink {
    pub fn with_capacity(n: usize) -> Self {
        Self {
            samples: Vec::with_capacity(n),
            sample_limit: n,
            enabled: true,
        }
    }
    pub fn disabled() -> Self {
        Self {
            samples: Vec::new(),
            sample_limit: 0,
            enabled: false,
        }
    }
    pub fn samples(&self) -> &[StageSample] {
        &self.samples
    }
    pub fn merge(&mut self, other: CollectingSink) {
        let remaining = self.sample_limit.saturating_sub(self.samples.len());
        self.samples
            .extend(other.samples.into_iter().take(remaining));
    }
}

impl TelemetrySink for CollectingSink {
    #[inline]
    fn record(&mut self, sample: StageSample) {
        if self.enabled && self.samples.len() < self.sample_limit {
            self.samples.push(sample);
        }
    }
    #[inline(always)]
    fn enabled(&self) -> bool {
        self.enabled
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn null_sink_is_disabled_and_drops_samples() {
        let mut s = NullSink;
        assert!(!s.enabled());
        s.record(StageSample {
            stage: StageId::Move,
            dur_ns: 5,
            cost: StageCost::default(),
        });
        // No state to inspect; the contract is "does nothing, reports disabled".
    }

    #[test]
    fn collecting_sink_keeps_samples_and_merges() {
        let mut a = CollectingSink::with_capacity(2);
        let mut b = CollectingSink::with_capacity(2);
        a.record(StageSample {
            stage: StageId::Open,
            dur_ns: 100,
            cost: StageCost::default(),
        });
        b.record(StageSample {
            stage: StageId::Open,
            dur_ns: 300,
            cost: StageCost::default(),
        });
        assert!(a.enabled());
        a.merge(b);
        assert_eq!(a.samples().len(), 2);
    }

    #[test]
    fn collecting_sink_caps_samples_at_capacity() {
        let mut s = CollectingSink::with_capacity(2);
        for dur_ns in [1, 2, 3] {
            s.record(StageSample {
                stage: StageId::FrameRecv,
                dur_ns,
                cost: StageCost::default(),
            });
        }

        assert_eq!(s.samples().len(), 2);
        assert_eq!(s.samples()[0].dur_ns, 1);
        assert_eq!(s.samples()[1].dur_ns, 2);
    }

    #[test]
    fn disabled_collecting_sink_drops_samples() {
        let mut s = CollectingSink::disabled();
        assert!(!s.enabled());
        s.record(StageSample {
            stage: StageId::FrameSend,
            dur_ns: 100,
            cost: StageCost::default(),
        });
        assert!(s.samples().is_empty());
    }
}
