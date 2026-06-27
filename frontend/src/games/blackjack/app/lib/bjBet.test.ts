import { test, expect } from "bun:test";
import { BET_OPTIONS, bjBetMove } from "./bjBet";
import {
  BlackjackProtocol,
  type BlackjackState,
} from "sui-tunnel-ts/protocol/blackjack";

const proto = new BlackjackProtocol();
const fresh = (): BlackjackState =>
  proto.initialState({
    tunnelId: "0x1",
    initialBalances: { a: 1000n, b: 1000n },
  });

test("offers the standard chip denominations", () => {
  expect(BET_OPTIONS).toEqual([25, 100, 500, 1000]);
});

test("builds a bet move clamped to [MIN_BET, maxBet]", () => {
  const s = fresh();
  expect(bjBetMove(100, s)).toEqual({ kind: "bet", amount: 100n });
  expect(bjBetMove(5, s)).toEqual({ kind: "bet", amount: 25n }); // below MIN_BET -> 25
});

test("caps the bet at the smaller balance", () => {
  const s = proto.initialState({
    tunnelId: "0x1",
    initialBalances: { a: 300n, b: 1000n },
  });
  expect(bjBetMove(1000, s)).toEqual({ kind: "bet", amount: 300n }); // capped at maxBet=300
});
