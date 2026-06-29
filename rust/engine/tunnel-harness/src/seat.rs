//! The sans-IO tunnel state machine. Pull-based: `propose` applies our move
//! locally, signs our half, and returns the MOVE frame to send; `handle_frame`
//! ingests one inbound frame and returns the frames to send back. State commits
//! only when the co-signing ACK arrives. No IO, no async, no ambient clock —
//! timestamps are injected. One seat per machine; two wired together self-play.
//!
//! CONTRACT: the core assumes a turn-disciplined driver — at most one party has an
//! outstanding `propose` at a time. There is no tie-break for a simultaneous
//! cross-propose: if both parties propose at once, each rejects the other's MOVE
//! (`expected ack, got move`) while holding its own pending proposal, so the
//! exchange cannot complete. Drivers MUST gate proposing on whose turn it is
//! (e.g. the protocol's `actor_for`), which is what the serve/bench fleets do.

use crate::frame::{AckFrame, FrameCodec, JsonFrameCodec, MoveFrame, TunnelFrame};
use crate::{Balances, HarnessError, Protocol, Seat, Signer, TunnelContext};
use tunnel_core::crypto::{blake2b256, verify};
use tunnel_core::wire::{serialize_state_update, StateUpdate};

struct Pending<P: Protocol> {
    next: P::State,
    msg: Vec<u8>,
    nonce: u64,
}

pub struct PartyRuntime<P: Protocol, S: Signer, C: FrameCodec<P::Move> = JsonFrameCodec> {
    protocol: P,
    signer: S,
    codec: C,
    opponent_pk: [u8; 32],
    tunnel_id: String,
    seat: Seat,
    state: P::State,
    nonce: u64,
    pending: Option<Pending<P>>,
}

impl<P: Protocol, S: Signer, C: FrameCodec<P::Move> + Default> PartyRuntime<P, S, C> {
    /// Build a party runtime using the default wire codec (`JsonFrameCodec`).
    pub fn new(protocol: P, signer: S, opponent_pk: [u8; 32], ctx: TunnelContext) -> Self {
        Self::with_codec(protocol, signer, C::default(), opponent_pk, ctx)
    }
}

impl<P: Protocol, S: Signer, C: FrameCodec<P::Move>> PartyRuntime<P, S, C> {
    /// Build a party runtime with an explicit wire codec.
    pub fn with_codec(
        protocol: P,
        signer: S,
        codec: C,
        opponent_pk: [u8; 32],
        ctx: TunnelContext,
    ) -> Self {
        let state = protocol.initial_state(&ctx);
        PartyRuntime {
            protocol,
            signer,
            codec,
            opponent_pk,
            tunnel_id: ctx.tunnel_id,
            seat: ctx.seat,
            state,
            nonce: 0,
            pending: None,
        }
    }

    pub fn seat(&self) -> Seat {
        self.seat
    }
    pub fn nonce(&self) -> u64 {
        self.nonce
    }
    pub fn tunnel_id(&self) -> &str {
        &self.tunnel_id
    }
    pub fn state(&self) -> &P::State {
        &self.state
    }
    pub fn is_terminal(&self) -> bool {
        self.protocol.is_terminal(&self.state)
    }
    pub fn balances(&self) -> Balances {
        self.protocol.balances(&self.state)
    }
    pub fn has_pending(&self) -> bool {
        self.pending.is_some()
    }
    pub fn sign(&self, msg: &[u8]) -> [u8; 64] {
        self.signer.sign(msg)
    }

    /// Mutate the committed state in place. Intended ONLY for pre-play setup (e.g.
    /// seeding a card stream) before the first `propose`/`handle_frame`; mutating
    /// mid-match would desync the nonce/state across seats.
    pub fn with_state_mut(&mut self, f: impl FnOnce(&mut P::State)) {
        f(&mut self.state);
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

    pub fn propose(&mut self, mv: P::Move, timestamp: u64) -> Result<Vec<u8>, HarnessError> {
        if self.pending.is_some() {
            return Err(HarnessError::Verification(
                "a proposal already awaits ack".into(),
            ));
        }
        let next = self.protocol.apply_move(&self.state, &mv, self.seat)?;
        let nonce = self.nonce + 1;
        let (update, msg) = self.build_update(&next, nonce, timestamp);
        let sig = self.signer.sign(&msg);
        let frame: TunnelFrame<P::Move> = TunnelFrame::Move(MoveFrame {
            nonce,
            by: self.seat.into(),
            mv,
            timestamp,
            state_hash: update.state_hash,
            party_a_balance: update.party_a_balance,
            party_b_balance: update.party_b_balance,
            sig_proposer: sig,
        });
        let bytes = self.codec.encode(&frame);
        self.pending = Some(Pending { next, msg, nonce });
        Ok(bytes)
    }

    pub fn handle_frame(&mut self, bytes: &[u8]) -> Result<Vec<Vec<u8>>, HarnessError> {
        match self.codec.decode(bytes)? {
            TunnelFrame::Move(m) => self.on_move(m),
            TunnelFrame::Ack(a) => self.on_ack(a),
        }
    }

    fn on_move(&mut self, m: MoveFrame<P::Move>) -> Result<Vec<Vec<u8>>, HarnessError> {
        if self.pending.is_some() {
            return Err(HarnessError::Verification("expected ack, got move".into()));
        }
        let by: Seat = m.by.into();
        if by == self.seat {
            return Err(HarnessError::Verification("move attributed to self".into()));
        }
        if m.nonce != self.nonce + 1 {
            return Err(HarnessError::Verification("nonce gap".into()));
        }
        let next = self.protocol.apply_move(&self.state, &m.mv, by)?;
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
        let sig_responder = self.signer.sign(&msg);
        self.state = next;
        self.nonce = m.nonce;
        let ack: TunnelFrame<P::Move> = TunnelFrame::Ack(AckFrame {
            nonce: m.nonce,
            sig_responder,
        });
        Ok(vec![self.codec.encode(&ack)])
    }

    fn on_ack(&mut self, a: AckFrame) -> Result<Vec<Vec<u8>>, HarnessError> {
        let p = self
            .pending
            .take()
            .ok_or_else(|| HarnessError::Verification("unexpected ack".into()))?;
        if a.nonce != p.nonce {
            return Err(HarnessError::Verification("unexpected ack nonce".into()));
        }
        if !verify(&self.opponent_pk, &p.msg, &a.sig_responder) {
            return Err(HarnessError::Verification("ack sig failed".into()));
        }
        self.state = p.next;
        self.nonce = p.nonce;
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::LocalSigner;
    use tunnel_core::crypto::keypair_from_secret;

    // A trivial two-seat protocol: each move transfers 1 unit to the other seat,
    // terminal after `cap` transfers. Enough to exercise the seat state machine.
    struct Tiny {
        cap: u64,
    }
    #[derive(Clone, Copy, serde::Serialize, serde::Deserialize)]
    struct TinyMove;
    #[derive(Clone)]
    struct TinyState {
        a: u64,
        b: u64,
        n: u64,
        cap: u64,
    }
    impl Protocol for Tiny {
        type State = TinyState;
        type Move = TinyMove;
        fn name(&self) -> &str {
            "tiny.v1"
        }
        fn initial_state(&self, ctx: &TunnelContext) -> TinyState {
            TinyState {
                a: ctx.initial.a,
                b: ctx.initial.b,
                n: 0,
                cap: self.cap,
            }
        }
        fn apply_move(
            &self,
            s: &TinyState,
            _mv: &TinyMove,
            by: Seat,
        ) -> Result<TinyState, crate::ProtocolError> {
            let turn = if s.n % 2 == 0 { Seat::A } else { Seat::B };
            if by != turn {
                return Err(crate::ProtocolError("wrong turn".into()));
            }
            let mut next = s.clone();
            match by {
                Seat::A => {
                    next.a -= 1;
                    next.b += 1;
                }
                Seat::B => {
                    next.b -= 1;
                    next.a += 1;
                }
            }
            next.n += 1;
            Ok(next)
        }
        fn encode_state(&self, s: &TinyState) -> Vec<u8> {
            let mut out = b"tiny".to_vec();
            out.extend_from_slice(&s.a.to_be_bytes());
            out.extend_from_slice(&s.b.to_be_bytes());
            out.extend_from_slice(&s.n.to_be_bytes());
            out
        }
        fn balances(&self, s: &TinyState) -> Balances {
            Balances { a: s.a, b: s.b }
        }
        fn is_terminal(&self, s: &TinyState) -> bool {
            s.n >= s.cap
        }
    }

    fn seats() -> (
        PartyRuntime<Tiny, LocalSigner>,
        PartyRuntime<Tiny, LocalSigner>,
    ) {
        let sa: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let sb: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let pka = keypair_from_secret(&sa).public_key();
        let pkb = keypair_from_secret(&sb).public_key();
        let ctx = |seat| TunnelContext {
            tunnel_id: "0xab".into(),
            initial: Balances { a: 5, b: 5 },
            seat,
        };
        let a = PartyRuntime::new(
            Tiny { cap: 4 },
            LocalSigner::from_secret(&sa),
            pkb,
            ctx(Seat::A),
        );
        let b = PartyRuntime::new(
            Tiny { cap: 4 },
            LocalSigner::from_secret(&sb),
            pka,
            ctx(Seat::B),
        );
        (a, b)
    }

    #[test]
    fn with_state_mut_edits_committed_state() {
        let (mut a, _b) = seats();
        assert_eq!(a.state().n, 0);
        a.with_state_mut(|s| s.n = 3);
        assert_eq!(a.state().n, 3);
    }

    #[test]
    fn propose_then_ack_advances_both_seats() {
        let (mut a, mut b) = seats();
        let mv_frame = a.propose(TinyMove, 1).unwrap();
        assert!(a.has_pending());
        let ack = b.handle_frame(&mv_frame).unwrap();
        assert_eq!(ack.len(), 1);
        assert_eq!(b.nonce(), 1);
        let done = a.handle_frame(&ack[0]).unwrap();
        assert!(done.is_empty());
        assert!(!a.has_pending());
        assert_eq!(a.nonce(), 1);
        assert_eq!(a.balances(), Balances { a: 4, b: 6 });
        assert_eq!(a.balances(), b.balances());
    }

    #[test]
    fn tampered_ack_signature_is_rejected() {
        let (mut a, mut b) = seats();
        let mv_frame = a.propose(TinyMove, 1).unwrap();
        let mut ack = b.handle_frame(&mv_frame).unwrap();
        // Corrupt the hex signature payload in the ACK JSON by flipping the first
        // nibble of sig_responder. Targeting the field directly is reliable because
        // `.replace("00","ff")` fails when the signature has no 0x00 bytes.
        let raw = String::from_utf8(ack.remove(0)).unwrap();
        let marker = "\"sigResponder\":\"";
        let pos = raw.find(marker).expect("sig_responder field in ack json") + marker.len();
        let flip = if raw.as_bytes()[pos] == b'0' {
            b'f'
        } else {
            b'0'
        };
        let mut corrupted = raw.into_bytes();
        corrupted[pos] = flip;
        let err = a.handle_frame(&corrupted).unwrap_err();
        assert!(matches!(err, HarnessError::Verification(_)));
    }

    #[test]
    fn move_attributed_to_self_is_rejected() {
        let (mut a, _b) = seats();
        let mv_frame = a.propose(TinyMove, 1).unwrap();
        // Feeding our own MOVE back to us: by == our seat.
        let mut fresh: PartyRuntime<Tiny, LocalSigner> = {
            let sa: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
            let pka = keypair_from_secret(&sa).public_key();
            PartyRuntime::new(
                Tiny { cap: 4 },
                LocalSigner::from_secret(&sa),
                pka,
                TunnelContext {
                    tunnel_id: "0xab".into(),
                    initial: Balances { a: 5, b: 5 },
                    seat: Seat::A,
                },
            )
        };
        let err = fresh.handle_frame(&mv_frame).unwrap_err();
        assert!(matches!(err, HarnessError::Verification(_)));
    }
}
