//! PvP off-chain engine: one seat's signer co-signing moves with a remote counterparty.
//! Byte-identical signed messages to self-play, so any co-signed artifact settles on-chain.
//! Pull-based: `propose`/`handle_frame` return the frames to send (see plan design note).

use crate::engine::crypto::{keypair_from_secret, verify as ed_verify, KeyPair};
use crate::engine::frame::{decode_frame, encode_frame, AckFrame, Frame, MoveFrame};
use crate::engine::wire::{serialize_settlement_with_root, serialize_state_update, Settlement, StateUpdate};
use crate::game::blackjack::{apply_move, encode_state, BjMove, BjState, Party};
use crate::engine::crypto::blake2b256;

pub struct Endpoint {
    pub public_key: [u8; 32],
    signing: Option<KeyPair>,
}

impl Endpoint {
    pub fn controlled(secret: &[u8; 32]) -> Endpoint {
        let kp = keypair_from_secret(secret);
        Endpoint { public_key: kp.public_key(), signing: Some(kp) }
    }
    pub fn observer(public_key: [u8; 32]) -> Endpoint {
        Endpoint { public_key, signing: None }
    }
    fn sign(&self, msg: &[u8]) -> [u8; 64] {
        self.signing.as_ref().expect("controlled endpoint must sign").sign(msg)
    }
    fn verify(&self, msg: &[u8], sig: &[u8; 64]) -> bool {
        ed_verify(&self.public_key, msg, sig)
    }
}

struct Pending {
    next: BjState,
    update: StateUpdate,
    msg: Vec<u8>,
}

pub struct DistTunnel {
    tunnel_id: String,
    self_party: Party,
    self_ep: Endpoint,
    opp_ep: Endpoint,
    total: u64,
    state: BjState,
    nonce: u64,
    pending: Option<Pending>,
}

impl DistTunnel {
    pub fn new(tunnel_id: &str, self_party: Party, self_ep: Endpoint, opp_ep: Endpoint, balance_a: u64, balance_b: u64) -> DistTunnel {
        let state = crate::game::blackjack::initial_state(balance_a, balance_b);
        DistTunnel {
            tunnel_id: tunnel_id.to_string(),
            self_party,
            self_ep,
            opp_ep,
            total: balance_a + balance_b,
            state,
            nonce: 0,
            pending: None,
        }
    }

    pub fn state(&self) -> &BjState { &self.state }
    pub fn is_terminal(&self) -> bool { crate::game::blackjack::is_terminal(&self.state) }

    fn build_update(&self, next: &BjState, nonce: u64, timestamp: u64) -> StateUpdate {
        StateUpdate {
            tunnel_id: self.tunnel_id.clone(),
            state_hash: blake2b256(&encode_state(next)),
            nonce,
            timestamp,
            party_a_balance: next.balance_a,
            party_b_balance: next.balance_b,
        }
    }

    /// Apply locally, sign our half, return the MOVE frame to send. State advances on ACK.
    pub fn propose(&mut self, mv: BjMove, timestamp: u64) -> Vec<Vec<u8>> {
        assert!(self.pending.is_none(), "a proposal is already awaiting ACK");
        let next = apply_move(&self.state, mv, self.self_party).expect("legal move");
        assert_eq!(next.balance_a + next.balance_b, self.total, "balance sum != total");
        let nonce = self.nonce + 1;
        let update = self.build_update(&next, nonce, timestamp);
        let msg = serialize_state_update(&update);
        let sig_self = self.self_ep.sign(&msg);
        let frame = Frame::Move(MoveFrame {
            nonce,
            by: self.self_party,
            mv,
            timestamp,
            state_hash: update.state_hash,
            party_a_balance: update.party_a_balance,
            party_b_balance: update.party_b_balance,
            sig_proposer: sig_self,
        });
        let bytes = encode_frame(&frame);
        self.pending = Some(Pending { next, update, msg });
        vec![bytes]
    }

    pub fn handle_frame(&mut self, bytes: &[u8]) -> Vec<Vec<u8>> {
        match decode_frame(bytes).expect("decodable frame") {
            Frame::Move(m) => self.on_move(m),
            Frame::Ack(a) => self.on_ack(a),
        }
    }

    fn on_move(&mut self, frame: MoveFrame) -> Vec<Vec<u8>> {
        assert!(frame.by != self.self_party, "MOVE attributed to self");
        assert_eq!(frame.nonce, self.nonce + 1, "nonce gap");
        let next = apply_move(&self.state, frame.mv, frame.by).expect("legal move");
        assert_eq!(next.balance_a + next.balance_b, self.total, "balance sum != total");
        assert!(next.balance_a == frame.party_a_balance && next.balance_b == frame.party_b_balance, "frame balances mismatch");
        let state_hash = blake2b256(&encode_state(&next));
        assert_eq!(state_hash, frame.state_hash, "frame stateHash mismatch");
        let update = StateUpdate {
            tunnel_id: self.tunnel_id.clone(),
            state_hash,
            nonce: frame.nonce,
            timestamp: frame.timestamp,
            party_a_balance: next.balance_a,
            party_b_balance: next.balance_b,
        };
        let msg = serialize_state_update(&update);
        assert!(self.opp_ep.verify(&msg, &frame.sig_proposer), "proposer signature failed");
        let sig_responder = self.self_ep.sign(&msg);
        self.state = next;
        self.nonce = frame.nonce;
        vec![encode_frame(&Frame::Ack(AckFrame { nonce: frame.nonce, sig_responder }))]
    }

    fn on_ack(&mut self, frame: AckFrame) -> Vec<Vec<u8>> {
        let p = self.pending.take().expect("ACK with no pending");
        assert_eq!(frame.nonce, p.update.nonce, "unexpected ACK nonce");
        assert!(self.opp_ep.verify(&p.msg, &frame.sig_responder), "responder signature failed");
        self.nonce = p.update.nonce;
        self.state = p.next;
        Vec::new()
    }

    pub fn build_settlement_half_with_root(&self, timestamp: u64, root: &[u8; 32], onchain_nonce: u64) -> (Settlement, [u8; 64]) {
        let settlement = Settlement {
            tunnel_id: self.tunnel_id.clone(),
            party_a_balance: self.state.balance_a,
            party_b_balance: self.state.balance_b,
            final_nonce: onchain_nonce + 1,
            timestamp,
        };
        let sig_self = self.self_ep.sign(&serialize_settlement_with_root(&settlement, root));
        (settlement, sig_self)
    }

    /// Returns `(sig_a, sig_b)` placed by side, verifying the opponent's half over the with-root bytes.
    pub fn combine_settlement_with_root(&self, settlement: &Settlement, root: &[u8; 32], sig_self: &[u8; 64], sig_other: &[u8; 64]) -> Result<([u8; 64], [u8; 64]), String> {
        let msg = serialize_settlement_with_root(settlement, root);
        if !self.opp_ep.verify(&msg, sig_other) {
            return Err("opponent settlement signature failed verification".into());
        }
        Ok(match self.self_party {
            Party::A => (*sig_self, *sig_other),
            Party::B => (*sig_other, *sig_self),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::crypto::keypair_from_secret;
    use crate::game::blackjack::{BjMove, Party};

    fn seats() -> (DistTunnel, DistTunnel) {
        let sa: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let sb: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let pka = keypair_from_secret(&sa).public_key();
        let pkb = keypair_from_secret(&sb).public_key();
        let a = DistTunnel::new("0xab", Party::A, Endpoint::controlled(&sa), Endpoint::observer(pkb), 200, 200);
        let b = DistTunnel::new("0xab", Party::B, Endpoint::controlled(&sb), Endpoint::observer(pka), 200, 200);
        (a, b)
    }

    #[test]
    fn one_move_cosigns_and_advances_both_seats() {
        let (mut a, mut b) = seats();
        // A is round-1 player; bet 25.
        let to_b = a.propose(BjMove::Bet { amount: 25 }, 1);
        assert_eq!(to_b.len(), 1);
        let mut to_a = Vec::new();
        for f in &to_b { to_a.extend(b.handle_frame(f)); }
        assert_eq!(to_a.len(), 1); // one ACK
        for f in &to_a { assert!(a.handle_frame(f).is_empty()); }
        // both advanced to round 1, player phase, identical state hash
        assert_eq!(a.state().round, 1);
        assert_eq!(b.state().round, 1);
        assert_eq!(hex::encode(blake2b256(&encode_state(a.state()))),
                   hex::encode(blake2b256(&encode_state(b.state()))));
    }
}
