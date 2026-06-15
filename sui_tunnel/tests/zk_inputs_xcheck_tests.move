// Cross-language golden test: the TS SDK's ZK public-input encoding
// (sui-tunnel-ts/src/zk/{scalars,cardCircuit}.ts) must match what the on-chain Groth16
// verifier consumes (zk_verifier::concat_scalars over 32-byte scalars; u64 scalars are
// little-endian). This ensures a card-in-deck proof built off-chain feeds correctly into
// zk_verifier::verify_circuit_proof during a dispute.
//
// Statement: deckRoot = 0x01..0x20, position = 5, card = 42.
#[test_only]
module sui_tunnel::zk_inputs_xcheck_tests;

use std::unit_test::assert_eq;
use sui_tunnel::zk_verifier;

#[test]
fun public_inputs_match_sdk() {
    let deck_root = x"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
    let inputs = zk_verifier::concat_scalars(vector[
        deck_root,
        zk_verifier::u64_to_scalar(5),
        zk_verifier::u64_to_scalar(42),
    ]);
    assert_eq!(
        inputs,
        x"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f2005000000000000000000000000000000000000000000000000000000000000002a00000000000000000000000000000000000000000000000000000000000000",
    );
}
