//! End-to-end control-plane test over the Unix socket transport.
//!
//! Drives the real `serve_unix` accept loop on a temp socket (never a fixed
//! shared path) and spawns real `run-swarm` subprocesses via the in-crate
//! binary (`CARGO_BIN_EXE_fleet-superx`). Asserts a `distribute` run over the
//! memory anchor reaches `Finished` with all tunnels conserved end-to-end.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use fleet_superx::daemon::{serve_unix, DaemonContext};
use fleet_superx::proto::{
    decode_line, encode_line, CohortWire, Request, Response, SpawnMode, StartRun,
};
use fleet_superx::registry::Registry;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};

/// A unique per-test socket path under the OS temp dir so concurrent test
/// processes never share a listener.
fn temp_socket() -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut path = std::env::temp_dir();
    path.push(format!(
        "fleet-superx-unix-{}-{}.sock",
        std::process::id(),
        nanos
    ));
    path
}

fn distribute_start() -> Request {
    Request::Start(StartRun {
        mode: SpawnMode::Distribute,
        swarms: 2,
        // payments.v1 is the memory-anchor protocol the swarm pipeline exercises;
        // the daemon control plane under test is protocol-agnostic.
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
async fn daemon_runs_distribute_to_completion_over_unix() {
    let socket = temp_socket();
    let _ = std::fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket).expect("bind temp unix socket");

    let ctx = Arc::new(DaemonContext {
        registry: Arc::new(Registry::new()),
        // The test binary can't `run-swarm`; spawn the real in-crate binary.
        self_exe: PathBuf::from(env!("CARGO_BIN_EXE_fleet-superx")),
        nonce: 0x1234_5678,
        sink: None,
        heartbeat_base: None,
    });
    let serve_ctx = ctx.clone();
    tokio::spawn(async move {
        let _ = serve_unix(listener, serve_ctx).await;
    });

    let stream = UnixStream::connect(&socket).await.expect("connect unix");
    let mut conn = BufReader::new(stream);

    conn.get_mut()
        .write_all(encode_line(&distribute_start()).as_bytes())
        .await
        .expect("send start");
    let mut line = String::new();
    conn.read_line(&mut line).await.expect("read started");
    let run_id = match decode_line::<Response>(&line).expect("decode started") {
        Response::Started { run_id } => run_id,
        other => panic!("expected Started, got {other:?}"),
    };

    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        assert!(Instant::now() < deadline, "run did not finish in time");
        conn.get_mut()
            .write_all(encode_line(&Request::List).as_bytes())
            .await
            .expect("send list");
        line.clear();
        conn.read_line(&mut line).await.expect("read runs");
        let Response::Runs(runs) = decode_line::<Response>(&line).expect("decode runs") else {
            panic!("expected Runs response");
        };
        let run = runs
            .iter()
            .find(|r| r.run_id == run_id)
            .expect("started run is listed");
        assert_ne!(run.state, "failed", "run failed unexpectedly");
        if run.state == "finished" {
            let agg = run.aggregate.as_ref().expect("finished run has aggregate");
            assert_eq!(agg.tunnels_settled, 4, "all tunnels settle end-to-end");
            assert_eq!(agg.tunnels_opened, 4);
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
