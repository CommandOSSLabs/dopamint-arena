import { test, expect } from "bun:test";
import { isRetriableTxError, withTxRetry } from "./probeRetry";

test("classifies the real stale-gas rejection as retriable", () => {
  const real =
    "Transaction needs to be rebuilt because object 0x04a0 version 0x807 " +
    "is unavailable for consumption, current version: 0x830";
  expect(isRetriableTxError(new Error(real))).toBe(true);
  expect(isRetriableTxError(real)).toBe(true);
});

test("does not retry Move aborts or gas-budget failures", () => {
  expect(isRetriableTxError(new Error("MoveAbort in 0x..::tunnel: 7"))).toBe(false);
  expect(isRetriableTxError(new Error("Insufficient gas: budget 1000 below ..."))).toBe(false);
  expect(isRetriableTxError(new Error("CommandArgumentError"))).toBe(false);
});

test("withTxRetry rebuilds and succeeds after a transient version conflict", async () => {
  let calls = 0;
  const out = await withTxRetry(
    async () => {
      calls++;
      if (calls < 3) throw new Error("object is unavailable for consumption");
      return "ok";
    },
    5,
    1,
  );
  expect(out).toBe("ok");
  expect(calls).toBe(3);
});

test("withTxRetry surfaces a non-retriable error immediately (no retries)", async () => {
  let calls = 0;
  await expect(
    withTxRetry(
      async () => {
        calls++;
        throw new Error("MoveAbort: 5");
      },
      5,
      1,
    ),
  ).rejects.toThrow("MoveAbort");
  expect(calls).toBe(1);
});

test("withTxRetry gives up after the attempt budget and rethrows the last error", async () => {
  let calls = 0;
  await expect(
    withTxRetry(
      async () => {
        calls++;
        throw new Error("needs to be rebuilt");
      },
      3,
      1,
    ),
  ).rejects.toThrow("needs to be rebuilt");
  expect(calls).toBe(3);
});
