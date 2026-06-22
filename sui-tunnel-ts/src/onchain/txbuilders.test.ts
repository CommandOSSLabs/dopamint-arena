process.env.PACKAGE_ID = "0x" + "ab".repeat(32);

import { test } from "node:test";
import assert from "node:assert/strict";
import { Transaction } from "@mysten/sui/transactions";
import * as tb from "./txbuilders";

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
const TID = "0x" + "cd".repeat(32);

function txJson(build: (tx: Transaction) => void): string {
  const tx = new Transaction();
  build(tx);
  return JSON.stringify(tx.getData());
}

test("buildCreateAndShare targets entry_create_and_share with the package id", () => {
  const json = txJson((tx) =>
    tb.buildCreateAndShare(tx, {
      partyA: PARTY_A,
      partyB: PARTY_B,
      timeoutMs: 1000n,
      penaltyAmount: 0n,
    }),
  );
  assert.ok(json.includes("entry_create_and_share"));
  assert.ok(json.includes("ab".repeat(32)));
});

test("recovery builders target the correct Move functions", () => {
  assert.ok(
    txJson((tx) =>
      tb.buildRaiseDisputeCurrentState(tx, { tunnelId: TID }),
    ).includes("entry_raise_dispute_current_state"),
  );
  assert.ok(
    txJson((tx) => tb.buildForceClose(tx, { tunnelId: TID })).includes(
      "entry_force_close",
    ),
  );
  assert.ok(
    txJson((tx) =>
      tb.buildWithdrawTimeout(tx, {
        tunnelId: TID,
        recipient: PARTY_A.address,
      }),
    ).includes("withdraw_timeout"),
  );
});

test("buildDepositFromGas splits gas and deposits", () => {
  const json = txJson((tx) =>
    tb.buildDepositFromGas(tx, { tunnelId: TID, amount: 500n }),
  );
  assert.ok(json.includes("entry_deposit"));
  assert.ok(json.includes("SplitCoins"));
});

test("buildEmitQuantumPokerRandomnessSeed targets Sui randomness bridge", () => {
  const json = txJson((tx) =>
    tb.buildEmitQuantumPokerRandomnessSeed(tx, {
      tunnelId: TID,
      sessionNonce: 1n,
      context: new Uint8Array([1, 2, 3]),
    }),
  );
  assert.ok(json.includes("sui_randomness"));
  assert.ok(json.includes("entry_emit_quantum_poker_seed"));
  assert.ok(json.includes("0000000000000000000000000000000000000000000000000000000000000008"));
});

test("buildCloseFromSettlement wires settlement balances + sigs", () => {
  const json = txJson((tx) =>
    tb.buildCloseFromSettlement(tx, TID, {
      settlement: {
        tunnelId: TID,
        partyABalance: 100n,
        partyBBalance: 200n,
        finalNonce: 5n,
        timestamp: 123n,
      },
      sigA: new Uint8Array(64),
      sigB: new Uint8Array(64),
    }),
  );
  assert.ok(json.includes("entry_close_cooperative"));
});

test("buildWithdrawTimeout transfers the returned coin to the recipient", () => {
  const json = txJson((tx) =>
    tb.buildWithdrawTimeout(tx, { tunnelId: TID, recipient: PARTY_A.address }),
  );
  assert.ok(json.includes("TransferObjects"));
});

test("buildCloseCooperativeWithRoot targets the root-anchored entry", () => {
  const json = txJson((tx) =>
    tb.buildCloseCooperativeWithRoot(tx, {
      tunnelId: TID,
      partyABalance: 1n,
      partyBBalance: 2n,
      sigA: new Uint8Array(64),
      sigB: new Uint8Array(64),
      timestamp: 1n,
      transcriptRoot: new Uint8Array(32),
    }),
  );
  assert.ok(json.includes("entry_close_cooperative_with_root"));
});

test("buildBatchClose adds one close per tunnel in a single tx", () => {
  const tx = new Transaction();
  const mk = (id: string) => ({
    tunnelId: id,
    settlement: {
      settlement: {
        tunnelId: id,
        partyABalance: 1n,
        partyBBalance: 1n,
        finalNonce: 1n,
        timestamp: 1n,
      },
      sigA: new Uint8Array(64),
      sigB: new Uint8Array(64),
    },
  });
  const n = tb.buildBatchClose(tx, [mk(TID), mk("0x" + "ef".repeat(32))]);
  assert.equal(n, 2);
  const commands = tx.getData().commands;
  const closes =
    JSON.stringify(commands).split("entry_close_cooperative").length - 1;
  assert.equal(closes, 2);
});

test("Quantum Poker builders target session creation and proof resolution", () => {
  const sessionJson = txJson((tx) =>
    tb.buildCreateQuantumPokerSession(tx, {
      tunnelId: TID,
      rulesHash: new Uint8Array(32),
      circuitId: new Uint8Array(32),
      inputSchemaHash: new Uint8Array(32),
    }),
  );
  assert.ok(sessionJson.includes("quantum_poker"));
  assert.ok(sessionJson.includes("entry_create_session"));

  const resolveJson = txJson((tx) =>
    tb.buildResolveQuantumPokerWithProof(tx, {
      sessionId: "0x" + "12".repeat(32),
      registryId: "0x" + "34".repeat(32),
      tunnelId: TID,
      proofBytes: new Uint8Array([1, 2, 3]),
      stateHash: new Uint8Array(32),
      handId: 1n,
      winner: 0,
      partyABalance: 100n,
      partyBBalance: 200n,
      resultHash: new Uint8Array(32),
    }),
  );
  assert.ok(resolveJson.includes("quantum_poker_referee"));
  assert.ok(resolveJson.includes("entry_resolve_with_proof"));
});
