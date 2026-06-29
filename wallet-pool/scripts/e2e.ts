import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { create } from "../src/create";
import { fund } from "../src/fund";
import { open } from "../src/pool";
import { list } from "../src/listing";
import { exportPool, importPool } from "../src/manage";
import { defaultStore } from "../src/store";
import { getClient } from "../src/rpc";

const SUI = "0x2::sui::SUI";
const ONE_SUI = 1_000_000_000n;

async function waitForBalance(
  addr: string,
  min: bigint,
  tries = 60,
): Promise<void> {
  const client = getClient("testnet");
  for (let i = 0; i < tries; i++) {
    const bal = BigInt(
      (await client.getBalance({ owner: addr, coinType: SUI })).totalBalance,
    );
    if (bal >= min) return;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`master ${addr} never reached ${min} MIST`);
}

function suiCli(args: string[]): unknown {
  const out = execFileSync("sui", ["client", ...args], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  return JSON.parse(out);
}

function getGasCoin(): { coinObjectId: string; mistBalance: string } {
  const coins = suiCli(["gas", "--json"]) as Array<{
    gasCoinId: string;
    mistBalance: number;
    suiBalance: string;
  }>;
  const coin = coins[0];
  if (!coin) throw new Error("no gas coin in sui client");
  return {
    coinObjectId: coin.gasCoinId,
    mistBalance: String(coin.mistBalance),
  };
}

async function main() {
  const store = defaultStore(`${tmpdir()}/wp-e2e-${Date.now()}`);
  const created = await create({
    network: "testnet",
    members: 2,
    master: { generate: true },
    store,
  });
  console.log("pool id:", created.walletPoolId);

  const bytes = await store.read(created.walletPoolId);
  if (!bytes) throw new Error("pool missing after create");
  const blob = JSON.parse(new TextDecoder().decode(bytes)) as {
    index: { role: string; address: string }[];
  };
  const masterAddr = blob.index.find((e) => e.role === "master")!.address;
  console.log("master address:", masterAddr);

  const gas = getGasCoin();
  console.log("gas coin:", gas.coinObjectId, "balance:", gas.mistBalance);

  const transferResult = suiCli([
    "transfer-sui",
    "--to",
    masterAddr,
    "--sui-coin-object-id",
    gas.coinObjectId,
    "--amount",
    String(ONE_SUI),
    "--gas-budget",
    "5000000",
    "--json",
  ]);
  console.log(
    "transfer digest:",
    (transferResult as { digest: string }).digest,
  );

  await waitForBalance(masterAddr, ONE_SUI);
  console.log("master funded");

  const fundResult = await fund({
    store,
    walletPoolId: created.walletPoolId,
    accessValue: created.accessValue,
    network: "testnet",
    amount: 100_000_000n,
    awaitEffects: true,
  });
  console.log("fund digest:", fundResult.digest);

  const p = await open({
    store,
    network: "testnet",
    walletPoolId: created.walletPoolId,
    accessValue: created.accessValue,
  });
  const kp = await p.getMemberKey(1);
  console.log("member 1 address:", kp.getPublicKey().toSuiAddress());

  const rows = await list({
    store,
    walletPoolId: created.walletPoolId,
    filter: { role: "member" },
    liveBalances: true,
    client: getClient("testnet"),
  });
  const funded = rows.some((r) => (r.balances?.get(SUI) ?? 0n) >= 100_000_000n);
  if (!funded) throw new Error("no member received funds");
  console.log("live balances confirm funding");

  const exported = await exportPool({
    store,
    walletPoolId: created.walletPoolId,
  });
  const store2 = defaultStore(`${tmpdir()}/wp-e2e2-${Date.now()}`);
  const imp = await importPool({ store: store2, blob: exported });
  if (imp.walletPoolId !== created.walletPoolId) {
    throw new Error("import returned wrong pool id");
  }
  console.log("export/import round-trip ok");

  await store.delete(created.walletPoolId);
  console.log("e2e complete");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
