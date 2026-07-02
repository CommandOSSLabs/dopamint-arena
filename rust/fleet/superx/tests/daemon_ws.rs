//! End-to-end control-plane test over the WebSocket transport.
//!
//! Drives the real `serve_ws` accept loop on an ephemeral loopback port (never a
//! fixed shared port) and spawns real `run-swarm` subprocesses via the in-crate
//! binary (`CARGO_BIN_EXE_fleet-superx`). Asserts a `distribute` run over the
//! memory anchor reaches `Finished` with all tunnels conserved — parity with the
//! Unix-socket test, proving both transports share `handle_request`.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use fleet_superx::daemon::{serve_ws, DaemonContext};
use fleet_superx::proto::{
    decode_line, encode_line, CohortWire, Request, Response, SpawnMode, StartRun,
};
use fleet_superx::registry::Registry;
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

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

/// Read frames from the ws stream until a text frame arrives, decoding it as a
/// [`Response`]. Skips ping/pong/other control frames.
async fn next_response<S>(ws: &mut S) -> Response
where
    S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        let msg = ws.next().await.expect("ws stream open").expect("ws frame");
        if let Message::Text(text) = msg {
            return decode_line::<Response>(&text).expect("decode response");
        }
    }
}

#[tokio::test]
async fn daemon_runs_distribute_to_completion_over_ws() {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind ephemeral loopback port");
    let addr = listener.local_addr().expect("local addr");

    let ctx = Arc::new(DaemonContext {
        registry: Arc::new(Registry::new()),
        // The test binary can't `run-swarm`; spawn the real in-crate binary.
        self_exe: PathBuf::from(env!("CARGO_BIN_EXE_fleet-superx")),
        nonce: 0x1234_5678,
    });
    let serve_ctx = ctx.clone();
    tokio::spawn(async move {
        let _ = serve_ws(listener, serve_ctx).await;
    });

    let url = format!("ws://{addr}");
    let (mut ws, _resp) = tokio_tungstenite::connect_async(&url)
        .await
        .expect("connect ws");

    ws.send(Message::Text(encode_line(&distribute_start())))
        .await
        .expect("send start");
    let run_id = match next_response(&mut ws).await {
        Response::Started { run_id } => run_id,
        other => panic!("expected Started, got {other:?}"),
    };

    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        assert!(Instant::now() < deadline, "run did not finish in time");
        ws.send(Message::Text(encode_line(&Request::List)))
            .await
            .expect("send list");
        let Response::Runs(runs) = next_response(&mut ws).await else {
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
