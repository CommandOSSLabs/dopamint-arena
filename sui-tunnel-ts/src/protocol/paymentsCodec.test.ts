import { test } from "node:test";
import assert from "node:assert/strict";
import { paymentsMoveCodec, type PaymentMoveJson } from "./paymentsCodec";
import type { PaymentMove } from "./payments";

function rt(m: PaymentMove): PaymentMove {
  return paymentsMoveCodec.decode(
    JSON.parse(JSON.stringify(paymentsMoveCodec.encode(m))),
  );
}

test("payments move round-trips amount as bigint over JSON", () => {
  const out = rt({ from: "A", amount: 2n });
  assert.deepEqual(out, { from: "A", amount: 2n });
});

test("payments move encode is JSON-safe", () => {
  const json = paymentsMoveCodec.encode({
    from: "B",
    amount: 1_000n,
  }) as PaymentMoveJson;
  assert.doesNotThrow(() => JSON.stringify(json));
  assert.equal(json.amount, "1000");
});