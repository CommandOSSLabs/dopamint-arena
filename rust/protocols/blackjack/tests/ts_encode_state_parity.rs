//! Cross-language state golden for the commit-reveal path: Rust `BlackjackV2` and the browser's
//! TS `BlackjackProtocol` must produce byte-identical `encode_state` (hence the co-signed state_hash)
//! through a full round's deal. Unlike the bomb_it frame golden (identity move codec), this pins the
//! parts a stale commit-reveal port would silently break: the phase-coded multi-phase state layout,
//! `computeCommitment`, and the joint card derivation (`combineReveals` → `deriveRank` → rejection
//! sampling). If any of those drifted, the browser and bot would diverge at check ② (state_hash).
//!
//! The expected hashes are `blake2b256(encodeState(...))` from the real TS engine, captured by
//! driving the identical sequence in `sui-tunnel-ts/bj_probe.ts` (round 1, stake 1000, MIN_BET,
//! deterministic value/salt = f(draw_count, seat)). Regenerate both from that script if the encoding
//! intentionally changes.
use tunnel_blackjack::v2::{
    player_party, BlackjackV2, BlackjackV2Move, BlackjackV2Secret, BlackjackV2State, Phase,
};
use tunnel_core::commitment::compute_commitment;
use tunnel_core::crypto::blake2b256;
use tunnel_harness::{Balances, Protocol, Seat, TunnelContext};

fn state_hash(s: &BlackjackV2State) -> String {
    blake2b256(&BlackjackV2.encode_state(s))
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect()
}

#[test]
fn blackjack_v2_encode_state_matches_ts_through_full_deal() {
    let p = BlackjackV2;
    let mut s = p.initial_state(&TunnelContext {
        tunnel_id: "0x0000000000000000000000000000000000000000000000000000000000000001".into(),
        initial: Balances { a: 1000, b: 1000 },
        seat: Seat::A,
    });

    let mut hashes = vec![state_hash(&s)]; // s0
    for _ in 0..20 {
        match s.phase {
            Phase::Player => break,
            Phase::RoundOver => {
                let by = player_party(s.round + 1);
                s = p
                    .apply_move(&s, &BlackjackV2Move::Bet { amount: 1 }, by)
                    .unwrap();
            }
            Phase::DrawCommit => {
                let by = if s.pending_commit_a.is_none() {
                    Seat::A
                } else {
                    Seat::B
                };
                let sc: u64 = if by == Seat::A { 0 } else { 1 };
                let value = vec![(s.draw_count & 0xff) as u8, sc as u8];
                let salt = vec![((0x40 + s.draw_count * 2 + sc) & 0xff) as u8; 16];
                let commitment = compute_commitment(&value, &salt).unwrap();
                s = p
                    .apply_move(
                        &s,
                        &BlackjackV2Move::Commit {
                            commitment,
                            local_secret: Some(BlackjackV2Secret { value, salt }),
                        },
                        by,
                    )
                    .unwrap();
            }
            Phase::DrawReveal => {
                let by = if s.pending_reveal_a.is_none() {
                    Seat::A
                } else {
                    Seat::B
                };
                let secret = if by == Seat::A {
                    s.local_secret_a.clone()
                } else {
                    s.local_secret_b.clone()
                }
                .unwrap();
                s = p
                    .apply_move(
                        &s,
                        &BlackjackV2Move::Reveal {
                            reveal: secret.into(),
                        },
                        by,
                    )
                    .unwrap();
            }
        }
        hashes.push(state_hash(&s));
    }

    // Byte-for-byte with the TS engine (sui-tunnel-ts/bj_probe.ts).
    assert_eq!(s.phase, Phase::Player, "deal must reach the player phase");
    assert_eq!(
        hashes[0],
        "5f620ce788ad23ac9bac32b2217dc2630eee9a7c8bfc686b1eefc61e2a938b8e"
    ); // initial
    assert_eq!(
        hashes[1],
        "d61ae1673fb1f7e3b1a2b330dc60879c8d4b644722327ecae594f9005aca7f25"
    ); // post-bet
    assert_eq!(
        hashes[5],
        "be5a03c0e4ed2924fc04d5274e71292dfeac6d342e4906df4a0986cbbc866918"
    ); // first card dealt (deriveRank)
    assert_eq!(
        hashes.last().unwrap(),
        "3f5d589ad9679ab21eab2f21e8a26e43992ce478bf44ac0f9409a0bd59740174" // full deal → player phase
    );
}
