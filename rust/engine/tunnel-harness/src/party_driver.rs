//! Drives one party asynchronously: plan -> propose -> send -> await ack, or
//! recv -> handle -> send. Owns the IO (`FrameTransport`) and the decision
//! (`MoveStrategy`); protocol transition and verification live in `PartyRuntime`.

use crate::{
    Balances, FrameTransport, HarnessError, MoveStrategy, MoveStrategyContext, PartyRuntime,
    Protocol, Signer,
};

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
