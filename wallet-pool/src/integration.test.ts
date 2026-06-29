import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { SuiClient } from "@mysten/sui/client";
import { create } from "./create";
import { fund } from "./fund";
import { open } from "./pool";
import { list } from "./listing";
import { exportPool, importPool } from "./manage";
import { defaultStore } from "./store";
import { getClient } from "./rpc";

const E2E = !!process.env.WALLET_POOL_E2E;
const SUI = "0x2::sui::SUI";

async function waitForBalance(
  client: SuiClient,
  addr: string,
  min: bigint,
  tries = 30,
) {
  for (let i = 0; i < tries; i++) {
    if (
      BigInt(
        (await client.getBalance({ owner: addr, coinType: SUI })).totalBalance,
      ) >= min
    )
      return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`master ${addr} never reached ${min} MIST`);
}

test(
  "e2e: create -> faucet -> fund -> use -> list -> export/import",
  { skip: !E2E },
  async () => {
    const store = defaultStore(`${tmpdir()}/wp-e2e-${Date.now()}`);
    const created = await create({
      network: "testnet",
      members: 2,
      master: { generate: true },
      store,
    });
    const blob = JSON.parse(
      new TextDecoder().decode((await store.read(created.walletPoolId))!),
    ) as { index: { role: string; address: string }[] };
    const masterAddr = blob.index.find((e) => e.role === "master")!.address;

    const client = getClient("testnet");
    await fetch("https://faucet.testnet.sui.io/gas", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ FixedAmountRequest: { recipient: masterAddr } }),
    });
    await waitForBalance(client, masterAddr, 500_000_000n);

    await fund({
      store,
      walletPoolId: created.walletPoolId,
      accessValue: created.accessValue,
      network: "testnet",
      amount: 100_000_000n,
      awaitEffects: true,
    });

    const p = await open({
      store,
      network: "testnet",
      walletPoolId: created.walletPoolId,
      accessValue: created.accessValue,
    });
    const kp = await p.getMemberKey(1);
    assert.ok(kp.getPublicKey().toSuiAddress());

    const rows = await list({
      store,
      walletPoolId: created.walletPoolId,
      filter: { role: "member" },
      liveBalances: true,
      client,
    });
    assert.ok(rows.some((r) => (r.balances?.get(SUI) ?? 0n) >= 100_000_000n));

    const exported = await exportPool({
      store,
      walletPoolId: created.walletPoolId,
    });
    const store2 = defaultStore(`${tmpdir()}/wp-e2e2-${Date.now()}`);
    const imp = await importPool({ store: store2, blob: exported });
    assert.equal(imp.walletPoolId, created.walletPoolId);

    await store.delete(created.walletPoolId);
  },
);
