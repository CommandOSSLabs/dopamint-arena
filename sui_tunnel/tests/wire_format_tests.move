// Cross-language golden-vector test: proves the Move serializers and commit-reveal
// hashing produce bytes byte-identical to the TypeScript SDK
// (sui-tunnel-ts/src/core/{wire,commitment,crypto}.ts).
//
// The same golden hex constants appear in sui-tunnel-ts/src/core/*.test.ts. If you
// change either side, you MUST change both in lockstep or off-chain signatures will
// silently fail to verify at on-chain settlement/dispute.
//
// Canonical inputs (shared with golden.gen.ts):
//   tunnel_id   = @0xab
//   state_hash  = 0x01..0x20
//   nonce=42 timestamp=1234567890 party_a_balance=1000 party_b_balance=2000
//   settlement final_nonce=43
//   htlc: payment_hash=0x01..0x20 amount=500 sender=@0xaa receiver=@0xbb expiry=9999999
//   commitment: value=0x07 salt=0x01..0x10 ; combine with value=0x2a salt=0x11..0x20
#[test_only]
module sui_tunnel::wire_format_tests;

use std::unit_test::assert_eq;
use sui_tunnel::randomness;
use sui_tunnel::signature;
use sui_tunnel::tunnel;

const STATE_HASH: vector<u8> = x"0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";

#[test]
fun state_update_matches_sdk_golden() {
    let id = sui::object::id_from_address(@0xab);
    let data = tunnel::create_state_update_data_for_testing(
        id,
        STATE_HASH,
        42,
        1234567890,
        1000,
        2000,
    );
    let bytes = data.serialize_state_update();
    assert_eq!(
        bytes,
        x"7375695f74756e6e656c3a3a73746174655f75706461746500000000000000000000000000000000000000000000000000000000000000ab0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20000000000000002a00000000499602d200000000000003e800000000000007d0",
    );
}

#[test]
fun settlement_matches_sdk_golden() {
    let id = sui::object::id_from_address(@0xab);
    let data = tunnel::create_settlement_data_for_testing(id, 1000, 2000, 43, 1234567890);
    let bytes = data.serialize_settlement();
    assert_eq!(
        bytes,
        x"7375695f74756e6e656c3a3a736574746c656d656e7400000000000000000000000000000000000000000000000000000000000000ab00000000000003e800000000000007d0000000000000002b00000000499602d2",
    );
}

#[test]
fun settlement_with_root_matches_sdk_golden() {
    // Root-anchored settlement (Deliverable 7/8); transcript_root = STATE_HASH (0x01..0x20).
    let id = sui::object::id_from_address(@0xab);
    let data = tunnel::create_settlement_with_root_data_for_testing(
        id,
        1000,
        2000,
        43,
        1234567890,
        STATE_HASH,
    );
    let bytes = data.serialize_settlement_with_root();
    assert_eq!(
        bytes,
        x"7375695f74756e6e656c3a3a736574746c656d656e745f763200000000000000000000000000000000000000000000000000000000000000ab00000000000003e800000000000007d0000000000000002b00000000499602d20102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
    );
}

#[test]
fun htlc_lock_matches_sdk_golden() {
    let id = sui::object::id_from_address(@0xab);
    let data = tunnel::create_htlc_lock_data_for_testing(
        id,
        STATE_HASH,
        500,
        @0xaa,
        @0xbb,
        9999999,
    );
    let bytes = data.serialize_htlc_lock();
    assert_eq!(
        bytes,
        x"7375695f74756e6e656c3a3a68746c635f6c6f636b00000000000000000000000000000000000000000000000000000000000000ab0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f2000000000000001f400000000000000000000000000000000000000000000000000000000000000aa00000000000000000000000000000000000000000000000000000000000000bb000000000098967f",
    );
}

#[test]
fun commitment_matches_sdk_golden() {
    // value=0x07, salt=0x01..0x10 (16 bytes)
    let commitment = randomness::create_commitment(
        &x"07",
        &x"0102030405060708090a0b0c0d0e0f10",
        @0x0,
        0,
    );
    assert_eq!(
        *commitment.commitment_hash(),
        x"9c5d7de7c93e176f232424794b460112bbc1e3edad6af9da200a121e7033f9f9",
    );
}

#[test]
fun combined_seed_matches_sdk_golden() {
    let reveal_a = randomness::create_reveal(x"07", x"0102030405060708090a0b0c0d0e0f10");
    let reveal_b = randomness::create_reveal(x"2a", x"1112131415161718191a1b1c1d1e1f20");
    let seed = reveal_a.combine_reveals(&reveal_b);
    assert_eq!(
        *seed.seed_bytes(),
        x"3783060fbc9a59b74485cbd081355de0b78609fb6db3b76d0c97f937dac4b795",
    );
}

#[test]
fun blake2b256_matches_sdk() {
    // Confirms @noble/hashes blake2b(dkLen:32) == Sui hash::blake2b256.
    assert_eq!(
        sui::hash::blake2b256(&b"hello"),
        x"324dcf027dd4a30a932c441f365a25e86b173defa4b8e58948253471b81b72cf",
    );
}

#[test]
fun sdk_signed_state_update_verifies_onchain() {
    // End-to-end: a dual-signed state_update produced entirely by the TS SDK
    // (core/tunnel.ts + core/crypto.ts, ed25519, fixed secrets 0x01..0x20 / 0x21..0x40)
    // is accepted by the on-chain verifier. Proves SDK-signed off-chain updates settle.
    let id = sui::object::id_from_address(@0xab);
    let data = tunnel::create_state_update_data_for_testing(
        id,
        STATE_HASH,
        42,
        1234567890,
        1000,
        2000,
    );
    let msg = data.serialize_state_update();

    let pk_a = x"79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664";
    let pk_b = x"e7f162a10bec559afea195e4dce84b69568d5d2cb0963eb446c0685e2b17f2f0";
    let sig_a =
        x"6941c8ba5bd00d2695d5edd6d33e3fb3e46a83685e09717382b0b0b82246726323a6abc9bec1ebb8535bb3100a03bf5205e7ce5c898f8d071916c4c795ac180b";
    let sig_b =
        x"3ee65d80264ea3e9e780937916c9815de8a4ce7ac162eef0ab2c65fbe272fc52564fac381dc1db49814a055e53ca2ab63e04f1b4d1154424ac9246c9f6f5440c";

    assert!(signature::verify(signature::ed25519(), &pk_a, &msg, &sig_a));
    assert!(signature::verify(signature::ed25519(), &pk_b, &msg, &sig_b));
}
