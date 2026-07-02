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
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::{Child, Command};

use crate::runconfig::{swarm_args, RunConfig};
use crate::swarm::report::SwarmReport;

/// Line a `run-swarm` worker prints to stderr once it has crossed the open
/// barrier and begun play — i.e. it is genuinely running with its graceful-stop
/// handler installed. The daemon watches for this to announce a run `Running`
/// only when a subsequent stop would drain real open tunnels. On stdout the
/// worker prints only its JSON report, so this never pollutes report parsing.
pub const SWARM_READY_MARKER: &str = "__fleet_superx_swarm_ready__";

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

/// Send `SIGTERM` to a swarm subprocess so it drains its current phase and
/// settles (graceful stop), unlike the `SIGKILL` of [`Child::kill`] which would
/// leave half-open tunnels. A pid that already exited (`ESRCH`) is treated as
/// success — the swarm is already gone, which is what stop wants.
#[cfg(unix)]
pub fn signal_swarm(pid: u32) -> std::io::Result<()> {
    // SAFETY: `kill` is a thin syscall wrapper with no memory effects; we pass a
    // plain pid and a fixed signal number.
    let rc = unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
    if rc == 0 {
        return Ok(());
    }
    let err = std::io::Error::last_os_error();
    if err.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(err)
    }
}

/// Non-unix fallback: graceful (SIGTERM-based) stop is unix-only.
#[cfg(not(unix))]
pub fn signal_swarm(_pid: u32) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "graceful stop signalling requires unix",
    ))
}

/// Observes a swarm subprocess's lifecycle so the daemon can drive the run's
/// state and record pids for graceful stop. Kept transport-agnostic so `spawn`
/// never depends on the registry.
pub trait SwarmProgressObserver: Send + Sync {
    /// A swarm subprocess was spawned with operating-system pid `pid`. The pid is
    /// known but the swarm may still be starting up (its stop handler not yet
    /// installed).
    fn swarm_spawned(&self, swarm_index: u64, pid: u32);
    /// The swarm reported (via [`SWARM_READY_MARKER`]) that it has begun play with
    /// its graceful-stop handler installed, so a stop now drains real open
    /// tunnels rather than racing startup.
    fn swarm_ready(&self, swarm_index: u64);
}

/// A no-op observer for callers that do not track swarm progress (the standalone
/// spawn entrypoints and their tests).
pub struct IgnoreProgress;

impl SwarmProgressObserver for IgnoreProgress {
    fn swarm_spawned(&self, _swarm_index: u64, _pid: u32) {}
    fn swarm_ready(&self, _swarm_index: u64) {}
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

/// Await a spawned swarm and parse its JSON report from stdout, streaming stderr
/// so the [`SWARM_READY_MARKER`] surfaces as `observer.swarm_ready` while the
/// swarm is still running. A non-zero exit or unparseable stdout becomes a
/// [`SwarmError`] rather than aborting the run.
async fn collect_report(
    handle: SwarmHandle,
    observer: &dyn SwarmProgressObserver,
) -> Result<SwarmReport, SwarmError> {
    let swarm = handle.swarm_index;
    let mut process = handle.process;
    let stdout = process.stdout.take();
    let stderr = process.stderr.take();

    // Drain stderr line-by-line: the readiness marker is reported to the observer
    // live; every other line is kept for failure diagnostics.
    let stderr_reader = async {
        let mut diagnostics = String::new();
        if let Some(stderr) = stderr {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line == SWARM_READY_MARKER {
                    observer.swarm_ready(swarm);
                    continue;
                }
                diagnostics.push_str(&line);
                diagnostics.push('\n');
            }
        }
        diagnostics
    };
    let stdout_reader = async {
        let mut collected = String::new();
        if let Some(mut stdout) = stdout {
            let _ = stdout.read_to_string(&mut collected).await;
        }
        collected
    };

    // stdout/stderr are owned handles taken off the child, so reading them while
    // awaiting `wait()` cannot deadlock on a full pipe.
    let (status, stdout_str, stderr_str) =
        tokio::join!(process.wait(), stdout_reader, stderr_reader);
    let status = status.map_err(|err| SwarmError::Spawn(format!("swarm {swarm}: {err}")))?;
    if !status.success() {
        return Err(SwarmError::NonZeroExit {
            swarm,
            code: status.code(),
            stderr: stderr_str,
        });
    }
    serde_json::from_str::<SwarmReport>(stdout_str.trim())
        .map_err(|source| SwarmError::Parse { swarm, source })
}

/// Run every swarm concurrently (the `replicate` and `distribute` modes, which
/// differ only in the per-swarm argv). All children are spawned before any is
/// awaited, so they run in parallel; results keep swarm-index order.
pub async fn run_replicate_or_distribute(
    self_exe: &Path,
    cfg: &RunConfig,
) -> Vec<Result<SwarmReport, SwarmError>> {
    run_replicate_or_distribute_observed(self_exe, cfg, &IgnoreProgress).await
}

/// Like [`run_replicate_or_distribute`] but reports each swarm's pid (on spawn)
/// and readiness (on the play transition) to `observer`. Every child is spawned
/// (and its pid observed) before any report is awaited, so the daemon has
/// recorded all pids by the time a swarm is running — closing the window between
/// "running" and "signalable" for graceful stop.
pub async fn run_replicate_or_distribute_observed(
    self_exe: &Path,
    cfg: &RunConfig,
    observer: &dyn SwarmProgressObserver,
) -> Vec<Result<SwarmReport, SwarmError>> {
    let mut pending = Vec::with_capacity(cfg.swarms as usize);
    for swarm_index in 0..cfg.swarms {
        let spawned = spawn_swarm(self_exe, cfg, swarm_index).await;
        if let Ok(handle) = &spawned {
            if let Some(pid) = handle.process.id() {
                observer.swarm_spawned(swarm_index, pid);
            }
        }
        pending.push(spawned);
    }
    let collecting = pending.into_iter().map(|spawned| async move {
        match spawned {
            Ok(handle) => collect_report(handle, observer).await,
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
    run_sequential_observed(self_exe, cfg, &IgnoreProgress).await
}

/// Like [`run_sequential`] but reports each swarm's pid (on spawn) and readiness
/// (on the play transition) to `observer`, so a graceful stop can signal whichever
/// swarm is currently live.
pub async fn run_sequential_observed(
    self_exe: &Path,
    cfg: &RunConfig,
    observer: &dyn SwarmProgressObserver,
) -> Vec<Result<SwarmReport, SwarmError>> {
    let mut results = Vec::with_capacity(cfg.swarms as usize);
    for swarm_index in 0..cfg.swarms {
        let result = match spawn_swarm(self_exe, cfg, swarm_index).await {
            Ok(handle) => {
                if let Some(pid) = handle.process.id() {
                    observer.swarm_spawned(swarm_index, pid);
                }
                collect_report(handle, observer).await
            }
            Err(err) => Err(SwarmError::Spawn(err.to_string())),
        };
        results.push(result);
    }
    results
}
