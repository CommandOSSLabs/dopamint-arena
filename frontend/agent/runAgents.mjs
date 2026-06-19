// Launch K agent contexts against the dev page with bare ?agent (rotation = tic-tac-toe only
// for now, §AGENT_GAMES), run for a duration, and count completed (settled) tunnels — a ramp /
// throughput observation. Anti-throttle flags are REQUIRED or background contexts idle (spec §5).
// Run: BASE_URL=http://localhost:5074 K=10 TIMEOUT_MS=60000 node agent/runAgents.mjs
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:5074";
const keys = JSON.parse(readFileSync(new URL("./keys.json", import.meta.url)));
const K = Number(process.env.K ?? 2);
const M = Number(process.env.M ?? 1); // concurrent tunnel slots per agent (multiplexed)
const DURATION = Number(process.env.TIMEOUT_MS ?? 60_000);

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
  page.on("pageerror", (e) => console.log(`[agent ${i}] PAGEERROR ${e.message}`));
  await page.goto(`${BASE}/?agent&m=${M}&key=${encodeURIComponent(keys[i % keys.length].secretKey)}`);
}

const start = Date.now();
while (Date.now() - start < DURATION) {
  await new Promise((r) => setTimeout(r, 5000));
  const s = Math.round((Date.now() - start) / 1000);
  console.log(`[t+${s}s] settled tunnels: ${settleCount} | distinct agents settled: ${settledAgents.size}/${K}`);
}
const secs = (Date.now() - start) / 1000;
console.log(
  `DONE: ${K} agents | ${settleCount} tunnels settled in ${secs.toFixed(0)}s | ~${(settleCount / secs).toFixed(2)} tunnels/s | distinct ${settledAgents.size}/${K}`,
);
await browser.close();
process.exit(settledAgents.size >= Math.min(2, K) ? 0 : 1);
