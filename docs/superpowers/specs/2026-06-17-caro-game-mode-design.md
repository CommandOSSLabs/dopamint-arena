# Caro (Five-in-a-Row) Game Mode — Design

**Date:** 2026-06-17
**Status:** Approved (design); pending implementation plan
**Scope:** Add a *Caro* (Gomoku / five-in-a-row) play style to the existing TicTacToe
game, alongside the current 3×3 board, settled on-chain through the same tunnel flow.

---

## 1. Goal

Add Caro as an **additional** game type in the ticTacToe app: a configurable-size board
where **five marks in a row** (horizontal / vertical / diagonal) wins, played **bot-vs-bot**
and settled on-chain via the existing Sui Tunnel flow (`create_and_fund` → off-chain
self-play → `update_state` → `close_cooperative_with_root`).

3×3 TicTacToe stays exactly as-is. Caro is purely additive and selected on the setup screen.

### Decisions (locked during brainstorming)

- **Board:** configurable size chosen at setup. Presets **15 / 19 / 25**, plus a custom
  input clamped to **9–29**. Default **15** (standard gomoku). Finite board (a hashed
  state-channel board cannot be literally unbounded), large enough to feel "unlimited".
- **Win rule:** free-style **5-in-a-row** — any run of **5 or more** consecutive same marks
  wins (overlines count). A full board with no winner is a **draw**.
- **Play mode:** **bot-vs-bot only** (auto-loop + single game), matching today's TTT. No
  human-vs-bot mode (TTT has none today; out of scope).
- **Stake:** 0 (like TTT). The board *is* the state; per-game results are tracked as a
  local score, balances stay constant.

### Non-goals

- Strict Vietnamese caro rules (exactly-5, blocked-both-ends void) — not this version.
- Human-vs-bot play. Truly infinite/pannable board. Minimax "perfect" caro AI.
- Any change to the repo core (`sui_tunnel/`, `sui-tunnel-ts/`). All work is game-side.

---

## 2. Architecture

**Approach A — parallel, isolated caro stack.** A new `caro/` module in `@ttt/shared`, a
parallel `useCaroBotGame` client hook, and a `CaroBoard` component. The shipping 3×3 TTT
protocol/hook/board are untouched. Each new unit is small, focused, and unit-testable.

```
@ttt/shared/src/caro/
  board.ts        # flat N*N board, O(1) win-check around the last move, legal moves, draw
  protocol.ts     # CaroProtocol (one game) + MultiGameCaroProtocol (N games / tunnel)
  bot.ts          # threat-scoring heuristic move picker (neighborhood-bounded)
  *.test.ts       # board / protocol / bot unit tests

client/src/
  hooks/useCaroBotGame.ts   # parallel to useBotGame; reuses bots/fund/tunnel libs
  components/CaroBoard.tsx   # fit-to-card N×N grid renderer
  scenes/SetupScene.tsx      # + game-type toggle + board-size selector  (modified)
  scenes/GameScene.tsx       # render CaroBoard when gameType==="caro"     (modified)
  App.tsx                    # thread gameType/boardSize; select active hook (modified)
```

Why not B (one generalized `useTunnelBotGame(engine)`) or C (one
`MultiGameGridProtocol(size, winLen)`): both refactor the working TTT
protocol/hook/encoding — larger blast radius for no functional gain here. Chosen A for
isolation and zero risk to the shipping game.

---

## 3. Protocol layer (`@ttt/shared/caro/`)

Implements the SDK interface `protocols.Protocol<State, Move>`
(`initialState` / `applyMove` / `encodeState` / `balances` / `isTerminal` / `randomMove?`).
Marks follow the existing convention: **0 = empty, 1 = party A (Bot X), 2 = party B (Bot O)**.

### 3.1 `board.ts`

```ts
export type CaroBoard = number[]; // length size*size, values 0|1|2

// 5+ consecutive `mark` through `idx` in any of the 4 axes -> mark, else 0.
// O(1): only scans outward from the move just played.
export function winnerAround(board: CaroBoard, size: number, idx: number): number;

export function isFull(board: CaroBoard): boolean;          // no empty cell -> draw
export function inBounds(size: number, r: number, c: number): boolean;
export function applyMark(board: CaroBoard, idx: number, mark: number): CaroBoard; // pure copy
```

`winnerAround` checks directions `(0,1) (1,0) (1,1) (1,-1)`; for each it counts contiguous
same-mark cells in both directions from `idx`; if `1 + forward + backward >= 5` the mover wins.

### 3.2 `CaroState` and `CaroProtocol(boardSize)`

```ts
export interface CaroState {
  board: number[];        // length size*size
  size: number;           // board edge length (9..29)
  turn: "A" | "B";        // side to move
  winner: number;         // 0 none | 1 A | 2 B | 3 draw
  lastMove: number;       // last placed index, -1 at start (for UI highlight + O(1) win-check)
  balanceA: bigint;       // carried for multi-game parity; constant at stake 0
  balanceB: bigint;
  stake: bigint;          // 0 for caro
}
export type CaroMove = { cell: number };  // flat board index (same shape as TTT move)
```

- `initialState(ctx)`: empty `size*size` board, `turn:"A"`, `winner:0`, `lastMove:-1`,
  balances from `ctx.initialBalances`, `stake:0`. `boardSize` is a constructor arg
  (default 15); A always moves first.
- `applyMove(state, {cell}, by)`: **throws** unless the game is live, `by === state.turn`,
  `cell` is in range and empty. Places `by`'s mark, recomputes `winner` via
  `winnerAround` (or `3` if the board is now full), flips `turn`. On a decisive win it
  applies the clamped loser→winner stake swap (inert at stake 0, kept for parity with TTT).
- `isTerminal(state)`: `state.winner !== 0`.
- `balances(state)`: `{ a: balanceA, b: balanceB }` (sums to the locked total).
- `randomMove(state, by, rng)`: a random legal cell near existing stones (center if empty),
  for the SDK simulator/sanity only — the real bot uses `bot.ts`.

### 3.3 `encodeState` (deterministic, canonical)

```
domain = protocolDomain("caro.v1")
encodeState = domain || lengthPrefixedConcat([
  u64be(size),                     // size baked in -> no cross-size hash collision
  Uint8Array(board),               // size*size bytes, values 0|1|2
  Uint8Array([turnByte, winnerByte]),  // turn: A=0 B=1 ; winner: 0|1|2|3
  u64be(balanceA), u64be(balanceB), u64be(stake),
])
```

Built from the SDK's own `protocols.protocolDomain` / `protocols.lengthPrefixedConcat` /
`core.u64ToBeBytes` / `core.concatBytes` so the byte format matches the framework exactly.
Distinct domain (`caro.v1`) guarantees no collision with `tic_tac_toe.*` state hashes.
`lastMove` is **not** encoded — it is deterministic from the move sequence (so both parties
always agree) and serves only the UI highlight + O(1) win-check; it is not part of the
canonical hashed state.

### 3.4 `MultiGameCaroProtocol(maxGames, boardSize)`

Mirrors `MultiGameTicTacToeProtocol` exactly, composing `CaroProtocol` as the inner game:
state `{ inner: CaroState, gamesPlayed, maxGames }`; domain `caro.multi.v1`; a finished inner
game + `gamesPlayed+1 >= maxGames` (or next stake unfundable) ⇒ terminal; an advance move
resets to a fresh board carrying balances forward. This lets N caro games settle in one
tunnel, identical to the TTT multi-game loop.

---

## 4. Bot AI (`@ttt/shared/caro/bot.ts`)

Minimax cannot scale to an N×N caro board, so the bot uses a **threat-scoring heuristic**:

```ts
export function pickCaroMove(
  state: CaroState, by: "A" | "B", rng: () => number, strength: "strong" | "weak",
): number;  // returns a flat board index (a legal empty cell)
```

- **Candidates:** empty cells within Chebyshev distance `R` of any placed stone
  (`R = 2` for `strong`, `1` for `weak`). First move (empty board) → center index.
- **Scoring:** for each candidate, score the runs it *makes for me* and *blocks for the
  opponent* across the 4 axes, with priority:
  `make 5 (win) ≫ block opponent 5 ≫ make open-4 > block open-4 > make/own open-3 > …`.
  `weak` uses only own-extension + immediate block (greedy); `strong` adds open-4/open-3
  threat weighting and a larger radius.
- **Tie-break:** small `rng`-driven jitter so equal-scoring openings vary between games.

Difficulty mapping (reusing the existing `Difficulty` type, no minimax for caro):
`perfect` → both `strong`; `even` → both `strong` with jitter; `uneven` → Bot X `strong`,
Bot O `weak`. The setup UI keeps the same three labels; their caro meaning is heuristic
strength.

---

## 5. Client wiring

### 5.1 Game type + board size

`App.tsx` gains `gameType: "ttt" | "caro"` and `boardSize: number` state, threaded into
setup and the game scene. `SetupScene` adds a **game-type toggle** and, when `caro`, a
**board-size selector** (presets 15/19/25 + clamped custom input 9–29, default 15), placed
on the existing tabbed setup panel.

### 5.2 Hooks (rules-of-hooks compliant)

`useCaroBotGame(difficulty, boardSize)` is a parallel hook mirroring `useBotGame`'s
orchestration (create_and_fund → animated self-play loop → `update_state` → close, with the
auto-loop, gas guards, per-tunnel `maxGames`, and digests). It reuses the **game-agnostic**
shared libs unchanged: `lib/bots.ts` (same two bot keypairs), `lib/tunnel.ts`
(`buildCreateAndFundTx` etc.), funding, balances. Its move picker is `pickCaroMove`; its
protocol is `MultiGameCaroProtocol(maxGames, boardSize)`.

`App` calls **both** `useBotGame` and `useCaroBotGame` and selects the active view by
`gameType` (`const g = gameType === "caro" ? caroGame : tttGame`). Both hooks share the same
bot identities (`loadOrCreateBots` is idempotent/localStorage-backed) and the cached
SuiClient; the inactive hook stays idle (no timers run until its `startAuto`/`newGame` is
called). **Known trade-off:** the idle hook performs one extra balance read on mount — a
negligible cost that buys rules-of-hooks compliance with zero refactor to the shipping TTT
hook. (Both hooks expose the same view surface so the shared panels render either.)

### 5.3 View shape

`useCaroBotGame` returns the same `BotGameView` surface used by `GameScene` (board, turn,
winner, phase, error, digests, balances, score, auto, rebalancing, maxGames, currentGame,
and the `fund`/`newGame`/`startAuto`/`stopAuto`/`setMaxGames`/… callbacks) **plus** caro
extras `boardSize: number` and `lastMove: number`. `board` is the flat `size*size` array.

### 5.4 `CaroBoard` component + `GameScene`

`CaroBoard` renders a fit-to-card `size×size` CSS grid: cell size scales to fit the game
card (≈500px), marks shown as X/O or two stone colors, the **last move** and the **winning
line** highlighted. If a size's grid exceeds the card it scrolls within a fixed frame.
`GameScene` renders `<CaroBoard …/>` when `gameType==="caro"`, else the current `<Board/>`;
the scoreboard, status text, games-per-tunnel control, actions, and the on-chain digest
panel (Open & Fund / Transcript Root / State Checkpoint / Settle & Close) are reused as-is.
Status text gains caro-appropriate wording (e.g., "Bot X wins! (5 in a row)").

---

## 6. Tunnel integration (unchanged)

Caro plugs into `core.OffchainTunnel.selfPlay` exactly like TTT: every move is dual-signed
and verified (`mode:"full"`, timestamp = on-chain `created_at`); a `proof.Transcript`
accumulates updates; settle = `update_state(final)` then `close_cooperative_with_root(root)`.
The opening uses the same one-tx `buildCreateAndFundTx` (player bot funds both stakes; the
other bot signs nothing). No new on-chain code; the deployed package already supports it.

---

## 7. Testing

Unit tests (node:test via tsx in `@ttt/shared`, co-located `*.test.ts`):

- **board.test.ts** — `winnerAround` detects 5-in-a-row in each of the 4 axes; detects a run
  of 6 (free-style overline) as a win; does **not** fire on 4; respects edges/corners (no
  wrap-around); `isFull` ⇒ draw only when no winner.
- **protocol.test.ts** — `applyMove` throws on out-of-range / occupied / wrong-turn moves;
  a winning move sets `winner` and makes the state terminal; `encodeState` is deterministic,
  changes when the board changes, encodes `size` (two sizes with identical small boards
  differ), and never collides with a `tic_tac_toe.*` encoding; balances always sum to the
  locked total.
- **multiGame** — N games settle in one tunnel; terminal only after the last game (or
  unfundable next stake); balance conservation across resets.
- **bot.test.ts** — takes an immediate winning move when 4-in-a-row is open; blocks the
  opponent's open-four; opens at center on an empty board; only ever returns legal empty
  cells.

Manual end-to-end: pick Caro + a size on setup, fund, run the bot arena, confirm a game
reaches 5-in-a-row and the tunnel settles on testnet (digest panel populates, suiscan shows
the state field + close event) — the same verification path already used for TTT.

---

## 8. Edge cases & risks

- **Draw on full board:** finite size means a full board with no 5-run is a draw (`winner=3`);
  rare on 15×15+ but handled.
- **Large-N performance:** O(1) `winnerAround` (scans only around the last move) +
  neighborhood-bounded candidate generation keep both move-gen and win-check fast at 25×25+.
- **Encoding size:** full `encodeState` is ≤ ~900 bytes at 29×29 — cheap to hash; no rolling
  digest needed.
- **Board rendering at large N:** cells shrink to fit the card; a frame with scroll covers
  sizes that exceed it. Marks remain legible via two distinct stone colors.
- **Two idle hooks:** documented trade-off (§5.2); one extra balance read, no timers.
- **Difficulty semantics differ from TTT:** "perfect" is heuristic-strong (not minimax) for
  caro; reflected in copy.
