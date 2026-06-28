//! Drive two `PartyRuntime`s through a full blackjack match in-process — no frame transport,
//! no async runtime. Proves the sans-IO core runs a real match and conserves value.

use tunnel_blackjack::{plan, Blackjack};
use tunnel_core::crypto::keypair_from_secret;
use tunnel_harness::{Balances, LocalSigner, PartyRuntime, Seat, TunnelContext};

/// Pump a proposer's MOVE to the responder and the ACK back until quiescent.
fn deliver(
    proposer: &mut PartyRuntime<Blackjack, LocalSigner>,
    responder: &mut PartyRuntime<Blackjack, LocalSigner>,
    first: Vec<u8>,
) {
    let mut to_responder = vec![first];
    loop {
        let mut to_proposer = Vec::new();
        for f in &to_responder {
            to_proposer.extend(responder.handle_frame(f).unwrap());
        }
        if to_proposer.is_empty() {
            break;
        }
        let mut next = Vec::new();
        for f in &to_proposer {
            next.extend(proposer.handle_frame(f).unwrap());
        }
        if next.is_empty() {
            break;
        }
        to_responder = next;
    }
}

#[test]
fn seat_self_play_match_conserves_balances() {
    let sa: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
    let sb: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
    let pka = keypair_from_secret(&sa).public_key();
    let pkb = keypair_from_secret(&sb).public_key();
    let ctx = |seat| TunnelContext {
        tunnel_id: "0xab".into(),
        initial: Balances { a: 200, b: 200 },
        seat,
    };
    let mut a = PartyRuntime::new(Blackjack, LocalSigner::from_secret(&sa), pkb, ctx(Seat::A));
    let mut b = PartyRuntime::new(Blackjack, LocalSigner::from_secret(&sb), pka, ctx(Seat::B));

    let mut ts = 1u64;
    let mut moves = 0u64;
    'outer: while moves < 5000 && !a.is_terminal() {
        let mut progressed = false;
        for p in [Seat::A, Seat::B] {
            if a.is_terminal() {
                break;
            }
            let st = if p == Seat::A { a.state() } else { b.state() };
            let Some(mv) = plan(st, p) else { continue };
            ts += 1;
            let first = if p == Seat::A {
                a.propose(mv, ts).unwrap()
            } else {
                b.propose(mv, ts).unwrap()
            };
            if p == Seat::A {
                deliver(&mut a, &mut b, first);
            } else {
                deliver(&mut b, &mut a, first);
            }
            moves += 1;
            progressed = true;
            if moves >= 5000 {
                break 'outer;
            }
        }
        if !progressed {
            break;
        }
    }

    assert!(moves > 0, "match made progress");
    assert_eq!(a.balances().sum(), 400);
    assert_eq!(a.balances(), b.balances());
    assert!(a.is_terminal());
}
