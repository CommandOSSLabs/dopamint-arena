//! Two parties play a full blackjack match over an in-memory frame transport through the
//! async driver; balances are conserved and both parties agree.

use std::sync::Arc;
use tunnel_blackjack::Blackjack;
use tunnel_core::crypto::keypair_from_secret;
use tunnel_harness::{
    Balances, InMemoryFrameTransport, LocalSigner, PartyDriver, PartyRuntime, RandomMoveStrategy,
    Seat, TunnelContext,
};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn self_play_match_conserves_balances() {
    let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
    let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
    let pk_a = keypair_from_secret(&secret_a).public_key();
    let pk_b = keypair_from_secret(&secret_b).public_key();

    let (ch_a, ch_b) = InMemoryFrameTransport::pair();
    let ctx = |seat| TunnelContext {
        tunnel_id: "0xab".into(),
        initial: Balances { a: 200, b: 200 },
        seat,
    };

    let driver_a = PartyDriver::new(
        PartyRuntime::new(
            Blackjack,
            LocalSigner::from_secret(&secret_a),
            pk_b,
            ctx(Seat::A),
        ),
        RandomMoveStrategy::new(Arc::new(Blackjack), 1),
        ch_a,
    );
    let driver_b = PartyDriver::new(
        PartyRuntime::new(
            Blackjack,
            LocalSigner::from_secret(&secret_b),
            pk_a,
            ctx(Seat::B),
        ),
        RandomMoveStrategy::new(Arc::new(Blackjack), 2),
        ch_b,
    );

    let mut clock_a = 1u64;
    let mut clock_b = 1u64;
    let (ra, rb) = tokio::join!(
        driver_a.run(5000, move || {
            clock_a += 1;
            clock_a
        }),
        driver_b.run(5000, move || {
            clock_b += 1;
            clock_b
        }),
    );
    let a = ra.expect("seat A runs cleanly");
    let b = rb.expect("seat B runs cleanly");
    assert_eq!(a.final_balances.sum(), 400);
    assert_eq!(a.final_balances, b.final_balances);
    assert!(a.moves > 0);
}
