//! Supervisor daemon: the Unix-socket control plane and run executor.
//!
//! `fleet-superx daemon` binds a Unix socket and accepts newline-delimited
//! [`Request`] frames. Each connection is served independently: a `Start`
//! accepts the run, spawns the mode-aware swarm set on a background task, and
//! replies `Started` immediately; the background task drives the run's
//! lifecycle in the shared [`Registry`] (`Running` → collect reports → `merge`
//! → `Finished`/`Failed`). `List` snapshots every run; `Stop` marks a run
//! draining. The WebSocket transport (Task B7) reuses [`handle_request`] so
//! both surfaces stay byte-for-byte identical.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use clap::Args;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};

use crate::merge::merge;
use crate::proto::SpawnMode;
use crate::proto::{decode_line, encode_line, Request, Response, RunSummary};
use crate::registry::{Registry, RunRecord, RunState};
use crate::runconfig::RunConfig;
use crate::spawn::{run_replicate_or_distribute, run_sequential, self_exe, SwarmError};
use crate::swarm::report::SwarmReport;

/// Default control socket: `$XDG_RUNTIME_DIR/fleet-superx.sock` when the runtime
/// dir is set (per-user, cleaned on logout), else `/tmp/fleet-superx.sock`.
fn default_socket() -> PathBuf {
    let dir = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/tmp"));
    dir.join("fleet-superx.sock")
}

/// `fleet-superx daemon` flags. `ws` and `sink_addr` are accepted here but wired
/// in later tasks (B7 WebSocket, Phase C sink).
#[derive(Args)]
pub struct DaemonArgs {
    /// Unix control socket to bind.
    #[arg(long, default_value_os_t = default_socket())]
    socket: PathBuf,
    /// Optional `host:port` for the WebSocket control listener (Task B7).
    #[arg(long)]
    ws: Option<String>,
    /// Optional `host:port` for the localhost heartbeat sink (Phase C).
    #[arg(long)]
    sink_addr: Option<String>,
}

/// Shared daemon state handed to every connection and transport. `nonce` seeds
/// [`Registry::gen_run_id`] so ids don't collide across daemon restarts.
pub struct DaemonContext {
    pub registry: Arc<Registry>,
    pub self_exe: PathBuf,
    pub nonce: u64,
}

impl DaemonContext {
    /// Build a context rooted at this process's own executable (spawned as the
    /// `run-swarm` worker) with a fresh per-process id nonce.
    pub fn new() -> Self {
        Self {
            registry: Arc::new(Registry::new()),
            self_exe: self_exe(),
            nonce: process_nonce(),
        }
    }
}

impl Default for DaemonContext {
    fn default() -> Self {
        Self::new()
    }
}

/// A per-process nonce from the wall clock mixed with the pid, so run ids minted
/// by different daemon processes are extremely unlikely to collide.
fn process_nonce() -> u64 {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    nanos ^ ((std::process::id() as u64).wrapping_shl(32) | std::process::id() as u64)
}

/// Entry point for `fleet-superx daemon`: build a multi-thread runtime, bind the
/// Unix socket, and serve the control plane until the accept loop errors.
/// Returns a process exit code (0 on clean shutdown, 1 on a setup failure).
pub fn daemon_main(a: DaemonArgs) -> i32 {
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(err) => {
            eprintln!("fleet-superx daemon: failed to build runtime: {err}");
            return 1;
        }
    };
    runtime.block_on(async move {
        // A stale socket file from a prior run blocks bind; clear it first.
        let _ = tokio::fs::remove_file(&a.socket).await;
        let listener = match UnixListener::bind(&a.socket) {
            Ok(listener) => listener,
            Err(err) => {
                eprintln!(
                    "fleet-superx daemon: failed to bind {}: {err}",
                    a.socket.display()
                );
                return 1;
            }
        };
        eprintln!("fleet-superx daemon: listening on {}", a.socket.display());
        let ctx = Arc::new(DaemonContext::new());
        if let Err(err) = serve_unix(listener, ctx).await {
            eprintln!("fleet-superx daemon: accept loop failed: {err}");
            return 1;
        }
        0
    })
}

/// Accept and serve control connections on `listener` until it errors. Each
/// connection is handled on its own task so a slow client never blocks others.
/// Factored out of [`daemon_main`] so integration tests can drive it directly on
/// a temp socket.
pub async fn serve_unix(listener: UnixListener, ctx: Arc<DaemonContext>) -> std::io::Result<()> {
    loop {
        let (stream, _addr) = listener.accept().await?;
        let ctx = ctx.clone();
        tokio::spawn(async move {
            if let Err(err) = serve_connection(stream, ctx).await {
                eprintln!("fleet-superx daemon: connection error: {err}");
            }
        });
    }
}

/// Read newline-delimited [`Request`] frames from one connection and write one
/// [`Response`] line each, until the client hangs up (EOF).
async fn serve_connection(stream: UnixStream, ctx: Arc<DaemonContext>) -> std::io::Result<()> {
    let mut conn = BufReader::new(stream);
    let mut line = String::new();
    loop {
        line.clear();
        let read = conn.read_line(&mut line).await?;
        if read == 0 {
            return Ok(()); // client closed the connection
        }
        if line.trim().is_empty() {
            continue;
        }
        let response = match decode_line::<Request>(&line) {
            Ok(request) => handle_request(request, &ctx).await,
            Err(err) => Response::Error(format!("malformed request: {err}")),
        };
        conn.get_mut()
            .write_all(encode_line(&response).as_bytes())
            .await?;
    }
}

/// Dispatch one control request against the shared registry. Transport-agnostic
/// so the Unix and WebSocket listeners share identical behavior.
///
/// `Start` accepts the run and returns immediately with its `run_id`; the run
/// executes on a detached background task. `List` snapshots every run. `Stop`
/// marks a known run draining. `Watch` is a streaming command handled by the
/// transport layer (Phase C), not this request/response path.
pub async fn handle_request(request: Request, ctx: &Arc<DaemonContext>) -> Response {
    match request {
        Request::Start(start) => {
            let run_id = ctx.registry.gen_run_id(ctx.nonce);
            let cfg = RunConfig::from_start(start, run_id.clone());
            ctx.registry.insert(RunRecord::new(cfg.clone()));
            let ctx = ctx.clone();
            tokio::spawn(async move { execute_run(ctx, cfg).await });
            Response::Started { run_id }
        }
        Request::List => {
            let runs = ctx.registry.list().iter().map(summarize_run).collect();
            Response::Runs(runs)
        }
        Request::Stop { run_id } => match ctx.registry.get(&run_id) {
            Some(_) => {
                // Full graceful drain (signalling swarm pids) lands in Task B9;
                // here we record the intent so `List` reflects a stopping run.
                ctx.registry.set_state(&run_id, RunState::Stopping);
                Response::Stopped
            }
            None => Response::Error(format!("unknown run: {run_id}")),
        },
        Request::Watch { run_id } => {
            Response::Error(format!("watch is a streaming command (run {run_id})"))
        }
    }
}

/// Project a registry record onto its `List` wire summary.
fn summarize_run(record: &RunRecord) -> RunSummary {
    RunSummary {
        run_id: record.run_id.clone(),
        state: record.state.as_str().to_string(),
        mode: record.cfg.mode,
        swarms: record.cfg.swarms,
        aggregate: record.aggregate.as_ref().map(|agg| agg.to_wire()),
    }
}

/// Drive one run's lifecycle: mark it `Running`, spawn the mode-aware swarm set,
/// collect every report, merge into the fleet aggregate, and land on `Finished`
/// (all swarms reported) or `Failed` (any swarm errored). Runs on a detached
/// task; failures are recorded in the registry, never propagated.
async fn execute_run(ctx: Arc<DaemonContext>, cfg: RunConfig) {
    ctx.registry.set_state(&cfg.run_id, RunState::Running);
    let started = Instant::now();
    let results = match cfg.mode {
        SpawnMode::Sequential => run_sequential(&ctx.self_exe, &cfg).await,
        SpawnMode::Replicate | SpawnMode::Distribute => {
            run_replicate_or_distribute(&ctx.self_exe, &cfg).await
        }
    };
    let wall_ms = started.elapsed().as_millis();

    let mut reports: Vec<SwarmReport> = Vec::with_capacity(results.len());
    let mut failure: Option<SwarmError> = None;
    for result in results {
        match result {
            Ok(report) => reports.push(report),
            Err(err) => {
                eprintln!("fleet-superx daemon: run {}: {err}", cfg.run_id);
                if failure.is_none() {
                    failure = Some(err);
                }
            }
        }
    }

    ctx.registry
        .set_aggregate(&cfg.run_id, merge(&reports, wall_ms));
    let terminal = if failure.is_some() {
        RunState::Failed
    } else {
        RunState::Finished
    };
    ctx.registry.set_state(&cfg.run_id, terminal);
}
