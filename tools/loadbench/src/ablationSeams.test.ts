import { test, expect } from "bun:test";
import { bigintSafeCodec, proposeAndAwait } from "./match";

test("bigintSafeCodec round-trips bigint and bytes", () => {
  const move = { n: 7n, b: new Uint8Array([1, 2, 3]) };
  const decoded = bigintSafeCodec.decode(bigintSafeCodec.encode(move)) as {
    n: bigint;
    b: Uint8Array;
  };
  expect(decoded.n).toBe(7n);
  expect(Array.from(decoded.b)).toEqual([1, 2, 3]);
});

test("proposeAndAwait resolves with elapsed ms on synchronous confirm", async () => {
  // Minimal structural stub: proposeAndAwait only touches onConfirmed + propose.
  const stub = {
    onConfirmed: undefined as ((u: unknown) => void) | undefined,
    propose(_m: unknown, _ts: bigint) {
      this.onConfirmed?.(undefined);
    },
  };
  const ms = await proposeAndAwait(stub as never, { kind: "noop" }, 1n);
  expect(typeof ms).toBe("number");
  expect(ms).toBeGreaterThanOrEqual(0);
});
