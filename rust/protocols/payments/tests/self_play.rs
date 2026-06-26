//! The payments protocol drives end-to-end through the same generic harness as
//! blackjack — proving the seams are protocol-agnostic.

use std::sync::Arc;
use tunnel_core::crypto::keypair_from_secret;
use tunnel_harness::{
    Balances, InMemoryChannel, LocalSigner, RandomPolicy, Seat, SeatDriver, TunnelContext,
};
use tunnel_payments::Payments;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn payments_self_play_conserves_total() {
    let sa: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
    let sb: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
    let pk_a = keypair_from_secret(&sa).public_key();
    let pk_b = keypair_from_secret(&sb).public_key();
    let (ch_a, ch_b) = InMemoryChannel::pair();

    let ctx = |seat| TunnelContext {
        tunnel_id: "0xcd".into(),
        initial: Balances { a: 100, b: 100 },
        seat,
    };
    let driver_a = SeatDriver::new(
        Payments { max_transfers: 20 },
        RandomPolicy::new(Arc::new(Payments { max_transfers: 20 }), 1),
        ch_a,
        LocalSigner::from_secret(&sa),
        pk_b,
        ctx(Seat::A),
    )
    .await;
    let driver_b = SeatDriver::new(
        Payments { max_transfers: 20 },
        RandomPolicy::new(Arc::new(Payments { max_transfers: 20 }), 2),
        ch_b,
        LocalSigner::from_secret(&sb),
        pk_a,
        ctx(Seat::B),
    )
    .await;

    let mut ca = 0u64;
    let mut cb = 0u64;
    let (ra, rb) = tokio::join!(
        driver_a.run(1000, move || {
            ca += 1;
            ca
        }),
        driver_b.run(1000, move || {
            cb += 1;
            cb
        }),
    );
    let a = ra.unwrap();
    let b = rb.unwrap();
    assert_eq!(a.final_balances.sum(), 200);
    assert_eq!(a.final_balances, b.final_balances);
    assert!(a.moves >= 20);
}
