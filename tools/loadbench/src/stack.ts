/**
 * Brings up the local bench stack:
 *   1. `docker compose up -d` (sui-localnet + valkey).
 *      If the container fails to become healthy (e.g. on x86 hosts with the ARM64 image),
 *      stack.ts detects the unhealthy state and falls back to the host `sui` binary.
 *   2. Waits for localnet RPC to become reachable (polls for up to 300s).
 *   3. Funds the active sui client wallet from the faucet (for gas).
 *   4. Publishes the sui_tunnel Move package.
 *      sui ≥ 1.73 requires:
 *        a) Move.toml [environments] with the active env and its chain-id.
 *        b) No stale [published.local] entry in Published.toml.
 *      stack.ts patches both files around the publish call and restores them.
 *   5. Funds a settler key + N bench keys via the local faucet.
 *   6. Writes `.env.local` and `keys.json` next to `package.json`.
 *
 * Run: `bun run stack`   (from tools/loadbench/)
 * Env:  N=<number>  — number of bench keys to fund (default 8)
 */

import { spawnSync, spawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { SuiClient } from "@mysten/sui/client";
import { getFaucetHost, requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { writeEnvLocal } from "./env";

const RPC = "http://127.0.0.1:9000";
const COMPOSE_FILE = new URL("../docker-compose.yml", import.meta.url).pathname;

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
async function waitFaucet(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch("http://127.0.0.1:9123/");
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
 * Publish the sui_tunnel package to localnet and return its on-chain packageId.
 *
 * sui ≥ 1.73 enforces that:
 *   1. Move.toml [environments] contains the active client environment.
 *   2. Published.toml has no stale publication record for that environment.
 *
 * The upstream sui_tunnel Move.toml has no [environments] section and
 * Published.toml accumulates entries across runs. This function:
 *   - Patches Move.toml to add the `local` env entry with the current chain-id.
 *   - Deletes Move.lock (gitignored, regenerated on build) to avoid stale chain-id
 *     mismatches in [pinned.local.*] sections from prior runs.
 *   - Clears any stale [published.local] section from Published.toml.
 *   - Runs `sui client publish`.
 *   - Restores Move.toml and Published.toml; leaves Move.lock as regenerated.
 *
 * The gas budget of 2B MIST is required because the sui_tunnel bytecode is
 * larger than normal localnet defaults (139 KB vs 102 KB cap). The host sui
 * is started with SUI_PROTOCOL_CONFIG_OVERRIDE_max_move_package_size=512000
 * to raise this limit.
 */
function publishPackage(chainId: string): string {
  // Resolve: src/stack.ts → src/ → loadbench/ → tools/ → repo root → sui_tunnel
  const pkgPath = new URL("../../../sui_tunnel", import.meta.url).pathname;
  const moveToml = `${pkgPath}/Move.toml`;
  const moveLock = `${pkgPath}/Move.lock`;
  const publishedToml = `${pkgPath}/Published.toml`;

  const origMoveToml = readFileSync(moveToml, "utf8");
  const moveLockExists = existsSync(moveLock);
  const origPublishedToml = existsSync(publishedToml)
    ? readFileSync(publishedToml, "utf8")
    : null;

  let patched = false;
  try {
    // 1. Add/overwrite [environments] in Move.toml with the current chain-id.
    let newMoveToml = origMoveToml.replace(/\n\[environments\][\s\S]*$/, "");
    newMoveToml = newMoveToml.trimEnd() + `\n\n[environments]\nlocal = "${chainId}"\n`;
    writeFileSync(moveToml, newMoveToml);
    patched = true;

    // 2. Remove Move.lock so the CLI regenerates it with the current chain-id.
    //    Stripping individual [pinned.local.*] sections is error-prone because the
    //    global regex skips the middle section when two adjacent sections share a
    //    blank-line boundary. Deletion is safe: Move.lock is gitignored and always
    //    regenerated on build.
    if (moveLockExists) {
      unlinkSync(moveLock);
    }

    // 3. Strip the stale [published.local] section from Published.toml so that
    //    `sui client publish` doesn't think the package is already published here.
    if (origPublishedToml !== null) {
      const stripped = origPublishedToml
        .replace(/\n\[published\.local\][\s\S]*?(?=\n\[|$)/, "")
        .trimEnd() + "\n";
      writeFileSync(publishedToml, stripped);
    }

    const out = spawnSync(
      "sui",
      ["client", "publish", "--gas-budget", "2000000000", "--json", pkgPath],
      { encoding: "utf8" },
    );

    // Restore patched files before any throw.
    // Move.lock is NOT restored — it is gitignored and the CLI regenerated it with
    // the new chain-id during publish. Restoring the old content would corrupt it.
    writeFileSync(moveToml, origMoveToml);
    if (origPublishedToml !== null) writeFileSync(publishedToml, origPublishedToml);
    patched = false;

    if (out.status !== 0) {
      throw new Error(`publish failed:\n${out.stderr || out.stdout}`);
    }

    // `sui client publish --json` emits build-progress lines before the JSON object.
    const lines = out.stdout.split("\n");
    const jsonStart = lines.findIndex((l) => l.trimStart().startsWith("{"));
    if (jsonStart === -1) {
      throw new Error(`no JSON in publish output:\n${out.stdout}`);
    }
    const jsonText = lines.slice(jsonStart).join("\n");

    const changes = JSON.parse(jsonText).objectChanges as {
      type: string;
      packageId?: string;
    }[];
    const pkg = changes.find((c) => c.type === "published");
    if (!pkg?.packageId) throw new Error("no published package in objectChanges");
    return pkg.packageId;
  } finally {
    // Safety net: restore Move.toml and Published.toml if an unexpected exception
    // interrupted the normal restore path. Move.lock is intentionally not restored
    // (gitignored, regenerated by the CLI).
    if (patched) {
      writeFileSync(moveToml, origMoveToml);
      if (origPublishedToml !== null) writeFileSync(publishedToml, origPublishedToml);
    }
  }
}

type FundedKey = { secretKey: string; address: string };

/** Generate `n` fresh keypairs, request faucet funds, and wait for balances to confirm. */
async function fundKeys(client: SuiClient, n: number): Promise<FundedKey[]> {
  const keys: FundedKey[] = [];
  for (let i = 0; i < n; i++) {
    const kp = new Ed25519Keypair();
    const address = kp.toSuiAddress();
    await requestSuiFromFaucetV2({
      host: getFaucetHost("localnet"),
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

async function main(): Promise<void> {
  const n = Number(process.env.N ?? "8");

  console.log("bringing up compose infra (localnet + valkey)…");
  // Start all services detached; valkey is healthy quickly.
  // sui-localnet may stay unhealthy (architecture mismatch, etc.) — detected below.
  const up = spawnSync(
    "docker",
    ["compose", "-f", COMPOSE_FILE, "up", "-d"],
    { stdio: "inherit" },
  );
  if (up.status !== 0) throw new Error("docker compose up failed");

  // Wait for healthcheck cycles to determine if sui-localnet is viable.
  // The ARM64 image becomes healthy within ~30s on Apple Silicon.
  // If unhealthy, stack.ts falls back to the host `sui` binary.
  console.log("waiting for sui-localnet health probe…");
  let suiViaDocker = false;
  for (let i = 0; i < 12; i++) {
    await sleep(5000);
    const h = containerHealth("loadbench-sui-localnet-1");
    if (h === "healthy") {
      suiViaDocker = true;
      break;
    }
    if (h === "unhealthy") break; // confirmed broken — fall back immediately
    // h === "starting" — keep probing
  }

  let hostSuiProc: ReturnType<typeof spawn> | null = null;
  if (!suiViaDocker) {
    // Stop the broken sui-localnet container so its port-forwards (9000, 9123) are
    // released before we start the host sui binary on those same ports.
    console.log("stopping broken sui-localnet container to free ports 9000/9123…");
    spawnSync(
      "docker",
      ["compose", "-f", COMPOSE_FILE, "stop", "sui-localnet"],
      { stdio: "inherit" },
    );

    // The sui binary needs max_move_package_size raised (sui_tunnel is 139 KB,
    // default limit on localnet is 102 KB).
    process.env.SUI_PROTOCOL_CONFIG_OVERRIDE_ENABLE = "1";
    process.env.SUI_PROTOCOL_CONFIG_OVERRIDE_max_move_package_size = "512000";
    hostSuiProc = startHostSui();
    await sleep(3000);
  }

  const client = new SuiClient({ url: RPC });
  try {
    await waitRpc(client);
  } catch (err) {
    if (hostSuiProc) hostSuiProc.kill();
    throw err;
  }
  console.log("localnet RPC ready");

  // Ensure the sui client targets localnet.
  // This also updates the cached chain_id in ~/.sui/sui_config/client.yaml,
  // which must match what we write into Move.toml's [environments] section.
  spawnSync("sui", ["client", "switch", "--env", "local"], {
    encoding: "utf8",
    stdio: "pipe",
  });

  // Wait for the faucet process to start (it launches a few seconds after RPC).
  await waitFaucet();

  // Read chain ID from the CLI (not the TypeScript client) so it matches exactly
  // what `sui client publish` will validate against Move.toml [environments].
  const chainIdResult = spawnSync("sui", ["client", "chain-identifier"], {
    encoding: "utf8",
  });
  const chainId = chainIdResult.stdout.trim();
  if (!chainId) throw new Error("failed to get chain identifier from sui CLI");

  // Fund the active wallet so the publish transaction has enough gas.
  // The sui_tunnel package is large; a budget of 2B MIST is needed.
  // Each faucet response gives 5 × 200 SUI coins; one call is sufficient.
  const publisherAddr = spawnSync("sui", ["client", "active-address"], {
    encoding: "utf8",
  }).stdout.trim();
  console.log(`funding publisher wallet ${publisherAddr}…`);
  await requestSuiFromFaucetV2({
    host: getFaucetHost("localnet"),
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
    packageId = publishPackage(chainId);
  } catch (err) {
    if (hostSuiProc) hostSuiProc.kill();
    throw err;
  }

  console.log(`funding settler + ${n} bench keys…`);
  let settler: FundedKey;
  let keys: FundedKey[];
  try {
    [settler] = await fundKeys(client, 1);
    keys = await fundKeys(client, n);
  } catch (err) {
    if (hostSuiProc) hostSuiProc.kill();
    throw err;
  }

  writeFileSync(
    new URL("../keys.json", import.meta.url),
    JSON.stringify(keys, null, 2),
  );
  writeEnvLocal({
    SUI_RPC_URL: RPC,
    SUI_NETWORK: RPC,
    TUNNEL_PACKAGE_ID: packageId,
    PACKAGE_ID: packageId,
    SUI_SETTLER_KEY: settler.secretKey,
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
