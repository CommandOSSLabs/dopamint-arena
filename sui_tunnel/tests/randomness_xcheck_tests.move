// Cross-language golden test: proves the TS SDK's verifiable randomness
// (sui-tunnel-ts/src/core/randomness.ts) produces a byte-identical dealerless deck
// to randomness.move. This is what lets the Quantum Poker shuffle, derived off-chain
// from a two-party commit-reveal seed, be re-derived and adjudicated on-chain.
//
// Same inputs as wire_format_tests commit-reveal vectors:
//   reveal_a = (value 0x07, salt 0x01..0x10), reveal_b = (value 0x2a, salt 0x11..0x20)
//   deck = [0..51], Fisher-Yates shuffle with seed = combine_reveals(reveal_a, reveal_b)
#[test_only]
module sui_tunnel::randomness_xcheck_tests;

use std::unit_test::assert_eq;
use sui_tunnel::randomness;

#[test]
fun shuffle_matches_sdk_golden() {
    let reveal_a = randomness::create_reveal(x"07", x"0102030405060708090a0b0c0d0e0f10");
    let reveal_b = randomness::create_reveal(x"2a", x"1112131415161718191a1b1c1d1e1f20");
    let seed = randomness::combine_reveals(&reveal_a, &reveal_b);

    let mut deck = vector<u8>[];
    let mut i = 0u8;
    while (i < 52) {
        deck.push_back(i);
        i = i + 1;
    };

    let _final = randomness::shuffle(&seed, &mut deck);
    assert_eq!(
        deck,
        x"1d283225010b1219072c0c29302a170a0f002b1513082d312602112e101c1405221f0e1a1e0d33092003182723161b04212f0624",
    );
}
