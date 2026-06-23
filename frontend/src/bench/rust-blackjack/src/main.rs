// Faithful Rust port of frontend blackjack.bet.v1 + the self-play step loop,
// for a language-vs-language throughput comparison against the JS engine.
//
// WHY: bun/node already run ed25519 in native C (BoringSSL/OpenSSL), so the
// crypto is ~a tie with Rust; the open question was whether Rust's non-crypto
// path (encode/hash/serialize/alloc, no GC) wins enough to matter. This is the
// apples-to-apples answer — `bjbench.ts` is the JS counterpart it mirrors.
//
// TRUSTWORTHINESS: `parity` mode emits the latest stateHash + both signatures
// after 50 real moves; it is byte-identical to `bjbench.ts` (and to node/bun),
// proving this port does the same work and produces on-chain-settleable bytes.
//
// RESULT (AWS c7i.48xlarge / Xeon 8488C, single core, real blackjack):
//   Rust 10,525 tx/s vs bun 6,958 vs node 3,187  ->  Rust = 1.51x bun, 3.30x node.
//   (On Apple Silicon it was a TIE — Rust's edge is x86-specific. Test on target HW.)
//
// RUN:  cargo build --release
//       ./target/release/blackjack-tps-rs parity        # prints PARITY line
//       ./target/release/blackjack-tps-rs bench 10000    # transitions/s over 10s
// Compare against: node/bun dist/bench/bjbench.js {parity,bench 10000}
use ed25519_dalek::{Signer, Verifier, SigningKey, Signature};
use blake2::{Blake2b, Digest};
use blake2::digest::consts::U32;
use std::time::Instant;
type B256 = Blake2b<U32>;

fn blake2b256(data: &[u8]) -> [u8; 32] { B256::digest(data).into() }
fn proto_domain() -> Vec<u8> { b"sui_tunnel::proto::blackjack.bet.v1".to_vec() }

fn hand_value(v: &[u8]) -> i64 {
    let mut total = 0i64; let mut aces = 0i64;
    for &x in v { total += x as i64; if x == 11 { aces += 1; } }
    while total > 21 && aces > 0 { total -= 10; aces -= 1; }
    total
}
fn rank_value(rank: u32) -> u8 { if rank == 1 { 11 } else if rank >= 11 { 10 } else { rank as u8 } }
fn draw_rank(round: u64, draw_index: u64) -> u32 {
    let mut buf = proto_domain(); buf.extend_from_slice(&round.to_be_bytes());
    let mut digest = blake2b256(&buf);
    for b in 0..(draw_index / 32) { let mut x = digest.to_vec(); x.extend_from_slice(&b.to_be_bytes()); digest = blake2b256(&x); }
    (digest[(draw_index % 32) as usize] as u32 % 13) + 1
}
fn player_party(round: u64) -> u8 { let r = round.wrapping_sub(1); if (r / 2) % 2 == 0 { 0 } else { 1 } }
fn dealer_party(round: u64) -> u8 { if player_party(round) == 0 { 1 } else { 0 } }

const MIN_BET: u64 = 25;
const ROUND_CAP: u64 = 1000;
#[derive(Clone)]
struct State { phase: u8, round: u64, draw_index: u64, player: Vec<u8>, dealer: Vec<u8>, bal_a: u64, bal_b: u64, total: u64, bet: u64 }
enum Move { Bet(u64), Hit, Stand }

fn initial_state(a: u64, b: u64) -> State { State{phase:0,round:0,draw_index:0,player:vec![],dealer:vec![],bal_a:a,bal_b:b,total:a+b,bet:0} }
fn max_bet(s: &State) -> u64 { s.bal_a.min(s.bal_b) }
fn is_terminal(s: &State) -> bool { s.round >= ROUND_CAP || (s.phase == 0 && max_bet(s) < MIN_BET) }
fn actor_for(s: &State) -> u8 { if s.phase == 1 { player_party(s.round) } else if s.phase == 2 { dealer_party(s.round) } else { player_party(s.round + 1) } }

fn draw_to(hand: &mut Vec<u8>, round: u64, di: &mut u64) { hand.push(rank_value(draw_rank(round, *di))); *di += 1; }
fn deal_round(s: &State, bet: u64) -> State {
    let round = s.round + 1; let mut di = 0u64; let mut p = vec![]; let mut d = vec![];
    for _ in 0..2 { draw_to(&mut p, round, &mut di); }
    for _ in 0..2 { draw_to(&mut d, round, &mut di); }
    State{phase:1,round,draw_index:di,player:p,dealer:d,bal_a:s.bal_a,bal_b:s.bal_b,total:s.total,bet}
}
fn settle(mut s: State, winner: i32) -> State {
    if winner == 0 { let amt = s.bet.min(s.bal_b); s.bal_a += amt; s.bal_b -= amt; }
    else if winner == 1 { let amt = s.bet.min(s.bal_a); s.bal_b += amt; s.bal_a -= amt; }
    s.phase = 0; s
}
fn resolve_dealer(s: &State) -> State {
    let mut hand = s.dealer.clone(); let mut di = s.draw_index;
    while hand_value(&hand) < 17 { draw_to(&mut hand, s.round, &mut di); }
    let mut r = s.clone(); r.dealer = hand; r.draw_index = di;
    let pv = hand_value(&r.player); let dv = hand_value(&r.dealer);
    let winner = if dv > 21 { player_party(s.round) as i32 }
        else if pv > dv { player_party(s.round) as i32 }
        else if dv > pv { dealer_party(s.round) as i32 } else { -1 };
    settle(r, winner)
}
fn apply_move(s: &State, m: &Move, by: u8) -> State {
    match s.phase {
        0 => { let amount = match m { Move::Bet(a) => *a, _ => panic!("bet expected") };
               assert_eq!(by, player_party(s.round + 1)); deal_round(s, amount) }
        1 => match m {
                 Move::Hit => { let mut hand = s.player.clone(); let mut di = s.draw_index; draw_to(&mut hand, s.round, &mut di);
                                let mut next = s.clone(); next.player = hand.clone(); next.draw_index = di;
                                if hand_value(&hand) > 21 { settle(next, dealer_party(s.round) as i32) } else { next } }
                 Move::Stand => { let mut next = s.clone(); next.phase = 2; next }
                 _ => panic!("bad player move") },
        2 => resolve_dealer(s),
        _ => panic!("phase"),
    }
}
fn encode_state(s: &State) -> Vec<u8> {
    let mut o = proto_domain();
    o.extend_from_slice(&s.bal_a.to_be_bytes());
    o.extend_from_slice(&s.bal_b.to_be_bytes());
    o.extend_from_slice(&s.round.to_be_bytes());
    o.extend_from_slice(&s.draw_index.to_be_bytes());
    o.push(s.phase);
    o.extend_from_slice(&s.bet.to_be_bytes());
    o.extend_from_slice(&(s.player.len() as u64).to_be_bytes());
    o.extend_from_slice(&s.player);
    o.extend_from_slice(&(s.dealer.len() as u64).to_be_bytes());
    o.extend_from_slice(&s.dealer);
    o
}
fn plan(seat: u8, s: &State) -> Option<Move> {
    if is_terminal(s) || actor_for(s) != seat { return None; }
    match s.phase {
        0 => { let cap = max_bet(s); if cap < MIN_BET { return None; }
               let amount = [25u64,100,500,1000].into_iter().find(|&o| o >= MIN_BET && o <= cap).unwrap_or(MIN_BET);
               Some(Move::Bet(amount.max(MIN_BET).min(cap))) }
        1 => { if seat != player_party(s.round) { return None; }
               Some(if hand_value(&s.player) < 17 { Move::Hit } else { Move::Stand }) }
        2 => { if seat != dealer_party(s.round) { return None; } Some(Move::Stand) }
        _ => None,
    }
}
fn serialize_state_update(tid: &[u8;32], sh: &[u8;32], nonce: u64, ts: u64, a: u64, b: u64) -> [u8;120] {
    let mut m = [0u8;120];
    m[..24].copy_from_slice(b"sui_tunnel::state_update");
    m[24..56].copy_from_slice(tid); m[56..88].copy_from_slice(sh);
    m[88..96].copy_from_slice(&nonce.to_be_bytes()); m[96..104].copy_from_slice(&ts.to_be_bytes());
    m[104..112].copy_from_slice(&a.to_be_bytes()); m[112..120].copy_from_slice(&b.to_be_bytes());
    m
}
const HEX: &[u8;16] = b"0123456789abcdef";
fn hex16(b:&[u8])->String{let mut s=String::new();for &x in b.iter().take(8){s.push(HEX[(x>>4)as usize]as char);s.push(HEX[(x&15)as usize]as char);}s}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).map(|s| s.as_str()).unwrap_or("bench");
    let tid = [0x11u8;32];
    let ska = SigningKey::from_bytes(&[3u8;32]); let vka = ska.verifying_key();
    let skb = SigningKey::from_bytes(&[4u8;32]); let vkb = skb.verifying_key();

    if mode == "parity" {
        let mut s = initial_state(10000, 10000); let mut nonce = 0u64; let mut steps = 0u64;
        let mut last: Option<([u8;32],Signature,Signature)> = None;
        while steps < 50 && !is_terminal(&s) {
            let actor = actor_for(&s);
            match plan(actor, &s) {
                Some(m) => { let next = apply_move(&s, &m, actor); let sh = blake2b256(&encode_state(&next));
                    let msg = serialize_state_update(&tid, &sh, nonce+1, 0, next.bal_a, next.bal_b);
                    let sa: Signature = ska.sign(&msg); let sb: Signature = skb.sign(&msg);
                    vka.verify(&msg,&sa).unwrap(); vkb.verify(&msg,&sb).unwrap();
                    s = next; nonce += 1; steps += 1; last = Some((sh,sa,sb)); }
                None => break,
            }
        }
        let (sh,sa,sb) = last.unwrap();
        println!("PARITY steps={} sh={} sigA={} sigB={}", steps, hex16(&sh), hex16(&sa.to_bytes()), hex16(&sb.to_bytes()));
        return;
    }

    let dur_ms: u128 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(6000);
    let run = |dur: u128| -> u64 {
        let mut s = initial_state(10000,10000); let mut nonce = 0u64; let mut steps = 0u64;
        let t = Instant::now();
        while t.elapsed().as_millis() < dur {
            if is_terminal(&s) { s = initial_state(10000,10000); nonce = 0; continue; }
            let enc = encode_state(&s);
            let mut h = String::with_capacity(enc.len()*2); for &x in &enc { h.push(HEX[(x>>4)as usize]as char); h.push(HEX[(x&15)as usize]as char); } std::hint::black_box(&h);
            let actor = actor_for(&s);
            match plan(actor, &s) {
                Some(m) => { let next = apply_move(&s, &m, actor); let sh = blake2b256(&encode_state(&next));
                    let msg = serialize_state_update(&tid, &sh, nonce+1, 0, next.bal_a, next.bal_b);
                    let sa: Signature = ska.sign(&msg); let sb: Signature = skb.sign(&msg);
                    vka.verify(&msg,&sa).unwrap(); vkb.verify(&msg,&sb).unwrap();
                    s = next; nonce += 1; steps += 1; }
                None => { s = initial_state(10000,10000); nonce = 0; }
            }
        }
        steps
    };
    run(1500);
    let steps = run(dur_ms);
    println!("[rust-dalek-native] blackjack full-flow: {} transitions/s", ((steps as f64)/((dur_ms as f64)/1000.0)) as u64);
}
