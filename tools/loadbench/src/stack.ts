/**
 * Brings up the local bench stack:
 *   1. `docker compose up -d` (sui-localnet + valkey).
 *      If the container fails to become healthy (e.g. on x86 hosts with the ARM64 image),
 *      stack.ts detects the unhealthy state and falls back to the host `sui` binary.
 *   2. Waits for localnet RPC to become reachable (polls for up to 300s).
 *   3. Funds the active sui client wallet from the faucet (for gas).
 *   4. Publishes the sui_tunnel Move package via the SDK (build to base64 +
 *      `tx.publish`, signed by the in-process funded publisher) — see publishPackage.
 *   5. Funds a settler key + N bench keys via the local faucet.
 *   6. Writes `.env.local` and `keys.json` next to `package.json`.
 *
 * Run: `bun run stack`   (from tools/loadbench/)
 * Env:  N=<number>  — number of bench keys to fund (default 8)
 */

import { spawnSync, spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { SuiClient } from "./suiClient";
import { Transaction } from "@mysten/sui/transactions";
import { requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { execute } from "../../../sui-tunnel-ts/src/onchain/lifecycle";
import { writeEnvLocal } from "./env";
import { envName, project, ports, suiConfigDir } from "./benchEnv";

const COMPOSE_FILE = new URL("../docker-compose.yml", import.meta.url).pathname;

// sui-tools image version for the localnet container. sui-tools ships per-arch tags
// (the bare tag is amd64; arm64 is a `-arm64` suffix), so the tag is arch-selected at
// runtime — keep this in sync with the host `sui` version used to build the package.
const SUI_TOOLS_VERSION = "testnet-v1.74.0";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll the localnet RPC until `sui_getChainIdentifier` succeeds or timeout. */
async function waitRpc(client: SuiClient): Promise<void> {
  for (let i = 0; i < 150; i++) {
    try {
      await client.getChainIdentifier();
      return;
    } catch {
      await sleep(2000);
    }
  }
  throw new Error("localnet RPC not healthy after 300s");
}

/** Poll the local faucet until it responds to a GET, allowing the faucet process to start. */
async function waitFaucet(faucetUrl: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(faucetUrl);
      if (res.status < 500) return;
    } catch {
      // ECONNREFUSED — faucet not up yet
    }
    await sleep(1000);
  }
  throw new Error("faucet not ready after 30s");
}

/** Return the Docker health status string for a named container, or null if not found. */
function containerHealth(name: string): string | null {
  const r = spawnSync(
    "docker",
    ["inspect", "--format", "{{.State.Health.Status}}", name],
    { encoding: "utf8" },
  );
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

/**
 * Start the host `sui` binary as a background process.
 * Used when the Docker sui-localnet container fails to become healthy
 * (e.g. architecture mismatch or missing genesis state).
 * Uses `--force-regenesis` so no prior config directory is needed.
 */
function startHostSui(): ReturnType<typeof spawn> {
  console.log(
    "falling back to host `sui start` (Docker container unhealthy)…",
  );
  const child = spawn(
    "sui",
    [
      "start",
      "--force-regenesis",
      "--with-faucet",
    ],
    { stdio: ["ignore", "pipe", "pipe"], detached: false },
  );
  child.stdout?.on("data", (d: Buffer) =>
    process.stdout.write(`[sui] ${d}`),
  );
  child.stderr?.on("data", (d: Buffer) =>
    process.stderr.write(`[sui] ${d}`),
  );
  return child;
}

/**
 * Build sui_tunnel to bytecode and publish it via the SDK, signed by `signer`
 * (the in-process, faucet-funded publisher). Returns the on-chain packageId.
 *
 * Why SDK publish, not `sui client publish` / `test-publish`: on this host the CLI
 * signs with the ~/.sui active address and ignores SUI_CONFIG_DIR, so the publish
 * fails "Cannot find gas coin"; and the CLI publish path validates the active env
 * against Move.toml [environments]. Building to base64 + `tx.publish` sidesteps
 * both — the in-process keypair signs (exact isolation) and no env validation runs,
 * so no Move.toml / Published.toml / Move.lock patching is needed. `sui move build`
 * itself touches neither the keystore nor the active env.
 *
 * The publish requires the localnet to raise two protocol limits (set in main on the
 * host-sui fallback): max_move_package_size (sui_tunnel bytecode is ~139 KB > the
 * 102 KB localnet default) and max_tx_size_bytes (the publish tx carries the whole
 * ~180 KB package > the 128 KiB default).
 */
async function publishPackage(
  client: SuiClient,
  signer: Ed25519Keypair,
): Promise<string> {
  // Resolve: src/stack.ts → src/ → loadbench/ → tools/ → repo root → sui_tunnel
  const pkgPath = new URL("../../../sui_tunnel", import.meta.url).pathname;

  // --dump-bytecode-as-base64 writes {modules:[b64], dependencies:[objId], digest:[]}
  // to stdout (build progress goes to stderr). sui_tunnel's only dependencies are the
  // system packages 0x1/0x2, present on every network incl. a force-regenesis localnet,
  // so --with-unpublished-dependencies is not needed.
  const built = spawnSync(
    "sui",
    ["move", "build", "--dump-bytecode-as-base64", "--path", pkgPath],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (built.status !== 0) {
    throw new Error(`sui move build failed:\n${built.stderr || built.stdout}`);
  }
  let compiled: { modules: string[]; dependencies: string[] };
  try {
    compiled = JSON.parse(built.stdout);
  } catch {
    throw new Error(
      `could not parse 'sui move build --dump' JSON:\n${built.stdout.slice(0, 1000)}`,
    );
  }

  const tx = new Transaction();
  // tx.publish returns the UpgradeCap; it must be consumed (transferred) or the tx aborts.
  const upgradeCap = tx.publish({
    modules: compiled.modules,
    dependencies: compiled.dependencies,
  });
  tx.transferObjects([upgradeCap], signer.toSuiAddress());
  tx.setGasBudget(2_000_000_000);

  // execute() surfaces an on-chain Move abort as a throw (status "failure").
  const res = await execute(client, signer, tx, { waitForFinality: true });
  const published = (
    res.objectChanges as Array<{ type: string; packageId?: string }> | undefined
  )?.find((c) => c.type === "published");
  if (!published?.packageId) {
    throw new Error(
      `no published package in objectChanges:\n${JSON.stringify(res.objectChanges)}`,
    );
  }
  return published.packageId;
}

type FundedKey = { secretKey: string; address: string };

/** Generate `n` fresh keypairs, request faucet funds, and wait for balances to confirm. */
async function fundKeys(client: SuiClient, n: number, faucetUrl: string): Promise<FundedKey[]> {
  const keys: FundedKey[] = [];
  for (let i = 0; i < n; i++) {
    const kp = new Ed25519Keypair();
    const address = kp.toSuiAddress();
    await requestSuiFromFaucetV2({
      host: faucetUrl,
      recipient: address,
    });
    keys.push({ secretKey: kp.getSecretKey(), address });
  }
  // Wait for each balance to land — callers depend on funded state.
  for (const k of keys) {
    for (let i = 0; i < 30; i++) {
      const { totalBalance } = await client.getBalance({ owner: k.address });
      if (BigInt(totalBalance) > 0n) break;
      await sleep(1000);
    }
  }
  return keys;
}

/** Write a self-contained sui CLI config (client.yaml + keystore + aliases) pointed at
 *  this stack's localnet, so `sui move build` (the only sui CLI call left) never reads or
 *  writes the global ~/.sui. Signing goes through the SDK in-process, not the CLI keystore;
 *  this config exists only to keep the CLI isolated and non-interactive. */
function seedSuiConfig(configDir: string, rpc: string, kp: Ed25519Keypair): string {
  mkdirSync(configDir, { recursive: true });
  // 0x00 prefix = ed25519 flag byte, matching the sui keystore wire format.
  const flagged = (bytes: Uint8Array) =>
    Buffer.concat([Buffer.from([0x00]), Buffer.from(bytes)]).toString("base64");
  const { secretKey } = decodeSuiPrivateKey(kp.getSecretKey());
  const addr = kp.toSuiAddress();
  // mode 0o600: keystore holds an unencrypted private key; restrict to owner-only, matching the real sui CLI.
  writeFileSync(`${configDir}/sui.keystore`, JSON.stringify([flagged(secretKey)], null, 2), { mode: 0o600 });
  writeFileSync(
    `${configDir}/sui.aliases`,
    JSON.stringify([{ alias: "publisher", public_key_base64: flagged(kp.getPublicKey().toRawBytes()) }], null, 2),
  );
  writeFileSync(
    `${configDir}/client.yaml`,
    // A valid client.yaml stops `sui move build` from prompting to initialise a config
    // under SUI_CONFIG_DIR. The env alias / active_address are no longer load-bearing
    // now that publishing goes through the SDK (no `sui client publish` env validation).
    `keystore:\n  File: ${configDir}/sui.keystore\nenvs:\n  - alias: local\n    rpc: "${rpc}"\n    ws: ~\n    basic_auth: ~\nactive_env: local\nactive_address: "${addr}"\n`,
  );
  return addr;
}

async function main(): Promise<void> {
  const n = Number(process.env.N ?? "8");

  // Change 1: resolve env identity once, before any compose or sui invocation.
  const name = envName();
  const proj = project(name);
  const p = ports(name);
  const cfgDir = suiConfigDir(name);
  // All `sui` CLI calls in this process target the per-stack config, never ~/.sui.
  process.env.SUI_CONFIG_DIR = cfgDir;
  let rpcPort = p.rpc;
  let faucetPort = p.faucet;
  const rpcUrl = () => `http://127.0.0.1:${rpcPort}`;
  const faucetUrl = () => `http://127.0.0.1:${faucetPort}`;
  console.log(`bench env "${name}" → project ${proj}, rpc :${rpcPort}, faucet :${faucetPort}, relay :${p.relay}`);

  console.log("bringing up compose infra (localnet + valkey)…");
  // Change 2: compose up under the env project + per-env ports.
  // Start all services detached; valkey is healthy quickly.
  // sui-localnet may stay unhealthy (architecture mismatch, etc.) — detected below.
  // Select the sui-tools tag for the host arch: the bare (amd64) tag SIGILLs under QEMU
  // on Apple Silicon, so use the -arm64 tag there. Other arches fall back to the bare tag.
  const suiToolsTag =
    process.arch === "arm64" ? `${SUI_TOOLS_VERSION}-arm64` : SUI_TOOLS_VERSION;
  const composeEnv = {
    ...process.env,
    SUI_RPC_PORT: String(rpcPort),
    SUI_FAUCET_PORT: String(faucetPort),
    VALKEY_PORT: String(p.valkey),
    SUI_TOOLS_TAG: suiToolsTag,
  } as NodeJS.ProcessEnv;
  const up = spawnSync(
    "docker",
    ["compose", "-f", COMPOSE_FILE, "-p", proj, "up", "-d"],
    { stdio: "inherit", env: composeEnv },
  );
  if (up.status !== 0) throw new Error("docker compose up failed");

  // Wait for healthcheck cycles to determine if sui-localnet is viable.
  // The ARM64 image becomes healthy within ~30s on Apple Silicon.
  // If unhealthy, stack.ts falls back to the host `sui` binary.
  console.log("waiting for sui-localnet health probe…");
  let suiViaDocker = false;
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    // Change 3: health container name is project-derived.
    const h = containerHealth(`${proj}-sui-localnet-1`);
    if (h === "healthy") {
      suiViaDocker = true;
      break;
    }
    if (h === "unhealthy") break; // confirmed broken — fall back immediately
    // h === "starting" — keep probing
  }

  let hostSuiProc: ReturnType<typeof spawn> | null = null;
  if (!suiViaDocker) {
    // Stop the broken sui-localnet container so its port-forwards are
    // released before we start the host sui binary on those same ports.
    console.log("stopping broken sui-localnet container to free ports…");
    // Change 4: stop uses the project.
    spawnSync(
      "docker",
      ["compose", "-f", COMPOSE_FILE, "-p", proj, "stop", "sui-localnet"],
      { stdio: "inherit", env: composeEnv },
    );

    // Change 5: host-sui fallback is single-stack — reset to default ports.
    rpcPort = 9000;
    faucetPort = 9123;
    console.log("host-sui fallback is NOT isolated — using default ports 9000/9123 (one stack at a time).");

    // The sui binary needs max_move_package_size raised (sui_tunnel is 139 KB,
    // default limit on localnet is 102 KB).
    process.env.SUI_PROTOCOL_CONFIG_OVERRIDE_ENABLE = "1";
    process.env.SUI_PROTOCOL_CONFIG_OVERRIDE_max_move_package_size = "512000";
    // The publish transaction carries the whole package (~180 KB serialized),
    // exceeding the default max_tx_size_bytes (128 KiB); raise it for the deploy.
    process.env.SUI_PROTOCOL_CONFIG_OVERRIDE_max_tx_size_bytes = "2097152";
    hostSuiProc = startHostSui();
    await sleep(3000);
  }

  const client = new SuiClient({ url: rpcUrl() });
  try {
    await waitRpc(client);
  } catch (err) {
    if (hostSuiProc) hostSuiProc.kill();
    throw err;
  }
  console.log("localnet RPC ready");

  // Change 7: seed the per-stack sui CLI config so `sui client publish`
  // never reads or writes global ~/.sui.
  const publisherKp = new Ed25519Keypair();
  const publisherAddr = seedSuiConfig(cfgDir, rpcUrl(), publisherKp);
  // SUI_CONFIG_DIR is already exported, so all `sui` calls below use this config.

  // Change 6: faucet polling uses faucetUrl().
  await waitFaucet(faucetUrl());

  // Fund the active wallet so the publish transaction has enough gas.
  // The sui_tunnel package is large; a budget of 2B MIST is needed.
  // Each faucet response gives 5 × 200 SUI coins; one call is sufficient.
  console.log(`funding publisher wallet ${publisherAddr}…`);
  // Change 6: funding uses faucetUrl() instead of getFaucetHost("localnet").
  await requestSuiFromFaucetV2({
    host: faucetUrl(),
    recipient: publisherAddr,
  });
  for (let i = 0; i < 30; i++) {
    const { totalBalance } = await client.getBalance({ owner: publisherAddr });
    if (BigInt(totalBalance) > 0n) break;
    await sleep(1000);
  }

  console.log("publishing sui_tunnel package…");
  let packageId: string;
  try {
    packageId = await publishPackage(client, publisherKp);
  } catch (err) {
    if (hostSuiProc) hostSuiProc.kill();
    throw err;
  }

  console.log(`funding settler + ${n} bench keys…`);
  let settler: FundedKey;
  let keys: FundedKey[];
  try {
    [settler] = await fundKeys(client, 1, faucetUrl());
    keys = await fundKeys(client, n, faucetUrl());
  } catch (err) {
    if (hostSuiProc) hostSuiProc.kill();
    throw err;
  }

  writeFileSync(
    new URL("../keys.json", import.meta.url),
    JSON.stringify(keys, null, 2),
  );
  // Change 8: write resolved URLs to .env.local, including relay URL.
  writeEnvLocal({
    SUI_RPC_URL: rpcUrl(),
    SUI_NETWORK: rpcUrl(),
    TUNNEL_PACKAGE_ID: packageId,
    PACKAGE_ID: packageId,
    SUI_SETTLER_KEY: settler.secretKey,
    MP_WS_URL: `ws://127.0.0.1:${p.relay}/v1/mp`,
  });

  console.log(
    `stack ready — PACKAGE_ID=${packageId}, ${n} funded keys in keys.json`,
  );

  // Keep the script running while the host sui process is alive so the localnet stays up.
  if (hostSuiProc) {
    console.log("host sui is running — press Ctrl-C to stop the localnet.");
    await new Promise<void>((_, reject) => {
      hostSuiProc!.on("exit", (code) => {
        if (code !== 0 && code !== null)
          reject(new Error(`sui exited with code ${code}`));
      });
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
