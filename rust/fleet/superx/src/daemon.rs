//! Supervisor daemon: the Unix-socket control plane and run executor.
//!
//! `fleet-superx daemon` binds a Unix socket and accepts newline-delimited
//! [`Request`] frames. Each connection is served independently: a `Start`
//! accepts the run, spawns the mode-aware swarm set on a background task, and
//! replies `Started` immediately; the background task drives the run's
//! lifecycle in the shared [`Registry`] (`Running` → collect reports → `merge`
//! → `Finished`/`Failed`). `List` snapshots every run; `Stop` marks a run
//! draining. The WebSocket transport ([`serve_ws`]) reuses [`handle_request`] so
//! both surfaces stay byte-for-byte identical; `daemon --ws ADDR` runs it
//! concurrently with the Unix listener.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use clap::Args;
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream, UnixListener, UnixStream};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::merge::merge;
use crate::proto::SpawnMode;
use crate::proto::{
    decode_line, encode_line, Request, Response, RunAggregateWire, RunEvent, RunSummary,
};
use crate::registry::{Registry, RunRecord, RunState};
use crate::runconfig::RunConfig;
use crate::sink::{serve_sink, Sink};
use crate::spawn::{
    run_replicate_or_distribute_observed, run_sequential_observed, self_exe, signal_swarm,
    SwarmError, SwarmProgressObserver,
};
use crate::swarm::report::SwarmReport;

/// Default control socket: `$XDG_RUNTIME_DIR/fleet-superx.sock` when the runtime
/// dir is set (per-user, cleaned on logout), else `/tmp/fleet-superx.sock`.
/// Shared by the daemon (bind default) and the client (connect default) so both
/// agree on the same path with no flags.
pub fn default_socket() -> PathBuf {
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
    /// Live heartbeat sink, present when the daemon was started with
    /// `--sink-addr`. Held here so `watch` (Phase C3) can read live aggregates;
    /// [`serve_sink`] holds a clone that folds incoming heartbeats.
    pub sink: Option<Sink>,
    /// Sink root (`http://<sink-addr>`) forwarded into each run's [`RunConfig`] so
    /// spawned swarms post run-scoped telemetry. `None` when no sink runs.
    pub heartbeat_base: Option<String>,
}

impl DaemonContext {
    /// Build a context rooted at this process's own executable (spawned as the
    /// `run-swarm` worker) with a fresh per-process id nonce. Telemetry is off
    /// until [`daemon_main`] binds a sink and sets [`DaemonContext::sink`] /
    /// [`DaemonContext::heartbeat_base`].
    pub fn new() -> Self {
        Self {
            registry: Arc::new(Registry::new()),
            self_exe: self_exe(),
            nonce: process_nonce(),
            sink: None,
            heartbeat_base: None,
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
        let mut ctx = DaemonContext::new();

        // Optionally bind the localhost heartbeat sink before serving so a bind
        // failure aborts startup. The sink runs on a detached task (auxiliary
        // telemetry, not the control plane); its root is threaded into each run so
        // spawned swarms post run-scoped heartbeats.
        if let Some(sink_addr) = &a.sink_addr {
            let sink_listener = match TcpListener::bind(sink_addr).await {
                Ok(listener) => listener,
                Err(err) => {
                    eprintln!("fleet-superx daemon: failed to bind sink {sink_addr}: {err}");
                    return 1;
                }
            };
            let bound = match sink_listener.local_addr() {
                Ok(addr) => addr,
                Err(err) => {
                    eprintln!("fleet-superx daemon: sink addr unavailable: {err}");
                    return 1;
                }
            };
            eprintln!("fleet-superx daemon: heartbeat sink listening on {bound}");
            let sink = Sink::new();
            ctx.sink = Some(sink.clone());
            ctx.heartbeat_base = Some(format!("http://{bound}"));
            tokio::spawn(async move {
                if let Err(err) = serve_sink(sink_listener, sink).await {
                    eprintln!("fleet-superx daemon: heartbeat sink stopped: {err}");
                }
            });
        }
        let ctx = Arc::new(ctx);

        // Optionally bind the WebSocket control listener before serving so a bind
        // failure aborts startup rather than surfacing mid-run.
        let ws_listener = match &a.ws {
            Some(addr) => match TcpListener::bind(addr).await {
                Ok(listener) => {
                    eprintln!("fleet-superx daemon: websocket listening on {addr}");
                    Some(listener)
                }
                Err(err) => {
                    eprintln!("fleet-superx daemon: failed to bind ws {addr}: {err}");
                    return 1;
                }
            },
            None => None,
        };

        // Serve both transports concurrently; either accept loop erroring out is
        // a fatal control-plane failure.
        let unix = serve_unix(listener, ctx.clone());
        let result = match ws_listener {
            Some(ws_listener) => {
                let ws = serve_ws(ws_listener, ctx);
                tokio::select! {
                    r = unix => r,
                    r = ws => r,
                }
            }
            None => unix.await,
        };
        if let Err(err) = result {
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
        // `Watch` holds the connection open, streaming many events; every other
        // request is a single request/response exchange.
        match decode_line::<Request>(&line) {
            Ok(Request::Watch { run_id }) => {
                let mut events = spawn_watch(run_id, ctx.clone());
                while let Some(event) = events.recv().await {
                    conn.get_mut()
                        .write_all(encode_line(&event).as_bytes())
                        .await?;
                }
            }
            Ok(request) => {
                let response = handle_request(request, &ctx).await;
                conn.get_mut()
                    .write_all(encode_line(&response).as_bytes())
                    .await?;
            }
            Err(err) => {
                let response = Response::Error(format!("malformed request: {err}"));
                conn.get_mut()
                    .write_all(encode_line(&response).as_bytes())
                    .await?;
            }
        }
    }
}

/// Accept and serve WebSocket control connections on `listener` until it errors.
/// The remote transport mirrors [`serve_unix`]: each connection runs on its own
/// task and dispatches through the shared [`handle_request`], so Unix and remote
/// clients observe byte-for-byte identical behavior. Factored out of
/// [`daemon_main`] so integration tests can drive it on an ephemeral loopback
/// port (`127.0.0.1:0`).
pub async fn serve_ws(listener: TcpListener, ctx: Arc<DaemonContext>) -> std::io::Result<()> {
    loop {
        let (stream, _addr) = listener.accept().await?;
        let ctx = ctx.clone();
        tokio::spawn(async move {
            if let Err(err) = serve_ws_connection(stream, ctx).await {
                eprintln!("fleet-superx daemon: ws connection error: {err}");
            }
        });
    }
}

/// Upgrade one TCP connection to WebSocket and serve control frames. Each text
/// frame carries one JSON [`Request`]; the matching [`Response`] is written back
/// as a text frame. Non-text frames (ping/pong/binary) are ignored; a close
/// frame ends the connection.
async fn serve_ws_connection(
    stream: TcpStream,
    ctx: Arc<DaemonContext>,
) -> Result<(), tokio_tungstenite::tungstenite::Error> {
    let mut ws = tokio_tungstenite::accept_async(stream).await?;
    while let Some(message) = ws.next().await {
        match message? {
            Message::Text(text) => {
                if text.trim().is_empty() {
                    continue;
                }
                // `Watch` streams a run's live events until it ends; other requests
                // are single request/response exchanges.
                match decode_line::<Request>(&text) {
                    Ok(Request::Watch { run_id }) => {
                        let mut events = spawn_watch(run_id, ctx.clone());
                        while let Some(event) = events.recv().await {
                            ws.send(Message::Text(encode_line(&event))).await?;
                        }
                    }
                    Ok(request) => {
                        let response = handle_request(request, &ctx).await;
                        ws.send(Message::Text(encode_line(&response))).await?;
                    }
                    Err(err) => {
                        let response = Response::Error(format!("malformed request: {err}"));
                        ws.send(Message::Text(encode_line(&response))).await?;
                    }
                }
            }
            Message::Close(_) => return Ok(()),
            // Ping is auto-ponged by tungstenite; other frames carry no request.
            _ => {}
        }
    }
    Ok(())
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
            let mut cfg = RunConfig::from_start(start, run_id.clone());
            // Point this run's swarms at the daemon's sink (if one runs) so their
            // heartbeats fold into a live aggregate keyed by this run id.
            cfg.heartbeat_sink = ctx.heartbeat_base.clone();
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
            Some(record) => {
                // Mark the run draining, then SIGTERM each swarm so it finishes
                // its current phase and settles (no half-open tunnels). The
                // detached `execute_run` task then collects the drained reports
                // and lands the run in Finished. A pid that already exited yields
                // ESRCH, which `signal_swarm` treats as success.
                ctx.registry.set_state(&run_id, RunState::Stopping);
                for pid in record.swarm_pids {
                    if let Err(err) = signal_swarm(pid) {
                        eprintln!("fleet-superx daemon: stop {run_id}: signal {pid}: {err}");
                    }
                }
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

/// Polling cadence for a `Watch` stream: how often the daemon samples the run's
/// state + live aggregate and emits an event. Small enough to feel live, large
/// enough not to spin.
const WATCH_INTERVAL: Duration = Duration::from_millis(100);

/// Depth of the per-watch event channel. Events are tiny and emitted on a slow
/// cadence, so a few slots absorb transient transport-write latency without the
/// producer ever blocking the run.
const WATCH_CHANNEL_DEPTH: usize = 16;

/// Spawn a background task that streams one run's live monitoring into a channel,
/// returning the receiver the transport drains onto the client. The task samples
/// the registry (lifecycle) and the sink (live aggregate) every [`WATCH_INTERVAL`],
/// emitting a `State` event on each transition, an `Aggregate` event per tick, and
/// a terminal `Ended` once the run finishes (or immediately if it is unknown). It
/// exits when the run ends or the receiver is dropped (client hung up), so no
/// watch task outlives its connection.
fn spawn_watch(run_id: String, ctx: Arc<DaemonContext>) -> mpsc::Receiver<Response> {
    let (tx, rx) = mpsc::channel(WATCH_CHANNEL_DEPTH);
    tokio::spawn(async move { watch_loop(run_id, ctx, tx).await });
    rx
}

/// Body of a watch stream: emit lifecycle transitions and live aggregates until
/// the run reaches a terminal state, closing with `Ended`. A `send` failure means
/// the client disconnected, which ends the loop.
async fn watch_loop(run_id: String, ctx: Arc<DaemonContext>, tx: mpsc::Sender<Response>) {
    let mut ticker = tokio::time::interval(WATCH_INTERVAL);
    let mut last_state: Option<RunState> = None;
    loop {
        ticker.tick().await;
        let Some(record) = ctx.registry.get(&run_id) else {
            // The run vanished (or was never known): report and end the stream.
            let _ = tx
                .send(Response::Error(format!("unknown run: {run_id}")))
                .await;
            let _ = tx
                .send(Response::Event(RunEvent::Ended {
                    run_id: run_id.clone(),
                }))
                .await;
            return;
        };

        if last_state != Some(record.state) {
            last_state = Some(record.state);
            let event = Response::Event(RunEvent::State {
                run_id: run_id.clone(),
                state: record.state.as_str().to_string(),
            });
            if tx.send(event).await.is_err() {
                return; // client hung up
            }
        }

        if let Some(aggregate) = watch_aggregate(&ctx, &record) {
            if tx
                .send(Response::Event(RunEvent::Aggregate(aggregate)))
                .await
                .is_err()
            {
                return;
            }
        }

        if matches!(record.state, RunState::Finished | RunState::Failed) {
            let _ = tx
                .send(Response::Event(RunEvent::Ended {
                    run_id: run_id.clone(),
                }))
                .await;
            return;
        }
    }
}

/// The aggregate a watch tick reports: the authoritative merged rollup once the
/// run has finished (attached to the record), else a best-effort projection of
/// the sink's live [`crate::sink::LiveAggregate`] while the run is still in
/// flight. `None` before any live telemetry exists (early ticks, no sink).
fn watch_aggregate(ctx: &Arc<DaemonContext>, record: &RunRecord) -> Option<RunAggregateWire> {
    if let Some(aggregate) = &record.aggregate {
        return Some(aggregate.to_wire());
    }
    let live = ctx.sink.as_ref()?.snapshot(&record.run_id)?;
    // Only `moves` and `tunnels_settled` are known in flight; the remaining
    // rollup fields land with the merged aggregate at completion.
    Some(RunAggregateWire {
        swarms: record.cfg.swarms,
        tunnels_opened: 0,
        tunnels_settled: live.tunnels_settled,
        tunnels_failed: 0,
        tunnels_aborted: 0,
        moves: live.moves,
        wall_ms: 0,
        wall_move_tps: 0.0,
        cpu_cores_avg: 0.0,
        rss_peak_bytes: 0,
    })
}

/// Records each swarm's pid into the registry as it spawns, and flips the run to
/// `Running` only once a swarm reports it has begun play (its graceful-stop
/// handler installed). Announcing `Running` on readiness — not on spawn —
/// guarantees a `Stop` observed as `running` reaches a swarm that will drain
/// gracefully, with its pid already recorded to signal.
struct RegistryProgressObserver {
    registry: Arc<Registry>,
    run_id: String,
    pids: std::sync::Mutex<Vec<u32>>,
}

impl RegistryProgressObserver {
    fn new(registry: Arc<Registry>, run_id: String) -> Self {
        Self {
            registry,
            run_id,
            pids: std::sync::Mutex::new(Vec::new()),
        }
    }
}

impl SwarmProgressObserver for RegistryProgressObserver {
    fn swarm_spawned(&self, _swarm_index: u64, pid: u32) {
        let pids = {
            let mut guard = self.pids.lock().expect("pid observer lock poisoned");
            guard.push(pid);
            guard.clone()
        };
        // Record the pid so a stop can signal it; the run is still `Starting`
        // until the swarm confirms readiness below.
        self.registry.set_pids(&self.run_id, pids);
    }

    fn swarm_ready(&self, _swarm_index: u64) {
        // The swarm is playing with its stop handler installed (idempotent after
        // the first swarm).
        self.registry.set_state(&self.run_id, RunState::Running);
    }
}

/// Drive one run's lifecycle: spawn the mode-aware swarm set (flipping the run to
/// `Running` as its swarms come up and recording their pids for `stop`), collect
/// every report, merge into the fleet aggregate, and land on `Finished` (all
/// swarms reported) or `Failed` (any swarm errored). Runs on a detached task;
/// failures are recorded in the registry, never propagated.
async fn execute_run(ctx: Arc<DaemonContext>, cfg: RunConfig) {
    let started = Instant::now();
    let observer = RegistryProgressObserver::new(ctx.registry.clone(), cfg.run_id.clone());
    let results = match cfg.mode {
        SpawnMode::Sequential => run_sequential_observed(&ctx.self_exe, &cfg, &observer).await,
        SpawnMode::Replicate | SpawnMode::Distribute => {
            run_replicate_or_distribute_observed(&ctx.self_exe, &cfg, &observer).await
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
