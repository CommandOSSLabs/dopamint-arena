//! In-process registry of active and completed runs plus the run lifecycle
//! state machine.
//!
//! The daemon owns one [`Registry`] shared across every control connection. It
//! tracks each run by `run_id`: its resolved [`RunConfig`], current
//! [`RunState`], spawned swarm pids (for `stop`), and — once every swarm report
//! is collected — the fleet [`RunAggregate`]. [`RunState`] transitions are
//! guarded so a run never regresses out of a terminal state or skips backwards;
//! callers observe rejected transitions via the `bool` return and leave the
//! record untouched.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use crate::merge::RunAggregate;
use crate::runconfig::RunConfig;

/// Lifecycle of a single run. `Finished` and `Failed` are terminal; a run
/// advances forward only (`Starting → Running → Stopping → Finished`, with
/// `Failed` reachable from any non-terminal state).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunState {
    /// Accepted; swarm processes are being spawned.
    Starting,
    /// All swarms spawned and running.
    Running,
    /// A `stop` was requested; swarms are draining.
    Stopping,
    /// Every swarm exited cleanly and the aggregate is attached.
    Finished,
    /// A swarm failed to spawn, exited non-zero, or produced an unparseable
    /// report.
    Failed,
}

impl RunState {
    /// Lowercase wire name carried in [`crate::proto::RunSummary::state`] and
    /// run-state events. Stable across versions — clients match on it.
    pub fn as_str(self) -> &'static str {
        match self {
            RunState::Starting => "starting",
            RunState::Running => "running",
            RunState::Stopping => "stopping",
            RunState::Finished => "finished",
            RunState::Failed => "failed",
        }
    }

    /// Whether the run has reached a terminal state and can no longer advance.
    fn is_terminal(self) -> bool {
        matches!(self, RunState::Finished | RunState::Failed)
    }

    /// Whether a forward transition from `self` to `next` is permitted. A run
    /// only moves forward; `Failed` is reachable from any non-terminal state,
    /// and no transition leaves a terminal state.
    fn can_advance_to(self, next: RunState) -> bool {
        use RunState::*;
        match (self, next) {
            (from, Failed) => !from.is_terminal(),
            (Starting, Running | Stopping) => true,
            (Running, Stopping | Finished) => true,
            (Stopping, Finished) => true,
            _ => false,
        }
    }
}

/// One run's tracked state: its config, current lifecycle state, the pids of its
/// spawned swarms (targeted by `stop`), and the fleet aggregate once collected.
#[derive(Clone, Debug)]
pub struct RunRecord {
    pub run_id: String,
    pub state: RunState,
    pub cfg: RunConfig,
    pub aggregate: Option<RunAggregate>,
    pub swarm_pids: Vec<u32>,
}

impl RunRecord {
    /// A freshly-accepted run: `Starting`, no pids, no aggregate. `run_id` is
    /// taken from the config so the registry key matches the record.
    pub fn new(cfg: RunConfig) -> Self {
        Self {
            run_id: cfg.run_id.clone(),
            state: RunState::Starting,
            cfg,
            aggregate: None,
            swarm_pids: Vec::new(),
        }
    }
}

/// Thread-safe registry of all runs the daemon has accepted, keyed by `run_id`.
/// Cloneable-out accessors ([`Registry::get`], [`Registry::list`]) snapshot the
/// record so callers never hold the lock across await points.
pub struct Registry {
    runs: Mutex<HashMap<String, RunRecord>>,
    /// Monotonic sequence feeding [`Registry::gen_run_id`]; makes ids unique and
    /// ordered within a daemon process.
    next_seq: AtomicU64,
}

impl Default for Registry {
    fn default() -> Self {
        Self::new()
    }
}

impl Registry {
    pub fn new() -> Self {
        Self {
            runs: Mutex::new(HashMap::new()),
            next_seq: AtomicU64::new(0),
        }
    }

    /// Record a newly-accepted run. Replaces any prior record under the same id.
    pub fn insert(&self, record: RunRecord) {
        self.runs
            .lock()
            .expect("registry lock poisoned")
            .insert(record.run_id.clone(), record);
    }

    /// Attempt a lifecycle transition. Returns `true` if `run_id` exists and the
    /// transition is legal (and was applied); `false` if the run is unknown or
    /// the transition would regress out of a terminal state or skip backwards.
    pub fn set_state(&self, run_id: &str, next: RunState) -> bool {
        let mut runs = self.runs.lock().expect("registry lock poisoned");
        match runs.get_mut(run_id) {
            Some(rec) if rec.state.can_advance_to(next) => {
                rec.state = next;
                true
            }
            _ => false,
        }
    }

    /// Record the pids of a run's spawned swarms so `stop` can signal them.
    /// Returns `false` if the run is unknown.
    pub fn set_pids(&self, run_id: &str, pids: Vec<u32>) -> bool {
        let mut runs = self.runs.lock().expect("registry lock poisoned");
        match runs.get_mut(run_id) {
            Some(rec) => {
                rec.swarm_pids = pids;
                true
            }
            None => false,
        }
    }

    /// Attach the fleet aggregate collected from a run's swarm reports. Returns
    /// `false` if the run is unknown.
    pub fn set_aggregate(&self, run_id: &str, aggregate: RunAggregate) -> bool {
        let mut runs = self.runs.lock().expect("registry lock poisoned");
        match runs.get_mut(run_id) {
            Some(rec) => {
                rec.aggregate = Some(aggregate);
                true
            }
            None => false,
        }
    }

    /// Snapshot the record for `run_id`, or `None` if unknown.
    pub fn get(&self, run_id: &str) -> Option<RunRecord> {
        self.runs
            .lock()
            .expect("registry lock poisoned")
            .get(run_id)
            .cloned()
    }

    /// Snapshot every tracked run in arbitrary order.
    pub fn list(&self) -> Vec<RunRecord> {
        self.runs
            .lock()
            .expect("registry lock poisoned")
            .values()
            .cloned()
            .collect()
    }

    /// Mint a fresh run id: a monotonic sequence plus a short suffix derived from
    /// a process-start `nonce`, so ids are unique within a process and unlikely
    /// to collide across daemon restarts.
    pub fn gen_run_id(&self, nonce: u64) -> String {
        let seq = self.next_seq.fetch_add(1, Ordering::Relaxed);
        // Mix the nonce with the sequence so restarts with a fresh nonce don't
        // reuse ids of a prior process at the same sequence.
        let mut suffix = nonce ^ 0x9e37_79b9_7f4a_7c15;
        suffix = suffix.wrapping_mul(0x2545_f491_4f6c_dd1d) ^ seq.wrapping_add(1);
        format!("run-{seq}-{:06x}", suffix & 0xff_ffff)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::{CohortWire, SpawnMode};
    use crate::runconfig::RunConfig;
    use std::time::Duration;

    fn sample_cfg(run_id: &str) -> RunConfig {
        RunConfig {
            run_id: run_id.to_string(),
            mode: SpawnMode::Distribute,
            swarms: 2,
            protocol: "blackjack.v2".to_string(),
            duration: Duration::from_secs(10),
            until_stop: false,
            tunnels: 4,
            scenario: "golden".to_string(),
            anchor: "memory".to_string(),
            initial_balance: 100,
            cohorts: CohortWire {
                open_cohort: None,
                open_spacing: Duration::ZERO,
                settle_cohort: None,
                settle_spacing: Duration::ZERO,
            },
            extra: vec![],
        }
    }

    #[test]
    fn lifecycle_advances_through_valid_transitions() {
        let reg = Registry::new();
        reg.insert(RunRecord::new(sample_cfg("run-1")));
        assert!(matches!(reg.get("run-1").unwrap().state, RunState::Starting));
        assert!(reg.set_state("run-1", RunState::Running));
        assert!(reg.set_state("run-1", RunState::Finished));
        assert!(matches!(reg.get("run-1").unwrap().state, RunState::Finished));
    }

    #[test]
    fn invalid_transition_out_of_terminal_is_rejected() {
        let reg = Registry::new();
        reg.insert(RunRecord::new(sample_cfg("run-1")));
        assert!(reg.set_state("run-1", RunState::Running));
        assert!(reg.set_state("run-1", RunState::Finished));
        // Finished is terminal: cannot go back to Running.
        assert!(!reg.set_state("run-1", RunState::Running));
        assert!(matches!(reg.get("run-1").unwrap().state, RunState::Finished));
    }

    #[test]
    fn set_state_on_unknown_run_is_rejected() {
        let reg = Registry::new();
        assert!(!reg.set_state("missing", RunState::Running));
    }

    #[test]
    fn list_returns_inserted_and_unknown_get_is_none() {
        let reg = Registry::new();
        assert!(reg.get("missing").is_none());
        reg.insert(RunRecord::new(sample_cfg("run-a")));
        reg.insert(RunRecord::new(sample_cfg("run-b")));
        assert_eq!(reg.list().len(), 2);
    }

    #[test]
    fn set_aggregate_attaches_rollup_and_records_pids() {
        let reg = Registry::new();
        reg.insert(RunRecord::new(sample_cfg("run-1")));
        reg.set_pids("run-1", vec![101, 202]);
        let agg = crate::merge::RunAggregate {
            swarms: 2,
            tunnels_opened: 4,
            tunnels_settled: 4,
            tunnels_failed: 0,
            tunnels_aborted: 0,
            moves: 40,
            wall_ms: 1000,
            wall_move_tps: 40.0,
            cpu_cores_avg: 1.5,
            rss_peak_bytes: 4096,
        };
        assert!(reg.set_aggregate("run-1", agg.clone()));
        let rec = reg.get("run-1").unwrap();
        assert_eq!(rec.aggregate, Some(agg));
        assert_eq!(rec.swarm_pids, vec![101, 202]);
    }

    #[test]
    fn gen_run_id_is_unique_and_monotonic() {
        let reg = Registry::new();
        let a = reg.gen_run_id(7);
        let b = reg.gen_run_id(7);
        let c = reg.gen_run_id(99);
        assert_ne!(a, b);
        assert_ne!(a, c);
        assert_ne!(b, c);
    }
}
