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

/// Round assigned cores to 2 decimals but never below a usable floor, so a
/// positive quota can't produce a zero denominator (which would make
/// utilization Inf/NaN).
pub fn quota_to_cores(q: f64) -> f64 {
    ((q * 100.0).round() / 100.0).max(0.01)
}

/// Parse the `usage_usec` line of cgroup v2 `cpu.stat` into total consumed CPU
/// microseconds, or None if absent/unparseable.
pub fn parse_cpu_stat_usage_usec(cpu_stat: &str) -> Option<u64> {
    for line in cpu_stat.lines() {
        let mut it = line.split_whitespace();
        if it.next() == Some("usage_usec") {
            return it.next()?.parse().ok();
        }
    }
    None
}

/// Total CPU time consumed by the current cgroup in microseconds (v2 `cpu.stat`
/// `usage_usec`, then v1 `cpuacct.usage` in nanoseconds). None if not in a cgroup.
pub fn cgroup_cpu_usage_usec() -> Option<u64> {
    if let Ok(s) = std::fs::read_to_string("/sys/fs/cgroup/cpu.stat") {
        if let Some(u) = parse_cpu_stat_usage_usec(&s) {
            return Some(u);
        }
    }
    let ns: u64 = std::fs::read_to_string("/sys/fs/cgroup/cpuacct/cpuacct.usage")
        .ok()?
        .trim()
        .parse()
        .ok()?;
    Some(ns / 1000)
}

/// Consumed cores over an interval: CPU-microseconds consumed / wall-microseconds
/// elapsed. 0.0 if no wall time elapsed.
pub fn consumed_cores(delta_usage_usec: u64, wall_elapsed_us: u128) -> f64 {
    if wall_elapsed_us == 0 {
        return 0.0;
    }
    delta_usage_usec as f64 / wall_elapsed_us as f64
}

/// The cores the bench may use, and how it was determined.
pub fn cpu_budget() -> CpuBudget {
    if let Some(q) = cgroup_quota_cores() {
        if q > 0.0 {
            return CpuBudget {
                cores: quota_to_cores(q),
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

    #[test]
    fn quota_to_cores_floors_tiny_positive_quota() {
        assert!(quota_to_cores(0.004) >= 0.01, "must never be zero");
        assert_eq!(quota_to_cores(2.0), 2.0);
        assert_eq!(quota_to_cores(0.5), 0.5);
    }

    #[test]
    fn cpu_stat_usage_parsed() {
        let stat = "usage_usec 123456\nuser_usec 100000\nsystem_usec 23456\n";
        assert_eq!(parse_cpu_stat_usage_usec(stat), Some(123456));
        assert_eq!(parse_cpu_stat_usage_usec("nr_periods 0\n"), None);
        assert_eq!(parse_cpu_stat_usage_usec(""), None);
    }

    #[test]
    fn consumed_cores_is_usage_over_wall() {
        assert_eq!(consumed_cores(400_000, 100_000), 4.0); // 4 cores busy for 0.1s
        assert_eq!(consumed_cores(50_000, 100_000), 0.5);
        assert_eq!(consumed_cores(1, 0), 0.0); // no wall time => 0, never NaN
    }
}
