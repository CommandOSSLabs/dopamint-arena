import { test } from "node:test";
import assert from "node:assert/strict";
import { BalanceService, type BalanceClient } from "./rpc";

function fakeClient(bal: (owner: string) => string): BalanceClient {
  return { getBalance: async ({ owner }) => ({ balance: bal(owner) }) };
}

test("getBalance caches (one RPC per address)", async () => {
  let calls = 0;
  const svc = new BalanceService(fakeClient(() => { calls++; return "1000"; }), 4, 60_000);
  assert.equal(await svc.getBalance("0x1"), 1000n);
  assert.equal(await svc.getBalance("0x1"), 1000n);
  assert.equal(calls, 1);
});

test("getBalances fetches all in parallel", async () => {
  const svc = new BalanceService(fakeClient((o) => String(Number(o.slice(2)) * 10)), 3, 60_000);
  const m = await svc.getBalances(["0x1", "0x2", "0x3", "0x4"], "0x2::sui::SUI");
  assert.equal(m.get("0x1"), 10n);
  assert.equal(m.get("0x4"), 40n);
  assert.equal(m.size, 4);
});
