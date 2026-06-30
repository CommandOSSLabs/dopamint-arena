use std::sync::Arc;
use tunnel_blackjack::Blackjack;
use tunnel_core::crypto::keypair_from_secret;
use tunnel_harness::{
    Balances, FrameTransport, InMemoryAnchor, InMemoryFrameTransport, LocalSigner, MoveStrategy,
    NullTranscriptRecorder, PartyDriver, RandomMoveStrategy, Seat, SeatParts,
};

#[tokio::test]
async fn public_api_uses_party_strategy_and_transport_names() {
    let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
    let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
    let pk_b = keypair_from_secret(&secret_b).public_key();

    let (transport_a, _transport_b) = InMemoryFrameTransport::pair();
    transport_a.send(b"frame".to_vec()).await.unwrap();

    let parts = SeatParts {
        protocol: Blackjack,
        signer: LocalSigner::from_secret(&secret_a),
        opponent_pk: pk_b,
        initial: Balances { a: 200, b: 200 },
        seat: Seat::A,
    };
    let strategy = RandomMoveStrategy::new(Arc::new(Blackjack), 1);

    fn assert_strategy<S: MoveStrategy<Blackjack>>(_: &S) {}
    assert_strategy(&strategy);

    let _driver = PartyDriver::new(
        parts,
        strategy,
        transport_a,
        InMemoryAnchor::with_fixed_id("0xab"),
        NullTranscriptRecorder,
    );
}

#[test]
fn telemetry_surface_is_public() {
    // Compile-time proof the observer seam + reporter are exported.
    fn _assert_observer<T: tunnel_harness::DriverObserver>() {}
    _assert_observer::<fleet_serve::HeartbeatReporter>();

    let _start = tunnel_harness::DriverStart {
        tunnel_id: "0x1",
        our_seat: tunnel_harness::Seat::A,
    };
    let _ev = tunnel_harness::MoveCommitted {
        by: tunnel_harness::Seat::A,
        nonce: 1,
        move_index: 1,
        timestamp_ms: 0,
    };
    let _p = fleet_serve::HeartbeatPayload {
        tunnel_id: "0x1".into(),
        nonce: "1".into(),
        actions_delta: 1,
        window_ms: 1,
    };

    // The headline production export: the serving construction seam. Coercing it
    // to a concrete fn pointer pins its name and full signature shape, keeping the
    // whole telemetry surface pinned in one place. (`fn() -> u64` is a concrete
    // stand-in for the seam's `impl FnMut() -> u64` clock parameter.)
    type SeamFn = fn(
        PartyDriver<
            Blackjack,
            RandomMoveStrategy<Blackjack>,
            InMemoryFrameTransport,
            LocalSigner,
            InMemoryAnchor,
            NullTranscriptRecorder,
        >,
        fleet_serve::HeartbeatReporter,
        u64,
        fn() -> u64,
    ) -> fleet_serve::DriverUnit;
    let _seam: SeamFn = fleet_serve::into_serving_unit;
}
