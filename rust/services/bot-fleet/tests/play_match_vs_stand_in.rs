//! TEST HARNESS — not a product mode. Production is **bot vs human only**; the relay's `is_bot`
//! guard never pairs two bots. Here a *second bot stands in for the human* because a unit test
//! can't drive a real browser/wallet — the bot speaks the identical relay protocol + co-signs the
//! same way the browser does, so it's a faithful substitute to prove the wiring in-process.
//!
//! It exercises the full per-match orchestration one real bot runs — `match.found` → hello
//! exchange → `NoopAnchor` open → co-signed play over the DEMUXED relay transport → settle — over
//! a `MockTransport` pair standing in for the relay, minus on-chain (NoopAnchor) and a real relay.

use bot_fleet::anchor::NoopAnchor;
use bot_fleet::match_channel::MatchChannel;
use bot_fleet::play_match::play_blackjack;
use bot_fleet::relay_ws::MockTransport;
use bot_fleet::signer_durable::DurableSigner;
use bot_fleet::Role;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bot_plays_a_full_match_against_a_human_stand_in() {
    let sa: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
    let sb: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);

    // One MockTransport pair = the relay forwarding payloads between the two seats.
    let (ta, tb) = MockTransport::pair();
    let cha = MatchChannel::new(ta);
    let chb = MatchChannel::new(tb);
    let anchor = NoopAnchor;

    let (ra, rb) = tokio::join!(
        play_blackjack(
            cha,
            &anchor,
            DurableSigner::from_secret(&sa),
            Role::A,
            "0xbotB",
            200,
            1,
        ),
        play_blackjack(
            chb,
            &anchor,
            DurableSigner::from_secret(&sb),
            Role::B,
            "0xhumanA",
            200,
            2,
        ),
    );

    let a = ra.expect("role A (player) completes the match");
    let b = rb.expect("role B (dealer) completes the match");

    assert_eq!(a.final_balances.sum(), 400, "stakes conserved");
    assert_eq!(
        a.final_balances, b.final_balances,
        "both seats agree on outcome"
    );
    assert!(a.moves > 0, "match progressed over the demuxed transport");
    assert!(
        b.settle_digest.is_some(),
        "dealer (role B) submitted the settle"
    );
    assert!(a.settle_digest.is_none(), "player (role A) does not submit");
}
