//! Cross-platform CPU + RSS sampling for the bench run (sysinfo). "cores" is
//! process CPU time over wall (a process pegging 4 cores reads ~4.0); "%" is
//! system-wide utilization. Started before the clock, stopped after, so startup
//! is excluded. Never panics the run: on an unavailable metric it records 0.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System};

#[derive(Clone, Debug, Default)]
pub struct ResourceSummary {
    pub cpu_cores_avg: f64,
    pub cpu_cores_peak: f64,
    pub cpu_pct_avg: f64,
    pub cpu_pct_peak: f64,
    pub rss_avg_bytes: f64,
    pub rss_peak_bytes: u64,
    pub samples: u64,
}

pub struct ResourceSampler {
    stop: Arc<AtomicBool>,
    handle: JoinHandle<ResourceSummary>,
}

pub fn start(interval_ms: u64) -> ResourceSampler {
    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = stop.clone();
    let handle = std::thread::spawn(move || sample_loop(interval_ms, stop_thread));
    ResourceSampler { stop, handle }
}

impl ResourceSampler {
    pub fn stop(self) -> ResourceSummary {
        self.stop.store(true, Ordering::Relaxed);
        self.handle.join().unwrap_or_default()
    }
}

fn sample_loop(interval_ms: u64, stop: Arc<AtomicBool>) -> ResourceSummary {
    let pid = match sysinfo::get_current_pid() {
        Ok(p) => p,
        Err(_) => return ResourceSummary::default(),
    };
    let ncores = std::thread::available_parallelism()
        .map(|n| n.get() as f64)
        .unwrap_or(1.0);
    let mut sys = System::new_with_specifics(
        RefreshKind::new().with_processes(ProcessRefreshKind::everything()),
    );

    let mut summary = ResourceSummary::default();
    let mut cores_sum = 0.0f64;
    let mut pct_sum = 0.0f64;
    let mut rss_sum = 0.0f64;

    // sysinfo needs two refreshes to compute CPU%; prime once, then loop.
    sys.refresh_cpu_all();
    sys.refresh_processes(ProcessesToUpdate::Some(&[pid]), false);

    while !stop.load(Ordering::Relaxed) {
        std::thread::sleep(Duration::from_millis(interval_ms));
        sys.refresh_cpu_all();
        sys.refresh_processes(ProcessesToUpdate::Some(&[pid]), false);

        let (cores, rss) = match sys.process(pid) {
            Some(p) => (p.cpu_usage() as f64 / 100.0, p.memory()),
            None => (0.0, 0),
        };
        let pct = system_cpu_pct(&sys);

        summary.samples += 1;
        cores_sum += cores;
        pct_sum += pct;
        rss_sum += rss as f64;
        if cores > summary.cpu_cores_peak {
            summary.cpu_cores_peak = cores;
        }
        if pct > summary.cpu_pct_peak {
            summary.cpu_pct_peak = pct;
        }
        if rss > summary.rss_peak_bytes {
            summary.rss_peak_bytes = rss;
        }
        let _ = ncores; // reserved for cgroup-aware denominator (see spec)
    }

    if summary.samples > 0 {
        let n = summary.samples as f64;
        summary.cpu_cores_avg = cores_sum / n;
        summary.cpu_pct_avg = pct_sum / n;
        summary.rss_avg_bytes = rss_sum / n;
    }
    summary
}

/// System-wide CPU utilization 0..100 (average across cores).
fn system_cpu_pct(sys: &System) -> f64 {
    sys.global_cpu_usage() as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sampler_yields_a_sane_summary() {
        let sampler = start(50);
        // do a little CPU work so at least one interval elapses
        let mut acc = 0u64;
        for i in 0..50_000_000u64 {
            acc = acc.wrapping_add(i);
        }
        std::hint::black_box(acc);
        std::thread::sleep(std::time::Duration::from_millis(160));
        let s = sampler.stop();
        assert!(s.samples >= 1, "expected at least one sample");
        assert!(s.cpu_cores_avg >= 0.0 && s.cpu_cores_avg.is_finite());
        assert!(s.cpu_cores_peak >= s.cpu_cores_avg - 1e-9);
        assert!(s.rss_peak_bytes >= 1);
        assert!(s.rss_avg_bytes > 0.0);
    }
}
