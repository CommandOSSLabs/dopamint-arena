#[test_only]
module sui_tunnel::example_atomic_swap_tests;

use std::unit_test::{assert_eq, destroy};
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario;
use sui_tunnel::example_atomic_swap;

// Common test addresses: the locker funds the swap, the claimer redeems it.
const LOCKER: address = @0xA11CE;
const CLAIMER: address = @0xB0B;

// A locked swap pays out to the claimer, so it must last at least
// MIN_LOCK_TIME_MS (3_600_000). Use a comfortable margin above that.
const LOCK_DURATION: u64 = 7_200_000;
const LOCK_AMOUNT: u64 = 1_000;
const START_TIME: u64 = 1_000;

#[test]
fun status_constants() {
    assert_eq!(example_atomic_swap::status_locked(), 0);
    assert_eq!(example_atomic_swap::status_claimed(), 1);
    assert_eq!(example_atomic_swap::status_refunded(), 2);
}

#[test]
fun time_constants() {
    // 1 hour in ms
    assert_eq!(example_atomic_swap::min_lock_time_ms(), 3600000);
    // 30 minutes in ms
    assert_eq!(example_atomic_swap::swap_time_buffer_ms(), 1800000);
}

#[test]
fun compute_secret_hash() {
    let secret = b"my_secret_preimage";
    let hash1 = example_atomic_swap::compute_secret_hash(&secret);
    let hash2 = example_atomic_swap::compute_secret_hash(&secret);

    // Same secret produces same hash
    assert_eq!(hash1, hash2);
    assert_eq!(hash1.length(), 32);

    // Different secret produces different hash
    let other_secret = b"other_secret";
    let other_hash = example_atomic_swap::compute_secret_hash(&other_secret);
    assert!(hash1 != other_hash);
}

// ============================================
// REAL LIFECYCLE TESTS (call the module's functions)
// ============================================

/// Success path: lock funds with hash(secret), then the claimer reveals the
/// correct preimage and receives the full locked amount. Asserts the status
/// transition (LOCKED -> CLAIMED), the receipt fields, and the exact payout
/// coin value transferred to the claimer.
#[test]
fun claim_with_correct_secret_pays_full_amount() {
    let mut scenario = test_scenario::begin(LOCKER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(START_TIME);

    let secret = b"correct_horse_battery_staple";
    let secret_hash = example_atomic_swap::compute_secret_hash(&secret);

    // LOCKER locks LOCK_AMOUNT for CLAIMER.
    let payment = coin::mint_for_testing<SUI>(LOCK_AMOUNT, scenario.ctx());
    let mut swap = example_atomic_swap::create_swap_lock<SUI>(
        CLAIMER,
        payment,
        secret_hash,
        LOCK_DURATION,
        &clock,
        scenario.ctx(),
    );

    // Freshly locked swap is in LOCKED status with the expected metadata.
    assert_eq!(example_atomic_swap::swap_status(&swap), example_atomic_swap::status_locked());
    assert_eq!(example_atomic_swap::swap_locker(&swap), LOCKER);
    assert_eq!(example_atomic_swap::swap_claimer(&swap), CLAIMER);
    assert_eq!(example_atomic_swap::swap_amount(&swap), LOCK_AMOUNT);
    assert_eq!(example_atomic_swap::swap_expires_at(&swap), START_TIME + LOCK_DURATION);
    assert!(example_atomic_swap::is_claimable(&swap, START_TIME));

    // CLAIMER reveals the secret before expiry and claims.
    scenario.next_tx(CLAIMER);
    let receipt = example_atomic_swap::claim_swap<SUI>(
        &mut swap,
        secret,
        &clock,
        scenario.ctx(),
    );

    // Status flipped to CLAIMED and the swap is no longer claimable.
    assert_eq!(example_atomic_swap::swap_status(&swap), example_atomic_swap::status_claimed());
    assert!(!example_atomic_swap::is_claimable(&swap, START_TIME));

    // Receipt records the agreed amount, parties, and the revealed secret.
    assert_eq!(example_atomic_swap::receipt_amount(&receipt), LOCK_AMOUNT);
    assert_eq!(example_atomic_swap::receipt_locker(&receipt), LOCKER);
    assert_eq!(example_atomic_swap::receipt_claimer(&receipt), CLAIMER);
    assert_eq!(*example_atomic_swap::receipt_secret(&receipt), secret);

    // The full locked amount was transferred directly to the claimer.
    scenario.next_tx(CLAIMER);
    let paid = scenario.take_from_address<coin::Coin<SUI>>(CLAIMER);
    assert_eq!(paid.value(), LOCK_AMOUNT);
    paid.burn_for_testing();

    destroy(swap);
    destroy(receipt);
    clock.destroy_for_testing();
    scenario.end();
}

/// Cross-swap reveal path: a receipt from one claim is reused to claim the
/// matching swap via claim_with_receipt. The receipt carries the secret, so the
/// counterparty swap (same hash) pays out its full amount to its claimer.
/// Exercises the two-leg atomic-swap completion the module is built for.
#[test]
fun claim_with_receipt_completes_matching_leg() {
    let mut scenario = test_scenario::begin(LOCKER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(START_TIME);

    let secret = b"shared_swap_secret_value_32bytes";
    let secret_hash = example_atomic_swap::compute_secret_hash(&secret);

    // Initiator (LOCKER) locks for the responder (CLAIMER).
    let init_payment = coin::mint_for_testing<SUI>(LOCK_AMOUNT, scenario.ctx());
    let mut init_swap = example_atomic_swap::create_swap_lock<SUI>(
        CLAIMER,
        init_payment,
        secret_hash,
        LOCK_DURATION,
        &clock,
        scenario.ctx(),
    );

    // Responder (CLAIMER) locks a matching swap; claimer of that swap is LOCKER.
    // create_matching_swap requires the responder is the initiator swap's claimer
    // and that the initiator swap still has > BUFFER + MIN_LOCK time remaining.
    scenario.next_tx(CLAIMER);
    let resp_amount = 750;
    let resp_payment = coin::mint_for_testing<SUI>(resp_amount, scenario.ctx());
    let mut resp_swap = example_atomic_swap::create_matching_swap<SUI>(
        &init_swap,
        resp_payment,
        &clock,
        scenario.ctx(),
    );

    // Responder swap expires BUFFER earlier than the initiator's, and pays LOCKER.
    assert_eq!(
        example_atomic_swap::swap_expires_at(&resp_swap),
        START_TIME + LOCK_DURATION - example_atomic_swap::swap_time_buffer_ms(),
    );
    assert_eq!(example_atomic_swap::swap_claimer(&resp_swap), LOCKER);
    assert_eq!(example_atomic_swap::swap_amount(&resp_swap), resp_amount);

    // CLAIMER claims the initiator swap, revealing the secret in a receipt.
    let receipt = example_atomic_swap::claim_swap<SUI>(
        &mut init_swap,
        secret,
        &clock,
        scenario.ctx(),
    );

    // LOCKER uses that receipt to claim the responder swap (no need to know the
    // secret directly — it is carried by the receipt).
    scenario.next_tx(LOCKER);
    example_atomic_swap::claim_with_receipt<SUI>(
        &mut resp_swap,
        &receipt,
        &clock,
        scenario.ctx(),
    );
    assert_eq!(example_atomic_swap::swap_status(&resp_swap), example_atomic_swap::status_claimed());

    // CLAIMER received the initiator's funds; LOCKER received the responder's.
    scenario.next_tx(CLAIMER);
    let to_claimer = scenario.take_from_address<coin::Coin<SUI>>(CLAIMER);
    assert_eq!(to_claimer.value(), LOCK_AMOUNT);
    to_claimer.burn_for_testing();

    scenario.next_tx(LOCKER);
    let to_locker = scenario.take_from_address<coin::Coin<SUI>>(LOCKER);
    assert_eq!(to_locker.value(), resp_amount);
    to_locker.burn_for_testing();

    destroy(init_swap);
    destroy(resp_swap);
    destroy(receipt);
    clock.destroy_for_testing();
    scenario.end();
}

/// Refund path: after the lock expires and nobody claimed, the locker gets the
/// full original amount back. Asserts the LOCKED -> REFUNDED transition and that
/// the exact locked amount is returned to the locker.
#[test]
fun refund_after_expiry_returns_full_amount() {
    let mut scenario = test_scenario::begin(LOCKER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(START_TIME);

    let secret = b"unrevealed_secret";
    let secret_hash = example_atomic_swap::compute_secret_hash(&secret);

    let payment = coin::mint_for_testing<SUI>(LOCK_AMOUNT, scenario.ctx());
    let mut swap = example_atomic_swap::create_swap_lock<SUI>(
        CLAIMER,
        payment,
        secret_hash,
        LOCK_DURATION,
        &clock,
        scenario.ctx(),
    );

    let expiry = example_atomic_swap::swap_expires_at(&swap);

    // Advance the clock to exactly the expiry (refund requires now >= expires_at).
    clock.set_for_testing(expiry);
    assert!(!example_atomic_swap::is_claimable(&swap, expiry));
    assert!(example_atomic_swap::is_refundable(&swap, expiry));

    // LOCKER refunds (sender is already LOCKER from begin()).
    example_atomic_swap::refund_expired<SUI>(&mut swap, &clock, scenario.ctx());
    assert_eq!(example_atomic_swap::swap_status(&swap), example_atomic_swap::status_refunded());

    // The full original amount was returned to the locker.
    scenario.next_tx(LOCKER);
    let refunded = scenario.take_from_address<coin::Coin<SUI>>(LOCKER);
    assert_eq!(refunded.value(), LOCK_AMOUNT);
    refunded.burn_for_testing();

    destroy(swap);
    clock.destroy_for_testing();
    scenario.end();
}

// ============================================
// NEGATIVE PATHS (#[expected_failure])
// ============================================

/// Claiming with a WRONG preimage must abort with commitment_mismatch (13):
/// blake2b256(wrong_secret) != stored secret_hash.
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_atomic_swap::ECommitmentMismatch,
        location = sui_tunnel::example_atomic_swap,
    ),
]
fun claim_with_wrong_secret_aborts() {
    let mut scenario = test_scenario::begin(LOCKER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(START_TIME);

    let secret = b"the_real_secret";
    let secret_hash = example_atomic_swap::compute_secret_hash(&secret);

    let payment = coin::mint_for_testing<SUI>(LOCK_AMOUNT, scenario.ctx());
    let mut swap = example_atomic_swap::create_swap_lock<SUI>(
        CLAIMER,
        payment,
        secret_hash,
        LOCK_DURATION,
        &clock,
        scenario.ctx(),
    );

    // CLAIMER tries to claim with a different preimage -> commitment_mismatch.
    scenario.next_tx(CLAIMER);
    let receipt = example_atomic_swap::claim_swap<SUI>(
        &mut swap,
        b"a_completely_wrong_secret",
        &clock,
        scenario.ctx(),
    );

    // Unreachable; present so the test type-checks.
    destroy(receipt);
    destroy(swap);
    clock.destroy_for_testing();
    scenario.end();
}

/// Claiming AFTER expiry must abort with timeout_reached (15): claim_swap
/// requires now < expires_at even with the correct secret.
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_atomic_swap::ETimeoutReached,
        location = sui_tunnel::example_atomic_swap,
    ),
]
fun claim_after_expiry_aborts() {
    let mut scenario = test_scenario::begin(LOCKER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(START_TIME);

    let secret = b"correct_secret";
    let secret_hash = example_atomic_swap::compute_secret_hash(&secret);

    let payment = coin::mint_for_testing<SUI>(LOCK_AMOUNT, scenario.ctx());
    let mut swap = example_atomic_swap::create_swap_lock<SUI>(
        CLAIMER,
        payment,
        secret_hash,
        LOCK_DURATION,
        &clock,
        scenario.ctx(),
    );

    // Move past expiry, then claim with the correct secret -> timeout_reached.
    clock.set_for_testing(START_TIME + LOCK_DURATION);
    scenario.next_tx(CLAIMER);
    let receipt = example_atomic_swap::claim_swap<SUI>(
        &mut swap,
        secret,
        &clock,
        scenario.ctx(),
    );

    destroy(receipt);
    destroy(swap);
    clock.destroy_for_testing();
    scenario.end();
}

/// Refunding BEFORE expiry must abort with timeout_not_reached (504): the locker
/// cannot reclaim funds while the swap is still live.
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_atomic_swap::ETimeoutNotReached,
        location = sui_tunnel::example_atomic_swap,
    ),
]
fun refund_before_expiry_aborts() {
    let mut scenario = test_scenario::begin(LOCKER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(START_TIME);

    let secret = b"still_live_secret";
    let secret_hash = example_atomic_swap::compute_secret_hash(&secret);

    let payment = coin::mint_for_testing<SUI>(LOCK_AMOUNT, scenario.ctx());
    let mut swap = example_atomic_swap::create_swap_lock<SUI>(
        CLAIMER,
        payment,
        secret_hash,
        LOCK_DURATION,
        &clock,
        scenario.ctx(),
    );

    // now (START_TIME) < expires_at -> timeout_not_reached.
    example_atomic_swap::refund_expired<SUI>(&mut swap, &clock, scenario.ctx());

    destroy(swap);
    clock.destroy_for_testing();
    scenario.end();
}

/// A non-claimer cannot claim: claim_swap requires ctx.sender() == claimer.
/// The LOCKER (still the sender) attempting to claim aborts with
/// not_authorized (0).
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_atomic_swap::ENotAuthorized,
        location = sui_tunnel::example_atomic_swap,
    ),
]
fun non_claimer_cannot_claim() {
    let mut scenario = test_scenario::begin(LOCKER);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(START_TIME);

    let secret = b"my_secret";
    let secret_hash = example_atomic_swap::compute_secret_hash(&secret);

    let payment = coin::mint_for_testing<SUI>(LOCK_AMOUNT, scenario.ctx());
    let mut swap = example_atomic_swap::create_swap_lock<SUI>(
        CLAIMER,
        payment,
        secret_hash,
        LOCK_DURATION,
        &clock,
        scenario.ctx(),
    );

    // Sender is still LOCKER (not CLAIMER) -> not_authorized.
    let receipt = example_atomic_swap::claim_swap<SUI>(
        &mut swap,
        secret,
        &clock,
        scenario.ctx(),
    );

    destroy(receipt);
    destroy(swap);
    clock.destroy_for_testing();
    scenario.end();
}
