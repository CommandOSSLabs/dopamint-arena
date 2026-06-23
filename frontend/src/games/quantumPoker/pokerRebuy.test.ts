import { test } from "node:test";
import assert from "node:assert/strict";
import type { PokerState } from "sui-tunnel-ts/protocol/quantumPoker";
import {
  POKER_ANTE,
  isRebuyableBust,
  carryOverBalances,
  runRebuyRound,
} from "./pokerRebuy";
import { POKER_BUYIN } from "./constants";

/** Build a PokerState with only the fields the re-buy helpers read; the rest are irrelevant here. */
function state(over: Partial<PokerState>): PokerState {
  return {
    phase: "commit",
    handNo: 1n,
    handCap: 50n,
    balanceA: POKER_BUYIN,
    balanceB: POKER_BUYIN,
    ...over,
  } as unknown as PokerState;
}

test("isRebuyableBust: true when done before cap and a seat is below the ante", () => {
  const s = state({ phase: "done", handNo: 7n, balanceA: POKER_ANTE - 1n, balanceB: 4999n });
  assert.equal(isRebuyableBust(s), true);
});

test("isRebuyableBust: false at the hand cap even if a seat is short", () => {
  const s = state({ phase: "done", handNo: 50n, balanceA: 0n, balanceB: 5000n });
  assert.equal(isRebuyableBust(s), false);
});

test("isRebuyableBust: false while a hand is still in progress", () => {
  const s = state({ phase: "river_bet", handNo: 3n, balanceA: 0n, balanceB: 5000n });
  assert.equal(isRebuyableBust(s), false);
});

test("isRebuyableBust: false when both seats can still cover the ante", () => {
  const s = state({ phase: "done", handNo: 7n, balanceA: 1000n, balanceB: 4000n });
  assert.equal(isRebuyableBust(s), false);
});

test("carryOverBalances: busted seat gains exactly one buy-in, winner carries its stack", () => {
  const s = state({ phase: "done", handNo: 7n, balanceA: 10n, balanceB: 4990n });
  assert.deepEqual(carryOverBalances(s), { a: 10n + POKER_BUYIN, b: 4990n });
});

test("carryOverBalances: the new balances stay funded for the next round", () => {
  const s = state({ phase: "done", handNo: 7n, balanceA: 10n, balanceB: 4990n });
  const next = carryOverBalances(s);
  assert.ok(next.a >= POKER_ANTE && next.b >= POKER_ANTE);
});

test("runRebuyRound: settles first, then starts a round with the carried-over balances", async () => {
  const order: string[] = [];
  let started: { a: bigint; b: bigint } | null = null;
  const s = state({ phase: "done", handNo: 7n, balanceA: 10n, balanceB: 4990n });
  await runRebuyRound(s, {
    settle: async () => {
      order.push("settle");
    },
    startRound: async (b) => {
      order.push("startRound");
      started = b;
    },
  });
  assert.deepEqual(order, ["settle", "startRound"]);
  assert.deepEqual(started, { a: 10n + POKER_BUYIN, b: 4990n });
});
