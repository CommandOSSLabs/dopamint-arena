use tunnel_chat::{strategy::ChatStrategy, Chat, ChatMove};
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
