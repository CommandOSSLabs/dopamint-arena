// Launch K agent contexts against the dev page with bare ?agent, run for a duration, and count
// completed (settled) tunnels — a ramp / throughput observation. Anti-throttle flags are REQUIRED
// or background contexts idle (spec §5).
// Run: BASE_URL=http://localhost:5173 K=10 TIMEOUT_MS=60000 node agent/runAgents.mjs
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const agentDir = fileURLToPath(new URL(".", import.meta.url));

function normalizeKeys(raw) {
  if (!Array.isArray(raw)) throw new Error("agent keys must be an array");
  const keys = raw.map((entry) =>
    typeof entry === "string" ? { secretKey: entry } : entry,
  );
  for (const [i, key] of keys.entries()) {
    if (!key?.secretKey || typeof key.secretKey !== "string") {
      throw new Error(`agent key ${i} is missing secretKey`);
    }
  }
  if (keys.length === 0) throw new Error("provide at least one agent key");
  return keys;
}

function readAgentKeys() {
  const inline = process.env.AGENT_KEYS?.trim();
  if (inline) {
    if (inline.startsWith("[")) return normalizeKeys(JSON.parse(inline));
    return normalizeKeys(inline.split(/[\s,]+/).filter(Boolean));
  }

  const keysFile = process.env.AGENT_KEYS_FILE ?? "keys.json";
  const keysPath = isAbsolute(keysFile)
    ? keysFile
    : resolve(agentDir, keysFile);
  if (!existsSync(keysPath)) {
    throw new Error(
      `missing ${keysPath}; run fundTreasury.mjs or set AGENT_KEYS/AGENT_KEYS_FILE`,
    );
  }
  return normalizeKeys(JSON.parse(readFileSync(keysPath, "utf8")));
}

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const keys = readAgentKeys();
const K = Number(process.env.K ?? 2);
const M = Number(process.env.M ?? 1); // concurrent tunnel slots per agent (multiplexed)
const DURATION = Number(process.env.TIMEOUT_MS ?? 60_000);
const GAME = process.env.GAME ?? "";

const browser = await chromium.launch({
  headless: true,
  args: [
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
  ],
});

let settleCount = 0;
const settledAgents = new Set();
for (let i = 0; i < K; i++) {
  const page = await (await browser.newContext()).newPage();
  page.on("console", (m) => {
    const t = m.text();
    if (t.includes("[agentstatus]") && t.includes(":settled:")) {
      settleCount++;
      settledAgents.add(i);
    } else if (/fatal|PAGEERROR|HTTP [45]\d\d/i.test(t)) {
      console.log(`[agent ${i}] ${t}`);
    }
  });
  page.on("pageerror", (e) =>
    console.log(`[agent ${i}] PAGEERROR ${e.message}`),
  );
  const url = new URL(BASE);
  url.searchParams.set("agent", "");
  url.searchParams.set("m", String(M));
  url.searchParams.set("key", keys[i % keys.length].secretKey);
  if (GAME) url.searchParams.set("game", GAME);
  await page.goto(url.toString());
}

const start = Date.now();
while (Date.now() - start < DURATION) {
  await new Promise((r) => setTimeout(r, 5000));
  const s = Math.round((Date.now() - start) / 1000);
  console.log(
    `[t+${s}s] settled tunnels: ${settleCount} | distinct agents settled: ${settledAgents.size}/${K}`,
  );
}
const secs = (Date.now() - start) / 1000;
console.log(
  `DONE: ${K} agents | ${settleCount} tunnels settled in ${secs.toFixed(0)}s | ~${(settleCount / secs).toFixed(2)} tunnels/s | distinct ${settledAgents.size}/${K}`,
);
await browser.close();
process.exit(settledAgents.size >= Math.min(2, K) ? 0 : 1);
