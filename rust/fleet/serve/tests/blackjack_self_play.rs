//! Two parties play a full blackjack match over an in-memory frame transport through the
//! async driver; balances are conserved and both parties agree.

use std::sync::Arc;
use tunnel_blackjack::Blackjack;
use tunnel_core::crypto::keypair_from_secret;
use tunnel_harness::{
    Balances, InMemoryAnchor, InMemoryFrameTransport, LocalSigner, NullTranscriptRecorder,
    PartyDriver, RandomMoveStrategy, Seat, SeatParts,
};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn self_play_match_conserves_balances() {
    let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
    let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
    let pk_a = keypair_from_secret(&secret_a).public_key();
    let pk_b = keypair_from_secret(&secret_b).public_key();

    let (ch_a, ch_b) = InMemoryFrameTransport::pair();
    let anchor = InMemoryAnchor::with_fixed_id("0xab");
    let driver_a = PartyDriver::new(
        SeatParts {
            protocol: Blackjack,
            signer: LocalSigner::from_secret(&secret_a),
            opponent_pk: pk_b,
            initial: Balances { a: 200, b: 200 },
            seat: Seat::A,
        },
        RandomMoveStrategy::new(Arc::new(Blackjack), 1),
        ch_a,
        anchor.clone(),
        NullTranscriptRecorder,
    );
    let driver_b = PartyDriver::new(
        SeatParts {
            protocol: Blackjack,
            signer: LocalSigner::from_secret(&secret_b),
            opponent_pk: pk_a,
            initial: Balances { a: 200, b: 200 },
            seat: Seat::B,
        },
        RandomMoveStrategy::new(Arc::new(Blackjack), 2),
        ch_b,
        anchor.clone(),
        NullTranscriptRecorder,
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
    let a = ra.expect("seat A runs cleanly").0;
    let b = rb.expect("seat B runs cleanly").0;
    assert_eq!(a.final_balances.sum(), 400);
    assert_eq!(a.final_balances, b.final_balances);
    assert!(a.moves > 0);
}
