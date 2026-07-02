//! Graceful-stop end-to-end over the Unix control plane.
//!
//! Drives the real `serve_unix` accept loop on a temp socket and spawns a real,
//! effectively-unbounded `run-swarm` subprocess via the in-crate binary
//! (`CARGO_BIN_EXE_fleet-superx`). Asserts that `Stop` propagates SIGTERM to the
//! swarm, which drains its current phase and settles, so the run lands in
//! `Finished` with every opened tunnel settled — no half-open tunnels.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use fleet_superx::daemon::{serve_unix, DaemonContext};
use fleet_superx::proto::{
    decode_line, encode_line, CohortWire, Request, Response, RunSummary, SpawnMode, StartRun,
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
        "fleet-superx-stop-{}-{}.sock",
        std::process::id(),
        nanos
    ));
    path
}

/// A run that will not self-terminate within the test window: `until_stop` with a
/// huge transfer cap, so the swarm keeps playing until SIGTERM drains it. Only a
/// working graceful stop can bring it to `Finished` in time.
fn unbounded_start() -> Request {
    Request::Start(StartRun {
        mode: SpawnMode::Replicate,
        swarms: 1,
        protocol: "payments.v1".to_string(),
        duration: Duration::from_secs(0),
        until_stop: true,
        tunnels: 2,
        scenario: "golden".to_string(),
        anchor: "memory".to_string(),
        initial_balance: 1_000_000,
        cohorts: CohortWire {
            open_cohort: None,
            open_spacing: Duration::ZERO,
            settle_cohort: None,
            settle_spacing: Duration::ZERO,
        },
        // The daemon path never emits `--moves`; forward a large cap so payments
        // plays effectively forever until the graceful stop cuts it short.
        extra: vec!["--moves".to_string(), "500000000".to_string()],
    })
}

/// Send one request and read exactly one response line back on the connection.
async fn round_trip(conn: &mut BufReader<UnixStream>, req: &Request) -> Response {
    conn.get_mut()
        .write_all(encode_line(req).as_bytes())
        .await
        .expect("send request");
    let mut line = String::new();
    conn.read_line(&mut line).await.expect("read response");
    decode_line::<Response>(&line).expect("decode response")
}

/// Snapshot the summary for `run_id` from a `List`.
async fn run_summary(conn: &mut BufReader<UnixStream>, run_id: &str) -> RunSummary {
    match round_trip(conn, &Request::List).await {
        Response::Runs(runs) => runs
            .into_iter()
            .find(|r| r.run_id == run_id)
            .expect("started run is listed"),
        other => panic!("expected Runs, got {other:?}"),
    }
}

#[tokio::test]
async fn stop_drains_running_swarm_to_finished_with_no_half_open() {
    let socket = temp_socket();
    let _ = std::fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket).expect("bind temp unix socket");

    let ctx = Arc::new(DaemonContext {
        registry: Arc::new(Registry::new()),
        // The test binary can't `run-swarm`; spawn the real in-crate binary.
        self_exe: PathBuf::from(env!("CARGO_BIN_EXE_fleet-superx")),
        nonce: 0xABCD_1234,
    });
    let serve_ctx = ctx.clone();
    tokio::spawn(async move {
        let _ = serve_unix(listener, serve_ctx).await;
    });

    let stream = UnixStream::connect(&socket).await.expect("connect unix");
    let mut conn = BufReader::new(stream);

    let run_id = match round_trip(&mut conn, &unbounded_start()).await {
        Response::Started { run_id } => run_id,
        other => panic!("expected Started, got {other:?}"),
    };

    // Wait until the swarm is actually running — with pids recorded — so the stop
    // below has processes to signal.
    let running_deadline = Instant::now() + Duration::from_secs(15);
    loop {
        assert!(
            Instant::now() < running_deadline,
            "run never reached running"
        );
        if run_summary(&mut conn, &run_id).await.state == "running" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    // Graceful stop: SIGTERM must reach the swarm, which drains and settles.
    match round_trip(&mut conn, &Request::Stop { run_id: run_id.clone() }).await {
        Response::Stopped => {}
        other => panic!("expected Stopped, got {other:?}"),
    }

    // The stopped run must reach Finished (not hang in Stopping, not Fail) with a
    // graceful aggregate: every opened tunnel settled.
    let finish_deadline = Instant::now() + Duration::from_secs(20);
    loop {
        assert!(
            Instant::now() < finish_deadline,
            "stopped run never reached finished"
        );
        let summary = run_summary(&mut conn, &run_id).await;
        assert_ne!(summary.state, "failed", "graceful stop must not fail the run");
        if summary.state == "finished" {
            let agg = summary
                .aggregate
                .expect("finished run carries an aggregate");
            assert_eq!(agg.tunnels_opened, 2, "both tunnels opened");
            assert_eq!(
                agg.tunnels_settled, agg.tunnels_opened,
                "graceful stop leaves no half-open tunnels"
            );
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}
