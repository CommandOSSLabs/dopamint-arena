use tunnel_blackjack::v2::{
    compute_slot_commitment, derive_rank, BlackjackV2, BlackjackV2Move, BlackjackV2Reveal,
    BlackjackV2Secret, Phase, WAGER,
};
use tunnel_harness::{Balances, Protocol, Seat, TunnelContext};

fn ctx() -> TunnelContext {
    TunnelContext {
        tunnel_id: "0xab".into(),
        initial: Balances { a: 1000, b: 1000 },
        seat: Seat::A,
    }
}

fn secret(value: u8, salt: u8) -> BlackjackV2Secret {
    BlackjackV2Secret {
        value: vec![value],
        salt: vec![salt; 16],
    }
}

fn commit(secret: BlackjackV2Secret) -> BlackjackV2Move {
    BlackjackV2Move::Commit {
        commitment: compute_slot_commitment(&secret).unwrap(),
        local_secret: Some(secret),
    }
}

fn reveal(secret: BlackjackV2Secret) -> BlackjackV2Move {
    BlackjackV2Move::Reveal {
        reveal: BlackjackV2Reveal {
            value: secret.value,
            salt: secret.salt,
        },
    }
}

/// Place the opening bet (player of round 1 = Seat::A) to begin round 1 (→ draw_commit). The
/// protocol awaits a `bet` before the first deal (FE parity), so card-machinery tests deal first.
fn deal(
    protocol: &BlackjackV2,
    state: &<BlackjackV2 as Protocol>::State,
) -> <BlackjackV2 as Protocol>::State {
    protocol
        .apply_move(state, &BlackjackV2Move::Bet { amount: WAGER }, Seat::A)
        .unwrap()
}

#[test]
fn initial_state_awaits_opening_bet_then_bet_begins_round() {
    let protocol = BlackjackV2;
    let state = protocol.initial_state(&ctx());
    assert_eq!(protocol.name(), "blackjack.v2");
    // No auto-deal: starts at round_over with no wager, awaiting the player's first bet (FE parity).
    assert_eq!(state.phase, Phase::RoundOver);
    assert_eq!(state.round, 0);
    assert_eq!(state.wager, 0);
    assert_eq!(protocol.balances(&state).sum(), 2000);

    // The opening bet sets the wager and deals round 1.
    let dealt = deal(&protocol, &state);
    assert_eq!(dealt.phase, Phase::DrawCommit);
    assert_eq!(dealt.round, 1);
    assert_eq!(dealt.wager, WAGER);
}

#[test]
fn derive_rank_is_deterministic_and_uses_both_reveals() {
    let a = secret(7, 1);
    let b = secret(42, 2);
    let rank = derive_rank(&a.clone().into(), &b.clone().into());
    assert_eq!(rank, derive_rank(&a.clone().into(), &b.clone().into()));
    assert!((1..=13).contains(&rank));

    let mut distinct = std::collections::BTreeSet::new();
    for i in 0..64 {
        distinct.insert(derive_rank(&a.clone().into(), &secret(i, 3).into()));
    }
    assert!(distinct.len() > 1);
}

#[test]
fn both_commits_enter_reveal_phase_and_bad_reveal_is_rejected() {
    let protocol = BlackjackV2;
    let mut state = deal(&protocol, &protocol.initial_state(&ctx()));
    let a = secret(1, 1);
    let b = secret(2, 2);
    state = protocol
        .apply_move(&state, &commit(a.clone()), Seat::A)
        .unwrap();
    assert_eq!(state.phase, Phase::DrawCommit);
    state = protocol
        .apply_move(&state, &commit(b.clone()), Seat::B)
        .unwrap();
    assert_eq!(state.phase, Phase::DrawReveal);

    assert!(protocol
        .apply_move(&state, &reveal(secret(99, 9)), Seat::A)
        .is_err());
}

#[test]
fn two_reveals_apply_one_card_and_advance_to_next_draw() {
    let protocol = BlackjackV2;
    let mut state = deal(&protocol, &protocol.initial_state(&ctx()));
    let a = secret(1, 1);
    let b = secret(2, 2);
    state = protocol
        .apply_move(&state, &commit(a.clone()), Seat::A)
        .unwrap();
    state = protocol
        .apply_move(&state, &commit(b.clone()), Seat::B)
        .unwrap();
    state = protocol.apply_move(&state, &reveal(a), Seat::A).unwrap();
    state = protocol.apply_move(&state, &reveal(b), Seat::B).unwrap();

    assert_eq!(state.draw_count, 1);
    assert_eq!(state.player_hand.len(), 1);
    assert_eq!(state.phase, Phase::DrawCommit);
    assert!(protocol
        .encode_state(&state)
        .starts_with(b"sui_tunnel::proto::blackjack.v2"));
}

// Cross-language encode_state golden: the EXACT bytes the FE `BlackjackProtocol` (blackjack.v2)
// produces, generated from sui-tunnel-ts (`encodeState`). Pins the co-signed wire — especially the
// `u64(wager)` inserted after the hands. If Rust drifts, co-signing with the FE breaks on that nonce;
// this catches it offline instead of as an opaque signature failure mid-match.
#[test]
fn encode_state_matches_ts_blackjack_v2_golden() {
    let protocol = BlackjackV2;
    // initialState({a:1000,b:1000}) — round_over, wager 0 (awaiting the opening bet).
    let s0 = protocol.initial_state(&ctx());
    assert_eq!(
        hex::encode(protocol.encode_state(&s0)),
        "7375695f74756e6e656c3a3a70726f746f3a3a626c61636b6a61636b2e763200000000000003e800000000000003e80000000000000000000000000000000003000000000000000000000000000000000000000000000000ff000000000000000000000000000000000000",
    );
    // After the opening bet of 100 — draw_commit, round 1, wager 100 (the bet byte 0x64 after hands).
    let s1 = deal(&protocol, &s0);
    assert_eq!(
        hex::encode(protocol.encode_state(&s1)),
        "7375695f74756e6e656c3a3a70726f746f3a3a626c61636b6a61636b2e763200000000000003e800000000000003e80000000000000001000000000000000000000000000000000000000000000000000000000000000064010000000000000000000000000000000000000000",
    );
}

// Move-wire JSON golden: the relayed move is JSON, and the bot's `BlackjackV2Move` must (de)serialize
// to the EXACT shape the FE `blackjackMoveCodec` sends — `bet.amount` a DECIMAL string, commit/reveal
// byte fields `0x`-hex, `kind`-tagged. Drift here is the poker move-wire bug class (a legal FE move
// the bot can't parse, or vice versa).
#[test]
fn move_json_matches_ts_blackjack_move_codec() {
    use serde_json::json;
    assert_eq!(
        serde_json::to_value(BlackjackV2Move::Bet { amount: 100 }).unwrap(),
        json!({ "kind": "bet", "amount": "100" }),
    );
    assert_eq!(
        serde_json::to_value(BlackjackV2Move::Commit {
            commitment: [0xab; 32],
            local_secret: None,
        })
        .unwrap(),
        json!({ "kind": "commit", "commitment": format!("0x{}", "ab".repeat(32)) }),
    );
    assert_eq!(
        serde_json::to_value(BlackjackV2Move::Reveal {
            reveal: BlackjackV2Reveal {
                value: vec![7],
                salt: vec![9; 16],
            },
        })
        .unwrap(),
        json!({ "kind": "reveal", "reveal": { "value": "0x07", "salt": format!("0x{}", "09".repeat(16)) } }),
    );
    // And the bot decodes the FE's exact bytes back.
    let bet: BlackjackV2Move =
        serde_json::from_value(json!({ "kind": "bet", "amount": "25" })).unwrap();
    assert!(matches!(bet, BlackjackV2Move::Bet { amount: 25 }));
    let commit: BlackjackV2Move = serde_json::from_value(
        json!({ "kind": "commit", "commitment": format!("0x{}", "cd".repeat(32)) }),
    )
    .unwrap();
    assert!(
        matches!(commit, BlackjackV2Move::Commit { commitment, .. } if commitment == [0xcd; 32])
    );
}
