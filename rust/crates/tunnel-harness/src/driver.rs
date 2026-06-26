//! The per-seat harness loop: plan -> deliver -> sign. Settling a terminal
//! `DriverOutcome` is the caller's job. Generic over all four runtime seams. One seat
//! per driver; self-play wires two drivers through an InMemoryChannel.

use crate::frame::{decode_frame, encode_frame, AckFrame, Frame, MoveFrame};
use crate::{
    Balances, Channel, HarnessError, Policy, PolicyContext, Protocol, Seat, Signer, TunnelContext,
};
use tunnel_core::crypto::{blake2b256, verify};
use tunnel_core::wire::{serialize_state_update, StateUpdate};

pub struct DriverOutcome {
    pub moves: u64,
    pub final_balances: Balances,
}

pub struct SeatDriver<P: Protocol, Pol: Policy<P>, Ch: Channel, S: Signer> {
    protocol: P,
    policy: Pol,
    channel: Ch,
    signer: S,
    opponent_pk: [u8; 32],
    tunnel_id: String,
    seat: Seat,
    state: P::State,
    nonce: u64,
}

impl<P: Protocol, Pol: Policy<P>, Ch: Channel, S: Signer> SeatDriver<P, Pol, Ch, S> {
    pub async fn new(
        protocol: P,
        policy: Pol,
        channel: Ch,
        signer: S,
        opponent_pk: [u8; 32],
        ctx: TunnelContext,
    ) -> SeatDriver<P, Pol, Ch, S> {
        let state = protocol.initial_state(&ctx).await;
        SeatDriver {
            protocol,
            policy,
            channel,
            signer,
            opponent_pk,
            tunnel_id: ctx.tunnel_id,
            seat: ctx.seat,
            state,
            nonce: 0,
        }
    }

    fn build_update(&self, next: &P::State, nonce: u64, timestamp: u64) -> (StateUpdate, Vec<u8>) {
        let bals = self.protocol.balances(next);
        let update = StateUpdate {
            tunnel_id: self.tunnel_id.clone(),
            state_hash: blake2b256(&self.protocol.encode_state(next)),
            nonce,
            timestamp,
            party_a_balance: bals.a,
            party_b_balance: bals.b,
        };
        let msg = serialize_state_update(&update);
        (update, msg)
    }

    /// Drive until terminal or `max_moves` co-signed transitions have occurred.
    /// `now` supplies monotonically increasing timestamps (inject a clock in tests).
    pub async fn run(
        mut self,
        max_moves: u64,
        mut now: impl FnMut() -> u64 + Send,
    ) -> Result<DriverOutcome, HarnessError> {
        let ctx = PolicyContext {
            tunnel_id: self.tunnel_id.clone(),
            seat: self.seat,
        };
        let mut moves = 0u64;

        loop {
            if self.protocol.is_terminal(&self.state) || moves >= max_moves {
                break;
            }

            // --- our turn? plan + deliver a MOVE, then await the ACK ---
            if let Some(mv) = self.policy.plan_move(&self.state, self.seat, &ctx).await {
                let next = self
                    .protocol
                    .apply_move(&self.state, &mv, self.seat)
                    .await?;
                let nonce = self.nonce + 1;
                let ts = now();
                let (update, msg) = self.build_update(&next, nonce, ts);
                let sig = self.signer.sign(&msg).await;
                let frame: Frame<P::Move> = Frame::Move(MoveFrame {
                    nonce,
                    by: self.seat.into(),
                    mv,
                    timestamp: ts,
                    state_hash: update.state_hash,
                    party_a_balance: update.party_a_balance,
                    party_b_balance: update.party_b_balance,
                    sig_proposer: sig,
                });
                self.channel.send(encode_frame(&frame)).await?;

                // Wait for the ACK that commits this nonce.
                match self.recv_frame().await? {
                    Some(Frame::Ack(ack)) => {
                        if ack.nonce != nonce {
                            return Err(HarnessError::Verification("unexpected ack nonce".into()));
                        }
                        if !verify(&self.opponent_pk, &msg, &ack.sig_responder) {
                            return Err(HarnessError::Verification("ack sig failed".into()));
                        }
                        self.state = next;
                        self.nonce = nonce;
                        moves += 1;
                        continue;
                    }
                    Some(Frame::Move(_)) => {
                        return Err(HarnessError::Verification("expected ack, got move".into()));
                    }
                    None => break,
                }
            }

            // --- not our turn: receive the opponent's MOVE, verify, apply, ACK ---
            match self.recv_frame().await? {
                Some(Frame::Move(m)) => {
                    self.on_move(m).await?;
                    moves += 1;
                }
                Some(Frame::Ack(_)) => {
                    return Err(HarnessError::Verification("unexpected ack".into()));
                }
                None => break,
            }
        }

        Ok(DriverOutcome {
            moves,
            final_balances: self.protocol.balances(&self.state),
        })
    }

    async fn recv_frame(&self) -> Result<Option<Frame<P::Move>>, HarnessError> {
        match self.channel.recv().await? {
            Some(bytes) => Ok(Some(decode_frame::<P::Move>(&bytes)?)),
            None => Ok(None),
        }
    }

    async fn on_move(&mut self, m: MoveFrame<P::Move>) -> Result<(), HarnessError> {
        let by: Seat = m.by.into();
        if by == self.seat {
            return Err(HarnessError::Verification("move attributed to self".into()));
        }
        if m.nonce != self.nonce + 1 {
            return Err(HarnessError::Verification("nonce gap".into()));
        }
        let next = self.protocol.apply_move(&self.state, &m.mv, by).await?;
        let bals = self.protocol.balances(&next);
        if bals.a != m.party_a_balance || bals.b != m.party_b_balance {
            return Err(HarnessError::Verification("frame balances mismatch".into()));
        }
        let state_hash = blake2b256(&self.protocol.encode_state(&next));
        if state_hash != m.state_hash {
            return Err(HarnessError::Verification(
                "frame state_hash mismatch".into(),
            ));
        }
        let update = StateUpdate {
            tunnel_id: self.tunnel_id.clone(),
            state_hash,
            nonce: m.nonce,
            timestamp: m.timestamp,
            party_a_balance: bals.a,
            party_b_balance: bals.b,
        };
        let msg = serialize_state_update(&update);
        if !verify(&self.opponent_pk, &msg, &m.sig_proposer) {
            return Err(HarnessError::Verification("proposer sig failed".into()));
        }
        let sig_responder = self.signer.sign(&msg).await;
        self.state = next;
        self.nonce = m.nonce;
        let ack: Frame<P::Move> = Frame::Ack(AckFrame {
            nonce: m.nonce,
            sig_responder,
        });
        self.channel.send(encode_frame(&ack)).await?;
        Ok(())
    }
}
