import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AllowanceStatus,
  allowanceStatusName,
  computeAvailable,
  computeEntitled,
  type AccrualState,
} from "./agentAllowance.ts";

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
