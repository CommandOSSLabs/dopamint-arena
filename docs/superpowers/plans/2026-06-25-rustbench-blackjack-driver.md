# rustbench Blackjack + Local/Offchain Match Driver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the loadbench blackjack path to Rust — the `BlackjackBetProtocol` state machine, the PvP `DistributedTunnel` per-move engine, the transport frame codec, an in-memory local channel, and a match driver — so a fixed-key match plays byte-and-signature-identically to the TS loadbench driver.

**Architecture:** Builds on the Plan 1 engine core (`tools/rustbench/src/engine/{wire,commitment,crypto,codec}.rs`). Adds the betting blackjack protocol, the frame envelope codec, the distributed tunnel (propose → co-sign → ack), a synchronous in-memory channel, and a `play_match` driver. Parity is proven by a whole-match golden captured from the real TS driver (143 moves, 75982 frame bytes, final balances 400/0, byte-identical settlement + ed25519 signatures).

**Tech Stack:** Rust 2021; `serde` + `serde_json` (frame envelope), plus the Plan 1 deps (`blake2`, `ed25519-dalek`, `hex`). Built `--release` (workspace `lto="thin"`, `codegen-units=1`).

## Global Constraints

- This plan ports the **betting** variant `BlackjackBetProtocol` (`frontend/src/games/blackjack/app/lib/bjBetProtocol.ts` + `bjCards.ts`) — the protocol loadbench's `--game blackjack` actually drives via `GAME_KITS["blackjack"]` — NOT the SDK's simpler `protocol/blackjack.ts`.
- **Byte-exactness is the contract** (carried from Plan 1). State encoding, frame JSON, and signed messages must be byte-identical to the TS. The whole-match golden in Task 6 is the gate.
- Protocol domain tag: `b"sui_tunnel::proto::blackjack.bet.v1"` (= `protocolDomain("blackjack.bet.v1")`, the literal `sui_tunnel::proto::` prefix + name). 35 bytes.
- Phase codes in `encodeState`: `round_over=0, player=1, dealer=2`.
- Constants: `MIN_BET=25`, `BET_OPTIONS=[25,100,500,1000]`, `DEALER_STANDS_AT=17`, `BUST_AT=21`, `ROUND_CAP=1000`.
- Player-seat rotation (`getPlayerParty`): `floor((round-1)/2) % 2 == 0 ? A : B`. The kit uses the default rotation (NOT `FIXED_PLAYER_A`).
- The bench bot is loadbench's `BlackjackBot.plan` (bet = first `BET_OPTIONS` entry that fits = always 25 when affordable; player hits while `handValue < 17` else stands; dealer stands), NOT the protocol's `randomMove`.
- All u64 fields are 8-byte big-endian (use Plan 1's `engine::codec::u64_to_be_bytes`). Card values are stored as `u8`.
- ed25519 signing is deterministic; fixed 32-byte seeds give reproducible signatures. Seat keys for the golden: A = bytes `0x01..0x20`, B = bytes `0x21..0x40` (same as Plan 1; PK_A=`79b5562e…`, PK_B=`e7f162a1…`).
- The frame codec must be byte-identical to `distributedFrame.ts::encodeFrame`: compact JSON, field order `kind,nonce,by,move,timestamp,stateHash,partyABalance,partyBBalance,sigProposer` (move) / `kind,nonce,sigResponder` (ack); u64 fields as decimal strings; `stateHash`/sig fields lowercase hex; `move` nested as `{"action":...}` with `amount` a JSON number for bets.
- Do not touch `backend/`, `sui-tunnel-ts/`, `frontend/`, or `tools/loadbench/`. All work is under `tools/rustbench/`.

---

### Task 1: Blackjack bet protocol — state machine + card stream + encodeState

**Files:**
- Create: `tools/rustbench/src/game/mod.rs`
- Create: `tools/rustbench/src/game/blackjack.rs`
- Modify: `tools/rustbench/src/lib.rs` (add `pub mod game;`)
- Test: in-file `#[cfg(test)]` in `blackjack.rs`.

**Interfaces:**
- Consumes: `engine::crypto::blake2b256`, `engine::codec::u64_to_be_bytes`.
- Produces:
  - `#[derive(Clone)] pub struct BjState { pub phase: Phase, pub round: u64, pub draw_index: u64, pub player_hand: Vec<u8>, pub dealer_hand: Vec<u8>, pub balance_a: u64, pub balance_b: u64, pub total: u64, pub bet: u64 }`
  - `#[derive(Clone, Copy, PartialEq)] pub enum Phase { RoundOver, Player, Dealer }`
  - `#[derive(Clone, Copy)] pub enum Party { A, B }`
  - `#[derive(Clone, Copy)] pub enum BjMove { Bet { amount: u64 }, Hit, Stand }`
  - `pub fn player_party(round: u64) -> Party`, `pub fn dealer_party(round: u64) -> Party`
  - `pub fn actor_for(s: &BjState) -> Party`
  - `pub fn hand_value(hand: &[u8]) -> u32`
  - `pub fn initial_state(balance_a: u64, balance_b: u64) -> BjState`
  - `pub fn apply_move(s: &BjState, mv: BjMove, by: Party) -> Result<BjState, String>`
  - `pub fn encode_state(s: &BjState) -> Vec<u8>`
  - `pub fn is_terminal(s: &BjState) -> bool`
  - `pub fn max_bet(s: &BjState) -> u64`
  - `pub const MIN_BET: u64 = 25;`

- [ ] **Step 1: Write the failing tests (golden vectors captured from the TS protocol)**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::crypto::blake2b256;

    // tunnelId/keys are irrelevant to the protocol; balances 200/200.
    #[test]
    fn initial_state_encodes_to_golden() {
        let s = initial_state(200, 200);
        assert_eq!(hex::encode(encode_state(&s)),
            "7375695f74756e6e656c3a3a70726f746f3a3a626c61636b6a61636b2e6265742e763100000000000000c800000000000000c80000000000000000000000000000000000000000000000000000000000000000000000000000000000");
        assert_eq!(hex::encode(blake2b256(&encode_state(&s))),
            "9af0532be79ef5264245875dacee60321f2d1ae4c1920cf37eb841d8e2da68eb");
    }

    #[test]
    fn first_round_deal_matches_golden() {
        // round_over -> player A bets 25 -> deal round 1.
        let s = initial_state(200, 200);
        let s1 = apply_move(&s, BjMove::Bet { amount: 25 }, Party::A).unwrap();
        assert_eq!(s1.player_hand, vec![10, 7]);
        assert_eq!(s1.dealer_hand, vec![10, 3]);
        assert_eq!(s1.draw_index, 4);
        assert!(matches!(s1.phase, Phase::Player));
        assert_eq!(s1.bet, 25);
        assert_eq!(hex::encode(encode_state(&s1)),
            "7375695f74756e6e656c3a3a70726f746f3a3a626c61636b6a61636b2e6265742e763100000000000000c800000000000000c80000000000000001000000000000000401000000000000001900000000000000020a0700000000000000020a03");
        assert_eq!(hex::encode(blake2b256(&encode_state(&s1))),
            "c217301ef203ccbe2a1f946e6a420cd8a7853cace315bfc9adca56d7162d9219");
    }

    #[test]
    fn hand_value_soft_ace() {
        assert_eq!(hand_value(&[11, 7]), 18);     // soft 18
        assert_eq!(hand_value(&[11, 7, 10]), 18); // ace downgraded once: 1+7+10
        assert_eq!(hand_value(&[10, 3]), 13);
    }

    #[test]
    fn balances_always_sum_to_total() {
        // Play a full match's worth of moves via basic strategy; sum is invariant.
        let mut s = initial_state(200, 200);
        for _ in 0..400 {
            if is_terminal(&s) { break; }
            let by = actor_for(&s);
            let mv = match s.phase {
                Phase::RoundOver => BjMove::Bet { amount: 25 },
                Phase::Player => if hand_value(&s.player_hand) < 17 { BjMove::Hit } else { BjMove::Stand },
                Phase::Dealer => BjMove::Stand,
            };
            s = apply_move(&s, mv, by).unwrap();
            assert_eq!(s.balance_a + s.balance_b, 400);
        }
        assert!(is_terminal(&s));
    }

    #[test]
    fn wrong_turn_is_rejected() {
        let s = initial_state(200, 200);
        // round 1 player is A; B may not bet.
        assert!(apply_move(&s, BjMove::Bet { amount: 25 }, Party::B).is_err());
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p rustbench blackjack`
Expected: FAIL (module not defined).

- [ ] **Step 3: Create `game/mod.rs` and register the module**

`tools/rustbench/src/game/mod.rs`:
```rust
//! Game protocols ported byte-exact from the loadbench kits.
pub mod blackjack;
```

In `tools/rustbench/src/lib.rs`, add after `pub mod engine;`:
```rust
pub mod game;
```

- [ ] **Step 4: Write `game/blackjack.rs` (port of `bjBetProtocol.ts` + `bjCards.ts`)**

```rust
//! Variable-bet player-vs-dealer Blackjack, byte-exact with
//! `frontend/src/games/blackjack/app/lib/bjBetProtocol.ts`. Dealerless: every card
//! comes from a deterministic per-round byte stream, so both seats (and an on-chain
//! replay of `encode_state`) agree on the cards. Party A = player, B = dealer, with a
//! 2-round rotation of the player role.

use crate::engine::codec::u64_to_be_bytes;
use crate::engine::crypto::blake2b256;

pub const MIN_BET: u64 = 25;
pub const BET_OPTIONS: [u64; 4] = [25, 100, 500, 1000];
const DEALER_STANDS_AT: u32 = 17;
const BUST_AT: u32 = 21;
const ROUND_CAP: u64 = 1000;

/// `protocolDomain("blackjack.bet.v1")` = `sui_tunnel::proto::` + name.
const DOMAIN: &[u8] = b"sui_tunnel::proto::blackjack.bet.v1";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Phase { RoundOver, Player, Dealer }

impl Phase {
    fn code(self) -> u8 {
        match self { Phase::RoundOver => 0, Phase::Player => 1, Phase::Dealer => 2 }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Party { A, B }

impl Party {
    pub fn other(self) -> Party { match self { Party::A => Party::B, Party::B => Party::A } }
}

#[derive(Clone, Copy, Debug)]
pub enum BjMove { Bet { amount: u64 }, Hit, Stand }

#[derive(Clone, Debug)]
pub struct BjState {
    pub phase: Phase,
    pub round: u64,
    pub draw_index: u64,
    pub player_hand: Vec<u8>,
    pub dealer_hand: Vec<u8>,
    pub balance_a: u64,
    pub balance_b: u64,
    pub total: u64,
    pub bet: u64,
}

/// Seat holding the PLAYER role in `round` (1-based). Swaps every two rounds.
pub fn player_party(round: u64) -> Party {
    // round - 1, then floor(/2) % 2; round 0 is treated like the TS Number(round)-1 = -1
    // path only via actor_for(round+1), so round >= 1 here in practice.
    let r = (round as i64) - 1;
    if (r.div_euclid(2)) % 2 == 0 { Party::A } else { Party::B }
}

pub fn dealer_party(round: u64) -> Party { player_party(round).other() }

/// The seat the protocol expects to act next. In `round_over` the NEXT round's player bets.
pub fn actor_for(s: &BjState) -> Party {
    match s.phase {
        Phase::Player => player_party(s.round),
        Phase::Dealer => dealer_party(s.round),
        Phase::RoundOver => player_party(s.round + 1),
    }
}

/// Deterministic card stream: `seed = blake2b256(DOMAIN || u64be(round))`, one byte per
/// draw, advancing a fresh digest every 32 draws via `blake2b256(digest || u64be(block))`.
fn draw_rank(round: u64, draw_index: u64) -> u8 {
    let mut buf = Vec::with_capacity(DOMAIN.len() + 8);
    buf.extend_from_slice(DOMAIN);
    buf.extend_from_slice(&u64_to_be_bytes(round));
    let mut digest = blake2b256(&buf);
    let idx = draw_index as usize;
    let block = idx / 32;
    for b in 0..block {
        let mut next = Vec::with_capacity(32 + 8);
        next.extend_from_slice(&digest);
        next.extend_from_slice(&u64_to_be_bytes(b as u64));
        digest = blake2b256(&next);
    }
    (digest[idx % 32] % 13) + 1
}

/// Map a rank (1..13) to its blackjack value (Ace = 11; downgraded later).
fn rank_value(rank: u8) -> u8 {
    if rank == 1 { 11 } else if rank >= 11 { 10 } else { rank }
}

/// Hand total with soft-ace handling: downgrade an 11 to 1 per ace while busting.
pub fn hand_value(hand: &[u8]) -> u32 {
    let mut total: u32 = 0;
    let mut aces: u32 = 0;
    for &v in hand {
        total += v as u32;
        if v == 11 { aces += 1; }
    }
    while total > BUST_AT && aces > 0 { total -= 10; aces -= 1; }
    total
}

fn is_bust(hand: &[u8]) -> bool { hand_value(hand) > BUST_AT }

/// Largest bet both sides can cover this round.
pub fn max_bet(s: &BjState) -> u64 { s.balance_a.min(s.balance_b) }

pub fn initial_state(balance_a: u64, balance_b: u64) -> BjState {
    BjState {
        phase: Phase::RoundOver,
        round: 0,
        draw_index: 0,
        player_hand: Vec::new(),
        dealer_hand: Vec::new(),
        balance_a,
        balance_b,
        total: balance_a + balance_b,
        bet: 0,
    }
}

pub fn is_terminal(s: &BjState) -> bool {
    s.round >= ROUND_CAP || (s.phase == Phase::RoundOver && max_bet(s) < MIN_BET)
}

fn draw_to(hand: &mut Vec<u8>, round: u64, draw_index: u64) -> u64 {
    hand.push(rank_value(draw_rank(round, draw_index)));
    draw_index + 1
}

fn deal_round(s: &BjState, bet: u64) -> BjState {
    let round = s.round + 1;
    let mut draw_index = 0u64;
    let mut player_hand = Vec::new();
    let mut dealer_hand = Vec::new();
    for _ in 0..2 { draw_index = draw_to(&mut player_hand, round, draw_index); }
    for _ in 0..2 { draw_index = draw_to(&mut dealer_hand, round, draw_index); }
    BjState { phase: Phase::Player, round, draw_index, player_hand, dealer_hand, bet, ..s.clone() }
}

fn resolve_dealer(s: &BjState) -> BjState {
    let mut hand = s.dealer_hand.clone();
    let mut draw_index = s.draw_index;
    while hand_value(&hand) < DEALER_STANDS_AT {
        draw_index = draw_to(&mut hand, s.round, draw_index);
    }
    let mut resolved = s.clone();
    resolved.dealer_hand = hand;
    resolved.draw_index = draw_index;
    let pv = hand_value(&resolved.player_hand);
    let dv = hand_value(&resolved.dealer_hand);
    let player = player_party(s.round);
    let dealer = player.other();
    let winner = if is_bust(&resolved.dealer_hand) {
        Some(player)
    } else if pv > dv {
        Some(player)
    } else if dv > pv {
        Some(dealer)
    } else {
        None
    };
    settle(&resolved, winner)
}

fn settle(s: &BjState, winner: Option<Party>) -> BjState {
    let mut balance_a = s.balance_a;
    let mut balance_b = s.balance_b;
    match winner {
        Some(Party::A) => { let amt = s.bet.min(balance_b); balance_a += amt; balance_b -= amt; }
        Some(Party::B) => { let amt = s.bet.min(balance_a); balance_b += amt; balance_a -= amt; }
        None => {}
    }
    BjState { phase: Phase::RoundOver, balance_a, balance_b, ..s.clone() }
}

pub fn apply_move(s: &BjState, mv: BjMove, by: Party) -> Result<BjState, String> {
    match s.phase {
        Phase::RoundOver => {
            let BjMove::Bet { amount } = mv else { return Err("place a bet to start the round".into()); };
            let next_player = player_party(s.round + 1);
            if by != next_player { return Err(format!("only the player ({next_player:?}) sets the bet")); }
            if is_terminal(s) { return Err("game over: a side cannot fund another bet".into()); }
            let cap = max_bet(s);
            if amount < MIN_BET || amount > cap { return Err(format!("bet must be {MIN_BET}..{cap}")); }
            Ok(deal_round(s, amount))
        }
        Phase::Player => {
            if by != player_party(s.round) { return Err("not the player's turn".into()); }
            match mv {
                BjMove::Hit => {
                    let mut next = s.clone();
                    next.draw_index = draw_to(&mut next.player_hand, s.round, s.draw_index);
                    if is_bust(&next.player_hand) { Ok(settle(&next, Some(dealer_party(s.round)))) } else { Ok(next) }
                }
                BjMove::Stand => Ok(BjState { phase: Phase::Dealer, ..s.clone() }),
                BjMove::Bet { .. } => Err("invalid player action".into()),
            }
        }
        Phase::Dealer => {
            if by != dealer_party(s.round) { return Err("not the dealer's turn".into()); }
            match mv {
                BjMove::Stand => Ok(resolve_dealer(s)),
                _ => Err("the dealer only stands (auto-play)".into()),
            }
        }
    }
}

/// Byte-exact with `bjBetProtocol.ts::encodeState`.
pub fn encode_state(s: &BjState) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(DOMAIN);
    out.extend_from_slice(&u64_to_be_bytes(s.balance_a));
    out.extend_from_slice(&u64_to_be_bytes(s.balance_b));
    out.extend_from_slice(&u64_to_be_bytes(s.round));
    out.extend_from_slice(&u64_to_be_bytes(s.draw_index));
    out.push(s.phase.code());
    out.extend_from_slice(&u64_to_be_bytes(s.bet));
    out.extend_from_slice(&u64_to_be_bytes(s.player_hand.len() as u64));
    out.extend_from_slice(&s.player_hand);
    out.extend_from_slice(&u64_to_be_bytes(s.dealer_hand.len() as u64));
    out.extend_from_slice(&s.dealer_hand);
    out
}
```

Note on `deal_round`/`settle` struct-update syntax: the explicitly-set fields must come BEFORE `..s.clone()`; the fields shown override the clone. Verify `cargo build` accepts the field order (Rust requires the spread last, which the code above satisfies).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p rustbench blackjack`
Expected: PASS (5 tests). If `first_round_deal_matches_golden` fails on the hands or hash, the card stream or `encode_state` diverged — fix the port, never the vector.

- [ ] **Step 6: Clippy + commit**

```bash
cargo clippy -p rustbench -- -D warnings
git add tools/rustbench/src/game tools/rustbench/src/lib.rs
git commit -m "feat(rustbench): port blackjack bet protocol"
```

---

### Task 2: Bench bot strategy + turn rotation

**Files:**
- Modify: `tools/rustbench/src/game/blackjack.rs` (append a `bot` submodule + `plan` fn)
- Test: in-file `#[cfg(test)]`.

**Interfaces:**
- Consumes: `BjState, BjMove, Party, Phase, player_party, dealer_party, actor_for, hand_value, is_terminal, max_bet, MIN_BET, BET_OPTIONS`.
- Produces: `pub fn plan(s: &BjState, seat: Party) -> Option<BjMove>` — the loadbench `BlackjackBot.plan` (returns `None` when it is not `seat`'s turn).

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod bot_tests {
    use super::*;

    #[test]
    fn round_over_player_bets_min_option() {
        let s = initial_state(200, 200);
        // round 1 player is A; A bets 25 (first BET_OPTIONS entry that fits).
        assert!(matches!(plan(&s, Party::A), Some(BjMove::Bet { amount: 25 })));
        // B is not the next player -> None.
        assert!(plan(&s, Party::B).is_none());
    }

    #[test]
    fn player_hits_below_17_then_stands() {
        let s = initial_state(200, 200);
        let s1 = apply_move(&s, BjMove::Bet { amount: 25 }, Party::A).unwrap();
        // player hand [10,7] = 17 -> stand; dealer's seat plans None here.
        assert!(matches!(plan(&s1, Party::A), Some(BjMove::Stand)));
        assert!(plan(&s1, Party::B).is_none());
    }

    #[test]
    fn dealer_only_stands() {
        let mut s = initial_state(200, 200);
        s = apply_move(&s, BjMove::Bet { amount: 25 }, Party::A).unwrap();
        s = apply_move(&s, BjMove::Stand, Party::A).unwrap(); // -> dealer phase
        let dealer = dealer_party(s.round);
        assert!(matches!(plan(&s, dealer), Some(BjMove::Stand)));
        assert!(plan(&s, dealer.other()).is_none());
    }
}
```

- [ ] **Step 2: Run to verify fail**

Run: `cargo test -p rustbench bot_tests`
Expected: FAIL (`plan` not defined).

- [ ] **Step 3: Implement `plan` (append to `blackjack.rs`, outside the existing `tests` modules)**

```rust
/// loadbench `BlackjackBot.plan`: deterministic basic strategy. Returns `None` when it
/// is not `seat`'s turn. Bet = the first `BET_OPTIONS` entry within `[MIN_BET, max_bet]`
/// (always 25 when affordable); player hits while `hand_value < 17`, else stands; dealer
/// stands. Mirrors `frontend/src/agent/games/blackjack/kit.ts::BlackjackBot`.
pub fn plan(s: &BjState, seat: Party) -> Option<BjMove> {
    if is_terminal(s) { return None; }
    if actor_for(s) != seat { return None; }
    match s.phase {
        Phase::RoundOver => {
            let cap = max_bet(s);
            let amount = BET_OPTIONS.iter().copied().find(|&o| o >= MIN_BET && o <= cap).unwrap_or(MIN_BET);
            // fixedBetMove clamps to [MIN_BET, cap]; amount is already in range when cap >= MIN_BET.
            let amount = amount.clamp(MIN_BET, cap);
            Some(BjMove::Bet { amount })
        }
        Phase::Player => {
            if seat != player_party(s.round) { return None; }
            Some(if hand_value(&s.player_hand) < 17 { BjMove::Hit } else { BjMove::Stand })
        }
        Phase::Dealer => {
            if seat != dealer_party(s.round) { return None; }
            Some(BjMove::Stand)
        }
    }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p rustbench bot_tests`
Expected: PASS (3 tests).

- [ ] **Step 5: Clippy + commit**

```bash
cargo clippy -p rustbench -- -D warnings
git add tools/rustbench/src/game/blackjack.rs
git commit -m "feat(rustbench): port blackjack bench bot strategy"
```

---

### Task 3: Transport frame codec (byte-identical JSON envelope)

**Files:**
- Create: `tools/rustbench/src/engine/frame.rs`
- Modify: `tools/rustbench/src/engine/mod.rs` (add `pub mod frame;`)
- Modify: `tools/rustbench/Cargo.toml` (add `serde_json`)
- Modify: root `Cargo.toml` (`serde_json` to `[workspace.dependencies]` only if absent — it is already present)
- Test: in-file `#[cfg(test)]`.

**Interfaces:**
- Consumes: `game::blackjack::{BjMove, Party}`.
- Produces:
  - `pub enum Frame { Move(MoveFrame), Ack(AckFrame) }`
  - `pub struct MoveFrame { pub nonce: u64, pub by: Party, pub mv: BjMove, pub timestamp: u64, pub state_hash: [u8;32], pub party_a_balance: u64, pub party_b_balance: u64, pub sig_proposer: [u8;64] }`
  - `pub struct AckFrame { pub nonce: u64, pub sig_responder: [u8;64] }`
  - `pub fn encode_frame(f: &Frame) -> Vec<u8>`
  - `pub fn decode_frame(bytes: &[u8]) -> Result<Frame, String>`

- [ ] **Step 1: Add deps**

In `tools/rustbench/Cargo.toml` `[dependencies]` (the codec uses `serde_json::Value` for decode and hand-built JSON for encode — no `serde` derive needed):
```toml
serde_json = { workspace = true }
```
`serde_json = "1.0"` already appears in the root `[workspace.dependencies]`, so no root change is needed. Confirm it is present before relying on `workspace = true`.

- [ ] **Step 2: Write the failing test (exact JSON bytes)**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::blackjack::{BjMove, Party};

    #[test]
    fn move_frame_encodes_to_exact_json() {
        let f = Frame::Move(MoveFrame {
            nonce: 1, by: Party::A, mv: BjMove::Bet { amount: 25 }, timestamp: 1234567890,
            state_hash: std::array::from_fn(|i| (i + 1) as u8),
            party_a_balance: 200, party_b_balance: 200,
            sig_proposer: [0xab; 64],
        });
        let json = String::from_utf8(encode_frame(&f)).unwrap();
        let expected = format!(
            "{{\"kind\":\"move\",\"nonce\":\"1\",\"by\":\"A\",\"move\":{{\"action\":\"bet\",\"amount\":25}},\"timestamp\":\"1234567890\",\"stateHash\":\"{}\",\"partyABalance\":\"200\",\"partyBBalance\":\"200\",\"sigProposer\":\"{}\"}}",
            hex::encode((1u8..=32).collect::<Vec<u8>>()),
            hex::encode([0xab; 64]),
        );
        assert_eq!(json, expected);
    }

    #[test]
    fn hit_move_has_no_amount_field() {
        let f = Frame::Move(MoveFrame {
            nonce: 2, by: Party::B, mv: BjMove::Hit, timestamp: 0,
            state_hash: [0; 32], party_a_balance: 1, party_b_balance: 2, sig_proposer: [0; 64],
        });
        let json = String::from_utf8(encode_frame(&f)).unwrap();
        assert!(json.contains("\"move\":{\"action\":\"hit\"}"));
        assert!(!json.contains("amount"));
    }

    #[test]
    fn ack_frame_round_trips() {
        let f = Frame::Ack(AckFrame { nonce: 7, sig_responder: [0xcd; 64] });
        let bytes = encode_frame(&f);
        assert_eq!(String::from_utf8(bytes.clone()).unwrap(),
            format!("{{\"kind\":\"ack\",\"nonce\":\"7\",\"sigResponder\":\"{}\"}}", hex::encode([0xcd; 64])));
        match decode_frame(&bytes).unwrap() {
            Frame::Ack(a) => { assert_eq!(a.nonce, 7); assert_eq!(a.sig_responder, [0xcd; 64]); }
            _ => panic!("expected ack"),
        }
    }

    #[test]
    fn move_frame_round_trips() {
        let f = Frame::Move(MoveFrame {
            nonce: 9, by: Party::A, mv: BjMove::Stand, timestamp: 5,
            state_hash: std::array::from_fn(|i| i as u8),
            party_a_balance: 10, party_b_balance: 20, sig_proposer: [1; 64],
        });
        let bytes = encode_frame(&f);
        match decode_frame(&bytes).unwrap() {
            Frame::Move(m) => {
                assert_eq!(m.nonce, 9);
                assert!(matches!(m.by, Party::A));
                assert!(matches!(m.mv, BjMove::Stand));
                assert_eq!(m.party_b_balance, 20);
            }
            _ => panic!("expected move"),
        }
    }
}
```

- [ ] **Step 3: Implement the codec (manual serde to guarantee field order + string-typed u64s)**

```rust
//! The two PvP wire frames and their JSON envelope codec — byte-identical to
//! `sui-tunnel-ts/src/core/distributedFrame.ts::encodeFrame`. u64 fields are decimal
//! strings; hashes/signatures are lowercase hex; `move` nests as `{"action":...}` with
//! `amount` a JSON number for bets. The SIGNED state-update bytes are produced separately
//! by `engine::wire::serialize_state_update`; this codec is only the transport envelope.

use crate::game::blackjack::{BjMove, Party};

pub struct MoveFrame {
    pub nonce: u64,
    pub by: Party,
    pub mv: BjMove,
    pub timestamp: u64,
    pub state_hash: [u8; 32],
    pub party_a_balance: u64,
    pub party_b_balance: u64,
    pub sig_proposer: [u8; 64],
}

pub struct AckFrame {
    pub nonce: u64,
    pub sig_responder: [u8; 64],
}

pub enum Frame { Move(MoveFrame), Ack(AckFrame) }

fn party_str(p: Party) -> &'static str { match p { Party::A => "A", Party::B => "B" } }

fn move_json(mv: &BjMove) -> String {
    match mv {
        BjMove::Bet { amount } => format!("{{\"action\":\"bet\",\"amount\":{amount}}}"),
        BjMove::Hit => "{\"action\":\"hit\"}".to_string(),
        BjMove::Stand => "{\"action\":\"stand\"}".to_string(),
    }
}

/// Compact JSON, field order identical to the TS `encodeFrame`. Built by hand (not derived)
/// so the exact key order and string/number typing are guaranteed.
pub fn encode_frame(f: &Frame) -> Vec<u8> {
    match f {
        Frame::Move(m) => format!(
            "{{\"kind\":\"move\",\"nonce\":\"{}\",\"by\":\"{}\",\"move\":{},\"timestamp\":\"{}\",\"stateHash\":\"{}\",\"partyABalance\":\"{}\",\"partyBBalance\":\"{}\",\"sigProposer\":\"{}\"}}",
            m.nonce, party_str(m.by), move_json(&m.mv), m.timestamp,
            hex::encode(m.state_hash), m.party_a_balance, m.party_b_balance, hex::encode(m.sig_proposer),
        ).into_bytes(),
        Frame::Ack(a) => format!(
            "{{\"kind\":\"ack\",\"nonce\":\"{}\",\"sigResponder\":\"{}\"}}",
            a.nonce, hex::encode(a.sig_responder),
        ).into_bytes(),
    }
}

/// Parse a frame. Uses serde_json's Value for tolerance (key order irrelevant on decode).
pub fn decode_frame(bytes: &[u8]) -> Result<Frame, String> {
    let v: serde_json::Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    let kind = v.get("kind").and_then(|k| k.as_str()).ok_or("missing kind")?;
    let nonce: u64 = v.get("nonce").and_then(|n| n.as_str()).ok_or("missing nonce")?.parse().map_err(|_| "bad nonce")?;
    match kind {
        "ack" => {
            let sig = parse_sig64(v.get("sigResponder").and_then(|s| s.as_str()).ok_or("missing sigResponder")?)?;
            Ok(Frame::Ack(AckFrame { nonce, sig_responder: sig }))
        }
        "move" => {
            let by = match v.get("by").and_then(|b| b.as_str()).ok_or("missing by")? {
                "A" => Party::A, "B" => Party::B, other => return Err(format!("bad party {other}")),
            };
            let mv_obj = v.get("move").ok_or("missing move")?;
            let action = mv_obj.get("action").and_then(|a| a.as_str()).ok_or("missing action")?;
            let mv = match action {
                "bet" => BjMove::Bet { amount: mv_obj.get("amount").and_then(|a| a.as_u64()).ok_or("missing amount")? },
                "hit" => BjMove::Hit,
                "stand" => BjMove::Stand,
                other => return Err(format!("bad action {other}")),
            };
            let timestamp: u64 = v.get("timestamp").and_then(|t| t.as_str()).ok_or("missing timestamp")?.parse().map_err(|_| "bad timestamp")?;
            let state_hash = parse_hash32(v.get("stateHash").and_then(|s| s.as_str()).ok_or("missing stateHash")?)?;
            let party_a_balance: u64 = v.get("partyABalance").and_then(|s| s.as_str()).ok_or("missing partyABalance")?.parse().map_err(|_| "bad balA")?;
            let party_b_balance: u64 = v.get("partyBBalance").and_then(|s| s.as_str()).ok_or("missing partyBBalance")?.parse().map_err(|_| "bad balB")?;
            let sig_proposer = parse_sig64(v.get("sigProposer").and_then(|s| s.as_str()).ok_or("missing sigProposer")?)?;
            Ok(Frame::Move(MoveFrame { nonce, by, mv, timestamp, state_hash, party_a_balance, party_b_balance, sig_proposer }))
        }
        other => Err(format!("unknown frame kind: {other}")),
    }
}

fn parse_hash32(s: &str) -> Result<[u8; 32], String> {
    let mut out = [0u8; 32];
    hex::decode_to_slice(s, &mut out).map_err(|e| e.to_string())?;
    Ok(out)
}

fn parse_sig64(s: &str) -> Result<[u8; 64], String> {
    let mut out = [0u8; 64];
    hex::decode_to_slice(s, &mut out).map_err(|e| e.to_string())?;
    Ok(out)
}
```

Add `pub mod frame;` to `engine/mod.rs`. The helpers `parse_hash32`/`parse_sig64` are defined inline at the bottom of the file.

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p rustbench frame`
Expected: PASS (4 tests).

- [ ] **Step 5: Clippy + commit**

```bash
cargo clippy -p rustbench -- -D warnings
git add tools/rustbench/src/engine/frame.rs tools/rustbench/src/engine/mod.rs tools/rustbench/Cargo.toml Cargo.toml
git commit -m "feat(rustbench): byte-exact transport frame codec"
```

---

### Task 4: PartyEndpoint + DistributedTunnel engine

**Files:**
- Create: `tools/rustbench/src/engine/tunnel.rs`
- Modify: `tools/rustbench/src/engine/mod.rs` (add `pub mod tunnel;`)
- Test: in-file `#[cfg(test)]`.

**Interfaces:**
- Consumes: `engine::crypto::{KeyPair, keypair_from_secret, verify}`, `engine::wire::{StateUpdate, Settlement, serialize_state_update, serialize_settlement_with_root}`, `engine::frame::{Frame, MoveFrame, AckFrame, encode_frame, decode_frame}`, `engine::commitment` (unused here), `game::blackjack::{BjState, BjMove, Party, apply_move, encode_state}`, `engine::crypto::blake2b256`.
- Produces:
  - `pub struct Endpoint { pub public_key: [u8;32], signing: Option<KeyPair> }` with `pub fn controlled(secret:&[u8;32])->Endpoint`, `pub fn observer(public_key:[u8;32])->Endpoint`, `fn sign(&self,&[u8])->[u8;64]`, `fn verify(&self,&[u8],&[u8;64])->bool`.
  - `pub struct DistTunnel { ... }` with:
    - `pub fn new(tunnel_id:&str, self_party:Party, self_ep:Endpoint, opp_ep:Endpoint, balance_a:u64, balance_b:u64) -> DistTunnel`
    - `pub fn state(&self) -> &BjState`
    - `pub fn is_terminal(&self) -> bool`
    - `pub fn propose(&mut self, mv: BjMove, timestamp: u64) -> Vec<Vec<u8>>` — returns encoded frames to send to the opponent (one MOVE frame).
    - `pub fn handle_frame(&mut self, bytes: &[u8]) -> Vec<Vec<u8>>` — process an inbound frame; returns encoded frames to send back (an ACK for a MOVE; nothing for an ACK).
    - `pub fn build_settlement_half_with_root(&self, timestamp:u64, root:&[u8;32], onchain_nonce:u64) -> (Settlement, [u8;64])`
    - `pub fn combine_settlement_with_root(&self, settlement:&Settlement, root:&[u8;32], sig_self:&[u8;64], sig_other:&[u8;64]) -> Result<([u8;64],[u8;64]), String>` — returns `(sig_a, sig_b)` placed by side, verifying the opponent's half over the with-root bytes.

**Design note (faithful but pull-based):** the TS `DistributedTunnel` pushes via `transport.send` + `onFrame` callbacks. This port uses a **pull** API (`propose`/`handle_frame` return the frames to send) — the produced wire bytes and signatures are identical, but the driver (Task 5) pumps frames explicitly instead of through callbacks. This is simpler to make deterministic and is exactly what the relay loop (a later plan) will drive.

- [ ] **Step 1: Write the failing test (one move co-signs and both seats advance)**

```rust
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
```

- [ ] **Step 2: Run to verify fail**

Run: `cargo test -p rustbench tunnel`
Expected: FAIL (types not defined).

- [ ] **Step 3: Implement `engine/tunnel.rs` (port of `distributedTunnel.ts`)**

```rust
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
```

Note: `serialize_settlement_with_root` from Plan 1 takes `(&Settlement, &[u8;32])`. The `Settlement` struct (Plan 1) has fields `tunnel_id, party_a_balance, party_b_balance, final_nonce, timestamp`. `Party` and `BjMove` derive `Copy` (Task 1), so `frame.by`/`mv` copy into the frame without a borrow conflict.

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p rustbench tunnel`
Expected: PASS. Fix compile errors (e.g. `Copy` bounds, borrow of `self.self_ep` while mutating `self.state` — reorder so signing happens before the `self.state = next` assignment, as written).

- [ ] **Step 5: Clippy + commit**

```bash
cargo clippy -p rustbench -- -D warnings
git add tools/rustbench/src/engine/tunnel.rs tools/rustbench/src/engine/mod.rs
git commit -m "feat(rustbench): distributed tunnel co-sign engine"
```

---

### Task 5: Local channel + match driver

**Files:**
- Create: `tools/rustbench/src/driver.rs`
- Modify: `tools/rustbench/src/lib.rs` (add `pub mod driver;`)
- Test: in-file `#[cfg(test)]` (light — the heavy parity check is Task 6).

**Interfaces:**
- Consumes: `engine::tunnel::{DistTunnel, Endpoint}`, `engine::crypto::{keypair_from_secret, blake2b256}`, `engine::wire::Settlement`, `game::blackjack::{Party, plan, player_party}`.
- Produces:
  - `pub struct MatchResult { pub moves: u64, pub bytes: usize, pub final_balance_a: u64, pub final_balance_b: u64, pub settlement: Settlement, pub sig_a: [u8;64], pub sig_b: [u8;64] }`
  - `pub fn play_fixed_match(tunnel_id:&str, secret_a:&[u8;32], secret_b:&[u8;32], balance_a:u64, balance_b:u64, created_at:u64, max_moves:u64) -> MatchResult`

- [ ] **Step 1: Write the failing test (smoke — match runs and conserves balances)**

```rust
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
```

- [ ] **Step 2: Run to verify fail**

Run: `cargo test -p rustbench driver`
Expected: FAIL (`play_fixed_match` not defined).

- [ ] **Step 3: Implement `driver.rs` (port of `match.ts::playMatch`)**

```rust
//! Channel-agnostic match driver. Replicates `tools/loadbench/src/match.ts::playMatch`:
//! two seats with a synchronous in-memory channel, basic-strategy bots, then a root-anchored
//! cooperative settlement (`root = blake2b256("dopamint:" + tunnelId)`).

use crate::engine::crypto::blake2b256;
use crate::engine::tunnel::{DistTunnel, Endpoint};
use crate::engine::crypto::keypair_from_secret;
use crate::engine::wire::Settlement;
use crate::game::blackjack::{is_terminal, plan, Party};

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
        for f in &to_responder { bytes += f.len(); to_proposer.extend(responder.handle_frame(f)); }
        if to_proposer.is_empty() { break; }
        let mut next_to_responder = Vec::new();
        for f in &to_proposer { bytes += f.len(); next_to_responder.extend(proposer.handle_frame(f)); }
        if next_to_responder.is_empty() { break; }
        to_responder = next_to_responder;
    }
    bytes
}

pub fn play_fixed_match(tunnel_id: &str, secret_a: &[u8; 32], secret_b: &[u8; 32], balance_a: u64, balance_b: u64, created_at: u64, max_moves: u64) -> MatchResult {
    let pka = keypair_from_secret(secret_a).public_key();
    let pkb = keypair_from_secret(secret_b).public_key();
    let mut dt_a = DistTunnel::new(tunnel_id, Party::A, Endpoint::controlled(secret_a), Endpoint::observer(pkb), balance_a, balance_b);
    let mut dt_b = DistTunnel::new(tunnel_id, Party::B, Endpoint::controlled(secret_b), Endpoint::observer(pka), balance_a, balance_b);

    let mut moves = 0u64;
    let mut bytes = 0usize;
    let mut ts = created_at;

    'outer: while moves < max_moves && !dt_a.is_terminal() {
        let mut progressed = false;
        for p in [Party::A, Party::B] {
            if dt_a.is_terminal() { break; }
            // Each seat plans against its OWN tunnel's confirmed state (identical after each
            // confirmed move). The immutable borrow ends before the mutable propose below,
            // since `plan` returns an owned `Option<BjMove>` (BjMove is Copy).
            let mv = {
                let st = match p { Party::A => dt_a.state(), Party::B => dt_b.state() };
                plan(st, p)
            };
            let mv = match mv { Some(m) => m, None => continue };
            ts += 1;
            let first = match p { Party::A => dt_a.propose(mv, ts), Party::B => dt_b.propose(mv, ts) };
            bytes += match p {
                Party::A => deliver(&mut dt_a, &mut dt_b, first),
                Party::B => deliver(&mut dt_b, &mut dt_a, first),
            };
            moves += 1;
            progressed = true;
            if moves >= max_moves { break 'outer; }
        }
        if !progressed { break; }
    }

    let root = blake2b256(format!("dopamint:{tunnel_id}").as_bytes());
    let (settlement, sig_a_half) = dt_a.build_settlement_half_with_root(created_at, &root, 0);
    let (_settlement_b, sig_b_half) = dt_b.build_settlement_half_with_root(created_at, &root, 0);
    let (sig_a, sig_b) = dt_a.combine_settlement_with_root(&settlement, &root, &sig_a_half, &sig_b_half).expect("settlement combines");

    let (final_a, final_b) = (settlement.party_a_balance, settlement.party_b_balance);
    MatchResult { moves, bytes, final_balance_a: final_a, final_balance_b: final_b, settlement, sig_a, sig_b }
}
```

The `combine_settlement_with_root` call passes `&root`, matching the Task 4 signature. Both seats build their half over the same `root`, so the signatures verify.

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p rustbench driver`
Expected: PASS.

- [ ] **Step 5: Clippy + commit**

```bash
cargo clippy -p rustbench -- -D warnings
git add tools/rustbench/src/driver.rs tools/rustbench/src/lib.rs
git commit -m "feat(rustbench): local-channel match driver"
```

---

### Task 6: Whole-match golden parity gate

**Files:**
- Create: `tools/rustbench/tests/blackjack_match.rs`
- Create: `tools/rustbench/tests/vectors/blackjack_match.json`
- Test: the integration test itself.

**Interfaces:**
- Consumes: `rustbench::driver::play_fixed_match`, `rustbench::engine::wire::serialize_settlement_with_root`, `rustbench::engine::crypto::keypair_from_secret`.
- Produces: the parity gate proving a fixed-key Rust match is byte-and-signature-identical to the TS loadbench driver.

These vectors were captured from the real TS driver: a fixed-key match (A=`0x01..0x20`, B=`0x21..0x40`), `tunnelId="0xab"`, balances 200/200, `createdAt=1234567890`, `maxMoves=500`, played through `tools/loadbench/src/match.ts::playMatch` with `GAME_KITS["blackjack"]`.

- [ ] **Step 1: Vendor the golden vectors into `tests/vectors/blackjack_match.json`**

```json
{
  "_source": "tools/loadbench/src/match.ts playMatch + GAME_KITS['blackjack'], fixed keys A=0x01..0x20 B=0x21..0x40, tunnelId 0xab, balances 200/200, createdAt 1234567890, maxMoves 500",
  "moves": 143,
  "bytes": 75982,
  "final_balance_a": 400,
  "final_balance_b": 0,
  "final_nonce": 1,
  "timestamp": 1234567890,
  "transcript_root": "cdb287222b0f14530a4332b9d5146d22ef352e99868e337c01417de870692c4b",
  "settle_msg": "7375695f74756e6e656c3a3a736574746c656d656e745f763200000000000000000000000000000000000000000000000000000000000000ab00000000000001900000000000000000000000000000000100000000499602d2cdb287222b0f14530a4332b9d5146d22ef352e99868e337c01417de870692c4b",
  "sig_a": "b83ba4249305c9f79cc5bff05a5fba3b49e545a723f7c527003335f0b3034ff39772fb146b9eb82d133334a97d47956cbbd0169b5fd353e326ef1cb65c74780e",
  "sig_b": "a8a4daa7d70e896cd14ab1c54d57aed9676f551d73dd76b5dbad1128ed26b34627f94528ee579d07d34cb56a93749a1cb239e8162676ce43f4897fbe3c0af501",
  "pk_a": "79b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad049664",
  "pk_b": "e7f162a10bec559afea195e4dce84b69568d5d2cb0963eb446c0685e2b17f2f0"
}
```

- [ ] **Step 2: Write the failing integration test**

```rust
//! Whole-match parity gate: a fixed-key Rust blackjack match must be byte-and-signature
//! identical to the TS loadbench driver. Vectors captured from match.ts (see vectors file).

use rustbench::driver::play_fixed_match;
use rustbench::engine::crypto::keypair_from_secret;
use rustbench::engine::wire::serialize_settlement_with_root;

fn field<'a>(json: &'a str, key: &str) -> &'a str {
    // minimal dependency-free string scan; needle includes the closing quote so
    // "final_balance_a" cannot collide with "final_balance_b" etc.
    let needle = format!("\"{key}\"");
    let start = json.find(&needle).expect("key present");
    let after = &json[start + needle.len()..];
    let colon = after.find(':').unwrap();
    let rest = &after[colon + 1..];
    // value is either a quoted string or a bare number until , or }
    let trimmed = rest.trim_start();
    if let Some(stripped) = trimmed.strip_prefix('"') {
        let end = stripped.find('"').unwrap();
        &stripped[..end]
    } else {
        let end = trimmed.find([',', '}', '\n']).unwrap();
        trimmed[..end].trim()
    }
}

#[test]
fn fixed_match_matches_ts_golden() {
    let json = include_str!("vectors/blackjack_match.json");
    let sa: [u8; 32] = std::array::from_fn(|i| (i + 1) as u8);
    let sb: [u8; 32] = std::array::from_fn(|i| (i + 33) as u8);

    // sanity: our keys are the golden keys
    assert_eq!(hex::encode(keypair_from_secret(&sa).public_key()), field(json, "pk_a"));
    assert_eq!(hex::encode(keypair_from_secret(&sb).public_key()), field(json, "pk_b"));

    let r = play_fixed_match("0xab", &sa, &sb, 200, 200, 1234567890, 500);

    assert_eq!(r.moves.to_string(), field(json, "moves"), "move count");
    assert_eq!(r.bytes.to_string(), field(json, "bytes"), "total frame bytes");
    assert_eq!(r.final_balance_a.to_string(), field(json, "final_balance_a"));
    assert_eq!(r.final_balance_b.to_string(), field(json, "final_balance_b"));
    assert_eq!(r.settlement.final_nonce.to_string(), field(json, "final_nonce"));
    assert_eq!(r.settlement.timestamp.to_string(), field(json, "timestamp"));

    let root: [u8; 32] = {
        let mut o = [0u8; 32];
        hex::decode_to_slice(field(json, "transcript_root"), &mut o).unwrap();
        o
    };
    assert_eq!(hex::encode(serialize_settlement_with_root(&r.settlement, &root)), field(json, "settle_msg"));
    assert_eq!(hex::encode(r.sig_a), field(json, "sig_a"));
    assert_eq!(hex::encode(r.sig_b), field(json, "sig_b"));
}
```

- [ ] **Step 3: Run to verify the gate (fail first if anything diverged, then pass)**

Run: `cargo test -p rustbench --test blackjack_match`
Expected: PASS. If `moves` or `bytes` mismatch, the move sequence or frame encoding diverged from the TS — debug the protocol/driver/frame, never the vector. If only `sig_a`/`sig_b` differ while balances match, the settlement message or key handling diverged.

- [ ] **Step 4: Full suite + clippy**

Run: `cargo test -p rustbench && cargo clippy -p rustbench -- -D warnings`
Expected: all tests pass (Plan 1's 14 + this plan's unit tests + the match gate), no warnings.

- [ ] **Step 5: Commit**

```bash
git add tools/rustbench/tests/blackjack_match.rs tools/rustbench/tests/vectors/blackjack_match.json
git commit -m "test(rustbench): whole-match blackjack parity gate"
```

---

## Verification of the golden (how these vectors were produced)

The vectors in Task 6 were captured by running a fixed-key match through the **real** TS loadbench driver (`tools/loadbench/src/match.ts::playMatch` + `GAME_KITS["blackjack"]`) under `bun`. The protocol-level vectors in Task 1 (`initial`/`R1` encodeState + state_hash, the `[10,7]`/`[10,3]` opening deal) came from the same run via `kit.protocol`. A faithful Rust port reproducing the move sequence, frame encoding, state encoding, and ed25519 signing will match all of them. `transcript_root = blake2b256("dopamint:0xab")` was independently verified.

## Follow-on plans (roadmap — not in this plan)

- **Plan 3 — swarm fleet (rayon CPU path) + resources + report.** First ceiling TPS, comparable to `bun run bench --offchain --channel local --game blackjack`.
- **Plan 4 — latency mode (p50/p99).**
- **Plan 5 — relay channel** (tokio IO path; the pull-based `propose`/`handle_frame` API drives a WS loop mirroring `tunnel-manager::mp::protocol`).
- **Plan 6 — onchain anchor** (PTB `create_and_fund` open + `close_cooperative_with_root` settle).
