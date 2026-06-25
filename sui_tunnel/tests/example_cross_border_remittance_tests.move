#[test_only]
module sui_tunnel::example_cross_border_remittance_tests;

use std::unit_test::assert_eq;
use sui::clock;
use sui::coin::Coin;
use sui::sui::SUI;
use sui::test_scenario;
use sui_tunnel::example_cross_border_remittance;
use sui_tunnel::hop;
use sui_tunnel::tunnel;

#[test]
fun status_constants() {
    assert_eq!(example_cross_border_remittance::remittance_created(), 0);
    assert_eq!(example_cross_border_remittance::remittance_in_flight(), 1);
    assert_eq!(example_cross_border_remittance::remittance_settled(), 2);
    assert_eq!(example_cross_border_remittance::remittance_failed(), 3);
}

#[test]
fun create_remittance_invoice() {
    let preimage = b"secret_remittance_preimage";
    let invoice = example_cross_border_remittance::create_remittance_invoice(
        &preimage,
        10000,
        @0xBEEF,
        3600000,
        b"Remittance for family",
        b"USD",
        b"EUR",
        850000,
    );

    assert_eq!(example_cross_border_remittance::invoice_amount(&invoice), 10000);
    assert_eq!(example_cross_border_remittance::invoice_receiver(&invoice), @0xBEEF);
    assert_eq!(example_cross_border_remittance::invoice_expiry_ms(&invoice), 3600000);
    assert_eq!(*example_cross_border_remittance::invoice_memo(&invoice), b"Remittance for family");
    assert_eq!(*example_cross_border_remittance::invoice_source_currency(&invoice), b"USD");
    assert_eq!(*example_cross_border_remittance::invoice_dest_currency(&invoice), b"EUR");
    assert_eq!(example_cross_border_remittance::invoice_fx_rate(&invoice), 850000);

    // Payment hash should be 32 bytes
    assert_eq!(example_cross_border_remittance::invoice_payment_hash(&invoice).length(), 32);
}

#[test]
fun initiate_remittance() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let preimage = b"test_preimage";
    let invoice = example_cross_border_remittance::create_remittance_invoice(
        &preimage,
        5000,
        @0xBEEF,
        3600000,
        b"Test",
        b"USD",
        b"EUR",
        1000000,
    );

    let remittance = example_cross_border_remittance::initiate_remittance(
        &invoice,
        &clock,
        &mut ctx,
    );

    assert_eq!(example_cross_border_remittance::remittance_amount(&remittance), 5000);
    assert_eq!(example_cross_border_remittance::remittance_status(&remittance), 0);
    assert_eq!(example_cross_border_remittance::remittance_total_fees(&remittance), 0);

    example_cross_border_remittance::destroy_for_testing(remittance);
    clock::destroy_for_testing(clock);
}

#[test]
fun add_corridor_hops() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let preimage = b"test_preimage";
    let invoice = example_cross_border_remittance::create_remittance_invoice(
        &preimage,
        5000,
        @0xD,
        3600000,
        b"Test",
        b"USD",
        b"EUR",
        1000000,
    );

    let mut remittance = example_cross_border_remittance::initiate_remittance(
        &invoice,
        &clock,
        &mut ctx,
    );

    // Add corridor hops: A -> B -> C -> D
    example_cross_border_remittance::add_corridor_hop(
        &mut remittance,
        b"tunnel_ab",
        @0xB,
        100,
        3600000,
        &ctx,
    );
    example_cross_border_remittance::add_corridor_hop(
        &mut remittance,
        b"tunnel_bc",
        @0xC,
        80,
        3480000,
        &ctx,
    );
    example_cross_border_remittance::add_corridor_hop(
        &mut remittance,
        b"tunnel_cd",
        @0xD,
        60,
        3360000,
        &ctx,
    );

    assert_eq!(example_cross_border_remittance::remittance_total_fees(&remittance), 240);
    assert_eq!(
        hop::route_hop_count(example_cross_border_remittance::remittance_route(&remittance)),
        3,
    );

    example_cross_border_remittance::destroy_for_testing(remittance);
    clock::destroy_for_testing(clock);
}

#[test]
fun complete_remittance_flow() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    // Simulate: Alice -> Bob -> Carol

    // Recipient creates invoice (receiver = @0x0 to match dummy ctx sender for claim)
    let preimage = b"carol_secret_preimage";
    let invoice = example_cross_border_remittance::create_remittance_invoice(
        &preimage,
        10000,
        @0x0,
        7200000,
        b"Pay recipient",
        b"USD",
        b"EUR",
        850000,
    );

    // Sender initiates remittance (sender = @0x0 from dummy ctx)
    let mut remittance = example_cross_border_remittance::initiate_remittance(
        &invoice,
        &clock,
        &mut ctx,
    );

    // Add corridor (last hop must be recipient @0x0)
    example_cross_border_remittance::add_corridor_hop(
        &mut remittance,
        b"sender_relay",
        @0xB,
        100,
        3600000,
        &ctx,
    );
    example_cross_border_remittance::add_corridor_hop(
        &mut remittance,
        b"relay_recipient",
        @0x0,
        50,
        3480000,
        &ctx,
    );

    // Validate corridor
    assert!(example_cross_border_remittance::validate_remittance(&remittance));

    // Setup HTLCs
    example_cross_border_remittance::setup_corridor_htlcs(&mut remittance, 3600000, &clock, &ctx);
    assert_eq!(example_cross_border_remittance::remittance_status(&remittance), 1);
    assert_eq!(example_cross_border_remittance::remittance_htlc_count(&remittance), 2);

    // Carol claims with preimage
    let claimed = example_cross_border_remittance::claim_remittance(
        &mut remittance,
        preimage,
        &ctx,
    );
    assert!(claimed);
    assert_eq!(example_cross_border_remittance::remittance_status(&remittance), 2);

    // Create receipt: 10000 USD at 0.85 -> 8500 EUR
    let receipt = example_cross_border_remittance::create_remittance_receipt(
        &remittance,
        b"USD",
        b"EUR",
        850000,
        1234567900,
    );
    assert_eq!(example_cross_border_remittance::receipt_source_amount(&receipt), 10000);
    assert_eq!(example_cross_border_remittance::receipt_dest_amount(&receipt), 8500);
    assert_eq!(*example_cross_border_remittance::receipt_source_currency(&receipt), b"USD");
    assert_eq!(*example_cross_border_remittance::receipt_dest_currency(&receipt), b"EUR");
    assert_eq!(example_cross_border_remittance::receipt_fx_rate(&receipt), 850000);
    assert_eq!(example_cross_border_remittance::receipt_fees(&receipt), 150);
    assert_eq!(*example_cross_border_remittance::receipt_preimage(&receipt), preimage);

    example_cross_border_remittance::destroy_for_testing(remittance);
    clock::destroy_for_testing(clock);
}

#[test]
fun calculate_total_needed() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let preimage = b"test";
    let invoice = example_cross_border_remittance::create_remittance_invoice(
        &preimage,
        10000,
        @0xB,
        3600000,
        b"",
        b"USD",
        b"EUR",
        1000000,
    );

    let mut remittance = example_cross_border_remittance::initiate_remittance(
        &invoice,
        &clock,
        &mut ctx,
    );
    example_cross_border_remittance::add_corridor_hop(
        &mut remittance,
        b"tunnel",
        @0xB,
        500,
        3600000,
        &ctx,
    );

    assert_eq!(example_cross_border_remittance::calculate_total_needed(&remittance), 10500);

    example_cross_border_remittance::destroy_for_testing(remittance);
    clock::destroy_for_testing(clock);
}

#[test]
fun remittance_with_wrong_preimage() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let preimage = b"correct_preimage";
    // Receiver = @0x0 to match dummy ctx sender for claim_remittance auth
    let invoice = example_cross_border_remittance::create_remittance_invoice(
        &preimage,
        1000,
        @0x0,
        3600000,
        b"",
        b"USD",
        b"EUR",
        1000000,
    );

    let mut remittance = example_cross_border_remittance::initiate_remittance(
        &invoice,
        &clock,
        &mut ctx,
    );
    example_cross_border_remittance::add_corridor_hop(
        &mut remittance,
        b"tunnel",
        @0x0,
        100,
        3600000,
        &ctx,
    );

    example_cross_border_remittance::setup_corridor_htlcs(&mut remittance, 3600000, &clock, &ctx);

    // Try claiming with wrong preimage
    let claimed = example_cross_border_remittance::claim_remittance(
        &mut remittance,
        b"wrong_preimage",
        &ctx,
    );
    assert!(!claimed);
    assert_eq!(example_cross_border_remittance::remittance_status(&remittance), 1);

    example_cross_border_remittance::destroy_for_testing(remittance);
    clock::destroy_for_testing(clock);
}

// ============================================
// AUTHORIZATION FAILURE TESTS
// ============================================

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_cross_border_remittance::ENotAuthorized,
        location = sui_tunnel::example_cross_border_remittance,
    ),
]
fun add_corridor_hop_non_sender() {
    let mut scenario = test_scenario::begin(@0xA11CE);
    let clock = clock::create_for_testing(scenario.ctx());
    let preimage = b"secret_preimage";
    let invoice = example_cross_border_remittance::create_remittance_invoice(
        &preimage,
        5000,
        @0xBEEF,
        3600000,
        b"",
        b"USD",
        b"EUR",
        1000000,
    );

    // Route sender is @0xA11CE.
    let mut remittance = example_cross_border_remittance::initiate_remittance(
        &invoice,
        &clock,
        scenario.ctx(),
    );

    // A non-sender attempts to add a hop.
    scenario.next_tx(@0xBAD);
    example_cross_border_remittance::add_corridor_hop(
        &mut remittance,
        b"tunnel_ab",
        @0xB,
        100,
        3600000,
        scenario.ctx(),
    );

    example_cross_border_remittance::destroy_for_testing(remittance);
    clock::destroy_for_testing(clock);
    scenario.end();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_cross_border_remittance::ENotAuthorized,
        location = sui_tunnel::example_cross_border_remittance,
    ),
]
fun setup_corridor_htlcs_non_sender() {
    let mut scenario = test_scenario::begin(@0xA11CE);
    let clock = clock::create_for_testing(scenario.ctx());
    let preimage = b"secret_preimage";
    let invoice = example_cross_border_remittance::create_remittance_invoice(
        &preimage,
        5000,
        @0xBEEF,
        3600000,
        b"",
        b"USD",
        b"EUR",
        1000000,
    );

    let mut remittance = example_cross_border_remittance::initiate_remittance(
        &invoice,
        &clock,
        scenario.ctx(),
    );
    example_cross_border_remittance::add_corridor_hop(
        &mut remittance,
        b"tunnel_ab",
        @0xBEEF,
        100,
        3600000,
        scenario.ctx(),
    );

    // A non-sender attempts to set up the corridor HTLCs.
    scenario.next_tx(@0xBAD);
    example_cross_border_remittance::setup_corridor_htlcs(
        &mut remittance,
        3600000,
        &clock,
        scenario.ctx(),
    );

    example_cross_border_remittance::destroy_for_testing(remittance);
    clock::destroy_for_testing(clock);
    scenario.end();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_cross_border_remittance::ENotAuthorized,
        location = sui_tunnel::example_cross_border_remittance,
    ),
]
fun claim_remittance_non_receiver() {
    let mut scenario = test_scenario::begin(@0xA11CE);
    let clock = clock::create_for_testing(scenario.ctx());
    let preimage = b"secret_preimage";
    // Receiver is @0xBEEF.
    let invoice = example_cross_border_remittance::create_remittance_invoice(
        &preimage,
        5000,
        @0xBEEF,
        3600000,
        b"",
        b"USD",
        b"EUR",
        1000000,
    );

    let mut remittance = example_cross_border_remittance::initiate_remittance(
        &invoice,
        &clock,
        scenario.ctx(),
    );
    example_cross_border_remittance::add_corridor_hop(
        &mut remittance,
        b"tunnel_ab",
        @0xBEEF,
        100,
        3600000,
        scenario.ctx(),
    );
    example_cross_border_remittance::setup_corridor_htlcs(
        &mut remittance,
        3600000,
        &clock,
        scenario.ctx(),
    );

    // A non-receiver attempts to claim.
    scenario.next_tx(@0xBAD);
    let _claimed = example_cross_border_remittance::claim_remittance(
        &mut remittance,
        preimage,
        scenario.ctx(),
    );

    example_cross_border_remittance::destroy_for_testing(remittance);
    clock::destroy_for_testing(clock);
    scenario.end();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_cross_border_remittance::ENotAuthorized,
        location = sui_tunnel::example_cross_border_remittance,
    ),
]
fun fail_remittance_non_sender() {
    let mut scenario = test_scenario::begin(@0xA11CE);
    let clock = clock::create_for_testing(scenario.ctx());
    let preimage = b"secret_preimage";
    let invoice = example_cross_border_remittance::create_remittance_invoice(
        &preimage,
        5000,
        @0xBEEF,
        3600000,
        b"",
        b"USD",
        b"EUR",
        1000000,
    );

    let mut remittance = example_cross_border_remittance::initiate_remittance(
        &invoice,
        &clock,
        scenario.ctx(),
    );

    // A non-sender attempts to fail the remittance.
    scenario.next_tx(@0xBAD);
    example_cross_border_remittance::fail_remittance(&mut remittance, &clock, scenario.ctx());

    example_cross_border_remittance::destroy_for_testing(remittance);
    clock::destroy_for_testing(clock);
    scenario.end();
}

// ============================================
// FX QUOTE TESTS
// ============================================

#[test]
fun quote_dest_amount_basic() {
    // 1000 source at 0.85 -> 850 dest
    assert_eq!(example_cross_border_remittance::quote_dest_amount(1000, 850000), 850);
    // 1.0 rate is identity
    assert_eq!(example_cross_border_remittance::quote_dest_amount(1000, 1000000), 1000);
    // Zero source amount is always zero
    assert_eq!(example_cross_border_remittance::quote_dest_amount(0, 850000), 0);
    assert_eq!(example_cross_border_remittance::fx_rate_scale(), 1000000);
}

#[test]
fun quote_dest_amount_deterministic() {
    let a = example_cross_border_remittance::quote_dest_amount(1000, 850000);
    let b = example_cross_border_remittance::quote_dest_amount(1000, 850000);
    assert_eq!(a, b);
    let c = example_cross_border_remittance::quote_dest_amount(1000, 900000);
    assert!(a != c);
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_cross_border_remittance::EOverflow,
        location = sui_tunnel::example_cross_border_remittance,
    ),
]
fun quote_dest_amount_overflows() {
    let _ = example_cross_border_remittance::quote_dest_amount(
        18446744073709551615,
        2000000,
    );
    abort
}

// ============================================
// ON-CHAIN HTLC ROUTING (REAL FUND MOVEMENT)
// ============================================

const ALICE: address = @0xA11CE;
const BOB: address = @0xB0B;
const CAROL: address = @0xCA01;
const TUNNEL_TIMEOUT_MS: u64 = 7200000;
const PREIMAGE: vector<u8> = b"the_corridor_preimage";

/// Builds a real two-hop corridor Alice -> Bob -> Carol over two funded tunnels and
/// sets up the off-chain HTLC plan. Amount 1000, hop-0 fee 10 (so Alice locks 1010 to
/// Bob, Bob locks 1000 to Carol). Sender stays ALICE.
fun setup_two_hop(
    scenario: &mut test_scenario::Scenario,
    clock: &clock::Clock,
): (tunnel::Tunnel<SUI>, tunnel::Tunnel<SUI>, example_cross_border_remittance::Remittance) {
    let tunnel_ab = tunnel::create_active_for_testing<SUI>(
        ALICE,
        BOB,
        2000,
        1000,
        TUNNEL_TIMEOUT_MS,
        0,
        clock,
        scenario.ctx(),
    );
    let tunnel_bc = tunnel::create_active_for_testing<SUI>(
        BOB,
        CAROL,
        2000,
        1000,
        TUNNEL_TIMEOUT_MS,
        0,
        clock,
        scenario.ctx(),
    );

    let preimage = PREIMAGE;
    let invoice = example_cross_border_remittance::create_remittance_invoice(
        &preimage,
        1000,
        CAROL,
        3600000,
        b"goods",
        b"USD",
        b"EUR",
        850000,
    );
    let mut remittance = example_cross_border_remittance::initiate_remittance(
        &invoice,
        clock,
        scenario.ctx(),
    );
    example_cross_border_remittance::add_corridor_hop(
        &mut remittance,
        example_cross_border_remittance::corridor_tunnel_id(&tunnel_ab),
        BOB,
        10,
        3600000,
        scenario.ctx(),
    );
    example_cross_border_remittance::add_corridor_hop(
        &mut remittance,
        example_cross_border_remittance::corridor_tunnel_id(&tunnel_bc),
        CAROL,
        0,
        3480000,
        scenario.ctx(),
    );
    example_cross_border_remittance::setup_corridor_htlcs(
        &mut remittance,
        3600000,
        clock,
        scenario.ctx(),
    );

    (tunnel_ab, tunnel_bc, remittance)
}

#[test]
fun single_preimage_moves_real_funds_across_hops() {
    let mut scenario = test_scenario::begin(ALICE);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    let (mut tunnel_ab, mut tunnel_bc, remittance) = setup_two_hop(&mut scenario, &clock);

    // Forward: Alice locks 1010 to Bob, then Bob locks 1000 to Carol.
    example_cross_border_remittance::lock_corridor_htlc_no_sig_for_testing(
        &remittance,
        &mut tunnel_ab,
        0,
        &clock,
        scenario.ctx(),
    );
    scenario.next_tx(BOB);
    example_cross_border_remittance::lock_corridor_htlc_no_sig_for_testing(
        &remittance,
        &mut tunnel_bc,
        1,
        &clock,
        scenario.ctx(),
    );

    // Backward: Carol reveals the preimage to claim from Bob, then Bob claims from Alice.
    scenario.next_tx(CAROL);
    example_cross_border_remittance::claim_corridor_htlc(
        &remittance,
        &mut tunnel_bc,
        1,
        PREIMAGE,
        &clock,
        scenario.ctx(),
    );
    scenario.next_tx(BOB);
    example_cross_border_remittance::claim_corridor_htlc(
        &remittance,
        &mut tunnel_ab,
        0,
        PREIMAGE,
        &clock,
        scenario.ctx(),
    );

    // Carol received the 1000 remittance; Bob netted his 10 fee (received 1010, paid 1000).
    scenario.next_tx(CAROL);
    let to_carol = scenario.take_from_address<Coin<SUI>>(CAROL);
    assert_eq!(to_carol.value(), 1000);
    to_carol.burn_for_testing();

    scenario.next_tx(BOB);
    let to_bob = scenario.take_from_address<Coin<SUI>>(BOB);
    assert_eq!(to_bob.value(), 1010);
    to_bob.burn_for_testing();

    tunnel::destroy_for_testing(tunnel_ab);
    tunnel::destroy_for_testing(tunnel_bc);
    example_cross_border_remittance::destroy_for_testing(remittance);
    clock.destroy_for_testing();
    scenario.end();
}

#[test]
fun expire_returns_locked_funds_to_locker() {
    let mut scenario = test_scenario::begin(ALICE);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    let (mut tunnel_ab, tunnel_bc, remittance) = setup_two_hop(&mut scenario, &clock);

    // Alice locks hop 0 (1010) but the remittance never completes.
    example_cross_border_remittance::lock_corridor_htlc_no_sig_for_testing(
        &remittance,
        &mut tunnel_ab,
        0,
        &clock,
        scenario.ctx(),
    );

    // Hop-0 expiry is absolute: lock-time clock (1000) + base timeout (3600000).
    clock.set_for_testing(3601001);
    example_cross_border_remittance::expire_corridor_htlc(
        &remittance,
        &mut tunnel_ab,
        0,
        &clock,
        scenario.ctx(),
    );

    scenario.next_tx(ALICE);
    let refunded = scenario.take_from_address<Coin<SUI>>(ALICE);
    assert_eq!(refunded.value(), 1010);
    refunded.burn_for_testing();

    tunnel::destroy_for_testing(tunnel_ab);
    tunnel::destroy_for_testing(tunnel_bc);
    example_cross_border_remittance::destroy_for_testing(remittance);
    clock.destroy_for_testing();
    scenario.end();
}

#[test]
fun htlc_expiry_is_absolute_at_realistic_clock() {
    let mut scenario = test_scenario::begin(ALICE);
    let mut clock = clock::create_for_testing(scenario.ctx());

    // A realistic on-chain timestamp. With relative expiries this would exceed
    // the per-hop timeout and lock_htlc would abort EInvalidTimeout.
    let now = 1_700_000_000_000;
    clock.set_for_testing(now);

    let (mut tunnel_ab, mut tunnel_bc, remittance) = setup_two_hop(&mut scenario, &clock);

    // Locking succeeds only because each stored expiry_ms is now + relative_timeout > now.
    example_cross_border_remittance::lock_corridor_htlc_no_sig_for_testing(
        &remittance,
        &mut tunnel_ab,
        0,
        &clock,
        scenario.ctx(),
    );
    scenario.next_tx(BOB);
    example_cross_border_remittance::lock_corridor_htlc_no_sig_for_testing(
        &remittance,
        &mut tunnel_bc,
        1,
        &clock,
        scenario.ctx(),
    );

    tunnel::destroy_for_testing(tunnel_ab);
    tunnel::destroy_for_testing(tunnel_bc);
    example_cross_border_remittance::destroy_for_testing(remittance);
    clock.destroy_for_testing();
    scenario.end();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_cross_border_remittance::EHopTunnelMismatch,
        location = sui_tunnel::example_cross_border_remittance,
    ),
]
fun lock_with_wrong_tunnel_aborts() {
    let mut scenario = test_scenario::begin(ALICE);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    let (tunnel_ab, mut tunnel_bc, remittance) = setup_two_hop(&mut scenario, &clock);

    // Hop 0 is bound to tunnel_ab, but we pass tunnel_bc.
    example_cross_border_remittance::lock_corridor_htlc_no_sig_for_testing(
        &remittance,
        &mut tunnel_bc,
        0,
        &clock,
        scenario.ctx(),
    );

    // Unreachable; present so the test type-checks.
    tunnel::destroy_for_testing(tunnel_ab);
    tunnel::destroy_for_testing(tunnel_bc);
    example_cross_border_remittance::destroy_for_testing(remittance);
    clock.destroy_for_testing();
    scenario.end();
}

#[
    test,
    expected_failure(
        abort_code = sui_tunnel::example_cross_border_remittance::EInvalidState,
        location = sui_tunnel::example_cross_border_remittance,
    ),
]
fun receipt_before_settlement_aborts() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let preimage = b"secret_preimage";
    let invoice = example_cross_border_remittance::create_remittance_invoice(
        &preimage,
        10000,
        @0x0,
        7200000,
        b"",
        b"USD",
        b"EUR",
        850000,
    );
    let remittance = example_cross_border_remittance::initiate_remittance(
        &invoice,
        &clock,
        &mut ctx,
    );

    // Still REMITTANCE_CREATED, so a receipt cannot be issued before settlement.
    example_cross_border_remittance::create_remittance_receipt(
        &remittance,
        b"USD",
        b"EUR",
        850000,
        1,
    );

    let _r = remittance;
    abort
}

#[test]
fun fail_remittance_marks_failed_and_retryable() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let preimage = b"secret_preimage";
    let invoice = example_cross_border_remittance::create_remittance_invoice(
        &preimage,
        10000,
        @0x0,
        7200000,
        b"",
        b"USD",
        b"EUR",
        850000,
    );
    let mut remittance = example_cross_border_remittance::initiate_remittance(
        &invoice,
        &clock,
        &mut ctx,
    );
    example_cross_border_remittance::add_corridor_hop(
        &mut remittance,
        b"r1",
        @0xB,
        100,
        3600000,
        &ctx,
    );
    example_cross_border_remittance::add_corridor_hop(
        &mut remittance,
        b"r2",
        @0x0,
        50,
        3480000,
        &ctx,
    );
    example_cross_border_remittance::setup_corridor_htlcs(&mut remittance, 3600000, &clock, &ctx);

    // Sender unwinds the corridor; the remittance becomes retryable.
    example_cross_border_remittance::fail_remittance(&mut remittance, &clock, &ctx);
    assert_eq!(
        example_cross_border_remittance::remittance_status(&remittance),
        example_cross_border_remittance::remittance_failed(),
    );
    assert!(!example_cross_border_remittance::is_remittance_successful(&remittance));
    assert!(example_cross_border_remittance::can_retry(&remittance));

    example_cross_border_remittance::destroy_for_testing(remittance);
    clock::destroy_for_testing(clock);
}
