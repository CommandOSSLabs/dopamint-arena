import { test, expect } from "bun:test";
import { pairLocalChannel } from "./channels/localChannel";
import { makeSeats, playMatch } from "./match";
import { kitFor, gameStake } from "./games";

test("a blackjack match plays to terminal over the local channel and settles", async () => {
  const stake = gameStake("blackjack");
  const seats = makeSeats("t-1", { a: stake, b: stake }, 1234n);
  const res = await playMatch(kitFor("blackjack"), seats, pairLocalChannel(), { seed: 7, maxMoves: 200 });
  expect(res.moves).toBeGreaterThan(0);
  expect(res.bytes).toBeGreaterThan(0);
  expect(res.latenciesMs.length).toBe(res.moves);
  const s = res.settlement.settlement;
  expect(s.partyABalance + s.partyBBalance).toBe(stake * 2n);
});
