//! TEST HARNESS — not a product mode. Production is **bot vs human only**; the relay's `is_bot`
//! guard never pairs two bots. Here a *second bot stands in for the human* because a unit test
//! can't drive a real browser/wallet — the bot speaks the identical relay protocol + co-signs the
//! same way the browser does, so it's a faithful substitute to prove the wiring in-process.
//!
//! It exercises the full per-match orchestration on the merged `tunnel_harness::PartyDriver` (#131):
//! hello exchange → anchor `open` → co-signed play over the DEMUXED relay transport → anchor
//! `settle`. Both seats share ONE `InMemoryAnchor`, so `open` resolves the same tunnel for both and
//! `settle` PAIRS their two halves — i.e. both returning `Ok` proves the cooperative close verified,
//! not just that the move loop ran. Off-chain (InMemoryAnchor) over a `MockTransport` pair.

use bot_fleet::match_channel::MatchChannel;
use bot_fleet::play_match::{play_blackjack, play_quantum_poker, QUANTUM_POKER};
use bot_fleet::relay_ws::MockTransport;
use bot_fleet::signer_durable::DurableSigner;
use bot_fleet::Role;
use tunnel_harness::{InMemoryAnchor, NullTranscriptRecorder};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bot_plays_a_full_match_against_a_human_stand_in() {
    let sa: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
    let sb: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);

    // One MockTransport pair = the relay forwarding payloads between the two seats.
    let (ta, tb) = MockTransport::pair();
    let cha = MatchChannel::new(ta);
    let chb = MatchChannel::new(tb);
    // ONE shared in-memory anchor: `open` is idempotent on (protocol, pubkeys) so both seats bracket
    // the SAME tunnel, and `settle` parks the first half until the second arrives, then pairs them.
    let anchor = InMemoryAnchor::new();

    let (ra, rb) = tokio::join!(
        play_blackjack(
            cha,
            anchor.clone(),
            DurableSigner::from_secret(&sa),
            Role::A,
            "0xbotB",
            NullTranscriptRecorder,
        ),
        play_blackjack(
            chb,
            anchor.clone(),
            DurableSigner::from_secret(&sb),
            Role::B,
            "0xhumanA",
            NullTranscriptRecorder,
        ),
    );

    let a = ra.expect("role A (player) completes open → play → settle");
    let b = rb.expect("role B (dealer) completes open → play → settle");

    let total = 2 * bot_fleet::play_match::BLACKJACK.stake_each;
    assert_eq!(a.final_balances.sum(), total, "stakes conserved");
    assert_eq!(
        a.final_balances, b.final_balances,
        "both seats agree on the settled outcome"
    );
    assert!(a.moves > 0, "match progressed over the demuxed transport");
    // Both returning Ok is the load-bearing assertion: the shared anchor PAIRED the two settle
    // halves (byte-identical co-signed settlement), so the cooperative close verified — not just
    // the move loop. A divergence in final balances/nonce/timestamp would fail the pairing → Err.
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bot_plays_a_full_poker_match_against_a_human_stand_in() {
    let sa: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
    let sb: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);

    let (ta, tb) = MockTransport::pair();
    let cha = MatchChannel::new(ta);
    let chb = MatchChannel::new(tb);
    let anchor = InMemoryAnchor::new();

    let (ra, rb) = tokio::join!(
        play_quantum_poker(
            cha,
            anchor.clone(),
            DurableSigner::from_secret(&sa),
            Role::A,
            "0xbotB",
            NullTranscriptRecorder,
        ),
        play_quantum_poker(
            chb,
            anchor.clone(),
            DurableSigner::from_secret(&sb),
            Role::B,
            "0xhumanA",
            NullTranscriptRecorder,
        ),
    );

    let a = ra.expect("role A completes open → play → settle");
    let b = rb.expect("role B completes open → play → settle");

    let total = 2 * QUANTUM_POKER.stake_each;
    assert_eq!(a.final_balances.sum(), total, "stakes conserved");
    assert_eq!(
        a.final_balances, b.final_balances,
        "both seats agree on the settled outcome"
    );
    assert!(
        a.moves > 0,
        "poker match progressed over the demuxed transport"
    );
}
