// Parity tests for mapSnapshotToView: pure function, no React.
//
// Asserts that every field of PvpTttView is derived correctly from a fixed
// SessionSnapshot<MultiGameTicTacToeState> + extras, covering the key branches:
//   - null state (pre-playing phases)
//   - active board with winner=0 (mid-game, my turn vs not my turn)
//   - inner game finished (winner set, innerOver=true)
//   - terminal session
//   - "opponent-abandoned" phase collapsed to "error"
//   - close digest forwarded from snapshot.digest
import { describe, it } from "node:test";
import assert from "node:assert";
import type { SessionSnapshot } from "@/agent/session/pvpGameSession";
import type { MultiGameTicTacToeState } from "@ttt/shared/ttt/multiGameProtocol";
import {
  mapSnapshotToView,
  type SnapshotExtras,
} from "@/games/ticTacToe/agent/mapSnapshotToView";
import type { PvpTttView } from "./usePvpTicTacToe";

// ── helpers ──────────────────────────────────────────────────────────────────

const NOOP = () => {};
const NOOP_CELL = (_cell: number) => {};
const NOOP_AUTO = (_on: boolean) => {};

function baseExtras(overrides?: Partial<SnapshotExtras>): SnapshotExtras {
  return {
    address: "0xALICE",
    balance: 42_000n,
    role: "A",
    score: { x: 0, o: 0, draws: 0 },
    games: [],
    digests: {},
    auto: false,
    variant: "ttt",
    boardSize: 3,
    queue: NOOP,
    play: NOOP_CELL,
    next: NOOP,
    stop: NOOP,
    setAuto: NOOP_AUTO,
    leave: NOOP,
    requeue: NOOP,
    ...overrides,
  };
}

function idleSnapshot(): Readonly<SessionSnapshot<MultiGameTicTacToeState>> {
  return {
    phase: "idle",
    state: null,
    balances: null,
    terminal: false,
    error: null,
  };
}

function playingSnapshot(
  boardOverride?: Partial<{
    board: number[];
    turn: "A" | "B";
    winner: number;
  }>,
  gamesPlayed = 0,
): Readonly<SessionSnapshot<MultiGameTicTacToeState>> {
  const board = boardOverride?.board ?? Array(9).fill(0);
  const turn = boardOverride?.turn ?? "A";
  const winner = boardOverride?.winner ?? 0;
  const state: MultiGameTicTacToeState = {
    inner: {
      board,
      turn,
      movesCount: board.filter((c) => c !== 0).length,
      winner: winner as 0 | 1 | 2 | 3,
      balanceA: 500n,
      balanceB: 500n,
      total: 1000n,
      stake: 1n,
    },
    gamesPlayed,
    maxGames: 10,
  };
  return {
    phase: "playing",
    state,
    balances: { a: 500n, b: 500n },
    terminal: false,
    error: null,
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("mapSnapshotToView", () => {
  it("pre-playing (null state): board/turn/winner/inner fields are empty/null/0", () => {
    const view = mapSnapshotToView(idleSnapshot(), baseExtras());
    assert.strictEqual(view.phase, "idle");
    assert.strictEqual(view.error, null);
    assert.strictEqual(view.role, "A");
    assert.deepStrictEqual(view.board, []);
    assert.strictEqual(view.turn, null);
    assert.strictEqual(view.winner, 0);
    assert.strictEqual(view.myMark, 1, "role A => myMark 1");
    assert.strictEqual(view.isMyTurn, false);
    assert.strictEqual(view.innerOver, false);
    assert.strictEqual(view.terminal, false);
    assert.strictEqual(view.currentGame, 0);
    assert.strictEqual(view.address, "0xALICE");
    assert.strictEqual(view.balance, 42_000n);
    assert.deepStrictEqual(view.score, { x: 0, o: 0, draws: 0 });
    assert.deepStrictEqual(view.games, []);
    assert.deepStrictEqual(view.digests, {});
    assert.strictEqual(view.auto, false);
    assert.strictEqual(view.variant, "ttt");
    assert.strictEqual(view.size, 3);
    assert.strictEqual(view.lastMove, -1);
    // Methods are passed through
    assert.strictEqual(view.queue, NOOP);
    assert.strictEqual(view.leave, NOOP);
  });

  it("playing mid-game, my turn (role A, turn A, winner 0) => isMyTurn true", () => {
    const snap = playingSnapshot({ turn: "A", winner: 0 });
    const view = mapSnapshotToView(snap, baseExtras({ role: "A" }));
    assert.strictEqual(view.phase, "playing");
    assert.strictEqual(view.isMyTurn, true);
    assert.strictEqual(view.turn, "A");
    assert.strictEqual(view.winner, 0);
    assert.strictEqual(view.innerOver, false);
    assert.strictEqual(view.myMark, 1);
    assert.strictEqual(view.currentGame, 1); // gamesPlayed=0 => currentGame=1
  });

  it("playing mid-game, opponent turn (role A, turn B) => isMyTurn false", () => {
    const snap = playingSnapshot({ turn: "B", winner: 0 });
    const view = mapSnapshotToView(snap, baseExtras({ role: "A" }));
    assert.strictEqual(view.isMyTurn, false);
    assert.strictEqual(view.turn, "B");
  });

  it("role B => myMark 2", () => {
    const snap = playingSnapshot({ turn: "B", winner: 0 });
    const view = mapSnapshotToView(snap, baseExtras({ role: "B" }));
    assert.strictEqual(view.myMark, 2);
    assert.strictEqual(view.isMyTurn, true);
  });

  it("role null (pre-match) => myMark 0, isMyTurn false", () => {
    const view = mapSnapshotToView(idleSnapshot(), baseExtras({ role: null }));
    assert.strictEqual(view.myMark, 0);
    assert.strictEqual(view.isMyTurn, false);
    assert.strictEqual(view.role, null);
  });

  it("inner game finished (winner set) => innerOver true, isMyTurn false", () => {
    // winner=1 means A won the current inner game
    const snap = playingSnapshot({ turn: "A", winner: 1 });
    const view = mapSnapshotToView(snap, baseExtras({ role: "A" }));
    assert.strictEqual(view.winner, 1);
    assert.strictEqual(view.innerOver, true);
    // isMyTurn false even though it's nominally A's turn — winner is set
    assert.strictEqual(view.isMyTurn, false);
  });

  it("terminal session => terminal true", () => {
    const state: MultiGameTicTacToeState = {
      inner: {
        board: [1, 1, 1, 2, 2, 0, 0, 0, 0],
        turn: "A",
        movesCount: 5,
        winner: 1,
        balanceA: 1000n,
        balanceB: 0n,
        total: 1000n,
        stake: 1n,
      },
      gamesPlayed: 9,
      maxGames: 10,
    };
    const snap: Readonly<SessionSnapshot<MultiGameTicTacToeState>> = {
      phase: "settling",
      state,
      balances: { a: 1000n, b: 0n },
      terminal: true,
      error: null,
    };
    const view = mapSnapshotToView(snap, baseExtras());
    assert.strictEqual(view.terminal, true);
    assert.strictEqual(view.phase, "settling");
    assert.strictEqual(view.currentGame, 10); // gamesPlayed=9 => 10
  });

  it("'opponent-abandoned' phase collapses to 'error'", () => {
    const snap: Readonly<SessionSnapshot<MultiGameTicTacToeState>> = {
      phase: "opponent-abandoned",
      state: null,
      balances: null,
      terminal: false,
      error: null,
    };
    const view = mapSnapshotToView(snap, baseExtras());
    assert.strictEqual(view.phase, "error");
  });

  it("error in snapshot => view.error set", () => {
    const snap: Readonly<SessionSnapshot<MultiGameTicTacToeState>> = {
      phase: "error",
      state: null,
      balances: null,
      terminal: false,
      error: "relay disconnected",
    };
    const view = mapSnapshotToView(snap, baseExtras());
    assert.strictEqual(view.error, "relay disconnected");
    assert.strictEqual(view.phase, "error");
  });

  it("close digest from snapshot.digest is forwarded to digests.close", () => {
    const snap: Readonly<SessionSnapshot<MultiGameTicTacToeState>> = {
      phase: "done",
      state: null,
      balances: { a: 600n, b: 400n },
      terminal: true,
      error: null,
      digest: "0xDEADBEEF",
    };
    const extrasWithPriorDigests = baseExtras({
      digests: { create: "0xCREATE", deposit: "0xDEPOSIT" },
    });
    const view = mapSnapshotToView(snap, extrasWithPriorDigests);
    assert.strictEqual(view.digests.close, "0xDEADBEEF");
    assert.strictEqual(view.digests.create, "0xCREATE");
    assert.strictEqual(view.digests.deposit, "0xDEPOSIT");
    assert.strictEqual(view.phase, "done");
    assert.strictEqual(view.terminal, true);
  });

  it("create/deposit digests from extras are preserved even without close", () => {
    const snap = playingSnapshot();
    const view = mapSnapshotToView(
      snap,
      baseExtras({ digests: { create: "0xC1", deposit: "0xD1" } }),
    );
    assert.strictEqual(view.digests.create, "0xC1");
    assert.strictEqual(view.digests.deposit, "0xD1");
    assert.strictEqual(view.digests.close, undefined);
  });

  it("score and games accumulation from extras are threaded through", () => {
    const snap = playingSnapshot();
    const games = [{ game: 1, winner: 1 as const }];
    const score = { x: 1, o: 0, draws: 0 };
    const view = mapSnapshotToView(snap, baseExtras({ score, games }));
    assert.deepStrictEqual(view.score, { x: 1, o: 0, draws: 0 });
    assert.strictEqual(view.games.length, 1);
    assert.strictEqual(view.games[0]!.game, 1);
  });

  it("auto flag is reflected from extras", () => {
    const view = mapSnapshotToView(idleSnapshot(), baseExtras({ auto: true }));
    assert.strictEqual(view.auto, true);
  });

  it("caro variant with boardSize 15 => size=15 when inner state is null", () => {
    const view = mapSnapshotToView(
      idleSnapshot(),
      baseExtras({ variant: "caro", boardSize: 15 }),
    );
    assert.strictEqual(view.variant, "caro");
    assert.strictEqual(view.size, 15);
  });

  it("currentGame reflects gamesPlayed+1", () => {
    const snap = playingSnapshot(undefined, 5);
    const view = mapSnapshotToView(snap, baseExtras());
    assert.strictEqual(view.currentGame, 6);
  });

  it("all six imperative methods are passed through unchanged", () => {
    const queue = () => {};
    const play = (_c: number) => {};
    const next = () => {};
    const stop = () => {};
    const setAuto = (_on: boolean) => {};
    const leave = () => {};
    const view = mapSnapshotToView(
      idleSnapshot(),
      baseExtras({ queue, play, next, stop, setAuto, leave }),
    );
    assert.strictEqual(view.queue, queue);
    assert.strictEqual(view.play, play);
    assert.strictEqual(view.next, next);
    assert.strictEqual(view.stop, stop);
    assert.strictEqual(view.setAuto, setAuto);
    assert.strictEqual(view.leave, leave);
  });
});
