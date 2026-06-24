/**
 * End-to-end smoke test for the chat window's two modes.
 *
 * 1. Starts a tiny /v1/chat proxy that forwards to local Ollama.
 * 2. Starts the Vite dev server pointed at that proxy.
 * 3. Opens Chromium with the dev-wallet key so a real testnet account signs
 *    the tunnel open/close transactions.
 * 4. Removes any seeded windows, opens the AI Chat window, and verifies:
 *    - Mode 1 (human ↔ LLM): a user message gets an assistant reply.
 *    - Mode 2 (AI vs AI): starting a debate produces exchanges and a Stop button.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chromium, type Page, type Locator } from "playwright";

const PROXY_PORT = 8080;
const FRONTEND_URL = "http://localhost:5173";
const OLLAMA_URL = "http://localhost:11434";
const TUNNEL_PACKAGE_ID =
  "0x3def9b94f239b11cf893852953ff54ed8f8b2f7450aee921125b400e1b9f080c";

// A second funded wallet so Mode 2 doesn't reuse coins locked by Mode 1.
const MODE2_DEV_KEY =
  process.env.MODE2_DEV_KEY ||
  "suiprivkey1qpjdzn0kxzy5prnr7dnlfwss8apu0zrvzzuumh04h2dcph2jpp7vwxekd9x";

const children: ChildProcess[] = [];

function killAll() {
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
}

function runUntilReady(
  cmd: string,
  args: string[],
  env: Record<string, string>,
  readyText: string,
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);

    let resolved = false;
    const doResolve = () => {
      if (!resolved) {
        resolved = true;
        resolve(child);
      }
    };

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
      if (stdout.includes(readyText) || stderr.includes(readyText)) doResolve();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
      if (stderr.includes(readyText)) doResolve();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0 && code !== null && !resolved) {
        reject(new Error(`Process exited ${code}.\n${stdout}\n${stderr}`));
      }
    });

    // Failsafe: resolve after a few seconds even if ready text wasn't seen.
    setTimeout(doResolve, 8000);
  });
}

async function waitForHttp(url: string, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.status < 500) return;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function getDevKey(): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("sui", ["keytool", "export", "--key-identity", "millionaire-wallet", "--json"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    proc.stdout?.on("data", (d) => (out += d.toString()));
    proc.stderr?.on("data", (d) => (err += d.toString()));
    proc.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`sui keytool export failed: ${err}`));
      try {
        const json = JSON.parse(out);
        const key = String(json.exportedPrivateKey).trim();
        resolve(key);
      } catch (e) {
        reject(e);
      }
    });
  });
}

function chatWindow(page: Page): Locator {
  // Locate the desktop window whose title bar reads "AI Chat".
  return page.locator('div[data-window]').filter({ has: page.locator('header', { hasText: 'AI Chat' }) });
}

async function removeAllWindows(page: Page) {
  await page.locator('button[aria-label="Layout tools"]').click();
  await page.getByText('Remove all').first().click();
  await page.getByRole('button', { name: 'Remove all' }).last().click();
  await page.waitForSelector('text=No games on the floor.');
}

async function addChatWindow(page: Page) {
  await page.locator('button[aria-label="Add game"]').click();
  await page.locator('[cmdk-input]').fill('AI Chat');
  await page.getByRole('option', { name: /AI Chat/ }).click();
  await chatWindow(page).waitFor({ state: 'visible' });
}

async function runMode1Chat(page: Page) {
  const win = chatWindow(page);
  await win.getByRole('button', { name: 'Chat with AI' }).click();

  const input = win.locator('input[placeholder="Type a message..."]');
  await input.waitFor({ state: 'visible' });
  await input.fill('Say a one-word greeting.');
  await input.press('Enter');

  // Wait for the assistant reply to appear (2 transcript entries).
  const transcript = win.locator('div.space-y-3 > div');
  await transcript.nth(1).waitFor({ state: 'visible', timeout: 60000 });
  const assistantText = await transcript.nth(1).innerText();
  console.log('[e2e] Mode 1 assistant reply:', assistantText.trim());
}

async function runMode2Debate(page: Page, targetExchanges: number) {
  await removeAllWindows(page);
  await addChatWindow(page);

  const win = chatWindow(page);
  await win.getByRole('button', { name: 'AI vs AI' }).click();
  await win.getByRole('button', { name: 'Start AI Debate' }).click();

  // Wait for the exchange counter to appear and advance.
  const counter = win.locator('text=/Exchange \\d+ /');
  await counter.waitFor({ state: 'visible', timeout: 120000 });
  let text = await counter.innerText();
  console.log('[e2e] Mode 2 counter:', text.trim());

  // Wait for the target exchange count (or higher) before stopping so the
  // loop visibly runs and then ends.
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    const t = await counter.innerText().catch(() => "");
    const match = t.match(/Exchange\s+(\d+)/);
    if (match && Number(match[1]) >= targetExchanges) break;
    await page.waitForTimeout(500);
  }
  text = await counter.innerText();
  console.log('[e2e] Mode 2 reached', text.trim());

  await win.getByRole('button', { name: 'Stop' }).click();
  // After stopping, the Start button returns and the conversation is over.
  await win.getByRole('button', { name: 'Start AI Debate' }).waitFor({
    state: 'visible',
    timeout: 60000,
  });
}

async function main() {
  const devKey = await getDevKey();
  console.log('[e2e] dev wallet ready');

  const proxy = await runUntilReady(
    "npx",
    ["tsx", "scripts/chat-e2e-proxy.ts"],
    { PORT: String(PROXY_PORT), OLLAMA_URL },
    "listening",
  );
  console.log('[e2e] proxy started');

  const vite = await runUntilReady(
    "npx",
    ["vite", "--port", "5173"],
    {
      BACKEND_URL: `http://localhost:${PROXY_PORT}`,
      VITE_TUNNEL_PACKAGE_ID: TUNNEL_PACKAGE_ID,
      VITE_DEBATE_EXCHANGE_TARGET: "3",
    },
    "ready in",
  );
  console.log('[e2e] vite started');

  await waitForHttp(`${FRONTEND_URL}/`);

  const browser = await chromium.launch({ headless: true });

  let failed = false;
  let mode1Page: Page | null = null;
  let mode2Page: Page | null = null;
  try {
    // Mode 1: human ↔ LLM chat.
    const ctx1 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    mode1Page = await ctx1.newPage();
    await mode1Page.goto(`${FRONTEND_URL}/?devKey=${encodeURIComponent(devKey)}`);
    await mode1Page.getByRole('button', { name: /0x9826/ }).first().waitFor({ state: 'visible', timeout: 30000 });
    console.log('[e2e] Mode 1 wallet connected');

    await removeAllWindows(mode1Page);
    await addChatWindow(mode1Page);

    console.log('[e2e] running Mode 1: human ↔ LLM chat');
    await runMode1Chat(mode1Page);

    // Mode 2: AI vs AI debate, using a separate wallet to avoid coin-version conflicts.
    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    mode2Page = await ctx2.newPage();
    await mode2Page.goto(`${FRONTEND_URL}/?devKey=${encodeURIComponent(MODE2_DEV_KEY)}`);
    await mode2Page.getByRole('button', { name: /0xa3f9/ }).first().waitFor({ state: 'visible', timeout: 30000 });
    console.log('[e2e] Mode 2 wallet connected');

    console.log('[e2e] running Mode 2: AI vs AI debate');
    await runMode2Debate(mode2Page, 3);

    console.log('[e2e] all checks passed');
  } catch (e) {
    failed = true;
    console.error('[e2e] failed:', e);
    const page = mode2Page ?? mode1Page;
    if (page) await page.screenshot({ path: 'chat-e2e-failure.png', fullPage: true });
  } finally {
    await browser.close();
    proxy.kill();
    vite.kill();
    killAll();
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
