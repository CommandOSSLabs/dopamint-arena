import { test } from "node:test";
import assert from "node:assert/strict";

// The SDK tx builders read the Move package id from env (Vite injects it via `define`); supply it
// here so `buildOpenAndFundMany` can resolve its move targets under node:test.
process.env.PACKAGE_ID = "0x2";
process.env.SUI_NETWORK = "testnet";

import { openAndFundSelfPlay } from "./tunnelTx.ts";
import { buildSweepToAddressBalance } from "./mtps.ts";
import { Transaction } from "@mysten/sui/transactions";

const COIN = "0xabc::mtps::MTPS";

// findTunnelId looks for a created `::tunnel::Tunnel` object change; the rest is unused here.
const fakeReads = {
  waitForTransaction: async () => {},
  getTransactionBlock: async () => ({
    objectChanges: [
      {
        type: "created",
        objectType: `0xpkg::tunnel::Tunnel<${COIN}>`,
        objectId: "0xtunnel",
      },
    ],
  }),
  getObject: async () => ({}),
} as unknown as Parameters<typeof openAndFundSelfPlay>[0]["reads"];

const party = (address: string) => ({ address, publicKey: new Uint8Array(32) });

/** Build the open PTB the builder would submit, capturing it instead of signing. */
async function capturedOpen(
  stake:
    | { stakeFromBalance: { amount: bigint; coinType: string } }
    | { stakeCoinId: string },
) {
  let captured: Transaction | undefined;
  await openAndFundSelfPlay({
    reads: fakeReads,
    signExec: async (tx) => {
      captured = tx as unknown as Transaction;
      return { digest: "0xdigest" };
    },
    partyA: party("0x1"),
    partyB: party("0x2"),
    aAmount: 1_000_000_000n,
    bAmount: 1_000_000_000n,
    coinType: COIN,
    ...stake,
  });
  return captured!.getData();
}

test("address-balance stake builds a Sender FundsWithdrawal + redeem_funds, no coin object", async () => {
  const data = await capturedOpen({
    stakeFromBalance: { amount: 2_000_000_000n, coinType: COIN },
  });

  const withdrawal = data.inputs.find((i) => i.$kind === "FundsWithdrawal");
  assert.ok(withdrawal, "the PTB carries a FundsWithdrawal input");
  // Must be the SENDER's own funds (the backend refuses Sponsor withdrawals — settler drain).
  assert.equal(
    (withdrawal as { FundsWithdrawal: { withdrawFrom: { $kind: string } } })
      .FundsWithdrawal.withdrawFrom.$kind,
    "Sender",
  );

  const hasRedeem = data.commands.some(
    (c) => c.$kind === "MoveCall" && c.MoveCall.function === "redeem_funds",
  );
  assert.ok(hasRedeem, "the stake coin comes from coin::redeem_funds");

  // The seat-stake split leaves a zero remainder; a redeemed Coin<T> has no `drop`, so it must be
  // destroyed or the PTB fails dry-run with "Unused ValueWithoutDrop".
  const hasDestroyZero = data.commands.some(
    (c) => c.$kind === "MoveCall" && c.MoveCall.function === "destroy_zero",
  );
  assert.ok(hasDestroyZero, "the zero withdrawal remainder is destroyed");
});

test("legacy coin-object stake builds no FundsWithdrawal (path unchanged)", async () => {
  const data = await capturedOpen({ stakeCoinId: "0xCAFE" });
  assert.ok(
    !data.inputs.some((i) => i.$kind === "FundsWithdrawal"),
    "the coin-object path never withdraws from an address balance",
  );
});

test("buildSweepToAddressBalance emits one coin::send_funds per coin", () => {
  const tx = new Transaction();
  buildSweepToAddressBalance(tx, "0x1", ["0xa", "0xb"]);
  const sends = tx
    .getData()
    .commands.filter(
      (c) => c.$kind === "MoveCall" && c.MoveCall.function === "send_funds",
    );
  assert.equal(sends.length, 2);
});
