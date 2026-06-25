//! Channel-agnostic match driver. Replicates `tools/loadbench/src/match.ts::playMatch`:
//! two seats with a synchronous in-memory channel, basic-strategy bots, then a root-anchored
//! cooperative settlement (`root = blake2b256("dopamint:" + tunnelId)`).

use crate::engine::crypto::blake2b256;
use crate::engine::crypto::keypair_from_secret;
use crate::engine::tunnel::{DistTunnel, Endpoint};
use crate::engine::wire::Settlement;
use crate::game::blackjack::{plan, Party};

pub struct MatchResult {
    pub moves: u64,
    pub bytes: usize,
    pub final_balance_a: u64,
    pub final_balance_b: u64,
    pub settlement: Settlement,
    pub sig_a: [u8; 64],
    pub sig_b: [u8; 64],
}

/// Pump one seat's proposal to the other and back until quiescent; returns bytes sent.
fn deliver(proposer: &mut DistTunnel, responder: &mut DistTunnel, first: Vec<Vec<u8>>) -> usize {
    let mut bytes = 0usize;
    // proposer -> responder (MOVE), responder -> proposer (ACK), proposer -> [] (done)
    let mut to_responder = first;
    loop {
        let mut to_proposer = Vec::new();
        for f in &to_responder {
            bytes += f.len();
            to_proposer.extend(responder.handle_frame(f));
        }
        if to_proposer.is_empty() {
            break;
        }
        let mut next_to_responder = Vec::new();
        for f in &to_proposer {
            bytes += f.len();
            next_to_responder.extend(proposer.handle_frame(f));
        }
        if next_to_responder.is_empty() {
            break;
        }
        to_responder = next_to_responder;
    }
    bytes
}

pub fn play_fixed_match(
    tunnel_id: &str,
    secret_a: &[u8; 32],
    secret_b: &[u8; 32],
    balance_a: u64,
    balance_b: u64,
    created_at: u64,
    max_moves: u64,
) -> MatchResult {
    let pka = keypair_from_secret(secret_a).public_key();
    let pkb = keypair_from_secret(secret_b).public_key();
    let mut dt_a = DistTunnel::new(
        tunnel_id,
        Party::A,
        Endpoint::controlled(secret_a),
        Endpoint::observer(pkb),
        balance_a,
        balance_b,
    );
    let mut dt_b = DistTunnel::new(
        tunnel_id,
        Party::B,
        Endpoint::controlled(secret_b),
        Endpoint::observer(pka),
        balance_a,
        balance_b,
    );

    let mut moves = 0u64;
    let mut bytes = 0usize;
    let mut ts = created_at;

    'outer: while moves < max_moves && !dt_a.is_terminal() {
        let mut progressed = false;
        for p in [Party::A, Party::B] {
            if dt_a.is_terminal() {
                break;
            }
            // Each seat plans against its OWN tunnel's confirmed state (identical after each
            // confirmed move). The immutable borrow ends before the mutable propose below,
            // since `plan` returns an owned `Option<BjMove>` (BjMove is Copy).
            let mv = {
                let st = match p {
                    Party::A => dt_a.state(),
                    Party::B => dt_b.state(),
                };
                plan(st, p)
            };
            let mv = match mv {
                Some(m) => m,
                None => continue,
            };
            ts += 1;
            let first = match p {
                Party::A => dt_a.propose(mv, ts),
                Party::B => dt_b.propose(mv, ts),
            };
            bytes += match p {
                Party::A => deliver(&mut dt_a, &mut dt_b, first),
                Party::B => deliver(&mut dt_b, &mut dt_a, first),
            };
            moves += 1;
            progressed = true;
            if moves >= max_moves {
                break 'outer;
            }
        }
        if !progressed {
            break;
        }
    }

    let root = blake2b256(format!("dopamint:{tunnel_id}").as_bytes());
    let (settlement, sig_a_half) = dt_a.build_settlement_half_with_root(created_at, &root, 0);
    let (_settlement_b, sig_b_half) = dt_b.build_settlement_half_with_root(created_at, &root, 0);
    let (sig_a, sig_b) = dt_a
        .combine_settlement_with_root(&settlement, &root, &sig_a_half, &sig_b_half)
        .expect("settlement combines");

    let (final_a, final_b) = (settlement.party_a_balance, settlement.party_b_balance);
    MatchResult {
        moves,
        bytes,
        final_balance_a: final_a,
        final_balance_b: final_b,
        settlement,
        sig_a,
        sig_b,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_match_runs_and_conserves_balances() {
        let sa: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let sb: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let r = play_fixed_match("0xab", &sa, &sb, 200, 200, 1234567890, 500);
        assert_eq!(r.final_balance_a + r.final_balance_b, 400);
        assert!(r.moves > 0);
        assert!(r.bytes > 0);
    }
}
