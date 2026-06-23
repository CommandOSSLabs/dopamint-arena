#[test_only]
module sui_tunnel::example_pixel_war_tests;

use std::unit_test::assert_eq;
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui_tunnel::example_pixel_war as war;

const PK_A: vector<u8> = x"0000000000000000000000000000000000000000000000000000000000000001";
const PK_B: vector<u8> = x"0000000000000000000000000000000000000000000000000000000000000002";
const HASH32: vector<u8> = x"00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const HASH31: vector<u8> = x"00112233445566778899aabbccddeeff00112233445566778899aabbccddee";

/// Open + fund party A on a 8x8 board, cap 64, overwrite limit 3, stake 1000.
fun open(clock: &clock::Clock, ctx: &mut TxContext): war::PixelWarGame<SUI> {
    let stake = coin::mint_for_testing<SUI>(1000, ctx);
    war::create_game<SUI>(@0x0, PK_A, @0x2, PK_B, stake, 8, 8, 64, 3, clock, ctx)
}

#[test]
fun outcome_and_status_constants_match_offchain() {
    assert_eq!(war::game_active(), 0);
    assert_eq!(war::game_settled(), 1);
    assert_eq!(war::game_disputed(), 2);
    assert_eq!(war::game_force_closed(), 3);
    // Winner-code parity with the off-chain `Winner` (0 none,1 A,2 B,3 draw).
    assert_eq!(war::outcome_none(), 0);
    assert_eq!(war::outcome_player_a(), 1);
    assert_eq!(war::outcome_player_b(), 2);
    assert_eq!(war::outcome_draw(), 3);
    assert_eq!(war::protocol_tag(), b"pixel_paint.war.v1");
}

#[test]
fun create_locks_party_a_stake_into_pot() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);

    let game = open(&clock, &mut ctx);

    assert_eq!(war::game_status<SUI>(&game), 0);
    assert_eq!(war::game_total_pot<SUI>(&game), 1000);
    assert_eq!(war::game_stake_amount<SUI>(&game), 1000);
    assert_eq!(war::game_nonce<SUI>(&game), 0);
    assert_eq!(war::game_winner<SUI>(&game), 0);
    assert_eq!(war::game_owned_a<SUI>(&game), 0);
    assert_eq!(war::game_owned_b<SUI>(&game), 0);
    assert_eq!(war::game_placed<SUI>(&game), 0);
    assert_eq!(war::game_width<SUI>(&game), 8);
    assert_eq!(war::game_cap<SUI>(&game), 64);
    assert_eq!(war::game_overwrite_limit<SUI>(&game), 3);

    war::destroy_game_for_testing<SUI>(game);
    clock::destroy_for_testing(clock);
}

#[test, expected_failure(abort_code = sui_tunnel::example_pixel_war::EBalanceMismatch, location = sui_tunnel::example_pixel_war)]
fun join_requires_matching_stake() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let mut game = open(&clock, &mut ctx);

    // Mismatched stake (500 != 1000) aborts before any deposit.
    let bad = coin::mint_for_testing<SUI>(500, &mut ctx);
    war::join_game<SUI>(&mut game, bad, &clock, &ctx);

    war::destroy_game_for_testing<SUI>(game);
    clock::destroy_for_testing(clock);
}

#[test]
fun record_move_without_signatures_advances_mirror_only() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let mut game = open(&clock, &mut ctx);

    // Empty sigs → checkpoint the mirror scalars without touching tunnel balances.
    war::record_move<SUI>(
        &mut game,
        HASH32,
        1, // nonce
        5, // placed
        3, // owned_a
        2, // owned_b
        0, // winner (ongoing)
        1000, // party_a_balance (unused: sigs empty)
        0, // party_b_balance
        0, // timestamp
        vector[], // sig_a
        vector[], // sig_b
        &clock,
    );

    assert_eq!(war::game_nonce<SUI>(&game), 1);
    assert_eq!(war::game_placed<SUI>(&game), 5);
    assert_eq!(war::game_owned_a<SUI>(&game), 3);
    assert_eq!(war::game_owned_b<SUI>(&game), 2);
    assert_eq!(war::game_state_hash<SUI>(&game).length(), 32);
    // Balances untouched — only A's deposit is in the pot.
    assert_eq!(war::game_total_pot<SUI>(&game), 1000);

    war::destroy_game_for_testing<SUI>(game);
    clock::destroy_for_testing(clock);
}

#[test, expected_failure(abort_code = sui_tunnel::example_pixel_war::EInvalidNonce, location = sui_tunnel::example_pixel_war)]
fun record_move_rejects_non_monotonic_nonce() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let mut game = open(&clock, &mut ctx);

    // nonce 0 is not strictly greater than the initial nonce 0.
    war::record_move<SUI>(&mut game, HASH32, 0, 1, 1, 0, 0, 1000, 0, 0, vector[], vector[], &clock);

    war::destroy_game_for_testing<SUI>(game);
    clock::destroy_for_testing(clock);
}

#[test, expected_failure(abort_code = sui_tunnel::example_pixel_war::EInvalidParameter, location = sui_tunnel::example_pixel_war)]
fun record_move_rejects_wrong_hash_length() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let mut game = open(&clock, &mut ctx);

    // Valid nonce, but a 31-byte hash is rejected.
    war::record_move<SUI>(&mut game, HASH31, 1, 1, 1, 0, 0, 1000, 0, 0, vector[], vector[], &clock);

    war::destroy_game_for_testing<SUI>(game);
    clock::destroy_for_testing(clock);
}

#[test, expected_failure(abort_code = sui_tunnel::example_pixel_war::ENoActiveDispute, location = sui_tunnel::example_pixel_war)]
fun force_close_only_from_disputed() {
    let mut ctx = sui::tx_context::dummy();
    let clock = clock::create_for_testing(&mut ctx);
    let mut game = open(&clock, &mut ctx);

    // Game is ACTIVE, not DISPUTED → force_close aborts.
    war::force_close<SUI>(&mut game, &clock, &mut ctx);

    war::destroy_game_for_testing<SUI>(game);
    clock::destroy_for_testing(clock);
}
