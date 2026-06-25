//! Whole-match parity gate: a fixed-key Rust blackjack match must be byte-and-signature
//! identical to the TS loadbench driver. Vectors captured from match.ts (see vectors file).

use rustbench::driver::play_fixed_match;
use rustbench::engine::crypto::keypair_from_secret;
use rustbench::engine::wire::serialize_settlement_with_root;

fn field<'a>(json: &'a str, key: &str) -> &'a str {
    // minimal dependency-free string scan; needle includes the closing quote so
    // "final_balance_a" cannot collide with "final_balance_b" etc.
    let needle = format!("\"{key}\"");
    let start = json.find(&needle).expect("key present");
    let after = &json[start + needle.len()..];
    let colon = after.find(':').unwrap();
    let rest = &after[colon + 1..];
    // value is either a quoted string or a bare number until , or }
    let trimmed = rest.trim_start();
    if let Some(stripped) = trimmed.strip_prefix('"') {
        let end = stripped.find('"').unwrap();
        &stripped[..end]
    } else {
        let end = trimmed.find([',', '}', '\n']).unwrap();
        trimmed[..end].trim()
    }
}

#[test]
fn fixed_match_matches_ts_golden() {
    let json = include_str!("vectors/blackjack_match.json");
    let sa: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
    let sb: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);

    // sanity: our keys are the golden keys
    assert_eq!(
        hex::encode(keypair_from_secret(&sa).public_key()),
        field(json, "pk_a")
    );
    assert_eq!(
        hex::encode(keypair_from_secret(&sb).public_key()),
        field(json, "pk_b")
    );

    let r = play_fixed_match("0xab", &sa, &sb, 200, 200, 1234567890, 500);

    assert_eq!(r.moves.to_string(), field(json, "moves"), "move count");
    assert_eq!(
        r.bytes.to_string(),
        field(json, "bytes"),
        "total frame bytes"
    );
    assert_eq!(
        r.final_balance_a.to_string(),
        field(json, "final_balance_a")
    );
    assert_eq!(
        r.final_balance_b.to_string(),
        field(json, "final_balance_b")
    );
    assert_eq!(
        r.settlement.final_nonce.to_string(),
        field(json, "final_nonce")
    );
    assert_eq!(r.settlement.timestamp.to_string(), field(json, "timestamp"));

    let root: [u8; 32] = {
        let mut o = [0u8; 32];
        hex::decode_to_slice(field(json, "transcript_root"), &mut o).unwrap();
        o
    };
    assert_eq!(
        hex::encode(serialize_settlement_with_root(&r.settlement, &root)),
        field(json, "settle_msg")
    );
    assert_eq!(hex::encode(r.sig_a), field(json, "sig_a"));
    assert_eq!(hex::encode(r.sig_b), field(json, "sig_b"));
}
