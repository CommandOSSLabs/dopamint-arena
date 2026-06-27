//! Full-flow integration on the merged engine: a complete blackjack match driven through the
//! bot-fleet transport stack — `tunnel_harness::PartyDriver` → `RelayChannel` → `relay_envelope`
//! → `MockTransport` — over the sans-IO `PartyRuntime` core. Every frame crosses the relay
//! envelope; the runtime's default `JsonFrameCodec` is byte-identical to the TS wire, so the
//! exact bytes a browser would accept flow through. The bot seat signs with `DurableSigner`.
//!
//! In-process proof of the v1 walking skeleton minus live infra (real relay WS + Sui settle),
//! which is verified manually end-to-end.

use std::sync::Arc;

use tunnel_blackjack::Blackjack;
use tunnel_core::crypto::keypair_from_secret;
use tunnel_harness::{
    Balances, LocalSigner, PartyDriver, PartyRuntime, RandomMoveStrategy, Seat, TunnelContext,
};

use bot_fleet::relay_channel::RelayChannel;
use bot_fleet::relay_ws::MockTransport;
use bot_fleet::signer_durable::DurableSigner;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn full_blackjack_match_over_the_relay_transport_conserves() {
    let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8); // human opponent
    let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8); // our bot
    let pk_a = keypair_from_secret(&secret_a).public_key();
    let pk_b = keypair_from_secret(&secret_b).public_key();

    // The two seats are wired through the relay transport, not an in-memory one.
    let (ta, tb) = MockTransport::pair();
    let ch_a = RelayChannel::new(ta);
    let ch_b = RelayChannel::new(tb);

    let ctx = |seat| TunnelContext {
        tunnel_id: "0xab".into(), // must be valid hex (hashed into the signed state-update)
        initial: Balances { a: 200, b: 200 },
        seat,
    };

    // Runtimes use the default JsonFrameCodec (TS-compatible). The bot (seat B) signs with the
    // durable signer; the human (seat A) with a local one. RandomMoveStrategy delegates to
    // Blackjack::sample_move (basic strategy) — legal moves only.
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
            DurableSigner::from_secret(&secret_b),
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

    let a = ra.expect("human seat runs cleanly over the relay");
    let b = rb.expect("bot seat runs cleanly over the relay");

    assert_eq!(a.final_balances.sum(), 400, "conservation holds for seat A");
    assert_eq!(b.final_balances.sum(), 400, "conservation holds for seat B");
    assert_eq!(
        a.final_balances, b.final_balances,
        "both seats agree on the settleable outcome after a full match over the relay envelope"
    );
    assert!(
        a.moves > 0,
        "the match made real progress through the transport"
    );
}
