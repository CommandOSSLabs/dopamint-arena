import { test } from "node:test";
import assert from "node:assert/strict";

process.env.VITE_AGENT_ALLOWANCE_PACKAGE_ID = "0xpkg";
process.env.VITE_MTPS_COIN_TYPE = "0xabc::mtps::MTPS";

import {
  AllowanceStatus,
  allowanceStatusName,
  buildCreateAllowanceTx,
  computeAvailable,
  computeEntitled,
  fetchAllowanceAfterMutation,
  type AccrualState,
  type AllowanceFields,
  type AllowanceReader,
} from "./agentAllowance.ts";

const COIN = "0xabc::mtps::MTPS";

// A 1000-unit/sec rate, cap 1_000_000, anchored at t=0, no voucher, open-ended.
const rateOnly = (over: Partial<AccrualState> = {}): AccrualState => ({
  ratePerSecond: 1000n,
  vestedFloor: 0n,
  anchorMs: 0n,
  authorizedTotal: 0n,
  spendCap: 1_000_000n,
  expiryMs: 0n,
  status: AllowanceStatus.ACTIVE,
  ...over,
});

test("rate entitlement accrues per elapsed second from the anchor", () => {
  const s = rateOnly();
  assert.equal(computeEntitled(s, 0n), 0n);
  assert.equal(computeEntitled(s, 10_000n), 10_000n); // 10s * 1000
  assert.equal(computeEntitled(s, 500_000n), 500_000n); // 500s * 1000
});

test("entitlement never exceeds the spend cap", () => {
  const s = rateOnly();
  // 2000s * 1000 = 2_000_000, clamped to the 1_000_000 cap.
  assert.equal(computeEntitled(s, 2_000_000n), 1_000_000n);
});

test("a signed voucher raises entitlement above the rate accrual", () => {
  // At t=10s rate alone vests 10_000; a 500_000 voucher dominates via max().
  const s = rateOnly({ authorizedTotal: 500_000n });
  assert.equal(computeEntitled(s, 10_000n), 500_000n);
});

test("expiry freezes accrual at the deadline", () => {
  const s = rateOnly({ expiryMs: 20_000n });
  // Past expiry, only the 20s up to the deadline count: 20 * 1000.
  assert.equal(computeEntitled(s, 60_000n), 20_000n);
});

test("a paused allowance falls back to its vested floor, capped", () => {
  const s = rateOnly({ status: AllowanceStatus.PAUSED, vestedFloor: 12_345n });
  // No fresh accrual while paused; entitlement is the locked floor.
  assert.equal(computeEntitled(s, 999_000n), 12_345n);
});

test("available is entitled minus spent, bounded by escrow", () => {
  const s = rateOnly();
  // Entitled at 100s = 100_000; spent 30_000 -> 70_000 owed, but escrow caps it.
  assert.equal(computeAvailable(s, 30_000n, 1_000_000n, 100_000n), 70_000n);
  assert.equal(computeAvailable(s, 30_000n, 50_000n, 100_000n), 50_000n);
});

test("a non-active allowance is never claimable", () => {
  const s = rateOnly({ status: AllowanceStatus.REVOKED, vestedFloor: 99n });
  assert.equal(computeAvailable(s, 0n, 1_000_000n, 100_000n), 0n);
});

test("status names map to their codes", () => {
  assert.equal(allowanceStatusName(AllowanceStatus.ACTIVE), "Active");
  assert.equal(allowanceStatusName(AllowanceStatus.PAUSED), "Paused");
  assert.equal(allowanceStatusName(AllowanceStatus.REVOKED), "Revoked");
});

test("fetchAllowanceAfterMutation polls until the predicate passes", async () => {
  const base: AllowanceFields = {
    id: "0xallowance",
    principal: "0xa",
    payee: "0xb",
    delegate: null,
    ratePerSecond: 1n,
    spendCap: 100n,
    spent: 0n,
    vestedFloor: 0n,
    anchorMs: 0n,
    authorizedTotal: 0n,
    expiryMs: 0n,
    status: AllowanceStatus.PAUSED,
    createdAt: 0n,
    escrowBalance: 100n,
  };

  let reads = 0;
  const client: AllowanceReader = {
    getObject: async () => {
      reads += 1;
      const status =
        reads >= 3 ? AllowanceStatus.ACTIVE : AllowanceStatus.PAUSED;
      return {
        data: {
          content: {
            dataType: "moveObject",
            fields: {
              principal: base.principal,
              payee: base.payee,
              delegate: null,
              rate_per_second: "1",
              spend_cap: "100",
              spent: "0",
              vested_floor: "0",
              anchor_ms: "0",
              authorized_total: "0",
              expiry_ms: "0",
              status,
              created_at: "0",
              escrow: "100",
            },
          },
        },
      };
    },
    getTransactionBlock: async () => ({ objectChanges: [] }),
  };

  const fresh = await fetchAllowanceAfterMutation(
    client,
    base.id,
    (f) => f.status === AllowanceStatus.ACTIVE,
    { attempts: 5, delayMs: 0 },
  );

  assert.equal(reads, 3);
  assert.equal(fresh?.status, AllowanceStatus.ACTIVE);
});

test("create allowance stakes from sender address balance (ADR-0013)", () => {
  const tx = buildCreateAllowanceTx({
    stakeFromBalance: { amount: 100n, coinType: COIN },
    fundAmount: 100n,
    payee: "0xb",
    ratePerSecond: 1n,
    spendCap: 100n,
  });
  const data = tx.getData();

  const withdrawal = data.inputs.find((i) => i.$kind === "FundsWithdrawal");
  assert.ok(withdrawal, "the PTB carries a FundsWithdrawal input");
  assert.equal(
    (withdrawal as { FundsWithdrawal: { withdrawFrom: { $kind: string } } })
      .FundsWithdrawal.withdrawFrom.$kind,
    "Sender",
  );

  const hasRedeem = data.commands.some(
    (c) => c.$kind === "MoveCall" && c.MoveCall.function === "redeem_funds",
  );
  assert.ok(hasRedeem, "escrow coin comes from coin::redeem_funds");

  const hasCreate = data.commands.some(
    (c) =>
      c.$kind === "MoveCall" &&
      c.MoveCall.function === "entry_create_and_share",
  );
  assert.ok(hasCreate, "the PTB calls entry_create_and_share");
});
