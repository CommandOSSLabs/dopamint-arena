//! Drives one party asynchronously: plan -> propose -> send -> await ack, or
//! recv -> handle -> send. Owns the IO (`FrameTransport`) and the decision
//! (`MoveStrategy`); protocol transition and verification live in `PartyRuntime`.

use crate::{
    Balances, FrameTransport, HarnessError, MoveStrategy, MoveStrategyContext, PartyRuntime,
    Protocol, Signer,
};

#[derive(Debug)]
pub struct DriverOutcome {
    pub moves: u64,
    pub final_balances: Balances,
}

pub struct PartyDriver<P: Protocol, Pol: MoveStrategy<P>, Ch: FrameTransport, S: Signer> {
    seat: PartyRuntime<P, S>,
    move_strategy: Pol,
    frame_transport: Ch,
}

impl<P: Protocol, Pol: MoveStrategy<P>, Ch: FrameTransport, S: Signer> PartyDriver<P, Pol, Ch, S> {
    pub fn new(seat: PartyRuntime<P, S>, move_strategy: Pol, frame_transport: Ch) -> Self {
        PartyDriver {
            seat,
            move_strategy,
            frame_transport,
        }
    }

    /// Drive until terminal. `now` supplies monotonically increasing timestamps
    /// (inject a clock in tests).
    ///
    /// `max_moves` is a per-party runaway guard, NOT a coordinated stop: the only
    /// safe termination is `is_terminal`, on which both parties break together. If
    /// `max_moves` trips mid-match it can leave the peer blocked in `recv`, so set
    /// it high enough to never trip in normal play and keep it equal across seats.
    pub async fn run(
        mut self,
        max_moves: u64,
        mut now: impl FnMut() -> u64 + Send,
    ) -> Result<DriverOutcome, HarnessError> {
        let result = self.run_inner(max_moves, &mut now).await;
        if result.is_err() {
            self.move_strategy.abort();
        }
        result
    }

    async fn run_inner(
        &mut self,
        max_moves: u64,
        now: &mut (impl FnMut() -> u64 + Send),
    ) -> Result<DriverOutcome, HarnessError> {
        let ctx = MoveStrategyContext {
            tunnel_id: String::new(), // generic strategies do not need tunnel_id
            seat: self.seat.seat(),
        };
        let our_seat = self.seat.seat();
        let mut moves = 0u64;

        loop {
            if self.seat.is_terminal() || moves >= max_moves {
                break;
            }

            // Our turn? The strategy returns Some only when it is.
            if let Some(mv) = self
                .move_strategy
                .plan_move(self.seat.state(), our_seat, &ctx)
                .await
            {
                let frame = self.seat.propose(mv, now())?;
                self.frame_transport.send(frame).await?;
                match self.frame_transport.recv().await? {
                    Some(bytes) => {
                        let out = self.seat.handle_frame(&bytes)?;
                        self.move_strategy.confirm_move(self.seat.state());
                        for f in out {
                            self.frame_transport.send(f).await?;
                        }
                        moves += 1;
                    }
                    None => break,
                }
                continue;
            }

            // Not our turn: receive the opponent's MOVE, verify+apply, send the ACK.
            match self.frame_transport.recv().await? {
                Some(bytes) => {
                    let out = self.seat.handle_frame(&bytes)?;
                    for f in out {
                        self.frame_transport.send(f).await?;
                    }
                    moves += 1;
                }
                None => break,
            }
        }

        Ok(DriverOutcome {
            moves,
            final_balances: self.seat.balances(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        Balances, FrameTransportError, InMemoryFrameTransport, LocalSigner, Seat, TunnelContext,
    };
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    };
    use tunnel_core::crypto::keypair_from_secret;

    #[derive(Clone)]
    struct OneMoveProtocol;

    #[derive(Clone, Copy, serde::Serialize, serde::Deserialize)]
    struct OneMove;

    #[derive(Clone)]
    struct OneMoveState {
        moved: bool,
        balances: Balances,
    }

    impl Protocol for OneMoveProtocol {
        type State = OneMoveState;
        type Move = OneMove;

        fn name(&self) -> &str {
            "one_move.v1"
        }

        fn initial_state(&self, ctx: &TunnelContext) -> Self::State {
            OneMoveState {
                moved: false,
                balances: ctx.initial,
            }
        }

        fn apply_move(
            &self,
            state: &Self::State,
            _mv: &Self::Move,
            by: Seat,
        ) -> Result<Self::State, crate::ProtocolError> {
            if by != Seat::A {
                return Err(crate::ProtocolError("only A can move".into()));
            }
            if state.moved {
                return Err(crate::ProtocolError("already moved".into()));
            }
            Ok(OneMoveState {
                moved: true,
                balances: state.balances,
            })
        }

        fn encode_state(&self, state: &Self::State) -> Vec<u8> {
            vec![u8::from(state.moved)]
        }

        fn balances(&self, state: &Self::State) -> Balances {
            state.balances
        }

        fn is_terminal(&self, state: &Self::State) -> bool {
            state.moved
        }
    }

    struct TrackingStrategy {
        seat: Seat,
        planned: Arc<AtomicU64>,
        confirmed: Arc<AtomicU64>,
        aborted: Arc<AtomicU64>,
    }

    impl TrackingStrategy {
        fn new(
            seat: Seat,
            planned: Arc<AtomicU64>,
            confirmed: Arc<AtomicU64>,
            aborted: Arc<AtomicU64>,
        ) -> Self {
            Self {
                seat,
                planned,
                confirmed,
                aborted,
            }
        }
    }

    impl MoveStrategy<OneMoveProtocol> for TrackingStrategy {
        async fn plan_move(
            &mut self,
            state: &OneMoveState,
            seat: Seat,
            _ctx: &crate::MoveStrategyContext,
        ) -> Option<OneMove> {
            if self.seat == Seat::A && seat == Seat::A && !state.moved {
                self.planned.fetch_add(1, Ordering::Relaxed);
                return Some(OneMove);
            }
            None
        }

        fn confirm_move(&mut self, state: &OneMoveState) {
            if state.moved {
                self.confirmed.fetch_add(1, Ordering::Relaxed);
            }
        }

        fn abort(&mut self) {
            self.aborted.fetch_add(1, Ordering::Relaxed);
        }
    }

    fn runtime(
        seat: Seat,
        secret: &[u8; 32],
        opponent_pk: [u8; 32],
    ) -> PartyRuntime<OneMoveProtocol, LocalSigner> {
        PartyRuntime::new(
            OneMoveProtocol,
            LocalSigner::from_secret(secret),
            opponent_pk,
            TunnelContext {
                tunnel_id: "0x1".into(),
                initial: Balances { a: 100, b: 100 },
                seat,
            },
        )
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn strategy_confirms_after_own_move_is_acked() {
        let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let pk_a = keypair_from_secret(&secret_a).public_key();
        let pk_b = keypair_from_secret(&secret_b).public_key();
        let (ch_a, ch_b) = InMemoryFrameTransport::pair();
        let planned = Arc::new(AtomicU64::new(0));
        let confirmed = Arc::new(AtomicU64::new(0));
        let aborted = Arc::new(AtomicU64::new(0));

        let driver_a = PartyDriver::new(
            runtime(Seat::A, &secret_a, pk_b),
            TrackingStrategy::new(
                Seat::A,
                Arc::clone(&planned),
                Arc::clone(&confirmed),
                Arc::clone(&aborted),
            ),
            ch_a,
        );
        let driver_b = PartyDriver::new(
            runtime(Seat::B, &secret_b, pk_a),
            TrackingStrategy::new(
                Seat::B,
                Arc::clone(&planned),
                Arc::clone(&confirmed),
                Arc::clone(&aborted),
            ),
            ch_b,
        );

        let (out_a, out_b) = tokio::join!(driver_a.run(10, || 1), driver_b.run(10, || 1),);

        assert!(out_a.unwrap().final_balances.sum() == 200);
        assert!(out_b.unwrap().final_balances.sum() == 200);
        assert_eq!(planned.load(Ordering::Relaxed), 1);
        assert_eq!(confirmed.load(Ordering::Relaxed), 1);
        assert_eq!(aborted.load(Ordering::Relaxed), 0);
    }

    struct FailingSendTransport;

    impl FrameTransport for FailingSendTransport {
        async fn send(&self, _bytes: Vec<u8>) -> Result<(), FrameTransportError> {
            Err(FrameTransportError::Transport("send failed".into()))
        }

        async fn recv(&self) -> Result<Option<Vec<u8>>, FrameTransportError> {
            Ok(None)
        }
    }

    #[tokio::test]
    async fn strategy_aborts_when_driver_errors() {
        let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let pk_b = keypair_from_secret(&secret_b).public_key();
        let planned = Arc::new(AtomicU64::new(0));
        let confirmed = Arc::new(AtomicU64::new(0));
        let aborted = Arc::new(AtomicU64::new(0));
        let driver = PartyDriver::new(
            runtime(Seat::A, &secret_a, pk_b),
            TrackingStrategy::new(
                Seat::A,
                Arc::clone(&planned),
                Arc::clone(&confirmed),
                Arc::clone(&aborted),
            ),
            FailingSendTransport,
        );

        let err = driver.run(10, || 1).await.unwrap_err();

        assert_eq!(
            err,
            HarnessError::FrameTransport(FrameTransportError::Transport("send failed".into()))
        );
        assert_eq!(planned.load(Ordering::Relaxed), 1);
        assert_eq!(confirmed.load(Ordering::Relaxed), 0);
        assert_eq!(aborted.load(Ordering::Relaxed), 1);
    }
}
