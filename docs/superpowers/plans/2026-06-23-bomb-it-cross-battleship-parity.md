# Bomb It & Chicken Cross — Battleship-tier Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring bomb-it + chicken-cross **solo** play to the battleship/ttt reference tier: out-of-React session survival, multi-game-per-tunnel (running score + settle-anytime), and the gas-sponsor funding path bomb-it is missing.

**Architecture:** Two new SDK multi-game protocol wrappers compose the existing single-game protocols (state `{inner, gamesPlayed}`, first move after terminal starts the next game, per-game seed from a synthetic id). Each solo hook is rewritten to battleship's out-of-React `BotSession` class (kept in a `windowId`-keyed module map, subscribed via `useSyncExternalStore`) which drives a multi-game advance loop, funds via the sponsor path, tallies score, and settles on demand. PvP and battleship are untouched.

**Tech Stack:** TypeScript; `sui-tunnel-ts` SDK (pnpm + prettier + `node:test` via tsx); React 19 (`useSyncExternalStore`); `@mysten/dapp-kit`; existing `onchain/` sponsor + `backend/settle` helpers.

## Global Constraints

> **DESIGN CORRECTION (surfaced by Task 2's tests):** chicken-cross and bomb-it are
> _winner-takes-all_ (the inner game flips the whole pot to the winner), unlike
> battleship which swaps a small fixed stake. A wrapper that delegated balances to the
> inner game would zero the loser after one decisive game → no rematch ever. So the
> multi-game wrapper **owns the real carried balances** and swaps a fixed `stakePerGame`
> loser→winner per _decided_ game (push swaps nothing); the inner game runs with
> _symbolic_ per-game balances `{stakePerGame, stakePerGame}` purely to crown a winner.
> The solo session **funds a large balance per seat** (battleship's `LOCKED_PER_SEAT` =
> 1 DOPAMINT, `SUI_PER_SEAT` fallback) with `stakePerGame` = the lobby stake (≥ MIN), so
> many games fit. The corrected protocol + tests live in the task briefs
> (`.superpowers/sdd/task-2-brief.md`, `task-3-brief.md`) and **supersede the Task 2/3
> code blocks below and the Task 5/8 funding steps** on the balance + funding model.
> Conservation, per-game seed, out-of-React survival, and cadence are unchanged.

- **Framework discipline (CLAUDE.md):** `sui-tunnel-ts` keeps pnpm + prettier + `node:test` via tsx; co-locate `*.test.ts`. Add protocols "following the existing protocol files" — do not restructure or convert to bun/biome.
- **Determinism (ADR 0010):** per-game seed stays a pure function of `(tunnelId, gamesPlayed)` — public, symmetric, party-independent. No commit-reveal.
- **Conservation (Protocol Invariant 1):** `balances(state).a + .b === total` for every reachable state. A reset carries inner balances forward verbatim.
- **Commits (CLAUDE.md §Git):** Conventional Commits; subject ≤50 chars, imperative, lowercase after type, no trailing period; **no AI attribution**; one logical change per commit.
- **Cadence preserved:** bomb-it = one co-signed tick per `SOLO_STEP_MS` (reaction); chicken-cross = batched under `FRAME_BUDGET_MS`/`MAX_STEPS_PER_FRAME` (throughput). No battleship TPS retrofit.
- **Solo survival ≠ PvP resume:** survival is the out-of-React `BotSession` + `registerWindowDisposer`; do not touch `frontend/src/pvp/resume.ts`.
- **Gate after each task:** the task's own tests green, then `cd frontend && pnpm typecheck`. Full gate at the end.

---

## File Structure

**Created**

- `sui-tunnel-ts/src/protocol/multiGameBombIt.ts` — `MultiGameBombItProtocol` (compose `BombItProtocol`).
- `sui-tunnel-ts/src/protocol/multiGameBombIt.test.ts` — protocol unit/golden tests.
- `sui-tunnel-ts/src/protocol/multiGameCross.ts` — `MultiGameCrossProtocol` (compose `CrossProtocol`).
- `sui-tunnel-ts/src/protocol/multiGameCross.test.ts` — protocol unit/golden tests.
- `docs/decisions/0011-multi-game-self-play-per-game-seed.md` — ADR (extends 0010).

**Modified**

- `sui-tunnel-ts/src/protocol/index.ts` — barrel-export the two wrappers.
- `frontend/src/games/chickenCross/session-core.ts` — add `stepMultiGame`, `kickoffNextGame`, `deriveMultiView`; keep single-game exports.
- `frontend/src/games/chickenCross/session-core.test.ts` — multi-game bounded test.
- `frontend/src/games/chickenCross/useChickenCrossSession.ts` — out-of-React `CrossBotSession`, multi-game, score, settle-anytime (keeps existing sponsor path).
- `frontend/src/games/chickenCross/ChickenCrossWindow.tsx` — solo survives remount (windowId store).
- `frontend/src/games/chickenCross/components/CrossBoard.tsx` — score, settle control, rematch beat.
- `frontend/src/games/bombIt/session-core.ts` — add `stepMultiGame`, `kickoffNextGame`, `deriveMultiView`; keep single-game exports.
- `frontend/src/games/bombIt/session-core.test.ts` — multi-game bounded test.
- `frontend/src/games/bombIt/useBombItSession.ts` — out-of-React `BombBotSession`, multi-game, **sponsor/DOPAMINT/backend-settle**, score, settle-anytime.
- `frontend/src/games/bombIt/BombItWindow.tsx` — solo survives remount.
- `frontend/src/games/bombIt/components/BombBoard.tsx` — score, settle control, rematch beat.

**Unchanged (re-verified at the gate)**

- `usePvpBombIt.ts`, `usePvpChickenCross.ts`, `pvp/*`, all `battleship/*`.

---

## Task 1: ADR — multi-game self-play + per-game seed

**Files:**

- Create: `docs/decisions/0011-multi-game-self-play-per-game-seed.md`

- [ ] **Step 1: Write the ADR**

```markdown
# 0011 — Multi-game self-play + per-game seed for bomb-it & chicken-cross

- **Status**: Accepted
- **Date**: 2026-06-23

## Context

Battleship and tic-tac-toe host MANY games inside ONE funded tunnel and settle
once (multi-game wrappers composing the single-game protocol). bomb-it and
chicken-cross funded a fresh tunnel per game. Bringing them to that tier needs a
multi-game wrapper too — but unlike battleship (whose per-game randomness is a
fresh fleet commit), their boards are seeded by `seedFromTunnelId(tunnelId)`,
which is FIXED per tunnel. A naive reset would replay the identical board/race
every game.

## Decision

Add `MultiGameBombItProtocol` / `MultiGameCrossProtocol` mirroring
`MultiGameBattleshipProtocol`. On a between-games reset the wrapper re-seeds the
inner game from a SYNTHETIC per-game id `` `${tunnelId}:g${gamesPlayed}` ``.
`gamesPlayed` is part of the co-signed multi-game state and of `encodeState`, so
both parties and an on-chain disputer derive the same per-game seed.

This stays inside ADR 0010: the field is still public, symmetric, and
party-independent, seeded from an un-grindable id — no commit-reveal is added.

## Consequences

- Solo bomb-it/cross fund once and play an unbounded series of distinct games,
  settling on demand (or at stake exhaustion), matching battleship/ttt.
- Each game's board/hazard-field differs (per-game seed), so a rematch is a new
  challenge, not a replay.
- Single-game PvP is unchanged (still seeds from the plain `tunnelId`).
- The wrappers live in `sui-tunnel-ts/src/protocol/`, beside the base protocols
  and ttt's multi-game wrapper, per `docs/adding-a-tunnel-game.md`.
```

- [ ] **Step 2: Commit**

```bash
git add docs/decisions/0011-multi-game-self-play-per-game-seed.md
git commit -m "docs(adr): multi-game self-play + per-game seed"
```

---

## Task 2: `MultiGameCrossProtocol` (SDK)

Chicken-cross first — it already has the sponsor path, so it isolates the multi-game change.

**Files:**

- Create: `sui-tunnel-ts/src/protocol/multiGameCross.ts`
- Create: `sui-tunnel-ts/src/protocol/multiGameCross.test.ts`
- Modify: `sui-tunnel-ts/src/protocol/index.ts`

**Interfaces:**

- Consumes: `CrossProtocol`, `CrossState`, `CrossMove` from `./cross`; `Protocol`, `Party`, `Balances`, `ProtocolContext`, `protocolDomain`, `lengthPrefixedConcat` from `./Protocol`; `concatBytes` from `../core/bytes`; `u64ToBeBytes` from `../core/wire`.
- Produces:
  - `interface MultiGameCrossState { inner: CrossState; gamesPlayed: number }`
  - `type MultiGameCrossMove = CrossMove`
  - `class MultiGameCrossProtocol implements Protocol<MultiGameCrossState, MultiGameCrossMove>` with ctor `(tunnelId: string, stakePerSeat?: bigint)`, plus `isGameOver(state): boolean` (inner terminal) used by the session loop.

- [ ] **Step 1: Write the failing test**

```ts
// sui-tunnel-ts/src/protocol/multiGameCross.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { CrossProtocol } from "./cross";
import {
  MultiGameCrossProtocol,
  type MultiGameCrossState,
} from "./multiGameCross";

/** Deterministic LCG so playthroughs are reproducible. */
function rngFrom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const conserved = (s: MultiGameCrossState, total: bigint): boolean =>
  s.inner.balanceA + s.inner.balanceB === total;

/** Drive the current inner game to terminal via the wrapper's own bot moves. */
function playOneGame(
  proto: MultiGameCrossProtocol,
  start: MultiGameCrossState,
  rng: () => number,
  total: bigint,
): MultiGameCrossState {
  let state = start;
  let guard = 0;
  while (!proto.isGameOver(state)) {
    if (++guard > 20000) throw new Error("game did not terminate");
    const by = state.inner.tick % 2n === 0n ? "A" : "B";
    const move = proto.randomMove(state, by, rng);
    if (!move) break;
    state = proto.applyMove(state, move, by);
    assert.ok(conserved(state, total), "conserved on every step");
  }
  return state;
}

test("plays many games on one tunnel, conserving balances every step", () => {
  const proto = new MultiGameCrossProtocol("0xt", 100n);
  const total = 200n;
  const rng = rngFrom(42);
  let state = proto.initialState({
    tunnelId: "0xt",
    initialBalances: { a: 100n, b: 100n },
  });
  for (let g = 0; g < 3; g++) {
    state = playOneGame(proto, state, rng, total);
    assert.ok(
      proto.isGameOver(state),
      "each game reached a terminal inner state",
    );
    if (proto.isTerminal(state)) break; // stake-exhausted (a decisive game moved all funds)
    // Rematch: the first move after terminal resets the inner board and starts game g+2.
    const by = state.inner.tick % 2n === 0n ? "A" : "B";
    state = proto.applyMove(state, { dirA: undefined }, "A");
    assert.ok(conserved(state, total), "conserved across the rematch kickoff");
  }
  assert.ok(state.gamesPlayed >= 1, "advanced past game 1");
});

test("rematch re-seeds the inner game to a DIFFERENT board", () => {
  const proto = new MultiGameCrossProtocol("0xt", 100n);
  const rng = rngFrom(7);
  let state = proto.initialState({
    tunnelId: "0xt",
    initialBalances: { a: 100n, b: 100n },
  });
  const seedG1 = state.inner.seed;
  state = playOneGame(proto, state, rng, 200n);
  // A push (winner null) keeps both fundable, guaranteeing a rematch is possible.
  if (!proto.isTerminal(state)) {
    state = proto.applyMove(state, { dirA: undefined }, "A");
    assert.equal(state.gamesPlayed, 1, "gamesPlayed bumped on the rematch");
    assert.notEqual(
      state.inner.seed,
      seedG1,
      "game 2 uses a different per-game seed",
    );
  }
});

test("a finished game is not terminal while both sides can fund the next", () => {
  // A push (equal-score dead heat / tick cap tie) leaves balances at (100,100).
  const proto = new MultiGameCrossProtocol("0xt", 100n);
  // Construct a terminal-but-funded state directly: winner null, balances intact.
  const base = new CrossProtocol().initialState({
    tunnelId: "0xt:g1",
    initialBalances: { a: 100n, b: 100n },
  });
  const pushed = { ...base, tick: 5400n, winner: null as null }; // tick cap reached, no winner
  const state: MultiGameCrossState = { inner: pushed, gamesPlayed: 0 };
  assert.equal(proto.isGameOver(state), true, "inner game over (tick cap)");
  assert.equal(
    proto.isTerminal(state),
    false,
    "session continues — both can fund",
  );
});

test("session IS terminal once a side cannot fund the next stake", () => {
  // Stake equals a seat's whole balance: after a decisive game a side is at 0.
  const proto = new MultiGameCrossProtocol("0xt", 100n);
  const base = new CrossProtocol().initialState({
    tunnelId: "0xt:g1",
    initialBalances: { a: 100n, b: 100n },
  });
  const aWon = { ...base, winner: "A" as const, balanceA: 200n, balanceB: 0n };
  const state: MultiGameCrossState = { inner: aWon, gamesPlayed: 0 };
  assert.equal(proto.isTerminal(state), true, "B at 0 cannot fund a 100 stake");
});

test("encodeState is deterministic and distinguishes gamesPlayed + domain", () => {
  const proto = new MultiGameCrossProtocol("0xt", 100n);
  const inner = new CrossProtocol();
  const s = proto.initialState({
    tunnelId: "0xt",
    initialBalances: { a: 100n, b: 100n },
  });
  assert.deepEqual(proto.encodeState(s), proto.encodeState(s));
  const bumped: MultiGameCrossState = { inner: s.inner, gamesPlayed: 1 };
  assert.notDeepEqual(proto.encodeState(s), proto.encodeState(bumped));
  // The multi-game encoding must never collide with the bare inner single-game encoding.
  assert.notDeepEqual(proto.encodeState(s), inner.encodeState(s.inner));
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd sui-tunnel-ts && node --import tsx --test src/protocol/multiGameCross.test.ts`
Expected: FAIL — `Cannot find module './multiGameCross'`.

- [ ] **Step 3: Write the protocol**

```ts
// sui-tunnel-ts/src/protocol/multiGameCross.ts
/**
 * Multi-game Chicken Cross: race MANY times inside ONE tunnel, settle ONCE on demand.
 * Composes the single-game {@link CrossProtocol} (mirrors MultiGameBattleship/ttt).
 *
 * Per-game seed (ADR 0011, extends 0010): a reset re-seeds the inner race from a
 * SYNTHETIC id `${tunnelId}:g${gamesPlayed}`, so each game's hazard field differs
 * while staying a deterministic, public, party-independent function of co-signed
 * state — no commit-reveal. encodeState domain-separates the multi state from the
 * inner single-game one.
 */
import {
  Protocol,
  Party,
  Balances,
  ProtocolContext,
  protocolDomain,
  lengthPrefixedConcat,
} from "./Protocol";
import { concatBytes } from "../core/bytes";
import { u64ToBeBytes } from "../core/wire";
import {
  CrossProtocol,
  MIN_STAKE,
  type CrossState,
  type CrossMove,
} from "./cross";

export interface MultiGameCrossState {
  /** The current single race (positions, scores, carried balances). */
  inner: CrossState;
  /** Completed games behind the current one; the running game is `gamesPlayed + 1`. */
  gamesPlayed: number;
}

/** A move is a normal inner move; the first one after a game ends starts the next. */
export type MultiGameCrossMove = CrossMove;

export class MultiGameCrossProtocol implements Protocol<
  MultiGameCrossState,
  MultiGameCrossMove
> {
  readonly name = "cross.multi.v1";

  private readonly domain = protocolDomain("cross.multi.v1");
  private readonly inner = new CrossProtocol();

  /**
   * @param tunnelId real Sui tunnel id; per-game seeds derive from `${tunnelId}:g${N}`.
   * @param stakePerSeat amount each side must still hold to fund another game.
   */
  constructor(
    private readonly tunnelId: string,
    private readonly stakePerSeat: bigint = MIN_STAKE,
  ) {}

  /** Synthetic per-game id so each game's seed (and board) differs deterministically. */
  private gameCtx(gameNumber: number, balances: Balances): ProtocolContext {
    return {
      tunnelId: `${this.tunnelId}:g${gameNumber}`,
      initialBalances: balances,
    };
  }

  initialState(ctx: ProtocolContext): MultiGameCrossState {
    return {
      inner: this.inner.initialState(this.gameCtx(1, ctx.initialBalances)),
      gamesPlayed: 0,
    };
  }

  /** Whether the CURRENT inner game is over (terminal), regardless of session funding. */
  isGameOver(state: MultiGameCrossState): boolean {
    return this.inner.isTerminal(state.inner);
  }

  applyMove(
    state: MultiGameCrossState,
    move: MultiGameCrossMove,
    by: Party,
  ): MultiGameCrossState {
    // Mid-game: delegate to the inner protocol (throws on an illegal move).
    if (!this.inner.isTerminal(state.inner)) {
      return { ...state, inner: this.inner.applyMove(state.inner, move, by) };
    }
    // A game finished. If neither side can fund the next stake, only settlement remains.
    if (this.isTerminal(state)) {
      throw new Error("session over: insufficient balance for another game");
    }
    // Otherwise this move STARTS the next game: reset to a fresh race seeded by the next
    // game number, carry balances forward, bump gamesPlayed, and apply the move to it.
    const nextGame = state.gamesPlayed + 2; // game 1 used :g1; the running one is gamesPlayed+1
    const fresh = this.inner.initialState(
      this.gameCtx(nextGame, {
        a: state.inner.balanceA,
        b: state.inner.balanceB,
      }),
    );
    return {
      inner: this.inner.applyMove(fresh, move, by),
      gamesPlayed: state.gamesPlayed + 1,
    };
  }

  encodeState(state: MultiGameCrossState): Uint8Array {
    return concatBytes([
      this.domain,
      lengthPrefixedConcat([
        this.inner.encodeState(state.inner),
        u64ToBeBytes(BigInt(state.gamesPlayed)),
      ]),
    ]);
  }

  balances(state: MultiGameCrossState): Balances {
    return this.inner.balances(state.inner);
  }

  isTerminal(state: MultiGameCrossState): boolean {
    if (!this.inner.isTerminal(state.inner)) return false; // settlement is player-driven mid-game
    return !this.canFundNextGame(state.inner); // between games: terminal only at exhaustion
  }

  randomMove(
    state: MultiGameCrossState,
    by: Party,
    rng: () => number,
  ): MultiGameCrossMove | null {
    // Mid-game, defer to the inner bot. Between games, return null — the session decides
    // whether to rematch (kickoff move) or settle; the simulator never auto-rematches.
    if (!this.inner.isTerminal(state.inner))
      return this.inner.randomMove(state.inner, by, rng);
    return null;
  }

  private canFundNextGame(inner: CrossState): boolean {
    if (this.stakePerSeat === 0n) return true;
    return (
      inner.balanceA >= this.stakePerSeat && inner.balanceB >= this.stakePerSeat
    );
  }
}
```

Note on game numbering: `initialState` seeds game 1 from `:g1`; the running game is `gamesPlayed + 1`, so the next game after a reset is `gamesPlayed + 2`. The test asserts only that the seed CHANGES, so the exact numbering is internal.

- [ ] **Step 4: Add the barrel export**

In `sui-tunnel-ts/src/protocol/index.ts`, add beside the existing `cross` export:

```ts
export * from "./multiGameCross";
```

(Match the file's existing export style — `export *` or named; read the file and mirror it.)

- [ ] **Step 5: Run the test, verify it passes**

Run: `cd sui-tunnel-ts && node --import tsx --test src/protocol/multiGameCross.test.ts`
Expected: PASS (all 6 tests).

- [ ] **Step 6: Format + commit**

```bash
cd sui-tunnel-ts && pnpm prettier --write src/protocol/multiGameCross.ts src/protocol/multiGameCross.test.ts src/protocol/index.ts
git add sui-tunnel-ts/src/protocol/multiGameCross.ts sui-tunnel-ts/src/protocol/multiGameCross.test.ts sui-tunnel-ts/src/protocol/index.ts
git commit -m "feat(sdk): multi-game chicken-cross protocol"
```

---

## Task 3: `MultiGameBombItProtocol` (SDK)

**Files:**

- Create: `sui-tunnel-ts/src/protocol/multiGameBombIt.ts`
- Create: `sui-tunnel-ts/src/protocol/multiGameBombIt.test.ts`
- Modify: `sui-tunnel-ts/src/protocol/index.ts`

**Interfaces:**

- Consumes: `BombItProtocol`, `BombItState`, `BombItMove`, `BOMB_IT_MIN_STATE`… use `BOMB_IT_MIN_STAKE` from `./bombIt`; same `Protocol` helpers as Task 2.
- Produces: `MultiGameBombItState`, `MultiGameBombItMove`, `class MultiGameBombItProtocol` ctor `(tunnelId, stakePerSeat?)`, `isGameOver(state)`.

- [ ] **Step 1: Write the failing test**

```ts
// sui-tunnel-ts/src/protocol/multiGameBombIt.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { BombItProtocol } from "./bombIt";
import {
  MultiGameBombItProtocol,
  type MultiGameBombItState,
} from "./multiGameBombIt";

function rngFrom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const conserved = (s: MultiGameBombItState, total: bigint): boolean =>
  s.inner.balanceA + s.inner.balanceB === total;

function playOneGame(
  proto: MultiGameBombItProtocol,
  start: MultiGameBombItState,
  rng: () => number,
  total: bigint,
): MultiGameBombItState {
  let state = start;
  let guard = 0;
  while (!proto.isGameOver(state)) {
    if (++guard > 20000) throw new Error("game did not terminate");
    const by = state.inner.tick % 2n === 0n ? "A" : "B";
    const move = proto.randomMove(state, by, rng);
    if (!move) break;
    state = proto.applyMove(state, move, by);
    assert.ok(conserved(state, total), "conserved on every step");
  }
  return state;
}

test("plays many games on one tunnel, conserving balances every step", () => {
  const proto = new MultiGameBombItProtocol("0xb", 100n);
  const rng = rngFrom(42);
  let state = proto.initialState({
    tunnelId: "0xb",
    initialBalances: { a: 100n, b: 100n },
  });
  for (let g = 0; g < 3; g++) {
    state = playOneGame(proto, state, rng, 200n);
    assert.ok(proto.isGameOver(state), "inner game terminal");
    if (proto.isTerminal(state)) break;
    state = proto.applyMove(state, { a: "stay" }, "A"); // kickoff next game
    assert.ok(conserved(state, 200n), "conserved across the rematch kickoff");
  }
  assert.ok(state.gamesPlayed >= 1);
});

test("rematch re-seeds the inner game to a DIFFERENT grid", () => {
  const proto = new MultiGameBombItProtocol("0xb", 100n);
  const rng = rngFrom(7);
  let state = proto.initialState({
    tunnelId: "0xb",
    initialBalances: { a: 100n, b: 100n },
  });
  const seedG1 = state.inner.seed;
  state = playOneGame(proto, state, rng, 200n);
  if (!proto.isTerminal(state)) {
    state = proto.applyMove(state, { a: "stay" }, "A");
    assert.equal(state.gamesPlayed, 1);
    assert.notEqual(
      state.inner.seed,
      seedG1,
      "game 2 uses a different per-game seed",
    );
  }
});

test("a DRAW is played-but-unscored and fundable-next (continues)", () => {
  const proto = new MultiGameBombItProtocol("0xb", 100n);
  const base = new BombItProtocol().initialState({
    tunnelId: "0xb:g1",
    initialBalances: { a: 100n, b: 100n },
  });
  const drawn = { ...base, winner: "draw" as const }; // both dead / tick cap ⇒ draw, balances intact
  const state: MultiGameBombItState = { inner: drawn, gamesPlayed: 0 };
  assert.equal(
    proto.isGameOver(state),
    true,
    "draw is terminal for the inner game",
  );
  assert.equal(
    proto.isTerminal(state),
    false,
    "session continues — a draw moved no funds",
  );
});

test("session IS terminal once a side cannot fund the next stake", () => {
  const proto = new MultiGameBombItProtocol("0xb", 100n);
  const base = new BombItProtocol().initialState({
    tunnelId: "0xb:g1",
    initialBalances: { a: 100n, b: 100n },
  });
  const aWon = { ...base, winner: "A" as const, balanceA: 200n, balanceB: 0n };
  const state: MultiGameBombItState = { inner: aWon, gamesPlayed: 0 };
  assert.equal(proto.isTerminal(state), true);
});

test("encodeState is deterministic and distinguishes gamesPlayed + domain", () => {
  const proto = new MultiGameBombItProtocol("0xb", 100n);
  const inner = new BombItProtocol();
  const s = proto.initialState({
    tunnelId: "0xb",
    initialBalances: { a: 100n, b: 100n },
  });
  assert.deepEqual(proto.encodeState(s), proto.encodeState(s));
  const bumped: MultiGameBombItState = { inner: s.inner, gamesPlayed: 1 };
  assert.notDeepEqual(proto.encodeState(s), proto.encodeState(bumped));
  assert.notDeepEqual(proto.encodeState(s), inner.encodeState(s.inner));
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd sui-tunnel-ts && node --import tsx --test src/protocol/multiGameBombIt.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the protocol**

Mirror `multiGameCross.ts` exactly, swapping the inner protocol and stake constant. Full code:

```ts
// sui-tunnel-ts/src/protocol/multiGameBombIt.ts
/**
 * Multi-game Bomb It: fight MANY duels inside ONE tunnel, settle ONCE on demand.
 * Composes the single-game {@link BombItProtocol}; per-game seed `${tunnelId}:g${N}`
 * gives each duel a different grid (ADR 0011, extends 0010 — public, symmetric,
 * deterministic; no commit-reveal). A draw moves no funds, so it is played-but-
 * unscored and the session continues.
 */
import {
  Protocol,
  Party,
  Balances,
  ProtocolContext,
  protocolDomain,
  lengthPrefixedConcat,
} from "./Protocol";
import { concatBytes } from "../core/bytes";
import { u64ToBeBytes } from "../core/wire";
import {
  BombItProtocol,
  BOMB_IT_MIN_STAKE,
  type BombItState,
  type BombItMove,
} from "./bombIt";

export interface MultiGameBombItState {
  inner: BombItState;
  gamesPlayed: number;
}
export type MultiGameBombItMove = BombItMove;

export class MultiGameBombItProtocol implements Protocol<
  MultiGameBombItState,
  MultiGameBombItMove
> {
  readonly name = "bomb_it.multi.v1";

  private readonly domain = protocolDomain("bomb_it.multi.v1");
  private readonly inner = new BombItProtocol();

  constructor(
    private readonly tunnelId: string,
    private readonly stakePerSeat: bigint = BOMB_IT_MIN_STAKE,
  ) {}

  private gameCtx(gameNumber: number, balances: Balances): ProtocolContext {
    return {
      tunnelId: `${this.tunnelId}:g${gameNumber}`,
      initialBalances: balances,
    };
  }

  initialState(ctx: ProtocolContext): MultiGameBombItState {
    return {
      inner: this.inner.initialState(this.gameCtx(1, ctx.initialBalances)),
      gamesPlayed: 0,
    };
  }

  isGameOver(state: MultiGameBombItState): boolean {
    return this.inner.isTerminal(state.inner);
  }

  applyMove(
    state: MultiGameBombItState,
    move: MultiGameBombItMove,
    by: Party,
  ): MultiGameBombItState {
    if (!this.inner.isTerminal(state.inner)) {
      return { ...state, inner: this.inner.applyMove(state.inner, move, by) };
    }
    if (this.isTerminal(state)) {
      throw new Error("session over: insufficient balance for another game");
    }
    const nextGame = state.gamesPlayed + 2;
    const fresh = this.inner.initialState(
      this.gameCtx(nextGame, {
        a: state.inner.balanceA,
        b: state.inner.balanceB,
      }),
    );
    return {
      inner: this.inner.applyMove(fresh, move, by),
      gamesPlayed: state.gamesPlayed + 1,
    };
  }

  encodeState(state: MultiGameBombItState): Uint8Array {
    return concatBytes([
      this.domain,
      lengthPrefixedConcat([
        this.inner.encodeState(state.inner),
        u64ToBeBytes(BigInt(state.gamesPlayed)),
      ]),
    ]);
  }

  balances(state: MultiGameBombItState): Balances {
    return this.inner.balances(state.inner);
  }

  isTerminal(state: MultiGameBombItState): boolean {
    if (!this.inner.isTerminal(state.inner)) return false;
    return !this.canFundNextGame(state.inner);
  }

  randomMove(
    state: MultiGameBombItState,
    by: Party,
    rng: () => number,
  ): MultiGameBombItMove | null {
    if (!this.inner.isTerminal(state.inner))
      return this.inner.randomMove(state.inner, by, rng);
    return null;
  }

  private canFundNextGame(inner: BombItState): boolean {
    if (this.stakePerSeat === 0n) return true;
    return (
      inner.balanceA >= this.stakePerSeat && inner.balanceB >= this.stakePerSeat
    );
  }
}
```

- [ ] **Step 4: Barrel export** — add `export * from "./multiGameBombIt";` to `index.ts`.

- [ ] **Step 5: Run the test, verify it passes**

Run: `cd sui-tunnel-ts && node --import tsx --test src/protocol/multiGameBombIt.test.ts`
Expected: PASS.

- [ ] **Step 6: Format + commit**

```bash
cd sui-tunnel-ts && pnpm prettier --write src/protocol/multiGameBombIt.ts src/protocol/multiGameBombIt.test.ts src/protocol/index.ts
git add sui-tunnel-ts/src/protocol/multiGameBombIt.ts sui-tunnel-ts/src/protocol/multiGameBombIt.test.ts sui-tunnel-ts/src/protocol/index.ts
git commit -m "feat(sdk): multi-game bomb-it protocol"
```

---

## Task 4: chicken-cross session-core — multi-game helpers

**Files:**

- Modify: `frontend/src/games/chickenCross/session-core.ts`
- Test: `frontend/src/games/chickenCross/session-core.test.ts`

**Interfaces:**

- Consumes: `MultiGameCrossProtocol`, `MultiGameCrossState`, `MultiGameCrossMove` (type-only import); existing `HumanSeat`, `deriveView`, `CrossView`.
- Produces:
  - `type StepOutcome = "stepped" | "game-over" | "session-over"`
  - `function stepMultiGame(protocol, tunnel, rng, human?): StepOutcome`
  - `function kickoffNextGame(tunnel): void` — steps seat A's no-op first move (`{ dirA: undefined }`), which the wrapper turns into a fresh-game reset.
  - `function deriveMultiView(state: MultiGameCrossState): CrossView` — `deriveView(state.inner)` (re-export convenience).

- [ ] **Step 1: Write the failing test** (append to `session-core.test.ts`)

```ts
import { MultiGameCrossProtocol } from "../../../../sui-tunnel-ts/src/protocol/multiGameCross.ts";
import {
  stepMultiGame,
  kickoffNextGame,
  deriveMultiView,
} from "./session-core.ts";

function freshMultiTunnel() {
  const a = createParticipant("a");
  const b = createParticipant("b");
  const protocol = new MultiGameCrossProtocol("0xfeed", MIN_STAKE);
  const tunnel = OffchainTunnel.selfPlay(
    protocol,
    "0xfeed",
    a.keyPair,
    b.keyPair,
    a.address,
    b.address,
    { a: MIN_STAKE, b: MIN_STAKE },
  );
  return { protocol, tunnel };
}

test("stepMultiGame advances a multi-game race and stays settleable", () => {
  const { protocol, tunnel } = freshMultiTunnel();
  let stepped = 0;
  for (let i = 0; i < 200; i++) {
    const r = stepMultiGame(protocol, tunnel, Math.random);
    if (r === "stepped") {
      stepped++;
      assert.equal(
        tunnel.state.inner.balanceA + tunnel.state.inner.balanceB,
        tunnel.state.inner.total,
      );
    } else break;
  }
  assert.ok(stepped > 0, "made progress");
  const u = tunnel.latest;
  assert.ok(
    u &&
      verifyCoSignedUpdate(
        u,
        { publicKey: tunnel.partyA.publicKey, scheme: tunnel.partyA.scheme },
        { publicKey: tunnel.partyB.publicKey, scheme: tunnel.partyB.scheme },
      ),
    "settleable mid multi-game session",
  );
});

test("kickoffNextGame starts game 2 on the same tunnel after a game ends", () => {
  const { protocol, tunnel } = freshMultiTunnel();
  // Advance until the first inner game ends (bounded — most races end well within this).
  let outcome = "stepped";
  for (let i = 0; i < 20000 && outcome === "stepped"; i++) {
    outcome = stepMultiGame(protocol, tunnel, Math.random);
  }
  if (outcome === "game-over") {
    assert.equal(tunnel.state.gamesPlayed, 0, "still game 1 at the boundary");
    kickoffNextGame(tunnel);
    assert.equal(tunnel.state.gamesPlayed, 1, "rematched onto game 2");
    assert.equal(
      deriveMultiView(tunnel.state).winner,
      null,
      "fresh game has no winner yet",
    );
  }
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `cd frontend && node --import tsx --test "src/games/chickenCross/session-core.test.ts"`
Expected: FAIL — `stepMultiGame` not exported.

- [ ] **Step 3: Add the helpers** to `session-core.ts`

Add type-only imports and the functions (keep the existing single-game exports unchanged):

```ts
import type {
  MultiGameCrossProtocol,
  MultiGameCrossState,
} from "sui-tunnel-ts/protocol/multiGameCross";
import type { CrossMove } from "sui-tunnel-ts/protocol/cross";

export type StepOutcome = "stepped" | "game-over" | "session-over";

/**
 * Advance a multi-game self-play race by one tick. Returns:
 *  - "stepped"      one inner tick co-signed;
 *  - "game-over"    the current inner game is terminal but the session can fund another
 *                   (caller records the score, then calls kickoffNextGame to rematch);
 *  - "session-over" stake is exhausted — caller settles.
 * Parity reads inner.tick (the multi-game state has no top-level tick).
 */
export function stepMultiGame(
  protocol: MultiGameCrossProtocol,
  tunnel: OffchainTunnel<MultiGameCrossState, CrossMove>,
  rng: () => number,
  human?: HumanSeat | null,
): StepOutcome {
  if (protocol.isTerminal(tunnel.state)) return "session-over";
  if (protocol.isGameOver(tunnel.state)) return "game-over";
  const by: Party = tunnel.state.inner.tick % 2n === 0n ? "A" : "B";
  let move: CrossMove | null;
  if (human && human.seat === by) {
    const dir = human.getDir();
    move = by === "A" ? { dirA: dir } : { dirB: dir };
  } else {
    move = protocol.randomMove(tunnel.state, by, rng);
  }
  if (!move) return "game-over";
  tunnel.step(move, by);
  return "stepped";
}

/**
 * Start the next game on the SAME tunnel: seat A's no-op first move, which the
 * wrapper turns into a fresh-game reset (new per-game seed, balances carried). A's
 * stay is always legal on a fresh board, so no bot lookahead on a not-yet-built state.
 */
export function kickoffNextGame(
  tunnel: OffchainTunnel<MultiGameCrossState, CrossMove>,
): void {
  tunnel.step({ dirA: undefined }, "A");
}

export function deriveMultiView(state: MultiGameCrossState): CrossView {
  return deriveView(state.inner);
}
```

Note: `OffchainTunnel`, `Party`, `HumanSeat`, `deriveView`, `CrossView` are already in scope from the existing file.

- [ ] **Step 4: Run, verify it passes**

Run: `cd frontend && node --import tsx --test "src/games/chickenCross/session-core.test.ts"`
Expected: PASS (existing + 2 new tests).

- [ ] **Step 5: Format + commit**

```bash
cd frontend && pnpm prettier --write src/games/chickenCross/session-core.ts src/games/chickenCross/session-core.test.ts
git add frontend/src/games/chickenCross/session-core.ts frontend/src/games/chickenCross/session-core.test.ts
git commit -m "feat(cross): multi-game session-core helpers"
```

---

## Task 5: chicken-cross — out-of-React multi-game `CrossBotSession` hook

Rewrite `useChickenCrossSession` to battleship's out-of-React `BotSession` shape, driving the multi-game protocol. **Copy `frontend/src/games/battleship/useBattleship.ts` as the structural template** and apply the deltas below; the funding/sponsor/heartbeat/settle bodies are lifted from the CURRENT `useChickenCrossSession.ts` (which already has the correct sponsor path) and from battleship.

**Files:**

- Modify (rewrite): `frontend/src/games/chickenCross/useChickenCrossSession.ts`

**Interfaces:**

- Produces (the hook's return — superset of today's, additive so the window/board can adopt incrementally):

  ```ts
  interface ChickenCrossSession {
    status: "idle" | "funding" | "playing" | "settling" | "settled" | "error";
    view: CrossView | null;
    result: SessionResult | null;
    stake: number;
    error: string | null;
    auto: boolean; // default true
    score: { you: number; foe: number }; // NEW
    gamesPlayed: number; // NEW
    start: (stake: number) => void;
    reset: () => void;
    setDir: (dir: CrossDir) => void;
    toggleAuto: () => void;
    settleNow: () => void; // NEW — settle the tunnel now (cash out)
  }
  function useChickenCrossSession(windowId: string): ChickenCrossSession; // NEW param
  ```

- [ ] **Step 1: Build the `CrossBotSession` class skeleton**

Mirror battleship's `BotSession` (`useBattleship.ts:133-693`). Fields: `deps`, `status`, `view`, `error`, `auto=true`, `snap`, `listeners`, `tunnel: OffchainTunnel<MultiGameCrossState, CrossMove> | null`, `protocol: MultiGameCrossProtocol | null`, `transcript`, `settleRequested`, `score={you:0,foe:0}`, `lastScoredGames=-1`, `tunnelId`, `createdAt`, `onChain`, `advancing`, `starting`, `gen`, control-plane `session`/`moveCount`/`actions`/`lastHeartbeat`, plus cross-specific `stake` and `nextDir` ref equivalent (a field `pendingDir?: CrossDir`).

Copy verbatim from battleship: `subscribe`, `getSnapshot`, `emit` (add `score`, `gamesPlayed: this.tunnel?.state.gamesPlayed ?? 0`, `stake`, `result`), `setStatus`, `fail`, `reset`, `dispose`, `flushHeartbeat`.

- [ ] **Step 2: `pushView` reads the inner state**

```ts
private pushView() {
  if (this.tunnel) this.view = deriveMultiView(this.tunnel.state);
  this.emit();
}
```

- [ ] **Step 3: `recordGameResult` — tally once per finished game**

```ts
/** Tally the just-finished inner game once (keyed by gamesPlayed). Push/draw → no tally. */
private recordGameResult() {
  if (!this.tunnel) return;
  const game = this.tunnel.state.gamesPlayed;
  if (game === this.lastScoredGames) return;
  const winner = this.tunnel.state.inner.winner; // "A" | "B" | null
  this.lastScoredGames = game;
  if (winner === "A") this.score = { ...this.score, you: this.score.you + 1 };
  else if (winner === "B") this.score = { ...this.score, foe: this.score.foe + 1 };
  // winner null = push → no tally, game still counts toward gamesPlayed.
}
```

- [ ] **Step 4: `advance` — the multi-game loop (frame-budgeted, async)**

```ts
private advance = async () => {
  if (this.advancing) return;
  this.advancing = true;
  const myGen = this.gen;
  const tunnel = this.tunnel;
  const protocol = this.protocol;
  try {
    while (tunnel && protocol) {
      // Batch ticks under the frame budget (cross's throughput showcase), then yield.
      const deadline = performance.now() + FRAME_BUDGET_MS;
      let boundary: StepOutcome = "stepped";
      for (let n = 0; n < MAX_STEPS_PER_FRAME; n++) {
        const human = this.auto
          ? null
          : { seat: HUMAN_SEAT, getDir: () => { const d = this.pendingDir; this.pendingDir = undefined; return d; } };
        boundary = stepMultiGame(protocol, tunnel, Math.random, human);
        if (boundary === "stepped") {
          this.moveCount += 1; this.actions += 1;
          if (performance.now() >= deadline) break;
        } else break;
      }
      this.pushView();
      this.flushHeartbeat(false);
      if (boundary === "stepped") { await sleep(0); if (this.gen !== myGen || this.tunnel !== tunnel) return; continue; }
      if (boundary === "session-over") { break; } // exhausted — leave for settle
      // boundary === "game-over": record, then rematch (auto) or stop.
      this.recordGameResult();
      this.pushView();
      if (!this.auto || this.settleRequested) break;
      await sleep(CROSS_REMATCH_MS); // a beat so the result + score register
      if (this.gen !== myGen || this.tunnel !== tunnel) return;
      kickoffNextGame(tunnel);
      this.pushView();
    }
  } catch (e) { this.fail(e); }
  finally { this.advancing = false; }
};
```

Add module constants near the top: `const sleep = (ms:number)=>new Promise<void>(r=>setTimeout(r,ms));` and `const CROSS_REMATCH_MS = 600;` (the between-games beat). Keep `FRAME_MS`, `FRAME_BUDGET_MS`, `MAX_STEPS_PER_FRAME`.

- [ ] **Step 5: `start` — fund (sponsor path) + build the MULTI-game tunnel**

Lift the funding block VERBATIM from the current `useChickenCrossSession.ts:124-211` (the `isDopamintConfigured` / `withSponsorFallback` open, `readCreatedAt`, transcript `onUpdate`, control-plane register, `flushHeartbeat`). Apply exactly these deltas:

1. `const protocol = new MultiGameCrossProtocol(tunnelId, stakeBig);` — **after** `tunnelId` is known (funding returns it), not before.
2. `const tunnel = OffchainTunnel.selfPlay(protocol, tunnelId, a.keyPair, b.keyPair, a.address, b.address, { a: stakeBig, b: stakeBig });`
3. After `setStatus("playing"); this.pushView();` call `void this.advance();` (battleship-style) instead of the old `setInterval`.
4. Move all `setX`/`refX` state onto class fields (`this.tunnel`, `this.protocol`, `this.transcript`, `this.tunnelId`, `this.createdAt`, `this.stake`, `this.onChain = true`).
5. Guard re-entry with `this.starting` + status check (copy battleship `startBattle:478-481`).

- [ ] **Step 6: `settleNow` + `settle` — settle anytime, with root**

Copy battleship `settleNow` (`useBattleship.ts:660-666`) and `settle` (`315-359`) verbatim, swapping `label: "chickenCross"` and using `this.tunnel.buildSettlementWithRoot(this.createdAt, transcript.root(), 0n)`. The current cross hook's `settleOnChain` already shows the exact `settleViaBackend` + `closeCooperativeWithRoot` shape — reuse it inside the class `settle`, but make it callable any time (not only at terminal). On settle set `this.result = sessionResult(this.tunnel.state.inner)`.

- [ ] **Step 7: `start`/`setDir`/`toggleAuto`/`setAuto` public methods + the store + hook**

- `setDir(dir)` → `this.pendingDir = dir`.
- `toggleAuto()` → flip `this.auto`, clear `pendingDir`, `emit()`, and if turning on while `status==="playing"` call `void this.advance()` (battleship `setAuto:624-631`).
- Store + hook: copy battleship `botSessions`/`getBotSession`/`useBattleship` (`695-751`) verbatim, renamed `crossSessions`/`getCrossSession`/`useChickenCrossSession(windowId)`; `registerWindowDisposer(windowId, "chicken-cross-bot", …)`. `deps` carries `report`, `account`, `client`, `signExec`, `sponsoredSignExec`, `selectStakeCoin`, `prepareStake` (same as battleship's hook body).

- [ ] **Step 8: Typecheck**

Run: `cd frontend && pnpm typecheck`
Expected: PASS (the window/board still compile against the superset return; `windowId` arg added in Task 6).

Note: this task does not add a unit test (the class is React/wallet-bound); its behavior is proven by the session-core multi-game tests (Task 4) + the manual verification at the end. Commit:

```bash
git add frontend/src/games/chickenCross/useChickenCrossSession.ts
git commit -m "feat(cross): out-of-React multi-game solo session"
```

---

## Task 6: chicken-cross — window + board wiring (survival, score, settle)

**Files:**

- Modify: `frontend/src/games/chickenCross/ChickenCrossWindow.tsx`
- Modify: `frontend/src/games/chickenCross/components/CrossBoard.tsx`

- [ ] **Step 1: Window — pass `windowId`, persist solo across remount**

In `ChickenCrossWindow.tsx`: call `const solo = useChickenCrossSession(windowId);`. Because the session now lives out-of-React (windowId-keyed), persist `"solo"` in `modeStore` too so a remount returns to the live solo game (today only `"pvp"` is stored). Change `modeStore` to `Map<string, "solo" | "pvp">` and store `"solo"` on solo start; the existing dispose clears it.

- [ ] **Step 2: Board — show running score + Settle, keep "again" as rematch**

In `CrossBoard.tsx` add props `score?: { you: number; foe: number }`, `gamesPlayed?: number`, `onSettle?: () => void`. Render the score in the existing stat pane (`cross-*` styled, e.g. `you {score.you} – {score.foe} foe · game {gamesPlayed+1}`) and a `cross-*` styled Settle button visible while a tunnel is live (status playing). Pass them from the window: `score={solo.score} gamesPlayed={solo.gamesPlayed} onSettle={solo.settleNow}`. The existing result card's "again" now calls back into the session to continue — for solo, auto-on rematches automatically; with auto off, wire the result CTA to `solo.toggleAuto()`-then-continue OR a dedicated `solo`-continue. Simplest: keep auto **on by default**, so the board's result flashes and the next game starts automatically; the manual "again" path stays `onPlayAgain` (back to lobby) as today. (Manual same-tunnel rematch is the auto-off toggle.)

- [ ] **Step 3: Typecheck + commit**

```bash
cd frontend && pnpm typecheck
git add frontend/src/games/chickenCross/ChickenCrossWindow.tsx frontend/src/games/chickenCross/components/CrossBoard.tsx
git commit -m "feat(cross): solo survives remount; score + settle UI"
```

---

## Task 7: bomb-it session-core — multi-game helpers

Identical shape to Task 4, for bomb-it's action-based moves.

**Files:**

- Modify: `frontend/src/games/bombIt/session-core.ts`
- Test: `frontend/src/games/bombIt/session-core.test.ts`

**Interfaces:**

- Produces: `StepOutcome`, `stepMultiGame(protocol: MultiGameBombItProtocol, tunnel, rng, human?)`, `kickoffNextGame(tunnel)` (steps `{ a: "stay" }`, "A"), `deriveMultiView(state): BombItView`.

- [ ] **Step 1: Write the failing test** (append to `bombIt/session-core.test.ts`, mirroring Task 4's two new tests but with `MultiGameBombItProtocol`, `getAction`, and `{ a:"stay" }` kickoff). Assert `stepMultiGame` makes progress + `verifyCoSignedUpdate`, and `kickoffNextGame` bumps `gamesPlayed` to 1.

```ts
import { MultiGameBombItProtocol } from "../../../../sui-tunnel-ts/src/protocol/multiGameBombIt.ts";
import {
  stepMultiGame,
  kickoffNextGame,
  deriveMultiView,
} from "./session-core.ts";
// ...freshMultiTunnel() mirrors Task 4 with BombItProtocol's MIN stake (BOMB_IT_MIN_STAKE)
test("stepMultiGame advances a multi-game duel and stays settleable", () => {
  /* mirror Task 4 */
});
test("kickoffNextGame starts game 2 after a duel ends", () => {
  /* mirror Task 4, { a:'stay' } */
});
```

(Repeat the full bodies from Task 4 with the bomb-it imports — do not abbreviate when writing the file.)

- [ ] **Step 2: Run, verify fail.** `cd frontend && node --import tsx --test "src/games/bombIt/session-core.test.ts"`

- [ ] **Step 3: Add helpers** to `bombIt/session-core.ts`:

```ts
import type {
  MultiGameBombItProtocol,
  MultiGameBombItState,
} from "sui-tunnel-ts/protocol/multiGameBombIt";
import type { BombItMove } from "sui-tunnel-ts/protocol/bombIt";

export type StepOutcome = "stepped" | "game-over" | "session-over";

export function stepMultiGame(
  protocol: MultiGameBombItProtocol,
  tunnel: OffchainTunnel<MultiGameBombItState, BombItMove>,
  rng: () => number,
  human?: HumanSeat | null,
): StepOutcome {
  if (protocol.isTerminal(tunnel.state)) return "session-over";
  if (protocol.isGameOver(tunnel.state)) return "game-over";
  const by: Party = tunnel.state.inner.tick % 2n === 0n ? "A" : "B";
  let move: BombItMove | null;
  if (human && human.seat === by) {
    const a = human.getAction();
    move = by === "A" ? { a } : { b: a };
  } else {
    move = protocol.randomMove(tunnel.state, by, rng);
  }
  if (!move) return "game-over";
  tunnel.step(move, by);
  return "stepped";
}

export function kickoffNextGame(
  tunnel: OffchainTunnel<MultiGameBombItState, BombItMove>,
): void {
  tunnel.step({ a: "stay" }, "A");
}

export function deriveMultiView(state: MultiGameBombItState): BombItView {
  return deriveView(state.inner);
}
```

- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Format + commit** `feat(bomb-it): multi-game session-core helpers`

---

## Task 8: bomb-it — out-of-React multi-game `BombBotSession` hook **(+ sponsor fix)**

The biggest task: bomb-it gains BOTH the out-of-React multi-game session AND the sponsor/DOPAMINT/backend-settle path it lacks. **Copy `useChickenCrossSession.ts` AS REWRITTEN IN TASK 5** (it now has the exact shape AND the sponsor path) and swap the protocol/cadence/move type.

**Files:**

- Modify (rewrite): `frontend/src/games/bombIt/useBombItSession.ts`

**Interfaces:**

- Produces:

  ```ts
  interface BombItSession {
    status: "idle" | "funding" | "playing" | "settling" | "settled" | "error";
    view: BombItView | null;
    result: BombItResult | null;
    stake: number;
    error: string | null;
    auto: boolean; // default true
    score: { you: number; foe: number }; // NEW
    gamesPlayed: number; // NEW
    start: (stake: number) => void;
    reset: () => void;
    queueAction: (a: BombItAction) => void;
    toggleAuto: () => void;
    settleNow: () => void; // NEW
  }
  function useBombItSession(windowId: string): BombItSession; // NEW param
  ```

- [ ] **Step 1: Port the sponsor imports** — add to the top (these are the imports bomb-it is MISSING today; copy from chicken-cross): `Transcript`, `settleViaBackend`, `closeCooperativeWithRoot`, `useSponsoredSignExec`, `withSponsorFallback`, `DOPAMINT_COIN_TYPE`, `isDopamintConfigured`. Replace `closeCooperative` usage.

- [ ] **Step 2: Build `BombBotSession`** mirroring `CrossBotSession` (Task 5) with:
  - `protocol: MultiGameBombItProtocol`, `tunnel: OffchainTunnel<MultiGameBombItState, BombItMove>`.
  - `pendingAction?: BombItAction` (replaces cross's `pendingDir`); `queueAction(a)` sets it; `human.getAction` reads+clears it.
  - **Cadence:** bomb-it steps ONE tick per `SOLO_STEP_MS`, so the advance loop body is the single-step form (not the frame-budget batch):
    ```ts
    while (tunnel && protocol) {
      const human = this.auto
        ? null
        : {
            seat: HUMAN_SEAT,
            getAction: () => {
              const a = this.pendingAction ?? "stay";
              this.pendingAction = undefined;
              return a;
            },
          };
      const boundary = stepMultiGame(protocol, tunnel, Math.random, human);
      if (boundary === "stepped") {
        this.moveCount += 1;
        this.actions += 1;
        this.pushView();
        this.flushHeartbeat(false);
        await sleep(SOLO_STEP_MS);
        if (this.gen !== myGen || this.tunnel !== tunnel) return;
        continue;
      }
      this.pushView();
      if (boundary === "session-over") break;
      this.recordGameResult();
      this.pushView();
      if (!this.auto || this.settleRequested) break;
      await sleep(BOMB_REMATCH_MS);
      if (this.gen !== myGen || this.tunnel !== tunnel) return;
      kickoffNextGame(tunnel);
      this.pushView();
    }
    ```
    Add `const BOMB_REMATCH_MS = 700;`. Keep `SOLO_STEP_MS` imported from session-core.
  - **`recordGameResult`:** bomb-it winner is `"A" | "B" | "draw" | null`; tally only `"A"`/`"B"`, skip `"draw"`/`null`.
  - **Funding (THE FIX):** copy the chicken-cross `start` funding block (sponsor/DOPAMINT/`withSponsorFallback`) VERBATIM, swapping `game: "bomb-it"`, `new BombItProtocol()` → `new MultiGameBombItProtocol(tunnelId, stakeBig)`, stake floor `BOMB_IT_MIN_STAKE`. This replaces today's raw-wallet `openAndFundSelfPlay(signExec)` + `closeCooperative`.
  - **`settle`:** `buildSettlementWithRoot` + `settleViaBackend({ label: "bombIt", … , fallbackClose: closeCooperativeWithRoot(...) })`; `this.result = sessionResult(this.tunnel.state.inner)`.
  - Store/hook: `bombSessions`/`getBombSession`/`useBombItSession(windowId)` + `registerWindowDisposer(windowId, "bomb-it-bot", …)`; `deps` includes the sponsored signer + stake selectors (battleship hook body).

- [ ] **Step 3: Typecheck**

Run: `cd frontend && pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/games/bombIt/useBombItSession.ts
git commit -m "feat(bomb-it): sponsored out-of-React multi-game session"
```

---

## Task 9: bomb-it — window + board wiring (survival, score, settle)

**Files:**

- Modify: `frontend/src/games/bombIt/BombItWindow.tsx`
- Modify: `frontend/src/games/bombIt/components/BombBoard.tsx`

- [ ] **Step 1: Window** — `const solo = useBombItSession(windowId);`; widen `modeStore` to `Map<string, "solo" | "pvp">` and store `"solo"` so a remount returns to the live solo match (today's comment that solo "is gone on remount" no longer applies — update it).

- [ ] **Step 2: Board** — add props `score?`, `gamesPlayed?`, `onSettle?` to `BombBoard`; render the running score in the existing `bomb-stats` pane and a `bomb-*` styled Settle button while live; pass `score={solo.score} gamesPlayed={solo.gamesPlayed} onSettle={solo.settleNow}` from the window. Auto stays default-on so finished duels flash then auto-rematch; `onPlayAgain` stays "back to menu".

- [ ] **Step 3: Typecheck + commit**

```bash
cd frontend && pnpm typecheck
git add frontend/src/games/bombIt/BombItWindow.tsx frontend/src/games/bombIt/components/BombBoard.tsx
git commit -m "feat(bomb-it): solo survives remount; score + settle UI"
```

---

## Task 10: Full gate + PvP/battleship re-verification

**Files:** none (verification only).

- [ ] **Step 1: SDK protocol suite** (incl. the two new golden tests)

```bash
cd sui-tunnel-ts && node --import tsx --test src/protocol/cross.test.ts src/protocol/bombIt.test.ts src/protocol/multiGameCross.test.ts src/protocol/multiGameBombIt.test.ts
```

Expected: all PASS.

- [ ] **Step 2: Frontend session-core suites**

```bash
cd frontend && node --import tsx --test "src/games/bombIt/session-core.test.ts" "src/games/chickenCross/session-core.test.ts"
```

Expected: all PASS.

- [ ] **Step 3: Typecheck + build**

```bash
cd frontend && pnpm typecheck && pnpm build
```

Expected: 0 errors; build OK.

- [ ] **Step 4: Run the app, manually verify the parity (per `superpowers:verification-before-completion`)**

Use the `/run` flow. Confirm, for BOTH games:

1. Open with a wallet connected → solo funds (sponsored — no "No valid gas coins" for bomb-it) and auto-plays.
2. A finished game flashes a result, bumps the running score, and auto-rematches on the SAME tunnel (no second wallet prompt) with a visibly DIFFERENT board.
3. Minimize then maximize (or resize) mid-match → the live match is still there (not back at the lobby).
4. Settle → closes once; status → settled.
5. PvP still matches + settles (unchanged).

- [ ] **Step 5: Decide the PR #43 landing strategy** (deferred per the brainstorming decision) and integrate. Surface the finished diff + the chosen strategy before any force-push.

---

## Self-Review (coverage vs spec)

- **Spec §"bomb-it funding"** → Task 8 Step 2 (sponsor/DOPAMINT/backend-settle port). ✓
- **Spec §"out-of-React survival"** → Tasks 5, 8 (BotSession + windowId store) + 6, 9 (window persists "solo"). ✓
- **Spec §"multi-game wrapper + per-game seed"** → Tasks 2, 3 + ADR Task 1; different-seed asserted. ✓
- **Spec §"settle-anytime + score"** → `settleNow`/`recordGameResult` (Tasks 5, 8); UI (6, 9). ✓
- **Spec §"cadence preserved"** → Task 5 frame-budget loop; Task 8 one-tick loop. ✓
- **Spec §"draw/push continuation"** → wrapper `isTerminal` (Tasks 2, 3) + `recordGameResult` skip + dedicated protocol tests. ✓
- **Spec §"PvP unchanged"** → Task 10 Step 4.5 re-verify. ✓
- **Gate** → Task 10 Steps 1-3 match the spec's gate block. ✓

**Placeholder scan:** Task 7 Step 1 says "mirror Task 4 — do not abbreviate when writing the file"; the implementer copies the shown Task 4 bodies with bomb-it imports (full code is present in Task 4). No TODO/TBD remain.

**Type consistency:** `StepOutcome`, `stepMultiGame`, `kickoffNextGame`, `deriveMultiView`, `isGameOver`, `score`, `gamesPlayed`, `settleNow` are named identically across Tasks 2-9. Hook signatures gain `windowId` consistently (Tasks 5, 8) and the windows pass it (Tasks 6, 9).
</content>
