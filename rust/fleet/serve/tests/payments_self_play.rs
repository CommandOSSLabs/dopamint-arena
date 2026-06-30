//! The payments protocol drives end-to-end through the same async driver as
//! blackjack — proving the seams are protocol-agnostic.

use std::sync::Arc;
use tunnel_core::crypto::keypair_from_secret;
use tunnel_harness::{
    Balances, InMemoryAnchor, InMemoryFrameTransport, LocalSigner, NullTranscriptRecorder,
    PartyDriver, RandomMoveStrategy, Seat, SeatParts,
};
use tunnel_payments::Payments;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn payments_self_play_conserves_total() {
    let sa: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
    let sb: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
    let pk_a = keypair_from_secret(&sa).public_key();
    let pk_b = keypair_from_secret(&sb).public_key();
    let (ch_a, ch_b) = InMemoryFrameTransport::pair();

    let anchor = InMemoryAnchor::with_fixed_id("0xcd");
    let driver_a = PartyDriver::new(
        SeatParts {
            protocol: Payments { max_transfers: 20 },
            signer: LocalSigner::from_secret(&sa),
            opponent_pk: pk_b,
            initial: Balances { a: 100, b: 100 },
            seat: Seat::A,
        },
        RandomMoveStrategy::new(Arc::new(Payments { max_transfers: 20 }), 1),
        ch_a,
        anchor.clone(),
        NullTranscriptRecorder,
    );
    let driver_b = PartyDriver::new(
        SeatParts {
            protocol: Payments { max_transfers: 20 },
            signer: LocalSigner::from_secret(&sb),
            opponent_pk: pk_a,
            initial: Balances { a: 100, b: 100 },
            seat: Seat::B,
        },
        RandomMoveStrategy::new(Arc::new(Payments { max_transfers: 20 }), 2),
        ch_b,
        anchor.clone(),
        NullTranscriptRecorder,
    );

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
    let a = ra.unwrap().0;
    let b = rb.unwrap().0;
    assert_eq!(a.final_balances.sum(), 200);
    assert_eq!(a.final_balances, b.final_balances);
    assert!(a.moves >= 20);
}
