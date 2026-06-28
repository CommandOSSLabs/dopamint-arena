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

#[test]
fn initial_state_begins_opening_draw_commit() {
    let protocol = BlackjackV2;
    let state = protocol.initial_state(&ctx());
    assert_eq!(protocol.name(), "blackjack.v2");
    assert_eq!(state.phase, Phase::DrawCommit);
    assert_eq!(state.round, 1);
    assert_eq!(state.wager, WAGER);
    assert_eq!(protocol.balances(&state).sum(), 2000);
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
    let mut state = protocol.initial_state(&ctx());
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
    let mut state = protocol.initial_state(&ctx());
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
