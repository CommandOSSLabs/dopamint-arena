//! The per-seat async driver: plan -> propose -> send -> await ack, or recv ->
//! handle -> send. Owns the IO (Channel) and the decision (Policy); the protocol
//! transition + verification live in the sans-IO `TunnelSeat`.

use crate::{Channel, Policy};
use tunnel_harness::{Balances, HarnessError, PolicyContext, Protocol, Signer, TunnelSeat};

pub struct DriverOutcome {
    pub moves: u64,
    pub final_balances: Balances,
}

pub struct AsyncSeatDriver<P: Protocol, Pol: Policy<P>, Ch: Channel, S: Signer> {
    seat: TunnelSeat<P, S>,
    policy: Pol,
    channel: Ch,
}

impl<P: Protocol, Pol: Policy<P>, Ch: Channel, S: Signer> AsyncSeatDriver<P, Pol, Ch, S> {
    pub fn new(seat: TunnelSeat<P, S>, policy: Pol, channel: Ch) -> Self {
        AsyncSeatDriver {
            seat,
            policy,
            channel,
        }
    }

    /// Drive until terminal or `max_moves` co-signed transitions. `now` supplies
    /// monotonically increasing timestamps (inject a clock in tests).
    pub async fn run(
        mut self,
        max_moves: u64,
        mut now: impl FnMut() -> u64 + Send,
    ) -> Result<DriverOutcome, HarnessError> {
        let ctx = PolicyContext {
            tunnel_id: String::new(), // tunnel_id is not needed by generic policies
            seat: self.seat.seat(),
        };
        let our_seat = self.seat.seat();
        let mut moves = 0u64;

        loop {
            if self.seat.is_terminal() || moves >= max_moves {
                break;
            }

            // Our turn? The policy returns Some only when it is.
            if let Some(mv) = self
                .policy
                .plan_move(self.seat.state(), our_seat, &ctx)
                .await
            {
                let frame = self.seat.propose(mv, now())?;
                self.channel.send(frame).await?;
                match self.channel.recv().await? {
                    Some(bytes) => {
                        let out = self.seat.handle_frame(&bytes)?;
                        for f in out {
                            self.channel.send(f).await?;
                        }
                        moves += 1;
                    }
                    None => break,
                }
                continue;
            }

            // Not our turn: receive the opponent's MOVE, verify+apply, send the ACK.
            match self.channel.recv().await? {
                Some(bytes) => {
                    let out = self.seat.handle_frame(&bytes)?;
                    for f in out {
                        self.channel.send(f).await?;
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
