//! End-to-end test of `Watch` live streaming over the Unix control plane.
//!
//! Drives the real `serve_unix` accept loop with a live heartbeat sink attached,
//! spawns real `run-swarm` subprocesses (`CARGO_BIN_EXE_fleet-superx`), and
//! asserts that a `Watch` connection streams at least one live `Aggregate` with
//! committed moves and terminates with an `Ended` event when the run finishes.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use fleet_superx::daemon::{serve_unix, DaemonContext};
use fleet_superx::proto::{
    decode_line, encode_line, CohortWire, Request, Response, RunEvent, SpawnMode, StartRun,
};
use fleet_superx::registry::Registry;
use fleet_superx::sink::{serve_sink, Sink};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, UnixListener, UnixStream};

/// A unique per-test socket path under the OS temp dir so concurrent test
/// processes never share a listener.
fn temp_socket() -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut path = std::env::temp_dir();
    path.push(format!(
        "fleet-superx-watch-{}-{}.sock",
        std::process::id(),
        nanos
    ));
    path
}

fn distribute_start() -> Request {
    Request::Start(StartRun {
        mode: SpawnMode::Distribute,
        swarms: 2,
        protocol: "payments.v1".to_string(),
        duration: Duration::from_secs(30),
        until_stop: false,
        tunnels: 4,
        scenario: "golden".to_string(),
        anchor: "memory".to_string(),
        initial_balance: 1_000_000,
        cohorts: CohortWire {
            open_cohort: None,
            open_spacing: Duration::ZERO,
            settle_cohort: None,
            settle_spacing: Duration::ZERO,
        },
        extra: vec![],
    })
}

#[tokio::test]
async fn watch_streams_live_aggregate_until_ended() {
    // A live sink so the daemon threads `--heartbeat-url` into each swarm and
    // `watch` can fold their in-flight telemetry.
    let sink = Sink::new();
    let sink_listener = TcpListener::bind("127.0.0.1:0").await.expect("bind sink");
    let sink_addr = sink_listener.local_addr().expect("sink addr");
    let sink_serve = sink.clone();
    let sink_task = tokio::spawn(async move {
        let _ = serve_sink(sink_listener, sink_serve).await;
    });

    let socket = temp_socket();
    let _ = std::fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket).expect("bind temp unix socket");

    let ctx = Arc::new(DaemonContext {
        registry: Arc::new(Registry::new()),
        self_exe: PathBuf::from(env!("CARGO_BIN_EXE_fleet-superx")),
        nonce: 0xF00D_BEEF,
        sink: Some(sink),
        heartbeat_base: Some(format!("http://{sink_addr}")),
    });
    let serve_ctx = ctx.clone();
    let serve_task = tokio::spawn(async move {
        let _ = serve_unix(listener, serve_ctx).await;
    });

    // Start the run on one connection.
    let start_stream = UnixStream::connect(&socket).await.expect("connect start");
    let mut start_conn = BufReader::new(start_stream);
    start_conn
        .get_mut()
        .write_all(encode_line(&distribute_start()).as_bytes())
        .await
        .expect("send start");
    let mut line = String::new();
    start_conn.read_line(&mut line).await.expect("read started");
    let run_id = match decode_line::<Response>(&line).expect("decode started") {
        Response::Started { run_id } => run_id,
        other => panic!("expected Started, got {other:?}"),
    };

    // Watch on a second connection; the stream stays open until the run ends.
    let watch_stream = UnixStream::connect(&socket).await.expect("connect watch");
    let mut watch_conn = BufReader::new(watch_stream);
    watch_conn
        .get_mut()
        .write_all(
            encode_line(&Request::Watch {
                run_id: run_id.clone(),
            })
            .as_bytes(),
        )
        .await
        .expect("send watch");

    // Collect events until the terminal `Ended` (the only loop exit), reporting
    // whether any streamed aggregate carried committed moves.
    let collect = async {
        let mut saw_aggregate_with_moves = false;
        let mut event_line = String::new();
        loop {
            event_line.clear();
            let read = watch_conn
                .read_line(&mut event_line)
                .await
                .expect("read watch event");
            if read == 0 {
                panic!("watch stream closed before Ended");
            }
            match decode_line::<Response>(&event_line).expect("decode watch event") {
                Response::Event(RunEvent::Aggregate(agg)) => {
                    if agg.moves > 0 {
                        saw_aggregate_with_moves = true;
                    }
                }
                Response::Event(RunEvent::State { .. }) => {}
                Response::Event(RunEvent::Ended { run_id: ended }) => {
                    assert_eq!(ended, run_id, "Ended carries the watched run id");
                    break saw_aggregate_with_moves;
                }
                other => panic!("unexpected watch response: {other:?}"),
            }
        }
    };

    let saw_aggregate_with_moves = tokio::time::timeout(Duration::from_secs(60), collect)
        .await
        .expect("watch stream reached Ended in time");
    assert!(
        saw_aggregate_with_moves,
        "watch streams at least one live aggregate with committed moves"
    );

    serve_task.abort();
    sink_task.abort();
    let _ = std::fs::remove_file(&socket);
}
