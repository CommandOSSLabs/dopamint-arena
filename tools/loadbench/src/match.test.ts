import { test, expect } from "bun:test";
import { pairLocalChannel } from "./channels/localChannel";
import { makeSeats, playMatch } from "./match";
import { PaymentsProtocol } from "../../../sui-tunnel-ts/src/protocol/payments";

test("a payments match plays to terminal over the local channel and settles", async () => {
  const seats = makeSeats("t-1", { a: 1000n, b: 1000n }, 1234n);
  const res = await playMatch(new PaymentsProtocol() as any, seats, pairLocalChannel(), { seed: 7, maxMoves: 200 });
  expect(res.moves).toBeGreaterThan(0);
  expect(res.bytes).toBeGreaterThan(0);
  expect(res.latenciesMs.length).toBe(res.moves);
  // The settlement balances still sum to the locked total.
  const s = res.settlement.settlement;
  expect(s.partyABalance + s.partyBBalance).toBe(2000n);
});
