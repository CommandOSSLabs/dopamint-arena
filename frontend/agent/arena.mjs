// frontend/agent/arena.mjs
// Arena auto-pilot: drive the REAL desktop UI into bot-vs-bot auto-play for ttt + blackjack.
// Injects a programmatic wallet via ?arena&key=, opens N windows per game, optionally sets
// matches-per-tunnel, funds from wallet ONLY if the Start/Auto control is disabled (unfunded),
// starts auto-play, runs for a duration.
// Run: KEY=suiprivkey1… DURATION_MS=60000 node agent/arena.mjs
// Env:
//   KEY          required  funded testnet wallet secret key
//   BASE_URL     optional  default http://localhost:5173
//   GAMES        optional  default "ttt,blackjack"  comma-separated
//   DURATION_MS  optional  default 60000
//   HEADLESS     optional  default false ("true" to run headless)
//   TTT_WINDOWS  optional  number of concurrent ttt windows (default 1)
//   BJ_WINDOWS   optional  number of concurrent blackjack windows (default 1)
//   TTT_MAX_GAMES  optional  fill ttt-max-games input if set
//   BJ_MAX_ROUNDS  optional  selectOption on bj-max-rounds if set
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const KEY = process.env.KEY;
if (!KEY) throw new Error("set KEY=<suiprivkey1…> (a funded testnet wallet secret)");
const GAMES = (process.env.GAMES ?? "ttt,blackjack").split(",").map((s) => s.trim());
const DURATION = Number(process.env.DURATION_MS ?? 60_000);
const HEADLESS = process.env.HEADLESS === "true";

const TTT_WINDOWS = Math.max(1, Number(process.env.TTT_WINDOWS ?? 1));
const BJ_WINDOWS = Math.max(1, Number(process.env.BJ_WINDOWS ?? 1));
const TTT_MAX_GAMES = process.env.TTT_MAX_GAMES ? String(process.env.TTT_MAX_GAMES) : null;
const BJ_MAX_ROUNDS = process.env.BJ_MAX_ROUNDS ? String(process.env.BJ_MAX_ROUNDS) : null;

const browser = await chromium.launch({
  headless: HEADLESS,
  args: [
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
  ],
});
const page = await (await browser.newContext()).newPage();
page.on("pageerror", (e) => console.log(`PAGEERROR ${e.message}`));

await page.goto(`${BASE}/?arena&key=${encodeURIComponent(KEY)}`);
// Wallet connected when the desktop dock renders the add-game button.
await page.getByTestId("add-game").waitFor({ state: "visible", timeout: 30_000 });
console.log("[arena] wallet connected, desktop ready");

/**
 * Open n windows for gameId one at a time, waiting for each to appear before
 * clicking the palette again — avoids racing the palette open/close animation.
 */
async function launchWindows(gameId, n) {
  const sel = `[data-game-window^="${gameId}"]`;
  const base = await page.locator(sel).count();
  for (let i = 0; i < n; i++) {
    await page.getByTestId("add-game").click();
    await page.getByTestId(`launch-${gameId}`).click();
    await waitForWindowCount(sel, base + i + 1);
  }
}

/**
 * Poll until the count of windows matching the CSS selector reaches `target`.
 * Avoids test-runner expect/toHaveCount — plain Playwright API only.
 */
async function waitForWindowCount(sel, target, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await page.locator(sel).count();
    if (count >= target) return;
    await page.waitForTimeout(300);
  }
  throw new Error(`timeout waiting for ${target} windows matching ${sel}`);
}

/**
 * Fund from wallet only if `startLocator` (scoped to window) is disabled (unfunded),
 * then wait for it to enable.
 */
async function fundIfLow(win, fundTestId, startTestId) {
  const start = win.getByTestId(startTestId);
  await start.waitFor({ state: "visible", timeout: 20_000 });
  if (await start.isDisabled()) {
    console.log(`[arena] ${startTestId} disabled → funding from wallet`);
    await win.getByTestId(fundTestId).click();
    await start.waitFor({ state: "visible" });
    // Poll until the start control enables (balance landed) or time out.
    for (let i = 0; i < 40 && (await start.isDisabled()); i++) {
      await page.waitForTimeout(1500);
    }
  } else {
    console.log(`[arena] ${startTestId} already funded`);
  }
}

if (GAMES.includes("ttt")) {
  const sel = '[data-game-window^="tic-tac-toe"]';
  // Open all windows first, confirming each before the next.
  await launchWindows("tic-tac-toe", TTT_WINDOWS);
  console.log(`[arena] ${TTT_WINDOWS} ttt window(s) open`);

  // Configure and start each window.
  for (let i = 0; i < TTT_WINDOWS; i++) {
    const win = page.locator(sel).nth(i);
    await win.getByTestId("ttt-tab-bots").click();
    if (TTT_MAX_GAMES !== null) {
      await win.getByTestId("ttt-max-games").fill(TTT_MAX_GAMES);
    }
    await fundIfLow(win, "ttt-fund-wallet", "ttt-start");
    await win.getByTestId("ttt-start").click();
    console.log(`[arena] ttt window ${i} auto-play started`);
  }
}

if (GAMES.includes("blackjack")) {
  const sel = '[data-game-window^="blackjack"]';
  // Open all windows first, confirming each before the next.
  await launchWindows("blackjack", BJ_WINDOWS);
  console.log(`[arena] ${BJ_WINDOWS} blackjack window(s) open`);

  // Configure and start each window.
  for (let i = 0; i < BJ_WINDOWS; i++) {
    const win = page.locator(sel).nth(i);
    await win.getByTestId("bj-watch-bots").click();
    if (BJ_MAX_ROUNDS !== null) {
      await win.getByTestId("bj-max-rounds").selectOption(BJ_MAX_ROUNDS);
    }
    await fundIfLow(win, "bj-fund-wallet", "bj-auto");
    await win.getByTestId("bj-auto").click();
    console.log(`[arena] blackjack window ${i} auto-play started`);
  }
}

console.log(`[arena] running ${GAMES.join(" + ")} for ${DURATION / 1000}s…`);
await page.waitForTimeout(DURATION);
console.log("[arena] done");
await browser.close();
process.exit(0);
