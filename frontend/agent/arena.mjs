// frontend/agent/arena.mjs
// Arena auto-pilot: drive the REAL desktop UI into bot-vs-bot auto-play for ttt + blackjack.
// Injects a programmatic wallet via ?arena&key=, opens both windows, funds from wallet ONLY if
// the Start/Auto control is disabled (unfunded), starts auto-play, runs for a duration.
// Run: KEY=suiprivkey1… DURATION_MS=60000 node agent/arena.mjs
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const KEY = process.env.KEY;
if (!KEY) throw new Error("set KEY=<suiprivkey1…> (a funded testnet wallet secret)");
const GAMES = (process.env.GAMES ?? "ttt,blackjack").split(",").map((s) => s.trim());
const DURATION = Number(process.env.DURATION_MS ?? 60_000);
const HEADLESS = process.env.HEADLESS === "true";

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

/** Open a game window from the command palette. */
async function launch(gameId) {
  await page.getByTestId("add-game").click();
  await page.getByTestId(`launch-${gameId}`).click();
}

/** Fund from wallet only if `startTestId` is disabled (unfunded), then wait for it to enable. */
async function fundIfLow(fundTestId, startTestId) {
  const start = page.getByTestId(startTestId);
  await start.waitFor({ state: "visible", timeout: 20_000 });
  if (await start.isDisabled()) {
    console.log(`[arena] ${startTestId} disabled → funding from wallet`);
    await page.getByTestId(fundTestId).click();
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
  await launch("tic-tac-toe");
  await page.getByTestId("ttt-tab-bots").click();           // bot-vs-bot funding tab
  await fundIfLow("ttt-fund-wallet", "ttt-start");
  await page.getByTestId("ttt-start").click();
  console.log("[arena] ttt auto-play started");
}
if (GAMES.includes("blackjack")) {
  await launch("blackjack");
  await page.getByTestId("bj-watch-bots").click();          // → PlayerBot (bot-vs-bot)
  await fundIfLow("bj-fund-wallet", "bj-auto");
  await page.getByTestId("bj-auto").click();
  console.log("[arena] blackjack auto-play started");
}

console.log(`[arena] running ${GAMES.join(" + ")} for ${DURATION / 1000}s…`);
await page.waitForTimeout(DURATION);
console.log("[arena] done");
await browser.close();
process.exit(0);
