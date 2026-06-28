#[test_only]
module mtps::mtps_tests;

use mtps::mtps::{Self, AdminCap, MTPS};
use sui::test_scenario as ts;
use std::unit_test::assert_eq;
use sui::coin::Coin;
use sui::coin_registry::MetadataCap;

#[test]
fun admin_mint_sends_requested_amount_to_recipient() {
    let backend = @0xA;
    let user = @0xB;
    let mut scenario = ts::begin(backend);
    mtps::test_init(scenario.ctx());

    // The AdminCap (holding the treasury) lands with the deployer/backend.
    scenario.next_tx(backend);
    let mut cap = scenario.take_from_sender<AdminCap>();
    mtps::admin_mint(&mut cap, 1_234, user, scenario.ctx());
    // Mint again — fresh supply each call.
    mtps::admin_mint(&mut cap, 766, user, scenario.ctx());
    scenario.return_to_sender(cap);

    scenario.next_tx(user);
    let c1 = scenario.take_from_sender<Coin<MTPS>>();
    let c2 = scenario.take_from_sender<Coin<MTPS>>();
    assert_eq!(c1.value() + c2.value(), 2_000);
    scenario.return_to_sender(c1);
    scenario.return_to_sender(c2);
    scenario.end();
}

/// Boundary: the per-call bound is inclusive (`amount <= MAX`), so a mint of exactly the cap
/// succeeds. Guards against a regression to a strict `<`.
#[test]
fun mint_at_exact_per_call_cap_succeeds() {
    let backend = @0xA;
    let user = @0xB;
    let mut scenario = ts::begin(backend);
    mtps::test_init(scenario.ctx());

    scenario.next_tx(backend);
    let mut cap = scenario.take_from_sender<AdminCap>();
    let max = mtps::max_mint_per_call();
    mtps::admin_mint(&mut cap, max, user, scenario.ctx());
    scenario.return_to_sender(cap);

    scenario.next_tx(user);
    let c = scenario.take_from_sender<Coin<MTPS>>();
    assert_eq!(c.value(), max);
    scenario.return_to_sender(c);
    scenario.end();
}

/// One unit over the cap aborts before any coin is minted.
#[test, expected_failure(abort_code = mtps::EAmountTooLarge)]
fun mint_above_per_call_cap_aborts() {
    let backend = @0xA;
    let user = @0xB;
    let mut scenario = ts::begin(backend);
    mtps::test_init(scenario.ctx());

    scenario.next_tx(backend);
    let mut cap = scenario.take_from_sender<AdminCap>();
    mtps::admin_mint(&mut cap, mtps::max_mint_per_call() + 1, user, scenario.ctx());
    scenario.return_to_sender(cap);
    scenario.end();
}

/// No lower-bound guard: minting 0 is allowed and yields a 0-value coin (documents the contract).
#[test]
fun mint_zero_amount_yields_zero_coin() {
    let backend = @0xA;
    let user = @0xB;
    let mut scenario = ts::begin(backend);
    mtps::test_init(scenario.ctx());

    scenario.next_tx(backend);
    let mut cap = scenario.take_from_sender<AdminCap>();
    mtps::admin_mint(&mut cap, 0, user, scenario.ctx());
    scenario.return_to_sender(cap);

    scenario.next_tx(user);
    let c = scenario.take_from_sender<Coin<MTPS>>();
    assert_eq!(c.value(), 0);
    scenario.return_to_sender(c);
    scenario.end();
}

/// The MetadataCap is kept (not burned) and lands with the deployer, so symbol/name/icon stay
/// updatable post-deploy (ADR-0015 §Decision 2).
#[test]
fun init_hands_metadata_cap_to_deployer() {
    let backend = @0xA;
    let mut scenario = ts::begin(backend);
    mtps::test_init(scenario.ctx());

    scenario.next_tx(backend);
    let meta = scenario.take_from_sender<MetadataCap<MTPS>>();
    scenario.return_to_sender(meta);
    scenario.end();
}

#[test]
fun burn_destroys_minted_supply() {
    let backend = @0xA;
    let mut scenario = ts::begin(backend);
    mtps::test_init(scenario.ctx());

    scenario.next_tx(backend);
    let mut cap = scenario.take_from_sender<AdminCap>();
    mtps::admin_mint(&mut cap, 500, backend, scenario.ctx());
    scenario.return_to_sender(cap);

    scenario.next_tx(backend);
    let coin = scenario.take_from_sender<Coin<MTPS>>();
    let mut cap = scenario.take_from_sender<AdminCap>();
    mtps::burn(&mut cap, coin);
    scenario.return_to_sender(cap);
    scenario.end();
}
