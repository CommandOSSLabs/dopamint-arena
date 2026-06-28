use std::collections::BTreeMap;

use crate::{
    balance, best_poker_hand, commit_slot_secrets, derive_quantum_card,
    expected_quantum_poker_reveal_slots, local_secret_array, random_slot_secrets, reveal_array,
    street_bet, total_bet, PokerMove, PokerPhase, PokerState, QuantumPoker, SlotSecret,
    A_HOLE_SLOTS, B_HOLE_SLOTS,
};
use tunnel_harness::{MoveStrategy, MoveStrategyContext, Seat};

#[derive(Clone, Debug)]
pub struct QuantumPokerStrategy {
    rng_state: u32,
    secrets_by_hand: BTreeMap<u64, Vec<SlotSecret>>,
}

impl QuantumPokerStrategy {
    pub fn new(seed: u64) -> Self {
        Self {
            rng_state: seed as u32,
            secrets_by_hand: BTreeMap::new(),
        }
    }

    pub fn has_cached_secrets_for_hand(&self, hand_no: u64) -> bool {
        self.secrets_by_hand.contains_key(&hand_no)
    }

    fn next_f64(&mut self) -> f64 {
        self.rng_state = self.rng_state.wrapping_add(0x6d2b_79f5);
        let mut t = (self.rng_state ^ (self.rng_state >> 15)).wrapping_mul(1 | self.rng_state);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        ((t ^ (t >> 14)) as f64) / 4_294_967_296.0
    }

    fn secrets_for(&mut self, state: &PokerState, seat: Seat) -> Option<Vec<SlotSecret>> {
        if let Some(secrets) = self.secrets_by_hand.get(&state.hand_no) {
            return Some(secrets.clone());
        }
        let locals = local_secret_array(state, seat)?;
        let secrets: Option<Vec<_>> = locals.iter().cloned().collect();
        let secrets = secrets?;
        self.secrets_by_hand.insert(state.hand_no, secrets.clone());
        Some(secrets)
    }
}

impl MoveStrategy<QuantumPoker> for QuantumPokerStrategy {
    async fn plan_move(
        &mut self,
        state: &PokerState,
        seat: Seat,
        _ctx: &MoveStrategyContext,
    ) -> Option<PokerMove> {
        if actor_for_state(state) != Some(seat) {
            return None;
        }
        match state.phase {
            PokerPhase::Commit => {
                let mut rng = || self.next_f64();
                let secrets = random_slot_secrets(&mut rng);
                let commitments = commit_slot_secrets(&secrets).ok()?;
                self.secrets_by_hand.insert(state.hand_no, secrets.clone());
                Some(PokerMove::CommitSlots {
                    commitments,
                    local_secrets: Some(secrets),
                })
            }
            PokerPhase::OpenPrivateHoles
            | PokerPhase::RevealFlop
            | PokerPhase::RevealTurn
            | PokerPhase::RevealRiver
            | PokerPhase::Showdown => {
                let slots = expected_quantum_poker_reveal_slots(state, seat).ok()?;
                let secrets = self.secrets_for(state, seat)?;
                let reveals: Option<Vec<_>> = slots
                    .iter()
                    .map(|slot| secrets.get(*slot as usize).cloned())
                    .collect();
                Some(PokerMove::RevealSlots {
                    slots,
                    reveals: reveals?,
                })
            }
            PokerPhase::PreflopBet
            | PokerPhase::FlopBet
            | PokerPhase::TurnBet
            | PokerPhase::RiverBet => {
                let diff = street_bet(state, seat.other()).saturating_sub(street_bet(state, seat));
                if diff > 0 {
                    return Some(if self.next_f64() < 0.85 {
                        PokerMove::Call
                    } else {
                        PokerMove::Fold
                    });
                }
                let available = balance(state, seat).saturating_sub(total_bet(state, seat));
                if available > 0 && self.next_f64() < 0.35 {
                    let cap = available.min(200);
                    let amount = 1 + (self.next_f64() * cap as f64).floor() as u64;
                    return Some(PokerMove::Bet { amount });
                }
                Some(PokerMove::Check)
            }
            PokerPhase::HandOver => Some(PokerMove::NextHand),
            PokerPhase::Done => None,
        }
    }

    fn abort(&mut self) {
        self.secrets_by_hand.clear();
    }
}

fn actor_for_state(state: &PokerState) -> Option<Seat> {
    match state.phase {
        PokerPhase::Commit => {
            if state.commit_a.is_none() {
                Some(Seat::A)
            } else if state.commit_b.is_none() {
                Some(Seat::B)
            } else {
                None
            }
        }
        PokerPhase::OpenPrivateHoles
        | PokerPhase::RevealFlop
        | PokerPhase::RevealTurn
        | PokerPhase::RevealRiver
        | PokerPhase::Showdown => {
            if expected_quantum_poker_reveal_slots(state, Seat::A)
                .is_ok_and(|slots| !slots.is_empty())
            {
                Some(Seat::A)
            } else if expected_quantum_poker_reveal_slots(state, Seat::B)
                .is_ok_and(|slots| !slots.is_empty())
            {
                Some(Seat::B)
            } else {
                None
            }
        }
        PokerPhase::PreflopBet
        | PokerPhase::FlopBet
        | PokerPhase::TurnBet
        | PokerPhase::RiverBet => Some(state.to_act),
        PokerPhase::HandOver => Some(Seat::A),
        PokerPhase::Done => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum QuantumPokerPersona {
    Tight,
    Loose,
    Aggressive,
    Passive,
    Balanced,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum QuantumPokerDifficulty {
    Easy,
    Normal,
    Hard,
    Adaptive,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StrategyTuning {
    pub call_threshold: f64,
    pub raise_threshold: f64,
    pub semi_bluff_threshold: f64,
}

#[derive(Clone, Debug)]
pub struct QuantumPokerBotProfile {
    pub name: &'static str,
    pub persona: QuantumPokerPersona,
    pub difficulty: QuantumPokerDifficulty,
    pub adaptive_modifier: f64,
}

impl QuantumPokerBotProfile {
    pub fn balanced(name: &'static str) -> Self {
        Self {
            name,
            persona: QuantumPokerPersona::Balanced,
            difficulty: QuantumPokerDifficulty::Adaptive,
            adaptive_modifier: 0.0,
        }
    }

    pub fn loose(name: &'static str) -> Self {
        Self {
            name,
            persona: QuantumPokerPersona::Loose,
            difficulty: QuantumPokerDifficulty::Adaptive,
            adaptive_modifier: 0.0,
        }
    }

    pub fn strategy_tuning(&self) -> StrategyTuning {
        let difficulty = match self.difficulty {
            QuantumPokerDifficulty::Easy => StrategyTuning {
                call_threshold: 0.05,
                raise_threshold: 0.08,
                semi_bluff_threshold: 0.08,
            },
            QuantumPokerDifficulty::Hard => StrategyTuning {
                call_threshold: -0.035,
                raise_threshold: -0.035,
                semi_bluff_threshold: -0.035,
            },
            QuantumPokerDifficulty::Adaptive => StrategyTuning {
                call_threshold: self.adaptive_modifier * -0.012,
                raise_threshold: self.adaptive_modifier * -0.014,
                semi_bluff_threshold: self.adaptive_modifier * -0.014,
            },
            QuantumPokerDifficulty::Normal => StrategyTuning {
                call_threshold: 0.0,
                raise_threshold: 0.0,
                semi_bluff_threshold: 0.0,
            },
        };
        let persona = match self.persona {
            QuantumPokerPersona::Aggressive => StrategyTuning {
                call_threshold: -0.01,
                raise_threshold: -0.025,
                semi_bluff_threshold: -0.02,
            },
            QuantumPokerPersona::Loose => StrategyTuning {
                call_threshold: -0.03,
                raise_threshold: -0.005,
                semi_bluff_threshold: -0.005,
            },
            QuantumPokerPersona::Passive => StrategyTuning {
                call_threshold: -0.005,
                raise_threshold: 0.035,
                semi_bluff_threshold: 0.04,
            },
            QuantumPokerPersona::Tight => StrategyTuning {
                call_threshold: 0.025,
                raise_threshold: 0.025,
                semi_bluff_threshold: 0.03,
            },
            QuantumPokerPersona::Balanced => StrategyTuning {
                call_threshold: 0.0,
                raise_threshold: 0.0,
                semi_bluff_threshold: 0.0,
            },
        };
        StrategyTuning {
            call_threshold: difficulty.call_threshold + persona.call_threshold,
            raise_threshold: difficulty.raise_threshold + persona.raise_threshold,
            semi_bluff_threshold: difficulty.semi_bluff_threshold + persona.semi_bluff_threshold,
        }
    }
}

#[derive(Clone, Debug)]
pub struct QuantumPokerPersonaStrategy {
    base: QuantumPokerStrategy,
    profile: QuantumPokerBotProfile,
}

impl QuantumPokerPersonaStrategy {
    pub fn new(seed: u64, profile: QuantumPokerBotProfile) -> Self {
        Self {
            base: QuantumPokerStrategy::new(seed),
            profile,
        }
    }

    fn known_hole_cards(&mut self, state: &PokerState, seat: Seat) -> Option<Vec<u8>> {
        let secrets = self.base.secrets_for(state, seat)?;
        let slots = if seat == Seat::A {
            A_HOLE_SLOTS
        } else {
            B_HOLE_SLOTS
        };
        let mut cards = Vec::with_capacity(2);
        for slot in slots {
            let own = secrets.get(slot as usize)?;
            let other = reveal_array(state, seat.other())[slot as usize].as_ref()?;
            cards.push(if seat == Seat::A {
                derive_quantum_card(own, other, 0)
            } else {
                derive_quantum_card(other, own, 0)
            });
        }
        Some(cards)
    }

    fn persona_betting_move(&mut self, state: &PokerState, seat: Seat) -> Option<PokerMove> {
        if state.to_act != seat {
            return None;
        }
        let tuning = self.profile.strategy_tuning();
        let holes = self.known_hole_cards(state, seat).unwrap_or_default();
        let profile = estimate_strength_profile(state, seat, &holes);
        let roll = self.base.next_f64();
        if profile.call_amount > 0 {
            if profile.call_amount > profile.available {
                return Some(PokerMove::Fold);
            }
            if !profile.preflop
                && profile.strong_draw
                && profile.pot_odds <= 0.18 - tuning.call_threshold + roll * 0.015
            {
                return Some(PokerMove::Call);
            }
            let threshold = if profile.river {
                profile.pot_odds + 0.08 + profile.pressure * 0.16 + tuning.call_threshold
                    - roll * 0.025
            } else if profile.preflop {
                0.38 + profile.pressure * 0.5 + tuning.call_threshold - roll * 0.035
            } else {
                profile.pot_odds + 0.055 + profile.pressure * 0.08 + tuning.call_threshold
                    - roll * 0.025
            };
            return Some(if profile.strength >= threshold {
                PokerMove::Call
            } else {
                PokerMove::Fold
            });
        }
        if profile.available > 0 {
            let should_bet = if profile.preflop {
                profile.strength >= 0.72 + tuning.raise_threshold - roll * 0.025
            } else if state.board.len() >= 5 {
                profile.strength >= 0.38 + tuning.raise_threshold - roll * 0.02
            } else {
                let value_bet = profile.strength >= 0.30 + tuning.raise_threshold - roll * 0.02;
                let semi_bluff = profile.strong_draw
                    && profile.strength >= 0.48 + tuning.semi_bluff_threshold - roll * 0.02;
                value_bet || semi_bluff
            };
            if should_bet {
                let amount = persona_bet_amount(
                    state,
                    profile.available,
                    profile.strength,
                    profile.strong_draw,
                );
                if amount > 0 {
                    return Some(PokerMove::Bet { amount });
                }
            }
        }
        Some(PokerMove::Check)
    }
}

impl MoveStrategy<QuantumPoker> for QuantumPokerPersonaStrategy {
    async fn plan_move(
        &mut self,
        state: &PokerState,
        seat: Seat,
        ctx: &MoveStrategyContext,
    ) -> Option<PokerMove> {
        match state.phase {
            PokerPhase::PreflopBet
            | PokerPhase::FlopBet
            | PokerPhase::TurnBet
            | PokerPhase::RiverBet => {
                if actor_for_state(state) != Some(seat) {
                    None
                } else {
                    self.persona_betting_move(state, seat)
                }
            }
            _ => self.base.plan_move(state, seat, ctx).await,
        }
    }

    fn abort(&mut self) {
        self.base.abort();
    }
}

fn amount_ratio(numerator: u64, denominator: u64) -> f64 {
    if denominator == 0 {
        0.0
    } else {
        numerator as f64 / denominator as f64
    }
}

fn rank_value(card: u8) -> u8 {
    (card % 13) + 2
}

fn suited(a: u8, b: u8) -> bool {
    a / 13 == b / 13
}

#[derive(Clone, Copy, Debug)]
struct PersonaStrengthProfile {
    strength: f64,
    pot_odds: f64,
    pressure: f64,
    call_amount: u64,
    available: u64,
    preflop: bool,
    river: bool,
    strong_draw: bool,
}

fn estimate_strength_profile(
    state: &PokerState,
    seat: Seat,
    holes: &[u8],
) -> PersonaStrengthProfile {
    let call_amount = street_bet(state, seat.other()).saturating_sub(street_bet(state, seat));
    let available = balance(state, seat).saturating_sub(total_bet(state, seat));
    let pot = state.total_bet_a + state.total_bet_b;
    let preflop = state.board.len() < 3;
    let river = state.board.len() >= 5;
    PersonaStrengthProfile {
        strength: estimate_strength(state, holes),
        pot_odds: amount_ratio(call_amount, pot + call_amount),
        pressure: amount_ratio(call_amount, available + call_amount),
        call_amount,
        available,
        preflop,
        river,
        strong_draw: estimate_strong_draw(holes, &state.board),
    }
}

fn preflop_strength(holes: &[u8]) -> f64 {
    if holes.len() < 2 {
        return 0.42;
    }
    let high = rank_value(holes[0]).max(rank_value(holes[1])) as f64;
    let low = rank_value(holes[0]).min(rank_value(holes[1])) as f64;
    let gap = high - low;
    let suited_boost = if suited(holes[0], holes[1]) {
        0.045
    } else {
        0.0
    };
    let value = if (high - low).abs() < f64::EPSILON {
        0.42 + high / 28.0
    } else if high == 14.0 {
        let ace = if low >= 13.0 {
            0.78
        } else if low == 12.0 {
            0.68
        } else if low == 11.0 {
            0.62
        } else if low == 10.0 {
            0.56
        } else {
            0.32 + low / 45.0
        };
        ace + suited_boost
    } else if high == 13.0 && low >= 10.0 {
        let king = if low == 12.0 {
            0.66
        } else if low == 11.0 {
            0.59
        } else {
            0.52
        };
        king + suited_boost
    } else if high == 12.0 && low >= 10.0 {
        let queen = if low == 11.0 { 0.57 } else { 0.49 };
        queen + suited_boost
    } else {
        let connector = if gap == 1.0 {
            0.08
        } else if gap == 2.0 {
            0.04
        } else {
            (-gap * 0.022).max(-0.16)
        };
        0.24 + high / 62.0 + low / 82.0 + connector + suited_boost
    };
    value.clamp(0.0, 1.0)
}

fn estimate_strong_draw(holes: &[u8], board: &[u8]) -> bool {
    if board.len() < 3 || board.len() >= 5 {
        return false;
    }
    let mut suit_counts = [0u8; 4];
    let mut ranks = [false; 15];
    for card in holes
        .iter()
        .filter(|card| !board.contains(card))
        .chain(board.iter())
    {
        suit_counts[(card / 13) as usize] += 1;
        let rank = rank_value(*card) as usize;
        ranks[rank] = true;
        if rank == 14 {
            ranks[1] = true;
        }
    }
    if suit_counts.iter().any(|count| *count >= 4) {
        return true;
    }
    (1..=10).any(|start| (start..start + 5).filter(|rank| ranks[*rank]).count() >= 4)
}

fn estimate_strength(state: &PokerState, holes: &[u8]) -> f64 {
    if state.board.len() < 3 {
        return preflop_strength(holes);
    }
    let mut cards: Vec<u8> = holes
        .iter()
        .copied()
        .filter(|card| !state.board.contains(card))
        .collect();
    cards.extend_from_slice(&state.board);
    if cards.len() < 5 {
        return preflop_strength(holes);
    }
    let best = match best_poker_hand(&cards[..cards.len().min(7)]) {
        Ok(best) => best,
        Err(_) => return preflop_strength(holes),
    };
    let category = best.score / 13u64.pow(5);
    let high_card_lift = holes.iter().any(|card| rank_value(*card) >= 12) as u8 as f64 * 0.04;
    ((category as f64 / 9.0) * 0.86 + high_card_lift).clamp(0.0, 1.0)
}

fn persona_bet_amount(state: &PokerState, available: u64, strength: f64, strong_draw: bool) -> u64 {
    let pot = (state.total_bet_a + state.total_bet_b).max(100);
    let premium_value = if state.board.len() < 3 {
        strength >= 0.84
    } else {
        strength >= if state.board.len() >= 5 { 0.62 } else { 0.58 }
    };
    let fraction = if premium_value {
        0.9
    } else if strength >= 0.5 {
        0.7
    } else if strong_draw {
        0.45
    } else {
        0.5
    };
    ((pot as f64 * fraction).floor().max(50.0) as u64).min(available)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{PokerPhase, ANTE, SLOT_COUNT};
    use tunnel_harness::{
        Balances, InMemoryFrameTransport, LocalSigner, PartyDriver, PartyRuntime, Protocol, Signer,
        TunnelContext,
    };

    fn ctx() -> TunnelContext {
        TunnelContext {
            tunnel_id: "0xpoker".into(),
            initial: Balances { a: 1000, b: 1000 },
            seat: Seat::A,
        }
    }

    fn strategy_ctx(seat: Seat) -> MoveStrategyContext {
        MoveStrategyContext {
            tunnel_id: "0xpoker".into(),
            seat,
        }
    }

    fn strip_local_secrets(mv: PokerMove) -> PokerMove {
        match mv {
            PokerMove::CommitSlots { commitments, .. } => PokerMove::CommitSlots {
                commitments,
                local_secrets: None,
            },
            other => other,
        }
    }

    fn slot_secrets(byte: u8) -> Vec<SlotSecret> {
        (0..SLOT_COUNT)
            .map(|slot| SlotSecret {
                value: vec![byte.wrapping_add(slot as u8); 32],
                salt: vec![byte.wrapping_add(slot as u8).wrapping_add(1); 16],
            })
            .collect()
    }

    fn commit_from_secrets(secrets: Vec<SlotSecret>) -> PokerMove {
        PokerMove::CommitSlots {
            commitments: commit_slot_secrets(&secrets).unwrap(),
            local_secrets: Some(secrets),
        }
    }

    #[tokio::test]
    async fn commit_phase_strategy_serializes_a_before_b_while_protocol_allows_either_missing_seat()
    {
        let protocol = QuantumPoker::default();
        let state = protocol.initial_state(&ctx());
        let mut a = QuantumPokerStrategy::new(1);
        let mut b = QuantumPokerStrategy::new(2);

        let commit_a = a
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await
            .expect("A should commit while its slot is missing");
        assert!(b
            .plan_move(&state, Seat::B, &strategy_ctx(Seat::B))
            .await
            .is_none());

        let state = protocol
            .apply_move(&state, &strip_local_secrets(commit_a), Seat::A)
            .unwrap();
        assert!(b
            .plan_move(&state, Seat::B, &strategy_ctx(Seat::B))
            .await
            .is_some());
        let state = protocol
            .apply_move(
                &protocol.initial_state(&ctx()),
                &commit_from_secrets(slot_secrets(7)),
                Seat::B,
            )
            .unwrap();
        assert!(a
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await
            .is_some());
    }

    #[tokio::test]
    async fn reveal_uses_cached_secrets_after_commit_preimage_is_stripped() {
        let protocol = QuantumPoker::default();
        let mut state = protocol.initial_state(&ctx());
        let mut a = QuantumPokerStrategy::new(1);
        let mut b = QuantumPokerStrategy::new(2);

        let secrets_b = slot_secrets(9);
        let commit_b = commit_from_secrets(secrets_b.clone());
        b.secrets_by_hand.insert(state.hand_no, secrets_b.clone());
        state = protocol
            .apply_move(&state, &strip_local_secrets(commit_b), Seat::B)
            .unwrap();
        let commit_a = a
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await
            .unwrap();
        state = protocol
            .apply_move(&state, &strip_local_secrets(commit_a), Seat::A)
            .unwrap();
        assert_eq!(state.phase, PokerPhase::OpenPrivateHoles);
        assert!(state.local_secrets_a.is_none());
        assert!(state.local_secrets_b.is_none());

        let reveal_a = a
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await
            .expect("A should reveal from cache");
        assert!(matches!(reveal_a, PokerMove::RevealSlots { .. }));
        assert!(b
            .plan_move(&state, Seat::B, &strategy_ctx(Seat::B))
            .await
            .is_none());

        let state_before_reveal = state.clone();
        state = protocol.apply_move(&state, &reveal_a, Seat::A).unwrap();
        assert!(b
            .plan_move(&state, Seat::B, &strategy_ctx(Seat::B))
            .await
            .is_some());
        let state = protocol
            .apply_move(
                &state_before_reveal,
                &PokerMove::RevealSlots {
                    slots: expected_quantum_poker_reveal_slots(&state_before_reveal, Seat::B)
                        .unwrap(),
                    reveals: expected_quantum_poker_reveal_slots(&state_before_reveal, Seat::B)
                        .unwrap()
                        .into_iter()
                        .map(|slot| secrets_b[slot as usize].clone())
                        .collect(),
                },
                Seat::B,
            )
            .unwrap();
        assert!(a
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await
            .is_some());
    }

    fn runtime(
        seat: Seat,
        signer: LocalSigner,
        opponent_pk: [u8; 32],
    ) -> PartyRuntime<QuantumPoker, LocalSigner> {
        PartyRuntime::new(
            QuantumPoker::new(1),
            signer,
            opponent_pk,
            TunnelContext {
                tunnel_id: "0xcd".into(),
                initial: Balances { a: 1000, b: 1000 },
                seat,
            },
        )
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn party_driver_self_play_does_not_cross_propose_in_commit_reveal() {
        let secret_a: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
        let secret_b: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);
        let signer_a = LocalSigner::from_secret(&secret_a);
        let signer_b = LocalSigner::from_secret(&secret_b);
        let pk_a = signer_a.public_key();
        let pk_b = signer_b.public_key();
        let (ch_a, ch_b) = InMemoryFrameTransport::pair();

        let driver_a = PartyDriver::new(
            runtime(Seat::A, signer_a, pk_b),
            QuantumPokerStrategy::new(1),
            ch_a,
        );
        let driver_b = PartyDriver::new(
            runtime(Seat::B, signer_b, pk_a),
            QuantumPokerStrategy::new(2),
            ch_b,
        );

        let (out_a, out_b) = tokio::join!(driver_a.run(200, || 1), driver_b.run(200, || 1));
        let out_a = out_a.unwrap();
        let out_b = out_b.unwrap();

        assert_eq!(out_a.final_balances.sum(), 2000);
        assert_eq!(out_a.final_balances, out_b.final_balances);
        assert!(out_a.moves > 0);
    }

    #[test]
    fn strategy_rng_matches_ts_mulberry32_stream() {
        let mut strategy = QuantumPokerStrategy::new(1);
        assert_close(strategy.next_f64(), 0.62707394058816135);
        assert_close(strategy.next_f64(), 0.0027357211802154779);
        assert_close(strategy.next_f64(), 0.52744703995995224);
    }

    #[tokio::test]
    async fn abort_clears_cached_unconfirmed_commit_secrets() {
        let protocol = QuantumPoker::default();
        let state = protocol.initial_state(&ctx());
        let mut strategy = QuantumPokerStrategy::new(1);

        assert!(strategy
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await
            .is_some());
        assert!(strategy.has_cached_secrets_for_hand(state.hand_no));

        strategy.abort();

        assert!(!strategy.has_cached_secrets_for_hand(state.hand_no));
    }

    #[tokio::test]
    async fn betting_phase_uses_to_act_and_returns_legal_move() {
        let protocol = QuantumPoker::default();
        let mut state = protocol.initial_state(&ctx());
        state.phase = PokerPhase::PreflopBet;
        state.total_bet_a = ANTE;
        state.total_bet_b = ANTE + 20;
        state.street_bet_a = 0;
        state.street_bet_b = 20;
        state.to_act = Seat::A;
        let mut a = QuantumPokerStrategy::new(1);
        let mut b = QuantumPokerStrategy::new(2);

        assert!(b
            .plan_move(&state, Seat::B, &strategy_ctx(Seat::B))
            .await
            .is_none());
        let planned = a
            .plan_move(&state, Seat::A, &strategy_ctx(Seat::A))
            .await
            .expect("A should answer bet");
        let next = protocol.apply_move(&state, &planned, Seat::A).unwrap();

        assert_eq!(protocol.balances(&next).sum(), 2000);
    }

    #[tokio::test]
    async fn self_play_single_hand_reaches_done_or_cap_and_conserves_balances() {
        let protocol = QuantumPoker::new(1);
        let mut state = protocol.initial_state(&ctx());
        let mut a = QuantumPokerStrategy::new(1);
        let mut b = QuantumPokerStrategy::new(2);

        for _ in 0..128 {
            if protocol.is_terminal(&state) {
                break;
            }
            let planned_a = a.plan_move(&state, Seat::A, &strategy_ctx(Seat::A)).await;
            let planned_b = b.plan_move(&state, Seat::B, &strategy_ctx(Seat::B)).await;
            let (seat, mv) = match (planned_a, planned_b) {
                (Some(mv), _) => (Seat::A, mv),
                (None, Some(mv)) => (Seat::B, mv),
                (None, None) => panic!("expected at least one planned move"),
            };
            state = protocol.apply_move(&state, &mv, seat).unwrap();
            assert_eq!(protocol.balances(&state).sum(), 2000);
        }

        assert!(protocol.is_terminal(&state));
    }

    #[test]
    fn persona_tuning_matches_legacy_profile_deltas() {
        let tight = QuantumPokerBotProfile {
            name: "Nari",
            persona: QuantumPokerPersona::Tight,
            difficulty: QuantumPokerDifficulty::Adaptive,
            adaptive_modifier: 0.0,
        };
        let loose = QuantumPokerBotProfile {
            name: "Jules",
            persona: QuantumPokerPersona::Loose,
            difficulty: QuantumPokerDifficulty::Adaptive,
            adaptive_modifier: 0.0,
        };

        let tight = tight.strategy_tuning();
        let loose = loose.strategy_tuning();

        assert!(tight.call_threshold > 0.0);
        assert!(tight.raise_threshold > 0.0);
        assert!(loose.call_threshold < 0.0);
        assert!(loose.raise_threshold < 0.0);
    }

    #[test]
    fn persona_preflop_strength_matches_broadway_special_cases() {
        assert_close(preflop_strength(&[11, 10]), 0.705);
        assert_close(preflop_strength(&[11, 22]), 0.59);
        assert_close(preflop_strength(&[10, 9]), 0.615);
        assert_close(preflop_strength(&[10, 21]), 0.49);
    }

    #[test]
    fn persona_detects_strong_flush_and_straight_draws_only_before_river() {
        assert!(estimate_strong_draw(&[0, 2], &[4, 6, 20]));
        assert!(estimate_strong_draw(&[3, 4], &[5, 6, 20]));
        assert!(!estimate_strong_draw(&[0, 2], &[4, 20]));
        assert!(!estimate_strong_draw(&[0, 2], &[4, 6, 8, 20, 22]));
    }

    #[test]
    fn persona_draw_bet_sizing_uses_ts_pot_control_fraction() {
        let mut state = QuantumPoker::default().initial_state(&ctx());
        state.phase = PokerPhase::TurnBet;
        state.board = vec![0, 2, 4, 20];
        state.total_bet_a = 100;
        state.total_bet_b = 100;

        assert_eq!(persona_bet_amount(&state, 1000, 0.49, true), 90);
    }

    #[tokio::test]
    async fn persona_strategy_reuses_commit_reveal_and_can_complete_hand() {
        let protocol = QuantumPoker::new(1);
        let mut state = protocol.initial_state(&ctx());
        let mut a = QuantumPokerPersonaStrategy::new(1, QuantumPokerBotProfile::balanced("Vale"));
        let mut b = QuantumPokerPersonaStrategy::new(2, QuantumPokerBotProfile::loose("Jules"));

        for _ in 0..128 {
            if protocol.is_terminal(&state) {
                break;
            }
            let planned_a = a.plan_move(&state, Seat::A, &strategy_ctx(Seat::A)).await;
            let planned_b = b.plan_move(&state, Seat::B, &strategy_ctx(Seat::B)).await;
            let (seat, mv) = match (planned_a, planned_b) {
                (Some(mv), _) => (Seat::A, mv),
                (None, Some(mv)) => (Seat::B, mv),
                (None, None) => panic!("expected at least one planned move"),
            };
            state = protocol.apply_move(&state, &mv, seat).unwrap();
            assert_eq!(protocol.balances(&state).sum(), 2000);
        }

        assert!(protocol.is_terminal(&state));
    }

    fn assert_close(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() < 0.000_001,
            "expected {expected}, got {actual}"
        );
    }
}
