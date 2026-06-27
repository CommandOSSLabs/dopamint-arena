use tunnel_api_credits::{ApiCredits, ApiCreditsMove};
use tunnel_harness::{Balances, Protocol, Seat, TunnelContext};

fn ctx() -> TunnelContext {
    TunnelContext {
        tunnel_id: "credits-1".into(),
        initial: Balances { a: 100, b: 0 },
        seat: Seat::A,
    }
}

#[test]
fn calls_shift_fixed_cost_from_client_to_provider() {
    let protocol = ApiCredits::new(10).unwrap();
    assert_eq!(protocol.name(), "api_credits.v1");

    let initial = protocol.initial_state(&ctx());
    assert_eq!(protocol.balances(&initial), Balances { a: 100, b: 0 });
    assert_eq!(initial.calls, 0);

    let next = protocol
        .apply_move(&initial, &ApiCreditsMove::Call, Seat::A)
        .unwrap();
    assert_eq!(next.client, 90);
    assert_eq!(next.provider, 10);
    assert_eq!(next.calls, 1);
    assert_eq!(protocol.balances(&next).sum(), 100);
}

#[test]
fn only_client_can_call_until_remaining_credit_is_too_small() {
    let protocol = ApiCredits::new(30).unwrap();
    let mut state = protocol.initial_state(&ctx());

    assert!(protocol
        .apply_move(&state, &ApiCreditsMove::Call, Seat::B)
        .is_err());

    for _ in 0..3 {
        state = protocol
            .apply_move(&state, &ApiCreditsMove::Call, Seat::A)
            .unwrap();
    }

    assert_eq!(state.client, 10);
    assert!(protocol.is_terminal(&state));
    assert!(protocol.sample_move(&state, Seat::A, &mut || 0.5).is_none());
}

#[test]
fn encode_state_is_domain_tagged_and_big_endian() {
    let protocol = ApiCredits::new(10).unwrap();
    let state = protocol.initial_state(&ctx());
    let encoded = protocol.encode_state(&state);

    assert!(encoded.starts_with(b"sui_tunnel::proto::api_credits.v1"));
    assert_eq!(
        encoded.len(),
        b"sui_tunnel::proto::api_credits.v1".len() + 24
    );
    assert_eq!(
        &encoded[encoded.len() - 24..encoded.len() - 16],
        &100u64.to_be_bytes()
    );
    assert_eq!(
        &encoded[encoded.len() - 16..encoded.len() - 8],
        &0u64.to_be_bytes()
    );
    assert_eq!(&encoded[encoded.len() - 8..], &0u64.to_be_bytes());
}
