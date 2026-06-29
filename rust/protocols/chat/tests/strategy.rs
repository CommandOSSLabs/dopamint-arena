use tunnel_chat::{Chat, ChatMove, ChatStrategy};
use tunnel_harness::{Balances, MoveStrategy, MoveStrategyContext, Protocol, Seat, TunnelContext};

fn ctx(initial: Balances) -> TunnelContext {
    TunnelContext {
        tunnel_id: "chat-strategy".into(),
        initial,
        seat: Seat::A,
    }
}

fn strategy_ctx(seat: Seat) -> MoveStrategyContext {
    MoveStrategyContext {
        tunnel_id: "chat-strategy".into(),
        seat,
    }
}

#[tokio::test]
async fn strategy_uses_message_count_as_default_text() {
    let protocol = Chat;
    let state = protocol.initial_state(&ctx(Balances { a: 0, b: 0 }));
    let mut strategy = ChatStrategy::new(1);

    assert_eq!(
        strategy
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await,
        Some(ChatMove {
            text: "msg0".into(),
            tip: None
        })
    );
}

#[tokio::test]
async fn confirm_and_abort_do_not_change_stateless_chat_decision() {
    let protocol = Chat;
    let state = protocol.initial_state(&ctx(Balances { a: 0, b: 0 }));
    let mut strategy = ChatStrategy::new(1);

    let before = strategy
        .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
        .await;
    strategy.confirm_move(&state);
    strategy.abort();
    let after = strategy
        .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
        .await;

    assert_eq!(before, after);
}

#[tokio::test]
async fn tipped_strategy_move_applies_and_conserves_balances() {
    let protocol = Chat;
    let state = protocol.initial_state(&ctx(Balances { a: 100, b: 100 }));

    for seed in 0..1000 {
        let mut strategy = ChatStrategy::new(seed);
        let planned = strategy
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await
            .unwrap();
        if let Some(tip) = planned.tip {
            assert!((1..=10).contains(&tip));
            let next = protocol.apply_move(&state, &planned, Seat::A).unwrap();

            assert_eq!(next.balance_a, 100 - tip);
            assert_eq!(next.balance_b, 100 + tip);
            assert_eq!(protocol.balances(&next).sum(), 200);
            return;
        }
    }

    panic!("no deterministic seed produced a chat tip");
}
