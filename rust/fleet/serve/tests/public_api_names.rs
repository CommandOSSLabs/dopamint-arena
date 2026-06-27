use std::sync::Arc;
use tunnel_blackjack::Blackjack;
use tunnel_core::crypto::keypair_from_secret;
use tunnel_harness::{
    Balances, FrameTransport, InMemoryFrameTransport, LocalSigner, MoveStrategy, PartyDriver,
    PartyRuntime, RandomMoveStrategy, Seat, TunnelContext,
};

#[tokio::test]
async fn public_api_uses_party_strategy_and_transport_names() {
    let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
    let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
    let pk_b = keypair_from_secret(&secret_b).public_key();

    let (transport_a, _transport_b) = InMemoryFrameTransport::pair();
    transport_a.send(b"frame".to_vec()).await.unwrap();

    let runtime = PartyRuntime::new(
        Blackjack,
        LocalSigner::from_secret(&secret_a),
        pk_b,
        TunnelContext {
            tunnel_id: "0xab".into(),
            initial: Balances { a: 200, b: 200 },
            seat: Seat::A,
        },
    );
    let strategy = RandomMoveStrategy::new(Arc::new(Blackjack), 1);

    fn assert_strategy<S: MoveStrategy<Blackjack>>(_: &S) {}
    assert_strategy(&strategy);

    let _driver = PartyDriver::new(runtime, strategy, transport_a);
}
