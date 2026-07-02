//! Spawn modes and per-swarm process handles.
//!
//! A run fans out into N hidden `run-swarm` subprocesses of this same binary.
//! The mode decides their timing: `replicate`/`distribute` launch every swarm at
//! once (they differ only in the argv the [`crate::runconfig`] builder produces),
//! while `sequential` runs one swarm to completion before spawning the next. Each
//! worker prints a JSON [`SwarmReport`] on stdout, which we parse back here.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use futures_util::future::join_all;
use tokio::process::{Child, Command};

use crate::runconfig::{swarm_args, RunConfig};
use crate::swarm::report::SwarmReport;

/// A spawned swarm subprocess and the index it was assigned. `process` is the
/// live `run-swarm` child; its stdout and stderr are piped so the report can be
/// parsed and a failure's diagnostics captured.
pub struct SwarmHandle {
    pub swarm_index: u64,
    pub process: Child,
}

/// Why a swarm did not yield a usable [`SwarmReport`].
#[derive(Debug)]
pub enum SwarmError {
    /// The child could not be spawned, or its output could not be collected.
    Spawn(String),
    /// The child exited non-zero; carries the exit code (if any) and its stderr.
    NonZeroExit {
        swarm: u64,
        code: Option<i32>,
        stderr: String,
    },
    /// The child exited zero but its stdout was not a parseable [`SwarmReport`].
    Parse {
        swarm: u64,
        source: serde_json::Error,
    },
}

impl std::fmt::Display for SwarmError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Spawn(msg) => write!(f, "swarm spawn failed: {msg}"),
            Self::NonZeroExit {
                swarm,
                code,
                stderr,
            } => {
                let code = code.map_or_else(|| "signal".to_string(), |c| c.to_string());
                write!(f, "swarm {swarm} exited with {code}: {}", stderr.trim())
            }
            Self::Parse { swarm, source } => {
                write!(f, "swarm {swarm} report parse failed: {source}")
            }
        }
    }
}

impl std::error::Error for SwarmError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Parse { source, .. } => Some(source),
            _ => None,
        }
    }
}

/// Absolute path to the currently running executable, used as the `run-swarm`
/// worker binary so the daemon spawns copies of itself.
pub fn self_exe() -> PathBuf {
    std::env::current_exe().expect("resolve current executable path")
}

/// Spawn one swarm as `self_exe run-swarm <argv>` with stdout/stderr piped.
/// `kill_on_drop` so a dropped handle (e.g. an aborted run) does not leak the
/// child. Applies the run's [`SpawnMode`](crate::proto::SpawnMode) via the argv
/// builder; the process starts immediately.
pub async fn spawn_swarm(
    self_exe: &Path,
    cfg: &RunConfig,
    swarm_index: u64,
) -> std::io::Result<SwarmHandle> {
    let process = Command::new(self_exe)
        .arg("run-swarm")
        .args(swarm_args(cfg, swarm_index))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    Ok(SwarmHandle {
        swarm_index,
        process,
    })
}

/// Await a spawned swarm and parse its JSON report from stdout. A non-zero exit
/// or unparseable stdout becomes a [`SwarmError`] rather than aborting the run.
async fn collect_report(handle: SwarmHandle) -> Result<SwarmReport, SwarmError> {
    let swarm = handle.swarm_index;
    let output = handle
        .process
        .wait_with_output()
        .await
        .map_err(|err| SwarmError::Spawn(format!("swarm {swarm}: {err}")))?;
    if !output.status.success() {
        return Err(SwarmError::NonZeroExit {
            swarm,
            code: output.status.code(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        });
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    serde_json::from_str::<SwarmReport>(stdout.trim())
        .map_err(|source| SwarmError::Parse { swarm, source })
}

/// Run every swarm concurrently (the `replicate` and `distribute` modes, which
/// differ only in the per-swarm argv). All children are spawned before any is
/// awaited, so they run in parallel; results keep swarm-index order.
pub async fn run_replicate_or_distribute(
    self_exe: &Path,
    cfg: &RunConfig,
) -> Vec<Result<SwarmReport, SwarmError>> {
    let mut pending = Vec::with_capacity(cfg.swarms as usize);
    for swarm_index in 0..cfg.swarms {
        pending.push(spawn_swarm(self_exe, cfg, swarm_index).await);
    }
    let collecting = pending.into_iter().map(|spawned| async move {
        match spawned {
            Ok(handle) => collect_report(handle).await,
            Err(err) => Err(SwarmError::Spawn(err.to_string())),
        }
    });
    join_all(collecting).await
}

/// Run swarms one at a time: spawn a swarm, await its report, then spawn the
/// next. The `sequential` mode's run windows are therefore disjoint in real time.
pub async fn run_sequential(
    self_exe: &Path,
    cfg: &RunConfig,
) -> Vec<Result<SwarmReport, SwarmError>> {
    let mut results = Vec::with_capacity(cfg.swarms as usize);
    for swarm_index in 0..cfg.swarms {
        let result = match spawn_swarm(self_exe, cfg, swarm_index).await {
            Ok(handle) => collect_report(handle).await,
            Err(err) => Err(SwarmError::Spawn(err.to_string())),
        };
        results.push(result);
    }
    results
}
