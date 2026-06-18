// Launch K agent contexts against the dev page with bare ?agent (all-games rotation).
// Anti-throttle flags are REQUIRED or background contexts idle (spec §5).
// Run: BASE_URL=http://localhost:5074 K=2 node agent/runAgents.mjs
// The 2-context proof: both agents start their rotation at game[0] (tic-tac-toe), so they
// share a queue and match each other; assert both reach a "settled" status.
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:5074";
const keys = JSON.parse(readFileSync(new URL("./keys.json", import.meta.url)));
const K = Number(process.env.K ?? 2);

const browser = await chromium.launch({
  headless: true,
  args: [
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
  ],
});

const settledAgents = new Set(); // tracked from console events (no DOM-poll race)
const pages = [];
for (let i = 0; i < K; i++) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("console", (m) => {
    const t = m.text();
    console.log(`[agent ${i}] ${t}`);
    if (t.includes("[agentstatus]") && t.includes(":settled:")) settledAgents.add(i);
  });
  page.on("pageerror", (e) => console.log(`[agent ${i}] PAGEERROR ${e.message}`));
  page.on("response", (r) => {
    if (r.status() >= 400) console.log(`[agent ${i}] HTTP ${r.status()} ${r.request().method()} ${r.url()}`);
  });
  await page.goto(`${BASE}/?agent&key=${encodeURIComponent(keys[i].secretKey)}`);
  pages.push(page);
}

const TIMEOUT = Number(process.env.TIMEOUT_MS ?? 90_000);
const need = Math.min(2, K);
const deadline = Date.now() + TIMEOUT;
while (Date.now() < deadline && settledAgents.size < need) {
  await new Promise((r) => setTimeout(r, 500));
}
const ok = settledAgents.size >= need;
console.log(`settled agents: ${settledAgents.size}/${need} -> ${ok ? "PASS" : "FAIL"}`);
await browser.close();
process.exit(ok ? 0 : 1);
