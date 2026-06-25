process.env.PACKAGE_ID = "0x" + "ab".repeat(32);

import { Transaction } from "@mysten/sui/transactions";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDepositMany } from "./createAndFund";

const USDC = "0x" + "cc".repeat(32) + "::usdc::USDC";

/** Distinct, valid 32-byte object ids for the N tunnels under test. */
function tunnelId(i: number): string {
  return "0x" + (i + 1).toString(16).padStart(64, "0");
}

test("buildDepositMany makes one SplitCoins and N entry_deposit calls", () => {
  const n = 4;
  const specs = Array.from({ length: n }, (_, i) => ({
    tunnelId: tunnelId(i),
    amount: BigInt(500 * (i + 1)),
  }));
  const tx = new Transaction();
  buildDepositMany(tx, specs);
  const cmds = tx.getData().commands as Array<{
    $kind: string;
    MoveCall?: { function: string };
  }>;

  // One split feeds every stake; one entry_deposit per tunnel — the "N deposits, 1 PTB" shape
  // that funds the whole batch under a single signature.
  const splits = cmds.filter((c) => c.$kind === "SplitCoins");
  const deposits = cmds.filter(
    (c) => c.$kind === "MoveCall" && c.MoveCall?.function === "entry_deposit"
  );
  assert.equal(splits.length, 1);
  assert.equal(deposits.length, n);
});

test("buildDepositMany targets every requested tunnel (no silent drop)", () => {
  // Intent: each stake must reach its matched tunnel — a dropped/duplicated id funds the wrong game.
  const ids = [
    "0x" + "11".repeat(32),
    "0x" + "22".repeat(32),
    "0x" + "33".repeat(32),
  ];
  const tx = new Transaction();
  buildDepositMany(
    tx,
    ids.map((id) => ({ tunnelId: id, amount: 500n }))
  );
  const json = JSON.stringify(tx.getData());
  for (const id of ids) {
    assert.ok(json.includes(id.slice(2)), `tunnel ${id} should be a tx input`);
  }
});

test("buildDepositMany funds a non-SUI batch from a caller-supplied source coin", () => {
  const n = 3;
  const specs = Array.from({ length: n }, (_, i) => ({
    tunnelId: tunnelId(i),
    amount: BigInt(500 * (i + 1)),
  }));
  const tx = new Transaction();
  const sourceCoin = tx.object("0x" + "dd".repeat(32));
  buildDepositMany(tx, specs, { coinType: USDC, sourceCoin });
  const cmds = tx.getData().commands as Array<{
    $kind: string;
    MoveCall?: { function: string; typeArguments?: string[] };
  }>;

  const splits = cmds.filter((c) => c.$kind === "SplitCoins");
  const deposits = cmds.filter(
    (c) => c.$kind === "MoveCall" && c.MoveCall?.function === "entry_deposit"
  );
  assert.equal(splits.length, 1);
  assert.equal(deposits.length, n);
  for (const d of deposits) {
    assert.deepEqual(d.MoveCall?.typeArguments, [USDC]);
  }
});

test("buildDepositMany rejects a non-SUI coinType with no sourceCoin (no gas-split footgun)", () => {
  const tx = new Transaction();
  assert.throws(
    () =>
      buildDepositMany(tx, [{ tunnelId: tunnelId(0), amount: 500n }], {
        coinType: USDC,
      }),
    /sourceCoin/
  );
});
