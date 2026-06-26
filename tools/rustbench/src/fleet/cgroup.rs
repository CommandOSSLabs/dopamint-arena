//! Cross-platform CPU "assigned cores" denominator. Inside a `docker run --cpus N`
//! (cgroup v2/v1) the quota is the truth; otherwise the host core count. Mirrors
//! loadbench's resourceMonitor cgroup logic so in-container utilization reads
//! against the assigned cores, not the host.

use std::fs;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum CpuBasis {
    Cgroup,
    System,
}

#[derive(Clone, Copy, Debug)]
pub struct CpuBudget {
    pub cores: f64,
    pub basis: CpuBasis,
}

/// Parse cgroup v2 `cpu.max` ("<quota> <period>" or "max <period>") into assigned
/// cores, or `None` if unlimited / unparseable.
pub fn parse_v2_quota(cpu_max: &str) -> Option<f64> {
    let mut it = cpu_max.split_whitespace();
    let quota = it.next()?;
    if quota == "max" {
        return None;
    }
    let q: f64 = quota.parse().ok()?;
    let p: f64 = it.next()?.parse().ok()?;
    if q > 0.0 && p > 0.0 {
        Some(q / p)
    } else {
        None
    }
}

/// Cores assigned by the cgroup CPU quota (v2 then v1), or `None` if unlimited /
/// not in a cgroup.
fn cgroup_quota_cores() -> Option<f64> {
    if let Ok(s) = fs::read_to_string("/sys/fs/cgroup/cpu.max") {
        return parse_v2_quota(&s);
    }
    let q: f64 = fs::read_to_string("/sys/fs/cgroup/cpu/cpu.cfs_quota_us")
        .ok()?
        .trim()
        .parse()
        .ok()?;
    let p: f64 = fs::read_to_string("/sys/fs/cgroup/cpu/cpu.cfs_period_us")
        .ok()?
        .trim()
        .parse()
        .ok()?;
    if q > 0.0 && p > 0.0 {
        Some(q / p)
    } else {
        None
    }
}

/// The cores the bench may use, and how it was determined.
pub fn cpu_budget() -> CpuBudget {
    if let Some(q) = cgroup_quota_cores() {
        if q > 0.0 {
            return CpuBudget {
                cores: (q * 100.0).round() / 100.0,
                basis: CpuBasis::Cgroup,
            };
        }
    }
    let cores = std::thread::available_parallelism()
        .map(|n| n.get() as f64)
        .unwrap_or(1.0);
    CpuBudget {
        cores,
        basis: CpuBasis::System,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn v2_quota_fraction() {
        assert_eq!(parse_v2_quota("800000 1000000"), Some(0.8));
        assert_eq!(parse_v2_quota("2000000 1000000"), Some(2.0));
    }

    #[test]
    fn v2_unlimited_is_none() {
        assert_eq!(parse_v2_quota("max 1000000"), None);
        assert_eq!(parse_v2_quota(""), None);
    }

    #[test]
    fn budget_is_positive() {
        let b = cpu_budget();
        assert!(b.cores >= 1.0, "fallback core count must be >= 1");
    }
}
