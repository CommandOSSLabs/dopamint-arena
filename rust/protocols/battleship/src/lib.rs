//! Battleship protocol, ported from `frontend/src/games/battleship`.

use tunnel_core::codec::u64_to_be_bytes;
use tunnel_core::crypto::blake2b256;
use tunnel_harness::{Balances, Protocol, ProtocolError, Seat, TunnelContext};

pub mod strategy;
pub use strategy::{BattleshipSeriesStrategy, BattleshipStrategy};

pub const BOARD_SIZE: usize = 10;
pub const CELL_COUNT: usize = BOARD_SIZE * BOARD_SIZE;
pub const FLEET_CELLS: u8 = 17;
pub const SALT_BYTES: usize = 32;
const TREE_LEAVES: usize = 128;
const COMMIT_BYTES: usize = 32;
const DOMAIN: &[u8] = b"sui_tunnel::proto::battleship.v1";
const SERIES_DOMAIN: &[u8] = b"sui_tunnel::proto::battleship.series.v1";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BattleshipPhase {
    AwaitingCommits,
    Playing,
    Over,
}

impl BattleshipPhase {
    fn code(self) -> u8 {
        match self {
            BattleshipPhase::AwaitingCommits => 0,
            BattleshipPhase::Playing => 1,
            BattleshipPhase::Over => 2,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BattleshipWinner {
    None,
    A,
    B,
}

impl BattleshipWinner {
    fn code(self) -> u8 {
        match self {
            BattleshipWinner::None => 0,
            BattleshipWinner::A => 1,
            BattleshipWinner::B => 2,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PendingShot {
    pub by: Seat,
    pub cell: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ShotResult {
    pub cell: u8,
    pub is_hit: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BattleshipState {
    pub phase: BattleshipPhase,
    pub turn: Seat,
    pub pending_shot: Option<PendingShot>,
    pub commit_a: Option<[u8; 32]>,
    pub commit_b: Option<[u8; 32]>,
    pub shots_at_a: Vec<ShotResult>,
    pub shots_at_b: Vec<ShotResult>,
    pub hits_on_a: u8,
    pub hits_on_b: u8,
    pub winner: BattleshipWinner,
    pub balance_a: u64,
    pub balance_b: u64,
    pub total: u64,
    pub stake: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BattleshipMove {
    Commit {
        #[serde(with = "tunnel_harness::wire_hex::array32")]
        root: [u8; 32],
    },
    Shoot {
        cell: u8,
    },
    Reveal {
        cell: u8,
        #[serde(rename = "isShip")]
        is_ship: bool,
        #[serde(with = "tunnel_harness::wire_hex::array32")]
        salt: [u8; 32],
        #[serde(with = "tunnel_harness::wire_hex::vec_array32")]
        proof: Vec<[u8; 32]>,
    },
}

#[derive(Clone, Debug)]
pub struct Battleship {
    default_stake: u64,
}

impl Battleship {
    pub fn new(stake: u64) -> Self {
        Self {
            default_stake: stake,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BattleshipSeriesState {
    pub inner: BattleshipState,
    pub games_played: u64,
    pub balance_a: u64,
    pub balance_b: u64,
}

#[derive(Clone, Debug)]
pub struct BattleshipSeries {
    tunnel_id: String,
    stake_per_game: u64,
    inner: Battleship,
}

impl BattleshipSeries {
    pub fn new(tunnel_id: impl Into<String>, stake_per_game: u64) -> Self {
        Self {
            tunnel_id: tunnel_id.into(),
            stake_per_game,
            inner: Battleship::new(stake_per_game),
        }
    }

    fn game_ctx(&self, game_number: u64) -> TunnelContext {
        TunnelContext {
            tunnel_id: format!("{}:g{}", self.tunnel_id, game_number),
            initial: Balances {
                a: self.stake_per_game,
                b: self.stake_per_game,
            },
            seat: Seat::A,
        }
    }

    fn can_fund_next_game(&self, state: &BattleshipSeriesState) -> bool {
        self.stake_per_game == 0
            || (state.balance_a >= self.stake_per_game && state.balance_b >= self.stake_per_game)
    }

    fn swap(&self, balance_a: u64, balance_b: u64, winner: BattleshipWinner) -> (u64, u64) {
        match winner {
            BattleshipWinner::A => {
                let stake = self.stake_per_game.min(balance_b);
                (balance_a + stake, balance_b - stake)
            }
            BattleshipWinner::B => {
                let stake = self.stake_per_game.min(balance_a);
                (balance_a - stake, balance_b + stake)
            }
            BattleshipWinner::None => (balance_a, balance_b),
        }
    }
}

impl Default for Battleship {
    fn default() -> Self {
        Self { default_stake: 100 }
    }
}

fn splitmix_next(state: u64) -> u64 {
    let mut z = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

fn leaf_hash(cell: u8, is_ship: bool, salt: &[u8; 32]) -> [u8; 32] {
    let mut input = Vec::with_capacity(35);
    input.push(0x00);
    input.push(cell);
    input.push(if is_ship { 1 } else { 0 });
    input.extend_from_slice(salt);
    blake2b256(&input)
}

fn node_hash(left: &[u8; 32], right: &[u8; 32]) -> [u8; 32] {
    let mut input = Vec::with_capacity(65);
    input.push(0x01);
    input.extend_from_slice(left);
    input.extend_from_slice(right);
    blake2b256(&input)
}

fn pad_leaf() -> [u8; 32] {
    blake2b256(&[0x02])
}

pub fn commit_board(board: &[u8], salts: &[[u8; 32]]) -> Result<Vec<Vec<[u8; 32]>>, String> {
    if board.len() != CELL_COUNT {
        return Err(format!("board must be {CELL_COUNT} cells"));
    }
    if salts.len() != CELL_COUNT {
        return Err(format!("need {CELL_COUNT} salts"));
    }
    let mut leaves = vec![pad_leaf(); TREE_LEAVES];
    for cell in 0..CELL_COUNT {
        leaves[cell] = leaf_hash(cell as u8, board[cell] == 1, &salts[cell]);
    }
    let mut layers = vec![leaves];
    while layers.last().unwrap().len() > 1 {
        let current = layers.last().unwrap();
        let mut next = Vec::with_capacity(current.len() / 2);
        for pair in current.chunks_exact(2) {
            next.push(node_hash(&pair[0], &pair[1]));
        }
        layers.push(next);
    }
    Ok(layers)
}

pub fn commitment_root(layers: &[Vec<[u8; 32]>]) -> Option<[u8; 32]> {
    layers.last().and_then(|layer| layer.first()).copied()
}

pub fn prove_cell(layers: &[Vec<[u8; 32]>], cell: u8) -> Result<Vec<[u8; 32]>, String> {
    if cell as usize >= CELL_COUNT {
        return Err(format!("cell out of range: {cell}"));
    }
    let mut idx = cell as usize;
    let mut proof = Vec::new();
    for level in layers.iter().take(layers.len().saturating_sub(1)) {
        proof.push(level[idx ^ 1]);
        idx >>= 1;
    }
    Ok(proof)
}

pub fn verify_cell(
    root: &[u8; 32],
    cell: u8,
    is_ship: bool,
    salt: &[u8; 32],
    proof: &[[u8; 32]],
) -> bool {
    if cell as usize >= CELL_COUNT {
        return false;
    }
    let mut hash = leaf_hash(cell, is_ship, salt);
    let mut idx = cell as usize;
    for sibling in proof {
        hash = if idx % 2 == 0 {
            node_hash(&hash, sibling)
        } else {
            node_hash(sibling, &hash)
        };
        idx >>= 1;
    }
    &hash == root
}

fn commit_for(state: &BattleshipState, party: Seat) -> Option<[u8; 32]> {
    match party {
        Seat::A => state.commit_a,
        Seat::B => state.commit_b,
    }
}

fn shots_at(state: &BattleshipState, defender: Seat) -> &[ShotResult] {
    match defender {
        Seat::A => &state.shots_at_a,
        Seat::B => &state.shots_at_b,
    }
}

fn push_length_prefixed(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&u64_to_be_bytes(bytes.len() as u64));
    out.extend_from_slice(bytes);
}

impl Protocol for Battleship {
    type State = BattleshipState;
    type Move = BattleshipMove;

    fn name(&self) -> &str {
        "battleship.v1"
    }

    fn initial_state(&self, ctx: &TunnelContext) -> Self::State {
        let stake = self.default_stake.min(ctx.initial.a.min(ctx.initial.b));
        BattleshipState {
            phase: BattleshipPhase::AwaitingCommits,
            turn: Seat::A,
            pending_shot: None,
            commit_a: None,
            commit_b: None,
            shots_at_a: Vec::new(),
            shots_at_b: Vec::new(),
            hits_on_a: 0,
            hits_on_b: 0,
            winner: BattleshipWinner::None,
            balance_a: ctx.initial.a,
            balance_b: ctx.initial.b,
            total: ctx.initial.sum(),
            stake,
        }
    }

    fn apply_move(
        &self,
        state: &Self::State,
        mv: &Self::Move,
        by: Seat,
    ) -> Result<Self::State, ProtocolError> {
        if state.phase == BattleshipPhase::Over || state.winner != BattleshipWinner::None {
            return Err(ProtocolError("game already over".into()));
        }
        match mv {
            BattleshipMove::Commit { root } => self.apply_commit(state, *root, by),
            BattleshipMove::Shoot { cell } => self.apply_shoot(state, *cell, by),
            BattleshipMove::Reveal {
                cell,
                is_ship,
                salt,
                proof,
            } => self.apply_reveal(state, *cell, *is_ship, salt, proof, by),
        }
    }

    fn encode_state(&self, state: &Self::State) -> Vec<u8> {
        let pending = state.pending_shot;
        let fixed = [
            state.phase.code(),
            if state.turn == Seat::A { 0 } else { 1 },
            if pending.is_some() { 1 } else { 0 },
            pending.map_or(0, |p| if p.by == Seat::A { 0 } else { 1 }),
            pending.map_or(0, |p| p.cell),
            state.hits_on_a,
            state.hits_on_b,
            state.winner.code(),
        ];

        let shot_bytes = |shots: &[ShotResult]| {
            let mut out = Vec::with_capacity(shots.len() * 2);
            for shot in shots {
                out.push(shot.cell);
                out.push(if shot.is_hit { 1 } else { 0 });
            }
            out
        };

        let mut variable = Vec::new();
        push_length_prefixed(
            &mut variable,
            state.commit_a.as_ref().map_or(&[], |r| &r[..]),
        );
        push_length_prefixed(
            &mut variable,
            state.commit_b.as_ref().map_or(&[], |r| &r[..]),
        );
        push_length_prefixed(&mut variable, &shot_bytes(&state.shots_at_a));
        push_length_prefixed(&mut variable, &shot_bytes(&state.shots_at_b));

        let mut out = Vec::new();
        out.extend_from_slice(DOMAIN);
        out.extend_from_slice(&fixed);
        out.extend_from_slice(&variable);
        out.extend_from_slice(&u64_to_be_bytes(state.balance_a));
        out.extend_from_slice(&u64_to_be_bytes(state.balance_b));
        out.extend_from_slice(&u64_to_be_bytes(state.stake));
        out
    }

    fn balances(&self, state: &Self::State) -> Balances {
        Balances {
            a: state.balance_a,
            b: state.balance_b,
        }
    }

    fn is_terminal(&self, state: &Self::State) -> bool {
        state.winner != BattleshipWinner::None
    }

    fn sample_move(
        &self,
        state: &Self::State,
        seat: Seat,
        rng: &mut dyn FnMut() -> f64,
    ) -> Option<Self::Move> {
        if state.phase != BattleshipPhase::Playing || state.pending_shot.is_some() {
            return None;
        }
        if seat != state.turn {
            return None;
        }
        let defender = seat.other();
        let fired: std::collections::BTreeSet<u8> =
            shots_at(state, defender).iter().map(|s| s.cell).collect();
        let open: Vec<u8> = (0..CELL_COUNT as u8)
            .filter(|cell| !fired.contains(cell))
            .collect();
        if open.is_empty() {
            return None;
        }
        let idx = ((rng() * open.len() as f64).floor() as usize).min(open.len() - 1);
        Some(BattleshipMove::Shoot { cell: open[idx] })
    }
}

impl Protocol for BattleshipSeries {
    type State = BattleshipSeriesState;
    type Move = BattleshipMove;

    fn name(&self) -> &str {
        "battleship.series.v1"
    }

    fn initial_state(&self, ctx: &TunnelContext) -> Self::State {
        BattleshipSeriesState {
            inner: self.inner.initial_state(&self.game_ctx(1)),
            games_played: 0,
            balance_a: ctx.initial.a,
            balance_b: ctx.initial.b,
        }
    }

    fn apply_move(
        &self,
        state: &Self::State,
        mv: &Self::Move,
        by: Seat,
    ) -> Result<Self::State, ProtocolError> {
        if !self.inner.is_terminal(&state.inner) {
            let next_inner = self.inner.apply_move(&state.inner, mv, by)?;
            if self.inner.is_terminal(&next_inner) {
                let (balance_a, balance_b) =
                    self.swap(state.balance_a, state.balance_b, next_inner.winner);
                return Ok(BattleshipSeriesState {
                    inner: next_inner,
                    games_played: state.games_played,
                    balance_a,
                    balance_b,
                });
            }
            return Ok(BattleshipSeriesState {
                inner: next_inner,
                ..state.clone()
            });
        }
        if self.is_terminal(state) {
            return Err(ProtocolError(
                "session over: insufficient balance for another game".into(),
            ));
        }
        let fresh = self
            .inner
            .initial_state(&self.game_ctx(state.games_played + 2));
        Ok(BattleshipSeriesState {
            inner: self.inner.apply_move(&fresh, mv, by)?,
            games_played: state.games_played + 1,
            balance_a: state.balance_a,
            balance_b: state.balance_b,
        })
    }

    fn encode_state(&self, state: &Self::State) -> Vec<u8> {
        let inner = self.inner.encode_state(&state.inner);
        let mut body = Vec::new();
        push_length_prefixed(&mut body, &inner);
        push_length_prefixed(&mut body, &u64_to_be_bytes(state.games_played));
        push_length_prefixed(&mut body, &u64_to_be_bytes(state.balance_a));
        push_length_prefixed(&mut body, &u64_to_be_bytes(state.balance_b));
        let mut out = Vec::with_capacity(SERIES_DOMAIN.len() + body.len());
        out.extend_from_slice(SERIES_DOMAIN);
        out.extend_from_slice(&body);
        out
    }

    fn balances(&self, state: &Self::State) -> Balances {
        Balances {
            a: state.balance_a,
            b: state.balance_b,
        }
    }

    fn is_terminal(&self, state: &Self::State) -> bool {
        self.inner.is_terminal(&state.inner) && !self.can_fund_next_game(state)
    }

    fn sample_move(
        &self,
        state: &Self::State,
        seat: Seat,
        rng: &mut dyn FnMut() -> f64,
    ) -> Option<Self::Move> {
        if self.inner.is_terminal(&state.inner) {
            return None;
        }
        self.inner.sample_move(&state.inner, seat, rng)
    }
}

impl Battleship {
    fn apply_commit(
        &self,
        state: &BattleshipState,
        root: [u8; 32],
        by: Seat,
    ) -> Result<BattleshipState, ProtocolError> {
        if state.phase != BattleshipPhase::AwaitingCommits {
            return Err(ProtocolError("commits are closed".into()));
        }
        if COMMIT_BYTES != root.len() {
            return Err(ProtocolError("commitment must be 32 bytes".into()));
        }
        if state.commit_a.is_none() {
            if by != Seat::A {
                return Err(ProtocolError("A commits first".into()));
            }
        } else if state.commit_b.is_none() {
            if by != Seat::B {
                return Err(ProtocolError("B commits second".into()));
            }
        } else {
            return Err(ProtocolError("both fleets already committed".into()));
        }

        let mut next = state.clone();
        match by {
            Seat::A => next.commit_a = Some(root),
            Seat::B => next.commit_b = Some(root),
        }
        if next.commit_a.is_some() && next.commit_b.is_some() {
            next.phase = BattleshipPhase::Playing;
            next.turn = Seat::A;
        }
        Ok(next)
    }

    fn apply_shoot(
        &self,
        state: &BattleshipState,
        cell: u8,
        by: Seat,
    ) -> Result<BattleshipState, ProtocolError> {
        if state.phase != BattleshipPhase::Playing {
            return Err(ProtocolError("not in the firing phase".into()));
        }
        if state.pending_shot.is_some() {
            return Err(ProtocolError("awaiting the previous shot's reveal".into()));
        }
        if by != state.turn {
            return Err(ProtocolError("not this party's turn".into()));
        }
        if cell as usize >= CELL_COUNT {
            return Err(ProtocolError(format!("cell out of range: {cell}")));
        }
        if shots_at(state, by.other())
            .iter()
            .any(|shot| shot.cell == cell)
        {
            return Err(ProtocolError(format!("already fired at cell {cell}")));
        }
        Ok(BattleshipState {
            pending_shot: Some(PendingShot { by, cell }),
            ..state.clone()
        })
    }

    fn apply_reveal(
        &self,
        state: &BattleshipState,
        cell: u8,
        is_ship: bool,
        salt: &[u8; 32],
        proof: &[[u8; 32]],
        by: Seat,
    ) -> Result<BattleshipState, ProtocolError> {
        let pending = state
            .pending_shot
            .ok_or_else(|| ProtocolError("no shot to reveal".into()))?;
        if state.phase != BattleshipPhase::Playing {
            return Err(ProtocolError("no shot to reveal".into()));
        }
        if by != pending.by.other() {
            return Err(ProtocolError("only the defender reveals".into()));
        }
        if cell != pending.cell {
            return Err(ProtocolError("reveal must answer the pending shot".into()));
        }
        let commit = commit_for(state, by)
            .ok_or_else(|| ProtocolError("defender has not committed".into()))?;
        if !verify_cell(&commit, cell, is_ship, salt, proof) {
            return Err(ProtocolError(
                "reveal proof does not match the committed board".into(),
            ));
        }

        let result = ShotResult {
            cell,
            is_hit: is_ship,
        };
        let mut next = state.clone();
        match by {
            Seat::A => {
                next.shots_at_a.push(result);
                if is_ship {
                    next.hits_on_a += 1;
                }
            }
            Seat::B => {
                next.shots_at_b.push(result);
                if is_ship {
                    next.hits_on_b += 1;
                }
            }
        }
        if next.hits_on_b == FLEET_CELLS {
            next.winner = BattleshipWinner::A;
        } else if next.hits_on_a == FLEET_CELLS {
            next.winner = BattleshipWinner::B;
        }
        if next.winner != BattleshipWinner::None {
            match next.winner {
                BattleshipWinner::A => {
                    let shift = next.stake.min(next.balance_b);
                    next.balance_a += shift;
                    next.balance_b -= shift;
                }
                BattleshipWinner::B => {
                    let shift = next.stake.min(next.balance_a);
                    next.balance_a -= shift;
                    next.balance_b += shift;
                }
                BattleshipWinner::None => {}
            }
            next.phase = BattleshipPhase::Over;
        }
        next.pending_shot = None;
        next.turn = by;
        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> TunnelContext {
        TunnelContext {
            tunnel_id: "0xbattle".into(),
            initial: Balances { a: 1000, b: 1000 },
            seat: Seat::A,
        }
    }

    #[test]
    fn merkle_commit_prove_verify_round_trips() {
        let mut board = vec![0u8; CELL_COUNT];
        board[7] = 1;
        let salts = vec![[9u8; 32]; CELL_COUNT];
        let layers = commit_board(&board, &salts).unwrap();
        let root = commitment_root(&layers).unwrap();
        let proof = prove_cell(&layers, 7).unwrap();
        assert!(verify_cell(&root, 7, true, &salts[7], &proof));
        assert!(!verify_cell(&root, 7, false, &salts[7], &proof));
    }

    #[test]
    fn commits_shoots_and_reveals() {
        let protocol = Battleship::default();
        let mut state = protocol.initial_state(&ctx());
        let board_a = vec![0u8; CELL_COUNT];
        let mut board_b = vec![0u8; CELL_COUNT];
        board_b[4] = 1;
        let salts_a = vec![[1u8; 32]; CELL_COUNT];
        let salts_b = vec![[2u8; 32]; CELL_COUNT];
        let layers_a = commit_board(&board_a, &salts_a).unwrap();
        let layers_b = commit_board(&board_b, &salts_b).unwrap();
        let root_a = commitment_root(&layers_a).unwrap();
        let root_b = commitment_root(&layers_b).unwrap();

        state = protocol
            .apply_move(&state, &BattleshipMove::Commit { root: root_a }, Seat::A)
            .unwrap();
        state = protocol
            .apply_move(&state, &BattleshipMove::Commit { root: root_b }, Seat::B)
            .unwrap();
        assert_eq!(state.phase, BattleshipPhase::Playing);
        state = protocol
            .apply_move(&state, &BattleshipMove::Shoot { cell: 4 }, Seat::A)
            .unwrap();
        state = protocol
            .apply_move(
                &state,
                &BattleshipMove::Reveal {
                    cell: 4,
                    is_ship: true,
                    salt: salts_b[4],
                    proof: prove_cell(&layers_b, 4).unwrap(),
                },
                Seat::B,
            )
            .unwrap();
        assert_eq!(state.hits_on_b, 1);
        assert_eq!(state.turn, Seat::B);
        assert!(protocol
            .encode_state(&state)
            .starts_with(b"sui_tunnel::proto::battleship.v1"));
    }

    #[test]
    fn series_uses_canonical_protocol_id() {
        let protocol = BattleshipSeries::new("0xbattle", 100);
        let state = protocol.initial_state(&ctx());
        assert_eq!(protocol.name(), "battleship.series.v1");
        assert!(protocol
            .encode_state(&state)
            .starts_with(b"sui_tunnel::proto::battleship.series.v1"));
        assert_eq!(protocol.balances(&state).sum(), 2000);
    }
}

#[cfg(test)]
mod move_wire_parity {
    use super::*;

    // The relayed move is JSON; the FE `battleshipMoveCodec` (battleship.v1) sends `type`-tagged moves
    // with bare-hex for [u8;32] (root/salt), an array of bare-hex for `proof`, `isShip` (camelCase),
    // and `cell` a number. The bot's `BattleshipMove` serde MUST match or commit/reveal can't decode.
    #[test]
    fn move_json_matches_fe_battleship_move_codec() {
        assert_eq!(
            serde_json::to_value(BattleshipMove::Commit { root: [0xab; 32] }).unwrap(),
            serde_json::json!({ "type": "commit", "root": "ab".repeat(32) }),
        );
        assert_eq!(
            serde_json::to_value(BattleshipMove::Reveal {
                cell: 7,
                is_ship: true,
                salt: [0xcd; 32],
                proof: vec![[0x11; 32], [0x22; 32]],
            })
            .unwrap(),
            serde_json::json!({
                "type": "reveal",
                "cell": 7,
                "isShip": true,
                "salt": "cd".repeat(32),
                "proof": ["11".repeat(32), "22".repeat(32)],
            }),
        );
        // And decodes the FE's exact bytes back.
        let parsed: BattleshipMove = serde_json::from_value(serde_json::json!({
            "type": "reveal", "cell": 0, "isShip": false,
            "salt": "00".repeat(32), "proof": ["ff".repeat(32)],
        }))
        .unwrap();
        assert!(matches!(
            parsed,
            BattleshipMove::Reveal {
                cell: 0,
                is_ship: false,
                ..
            }
        ));
    }
}
