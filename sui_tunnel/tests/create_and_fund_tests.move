#[test_only]
module sui_tunnel::create_and_fund_tests;

use std::unit_test::assert_eq;
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario;
use sui_tunnel::signature;
use sui_tunnel::tunnel::{Self, Tunnel};

// 32-byte ed25519 public keys (length is what create_and_fund validates).
const PK_A: vector<u8> = x"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PK_B: vector<u8> = x"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

// The whole point of create_and_fund: a sender that is NEITHER party funds both stakes.
// Here @0xF is the wallet, @0xA/@0xB are the user's ephemeral (fundless) agent keys.
#[test]
fun create_and_fund_opens_active_from_non_party_funder() {
    let funder = @0xF;
    let party_a = @0xA;
    let party_b = @0xB;
    let a_amount = 1000;
    let b_amount = 250;

    let mut scenario = test_scenario::begin(funder);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    let coin_a = coin::mint_for_testing<SUI>(a_amount, scenario.ctx());
    let coin_b = coin::mint_for_testing<SUI>(b_amount, scenario.ctx());

    tunnel::create_and_fund<SUI>(
        party_a,
        PK_A,
        signature::ed25519(),
        party_b,
        PK_B,
        signature::ed25519(),
        coin_a,
        coin_b,
        60000,
        0,
        &clock,
        scenario.ctx(),
    );

    // Shared objects are not visible in the tx that shared them.
    scenario.next_tx(funder);
    let t = scenario.take_shared<Tunnel<SUI>>();

    // Funding both sides activates the tunnel even though the funder is not a party.
    assert_eq!(t.is_active(), true);
    assert_eq!(t.total_balance(), a_amount + b_amount);
    assert_eq!(t.party_a_deposit(), a_amount);
    assert_eq!(t.party_b_deposit(), b_amount);

    test_scenario::return_shared(t);
    clock.destroy_for_testing();
    scenario.end();
}

// The funding model at scale: one non-party funder opens+funds+activates five INDEPENDENT
// tunnels for fundless ephemeral keys in a single tx. Distinct stakes and a fixed 4:1 a:b
// ratio pin each failure to one assertion (wrong-tunnel stake → totals set; a/b swap →
// ratio; skipped activation → event count). Proves the function's logic across N opens in
// one TxContext — NOT real PTB composition (that is the localnet TS-SDK harness).
#[test]
fun one_funder_opens_and_activates_five_tunnels() {
    let funder = @0xF;
    let party_as = vector[@0xA1, @0xA2, @0xA3, @0xA4, @0xA5];
    let party_bs = vector[@0xB1, @0xB2, @0xB3, @0xB4, @0xB5];
    let n = 5;

    let mut scenario = test_scenario::begin(funder);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    // All five opens land in the begin() transaction. Stakes scale with the index
    // so every tunnel's total is distinct and a == 4 * b holds for each.
    let mut i = 0;
    while (i < n) {
        let coin_a = coin::mint_for_testing<SUI>(1000 * (i + 1), scenario.ctx());
        let coin_b = coin::mint_for_testing<SUI>(250 * (i + 1), scenario.ctx());
        tunnel::create_and_fund<SUI>(
            *party_as.borrow(i),
            PK_A,
            signature::ed25519(),
            *party_bs.borrow(i),
            PK_B,
            signature::ed25519(),
            coin_a,
            coin_b,
            60000,
            0,
            &clock,
            scenario.ctx(),
        );
        i = i + 1;
    };

    // effects.shared is exactly the five tunnels (minted coins are consumed in-tx;
    // the clock is owned, not shared). Each tunnel must emit Created + Deposit x2 +
    // Activated = 4 events the backend indexer consumes.
    let effects = scenario.next_tx(funder);
    let tunnel_ids = test_scenario::shared(&effects);
    assert_eq!(tunnel_ids.length(), n);
    assert_eq!(test_scenario::num_user_events(&effects), n * 4);

    // Every tunnel is independently ACTIVE and holds exactly its own two stakes.
    let mut totals = vector[];
    let mut j = 0;
    while (j < n) {
        let t = scenario.take_shared_by_id<Tunnel<SUI>>(*tunnel_ids.borrow(j));
        assert_eq!(t.is_active(), true);
        let a = t.party_a_deposit();
        let b = t.party_b_deposit();
        assert_eq!(a, b * 4);
        assert_eq!(t.total_balance(), a + b);
        totals.push_back(a + b);
        test_scenario::return_shared(t);
        j = j + 1;
    };

    // The five distinct totals each appear once: no stake landed in the wrong
    // tunnel and no tunnel was funded twice from a reused coin.
    let expected = vector[1250u64, 2500, 3750, 5000, 6250];
    let mut k = 0;
    while (k < n) {
        assert_eq!(totals.contains(expected.borrow(k)), true);
        k = k + 1;
    };

    clock.destroy_for_testing();
    scenario.end();
}

// ---- Negative paths: create_and_fund must be wired to the same validators as `create`. ----
// Each pins one failure mode of the shared param/deposit checks. The trailing cleanup never
// runs (the call aborts) but is required to type-check the function.

// A zero timeout would let funds be trapped forever, so it is rejected up front.
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::tunnel::EInvalidTimeout,
        location = sui_tunnel::tunnel,
    ),
]
fun create_and_fund_rejects_zero_timeout() {
    let mut scenario = test_scenario::begin(@0xF);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    let coin_a = coin::mint_for_testing<SUI>(1000, scenario.ctx());
    let coin_b = coin::mint_for_testing<SUI>(250, scenario.ctx());

    tunnel::create_and_fund<SUI>(
        @0xA,
        PK_A,
        signature::ed25519(),
        @0xB,
        PK_B,
        signature::ed25519(),
        coin_a,
        coin_b,
        0, // zero timeout
        0,
        &clock,
        scenario.ctx(),
    );

    clock.destroy_for_testing();
    scenario.end();
}

// Both parties sharing one address is meaningless for a two-party channel.
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::tunnel::EInvalidParties,
        location = sui_tunnel::tunnel,
    ),
]
fun create_and_fund_rejects_same_party() {
    let mut scenario = test_scenario::begin(@0xF);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    let coin_a = coin::mint_for_testing<SUI>(1000, scenario.ctx());
    let coin_b = coin::mint_for_testing<SUI>(250, scenario.ctx());

    tunnel::create_and_fund<SUI>(
        @0xA,
        PK_A,
        signature::ed25519(),
        @0xA, // party_b == party_a
        PK_B,
        signature::ed25519(),
        coin_a,
        coin_b,
        60000,
        0,
        &clock,
        scenario.ctx(),
    );

    clock.destroy_for_testing();
    scenario.end();
}

// A public key whose length does not match its scheme (ed25519 wants 32 bytes) is rejected.
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::tunnel::EInvalidPublicKey,
        location = sui_tunnel::tunnel,
    ),
]
fun create_and_fund_rejects_bad_pubkey_length() {
    let mut scenario = test_scenario::begin(@0xF);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    let coin_a = coin::mint_for_testing<SUI>(1000, scenario.ctx());
    let coin_b = coin::mint_for_testing<SUI>(250, scenario.ctx());

    tunnel::create_and_fund<SUI>(
        @0xA,
        x"AABB", // 2 bytes != 32 for ed25519
        signature::ed25519(),
        @0xB,
        PK_B,
        signature::ed25519(),
        coin_a,
        coin_b,
        60000,
        0,
        &clock,
        scenario.ctx(),
    );

    clock.destroy_for_testing();
    scenario.end();
}

// A zero-value stake is below MIN_DEPOSIT, so the first deposit_internal aborts — the new
// entry inherits the deposit-path guard rather than skipping it.
#[
    test,
    expected_failure(
        abort_code = sui_tunnel::tunnel::EMinimumDepositNotMet,
        location = sui_tunnel::tunnel,
    ),
]
fun create_and_fund_rejects_zero_value_coin() {
    let mut scenario = test_scenario::begin(@0xF);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1000);

    let coin_a = coin::mint_for_testing<SUI>(0, scenario.ctx()); // below MIN_DEPOSIT
    let coin_b = coin::mint_for_testing<SUI>(250, scenario.ctx());

    tunnel::create_and_fund<SUI>(
        @0xA,
        PK_A,
        signature::ed25519(),
        @0xB,
        PK_B,
        signature::ed25519(),
        coin_a,
        coin_b,
        60000,
        0,
        &clock,
        scenario.ctx(),
    );

    clock.destroy_for_testing();
    scenario.end();
}
