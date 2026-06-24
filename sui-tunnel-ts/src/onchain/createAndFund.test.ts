process.env.PACKAGE_ID = "0x" + "ab".repeat(32);

import { Transaction } from "@mysten/sui/transactions";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCreateAndFund,
  buildOpenAndFundMany,
  buildOpenAndFundOneReturnless,
} from "./createAndFund";
import { buildEmitQuantumPokerRandomnessSeed } from "./txbuilders";

const PARTY_A = {
  address: "0x1",
  publicKey: new Uint8Array(32),
  signatureType: 0,
};
const PARTY_B = {
  address: "0x2",
  publicKey: new Uint8Array(32),
  signatureType: 0,
};

function txJson(build: (tx: Transaction) => void): string {
  const tx = new Transaction();
  build(tx);
  return JSON.stringify(tx.getData());
}

test("buildCreateAndFund targets the public fun (not an entry wrapper)", () => {
  const json = txJson((tx) => {
    const [coinA, coinB] = tx.splitCoins(tx.gas, [
      tx.pure.u64(1n),
      tx.pure.u64(2n),
    ]);
    const tunnelId = buildCreateAndFund(tx, {
      partyA: PARTY_A,
      partyB: PARTY_B,
      coinA,
      coinB,
      timeoutMs: 1000n,
    });
    assert.equal(tunnelId.$kind, "Result");
  });
  assert.ok(json.includes("create_and_fund"));
  assert.ok(!json.includes("entry_create_and_fund"));
  assert.ok(json.includes("ab".repeat(32)));
});

test("buildOpenAndFundMany makes one SplitCoins and N create_and_fund calls", () => {
  const n = 5;
  const specs = Array.from({ length: n }, (_, i) => ({
    partyA: { ...PARTY_A, address: "0x" + `a${i}` },
    partyB: { ...PARTY_B, address: "0x" + `b${i}` },
    aAmount: BigInt(1000 * (i + 1)),
    bAmount: BigInt(250 * (i + 1)),
    timeoutMs: 3_600_000n,
  }));
  const tx = new Transaction();
  const tunnelIds = buildOpenAndFundMany(tx, specs);
  assert.equal(tunnelIds.length, n);
  const cmds = tx.getData().commands as Array<{
    $kind: string;
    MoveCall?: { function: string };
  }>;

  const splits = cmds.filter((c) => c.$kind === "SplitCoins");
  const funds = cmds.filter(
    (c) => c.$kind === "MoveCall" && c.MoveCall?.function === "create_and_fund",
  );
  assert.equal(splits.length, 1);
  assert.equal(funds.length, n);
});

test("buildOpenAndFundOneReturnless targets the returnless create_and_fund", () => {
  const tx = new Transaction();
  buildOpenAndFundOneReturnless(tx, {
    partyA: PARTY_A,
    partyB: PARTY_B,
    aAmount: 1000n,
    bAmount: 1000n,
    timeoutMs: 3_600_000n,
  });
  const cmds = tx.getData().commands as Array<{
    $kind: string;
    MoveCall?: { function: string };
  }>;
  const splits = cmds.filter((c) => c.$kind === "SplitCoins");
  const funds = cmds.filter(
    (c) => c.$kind === "MoveCall" && c.MoveCall?.function === "create_and_fund",
  );
  const withId = cmds.filter(
    (c) =>
      c.$kind === "MoveCall" &&
      c.MoveCall?.function === "create_and_fund_with_id",
  );
  assert.equal(splits.length, 1);
  assert.equal(funds.length, 1);
  assert.equal(withId.length, 0);
});

const USDC = "0x" + "cc".repeat(32) + "::usdc::USDC";

test("buildOpenAndFundMany funds a non-SUI batch from a caller-supplied source coin", () => {
  const n = 3;
  const specs = Array.from({ length: n }, (_, i) => ({
    partyA: { ...PARTY_A, address: "0x" + `a${i}` },
    partyB: { ...PARTY_B, address: "0x" + `b${i}` },
    aAmount: BigInt(1000 * (i + 1)),
    bAmount: BigInt(250 * (i + 1)),
    timeoutMs: 3_600_000n,
  }));
  const tx = new Transaction();
  const sourceCoin = tx.object("0x" + "dd".repeat(32));
  const tunnelIds = buildOpenAndFundMany(tx, specs, {
    coinType: USDC,
    sourceCoin,
  });
  assert.equal(tunnelIds.length, n);
  const cmds = tx.getData().commands as Array<{
    $kind: string;
    MoveCall?: { function: string; typeArguments?: string[] };
  }>;

  const splits = cmds.filter((c) => c.$kind === "SplitCoins");
  const funds = cmds.filter(
    (c) => c.$kind === "MoveCall" && c.MoveCall?.function === "create_and_fund",
  );
  assert.equal(splits.length, 1);
  assert.equal(funds.length, n);
  for (const f of funds) {
    assert.deepEqual(f.MoveCall?.typeArguments, [USDC]);
  }
});

test("buildOpenAndFundMany rejects a non-SUI coinType with no sourceCoin", () => {
  const tx = new Transaction();
  const spec = {
    partyA: PARTY_A,
    partyB: PARTY_B,
    aAmount: 1000n,
    bAmount: 250n,
    timeoutMs: 3_600_000n,
  };
  assert.throws(
    () => buildOpenAndFundMany(tx, [spec], { coinType: USDC }),
    /sourceCoin/,
  );
});

test("create_and_fund result composes into Sui randomness seed emission", () => {
  const tx = new Transaction();
  const [coinA, coinB] = tx.splitCoins(tx.gas, [
    tx.pure.u64(1000n),
    tx.pure.u64(1000n),
  ]);
  const tunnelId = buildCreateAndFund(tx, {
    partyA: PARTY_A,
    partyB: PARTY_B,
    coinA,
    coinB,
    timeoutMs: 1000n,
  });
  buildEmitQuantumPokerRandomnessSeed(tx, {
    tunnelId,
    sessionNonce: 0n,
  });

  const json = JSON.stringify(tx.getData());
  assert.ok(json.includes("create_and_fund"));
  assert.ok(json.includes("entry_emit_quantum_poker_seed"));
  assert.ok(json.includes('"Result"'));
});
