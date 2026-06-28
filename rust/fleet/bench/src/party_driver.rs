//! The synchronous in-process match driver: two `PartyRuntime`s pumped against each
//! other with no frame transport and no async runtime. Mirrors loadbench's `playMatch`
//! (basic-strategy bots, then a root-anchored cooperative settlement). `bytes`
//! counts MOVE/ACK frame bytes only — the determinism gate (143*N / 75982*N).

use std::time::Instant;
use tunnel_blackjack::v2::{BlackjackV2, BlackjackV2Move};
use tunnel_blackjack::{BjMove, Blackjack};
use tunnel_core::crypto::blake2b256;
use tunnel_core::wire::{serialize_settlement_with_root, Settlement};
use tunnel_harness::{
    Balances, FrameCodec, LocalSigner, PartyRuntime, Protocol, Seat, Signer, TunnelContext,
};

type Seats<P, C> = PartyRuntime<P, LocalSigner, C>;

pub struct MatchResult {
    pub moves: u64,
    pub bytes: usize,
    pub final_balance_a: u64,
    pub final_balance_b: u64,
    pub play_ns: u128,
}

/// Pre-built signer material for both seats.
#[derive(Clone)]
pub struct SeatKit {
    signer_a: LocalSigner,
    signer_b: LocalSigner,
    pk_a: [u8; 32],
    pk_b: [u8; 32],
}

impl SeatKit {
    pub fn new(secret_a: &[u8; 32], secret_b: &[u8; 32]) -> SeatKit {
        let signer_a = LocalSigner::from_secret(secret_a);
        let signer_b = LocalSigner::from_secret(secret_b);
        SeatKit {
            pk_a: signer_a.public_key(),
            pk_b: signer_b.public_key(),
            signer_a,
            signer_b,
        }
    }
}

/// Pump one seat's MOVE to the other and the ACK back until quiescent; returns bytes sent.
fn deliver<P, C>(proposer: &mut Seats<P, C>, responder: &mut Seats<P, C>, first: Vec<u8>) -> usize
where
    P: Protocol,
    C: FrameCodec<P::Move>,
{
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
fn seed_cards<C: FrameCodec<BjMove>>(seat: &mut Seats<Blackjack, C>, card_seed: Option<u64>) {
    if card_seed.is_some() {
        seat.with_state_mut(|s| s.card_seed = card_seed);
    }
}

struct SplitMix64 {
    state: u64,
}

impl SplitMix64 {
    fn new(seed: u64) -> SplitMix64 {
        SplitMix64 { state: seed }
    }

    fn next_f64(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        (z >> 11) as f64 / (1u64 << 53) as f64
    }
}

#[allow(clippy::too_many_arguments)]
fn play_protocol_match_seeded<P, C>(
    protocol: P,
    move_seed: u64,
    kit: &SeatKit,
    tunnel_id: &str,
    balance_a: u64,
    balance_b: u64,
    created_at: u64,
    max_moves: u64,
    configure: impl FnOnce(&mut Seats<P, C>, &mut Seats<P, C>),
) -> MatchResult
where
    P: Protocol + Clone,
    C: FrameCodec<P::Move> + Default,
{
    let ctx = |seat| TunnelContext {
        tunnel_id: tunnel_id.to_string(),
        initial: Balances {
            a: balance_a,
            b: balance_b,
        },
        seat,
    };
    let mut a: Seats<P, C> = PartyRuntime::new(
        protocol.clone(),
        kit.signer_a.clone(),
        kit.pk_b,
        ctx(Seat::A),
    );
    let mut b: Seats<P, C> = PartyRuntime::new(
        protocol.clone(),
        kit.signer_b.clone(),
        kit.pk_a,
        ctx(Seat::B),
    );
    configure(&mut a, &mut b);

    let started = Instant::now();
    let mut moves = 0u64;
    let mut bytes = 0usize;
    let mut ts = created_at;
    let mut rng_a = SplitMix64::new(move_seed ^ 0xA5A5_5A5A_D0D0_1CE5);
    let mut rng_b = SplitMix64::new(move_seed ^ 0x5A5A_A5A5_CAFE_BABE);

    'outer: while moves < max_moves && !a.is_terminal() {
        let mut progressed = false;
        for p in [Seat::A, Seat::B] {
            if a.is_terminal() {
                break;
            }
            let mv = match p {
                Seat::A => {
                    let mut rng = || rng_a.next_f64();
                    protocol.sample_move(a.state(), p, &mut rng)
                }
                Seat::B => {
                    let mut rng = || rng_b.next_f64();
                    protocol.sample_move(b.state(), p, &mut rng)
                }
            };
            let Some(mv) = mv else { continue };
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

#[allow(clippy::too_many_arguments)]
pub fn play_match_seeded<C: FrameCodec<BjMove> + Default>(
    card_seed: Option<u64>,
    kit: &SeatKit,
    tunnel_id: &str,
    balance_a: u64,
    balance_b: u64,
    created_at: u64,
    max_moves: u64,
) -> MatchResult {
    play_protocol_match_seeded::<Blackjack, C>(
        Blackjack,
        card_seed.unwrap_or(0),
        kit,
        tunnel_id,
        balance_a,
        balance_b,
        created_at,
        max_moves,
        |a, b| {
            seed_cards(a, card_seed);
            seed_cards(b, card_seed);
        },
    )
}

#[allow(clippy::too_many_arguments)]
pub fn play_blackjack_v2_seeded<C: FrameCodec<BlackjackV2Move> + Default>(
    move_seed: u64,
    kit: &SeatKit,
    tunnel_id: &str,
    balance_a: u64,
    balance_b: u64,
    created_at: u64,
    max_moves: u64,
) -> MatchResult {
    play_protocol_match_seeded::<BlackjackV2, C>(
        BlackjackV2,
        move_seed,
        kit,
        tunnel_id,
        balance_a,
        balance_b,
        created_at,
        max_moves,
        |_, _| {},
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use tunnel_harness::{BcsFrameCodec, JsonFrameCodec, PostcardFrameCodec};

    const BCS_GOLDEN_BYTES: usize = 29492;
    const POSTCARD_GOLDEN_BYTES: usize = 24985;

    fn golden_match<C: tunnel_harness::FrameCodec<tunnel_blackjack::BjMove> + Default>(
    ) -> MatchResult {
        let sa: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let sb: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let kit = SeatKit::new(&sa, &sb);
        play_match_seeded::<C>(None, &kit, "0x1", 200, 200, 1234567890, 1000)
    }

    #[test]
    fn json_match_is_143_moves_and_75982_bytes() {
        let r = golden_match::<JsonFrameCodec>();
        assert_eq!(r.moves, 143, "golden deterministic move count");
        assert_eq!(r.bytes, 75982, "golden JSON frame bytes");
        assert_eq!(r.final_balance_a + r.final_balance_b, 400);
    }

    #[test]
    fn move_count_is_codec_independent() {
        let j = golden_match::<JsonFrameCodec>();
        let b = golden_match::<BcsFrameCodec>();
        let p = golden_match::<PostcardFrameCodec>();
        for r in [&b, &p] {
            assert_eq!(r.moves, j.moves);
            assert_eq!(r.final_balance_a, j.final_balance_a);
            assert_eq!(r.final_balance_b, j.final_balance_b);
        }
        assert!(
            b.bytes < j.bytes && p.bytes < j.bytes,
            "json={} bcs={} postcard={}",
            j.bytes,
            b.bytes,
            p.bytes
        );
    }

    #[test]
    fn bcs_match_byte_golden() {
        assert_eq!(golden_match::<BcsFrameCodec>().bytes, BCS_GOLDEN_BYTES);
    }

    #[test]
    fn postcard_match_byte_golden() {
        assert_eq!(
            golden_match::<PostcardFrameCodec>().bytes,
            POSTCARD_GOLDEN_BYTES
        );
    }
}
