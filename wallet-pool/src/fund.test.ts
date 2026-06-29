import { test } from "node:test";
import assert from "node:assert/strict";
import { Transaction } from "@mysten/sui/transactions";
import { resolveTargets, buildSuiFundTransaction } from "./fund";
import type { PoolBlob, WalletEntry } from "./types";

function index(): WalletEntry[] {
  return [
    { role: "master", address: "0xM", ordinal: 0, createdAt: 0, enabled: true, useCount: 0, lastUsedAt: 0 },
    { role: "member", address: "0xA", ordinal: 1, createdAt: 0, enabled: true, useCount: 0, lastUsedAt: 0 },
    { role: "member", address: "0xB", ordinal: 2, createdAt: 0, enabled: true, useCount: 0, lastUsedAt: 0 },
    { role: "member", address: "0xC", ordinal: 3, createdAt: 0, enabled: false, useCount: 0, lastUsedAt: 0 },
  ];
}
const blob = { version: 1, walletPoolId: "wp_x", network: "testnet", createdAt: 0, coinTypes: [], index: index() } as unknown as PoolBlob;

test("resolveTargets all selects enabled members only", () => {
  const t = resolveTargets(blob, "all", 100n);
  assert.deepEqual(t.map((x) => x.address), ["0xA", "0xB"]);
  assert.ok(t.every((x) => x.amount === 100n));
});

test("resolveTargets subset filters by address", () => {
  const t = resolveTargets(blob, ["0xB", "0xC"], 50n);
  assert.deepEqual(t.map((x) => x.address), ["0xB"]); // 0xC disabled -> excluded
});

test("buildSuiFundTransaction is constructable", () => {
  const tx = buildSuiFundTransaction([{ address: "0xA", amount: 1n }]);
  assert.ok(tx instanceof Transaction);
});
