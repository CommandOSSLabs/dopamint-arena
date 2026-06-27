//! The synchronous in-process match driver: two `TunnelSeat`s pumped against each
//! other with no channel and no async runtime. Mirrors loadbench's `playMatch`
//! (basic-strategy bots, then a root-anchored cooperative settlement). `bytes`
//! counts MOVE/ACK frame bytes only — the determinism gate (143*N / 75982*N).

use std::time::Instant;
use tunnel_blackjack::{plan, Blackjack};
use tunnel_core::crypto::{blake2b256, keypair_from_secret};
use tunnel_core::wire::{serialize_settlement_with_root, Settlement};
use tunnel_harness::{Balances, LocalSigner, Seat, TunnelContext, TunnelSeat};

type Seats = TunnelSeat<Blackjack, LocalSigner>;

pub struct MatchResult {
    pub moves: u64,
    pub bytes: usize,
    pub final_balance_a: u64,
    pub final_balance_b: u64,
    pub play_ns: u128,
}

/// Per-worker cached seat material: secrets + derived public keys, so the per-match
/// path skips public-key derivation.
pub struct SeatKit {
    secret_a: [u8; 32],
    secret_b: [u8; 32],
    pk_a: [u8; 32],
    pk_b: [u8; 32],
}

impl SeatKit {
    pub fn new(secret_a: &[u8; 32], secret_b: &[u8; 32]) -> SeatKit {
        SeatKit {
            secret_a: *secret_a,
            secret_b: *secret_b,
            pk_a: keypair_from_secret(secret_a).public_key(),
            pk_b: keypair_from_secret(secret_b).public_key(),
        }
    }
}

/// Pump one seat's MOVE to the other and the ACK back until quiescent; returns bytes sent.
fn deliver(proposer: &mut Seats, responder: &mut Seats, first: Vec<u8>) -> usize {
    let mut bytes = first.len();
    let mut to_responder = vec![first];
    loop {
        let mut to_proposer = Vec::new();
        for f in &to_responder {
            to_proposer.extend(responder.handle_frame(f).expect("legal frame"));
        }
        if to_proposer.is_empty() {
            break;
        }
        let mut next = Vec::new();
        for f in &to_proposer {
            bytes += f.len();
            next.extend(proposer.handle_frame(f).expect("legal frame"));
        }
        if next.is_empty() {
            break;
        }
        for f in &next {
            bytes += f.len();
        }
        to_responder = next;
    }
    bytes
}

/// Inject the per-match card seed into a seat's blackjack state before play. `None`
/// keeps the golden deterministic stream (byte-identical to the legacy gate).
fn seed_cards(seat: &mut Seats, card_seed: Option<u64>) {
    if card_seed.is_some() {
        seat.with_state_mut(|s| s.card_seed = card_seed);
    }
}

#[allow(clippy::too_many_arguments)]
pub fn play_match_seeded(
    card_seed: Option<u64>,
    kit: &SeatKit,
    tunnel_id: &str,
    balance_a: u64,
    balance_b: u64,
    created_at: u64,
    max_moves: u64,
) -> MatchResult {
    let ctx = |seat| TunnelContext {
        tunnel_id: tunnel_id.to_string(),
        initial: Balances {
            a: balance_a,
            b: balance_b,
        },
        seat,
    };
    let mut a: Seats = TunnelSeat::new(
        Blackjack,
        LocalSigner::from_secret(&kit.secret_a),
        kit.pk_b,
        ctx(Seat::A),
    );
    let mut b: Seats = TunnelSeat::new(
        Blackjack,
        LocalSigner::from_secret(&kit.secret_b),
        kit.pk_a,
        ctx(Seat::B),
    );
    seed_cards(&mut a, card_seed);
    seed_cards(&mut b, card_seed);

    let started = Instant::now();
    let mut moves = 0u64;
    let mut bytes = 0usize;
    let mut ts = created_at;

    'outer: while moves < max_moves && !a.is_terminal() {
        let mut progressed = false;
        for p in [Seat::A, Seat::B] {
            if a.is_terminal() {
                break;
            }
            let st = if p == Seat::A { a.state() } else { b.state() };
            let Some(mv) = plan(st, p) else { continue };
            ts += 1;
            let first = if p == Seat::A {
                a.propose(mv, ts).expect("legal move")
            } else {
                b.propose(mv, ts).expect("legal move")
            };
            bytes += if p == Seat::A {
                deliver(&mut a, &mut b, first)
            } else {
                deliver(&mut b, &mut a, first)
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

    // Root-anchored cooperative settlement (mirrors loadbench; not counted in bytes).
    let root = blake2b256(format!("dopamint:{tunnel_id}").as_bytes());
    let bals = a.balances();
    let settlement = Settlement {
        tunnel_id: tunnel_id.to_string(),
        party_a_balance: bals.a,
        party_b_balance: bals.b,
        final_nonce: 1,
        timestamp: created_at,
    };
    let msg = serialize_settlement_with_root(&settlement, &root);
    let _sig_a = a.sign(&msg);
    let _sig_b = b.sign(&msg);

    MatchResult {
        moves,
        bytes,
        final_balance_a: bals.a,
        final_balance_b: bals.b,
        play_ns: started.elapsed().as_nanos(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deterministic_match_is_143_moves_and_75982_bytes() {
        let sa: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let sb: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let kit = SeatKit::new(&sa, &sb);
        let r = play_match_seeded(None, &kit, "0x1", 200, 200, 1234567890, 1000);
        assert_eq!(r.moves, 143, "golden deterministic move count");
        assert_eq!(r.bytes, 75982, "golden deterministic frame bytes");
        assert_eq!(r.final_balance_a + r.final_balance_b, 400);
    }
}
