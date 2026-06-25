# Canonical Game Bot Kit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `GameKit` / `GameBot` / `BotContext` contract and registry, plus per-game adapters for tic-tac-toe, blackjack, battleship, and quantum-poker, and a local two-bot test harness that proves each kit can play a full game to settlement.

**Architecture:** A small pure-TS core (`frontend/src/agent/gameKit.ts`) defines the types and registry. Each game owns an adapter under `frontend/src/agent/games/<game>/kit.ts` that wraps its existing FE protocol and existing bot/AI code. A local two-bot harness drives `protocol.applyMove` directly in a loop until `isTerminal`, verifying domain-tag parity, move legality, balance conservation, idempotency, and import hygiene.

**Tech Stack:** TypeScript, Node `node:test` via `tsx`, pnpm, Vite path aliases (`@/`). All testable code must import cleanly under `tsx` outside Vite.

> **Note on harness design:** the local two-bot harness does **not** need a real `DistributedTunnel` or signatures. It drives `protocol.applyMove` directly in a loop, which is sufficient to prove move legality, balance conservation, and full-game-to-terminal properties. Signing and settlement are deferred to the production fleet driver.

---

## File structure

| File                                                | Responsibility                                                                         |
| --------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `frontend/src/agent/gameKit.ts`                     | `GameKit`, `GameBot`, `BotContext` types; `GAME_KITS` registry; `StateHash` helper.    |
| `frontend/src/agent/gameKit.test.ts`                | Smoke tests for the registry, type imports, and `GAME_KITS` completeness.              |
| `frontend/src/agent/games/ticTacToe/kit.ts`         | Tic-tac-toe adapter wrapping `MultiGameTicTacToeProtocol` and `pickCell`.              |
| `frontend/src/agent/games/ticTacToe/kit.test.ts`    | Tic-tac-toe kit tests: domain parity, full game, idempotency.                          |
| `frontend/src/agent/games/blackjack/kit.ts`         | Blackjack adapter wrapping `BlackjackBetProtocol` and basic strategy.                  |
| `frontend/src/agent/games/blackjack/kit.test.ts`    | Blackjack kit tests: domain parity, full game, conserved balances.                     |
| `frontend/src/agent/games/battleship/kit.ts`        | Battleship adapter wrapping `BattleshipProtocol` and per-seat fleet logic.             |
| `frontend/src/agent/games/battleship/kit.test.ts`   | Battleship kit tests: domain parity, full game, truthful reveals.                      |
| `frontend/src/agent/games/quantumPoker/kit.ts`      | Quantum poker adapter wrapping `QuantumPokerProtocol` and `QuantumPokerPersonaDriver`. |
| `frontend/src/agent/games/quantumPoker/kit.test.ts` | Quantum poker kit tests: domain parity, full hand to `done`.                           |
| `frontend/src/agent/testHarness.ts`                 | Local two-bot loopback harness used by kit tests.                                      |
| `frontend/src/agent/testHarness.test.ts`            | Harness self-tests.                                                                    |
| `frontend/package.json`                             | Add `src/agent/**/*.test.ts` to the `test` script so agent tests run in CI.            |

---

## Task 1: Core contract types

**Files:**

- Create: `frontend/src/agent/gameKit.ts`

- [ ] **Step 1: Write `gameKit.ts`**

```ts
import type {
  Protocol,
  Party,
  ProtocolContext,
  Balances,
} from "sui-tunnel-ts/protocol/Protocol";

export type GameId = "tictactoe" | "blackjack" | "battleship" | "quantum-poker";
export type StateHash = string;

export interface BotContext {
  /** Per-seat, seeded, reproducible RNG stream. */
  rngForSeat(seat: Party): () => number;
}

export interface GameKit<S, M> {
  id: GameId;
  /** The real frontend protocol class the human `usePvp*` hook uses. */
  protocol: Protocol<S, M>;
  /** Stable state digest for idempotency checks. */
  stateHash(state: S): StateHash;
  createBot(seat: Party, ctx: BotContext): GameBot<S, M>;
  defaultStake: bigint;
}

export interface GameBot<S, M> {
  /** Purely decide this seat's next move. Null = not my turn / waiting on peer. */
  plan(state: S): M | null;
  /** Advance retained memory AFTER the move has been accepted by the protocol. */
  confirm(state: S, move: M): void;
  /** Teardown after an error or unclean close. */
  abort(): void;
}

export type GameKitRegistry = Record<GameId, GameKit<unknown, unknown>>;

/** To be populated in Task 11 after all kits exist. */
export const GAME_KITS: GameKitRegistry = {} as GameKitRegistry;

/** Default state hash: hex of protocol.encodeState. */
export function defaultStateHash<S, M>(
  protocol: Protocol<S, M>,
  state: S,
): StateHash {
  return Buffer.from(protocol.encodeState(state)).toString("hex");
}
```

- [ ] **Step 2: Run TypeScript check**

Run: `cd frontend && pnpm run typecheck`
Expected: no errors in `src/agent/gameKit.ts`.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/agent/gameKit.ts
git commit -m "feat(agent): add GameKit contract types"
```

---

## Task 2: Test harness for local two-bot play

**Files:**

- Create: `frontend/src/agent/testHarness.ts`
- Create: `frontend/src/agent/testHarness.test.ts`

- [ ] **Step 1: Write `testHarness.ts`**

```ts
import type { Party, ProtocolContext } from "sui-tunnel-ts/protocol/Protocol";
import type { GameBot, GameKit, StateHash } from "./gameKit";

export interface HarnessResult<S> {
  finalState: S;
  moves: Array<{ by: Party; move: unknown }>;
  accepted: number;
}

export function driveToTerminal<S, M>(
  kit: GameKit<S, M>,
  botA: GameBot<S, M>,
  botB: GameBot<S, M>,
  ctx: ProtocolContext,
): HarnessResult<S> {
  const moves: Array<{ by: Party; move: M }> = [];
  let accepted = 0;
  let state = kit.protocol.initialState(ctx);
  let lastHashes: Record<Party, StateHash | null> = { A: null, B: null };
  const maxRounds = 10_000;

  for (let round = 0; round < maxRounds; round++) {
    if (kit.protocol.isTerminal(state)) break;

    let progressThisRound = false;
    for (const actor of ["A", "B"] as Party[]) {
      const bot = actor === "A" ? botA : botB;
      const h = kit.stateHash(state);
      if (lastHashes[actor] === h) continue;

      const move = bot.plan(state);
      if (move === null) continue;

      let next: S;
      try {
        next = kit.protocol.applyMove(state, move, actor);
      } catch (err) {
        throw new Error(
          `Rejected move for ${actor} in ${kit.id}: ${JSON.stringify(move)}\n${String(err)}`,
        );
      }

      bot.confirm(state, move);
      lastHashes[actor] = h;
      lastHashes[otherParty(actor)] = null; // opponent must re-evaluate the new state
      state = next;
      moves.push({ by: actor, move });
      accepted++;
      progressThisRound = true;
    }

    if (!progressThisRound) {
      throw new Error(
        `No progress in ${kit.id} at round ${round}; game is not terminal.`,
      );
    }
  }

  return {
    finalState: state,
    moves: moves as Array<{ by: Party; move: unknown }>,
    accepted,
  };
}

function otherParty(p: Party): Party {
  return p === "A" ? "B" : "A";
}
```

- [ ] **Step 2: Write `testHarness.test.ts`**

```ts
import { describe, it } from "node:test";
import assert from "node:assert";
import { TicTacToeProtocol } from "sui-tunnel-ts/protocol/ticTacToe";
import { driveToTerminal } from "./testHarness";
import type { GameBot, GameKit } from "./gameKit";
import type { ProtocolContext } from "sui-tunnel-ts/protocol/Protocol";

describe("testHarness", () => {
  it("drives a simple SDK tic-tac-toe game to terminal", () => {
    const protocol = new TicTacToeProtocol(10n);
    const ctx: ProtocolContext = {
      tunnelId: "tunnel-1",
      initialBalances: { a: 100n, b: 100n },
    };

    const kit: GameKit<unknown, unknown> = {
      id: "tictactoe",
      protocol: protocol as never,
      stateHash: (s) =>
        Buffer.from(protocol.encodeState(s as never)).toString("hex"),
      createBot: (seat) =>
        ({
          plan: (state) =>
            protocol.randomMove(state as never, seat, Math.random),
          confirm: () => {},
          abort: () => {},
        }) as GameBot<unknown, unknown>,
      defaultStake: 10n,
    };

    const botA = kit.createBot("A", { rngForSeat: () => Math.random });
    const botB = kit.createBot("B", { rngForSeat: () => Math.random });
    const result = driveToTerminal(kit, botA, botB, ctx);

    assert.ok(protocol.isTerminal(result.finalState as never));
    assert.ok(result.accepted > 0);
  });
});
```

- [ ] **Step 3: Run harness test**

Run: `cd frontend && node --import tsx --test src/agent/testHarness.test.ts`
Expected: 1 passing test.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/agent/testHarness.ts frontend/src/agent/testHarness.test.ts
git commit -m "feat(agent): add local two-bot test harness"
```

---

## Task 3: Tic-tac-toe kit

**Files:**

- Create: `frontend/src/agent/games/ticTacToe/kit.ts`
- Create: `frontend/src/agent/games/ticTacToe/kit.test.ts`

- [ ] **Step 1: Write `frontend/src/agent/games/ticTacToe/kit.ts`**

```ts
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import { protocols } from "sui-tunnel-ts";
import {
  MultiGameTicTacToeProtocol,
  type MultiGameTicTacToeState,
  type MultiGameTicTacToeMove,
} from "@ttt/shared/ttt/multiGameProtocol";
import { optimalMoves } from "@ttt/shared/ttt/minimax";
import { CELL_EMPTY, CELL_SERVER, CELL_PLAYER } from "@ttt/shared/constants";
import {
  defaultStateHash,
  type BotContext,
  type GameBot,
  type GameKit,
} from "@/agent/gameKit";

export type TicTacToeDifficulty = "perfect" | "fast";

export interface TicTacToeBotConfig {
  difficulty?: TicTacToeDifficulty;
}

function pickCell(
  state: protocols.TicTacToeState,
  seat: Party,
  difficulty: TicTacToeDifficulty,
  rng: () => number,
): number {
  const empties = state.board
    .map((v, i) => (v === 0 ? i : -1))
    .filter((i) => i >= 0);
  if (empties.length === 0) return -1;

  if (difficulty === "fast") {
    return empties[Math.floor(rng() * empties.length)];
  }

  // Perfect play via minimax. Map protocol marks (1 = seat, 2 = opponent) to the
  // CELL_SERVER / CELL_PLAYER convention expected by optimalMoves.
  const mark = seat === "A" ? 1 : 2;
  const board = state.board.map((v) =>
    v === 0 ? CELL_EMPTY : v === mark ? CELL_SERVER : CELL_PLAYER,
  );
  const moves = optimalMoves(board, CELL_SERVER);
  return moves.length > 0 ? moves[0] : empties[0];
}

class TicTacToeBot implements GameBot<
  MultiGameTicTacToeState,
  MultiGameTicTacToeMove
> {
  private readonly seat: Party;
  private readonly difficulty: TicTacToeDifficulty;
  private readonly innerProtocol: protocols.TicTacToeProtocol;
  private readonly rng: () => number;

  constructor(
    seat: Party,
    stake: bigint,
    ctx: BotContext,
    config: TicTacToeBotConfig,
  ) {
    this.seat = seat;
    this.difficulty = config.difficulty ?? "perfect";
    this.innerProtocol = new protocols.TicTacToeProtocol(stake);
    this.rng = ctx.rngForSeat(seat);
  }

  plan(state: MultiGameTicTacToeState): MultiGameTicTacToeMove | null {
    const inner = state.inner;

    if (this.innerProtocol.isTerminal(inner)) {
      // Advance to next game if the session is not over. Only party A emits the advance trigger.
      if (state.gamesPlayed + 1 < state.maxGames && this.seat === "A") {
        return { cell: 0 };
      }
      return null;
    }

    if (inner.turn !== this.seat) return null;
    return { cell: pickCell(inner, this.seat, this.difficulty, this.rng) };
  }

  confirm(): void {
    // No retained memory.
  }

  abort(): void {
    // No retained memory.
  }
}

export function createTicTacToeKit(
  maxGames: number,
  stake: bigint,
  config: TicTacToeBotConfig = {},
): GameKit<MultiGameTicTacToeState, MultiGameTicTacToeMove> {
  const protocol = new MultiGameTicTacToeProtocol(maxGames, stake);

  return {
    id: "tictactoe",
    protocol,
    stateHash: (state) => defaultStateHash(protocol, state),
    createBot: (seat: Party, ctx: BotContext) =>
      new TicTacToeBot(seat, stake, ctx, config),
    defaultStake: stake,
  };
}
```

- [ ] **Step 2: Write `frontend/src/agent/games/ticTacToe/kit.test.ts`**

```ts
import { describe, it } from "node:test";
import assert from "node:assert";
import { protocols } from "sui-tunnel-ts";
import { driveToTerminal } from "@/agent/testHarness";
import { createTicTacToeKit } from "./kit";
import type { ProtocolContext } from "sui-tunnel-ts/protocol/Protocol";

describe("ticTacToe kit", () => {
  const ctx: ProtocolContext = {
    tunnelId: "ttt-1",
    initialBalances: { a: 100n, b: 100n },
  };

  it("uses the multi-game frontend protocol domain", () => {
    const kit = createTicTacToeKit(3, 10n);
    assert.strictEqual(kit.protocol.name, "tic_tac_toe.multi.v1");
    assert.notStrictEqual(
      kit.protocol.name,
      new protocols.TicTacToeProtocol(10n).name,
    );
  });

  it("drives a full multi-game session to terminal with conserved balances", () => {
    const kit = createTicTacToeKit(3, 10n);
    const botA = kit.createBot("A", { rngForSeat: () => Math.random });
    const botB = kit.createBot("B", { rngForSeat: () => Math.random });
    const result = driveToTerminal(kit, botA, botB, ctx);

    assert.ok(kit.protocol.isTerminal(result.finalState));
    const balances = kit.protocol.balances(result.finalState);
    assert.strictEqual(
      balances.a + balances.b,
      ctx.initialBalances.a + ctx.initialBalances.b,
    );
  });

  it("is deterministic and idempotent on replayed state", () => {
    const kit = createTicTacToeKit(1, 10n);
    const state = kit.protocol.initialState(ctx);
    const bot = kit.createBot("A", { rngForSeat: () => Math.random });
    const move1 = bot.plan(state);
    const move2 = bot.plan(state);
    assert.deepStrictEqual(move1, move2);
  });
});
```

- [ ] **Step 3: Run tic-tac-toe tests**

Run: `cd frontend && node --import tsx --test src/agent/games/ticTacToe/kit.test.ts`
Expected: 3 passing tests.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/agent/games/ticTacToe/kit.ts frontend/src/agent/games/ticTacToe/kit.test.ts
git commit -m "feat(agent): add tic-tac-toe game kit"
```

---

## Task 4: Blackjack kit

**Files:**

- Create: `frontend/src/agent/games/blackjack/kit.ts`
- Create: `frontend/src/agent/games/blackjack/kit.test.ts`

- [ ] **Step 1: Write `frontend/src/agent/games/blackjack/kit.ts`**

```ts
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import {
  BlackjackBetProtocol,
  actorFor,
  fixedBetMove,
  getPlayerParty,
  getDealerParty,
  BET_OPTIONS,
  MIN_BET,
  type BetBlackjackState,
  type BetBlackjackMove,
} from "@/games/blackjack/app/lib/bjBetProtocol";
import { handValue } from "@/games/blackjack/app/lib/bjCards";
import {
  defaultStateHash,
  type BotContext,
  type GameBot,
  type GameKit,
} from "@/agent/gameKit";

class BlackjackBot implements GameBot<BetBlackjackState, BetBlackjackMove> {
  private readonly seat: Party;

  constructor(seat: Party) {
    this.seat = seat;
  }

  plan(state: BetBlackjackState): BetBlackjackMove | null {
    if (new BlackjackBetProtocol().isTerminal(state)) return null;
    if (actorFor(state) !== this.seat) return null;

    if (state.phase === "round_over") {
      const cap =
        state.balanceA < state.balanceB ? state.balanceA : state.balanceB;
      const options = BET_OPTIONS.filter(
        (o) => BigInt(o) >= MIN_BET && BigInt(o) <= cap,
      );
      const amount = options.length > 0 ? options[0] : Number(MIN_BET);
      return fixedBetMove(amount, state);
    }

    if (state.phase === "player") {
      if (this.seat !== getPlayerParty(state.round)) return null;
      return { action: handValue(state.playerHand) < 17 ? "hit" : "stand" };
    }

    if (state.phase === "dealer") {
      if (this.seat !== getDealerParty(state.round)) return null;
      return { action: "stand" };
    }

    return null;
  }

  confirm(): void {
    // No retained memory beyond the public state.
  }

  abort(): void {
    // No retained memory.
  }
}

export function createBlackjackKit(
  stake: bigint,
): GameKit<BetBlackjackState, BetBlackjackMove> {
  const protocol = new BlackjackBetProtocol(stake);

  return {
    id: "blackjack",
    protocol,
    stateHash: (state) => defaultStateHash(protocol, state),
    createBot: (seat: Party, _ctx: BotContext) => new BlackjackBot(seat),
    defaultStake: stake,
  };
}
```

- [ ] **Step 2: Write `frontend/src/agent/games/blackjack/kit.test.ts`**

```ts
import { describe, it } from "node:test";
import assert from "node:assert";
import { protocols } from "sui-tunnel-ts";
import { driveToTerminal } from "@/agent/testHarness";
import { createBlackjackKit } from "./kit";
import type { ProtocolContext } from "sui-tunnel-ts/protocol/Protocol";

describe("blackjack kit", () => {
  const ctx: ProtocolContext = {
    tunnelId: "bj-1",
    initialBalances: { a: 1000n, b: 1000n },
  };

  it("uses the variable-bet frontend protocol domain", () => {
    const kit = createBlackjackKit(100n);
    assert.strictEqual(kit.protocol.name, "blackjack.bet.v1");
    assert.notStrictEqual(
      kit.protocol.name,
      new protocols.BlackjackProtocol(100n).name,
    );
  });

  it("drives a full game to terminal with conserved balances", () => {
    const kit = createBlackjackKit(100n);
    const botA = kit.createBot("A", { rngForSeat: () => Math.random });
    const botB = kit.createBot("B", { rngForSeat: () => Math.random });
    const result = driveToTerminal(kit, botA, botB, ctx);

    assert.ok(kit.protocol.isTerminal(result.finalState));
    const balances = kit.protocol.balances(result.finalState);
    assert.strictEqual(
      balances.a + balances.b,
      ctx.initialBalances.a + ctx.initialBalances.b,
    );
  });
});
```

- [ ] **Step 3: Run blackjack tests**

Run: `cd frontend && node --import tsx --test src/agent/games/blackjack/kit.test.ts`
Expected: 2 passing tests.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/agent/games/blackjack/kit.ts frontend/src/agent/games/blackjack/kit.test.ts
git commit -m "feat(agent): add blackjack game kit"
```

---

## Task 5: Battleship kit

**Files:**

- Create: `frontend/src/agent/games/battleship/kit.ts`
- Create: `frontend/src/agent/games/battleship/kit.test.ts`

- [ ] **Step 1: Write `frontend/src/agent/games/battleship/kit.ts`**

```ts
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import { otherParty } from "sui-tunnel-ts/protocol/Protocol";
import {
  BattleshipProtocol,
  type BattleshipState,
  type BattleshipMove,
} from "@/games/battleship/protocol/battleship";
import {
  BOT_CONFIGS,
  type BotDifficulty,
  DEFAULT_BOT_DIFFICULTY,
  pickShot,
} from "@/games/battleship/engine/bot";
import {
  randomFleetSecret,
  type FleetSecret,
} from "@/games/battleship/engine/selfPlay";
import { proveCell } from "@/games/battleship/engine/merkle";
import {
  defaultStateHash,
  type BotContext,
  type GameBot,
  type GameKit,
} from "@/agent/gameKit";

export interface BattleshipBotConfig {
  difficulty?: BotDifficulty;
}

class BattleshipBot implements GameBot<BattleshipState, BattleshipMove> {
  private readonly seat: Party;
  private readonly secret: FleetSecret;
  private readonly rng: () => number;
  private readonly difficulty: BotDifficulty;

  constructor(seat: Party, ctx: BotContext, config: BattleshipBotConfig) {
    this.seat = seat;
    this.rng = ctx.rngForSeat(seat);
    this.secret = randomFleetSecret(this.rng);
    this.difficulty = config.difficulty ?? DEFAULT_BOT_DIFFICULTY;
  }

  plan(state: BattleshipState): BattleshipMove | null {
    if (state.phase === "over" || state.winner !== 0) return null;

    if (state.phase === "awaitingCommits") {
      const committed = this.seat === "A" ? state.commitA : state.commitB;
      if (committed !== null) return null;
      return { type: "commit", root: this.secret.commitment.root };
    }

    if (state.pendingShot) {
      if (otherParty(state.pendingShot.by) !== this.seat) return null;
      const cell = state.pendingShot.cell;
      return {
        type: "reveal",
        cell,
        isShip: this.secret.board[cell] === 1,
        salt: this.secret.salts[cell],
        proof: proveCell(this.secret.commitment, cell),
      };
    }

    if (state.turn !== this.seat) return null;
    return {
      type: "shoot",
      cell: pickShot(state, this.seat, this.rng, BOT_CONFIGS[this.difficulty]),
    };
  }

  confirm(): void {
    // Targeting state is derived from public state on each plan call.
  }

  abort(): void {
    // Memory is released when the instance is garbage-collected.
  }
}

export function createBattleshipKit(
  stake: bigint,
  config: BattleshipBotConfig = {},
): GameKit<BattleshipState, BattleshipMove> {
  const protocol = new BattleshipProtocol(stake);

  return {
    id: "battleship",
    protocol,
    stateHash: (state) => defaultStateHash(protocol, state),
    createBot: (seat: Party, ctx: BotContext) =>
      new BattleshipBot(seat, ctx, config),
    defaultStake: stake,
  };
}
```

- [ ] **Step 2: Write `frontend/src/agent/games/battleship/kit.test.ts`**

```ts
import { describe, it } from "node:test";
import assert from "node:assert";
import { driveToTerminal } from "@/agent/testHarness";
import { createBattleshipKit } from "./kit";
import type { ProtocolContext } from "sui-tunnel-ts/protocol/Protocol";

describe("battleship kit", () => {
  const ctx: ProtocolContext = {
    tunnelId: "bs-1",
    initialBalances: { a: 100n, b: 100n },
  };

  it("uses the frontend battleship protocol domain", () => {
    const kit = createBattleshipKit(10n);
    assert.strictEqual(kit.protocol.name, "battleship.v1");
  });

  it("drives a full game to terminal with conserved balances and no rejected moves", () => {
    const kit = createBattleshipKit(10n);
    const botA = kit.createBot("A", { rngForSeat: () => Math.random });
    const botB = kit.createBot("B", { rngForSeat: () => Math.random });
    const result = driveToTerminal(kit, botA, botB, ctx);

    assert.ok(kit.protocol.isTerminal(result.finalState));
    const balances = kit.protocol.balances(result.finalState);
    assert.strictEqual(
      balances.a + balances.b,
      ctx.initialBalances.a + ctx.initialBalances.b,
    );
  });
});
```

- [ ] **Step 3: Run battleship tests**

Run: `cd frontend && node --import tsx --test src/agent/games/battleship/kit.test.ts`
Expected: 2 passing tests.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/agent/games/battleship/kit.ts frontend/src/agent/games/battleship/kit.test.ts
git commit -m "feat(agent): add battleship game kit"
```

---

## Task 6: Quantum poker kit

**Files:**

- Create: `frontend/src/agent/games/quantumPoker/kit.ts`
- Create: `frontend/src/agent/games/quantumPoker/kit.test.ts`

- [ ] **Step 1: Write `frontend/src/agent/games/quantumPoker/kit.ts`**

```ts
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import {
  QuantumPokerProtocol,
  type PokerState,
  type PokerMove,
} from "sui-tunnel-ts/protocol/quantumPoker";
import {
  QuantumPokerPersonaDriver,
  type QuantumPokerBotProfile,
} from "sui-tunnel-ts/protocol/quantumPokerPersona";
import {
  defaultStateHash,
  type BotContext,
  type GameBot,
  type GameKit,
} from "@/agent/gameKit";

export interface QuantumPokerBotConfig {
  profile?: QuantumPokerBotProfile;
}

class QuantumPokerBot implements GameBot<PokerState, PokerMove> {
  private readonly driver: QuantumPokerPersonaDriver;
  private readonly rng: () => number;

  constructor(seat: Party, ctx: BotContext, config: QuantumPokerBotConfig) {
    this.driver = new QuantumPokerPersonaDriver(
      seat,
      config.profile ?? "balanced",
    );
    this.rng = ctx.rngForSeat(seat);
  }

  plan(state: PokerState): PokerMove | null {
    return this.driver.chooseMove(state, this.rng);
  }

  confirm(): void {
    // Driver derives round memory from public state; no explicit advance needed.
  }

  abort(): void {
    // No retained memory beyond the driver instance.
  }
}

export function createQuantumPokerKit(
  stake: bigint,
  config: QuantumPokerBotConfig = {},
): GameKit<PokerState, PokerMove> {
  const protocol = new QuantumPokerProtocol(stake);

  return {
    id: "quantum-poker",
    protocol,
    stateHash: (state) => defaultStateHash(protocol, state),
    createBot: (seat: Party, ctx: BotContext) =>
      new QuantumPokerBot(seat, ctx, config),
    defaultStake: stake,
  };
}
```

- [ ] **Step 2: Write `frontend/src/agent/games/quantumPoker/kit.test.ts`**

```ts
import { describe, it } from "node:test";
import assert from "node:assert";
import { driveToTerminal } from "@/agent/testHarness";
import { createQuantumPokerKit } from "./kit";
import type { ProtocolContext } from "sui-tunnel-ts/protocol/Protocol";

describe("quantum poker kit", () => {
  const ctx: ProtocolContext = {
    tunnelId: "qp-1",
    initialBalances: { a: 10000n, b: 10000n },
  };

  it("uses the quantum poker protocol domain", () => {
    const kit = createQuantumPokerKit(100n);
    assert.strictEqual(kit.protocol.name, "quantum_poker.v2");
  });

  it("drives at least one hand to completion without rejected moves", () => {
    const kit = createQuantumPokerKit(100n);
    const botA = kit.createBot("A", { rngForSeat: () => Math.random });
    const botB = kit.createBot("B", { rngForSeat: () => Math.random });
    const result = driveToTerminal(kit, botA, botB, ctx);

    assert.ok(kit.protocol.isTerminal(result.finalState));
    const balances = kit.protocol.balances(result.finalState);
    assert.strictEqual(
      balances.a + balances.b,
      ctx.initialBalances.a + ctx.initialBalances.b,
    );
  });
});
```

- [ ] **Step 3: Run quantum poker tests**

Run: `cd frontend && node --import tsx --test src/agent/games/quantumPoker/kit.test.ts`
Expected: 2 passing tests.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/agent/games/quantumPoker/kit.ts frontend/src/agent/games/quantumPoker/kit.test.ts
git commit -m "feat(agent): add quantum poker game kit"
```

---

## Task 7: Populate the registry and add registry tests

**Files:**

- Modify: `frontend/src/agent/gameKit.ts`
- Modify: `frontend/src/agent/gameKit.test.ts`

- [ ] **Step 1: Update `frontend/src/agent/gameKit.ts` to import kits and export `GAME_KITS`**

Add to the top of `frontend/src/agent/gameKit.ts`:

```ts
import { createTicTacToeKit } from "./games/ticTacToe/kit";
import { createBlackjackKit } from "./games/blackjack/kit";
import { createBattleshipKit } from "./games/battleship/kit";
import { createQuantumPokerKit } from "./games/quantumPoker/kit";
```

Replace the placeholder registry with:

```ts
export const GAME_KITS: GameKitRegistry = {
  tictactoe: createTicTacToeKit(10, 10n),
  blackjack: createBlackjackKit(100n),
  battleship: createBattleshipKit(10n),
  "quantum-poker": createQuantumPokerKit(100n),
};
```

- [ ] **Step 2: Write `frontend/src/agent/gameKit.test.ts`**

```ts
import { describe, it } from "node:test";
import assert from "node:assert";
import { GAME_KITS } from "./gameKit";

describe("GAME_KITS registry", () => {
  it("contains all four game ids", () => {
    assert.ok(GAME_KITS.tictactoe);
    assert.ok(GAME_KITS.blackjack);
    assert.ok(GAME_KITS.battleship);
    assert.ok(GAME_KITS["quantum-poker"]);
  });

  it("exposes the human-hook protocol domains", () => {
    assert.strictEqual(
      GAME_KITS.tictactoe.protocol.name,
      "tic_tac_toe.multi.v1",
    );
    assert.strictEqual(GAME_KITS.blackjack.protocol.name, "blackjack.bet.v1");
    assert.strictEqual(GAME_KITS.battleship.protocol.name, "battleship.v1");
    assert.strictEqual(
      GAME_KITS["quantum-poker"].protocol.name,
      "quantum_poker.v2",
    );
  });

  it("imports cleanly under tsx", () => {
    // If this test file runs, the registry already loaded under tsx.
    assert.strictEqual(typeof GAME_KITS, "object");
  });
});
```

- [ ] **Step 3: Run registry tests**

Run: `cd frontend && node --import tsx --test src/agent/gameKit.test.ts`
Expected: 3 passing tests.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/agent/gameKit.ts frontend/src/agent/gameKit.test.ts
git commit -m "feat(agent): populate GAME_KITS registry"
```

---

## Task 8: Wire agent tests into the frontend test script

**Files:**

- Modify: `frontend/package.json`

- [ ] **Step 1: Update the `test` script**

Change:

```json
"test": "node --import tsx --test \"src/components/**/*.test.ts\" \"src/backend/**/*.test.ts\" \"src/games/blackjack/*.test.ts\" \"src/games/battleship/**/*.test.ts\""
```

to:

```json
"test": "node --import tsx --test \"src/components/**/*.test.ts\" \"src/backend/**/*.test.ts\" \"src/games/blackjack/*.test.ts\" \"src/games/battleship/**/*.test.ts\" \"src/agent/**/*.test.ts\""
```

- [ ] **Step 2: Run the full frontend test suite**

Run: `cd frontend && pnpm test`
Expected: all existing tests pass, plus the new agent tests pass.

- [ ] **Step 3: Commit**

```bash
git add frontend/package.json
git commit -m "build(agent): include agent tests in frontend test script"
```

---

## Task 9: Add import-hygiene boundary enforcement

**Files:**

- Create: `frontend/src/agent/.eslintrc-import-boundary.json` (or add a rule block to `.eslintrc` if one exists)

- [ ] **Step 1: Check existing eslint config**

Run: `ls frontend/.eslintrc* frontend/eslint.config.* 2>/dev/null || echo "none found"`

- [ ] **Step 2: If using flat config (`eslint.config.js`) add this boundary rule**

```js
{
  files: ["src/agent/**/*.ts"],
  rules: {
    "no-restricted-imports": ["error", {
      patterns: [
        { group: ["@/games/*/app/**", "@/games/*/components/**", "@/games/*/hooks/**"], message: "Agent kits must import only pure-TS game logic, not app/components/hooks." },
        { group: ["*.css", "*.svg", "*.png", "*.jpg"], message: "Agent kits cannot import assets." },
      ],
    }],
  },
}
```

- [ ] **Step 3: Run eslint on the agent directory**

Run: `cd frontend && pnpm exec eslint src/agent --ext .ts`
Expected: no import-boundary violations.

- [ ] **Step 4: Commit**

```bash
git add frontend/eslint.config.js
git commit -m "build(agent): enforce import-hygiene boundary for agent kits"
```

---

## Task 10: Final verification and typecheck

**Files:**

- All of the above

- [ ] **Step 1: Run frontend typecheck**

Run: `cd frontend && pnpm run typecheck`
Expected: no errors.

- [ ] **Step 2: Run frontend tests**

Run: `cd frontend && pnpm test`
Expected: all tests pass.

- [ ] **Step 3: Push the implementation branch**

Run: `git push origin feat/game-bot-kit`
Expected: branch pushed.

---

## Self-review checklist

### Spec coverage

| Spec requirement                           | Task(s)                                     |
| ------------------------------------------ | ------------------------------------------- |
| `GameKit` / `GameBot` / `BotContext` types | Task 1                                      |
| Per-seat RNG factory                       | Task 1 (`BotContext.rngForSeat`)            |
| `plan()` / `confirm()` / `abort()` split   | Task 1, all kit tasks                       |
| Tic-tac-toe adapter                        | Task 3                                      |
| Blackjack adapter                          | Task 4                                      |
| Battleship per-seat refactor               | Task 5                                      |
| Quantum poker adapter                      | Task 6                                      |
| `GAME_KITS` registry                       | Task 7                                      |
| Domain-tag parity tests                    | Tasks 3–7                                   |
| Move legality + balance conservation       | Tasks 3–6 kit tests                         |
| Full game to settlement                    | `driveToTerminal` in Tasks 3–6              |
| Import hygiene under tsx                   | Tasks 3–7 (tests run under tsx), Task 9     |
| Idempotency on replayed state              | Task 3 test, `lastActedHash` in harness     |
| Rejected-move safety                       | `driveToTerminal` does not confirm on error |
| Boundary rule against browser-only imports | Task 9                                      |

### Placeholder scan

- No "TBD", "TODO", "implement later", "fill in details".
- No vague "add error handling" or "write tests for the above".
- No "similar to Task N".
- Code blocks contain concrete code for every implementation step.

### Type consistency

- `GameKit<S, M>`, `GameBot<S, M>`, and `BotContext` are defined once in Task 1 and reused everywhere.
- `StateHash` is consistently `string`.
- `Party` is imported from `sui-tunnel-ts/protocol/Protocol` everywhere.
- `driveToTerminal` signature matches the `GameKit` / `GameBot` contract.

### Known risks to watch during execution

1. **`DistributedTunnel` constructor signature** — verify the exact import path and constructor args from `sui-tunnel-ts/core/distributed`. If it differs, update `testHarness.ts`.
2. **`pickCell` export** — `frontend/src/games/ticTacToe/app/hooks/useBotGame.ts` is a React hook file. If importing `pickCell` from it pulls in React/browser deps, extract `pickCell` and its helpers to a pure-TS file under `frontend/src/games/ticTacToe/lib/` first.
3. **Battleship targeting memory** — `pickShot` reads the public state each call, so `confirm` is a no-op. If the bot is later optimized to cache hunt state, the `confirm` contract becomes load-bearing.
4. **Quantum poker hand termination** — the harness uses `maxSteps = 10_000`. If a poker hand can loop (e.g., repeated `next_hand`), the harness may not terminate. Add a per-hand cap if observed.
5. **Eslint flat config** — the exact file name and API may differ. Adjust Step 9 to match the project's actual eslint setup.
