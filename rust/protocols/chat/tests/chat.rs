use tunnel_chat::{Chat, ChatMove};
use tunnel_core::crypto::blake2b256;
use tunnel_harness::{Balances, Protocol, Seat, TunnelContext};

fn ctx() -> TunnelContext {
    TunnelContext {
        tunnel_id: "chat-1".into(),
        initial: Balances { a: 100, b: 100 },
        seat: Seat::A,
    }
}

#[test]
fn messages_fold_digest_and_tips_shift_balances() {
    let protocol = Chat;
    assert_eq!(protocol.name(), "chat.v1");

    let initial = protocol.initial_state(&ctx());
    assert_eq!(initial.message_count, 0);
    assert_eq!(initial.transcript_digest, [0u8; 32]);
    assert_eq!(protocol.balances(&initial), Balances { a: 100, b: 100 });

    let after_a = protocol
        .apply_move(
            &initial,
            &ChatMove {
                text: "thanks".into(),
                tip: Some(30),
            },
            Seat::A,
        )
        .unwrap();
    assert_eq!(after_a.message_count, 1);
    assert_eq!(after_a.last_sender, Some(Seat::A));
    assert_ne!(after_a.transcript_digest, [0u8; 32]);
    assert_eq!(protocol.balances(&after_a), Balances { a: 70, b: 130 });

    let after_b = protocol
        .apply_move(
            &after_a,
            &ChatMove {
                text: "back".into(),
                tip: Some(10),
            },
            Seat::B,
        )
        .unwrap();
    assert_eq!(after_b.message_count, 2);
    assert_eq!(after_b.last_sender, Some(Seat::B));
    assert_eq!(protocol.balances(&after_b), Balances { a: 80, b: 120 });
    assert_eq!(protocol.balances(&after_b).sum(), 200);
}

#[test]
fn digest_is_sender_and_order_sensitive() {
    let protocol = Chat;
    let state = protocol.initial_state(&ctx());
    let from_a = protocol
        .apply_move(&state, &ChatMove::plain("x"), Seat::A)
        .unwrap();
    let from_b = protocol
        .apply_move(&state, &ChatMove::plain("x"), Seat::B)
        .unwrap();
    assert_ne!(from_a.transcript_digest, from_b.transcript_digest);

    let ay = protocol
        .apply_move(&from_a, &ChatMove::plain("y"), Seat::B)
        .unwrap();
    let az = protocol
        .apply_move(&from_a, &ChatMove::plain("z"), Seat::B)
        .unwrap();
    assert_ne!(ay.transcript_digest, az.transcript_digest);
}

#[test]
fn rejects_empty_text_and_over_balance_tips() {
    let protocol = Chat;
    let state = protocol.initial_state(&ctx());

    assert!(protocol
        .apply_move(&state, &ChatMove::plain(""), Seat::A)
        .is_err());
    assert!(protocol
        .apply_move(
            &state,
            &ChatMove {
                text: "hi".into(),
                tip: Some(101),
            },
            Seat::A,
        )
        .is_err());
}

#[test]
fn encode_state_is_fixed_size_and_domain_tagged() {
    let protocol = Chat;
    let initial = protocol.initial_state(&ctx());
    let next = protocol
        .apply_move(&initial, &ChatMove::plain("hi"), Seat::A)
        .unwrap();
    let long = protocol
        .apply_move(&next, &ChatMove::plain("x".repeat(5000)), Seat::B)
        .unwrap();

    let e0 = protocol.encode_state(&initial);
    let e1 = protocol.encode_state(&next);
    let e2 = protocol.encode_state(&long);
    assert!(e0.starts_with(b"sui_tunnel::proto::chat.v1"));
    assert_eq!(e0.len(), b"sui_tunnel::proto::chat.v1".len() + 32 + 24);
    assert_eq!(e0.len(), e1.len());
    assert_eq!(e1.len(), e2.len());
    assert_ne!(blake2b256(&e0), blake2b256(&e1));
}
