import { describe, it } from "node:test";
import assert from "node:assert";
import {
  type PaymentsState,
  type PaymentMove,
} from "sui-tunnel-ts/protocol/payments";
import { createRegularPaymentsKit, isCatalogPaymentMove } from "./kit";
import type { ProtocolContext } from "sui-tunnel-ts/protocol/Protocol";
import { PRODUCTS } from "@/games/regularPayments/utils/catalog";
import { DEPOSIT_BUDGET } from "@/games/regularPayments/utils/constants";

function mulberry32(seed: number): () => number {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("regularPayments kit", () => {
  const ctx: ProtocolContext = {
    tunnelId: "rp-1",
    initialBalances: { a: DEPOSIT_BUDGET, b: 1n },
  };

  it("uses the payments.v1 protocol domain and correct id", () => {
    const kit = createRegularPaymentsKit();
    assert.strictEqual(kit.id, "regular-payments");
    assert.strictEqual(kit.protocol.name, "payments.v1");
    assert.strictEqual(kit.defaultStake, DEPOSIT_BUDGET);
  });

  it("shopper bot (A) proposes a catalog-priced purchase when it has budget", () => {
    const kit = createRegularPaymentsKit();
    const state = kit.protocol.initialState(ctx);
    const botA = kit.createBot("A", { rngForSeat: () => mulberry32(1) });
    const botB = kit.createBot("B", { rngForSeat: () => mulberry32(2) });

    const moveA = botA.plan(state);
    const moveB = botB.plan(state);

    assert.ok(moveA);
    assert.strictEqual(moveA.from, "A");
    assert.ok(
      PRODUCTS.some((p) => p.priceMtps === moveA.amount),
      "amount must match a catalog price",
    );
    assert.strictEqual(moveB, null);
  });

  it("shop bot (B) never initiates purchases", () => {
    const kit = createRegularPaymentsKit();
    const state = kit.protocol.initialState(ctx);
    const botB = kit.createBot("B", { rngForSeat: () => mulberry32(7) });
    assert.strictEqual(botB.plan(state), null);
  });

  it("drives multiple catalog picks with conserved balances", () => {
    const kit = createRegularPaymentsKit();
    const botA = kit.createBot("A", { rngForSeat: () => mulberry32(1) });
    const botB = kit.createBot("B", { rngForSeat: () => mulberry32(2) });

    let state: PaymentsState = kit.protocol.initialState(ctx);
    const steps = 7;

    for (let i = 0; i < steps; i++) {
      const move = botA.plan(state);
      assert.ok(move, `expected shopper move at step ${i}`);
      assert.strictEqual(move.from, "A");
      assert.ok(isCatalogPaymentMove(state, move));
      assert.strictEqual(botB.plan(state), null);

      const next = kit.protocol.applyMove(state, move, "A");
      botA.confirm(state, move);

      const bals = kit.protocol.balances(next);
      assert.strictEqual(
        bals.a + bals.b,
        ctx.initialBalances.a + ctx.initialBalances.b,
      );

      state = next;
    }

    assert.strictEqual(state.count, BigInt(steps));
  });

  it("plan is deterministic for the same rng seed and state", () => {
    const kit = createRegularPaymentsKit();
    const state = kit.protocol.initialState(ctx);
    const mkBot = () =>
      kit.createBot("A", { rngForSeat: () => mulberry32(42) });

    assert.deepStrictEqual(mkBot().plan(state), mkBot().plan(state));
  });

  it("stops proposing when shopper cannot afford any catalog item", () => {
    const kit = createRegularPaymentsKit();
    const lowState: PaymentsState = {
      balanceA: 0n,
      balanceB: DEPOSIT_BUDGET,
      total: DEPOSIT_BUDGET,
      count: 0n,
    };

    const botA = kit.createBot("A", { rngForSeat: () => mulberry32(1) });
    assert.strictEqual(botA.plan(lowState), null);
  });

  it("isCatalogPaymentMove rejects non-catalog amounts", () => {
    const state: PaymentsState = {
      balanceA: DEPOSIT_BUDGET,
      balanceB: 1n,
      total: DEPOSIT_BUDGET + 1n,
      count: 0n,
    };
    const bad: PaymentMove = { from: "A", amount: 999n };
    assert.strictEqual(isCatalogPaymentMove(state, bad), false);
  });
});
