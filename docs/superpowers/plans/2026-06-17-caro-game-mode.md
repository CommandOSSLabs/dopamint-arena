# Caro (Five-in-a-Row) Game Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a configurable-size Caro (gomoku / five-in-a-row) bot-vs-bot game type to the ticTacToe app, settled on-chain through the existing Sui Tunnel flow, without touching the repo core.

**Architecture:** New isolated `caro/` module in `@ttt/shared` (board logic, a `CaroProtocol` + `MultiGameCaroProtocol` implementing the SDK `Protocol` interface, and a heuristic bot), plus a parallel `useCaroBotGame` client hook and a `CaroBoard` component. The shipping 3×3 TicTacToe stack is untouched; the client selects the active game by a new `gameType` flag.

**Tech Stack:** TypeScript, `@ttt/shared` (bun test), React client (vite + bun), `sui-tunnel-ts` SDK (vendored copy at `frontend/src/games/ticTacToe/reference/sui-tunnel-ts`), Sui testnet tunnel package `0x0b89fe86…a5a22b`.

**Spec:** `docs/superpowers/specs/2026-06-17-caro-game-mode-design.md`

**Conventions:** Conventional Commits, subject ≤ 50 chars, **no AI attribution**. Do **not** `git add -A`; stage only the listed files. Do not stage `sui-tunnel-ts/**` or `sui_tunnel/**`. Do not push.

**Marks convention:** `0` = empty, `1` = party A (Bot X), `2` = party B (Bot O). `winner`: `0` none, `1` A, `2` B, `3` draw.

**Paths (relative to repo root):**
- Shared: `frontend/src/games/ticTacToe/packages/shared/src/caro/`
- Client: `frontend/src/games/ticTacToe/packages/client/src/`

**How to run shared tests:**
- All: `cd frontend/src/games/ticTacToe/packages/shared && bun test`
- One file: `cd frontend/src/games/ticTacToe/packages/shared && bun test src/caro/board.test.ts`

---

## Task 1: Caro board logic (`caro/board.ts`)

**Files:**
- Create: `frontend/src/games/ticTacToe/packages/shared/src/caro/board.ts`
- Test: `frontend/src/games/ticTacToe/packages/shared/src/caro/board.test.ts`

- [ ] **Step 1: Write the failing test**

Create `caro/board.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { winnerAround, winningLine, isFull, inBounds, applyMark } from "./board";

// Helper: empty size*size board.
const empty = (size: number) => new Array(size * size).fill(0) as number[];
const idx = (size: number, r: number, c: number) => r * size + c;

describe("caro board", () => {
  it("inBounds rejects off-grid coordinates", () => {
    expect(inBounds(15, 0, 0)).toBe(true);
    expect(inBounds(15, 14, 14)).toBe(true);
    expect(inBounds(15, -1, 0)).toBe(false);
    expect(inBounds(15, 0, 15)).toBe(false);
  });

  it("applyMark returns a new board without mutating the input", () => {
    const b = empty(15);
    const b2 = applyMark(b, 7, 1);
    expect(b2[7]).toBe(1);
    expect(b[7]).toBe(0); // original untouched
    expect(b2).not.toBe(b);
  });

  it("detects a horizontal five-in-a-row through the last move", () => {
    const size = 15;
    let b = empty(size);
    // Place marks at row 2, cols 3..7; last move = col 7.
    for (let c = 3; c <= 7; c++) b = applyMark(b, idx(size, 2, c), 1);
    expect(winnerAround(b, size, idx(size, 2, 7))).toBe(1);
  });

  it("detects vertical and both diagonals", () => {
    const size = 15;
    // Vertical col 5, rows 4..8.
    let v = empty(size);
    for (let r = 4; r <= 8; r++) v = applyMark(v, idx(size, r, 5), 2);
    expect(winnerAround(v, size, idx(size, 8, 5))).toBe(2);

    // Down-right diagonal (1,1).
    let d1 = empty(size);
    for (let k = 0; k < 5; k++) d1 = applyMark(d1, idx(size, 1 + k, 1 + k), 1);
    expect(winnerAround(d1, size, idx(size, 5, 5))).toBe(1);

    // Down-left diagonal (1,-1).
    let d2 = empty(size);
    for (let k = 0; k < 5; k++) d2 = applyMark(d2, idx(size, 1 + k, 10 - k), 2);
    expect(winnerAround(d2, size, idx(size, 5, 6))).toBe(2);
  });

  it("counts an overline (6 in a row) as a win (free-style)", () => {
    const size = 15;
    let b = empty(size);
    for (let c = 2; c <= 7; c++) b = applyMark(b, idx(size, 0, c), 1); // 6 marks
    expect(winnerAround(b, size, idx(size, 0, 7))).toBe(1);
  });

  it("does not fire on only four in a row", () => {
    const size = 15;
    let b = empty(size);
    for (let c = 3; c <= 6; c++) b = applyMark(b, idx(size, 2, c), 1); // 4 marks
    expect(winnerAround(b, size, idx(size, 2, 6))).toBe(0);
  });

  it("does not wrap around the right edge", () => {
    const size = 15;
    let b = empty(size);
    // cols 13,14 of row 3 and cols 0,1,2 of row 4 are NOT contiguous.
    b = applyMark(b, idx(size, 3, 13), 1);
    b = applyMark(b, idx(size, 3, 14), 1);
    b = applyMark(b, idx(size, 4, 0), 1);
    b = applyMark(b, idx(size, 4, 1), 1);
    b = applyMark(b, idx(size, 4, 2), 1);
    expect(winnerAround(b, size, idx(size, 4, 2))).toBe(0);
  });

  it("isFull is true only when no empty cell remains", () => {
    expect(isFull(empty(3))).toBe(false);
    expect(isFull(new Array(9).fill(1))).toBe(true);
  });

  it("returns 0 for an empty / out-of-range last index", () => {
    expect(winnerAround(empty(15), 15, -1)).toBe(0);
    expect(winnerAround(empty(15), 15, 0)).toBe(0); // cell is empty
  });

  it("winningLine returns the cells of the 5-run through the last move", () => {
    const size = 15;
    let b = empty(size);
    for (let c = 3; c <= 7; c++) b = applyMark(b, idx(size, 2, c), 1);
    const line = winningLine(b, size, idx(size, 2, 7)).sort((x, y) => x - y);
    expect(line).toEqual([3, 4, 5, 6, 7].map((c) => idx(size, 2, c)));
  });

  it("winningLine is empty when the last move does not complete five", () => {
    const size = 15;
    let b = empty(size);
    for (let c = 3; c <= 6; c++) b = applyMark(b, idx(size, 2, c), 1); // only four
    expect(winningLine(b, size, idx(size, 2, 6))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend/src/games/ticTacToe/packages/shared && bun test src/caro/board.test.ts`
Expected: FAIL — `Cannot find module "./board"`.

- [ ] **Step 3: Implement `caro/board.ts`**

```ts
/**
 * Caro (gomoku) board primitives. The board is a flat `size*size` array of marks
 * (0 empty, 1 party A, 2 party B). Win-check is O(1): it scans outward from the cell
 * just played, so it scales to any board size.
 */

export type CaroBoard = number[]; // length size*size, values 0|1|2

// The four axes to test for a run: horizontal, vertical, and both diagonals.
const DIRS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
];

export function inBounds(size: number, r: number, c: number): boolean {
  return r >= 0 && r < size && c >= 0 && c < size;
}

/** Pure: a copy of `board` with `idx` set to `mark`. */
export function applyMark(board: CaroBoard, idx: number, mark: number): CaroBoard {
  const next = board.slice();
  next[idx] = mark;
  return next;
}

export function isFull(board: CaroBoard): boolean {
  return board.every((v) => v !== 0);
}

/**
 * If the mark at `idx` completes a run of 5 OR MORE (free-style) along any axis,
 * return that mark; otherwise 0. Only scans around `idx`, so cost is O(1) per move.
 * Returns 0 if `idx` is out of range or empty.
 */
export function winnerAround(board: CaroBoard, size: number, idx: number): number {
  if (idx < 0 || idx >= size * size) return 0;
  const mark = board[idx];
  if (mark === 0) return 0;
  const r0 = Math.floor(idx / size);
  const c0 = idx % size;
  for (const [dr, dc] of DIRS) {
    let count = 1;
    let r = r0 + dr;
    let c = c0 + dc;
    while (inBounds(size, r, c) && board[r * size + c] === mark) {
      count++;
      r += dr;
      c += dc;
    }
    r = r0 - dr;
    c = c0 - dc;
    while (inBounds(size, r, c) && board[r * size + c] === mark) {
      count++;
      r -= dr;
      c -= dc;
    }
    if (count >= 5) return mark;
  }
  return 0;
}

/**
 * The cells forming the 5+ run through `idx` (the winning line), or `[]` if the mark at
 * `idx` does not complete a five. Naturally empty mid-game (a non-winning last move has no
 * 5-run), so the UI can call it every render and only highlights once a game is won.
 */
export function winningLine(board: CaroBoard, size: number, idx: number): number[] {
  if (idx < 0 || idx >= size * size) return [];
  const mark = board[idx];
  if (mark === 0) return [];
  const r0 = Math.floor(idx / size);
  const c0 = idx % size;
  for (const [dr, dc] of DIRS) {
    const line = [idx];
    let r = r0 + dr;
    let c = c0 + dc;
    while (inBounds(size, r, c) && board[r * size + c] === mark) {
      line.push(r * size + c);
      r += dr;
      c += dc;
    }
    r = r0 - dr;
    c = c0 - dc;
    while (inBounds(size, r, c) && board[r * size + c] === mark) {
      line.push(r * size + c);
      r -= dr;
      c -= dc;
    }
    if (line.length >= 5) return line;
  }
  return [];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend/src/games/ticTacToe/packages/shared && bun test src/caro/board.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/ticTacToe/packages/shared/src/caro/board.ts \
        frontend/src/games/ticTacToe/packages/shared/src/caro/board.test.ts
git commit -m "feat(caro): board with O(1) five-in-a-row check"
```

---

## Task 2: Single-game `CaroProtocol` (`caro/protocol.ts`)

**Files:**
- Create: `frontend/src/games/ticTacToe/packages/shared/src/caro/protocol.ts`
- Test: `frontend/src/games/ticTacToe/packages/shared/src/caro/protocol.test.ts`

Implements the SDK `protocols.Protocol<CaroState, CaroMove>`. Stake is fixed at 0 (the board
is the state; per-game score is tracked client-side), so balances are constant — no stake
swap. `encodeState` bakes in `size` and uses a distinct `caro.v1` domain so it can never
collide with a `tic_tac_toe.*` hash.

- [ ] **Step 1: Write the failing test**

Create `caro/protocol.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { protocols } from "sui-tunnel-ts";
import { CaroProtocol, type CaroState } from "./protocol";

const ctx = (a: bigint, b: bigint): protocols.ProtocolContext => ({
  tunnelId: "0xtest",
  initialBalances: { a, b },
});

// Place A at row 0 cols 0..4 (interleaving B elsewhere) to make a horizontal 5.
function playAFive(proto: CaroProtocol, s0: CaroState): CaroState {
  let s = s0;
  const N = s0.size;
  for (let k = 0; k < 4; k++) {
    s = proto.applyMove(s, { cell: 0 * N + k }, "A"); // A extends row 0
    s = proto.applyMove(s, { cell: 5 * N + k }, "B"); // B plays harmlessly on row 5
  }
  s = proto.applyMove(s, { cell: 0 * N + 4 }, "A"); // A's 5th -> win
  return s;
}

describe("CaroProtocol", () => {
  it("initial state is an empty board of the configured size, A to move", () => {
    const proto = new CaroProtocol(15);
    const s = proto.initialState(ctx(1n, 1n));
    expect(s.size).toBe(15);
    expect(s.board.length).toBe(225);
    expect(s.board.every((c) => c === 0)).toBe(true);
    expect(s.turn).toBe("A");
    expect(s.winner).toBe(0);
    expect(s.lastMove).toBe(-1);
    expect(s.movesCount).toBe(0);
  });

  it("rejects out-of-range, occupied, and wrong-turn moves", () => {
    const proto = new CaroProtocol(15);
    const s0 = proto.initialState(ctx(1n, 1n));
    expect(() => proto.applyMove(s0, { cell: -1 }, "A")).toThrow();
    expect(() => proto.applyMove(s0, { cell: 225 }, "A")).toThrow();
    expect(() => proto.applyMove(s0, { cell: 0 }, "B")).toThrow(); // A starts
    const s1 = proto.applyMove(s0, { cell: 0 }, "A");
    expect(() => proto.applyMove(s1, { cell: 0 }, "B")).toThrow(); // occupied
    expect(() => proto.applyMove(s1, { cell: 1 }, "A")).toThrow(); // not A's turn
  });

  it("a winning move sets winner and makes the state terminal", () => {
    const proto = new CaroProtocol(15);
    const s = playAFive(proto, proto.initialState(ctx(1n, 1n)));
    expect(s.winner).toBe(1);
    expect(proto.isTerminal(s)).toBe(true);
    expect(() => proto.applyMove(s, { cell: 100 }, "B")).toThrow(); // game over
  });

  it("declares a draw when the board fills with no five", () => {
    // 3x3 can never make 5, so a full board is always a draw — handy for the test.
    const proto = new CaroProtocol(3);
    let s = proto.initialState(ctx(1n, 1n));
    const order: Array<[number, "A" | "B"]> = [
      [0, "A"], [1, "B"], [2, "A"],
      [4, "B"], [3, "A"], [5, "B"],
      [7, "A"], [6, "B"], [8, "A"],
    ];
    for (const [cell, by] of order) s = proto.applyMove(s, { cell }, by);
    expect(s.winner).toBe(3);
    expect(proto.isTerminal(s)).toBe(true);
  });

  it("balances are constant and sum to the locked total", () => {
    const proto = new CaroProtocol(15);
    const s = playAFive(proto, proto.initialState(ctx(1n, 1n)));
    expect(proto.balances(s)).toEqual({ a: 1n, b: 1n });
  });

  it("encodeState is deterministic, changes with the board, and bakes in size", () => {
    const p15 = new CaroProtocol(15);
    const s0 = p15.initialState(ctx(1n, 1n));
    expect(p15.encodeState(s0)).toEqual(p15.encodeState({ ...s0, board: s0.board.slice() }));
    const s1 = p15.applyMove(s0, { cell: 0 }, "A");
    expect(p15.encodeState(s1)).not.toEqual(p15.encodeState(s0));

    // Same logical empty board but different size -> different bytes.
    const p19 = new CaroProtocol(19);
    const e15 = p15.encodeState(s0);
    const e19 = p19.encodeState(p19.initialState(ctx(1n, 1n)));
    expect(e15).not.toEqual(e19);
  });

  it("does not collide with a TicTacToe encoding for an empty board", () => {
    const caro = new CaroProtocol(3);
    const ttt = new protocols.TicTacToeProtocol(0n);
    const cEnc = caro.encodeState(caro.initialState(ctx(1n, 1n)));
    const tEnc = ttt.encodeState(ttt.initialState(ctx(1n, 1n)));
    expect(cEnc).not.toEqual(tEnc); // distinct domain tags
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend/src/games/ticTacToe/packages/shared && bun test src/caro/protocol.test.ts`
Expected: FAIL — `Cannot find module "./protocol"`.

- [ ] **Step 3: Implement `CaroProtocol` in `caro/protocol.ts`**

```ts
/**
 * Caro (five-in-a-row) protocols, game-side (NOT in the SDK). `CaroProtocol` is one game;
 * `MultiGameCaroProtocol` (Task 3) plays N of them in one tunnel. Both implement the SDK's
 * `Protocol` interface so they drop straight into `OffchainTunnel.selfPlay`.
 *
 * Stake is fixed at 0: the board is the only meaningful state, balances stay constant, and
 * per-game wins are tracked client-side (like the existing TicTacToe arena). encodeState uses
 * a distinct `caro.v1` domain and bakes in the board size, so a caro hash can never collide
 * with a TicTacToe hash or with a caro game of a different size.
 */

import { core, protocols } from "sui-tunnel-ts";
import { winnerAround, applyMark } from "./board";

type Protocol<State, Move> = protocols.Protocol<State, Move>;
type Party = protocols.Party;
type Balances = protocols.Balances;
type ProtocolContext = protocols.ProtocolContext;

export interface CaroState {
  board: number[]; // length size*size, values 0|1|2
  size: number; // board edge length
  turn: "A" | "B"; // side to move
  winner: number; // 0 none | 1 A | 2 B | 3 draw
  lastMove: number; // last placed index, -1 at start (UI highlight + O(1) win-check)
  movesCount: number; // placed stones; == size*size means full -> draw
  balanceA: bigint;
  balanceB: bigint;
  stake: bigint; // always 0n for caro
}

export type CaroMove = { cell: number };

const DOMAIN = protocols.protocolDomain("caro.v1");

export class CaroProtocol implements Protocol<CaroState, CaroMove> {
  readonly name = "caro.v1";
  private readonly size: number;

  /** @param boardSize edge length of the square board (the client clamps to 9–29; the
   *  protocol allows >= 3 so a 3×3 — which can never make five — is a valid draw fixture). */
  constructor(boardSize: number = 15) {
    if (!Number.isInteger(boardSize) || boardSize < 3) {
      throw new Error("caro board size must be an integer >= 3");
    }
    this.size = boardSize;
  }

  initialState(ctx: ProtocolContext): CaroState {
    return {
      board: new Array(this.size * this.size).fill(0),
      size: this.size,
      turn: "A",
      winner: 0,
      lastMove: -1,
      movesCount: 0,
      balanceA: ctx.initialBalances.a,
      balanceB: ctx.initialBalances.b,
      stake: 0n,
    };
  }

  applyMove(state: CaroState, move: CaroMove, by: Party): CaroState {
    if (state.winner !== 0) throw new Error("caro: game already over");
    if (by !== state.turn) throw new Error("caro: not this party's turn");
    const { cell } = move;
    if (!Number.isInteger(cell) || cell < 0 || cell >= state.size * state.size) {
      throw new Error("caro: cell out of range");
    }
    if (state.board[cell] !== 0) throw new Error("caro: cell occupied");

    const mark = by === "A" ? 1 : 2;
    const board = applyMark(state.board, cell, mark);
    const movesCount = state.movesCount + 1;
    let winner = winnerAround(board, state.size, cell);
    if (winner === 0 && movesCount === state.size * state.size) winner = 3; // draw

    return {
      ...state,
      board,
      movesCount,
      winner,
      lastMove: cell,
      turn: by === "A" ? "B" : "A",
    };
  }

  encodeState(state: CaroState): Uint8Array {
    return core.concatBytes([
      DOMAIN,
      protocols.lengthPrefixedConcat([
        core.u64ToBeBytes(state.size),
        Uint8Array.from(state.board),
        Uint8Array.from([state.turn === "A" ? 0 : 1, state.winner]),
        core.u64ToBeBytes(state.balanceA),
        core.u64ToBeBytes(state.balanceB),
        core.u64ToBeBytes(state.stake),
      ]),
    ]);
  }

  balances(state: CaroState): Balances {
    return { a: state.balanceA, b: state.balanceB };
  }

  isTerminal(state: CaroState): boolean {
    return state.winner !== 0;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend/src/games/ticTacToe/packages/shared && bun test src/caro/protocol.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/ticTacToe/packages/shared/src/caro/protocol.ts \
        frontend/src/games/ticTacToe/packages/shared/src/caro/protocol.test.ts
git commit -m "feat(caro): single-game CaroProtocol over the tunnel"
```

---

## Task 3: `MultiGameCaroProtocol` (N games per tunnel)

**Files:**
- Modify: `frontend/src/games/ticTacToe/packages/shared/src/caro/protocol.ts` (append the class)
- Test: `frontend/src/games/ticTacToe/packages/shared/src/caro/multiGame.test.ts`

Mirrors `MultiGameTicTacToeProtocol`: composes `CaroProtocol`, plays `maxGames` games in one
tunnel, resets to a fresh board between games carrying balances forward, and is terminal only
after the last game. Distinct `caro.multi.v1` domain.

- [ ] **Step 1: Write the failing test**

Create `caro/multiGame.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { protocols } from "sui-tunnel-ts";
import { MultiGameCaroProtocol, type MultiGameCaroState } from "./protocol";

const ctx = (a: bigint, b: bigint): protocols.ProtocolContext => ({
  tunnelId: "0xtest",
  initialBalances: { a, b },
});

// A makes a horizontal 5 on row 0; B plays harmlessly on row 5. Returns post-win state.
function playAFive(
  proto: MultiGameCaroProtocol,
  s0: MultiGameCaroState,
): MultiGameCaroState {
  let s = s0;
  const N = s0.inner.size;
  for (let k = 0; k < 4; k++) {
    s = proto.applyMove(s, { cell: 0 * N + k }, "A");
    s = proto.applyMove(s, { cell: 5 * N + k }, "B");
  }
  return proto.applyMove(s, { cell: 0 * N + 4 }, "A");
}

describe("MultiGameCaroProtocol", () => {
  it("is not terminal after one finished game when maxGames > 1", () => {
    const proto = new MultiGameCaroProtocol(3, 15);
    const s = playAFive(proto, proto.initialState(ctx(1n, 1n)));
    expect(proto.isTerminal(s)).toBe(false);
    expect(s.inner.winner).toBe(1);
  });

  it("advances to a fresh board carrying balances forward", () => {
    const proto = new MultiGameCaroProtocol(3, 15);
    let s = playAFive(proto, proto.initialState(ctx(1n, 1n)));
    const balBefore = proto.balances(s);
    s = proto.applyMove(s, { cell: 0 }, "A"); // advance trigger
    expect(s.gamesPlayed).toBe(1);
    expect(s.inner.winner).toBe(0);
    expect(s.inner.movesCount).toBe(0);
    expect(s.inner.board.every((c) => c === 0)).toBe(true);
    expect(proto.balances(s)).toEqual(balBefore);
  });

  it("becomes terminal only after the last of N games", () => {
    const proto = new MultiGameCaroProtocol(2, 15);
    let s = playAFive(proto, proto.initialState(ctx(1n, 1n)));
    expect(proto.isTerminal(s)).toBe(false);
    s = proto.applyMove(s, { cell: 0 }, "A"); // advance to game 2
    s = playAFive(proto, s);
    expect(proto.isTerminal(s)).toBe(true);
  });

  it("throws on an advance move once the session is terminal", () => {
    const proto = new MultiGameCaroProtocol(1, 15);
    const s = playAFive(proto, proto.initialState(ctx(1n, 1n)));
    expect(proto.isTerminal(s)).toBe(true);
    expect(() => proto.applyMove(s, { cell: 0 }, "A")).toThrow();
  });

  it("encodeState is deterministic and distinguishes gamesPlayed", () => {
    const proto = new MultiGameCaroProtocol(3, 15);
    const s = playAFive(proto, proto.initialState(ctx(1n, 1n)));
    const enc1 = proto.encodeState(s);
    expect(proto.encodeState({ ...s, inner: { ...s.inner } })).toEqual(enc1);
    const advanced = proto.applyMove(s, { cell: 0 }, "A");
    expect(proto.encodeState(advanced)).not.toEqual(enc1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend/src/games/ticTacToe/packages/shared && bun test src/caro/multiGame.test.ts`
Expected: FAIL — `MultiGameCaroProtocol` / `MultiGameCaroState` not exported.

- [ ] **Step 3: Append `MultiGameCaroProtocol` to `caro/protocol.ts`**

Add to the END of `caro/protocol.ts`:

```ts
export interface MultiGameCaroState {
  inner: CaroState;
  gamesPlayed: number;
  maxGames: number;
}

export type MultiGameCaroMove = CaroMove;

const MULTI_DOMAIN = protocols.protocolDomain("caro.multi.v1");

/** Plays `maxGames` Caro games over one tunnel, composing `CaroProtocol`. */
export class MultiGameCaroProtocol
  implements Protocol<MultiGameCaroState, MultiGameCaroMove>
{
  readonly name = "caro.multi.v1";
  private readonly inner: CaroProtocol;
  private readonly maxGames: number;

  /**
   * @param maxGames  games to play in one tunnel (>= 1)
   * @param boardSize edge length passed to the inner CaroProtocol
   */
  constructor(maxGames: number, boardSize: number = 15) {
    if (!Number.isInteger(maxGames) || maxGames < 1) {
      throw new Error("maxGames must be a positive integer");
    }
    this.maxGames = maxGames;
    this.inner = new CaroProtocol(boardSize);
  }

  initialState(ctx: ProtocolContext): MultiGameCaroState {
    return { inner: this.inner.initialState(ctx), gamesPlayed: 0, maxGames: this.maxGames };
  }

  applyMove(
    state: MultiGameCaroState,
    move: MultiGameCaroMove,
    by: Party,
  ): MultiGameCaroState {
    if (!this.inner.isTerminal(state.inner)) {
      return { ...state, inner: this.inner.applyMove(state.inner, move, by) };
    }
    if (this.isTerminal(state)) {
      throw new Error("caro session over: no more games can be played");
    }
    // Reset to a fresh board, carrying balances forward (stake is 0, so they are unchanged).
    const carried = this.inner.initialState({
      tunnelId: "",
      initialBalances: { a: state.inner.balanceA, b: state.inner.balanceB },
    });
    return { inner: carried, gamesPlayed: state.gamesPlayed + 1, maxGames: state.maxGames };
  }

  encodeState(state: MultiGameCaroState): Uint8Array {
    return core.concatBytes([
      MULTI_DOMAIN,
      protocols.lengthPrefixedConcat([
        this.inner.encodeState(state.inner),
        core.u64ToBeBytes(state.gamesPlayed),
      ]),
    ]);
  }

  balances(state: MultiGameCaroState): Balances {
    return this.inner.balances(state.inner);
  }

  isTerminal(state: MultiGameCaroState): boolean {
    if (!this.inner.isTerminal(state.inner)) return false;
    return state.gamesPlayed + 1 >= state.maxGames;
  }

  randomMove(
    state: MultiGameCaroState,
    by: Party,
    _rng: () => number,
  ): MultiGameCaroMove | null {
    if (this.isTerminal(state)) return null;
    // Between games only A drives the advance (mirrors TTT); mid-game the hook supplies moves.
    if (this.inner.isTerminal(state.inner)) return by === "A" ? { cell: 0 } : null;
    // Mid-game fallback: first empty cell (the real bot uses caro/bot.ts instead).
    const i = state.inner.board.findIndex((c) => c === 0);
    return i >= 0 ? { cell: i } : null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend/src/games/ticTacToe/packages/shared && bun test src/caro/multiGame.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/ticTacToe/packages/shared/src/caro/protocol.ts \
        frontend/src/games/ticTacToe/packages/shared/src/caro/multiGame.test.ts
git commit -m "feat(caro): multi-game protocol for N games per tunnel"
```

---

## Task 4: Heuristic bot (`caro/bot.ts`)

**Files:**
- Create: `frontend/src/games/ticTacToe/packages/shared/src/caro/bot.ts`
- Test: `frontend/src/games/ticTacToe/packages/shared/src/caro/bot.test.ts`

A threat-scoring picker (no minimax). Candidates are limited to the neighborhood of placed
stones (radius 2 for `strong`, 1 for `weak`); first move is the center. Each candidate scores
the best run it makes for the mover and the best it blocks for the opponent.

- [ ] **Step 1: Write the failing test**

Create `caro/bot.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { CaroProtocol } from "./protocol";
import { pickCaroMove } from "./bot";

const ctx = { tunnelId: "0xtest", initialBalances: { a: 1n, b: 1n } };
const det = () => 0; // deterministic rng for tests
const idx = (size: number, r: number, c: number) => r * size + c;

describe("pickCaroMove", () => {
  it("opens at the center on an empty board", () => {
    const s = new CaroProtocol(15).initialState(ctx);
    const center = Math.floor((15 * 15) / 2);
    expect(pickCaroMove(s, "A", det, "strong")).toBe(center);
  });

  it("takes the immediate winning move (completes five)", () => {
    const proto = new CaroProtocol(15);
    let s = proto.initialState(ctx);
    // A at row 7 cols 3..6 (open four); B harmless on row 9. A to move.
    for (let k = 0; k < 4; k++) {
      s = proto.applyMove(s, { cell: idx(15, 7, 3 + k) }, "A");
      if (k < 3) s = proto.applyMove(s, { cell: idx(15, 9, k) }, "B");
    }
    // Now it's B's turn after 4 A-moves + 3 B-moves -> make it A's turn:
    s = proto.applyMove(s, { cell: idx(15, 9, 3) }, "B");
    expect(s.turn).toBe("A");
    const move = pickCaroMove(s, "A", det, "strong");
    // Completing the run at col 2 or col 7 both make five.
    expect([idx(15, 7, 2), idx(15, 7, 7)]).toContain(move);
  });

  it("blocks the opponent's open four when it has no win of its own", () => {
    const proto = new CaroProtocol(15);
    let s = proto.initialState(ctx);
    // B builds an open four on row 7 cols 3..6; A plays scattered, no threat.
    s = proto.applyMove(s, { cell: idx(15, 0, 0) }, "A");
    s = proto.applyMove(s, { cell: idx(15, 7, 3) }, "B");
    s = proto.applyMove(s, { cell: idx(15, 0, 2) }, "A");
    s = proto.applyMove(s, { cell: idx(15, 7, 4) }, "B");
    s = proto.applyMove(s, { cell: idx(15, 0, 4) }, "A");
    s = proto.applyMove(s, { cell: idx(15, 7, 5) }, "B");
    s = proto.applyMove(s, { cell: idx(15, 0, 6) }, "A");
    s = proto.applyMove(s, { cell: idx(15, 7, 6) }, "B");
    expect(s.turn).toBe("A");
    const move = pickCaroMove(s, "A", det, "strong");
    expect([idx(15, 7, 2), idx(15, 7, 7)]).toContain(move); // block an open end
  });

  it("always returns a legal empty cell", () => {
    const proto = new CaroProtocol(9);
    let s = proto.initialState(ctx);
    s = proto.applyMove(s, { cell: 40 }, "A");
    const move = pickCaroMove(s, "B", det, "weak");
    expect(s.board[move]).toBe(0);
    expect(move).toBeGreaterThanOrEqual(0);
    expect(move).toBeLessThan(81);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend/src/games/ticTacToe/packages/shared && bun test src/caro/bot.test.ts`
Expected: FAIL — `Cannot find module "./bot"`.

- [ ] **Step 3: Implement `caro/bot.ts`**

```ts
/**
 * Heuristic caro bot: a one-ply threat score (no minimax, which cannot scale to a large
 * board). Candidate cells are limited to the neighborhood of existing stones, and each is
 * scored by the best run it makes for the mover plus the best it denies the opponent.
 */

import { inBounds } from "./board";
import type { CaroState } from "./protocol";

const DIRS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 0],
  [1, 1],
  [1, -1],
];

export type BotStrength = "strong" | "weak";

// Run length + how many of its two ends are open, treating `idx` as if it held `mark`.
function lineInfo(
  board: number[],
  size: number,
  idx: number,
  dr: number,
  dc: number,
  mark: number,
): { run: number; openEnds: number } {
  const r0 = Math.floor(idx / size);
  const c0 = idx % size;
  let run = 1;
  let r = r0 + dr;
  let c = c0 + dc;
  while (inBounds(size, r, c) && board[r * size + c] === mark) {
    run++;
    r += dr;
    c += dc;
  }
  const fwdOpen = inBounds(size, r, c) && board[r * size + c] === 0;
  r = r0 - dr;
  c = c0 - dc;
  while (inBounds(size, r, c) && board[r * size + c] === mark) {
    run++;
    r -= dr;
    c -= dc;
  }
  const bwdOpen = inBounds(size, r, c) && board[r * size + c] === 0;
  return { run, openEnds: (fwdOpen ? 1 : 0) + (bwdOpen ? 1 : 0) };
}

function patternValue(run: number, openEnds: number): number {
  if (run >= 5) return 100000; // completes five -> win
  if (run === 4) return openEnds >= 1 ? 9000 : 200; // four (open or single-blocked)
  if (run === 3) return openEnds === 2 ? 1500 : 150; // open three vs blocked three
  if (run === 2) return openEnds === 2 ? 200 : 30;
  return openEnds === 2 ? 20 : 5; // lone stone, prefer open space
}

// Best single-axis pattern value for placing `mark` at `idx`.
function moveScore(board: number[], size: number, idx: number, mark: number): number {
  let best = 0;
  for (const [dr, dc] of DIRS) {
    const { run, openEnds } = lineInfo(board, size, idx, dr, dc, mark);
    best = Math.max(best, patternValue(run, openEnds));
  }
  return best;
}

// Empty cells within Chebyshev distance `radius` of any stone.
function candidates(board: number[], size: number, radius: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < board.length; i++) {
    if (board[i] !== 0) continue;
    const r0 = Math.floor(i / size);
    const c0 = i % size;
    let near = false;
    for (let dr = -radius; dr <= radius && !near; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (dr === 0 && dc === 0) continue;
        const r = r0 + dr;
        const c = c0 + dc;
        if (inBounds(size, r, c) && board[r * size + c] !== 0) {
          near = true;
          break;
        }
      }
    }
    if (near) out.push(i);
  }
  return out;
}

/**
 * Pick a move (flat index) for `by`. `strong` searches radius 2 and weighs offense+defense;
 * `weak` searches radius 1 with slightly less defensive weight. `rng` only breaks ties so
 * equal-scoring openings vary between games.
 */
export function pickCaroMove(
  state: CaroState,
  by: "A" | "B",
  rng: () => number,
  strength: BotStrength,
): number {
  const { board, size } = state;
  const me = by === "A" ? 1 : 2;
  const opp = me === 1 ? 2 : 1;

  if (state.movesCount === 0) return Math.floor((size * size) / 2); // center opening

  const radius = strength === "strong" ? 2 : 1;
  const defenseWeight = strength === "strong" ? 0.95 : 0.85;
  let cells = candidates(board, size, radius);
  if (cells.length === 0) cells = board.map((_, i) => i).filter((i) => board[i] === 0);

  let bestCell = cells[0];
  let bestScore = -Infinity;
  for (const i of cells) {
    const score =
      moveScore(board, size, i, me) + defenseWeight * moveScore(board, size, i, opp);
    // Tie-break with a small rng jitter so identical scores diversify.
    const jittered = score + rng() * 0.5;
    if (jittered > bestScore) {
      bestScore = jittered;
      bestCell = i;
    }
  }
  return bestCell;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend/src/games/ticTacToe/packages/shared && bun test src/caro/bot.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/ticTacToe/packages/shared/src/caro/bot.ts \
        frontend/src/games/ticTacToe/packages/shared/src/caro/bot.test.ts
git commit -m "feat(caro): threat-scoring heuristic bot"
```

---

## Task 5: Export the caro module from `@ttt/shared`

**Files:**
- Modify: `frontend/src/games/ticTacToe/packages/shared/src/index.ts`

- [ ] **Step 1: Add the exports**

In `src/index.ts`, after the existing `ttt/*` exports (after line `export * from "./ttt/multiGameProtocol";`), add:

```ts
export * from "./caro/board";
export * from "./caro/protocol";
export * from "./caro/bot";
```

- [ ] **Step 2: Typecheck + run the whole shared suite**

Run: `cd frontend/src/games/ticTacToe/packages/shared && bun run typecheck && bun test`
Expected: typecheck clean; ALL tests pass (existing TTT + new caro).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/games/ticTacToe/packages/shared/src/index.ts
git commit -m "feat(caro): export caro module from shared"
```

---

## Task 6: `CaroBoard` component

**Files:**
- Create: `frontend/src/games/ticTacToe/packages/client/src/components/CaroBoard.tsx`

A fit-to-card `size×size` grid. Marks render as `✕` (1, Bot X) / `◯` (2, Bot O). The last move
is highlighted; the board scrolls inside a fixed frame if it exceeds the card. No unit test
(the client has no component test harness); verified by typecheck + build + manual smoke.

- [ ] **Step 1: Implement the component**

```tsx
import { winningLine } from "@ttt/shared";

// Caro board: a fit-to-card size×size grid. Marks: 1 = Bot X (✕), 2 = Bot O (◯).
// The last move is highlighted; once a game is won, the 5-in-a-row line is highlighted too
// (winningLine is empty mid-game). Read-only (bot-vs-bot); cells aren't clickable.
export function CaroBoard({
  board,
  size,
  lastMove,
}: {
  board: number[];
  size: number;
  lastMove: number;
}) {
  // Cell size shrinks as the board grows so a 25×25 still fits ~460px; min 14px keeps marks
  // legible (a frame scrolls if the grid exceeds the frame).
  const cell = Math.max(14, Math.floor(460 / size));
  const dim = cell * size;
  const win = new Set(winningLine(board, size, lastMove));
  return (
    <div className="max-w-full max-h-[480px] overflow-auto border-[2px] border-primary rounded-sm bg-surface p-1">
      <div
        className="grid"
        style={{
          gridTemplateColumns: `repeat(${size}, ${cell}px)`,
          gridTemplateRows: `repeat(${size}, ${cell}px)`,
          width: dim,
          height: dim,
        }}
      >
        {board.map((v, i) => (
          <div
            key={i}
            className={`flex items-center justify-center border border-primary/15 ${
              win.has(i) ? "bg-secondary/40" : i === lastMove ? "bg-tertiary/30" : ""
            }`}
            style={{ fontSize: Math.floor(cell * 0.7), lineHeight: 1 }}
          >
            {v === 1 ? (
              <span className="text-primary font-bold">✕</span>
            ) : v === 2 ? (
              <span className="text-secondary font-bold">◯</span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend/src/games/ticTacToe && bun run --cwd packages/client typecheck`
Expected: clean (component compiles; it's not imported yet).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/games/ticTacToe/packages/client/src/components/CaroBoard.tsx
git commit -m "feat(caro): CaroBoard grid component"
```

---

## Task 7: `useCaroBotGame` hook

**Files:**
- Create: `frontend/src/games/ticTacToe/packages/client/src/hooks/useCaroBotGame.ts`

Parallel to `useBotGame.ts` (read that file as the template). Same orchestration
(create_and_fund → animated self-play → `update_state` → `close_with_root`, auto-loop, gas
guards, `maxGames` per tunnel, digests), but drives `MultiGameCaroProtocol` with `pickCaroMove`
and exposes `boardSize` + `lastMove`. Reuses the game-agnostic libs `@/lib/bots`, `@/lib/tunnel`
unchanged.

- [ ] **Step 1: Implement the hook**

```ts
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { core, proof, bytesToHex } from "sui-tunnel-ts";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { Transaction } from "@mysten/sui/transactions";
import {
  MultiGameCaroProtocol,
  type MultiGameCaroState,
  pickCaroMove,
  type BotStrength,
} from "@ttt/shared";
import {
  buildCreateAndFundTx,
  buildSettleWithRootTx,
  buildUpdateStateTx,
  parseTunnelId,
} from "@/lib/tunnel";
import {
  loadOrCreateBots,
  getSuiClient,
  botBalances,
  fundBots,
  transferBetweenBots,
  type BotIdentity,
} from "@/lib/bots";
import type { Difficulty } from "@/hooks/useBotGame";
import type { BotPhase, BotScore, BotDigests } from "@/hooks/useBotGame";

const DEFAULT_MAX_GAMES = 5;
const MIN_MAX_GAMES = 1;
const MAX_MAX_GAMES = 100;
const DEFAULT_BOARD_SIZE = 15;
const MIN_BOARD_SIZE = 9;
const MAX_BOARD_SIZE = 29;

const SCORE_KEY = "caro_bot_score.v1";
const STEP_MS = 350;
const MIN_PLAY_MIST = 20_000_000n;
const NEXT_GAME_MS = 1200;
// Caro games are long; cap steps so a logic bug can't spin forever (size^2 + advances).
const MAX_STEPS = 2000;

export interface CaroBotGameView {
  board: number[];
  boardSize: number;
  lastMove: number;
  turn: "A" | "B";
  winner: number;
  phase: BotPhase;
  error: string | null;
  digests: BotDigests;
  balances: { x: bigint; o: bigint };
  score: BotScore;
  auto: boolean;
  rebalancing: boolean;
  maxGames: number;
  currentGame: number;
  setMaxGames: (n: number) => void;
  fund: () => void;
  rebalance: () => void;
  refresh: () => Promise<{ x: bigint; o: bigint } | null>;
  resetScore: () => void;
  newGame: () => void;
  startAuto: () => void;
  stopAuto: () => void;
}

function loadScore(): BotScore {
  try {
    const s = localStorage.getItem(SCORE_KEY);
    if (s) return JSON.parse(s) as BotScore;
  } catch {
    /* ignore */
  }
  return { x: 0, o: 0, draws: 0 };
}

// Difficulty -> per-party heuristic strength. No minimax for caro.
function strengthFor(difficulty: Difficulty, by: "A" | "B"): BotStrength {
  if (difficulty === "uneven") return by === "A" ? "strong" : "weak";
  return "strong"; // perfect/even both strong; "even" gets rng jitter at the call site
}

export function useCaroBotGame(
  difficulty: Difficulty = "even",
  boardSize: number = DEFAULT_BOARD_SIZE,
): CaroBotGameView {
  const bots = useMemo(() => loadOrCreateBots(), []);
  const client = useMemo(() => getSuiClient(), []);

  const [board, setBoard] = useState<number[]>(() =>
    new Array(DEFAULT_BOARD_SIZE * DEFAULT_BOARD_SIZE).fill(0),
  );
  const [size, setSize] = useState<number>(DEFAULT_BOARD_SIZE);
  const [lastMove, setLastMove] = useState<number>(-1);
  const [turn, setTurn] = useState<"A" | "B">("A");
  const [winner, setWinner] = useState<number>(0);
  const [phase, setPhase] = useState<BotPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [digests, setDigests] = useState<BotDigests>({});
  const [balances, setBalances] = useState<{ x: bigint; o: bigint }>({ x: 0n, o: 0n });
  const [score, setScore] = useState<BotScore>(loadScore);
  const [auto, setAuto] = useState(false);
  const [rebalancing, setRebalancing] = useState(false);
  const [maxGames, setMaxGamesState] = useState<number>(DEFAULT_MAX_GAMES);
  const [currentGame, setCurrentGame] = useState<number>(1);

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const nextRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoRef = useRef(false);
  const balancesRef = useRef<{ x: bigint; o: bigint }>({ x: 0n, o: 0n });
  const runRef = useRef<() => void>(() => {});
  const difficultyRef = useRef<Difficulty>(difficulty);
  difficultyRef.current = difficulty;
  const maxGamesRef = useRef<number>(DEFAULT_MAX_GAMES);
  maxGamesRef.current = maxGames;
  const boardSizeRef = useRef<number>(boardSize);
  boardSizeRef.current = Math.max(MIN_BOARD_SIZE, Math.min(MAX_BOARD_SIZE, Math.floor(boardSize)));

  const setMaxGames = useCallback((n: number) => {
    const clamped = Math.max(
      MIN_MAX_GAMES,
      Math.min(MAX_MAX_GAMES, Math.floor(Number.isFinite(n) ? n : DEFAULT_MAX_GAMES)),
    );
    setMaxGamesState(clamped);
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const refreshBalances = useCallback(async () => {
    try {
      const b = await botBalances(client, bots);
      balancesRef.current = b;
      setBalances(b);
      return b;
    } catch {
      return null;
    }
  }, [client, bots]);

  useEffect(() => {
    void refreshBalances();
    return () => {
      stopTimer();
      if (nextRef.current !== null) clearTimeout(nextRef.current);
    };
  }, [refreshBalances, stopTimer]);

  const submit = useCallback(
    async (tx: Transaction, signer: Ed25519Keypair) => {
      const res = await client.signAndExecuteTransaction({
        signer,
        transaction: tx,
        options: { showObjectChanges: true, showEffects: true },
      });
      if (res.effects?.status?.status !== "success") {
        throw new Error(`tx ${res.digest} failed: ${res.effects?.status?.error ?? "unknown"}`);
      }
      await client.waitForTransaction({ digest: res.digest });
      return res;
    },
    [client],
  );

  const fund = useCallback(() => {
    void (async () => {
      setPhase("funding");
      setError(null);
      try {
        await fundBots(client, bots);
        await refreshBalances();
        setPhase("idle");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    })();
  }, [client, bots, refreshBalances]);

  // Run ONE tunnel that plays `maxGames` caro games and settles once.
  const runGame = useCallback(() => {
    stopTimer();
    if (balancesRef.current.x < MIN_PLAY_MIST || balancesRef.current.o < MIN_PLAY_MIST) {
      autoRef.current = false;
      setAuto(false);
      setError("Fund the bots first");
      setPhase("error");
      return;
    }
    const N = boardSizeRef.current;
    setError(null);
    setBoard(new Array(N * N).fill(0));
    setSize(N);
    setLastMove(-1);
    setTurn("A");
    setWinner(0);
    setDigests({});
    setCurrentGame(1);

    const proto = new MultiGameCaroProtocol(maxGamesRef.current, N);

    void (async () => {
      try {
        const partyX = { address: bots.x.address, publicKey: bots.x.publicKey };
        const partyO = { address: bots.o.address, publicKey: bots.o.publicKey };

        // 1) open + fund (both 1-MIST stakes) + activate in ONE tx (bot X signs).
        setPhase("opening");
        const createRes = await submit(buildCreateAndFundTx(partyX, partyO, 1n), bots.x.keypair);
        const tunnelId = parseTunnelId(createRes.objectChanges);
        if (!tunnelId) throw new Error("could not find created Tunnel id");
        setDigests((d) => ({ ...d, create: createRes.digest }));

        // 2) read created_at for the settlement timestamp.
        const obj = await client.getObject({ id: tunnelId, options: { showContent: true } });
        const fields = (obj.data?.content as { fields?: Record<string, unknown> } | undefined)
          ?.fields;
        const createdAt = BigInt((fields?.created_at as string | undefined) ?? 0);

        // 3) off-chain self-play tunnel (both keys local), driving MultiGameCaroProtocol.
        const tunnel = core.OffchainTunnel.selfPlay<MultiGameCaroState, { cell: number }>(
          proto,
          tunnelId,
          bots.x.coreKey,
          bots.o.coreKey,
          bots.x.address,
          bots.o.address,
          { a: 1n, b: 1n },
        );

        const transcript = new proof.Transcript(tunnelId);
        tunnel.onUpdate = (u) => transcript.append(u);

        // 4) animate moves across all N games; each .step co-signs + verifies (mode "full").
        setPhase("playing");
        let lastScoredGame = -1;
        const recordGame = (gameIndex: number, gameWinner: number) => {
          if (gameIndex === lastScoredGame) return;
          lastScoredGame = gameIndex;
          setScore((prev) => {
            const next: BotScore = {
              x: prev.x + (gameWinner === 1 ? 1 : 0),
              o: prev.o + (gameWinner === 2 ? 1 : 0),
              draws: prev.draws + (gameWinner === 3 ? 1 : 0),
            };
            try {
              localStorage.setItem(SCORE_KEY, JSON.stringify(next));
            } catch {
              /* ignore */
            }
            return next;
          });
        };

        await new Promise<void>((resolve, reject) => {
          let steps = 0;
          timerRef.current = setInterval(() => {
            try {
              if (proto.isTerminal(tunnel.state)) {
                stopTimer();
                resolve();
                return;
              }
              if (steps++ >= MAX_STEPS) throw new Error("caro self-play exceeded step bound");
              const inner = tunnel.state.inner;
              const innerOver = inner.winner !== 0;
              // Between games, A drives the advance with any cell; mid-game, the heuristic picks.
              const by: "A" | "B" = innerOver ? "A" : (inner.turn as "A" | "B");
              const cell = innerOver
                ? 0
                : pickCaroMove(inner, by, Math.random, strengthFor(difficultyRef.current, by));
              // Sign each update with the on-chain created_at so update_state's timestamp
              // check passes regardless of local clock skew.
              const r = tunnel.step({ cell }, by, { mode: "full", timestamp: createdAt });
              if (!r.verified) throw new Error(`state ${r.nonce} failed dual-verify`);

              const next = tunnel.state;
              setBoard([...next.inner.board]);
              setSize(next.inner.size);
              setLastMove(next.inner.lastMove);
              setTurn(next.inner.turn as "A" | "B");
              setWinner(next.inner.winner);
              setCurrentGame(next.gamesPlayed + 1);
              if (next.inner.winner !== 0) recordGame(next.gamesPlayed, next.inner.winner);

              if (proto.isTerminal(next)) {
                stopTimer();
                resolve();
              }
            } catch (err) {
              stopTimer();
              reject(err);
            }
          }, STEP_MS);
        });

        const finalInner = tunnel.state.inner;
        setBoard([...finalInner.board]);
        setLastMove(finalInner.lastMove);
        setWinner(finalInner.winner);

        // 5) checkpoint the FINAL co-signed state (update_state) before the root close.
        setPhase("settling");
        const latest = tunnel.latest;
        if (latest) {
          const ures = await submit(buildUpdateStateTx(tunnelId, latest), bots.x.keypair);
          setDigests((d) => ({ ...d, update: ures.digest }));
        }

        // 6) settle: anchor the transcript root AND distribute funds in one cooperative close.
        const root = transcript.root();
        const onchainNonce = latest ? latest.update.nonce : 0n;
        const s = tunnel.buildSettlementWithRoot(createdAt, root, onchainNonce);
        const closeRes = await submit(buildSettleWithRootTx(tunnelId, s), bots.x.keypair);
        setDigests((d) => ({ ...d, close: closeRes.digest, root: `0x${bytesToHex(root)}` }));

        const b = await refreshBalances();
        setPhase("done");

        // 7) auto-play: next tunnel until a bot is low on gas.
        if (autoRef.current) {
          if (b && b.x >= MIN_PLAY_MIST && b.o >= MIN_PLAY_MIST) {
            nextRef.current = setTimeout(() => {
              if (autoRef.current) runRef.current();
            }, NEXT_GAME_MS);
          } else {
            autoRef.current = false;
            setAuto(false);
            setError("A bot is low on gas — auto-play stopped. Fund the bots to continue.");
          }
        }
      } catch (e) {
        stopTimer();
        autoRef.current = false;
        setAuto(false);
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    })();
  }, [bots, client, submit, refreshBalances, stopTimer]);

  useEffect(() => {
    runRef.current = runGame;
  }, [runGame]);

  const newGame = useCallback(() => {
    autoRef.current = false;
    setAuto(false);
    runGame();
  }, [runGame]);

  const startAuto = useCallback(() => {
    if (balancesRef.current.x < MIN_PLAY_MIST || balancesRef.current.o < MIN_PLAY_MIST) {
      setError("Fund the bots first");
      setPhase("error");
      return;
    }
    autoRef.current = true;
    setAuto(true);
    runGame();
  }, [runGame]);

  const resetScore = useCallback(() => {
    const zero: BotScore = { x: 0, o: 0, draws: 0 };
    setScore(zero);
    try {
      localStorage.setItem(SCORE_KEY, JSON.stringify(zero));
    } catch {
      /* ignore */
    }
  }, []);

  const stopAuto = useCallback(() => {
    autoRef.current = false;
    setAuto(false);
    if (nextRef.current !== null) {
      clearTimeout(nextRef.current);
      nextRef.current = null;
    }
  }, []);

  const rebalance = useCallback(() => {
    void (async () => {
      setError(null);
      const b = balancesRef.current;
      const fromX = b.x >= b.o;
      const from = fromX ? bots.x : bots.o;
      const to = fromX ? bots.o : bots.x;
      const diff = fromX ? b.x - b.o : b.o - b.x;
      if (diff < 4_000_000n) {
        setError("Bots are already balanced.");
        return;
      }
      setRebalancing(true);
      try {
        await transferBetweenBots(client, from, to, Number(diff / 2n));
        await refreshBalances();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setRebalancing(false);
      }
    })();
  }, [bots, client, refreshBalances]);

  return {
    board,
    boardSize: size,
    lastMove,
    turn,
    winner,
    phase,
    error,
    digests,
    balances,
    score,
    auto,
    rebalancing,
    maxGames,
    currentGame,
    setMaxGames,
    fund,
    rebalance,
    refresh: refreshBalances,
    resetScore,
    newGame,
    startAuto,
    stopAuto,
  };
}
```

- [ ] **Step 2: Export the shared types used above from `useBotGame.ts`**

`useCaroBotGame` imports `BotPhase`, `BotScore`, `BotDigests`, `Difficulty` from `@/hooks/useBotGame`. Confirm `useBotGame.ts` exports each (it already exports `Difficulty`, `BotPhase`, `BotDigests`, `BotScore` as interfaces/types). If `BotScore` or `BotDigests` are declared but not `export`ed, add `export` to their declarations:

```ts
export interface BotDigests { /* …unchanged… */ }
export interface BotScore { x: number; o: number; draws: number }
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend/src/games/ticTacToe && bun run --cwd packages/client typecheck`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/games/ticTacToe/packages/client/src/hooks/useCaroBotGame.ts \
        frontend/src/games/ticTacToe/packages/client/src/hooks/useBotGame.ts
git commit -m "feat(caro): useCaroBotGame tunnel arena hook"
```

---

## Task 8: Setup screen — game type + board size

**Files:**
- Modify: `frontend/src/games/ticTacToe/packages/client/src/scenes/SetupScene.tsx`

Add a `GameType = "ttt" | "caro"` toggle and (when caro) a board-size selector. Thread new
props through `SetupScene`. The board-size control: presets 15/19/25 + a custom input clamped
9–29.

- [ ] **Step 1: Add the type + props + controls**

At the top of `SetupScene.tsx`, after `export type PlayMode = …`, add:

```ts
export type GameType = "ttt" | "caro";

const BOARD_PRESETS = [15, 19, 25] as const;

function GameTypeChoice({
  value,
  onChange,
}: {
  value: GameType;
  onChange: (v: GameType) => void;
}) {
  const opts: { id: GameType; label: string }[] = [
    { id: "ttt", label: "Tic-Tac-Toe (3×3)" },
    { id: "caro", label: "Caro (5-in-a-row)" },
  ];
  return (
    <div className="flex flex-wrap gap-3 ml-4">
      {opts.map((o) => (
        <button
          key={o.id}
          type="button"
          onClick={() => onChange(o.id)}
          className={`px-4 py-2 border-2 border-primary rounded-sm font-body-lg text-lg transition-all ${
            value === o.id
              ? "bg-primary text-on-primary shadow-[2px_2px_0px_#001e40]"
              : "bg-surface text-primary hover:bg-primary/5"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function BoardSizeChoice({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex flex-col gap-2 ml-4 mt-4">
      <span className="font-label-sm text-xs uppercase tracking-wide text-outline">
        Board size (9–29)
      </span>
      <div className="flex flex-wrap items-center gap-2">
        {BOARD_PRESETS.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            className={`px-3 py-1 border-2 border-primary rounded-sm font-label-sm text-sm transition-all ${
              value === n
                ? "bg-primary text-on-primary shadow-[1px_1px_0px_#001e40]"
                : "bg-surface text-primary hover:bg-primary/5"
            }`}
          >
            {n}×{n}
          </button>
        ))}
        <input
          type="number"
          min={9}
          max={29}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label="Custom board size"
          className="w-20 px-2 py-1 border-2 border-primary rounded-sm bg-surface text-primary font-label-sm text-sm tabular-nums text-center"
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Extend the `SetupScene` props and the "mode" tab**

Add to the `SetupScene({ … })` destructured params and its type (alongside `mode`/`setMode`):

```ts
  gameType,
  setGameType,
  boardSize,
  setBoardSize,
```

```ts
  gameType: GameType;
  setGameType: (g: GameType) => void;
  boardSize: number;
  setBoardSize: (n: number) => void;
```

Then in the `activeTab === "mode"` block, render the game-type + size controls above the
existing `PlayModeChoice`:

```tsx
          {activeTab === "mode" && (
            <div className="space-y-3">
              <h2 className="font-headline-lg-mobile text-base text-primary">Select Game</h2>
              <div className="py-1">
                <GameTypeChoice value={gameType} onChange={setGameType} />
              </div>
              {gameType === "caro" && (
                <BoardSizeChoice value={boardSize} onChange={setBoardSize} />
              )}
              <h2 className="font-headline-lg-mobile text-base text-primary pt-2">Play Mode</h2>
              <p className="text-xs text-outline -mt-1.5">Choose how the bot matches are run.</p>
              <div className="py-2">
                <PlayModeChoice value={mode} onChange={setMode} />
              </div>
            </div>
          )}
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend/src/games/ticTacToe && bun run --cwd packages/client typecheck`
Expected: FAIL — `App.tsx` does not yet pass the new props (fixed in Task 9). It is OK for this step to fail typecheck on `App.tsx` only; `SetupScene.tsx` itself must compile (no errors reported inside `SetupScene.tsx`).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/games/ticTacToe/packages/client/src/scenes/SetupScene.tsx
git commit -m "feat(caro): setup game-type + board-size controls"
```

---

## Task 9: Wire `App.tsx` (game type, board size, active hook)

**Files:**
- Modify: `frontend/src/games/ticTacToe/packages/client/src/App.tsx`

App calls **both** hooks (rules-of-hooks) and selects the active view by `gameType`. The
inactive hook stays idle. `start()`/`backToSetup()` act on the active game.

- [ ] **Step 1: Add state, the caro hook, and the active selector**

Replace the imports + the top of `App()` through the `g` declaration:

```tsx
import { useEffect, useState } from "react";
import { useBotGame, type Difficulty } from "@/hooks/useBotGame";
import { useCaroBotGame } from "@/hooks/useCaroBotGame";
import { useCustomWallet } from "@/contexts/CustomWallet";
import { LoginScene } from "@/scenes/LoginScene";
import { SetupScene, type PlayMode, type GameType } from "@/scenes/SetupScene";
import { GameScene } from "@/scenes/GameScene";
import { GameCardScale } from "@/components/GameCardScale";

type Scene = "login" | "setup" | "game";

export default function App() {
  const [scene, setScene] = useState<Scene>("login");
  const [mode, setMode] = useState<PlayMode>("auto");
  const [difficulty, setDifficulty] = useState<Difficulty>("even");
  const [gameType, setGameType] = useState<GameType>("ttt");
  const [boardSize, setBoardSize] = useState<number>(15);
  const [windowWidth, setWindowWidth] = useState(typeof window !== "undefined" ? window.innerWidth : 1024);
  const [windowHeight, setWindowHeight] = useState(typeof window !== "undefined" ? window.innerHeight : 768);

  const { isConnected } = useCustomWallet();
  // Both hooks are always called (rules of hooks); only the active one is driven. They share
  // the same bot identities and SuiClient, so the idle hook costs only one extra balance read.
  const tttGame = useBotGame(difficulty);
  const caroGame = useCaroBotGame(difficulty, boardSize);
  const g = gameType === "caro" ? caroGame : tttGame;

  const funded = g.balances.x > 0n && g.balances.o > 0n;
```

- [ ] **Step 2: Pass new props to `SetupScene` and `GameScene`**

In the `setup` branch, add to `<SetupScene … />`:

```tsx
              gameType={gameType}
              setGameType={setGameType}
              boardSize={boardSize}
              setBoardSize={setBoardSize}
```

In the `game` branch, pass `gameType`:

```tsx
          {scene === "game" && <GameScene g={g} mode={mode} gameType={gameType} onBack={backToSetup} isPortrait={isPortrait} />}
```

- [ ] **Step 3: Stop both loops on disconnect / back**

In the disconnect effect and `backToSetup`, stop both games so the idle one can't keep a timer:

```tsx
  useEffect(() => {
    if (!isConnected && scene !== "login") {
      tttGame.stopAuto();
      caroGame.stopAuto();
      setScene("login");
    }
  }, [isConnected, scene, tttGame, caroGame]);
```

```tsx
  const backToSetup = () => {
    tttGame.stopAuto();
    caroGame.stopAuto();
    setScene("setup");
  };
```

- [ ] **Step 4: Typecheck**

Run: `cd frontend/src/games/ticTacToe && bun run --cwd packages/client typecheck`
Expected: FAIL only on `GameScene` not yet accepting `gameType` (fixed in Task 10). `App.tsx` and `SetupScene.tsx` report no errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/ticTacToe/packages/client/src/App.tsx
git commit -m "feat(caro): wire game-type selection in App"
```

---

## Task 10: Render caro in `GameScene`

**Files:**
- Modify: `frontend/src/games/ticTacToe/packages/client/src/scenes/GameScene.tsx`

Add a `gameType` prop; render `CaroBoard` when caro, else the existing `Board`. Widen the `g`
type to carry the optional caro extras. Update the title + status copy for caro.

- [ ] **Step 1: Imports + prop + widened type**

At the top, add:

```tsx
import { CaroBoard } from "@/components/CaroBoard";
import type { GameType } from "@/scenes/SetupScene";
```

Change the `GameScene` signature to accept `gameType` and the optional caro view extras:

```tsx
export function GameScene({
  g,
  mode,
  gameType,
  onBack,
  isPortrait = false,
}: {
  g: BotGameView & { boardSize?: number; lastMove?: number };
  mode: PlayMode;
  gameType: GameType;
  onBack: () => void;
  isPortrait?: boolean;
}) {
```

- [ ] **Step 2: Branch the board render**

Replace the "Grid board" block:

```tsx
          {/* Grid board */}
          <div className="flex justify-center my-4">
            <Board board={uiBoard(g.board)} onPlay={() => {}} disabled />
          </div>
```

with:

```tsx
          {/* Board: 3×3 grid for TTT, N×N grid for caro */}
          <div className="flex justify-center my-4">
            {gameType === "caro" ? (
              <CaroBoard board={g.board} size={g.boardSize ?? 15} lastMove={g.lastMove ?? -1} />
            ) : (
              <Board board={uiBoard(g.board)} onPlay={() => {}} disabled />
            )}
          </div>
```

- [ ] **Step 3: Caro-aware title + win text**

Replace the header title text (the `<h1>` containing `Tic-Tac-Toe Journal`) with a
`gameType`-aware label:

```tsx
        <h1 className="font-headline-xl text-3xl text-primary underline decoration-secondary decoration-2 truncate tracking-tight">
          {gameType === "caro" ? "Caro Journal" : "Tic-Tac-Toe Journal"}
        </h1>
```

Update `statusText` so the win line reads naturally for caro. Change its signature and the
two win lines:

```tsx
function statusText(phase: BotPhase, turn: "A" | "B", winner: number, gameType: "ttt" | "caro"): string {
  const fiveOrLine = gameType === "caro" ? " (5 in a row)" : "";
  if (winner === 1) return `Bot X wins!${fiveOrLine} ❌`;
  if (winner === 2) return `Bot O wins!${fiveOrLine} ⭕`;
  if (winner === 3) return "Draw match.";
  // …rest unchanged…
```

And update the call site:

```tsx
            {statusText(g.phase, g.turn, g.winner, gameType)}
```

- [ ] **Step 4: Typecheck**

Run: `cd frontend/src/games/ticTacToe && bun run --cwd packages/client typecheck`
Expected: clean (all files now consistent).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/ticTacToe/packages/client/src/scenes/GameScene.tsx
git commit -m "feat(caro): render caro board in game scene"
```

---

## Task 11: Full build + manual smoke

**Files:** none (verification only)

- [ ] **Step 1: Shared suite + client build**

```bash
cd frontend/src/games/ticTacToe/packages/shared && bun test
cd frontend/src/games/ticTacToe && bun run build
```
Expected: all shared tests pass; `bun run build` completes (the pre-existing @noble PURE-annotation warning and the chunk-size warning are benign).

- [ ] **Step 2: Manual smoke (dev server)**

```bash
cd frontend/src/games/ticTacToe && bun run dev
```
In the browser: continue past login → setup → **Play Mode** tab → choose **Caro**, pick a
board size (e.g. 19), **Single game**, fund the bots, **Start playing**. Verify: an N×N board
renders, two bots place ✕/◯ alternately, a game ends on 5-in-a-row (status shows
"Bot X wins! (5 in a row)"), and the on-chain digest panel populates (Open & Fund → State
Checkpoint → Settle & Close, plus the transcript root). Then switch back to setup, choose
**Tic-Tac-Toe (3×3)**, and confirm the original game still works unchanged.

- [ ] **Step 3: No commit** (verification task). If Step 1 or 2 surfaces a defect, fix it in the relevant task's files and re-run.

---

## Self-review notes (for the executor)

- **Marks/winner stay consistent across every task:** `0/1/2` cells, `winner ∈ {0,1,2,3}`,
  `1`=A/Bot X, `2`=B/Bot O. `pickCaroMove` and `winnerAround` agree on this.
- **Type names match across tasks:** `CaroState`, `CaroMove`, `MultiGameCaroState`,
  `MultiGameCaroMove`, `MultiGameCaroProtocol`, `CaroProtocol`, `pickCaroMove`, `BotStrength`,
  `CaroBotGameView`, `GameType`. The hook imports `BotPhase`/`BotScore`/`BotDigests`/`Difficulty`
  from `useBotGame` (Task 7 Step 2 ensures they are exported).
- **No repo-core edits:** all changes are under `packages/shared/src/caro/` and
  `packages/client/src/`. `sui-tunnel-ts/**` and `sui_tunnel/**` are never staged.
- **Tunnel flow reused as-is:** `buildCreateAndFundTx`, `buildUpdateStateTx`,
  `buildSettleWithRootTx`, `parseTunnelId` from `@/lib/tunnel` (unchanged from the
  create_and_fund work) and `@/lib/bots` are protocol-agnostic.
