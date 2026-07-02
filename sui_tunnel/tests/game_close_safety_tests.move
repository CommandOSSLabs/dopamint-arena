// Review artifact (SolEng game-correctness review, dev-raid). Encodes Kostas's
// channel-close invariant as tests. The generic tunnel close is GAME-BLIND:
// `force_close_after_timeout` finalizes the stored co-signed balances plus a flat
// penalty and re-derives no game rules. For a turn-based 2-party game a seat about to
// LOSE can withhold its co-signature on the move that finalizes the loss; the honest
// seat then holds only the earlier, balance-neutral co-signed state, and the chain
// pays that out. Safety reduces entirely to `penalty_amount` >= the at-risk stake.
//
// Two kinds of test here, deliberately:
//   * GREEN invariant — the penalty mechanism, when sized correctly, DOES punish the
//     abandoner. This is real, satisfied behaviour, so it passes.
//   * RED security spec — the invariant Kostas actually wants ("you lose your money if
//     you don't progress") does NOT hold at penalty 0. The spec asserts the SECURE
//     outcome, which the current game-blind close does not deliver, so the test FAILS
//     (red) and shows up in CI. This is intentional: a failing security spec is the
//     signal the team must fix the gap. It is NOT quarantined with #[expected_failure]
//     — that mark is for cases where the system CORRECTLY aborts to block abuse (and so
//     should be green). Here the system fails to protect, so the test must be red. When
//     a game-aware close (or a required penalty) is added, the assert holds and this
//     test goes green, becoming a permanent regression guard.
//
// Additive, test-only, depends only on existing public `*_for_testing` helpers.
#[test_only]
module sui_tunnel::game_close_safety_tests;

use std::unit_test::assert_eq;
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario;
use sui_tunnel::tunnel;

const STAKE_EACH: u64 = 1000;
const TIMEOUT_MS: u64 = 60_000;

// RED SECURITY SPEC — fails today on purpose (the failure IS finding F1/F2; it must be
// visible in CI). Kostas: "one can stop the game… we should allow the other party to say
// you lose your money if you don't progress." Secure invariant: a seat that abandons a
// losing game must NOT recover its stake from a penalty-0 force_close. The generic close
// is game-blind, so today the abandoner keeps everything and the assert below fails.
#[test]
fun security_abandoner_must_not_keep_stake_at_penalty_zero() {
    let honest = @0xAAAA; // about to WIN the game
    let abandoner = @0xBBBB; // about to LOSE; withholds the co-signature and walks
    let mut scenario = test_scenario::begin(honest);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    // The latest BOTH-signed state is the pre-decision, balance-neutral split — the
    // winning move was never co-signed because `abandoner` withheld its signature.
    let mut tunnel = tunnel::create_active_for_testing<SUI>(
        honest,
        abandoner,
        STAKE_EACH,
        STAKE_EACH,
        TIMEOUT_MS,
        0, // penalty_amount = 0  <-- the Tic-tac-toe PvP open value
        &clock,
        scenario.ctx(),
    );
    tunnel::raise_dispute_current_state(&mut tunnel, &clock, scenario.ctx());
    clock.set_for_testing(1000 + TIMEOUT_MS + 1);
    tunnel::force_close_after_timeout(&mut tunnel, &clock, scenario.ctx());

    scenario.next_tx(honest);
    let coin_honest = scenario.take_from_address<coin::Coin<SUI>>(honest);
    let coin_abandoner = scenario.take_from_address<coin::Coin<SUI>>(abandoner);

    // SECURE invariant: the abandoner forfeits the stake it refused to play out.
    // FAILS today (it kept STAKE_EACH) — this is the intended red CI signal for F1/F2.
    assert_eq!(coin_abandoner.value(), 0);

    // Reachable only once the invariant holds (keeps the resource checker happy and
    // makes this a passing regression guard after the gap is fixed).
    coin_honest.burn_for_testing();
    coin_abandoner.burn_for_testing();
    tunnel::destroy_for_testing(tunnel);
    clock.destroy_for_testing();
    scenario.end();
}

// GREEN invariant — the mitigation Blackjack PvP already uses: with `penalty_amount`
// >= the at-risk stake, abandoning is no longer free. This is real satisfied behaviour
// (the flat penalty moves loser→raiser on force_close), so it passes today and guards
// against the penalty mechanism regressing.
#[test]
fun penalty_equal_to_stake_compensates_honest_seat() {
    let honest = @0xAAAA;
    let abandoner = @0xBBBB;
    let mut scenario = test_scenario::begin(honest);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    let mut tunnel = tunnel::create_active_for_testing<SUI>(
        honest,
        abandoner,
        STAKE_EACH,
        STAKE_EACH,
        TIMEOUT_MS,
        STAKE_EACH, // penalty_amount = the at-risk stake
        &clock,
        scenario.ctx(),
    );
    tunnel::raise_dispute_current_state(&mut tunnel, &clock, scenario.ctx());
    clock.set_for_testing(1000 + TIMEOUT_MS + 1);
    tunnel::force_close_after_timeout(&mut tunnel, &clock, scenario.ctx());

    scenario.next_tx(honest);
    let coin_honest = scenario.take_from_address<coin::Coin<SUI>>(honest);
    let coin_abandoner = scenario.take_from_address<coin::Coin<SUI>>(abandoner);
    assert_eq!(coin_honest.value(), STAKE_EACH + STAKE_EACH);
    assert_eq!(coin_abandoner.value(), 0);
    coin_honest.burn_for_testing();
    coin_abandoner.burn_for_testing();

    tunnel::destroy_for_testing(tunnel);
    clock.destroy_for_testing();
    scenario.end();
}
