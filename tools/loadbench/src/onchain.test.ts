import { test, expect } from "bun:test";
import { makeSeats } from "./match";
import { openSpec } from "./onchain";

test("openSpec mirrors seat addresses and stakes into the funding spec", () => {
  const seats = makeSeats("t-9", { a: 5n, b: 7n }, 0n);
  const spec = openSpec(seats);
  expect(spec.partyA.address).toBe(seats.partyA.address);
  expect(spec.partyB.address).toBe(seats.partyB.address);
  expect(spec.aAmount).toBe(5n);
  expect(spec.bAmount).toBe(7n);
});
