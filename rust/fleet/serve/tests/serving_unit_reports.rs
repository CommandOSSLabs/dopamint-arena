//! Integrity: the serving construction seam actually attaches the heartbeat
//! reporter, so a served tunnel's moves reach the telemetry server.

use std::sync::Arc;
use std::time::Duration;

use fleet_serve::{into_serving_unit, DriverUnit, FleetSupervisor, HeartbeatReporter};
use tunnel_core::crypto::keypair_from_secret;
use tunnel_harness::{
    Balances, InMemoryFrameTransport, LocalSigner, PartyDriver, PartyRuntime, RandomMoveStrategy,
    Seat, TunnelContext,
};
use tunnel_payments::Payments;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn serve_unit_attaches_reporter() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/sessions/sess-1/heartbeat"))
        .respond_with(ResponseTemplate::new(204))
        .mount(&server)
        .await;

    let sa: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
    let sb: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
    let pk_a = keypair_from_secret(&sa).public_key();
    let pk_b = keypair_from_secret(&sb).public_key();
    let (ch_a, ch_b) = InMemoryFrameTransport::pair();

    let ctx = |seat| TunnelContext {
        tunnel_id: "0xcd".into(),
        initial: Balances { a: 100, b: 100 },
        seat,
    };

    // Seat A owns the session → its reporter is attached via the seam.
    let reporter = HeartbeatReporter::new(
        reqwest::Client::new(),
        server.uri(),
        "sess-1".into(),
        "tok-1".into(),
    );
    let driver_a = PartyDriver::new(
        PartyRuntime::new(
            Payments { max_transfers: 20 },
            LocalSigner::from_secret(&sa),
            pk_b,
            ctx(Seat::A),
        ),
        RandomMoveStrategy::new(Arc::new(Payments { max_transfers: 20 }), 1),
        ch_a,
    );
    let mut ca = 0u64;
    let unit_a = into_serving_unit(driver_a, reporter, 1000, move || {
        ca += 1;
        ca
    });

    // Seat B is the plain opponent — no reporter (it does not own the session).
    let driver_b = PartyDriver::new(
        PartyRuntime::new(
            Payments { max_transfers: 20 },
            LocalSigner::from_secret(&sb),
            pk_a,
            ctx(Seat::B),
        ),
        RandomMoveStrategy::new(Arc::new(Payments { max_transfers: 20 }), 2),
        ch_b,
    );
    let mut cb = 0u64;
    let unit_b: DriverUnit = Box::pin(driver_b.run(1000, move || {
        cb += 1;
        cb
    }));

    let metrics = FleetSupervisor::run_drivers(vec![unit_a, unit_b]).await;
    assert_eq!(metrics.tunnels, 2);

    // The reporter's POSTs are fire-and-forget; poll briefly for the trailing flush.
    let mut got = 0usize;
    for _ in 0..100 {
        got = server.received_requests().await.unwrap().len();
        if got > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        got >= 1,
        "expected at least one heartbeat POST from the attached reporter"
    );
}
