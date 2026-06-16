process.env.PACKAGE_ID = "0x" + "ab".repeat(32);

import { Transaction } from "@mysten/sui/transactions";
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCreateAndFund, buildOpenAndFundMany } from "./createAndFund";

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
    buildCreateAndFund(tx, {
      partyA: PARTY_A,
      partyB: PARTY_B,
      coinA,
      coinB,
      timeoutMs: 1000n,
    });
  });
  // Composes in a PTB precisely because it is `public fun`, not `entry_create_and_fund`.
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
  buildOpenAndFundMany(tx, specs);
  const cmds = tx.getData().commands as Array<{
    $kind: string;
    MoveCall?: { function: string };
  }>;

  // One split feeds every stake; one create_and_fund per tunnel — the "N opens, 1 PTB" shape.
  const splits = cmds.filter((c) => c.$kind === "SplitCoins");
  const funds = cmds.filter(
    (c) => c.$kind === "MoveCall" && c.MoveCall?.function === "create_and_fund",
  );
  assert.equal(splits.length, 1);
  assert.equal(funds.length, n);
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
  buildOpenAndFundMany(tx, specs, { coinType: USDC, sourceCoin });
  const cmds = tx.getData().commands as Array<{
    $kind: string;
    MoveCall?: { function: string; typeArguments?: string[] };
  }>;

  // Still the "N opens, 1 PTB" shape, but every create_and_fund is type-argged <USDC>, not <SUI>.
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

test("buildOpenAndFundMany rejects a non-SUI coinType with no sourceCoin (no gas-split footgun)", () => {
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
