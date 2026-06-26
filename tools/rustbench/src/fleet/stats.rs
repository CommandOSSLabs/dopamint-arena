//! Exact summary statistics over a sample slice. Used for moves-per-match,
//! play-loop duration, CPU utilization, and RSS. Percentiles are nearest-rank
//! over a sorted copy — the sample volume is small (a few hundred thousand at
//! most), so an exact sort beats a streaming estimator.

#[derive(Clone, Debug, Default)]
pub struct Distribution {
    pub count: u64,
    pub avg: f64,
    pub min: f64,
    pub p50: f64,
    pub p90: f64,
    pub p99: f64,
    pub peak: f64,
}

/// Nearest-rank percentile (`p` in 0..=100) over an already-sorted slice.
fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let rank = ((p / 100.0) * sorted.len() as f64).ceil() as usize;
    let idx = rank.saturating_sub(1).min(sorted.len() - 1);
    sorted[idx]
}

pub fn summarize(values: &[f64]) -> Distribution {
    if values.is_empty() {
        return Distribution::default();
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let count = sorted.len();
    let sum: f64 = sorted.iter().sum();
    Distribution {
        count: count as u64,
        avg: sum / count as f64,
        min: sorted[0],
        p50: percentile(&sorted, 50.0),
        p90: percentile(&sorted, 90.0),
        p99: percentile(&sorted, 99.0),
        peak: sorted[count - 1],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_is_default() {
        let d = summarize(&[]);
        assert_eq!(d.count, 0);
        assert_eq!(d.avg, 0.0);
    }

    #[test]
    fn percentiles_nearest_rank() {
        let xs: Vec<f64> = (1..=100).map(|i| i as f64).collect();
        let d = summarize(&xs);
        assert_eq!(d.count, 100);
        assert_eq!(d.min, 1.0);
        assert_eq!(d.peak, 100.0);
        assert_eq!(d.avg, 50.5);
        assert_eq!(d.p50, 50.0); // nearest-rank: ceil(0.50*100)=50 -> xs[49]=50
        assert_eq!(d.p90, 90.0);
        assert_eq!(d.p99, 99.0);
    }

    #[test]
    fn single_value() {
        let d = summarize(&[7.0]);
        assert_eq!(d.count, 1);
        assert_eq!(d.avg, 7.0);
        assert_eq!(d.p50, 7.0);
        assert_eq!(d.p99, 7.0);
    }
}
