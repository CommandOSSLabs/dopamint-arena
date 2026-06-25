# Arena Auto-Pilot (Playwright UI bot, ttt + blackjack) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A one-command Playwright bot that drives the real Dopamint desktop into bot-vs-bot auto-play for tic-tac-toe and blackjack, funding the in-game bots from the wallet only when they're low.

**Architecture:** Two parts. (1) Frontend: extract `AgentBoot`'s programmatic-wallet injection into a reusable `ProgrammaticWalletGate`, add an `?arena` mode that renders the normal `<App/>` desktop with an injected wallet, and add `data-testid`s to the controls the bot clicks. (2) `frontend/agent/arena.mjs`: a Playwright script that opens both game windows, selects bot-vs-bot, funds-from-wallet only if the Start/Auto control is disabled (unfunded), starts auto-play, runs for a duration, and reports.

**Tech Stack:** React + `@tanstack/react-router`, `@mysten/dapp-kit` + `@mysten/wallet-standard`, Playwright, `node:test` via `tsx`, pnpm.

## Global Constraints

- **No faucet.** The bot funds via the wallet (`fundFromWallet` → `buildFundTx`) and only when a bot is low; never the testnet faucet.
- **Wallet injection is gated** strictly on `?arena` + a provided `key`; normal users (no params) and `?agent` are unaffected.
- **Scope: ttt + blackjack only.** No battleship/quantum-poker. The `?agent`/`AgentRunner`/`runAgents.mjs` path is unchanged.
- **`data-testid` contract** (Part 1 adds these; Part 2 selects by them):
  - `add-game` — desktop "+" launcher button
  - `launch-tic-tac-toe`, `launch-blackjack` — command-palette game entries (`launch-${g.id}`)
  - `ttt-tab-bots`, `ttt-fund-wallet`, `ttt-start` — ttt setup controls
  - `bj-watch-bots`, `bj-fund-wallet`, `bj-auto` — blackjack bot-arena controls
- **No AI attribution in commits.** Conventional Commits, ≤50 char subject. Targeted `git add` only (never `-A`); leave untracked framework files + `report.json` alone.
- **Test runner:** `cd frontend && pnpm exec node --import tsx --test <file>` (single), `pnpm test` (suite). tsc: `./node_modules/.bin/tsc --noEmit`.

---

## File structure

**Create:**

- `frontend/src/agent/ProgrammaticWalletGate.tsx` — reusable wallet-injection wrapper.
- `frontend/agent/arena.mjs` — the Playwright arena bot.

**Modify:**

- `frontend/src/agent/agentConfig.ts` (+ `agentConfig.test.ts`) — parse `arena`.
- `frontend/src/agent/AgentBoot.tsx` — re-use the gate (no behavior change).
- `frontend/src/main.tsx` — `?arena` branch renders `<App/>` inside the gate.
- `frontend/src/desktop/Desktop.tsx` — testids on `add-game` + `launch-${g.id}`.
- `frontend/src/games/ticTacToe/app/scenes/SetupScene.tsx` — testids on Bots tab + Start.
- `frontend/src/games/ticTacToe/app/components/BotPanel.tsx` — testid on fund button.
- `frontend/src/games/blackjack/app/pages/Home.tsx` — testid on "Watch Bot Arena".
- `frontend/src/games/blackjack/app/pages/PlayerBot.tsx` — testids on fund + Auto.
- `frontend/agent/README.md` — document the arena bot.

---

## Task 1: Parse the `arena` flag

**Files:**

- Modify: `frontend/src/agent/agentConfig.ts`
- Test: `frontend/src/agent/agentConfig.test.ts`

**Interfaces:**

- Produces: `AgentConfig` gains `arena: boolean`. `parseAgentConfig(href)` sets `arena = ?arena present`, reusing the existing `secretKey` (`?key`).

- [ ] **Step 1: Write the failing test** (append to `agentConfig.test.ts`)

```ts
import { parseAgentConfig } from "./agentConfig";
it("parses ?arena with a key and leaves ?agent off", () => {
  const c = parseAgentConfig("http://x/?arena&key=suiprivkey1abc");
  assert.strictEqual(c.arena, true);
  assert.strictEqual(c.enabled, false); // not agent mode
  assert.strictEqual(c.secretKey, "suiprivkey1abc");
});
it("arena defaults false with no param", () => {
  assert.strictEqual(parseAgentConfig("http://x/").arena, false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && pnpm exec node --import tsx --test src/agent/agentConfig.test.ts`
Expected: FAIL — `arena` is `undefined` / not on `AgentConfig`.

- [ ] **Step 3: Implement**

```ts
// agentConfig.ts — add `arena` to the interface and parser
export interface AgentConfig {
  enabled: boolean;
  arena: boolean;
  secretKey: string | null;
  concurrency: number;
}
export function parseAgentConfig(href: string): AgentConfig {
  const p = new URL(href).searchParams;
  return {
    enabled: p.get("agent") !== null,
    arena: p.get("arena") !== null,
    secretKey: p.get("key"),
    concurrency: Math.max(1, Number(p.get("m") ?? "1")),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && pnpm exec node --import tsx --test src/agent/agentConfig.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/agent/agentConfig.ts frontend/src/agent/agentConfig.test.ts
git commit -m "feat(agent): parse ?arena flag"
```

## Task 2: Reusable wallet gate + `?arena` desktop mode

**Files:**

- Create: `frontend/src/agent/ProgrammaticWalletGate.tsx`
- Modify: `frontend/src/agent/AgentBoot.tsx`, `frontend/src/main.tsx`

**Interfaces:**

- Consumes: `AgentConfig.arena`/`secretKey` (Task 1), existing `programmaticWalletFromSecret`.
- Produces: `<ProgrammaticWalletGate secretKey={string|null}>` — registers + connects the programmatic wallet, renders children once an account exists. `?arena&key=` renders `<App/>` inside it.

- [ ] **Step 1: Create the gate** (extracted verbatim from `AgentBoot`'s logic)

```tsx
// frontend/src/agent/ProgrammaticWalletGate.tsx
import { useEffect, useRef, type ReactNode } from "react";
import { getWallets } from "@mysten/wallet-standard";
import {
  useConnectWallet,
  useCurrentAccount,
  useSuiClient,
} from "@mysten/dapp-kit";
import { programmaticWalletFromSecret } from "../wallet/programmaticWallet";

/** Registers a programmatic wallet from `secretKey` with the Wallet Standard and connects it
 *  once (dapp-kit autoConnect can't pick an unseen wallet on first load), then renders children.
 *  Shared by ?agent (headless) and ?arena (desktop UI under automation). */
export function ProgrammaticWalletGate({
  secretKey,
  children,
}: {
  secretKey: string | null;
  children: ReactNode;
}) {
  const client = useSuiClient();
  const account = useCurrentAccount();
  const { mutate: connect } = useConnectWallet();
  const tried = useRef(false);
  useEffect(() => {
    if (!secretKey || tried.current) return;
    tried.current = true;
    const wallet = programmaticWalletFromSecret(secretKey, client);
    getWallets().register(wallet as never);
    connect({ wallet: wallet as never });
  }, [client, connect, secretKey]);
  if (!account) return <div data-agent="connecting">connecting…</div>;
  return <>{children}</>;
}
```

- [ ] **Step 2: Make `AgentBoot` use the gate** (no behavior change for `?agent`)

```tsx
// frontend/src/agent/AgentBoot.tsx — replace the body with:
import { type ReactNode } from "react";
import { parseAgentConfig } from "./agentConfig";
import { ProgrammaticWalletGate } from "./ProgrammaticWalletGate";

export function AgentBoot({ children }: { children: ReactNode }) {
  const cfg = parseAgentConfig(window.location.href);
  return (
    <ProgrammaticWalletGate secretKey={cfg.secretKey}>
      {children}
    </ProgrammaticWalletGate>
  );
}
```

- [ ] **Step 3: Add the `?arena` branch in `main.tsx`**

```tsx
// main.tsx — imports
import { ProgrammaticWalletGate } from "./agent/ProgrammaticWalletGate";
// ...
const cfg = parseAgentConfig(window.location.href);
// render:
{
  cfg.enabled ? (
    <AgentBoot>
      <AgentRunner />
    </AgentBoot>
  ) : cfg.arena ? (
    <ProgrammaticWalletGate secretKey={cfg.secretKey}>
      <App />
    </ProgrammaticWalletGate>
  ) : (
    <App />
  );
}
```

- [ ] **Step 4: Verify build**

Run: `cd frontend && ./node_modules/.bin/tsc --noEmit`
Expected: exit 0 (no new errors). Manually: `?agent` still renders the headless runner; `?arena&key=…` renders the desktop after connecting (a real wallet key is exercised in Task 5).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/agent/ProgrammaticWalletGate.tsx frontend/src/agent/AgentBoot.tsx frontend/src/main.tsx
git commit -m "feat(agent): inject wallet into desktop via ?arena"
```

## Task 3: `data-testid`s on the arena controls

**Files (add one attribute each — do not change logic/text):**

- `frontend/src/desktop/Desktop.tsx`: the "+" Add-game button → `data-testid="add-game"`; the command item → `data-testid={`launch-${g.id}`}` (yields `launch-tic-tac-toe`, `launch-blackjack`).
- `frontend/src/games/ticTacToe/app/scenes/SetupScene.tsx`: the **Bots** tab button → `data-testid="ttt-tab-bots"`; the **Start playing** button → `data-testid="ttt-start"`.
- `frontend/src/games/ticTacToe/app/components/BotPanel.tsx`: the **Fund bots from wallet** button → `data-testid="ttt-fund-wallet"`.
- `frontend/src/games/blackjack/app/pages/Home.tsx`: the **Watch Bot Arena** button → `data-testid="bj-watch-bots"`.
- `frontend/src/games/blackjack/app/pages/PlayerBot.tsx`: the wallet **Top Up SUI** button → `data-testid="bj-fund-wallet"`; the **Auto** button → `data-testid="bj-auto"`.

**Interfaces:**

- Produces: the testid contract in Global Constraints. The Start (`ttt-start`) and Auto (`bj-auto`) buttons keep their existing `disabled` when unfunded — the script reads that to decide whether to fund.

- [ ] **Step 1: Add each `data-testid`** at the exact elements above (read each file; attach the attribute to the existing `<button>`/`CommandItem`, leaving `onClick`, text, and `disabled` untouched).
- [ ] **Step 2: Verify build**: `cd frontend && ./node_modules/.bin/tsc --noEmit` → exit 0.
- [ ] **Step 3: Grep-verify the contract is present**

Run:

```bash
cd frontend && grep -rl "add-game\|launch-\${g.id}\|ttt-tab-bots\|ttt-fund-wallet\|ttt-start\|bj-watch-bots\|bj-fund-wallet\|bj-auto" src | sort -u
```

Expected: the 5 modified files listed.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/desktop/Desktop.tsx frontend/src/games/ticTacToe/app/scenes/SetupScene.tsx frontend/src/games/ticTacToe/app/components/BotPanel.tsx frontend/src/games/blackjack/app/pages/Home.tsx frontend/src/games/blackjack/app/pages/PlayerBot.tsx
git commit -m "test(ui): add data-testids for arena bot"
```

## Task 4: The `arena.mjs` Playwright bot

**Files:**

- Create: `frontend/agent/arena.mjs`

**Interfaces:**

- Consumes: the `?arena&key=` mode (Task 2) + the testid contract (Task 3).
- Produces: a runnable script. Env: `KEY` (required), `GAMES=ttt,blackjack`, `DURATION_MS=60000`, `HEADLESS=false`, `BASE_URL=http://localhost:5173`.

- [ ] **Step 1: Write the script** (mirrors `runAgents.mjs`'s launch + anti-throttle)

```js
// frontend/agent/arena.mjs
// Arena auto-pilot: drive the REAL desktop UI into bot-vs-bot auto-play for ttt + blackjack.
// Injects a programmatic wallet via ?arena&key=, opens both windows, funds from wallet ONLY if
// the Start/Auto control is disabled (unfunded), starts auto-play, runs for a duration.
// Run: KEY=suiprivkey1… DURATION_MS=60000 node agent/arena.mjs
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const KEY = process.env.KEY;
if (!KEY)
  throw new Error("set KEY=<suiprivkey1…> (a funded testnet wallet secret)");
const GAMES = (process.env.GAMES ?? "ttt,blackjack")
  .split(",")
  .map((s) => s.trim());
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
await page
  .getByTestId("add-game")
  .waitFor({ state: "visible", timeout: 30_000 });
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
  await page.getByTestId("ttt-tab-bots").click(); // bot-vs-bot funding tab
  await fundIfLow("ttt-fund-wallet", "ttt-start");
  await page.getByTestId("ttt-start").click();
  console.log("[arena] ttt auto-play started");
}
if (GAMES.includes("blackjack")) {
  await launch("blackjack");
  await page.getByTestId("bj-watch-bots").click(); // → PlayerBot (bot-vs-bot)
  await fundIfLow("bj-fund-wallet", "bj-auto");
  await page.getByTestId("bj-auto").click();
  console.log("[arena] blackjack auto-play started");
}

console.log(`[arena] running ${GAMES.join(" + ")} for ${DURATION / 1000}s…`);
await page.waitForTimeout(DURATION);
console.log("[arena] done");
await browser.close();
process.exit(0);
```

- [ ] **Step 2: Lint-parse the script** (no test harness; just ensure it parses)

Run: `cd frontend && node --check agent/arena.mjs`
Expected: no output (valid syntax).

- [ ] **Step 3: Commit**

```bash
git add frontend/agent/arena.mjs
git commit -m "feat(agent): arena ui auto-pilot for ttt + blackjack"
```

## Task 5: Smoke-verify + document

**Files:**

- Modify: `frontend/agent/README.md`

**Interfaces:** consumes Tasks 1–4. This is a manual/CI smoke (like `runAgents.mjs`), not a unit test.

- [ ] **Step 1: Document** — add an "Arena auto-pilot" section to `agent/README.md`:

````markdown
3. **Arena auto-pilot** — drive the real desktop into bot-vs-bot auto-play (ttt + blackjack),
   funding bots from the wallet only when low (no faucet):

   ```bash
   KEY=$(sui keytool export --key-identity "$(sui client active-address)" --json | jq -r .exportedPrivateKey) \
     DURATION_MS=60000 node agent/arena.mjs
   # HEADLESS=true to hide the browser; GAMES=ttt or GAMES=blackjack to run one.
   ```

   Requires the dev server up (`BASE_URL`, default :5173) and the `KEY` wallet funded on testnet.
````

- [ ] **Step 2: Smoke run** (requires dev server on :5173 + a funded `KEY`)

Run: `cd frontend && KEY=<funded suiprivkey> DURATION_MS=10000 HEADLESS=true node agent/arena.mjs`
Expected: logs `wallet connected`, `ttt auto-play started`, `blackjack auto-play started`, `done`; exit 0. (If a `KEY`/funding isn't available in this environment, capture the failure point and report — do not fake success.)

- [ ] **Step 3: Commit**

```bash
git add frontend/agent/README.md
git commit -m "docs(agent): document arena auto-pilot"
```

---

## Self-review (coverage map)

- Spec Part 1 (desktop wallet injection) → Tasks 1–2. Stable selectors → Task 3.
- Spec Part 2 (`arena.mjs`: open both → bot-vs-bot → fund-if-low → start → duration) → Task 4.
- "Fund only when low / no faucet" → `fundIfLow` keys off the Start/Auto `disabled` state and clicks `*-fund-wallet` (never the faucet button) — Task 4.
- Testing (selector smoke + agentConfig unit) → Tasks 1, 5.
- Non-goals (battleship/poker, `?agent` unchanged) honored: only the listed files change; `AgentBoot` keeps `?agent` behavior via the extracted gate.

**Note for the executor:** Task 3 attaches testids to existing elements found at the file:line references in the spec's control map; read each file and attach to the matching `<button>`/`CommandItem` without altering `onClick`, label text, or `disabled`. The blackjack `PlayerBot` faucet button (`game.fund`, "Fund Stake") is intentionally left untouched and unused by the bot.

---

## Extension: configurable concurrent tunnels + matches-per-tunnel

User-approved follow-up. The arena bot becomes configurable for (a) **concurrent tunnels** = N windows per game, and (b) **matches-per-tunnel** = ttt `maxGames` / blackjack `maxRounds`. Mode/difficulty intentionally NOT included.

New env (arena.mjs): `TTT_WINDOWS`/`BJ_WINDOWS` (default `1`); `TTT_MAX_GAMES`/`BJ_MAX_ROUNDS` (optional; unset ⇒ leave UI default).

### Task 6: testids for per-window scoping + count controls

**Files (attribute-only, no logic change):**

- `frontend/src/desktop/Desktop.tsx`: tag each window's CONTENT container (the element that renders the game module for an `instanceId`, e.g. `tic-tac-toe#1`) with `data-game-window={instanceId}`. Find where the grid renders each open window's body (not the dock item) and attach there.
- `frontend/src/games/ticTacToe/app/scenes/SetupScene.tsx`: the games-per-tunnel `<input>` (`aria-label="Custom games per tunnel"`) → `data-testid="ttt-max-games"`.
- `frontend/src/games/blackjack/app/pages/PlayerBot.tsx`: the "Rounds per tunnel" `<select>` → `data-testid="bj-max-rounds"`.

- [ ] Add the 3 attributes; `./node_modules/.bin/tsc --noEmit` exit 0; grep confirms `data-game-window`, `ttt-max-games`, `bj-max-rounds` present. Commit `test(ui): add testids for window scoping + counts`.

### Task 7: arena.mjs — multi-window + per-window scoping + counts

**Files:** Modify `frontend/agent/arena.mjs`.

- Read env: `TTT_WINDOWS`/`BJ_WINDOWS` (int ≥1, default 1), `TTT_MAX_GAMES`/`BJ_MAX_ROUNDS` (optional int).
- For each game, open `WINDOWS` windows (loop `add-game` → `launch-${id}`). Then for window index `i` in `0..WINDOWS`, build a window-scoped locator `const win = page.locator('[data-game-window^="<gameId>"]').nth(i)` and run ALL that window's interactions via `win.getByTestId(...)` (never page-global — avoids strict-mode across N windows).
- Per ttt window: if `TTT_MAX_GAMES` set, `win.getByTestId("ttt-tab-bots").click()` then fill `ttt-max-games` (`.fill(String(n))`); then fund-if-`ttt-start`-disabled via `ttt-fund-wallet`; click `ttt-start`.
- Per blackjack window: `win.getByTestId("bj-watch-bots").click()`; if `BJ_MAX_ROUNDS` set, `selectOption` on `bj-max-rounds`; fund-if-`bj-auto`-disabled via `bj-fund-wallet`; click `bj-auto`.
- `node --check agent/arena.mjs` valid. Commit `feat(agent): configurable windows + matches per tunnel`.

### Task 8: README — new configs + multi-window

**Files:** Modify `frontend/agent/README.md` (the "Arena auto-pilot" section).

- Document the new env vars (`TTT_WINDOWS`, `BJ_WINDOWS`, `TTT_MAX_GAMES`, `BJ_MAX_ROUNDS`) in a small table, and add a multi-window example, e.g.:
  `KEY=… TTT_WINDOWS=3 BJ_WINDOWS=2 TTT_MAX_GAMES=50 BJ_MAX_ROUNDS=200 DURATION_MS=60000 node agent/arena.mjs`
  with one line each explaining "concurrent tunnels (N windows)" vs "matches anchored per on-chain settle".
- Commit `docs(agent): document arena windows + counts`.
