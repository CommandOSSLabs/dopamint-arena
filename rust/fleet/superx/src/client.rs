//! `fleet-superx` control-plane client: the `start`, `stop`, and `ls`
//! subcommands.
//!
//! Each command resolves a [`Connect`] target from `--connect` (a Unix socket
//! path, or a `ws://…`/`wss://…` URL; default is the daemon's
//! [`crate::daemon::default_socket`]), sends one [`Request`], and renders the
//! [`Response`]. Transport plumbing lives in [`connect_and_send`] so the Unix and
//! WebSocket clients share one request/response path. `watch` is a streaming
//! command wired in Phase C.

use std::path::{Path, PathBuf};
use std::time::Duration;

use clap::Args;
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio_tungstenite::tungstenite::Message;

use crate::daemon::default_socket;
use crate::proto::{
    decode_line, encode_line, CohortWire, Request, Response, RunEvent, SpawnMode, StartRun,
};

/// `fleet-superx start`: describe a run and hand it to the daemon.
#[derive(Args)]
pub struct StartArgs {
    /// Control endpoint: a Unix socket path or a `ws://HOST:PORT` URL. Defaults
    /// to the daemon's standard Unix socket.
    #[arg(long)]
    connect: Option<String>,
    /// Spawn mode: `replicate`, `distribute`, or `sequential`.
    #[arg(long, default_value = "replicate")]
    mode: String,
    /// Number of swarm processes to spawn.
    #[arg(long, default_value_t = 1)]
    swarms: u64,
    /// Protocol id each swarm plays (e.g. `blackjack.v2`, `payments.v1`).
    #[arg(long)]
    protocol: String,
    /// Wall-clock budget like `30s`, `10m`, `1h` (bare number = seconds).
    #[arg(long = "for")]
    for_dur: Option<String>,
    /// Run until an explicit `stop` (no deadline).
    #[arg(long)]
    until_stop: bool,
    /// Per-swarm tunnel count (split across swarms in `distribute` mode).
    #[arg(long, default_value_t = 1)]
    tunnels: u64,
    /// Gameplay scenario: `golden` (fixed seed) or `varied`.
    #[arg(long, default_value = "golden")]
    scenario: String,
    /// Settlement anchor: `memory` or `sui-sponsored`.
    #[arg(long, default_value = "memory")]
    anchor: String,
    /// Starting balance per seat.
    #[arg(long, default_value_t = 1_000_000)]
    initial_balance: u64,
    /// Max concurrent opens in flight (unset = no cap).
    #[arg(long)]
    open_cohort: Option<usize>,
    /// Delay between open cohorts, milliseconds.
    #[arg(long, default_value_t = 0)]
    open_spacing_ms: u64,
    /// Max concurrent settles in flight (unset = no cap).
    #[arg(long)]
    settle_cohort: Option<usize>,
    /// Delay between settle cohorts, milliseconds.
    #[arg(long, default_value_t = 0)]
    settle_spacing_ms: u64,
    /// Extra args forwarded verbatim to each `run-swarm` (after a `--`).
    #[arg(last = true)]
    extra: Vec<String>,
}

/// `fleet-superx stop`: request a graceful drain of one run.
#[derive(Args)]
pub struct StopArgs {
    #[arg(long)]
    connect: Option<String>,
    /// Run id to stop.
    run_id: String,
}

/// `fleet-superx ls`: list every run the daemon knows about.
#[derive(Args)]
pub struct LsArgs {
    #[arg(long)]
    connect: Option<String>,
}

/// `fleet-superx watch`: stream a run's live monitoring (Phase C).
#[derive(Args)]
pub struct WatchArgs {
    #[arg(long)]
    connect: Option<String>,
    /// Run id to watch.
    run_id: String,
}

/// A resolved control endpoint. `ws://`/`wss://` targets speak WebSocket;
/// everything else is a Unix socket path.
#[derive(Clone, Debug)]
pub enum Connect {
    Unix(PathBuf),
    Ws(String),
}

/// Resolve the `--connect` string into a transport target. A missing value
/// defaults to the daemon's standard Unix socket; a `ws://`/`wss://` prefix
/// selects WebSocket; anything else is treated as a Unix socket path.
pub fn resolve_connect(connect: Option<&str>) -> Connect {
    match connect {
        None => Connect::Unix(default_socket()),
        Some(s) if s.starts_with("ws://") || s.starts_with("wss://") => Connect::Ws(s.to_string()),
        Some(s) => Connect::Unix(PathBuf::from(s)),
    }
}

/// Open one connection to `target`, send `req`, and collect the response(s).
///
/// For the request/response commands (`start`/`stop`/`ls`) exactly one
/// [`Response`] comes back; it is returned as a single-element vector so a future
/// streaming command (`watch`) can share this entry point. Every failure —
/// connect, encode, transport, decode — is flattened to a human string.
pub async fn connect_and_send(target: Connect, req: Request) -> Result<Vec<Response>, String> {
    match target {
        Connect::Unix(path) => unix_request(&path, req).await,
        Connect::Ws(url) => ws_request(&url, req).await,
    }
}

/// One newline-framed request/response exchange over a Unix socket.
async fn unix_request(path: &Path, req: Request) -> Result<Vec<Response>, String> {
    let stream = UnixStream::connect(path)
        .await
        .map_err(|e| format!("connect {}: {e}", path.display()))?;
    let mut conn = BufReader::new(stream);
    conn.get_mut()
        .write_all(encode_line(&req).as_bytes())
        .await
        .map_err(|e| format!("send request: {e}"))?;
    let mut line = String::new();
    let read = conn
        .read_line(&mut line)
        .await
        .map_err(|e| format!("read response: {e}"))?;
    if read == 0 {
        return Err("daemon closed the connection without responding".to_string());
    }
    let response = decode_line::<Response>(&line).map_err(|e| format!("decode response: {e}"))?;
    Ok(vec![response])
}

/// One text-frame request/response exchange over WebSocket.
async fn ws_request(url: &str, req: Request) -> Result<Vec<Response>, String> {
    let (mut ws, _upgrade) = tokio_tungstenite::connect_async(url)
        .await
        .map_err(|e| format!("connect {url}: {e}"))?;
    ws.send(Message::Text(encode_line(&req)))
        .await
        .map_err(|e| format!("send request: {e}"))?;
    // Skip control frames (ping/pong) until the first text frame carries the
    // JSON response.
    loop {
        match ws.next().await {
            Some(Ok(Message::Text(text))) => {
                let response =
                    decode_line::<Response>(&text).map_err(|e| format!("decode response: {e}"))?;
                return Ok(vec![response]);
            }
            Some(Ok(Message::Close(_))) | None => {
                return Err("daemon closed the connection without responding".to_string());
            }
            Some(Ok(_)) => continue,
            Some(Err(e)) => return Err(format!("ws transport: {e}")),
        }
    }
}

impl StartArgs {
    /// Build the wire [`StartRun`] this command asks the daemon to run. Fails on
    /// an unknown `--mode` or malformed `--for` duration.
    fn to_start_run(&self) -> Result<StartRun, String> {
        let mode = parse_mode(&self.mode)?;
        let duration = match &self.for_dur {
            Some(spec) => parse_duration(spec)?,
            None => Duration::ZERO,
        };
        Ok(StartRun {
            mode,
            swarms: self.swarms,
            protocol: self.protocol.clone(),
            duration,
            until_stop: self.until_stop,
            tunnels: self.tunnels,
            scenario: self.scenario.clone(),
            anchor: self.anchor.clone(),
            initial_balance: self.initial_balance,
            cohorts: CohortWire {
                open_cohort: self.open_cohort,
                open_spacing: Duration::from_millis(self.open_spacing_ms),
                settle_cohort: self.settle_cohort,
                settle_spacing: Duration::from_millis(self.settle_spacing_ms),
            },
            extra: self.extra.clone(),
        })
    }
}

/// Parse a `--mode` string into a [`SpawnMode`].
fn parse_mode(mode: &str) -> Result<SpawnMode, String> {
    match mode {
        "replicate" => Ok(SpawnMode::Replicate),
        "distribute" => Ok(SpawnMode::Distribute),
        "sequential" => Ok(SpawnMode::Sequential),
        other => Err(format!(
            "unknown mode '{other}' (expected replicate|distribute|sequential)"
        )),
    }
}

/// Parse a human duration: a bare integer (seconds) or an integer with a `s`,
/// `m`, or `h` suffix (e.g. `30s`, `10m`, `1h`).
fn parse_duration(spec: &str) -> Result<Duration, String> {
    let spec = spec.trim();
    if spec.is_empty() {
        return Err("empty duration".to_string());
    }
    let split = spec
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(spec.len());
    let (digits, unit) = spec.split_at(split);
    let value: u64 = digits
        .parse()
        .map_err(|_| format!("invalid duration '{spec}'"))?;
    let secs = match unit.trim() {
        "" | "s" => value,
        "m" => value.saturating_mul(60),
        "h" => value.saturating_mul(3600),
        other => return Err(format!("unknown duration unit '{other}' (expected s|m|h)")),
    };
    Ok(Duration::from_secs(secs))
}

/// Run one client exchange on a short-lived current-thread runtime. The `*_main`
/// entry points are synchronous (clap dispatch), so each builds its own runtime
/// rather than requiring an ambient one.
fn exchange(target: Connect, req: Request) -> Result<Vec<Response>, String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("build runtime: {e}"))?;
    runtime.block_on(connect_and_send(target, req))
}

/// Render one response to stdout; returns `true` when it is an `Error` so the
/// caller can exit non-zero.
fn render_response(response: &Response) -> bool {
    match response {
        Response::Started { run_id } => {
            println!("started {run_id}");
            false
        }
        Response::Stopped => {
            println!("stopping");
            false
        }
        Response::Runs(runs) => {
            if runs.is_empty() {
                println!("no runs");
            } else {
                for run in runs {
                    match &run.aggregate {
                        Some(agg) => println!(
                            "{}  {}  {}  swarms={}  settled={}  tps={:.1}",
                            run.run_id,
                            run.state,
                            mode_label(run.mode),
                            run.swarms,
                            agg.tunnels_settled,
                            agg.wall_move_tps,
                        ),
                        None => println!(
                            "{}  {}  {}  swarms={}",
                            run.run_id,
                            run.state,
                            mode_label(run.mode),
                            run.swarms,
                        ),
                    }
                }
            }
            false
        }
        Response::Event(event) => {
            println!("{event:?}");
            false
        }
        Response::Error(message) => {
            eprintln!("error: {message}");
            true
        }
    }
}

/// Human label for a [`SpawnMode`] in list output.
fn mode_label(mode: SpawnMode) -> &'static str {
    match mode {
        SpawnMode::Replicate => "replicate",
        SpawnMode::Distribute => "distribute",
        SpawnMode::Sequential => "sequential",
    }
}

/// Send `req` to `target`, render every response, and map to a process exit code
/// (0 ok, 1 on transport failure or an `Error` response).
fn dispatch(target: Connect, req: Request) -> i32 {
    match exchange(target, req) {
        Ok(responses) => {
            let mut had_error = false;
            for response in &responses {
                had_error |= render_response(response);
            }
            i32::from(had_error)
        }
        Err(err) => {
            eprintln!("fleet-superx: {err}");
            1
        }
    }
}

/// `fleet-superx start` entry point.
pub fn start_main(args: StartArgs) -> i32 {
    let start = match args.to_start_run() {
        Ok(start) => start,
        Err(err) => {
            eprintln!("fleet-superx start: {err}");
            return 2;
        }
    };
    let target = resolve_connect(args.connect.as_deref());
    dispatch(target, Request::Start(start))
}

/// `fleet-superx stop` entry point.
pub fn stop_main(args: StopArgs) -> i32 {
    let target = resolve_connect(args.connect.as_deref());
    dispatch(
        target,
        Request::Stop {
            run_id: args.run_id,
        },
    )
}

/// `fleet-superx ls` entry point.
pub fn ls_main(args: LsArgs) -> i32 {
    let target = resolve_connect(args.connect.as_deref());
    dispatch(target, Request::List)
}

/// `fleet-superx watch` entry point: stream a run's live monitoring, printing a
/// line per event until the terminal `Ended`. Returns 0 on a clean end, 1 on a
/// transport failure or an `Error` response from the daemon.
pub fn watch_main(args: WatchArgs) -> i32 {
    let target = resolve_connect(args.connect.as_deref());
    let req = Request::Watch {
        run_id: args.run_id,
    };
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(err) => {
            eprintln!("fleet-superx watch: build runtime: {err}");
            return 1;
        }
    };
    match runtime.block_on(watch_stream(target, req)) {
        Ok(()) => 0,
        Err(err) => {
            eprintln!("fleet-superx: {err}");
            1
        }
    }
}

/// Stream watch events from `target`, printing each until `Ended`. Shared entry
/// for both transports so Unix and WebSocket clients render identically.
async fn watch_stream(target: Connect, req: Request) -> Result<(), String> {
    match target {
        Connect::Unix(path) => watch_unix(&path, req).await,
        Connect::Ws(url) => watch_ws(&url, req).await,
    }
}

/// Stream watch events over a Unix socket until `Ended` or an error.
async fn watch_unix(path: &Path, req: Request) -> Result<(), String> {
    let stream = UnixStream::connect(path)
        .await
        .map_err(|e| format!("connect {}: {e}", path.display()))?;
    let mut conn = BufReader::new(stream);
    conn.get_mut()
        .write_all(encode_line(&req).as_bytes())
        .await
        .map_err(|e| format!("send watch: {e}"))?;
    let mut line = String::new();
    loop {
        line.clear();
        let read = conn
            .read_line(&mut line)
            .await
            .map_err(|e| format!("read watch event: {e}"))?;
        if read == 0 {
            return Err("daemon closed the watch stream before it ended".to_string());
        }
        let response = decode_line::<Response>(&line).map_err(|e| format!("decode event: {e}"))?;
        if render_watch_event(&response)? {
            return Ok(());
        }
    }
}

/// Stream watch events over WebSocket until `Ended` or an error.
async fn watch_ws(url: &str, req: Request) -> Result<(), String> {
    let (mut ws, _upgrade) = tokio_tungstenite::connect_async(url)
        .await
        .map_err(|e| format!("connect {url}: {e}"))?;
    ws.send(Message::Text(encode_line(&req)))
        .await
        .map_err(|e| format!("send watch: {e}"))?;
    loop {
        match ws.next().await {
            Some(Ok(Message::Text(text))) => {
                let response =
                    decode_line::<Response>(&text).map_err(|e| format!("decode event: {e}"))?;
                if render_watch_event(&response)? {
                    return Ok(());
                }
            }
            Some(Ok(Message::Close(_))) | None => {
                return Err("daemon closed the watch stream before it ended".to_string());
            }
            // Skip control frames (ping/pong auto-handled) and non-text payloads.
            Some(Ok(_)) => continue,
            Some(Err(e)) => return Err(format!("ws transport: {e}")),
        }
    }
}

/// Render one streamed watch event. Returns `Ok(true)` on the terminal `Ended`
/// (stop streaming), `Ok(false)` to keep streaming, or `Err` on an `Error`
/// response from the daemon.
fn render_watch_event(response: &Response) -> Result<bool, String> {
    match response {
        Response::Event(RunEvent::State { run_id, state }) => {
            println!("[{run_id}] {state}");
            Ok(false)
        }
        Response::Event(RunEvent::Aggregate(agg)) => {
            println!(
                "  moves={} settled={} opened={} tps={:.1}",
                agg.moves, agg.tunnels_settled, agg.tunnels_opened, agg.wall_move_tps
            );
            Ok(false)
        }
        Response::Event(RunEvent::Ended { run_id }) => {
            println!("[{run_id}] ended");
            Ok(true)
        }
        Response::Error(message) => Err(message.clone()),
        other => {
            // A non-event response on a watch stream is unexpected but harmless;
            // surface it rather than dropping it.
            println!("{other:?}");
            Ok(false)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::daemon::{serve_unix, DaemonContext};
    use crate::proto::{CohortWire, Request, Response, SpawnMode, StartRun};
    use crate::registry::Registry;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::Duration;

    fn temp_socket() -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let mut path = std::env::temp_dir();
        path.push(format!(
            "fleet-superx-client-{}-{}.sock",
            std::process::id(),
            nanos
        ));
        path
    }

    fn memory_start() -> StartRun {
        StartRun {
            mode: SpawnMode::Distribute,
            swarms: 1,
            protocol: "payments.v1".to_string(),
            duration: Duration::ZERO,
            until_stop: false,
            tunnels: 1,
            scenario: "golden".to_string(),
            anchor: "memory".to_string(),
            initial_balance: 1_000,
            cohorts: CohortWire {
                open_cohort: None,
                open_spacing: Duration::ZERO,
                settle_cohort: None,
                settle_spacing: Duration::ZERO,
            },
            extra: vec![],
        }
    }

    /// The client's `connect_and_send` speaks the real Unix control plane: a
    /// `Start` returns a `run_id` the daemon then lists. A bogus `self_exe` keeps
    /// the test hermetic — the accepted run fails to spawn, but is still recorded
    /// and listed, which is all this exercises.
    #[tokio::test]
    async fn start_then_list_round_trips_over_unix() {
        let socket = temp_socket();
        let _ = std::fs::remove_file(&socket);
        let listener = tokio::net::UnixListener::bind(&socket).expect("bind temp socket");
        let ctx = Arc::new(DaemonContext {
            registry: Arc::new(Registry::new()),
            self_exe: PathBuf::from("/nonexistent/fleet-superx-not-here"),
            nonce: 0x9999,
            sink: None,
            heartbeat_base: None,
        });
        let serve_ctx = ctx.clone();
        tokio::spawn(async move {
            let _ = serve_unix(listener, serve_ctx).await;
        });

        let started = connect_and_send(
            Connect::Unix(socket.clone()),
            Request::Start(memory_start()),
        )
        .await
        .expect("start round-trips");
        let run_id = match started.as_slice() {
            [Response::Started { run_id }] => run_id.clone(),
            other => panic!("expected [Started], got {other:?}"),
        };

        let listed = connect_and_send(Connect::Unix(socket.clone()), Request::List)
            .await
            .expect("list round-trips");
        let Response::Runs(runs) = &listed[0] else {
            panic!("expected Runs, got {listed:?}");
        };
        assert!(
            runs.iter().any(|r| r.run_id == run_id),
            "started run appears in list"
        );
    }

    #[test]
    fn resolve_connect_picks_transport() {
        assert!(matches!(resolve_connect(None), Connect::Unix(_)));
        assert!(matches!(
            resolve_connect(Some("ws://127.0.0.1:9000")),
            Connect::Ws(_)
        ));
        assert!(matches!(
            resolve_connect(Some("/run/fleet.sock")),
            Connect::Unix(_)
        ));
    }

    #[test]
    fn parse_duration_accepts_units() {
        assert_eq!(parse_duration("45").unwrap(), Duration::from_secs(45));
        assert_eq!(parse_duration("30s").unwrap(), Duration::from_secs(30));
        assert_eq!(parse_duration("10m").unwrap(), Duration::from_secs(600));
        assert_eq!(parse_duration("2h").unwrap(), Duration::from_secs(7200));
        assert!(parse_duration("5d").is_err());
        assert!(parse_duration("abc").is_err());
    }

    #[test]
    fn parse_mode_rejects_unknown() {
        assert_eq!(parse_mode("distribute").unwrap(), SpawnMode::Distribute);
        assert!(parse_mode("nope").is_err());
    }
}
