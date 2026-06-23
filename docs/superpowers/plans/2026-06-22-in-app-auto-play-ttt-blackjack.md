# In-App Auto-Play (ttt + blackjack), remove Playwright arena — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** When a ttt or blackjack game window opens, it auto-enters bot-vs-bot
self-play and auto-funds the bots **from the connected wallet only if low** (no
faucet). Remove the Playwright `?arena` auto-pilot in favour of this in-app path.

**Architecture:** Both games already auto-navigate on wallet-connect. We (1) point
blackjack at the bot-vs-bot page (`/bot`) and add a fund-if-low + `startAuto`
effect there; (2) switch ttt's existing auto-effect from faucet (`g.fund()`) to
wallet-fund (`buildFundTx` + `executeTransaction` + `g.refresh()`); (3) replace the
page-global `sessionStorage` auto-nav flags with per-instance refs so every window
auto-plays; (4) delete the `?arena` mode and `agent/arena.mjs`.

**Tech Stack:** React, @mysten/dapp-kit, @tanstack/react-router, Sui TS SDK.

## Global Constraints

- No faucet. Fund bots **from the connected wallet, only when balance is low**
  (a bot balance is `0n`). Funding must run **at most once** per window per session
  (guard with a `useRef`), then `startAuto` when funded.
- Every game window must auto-play independently — do NOT gate auto-navigation on a
  page-global `sessionStorage` flag (it stops 2nd/3rd windows). Use a per-component
  `useRef`.
- `ProgrammaticWalletGate` stays — it is used by `AgentBoot` (`?agent`). Only the
  `?arena` branch in `main.tsx` and the `arena` config field are removed.
- Reuse existing helpers: `loadOrCreateBots`, `buildFundTx`. Do not duplicate them.
- Conventional Commits, subject ≤50 chars, imperative, no AI attribution. Targeted
  `git add <paths>` only — never `-A`/`.`. Do NOT touch `sui_tunnel/` or
  `sui-tunnel-ts/`. Leave untracked framework files alone.
- TS SDK tests via `node:test`/`tsx`; frontend has no test runner wired — verify
  with `pnpm -C frontend tsc --noEmit` (typecheck) and `pnpm -C frontend build` if tsc is unavailable.

---

### Task 1: Blackjack auto-play on open (bot-vs-bot)

**Files:**
- Modify: `frontend/src/games/blackjack/app/pages/Home.tsx`
- Modify: `frontend/src/games/blackjack/app/pages/PlayerBot.tsx`

**Interfaces (existing, consume as-is):**
- `Home`: `account = useCurrentAccount()`, `navigate = useGameNavigate()`.
  `navigate("/bot")` opens the bot-vs-bot arena (PlayerBot).
- `PlayerBot`: `account = useCurrentAccount()`; `fundFromWallet()` (async, funds both
  bots from wallet via `signAndExecute(buildFundTx(loadOrCreateBots()))`);
  `game.startAuto()` / `game.stopAuto()`; `running` (bool, a loop is active);
  `unfunded = balances.a === 0n || balances.b === 0n`.

**Changes:**

- [ ] **Home.tsx** — auto-navigate to the bot arena instead of `/play`, once per
  window (per-instance ref, not `sessionStorage`). Drop the `parseAgentConfig` arena
  guard and the import. Replace the redirect effect with:
```tsx
const autoNavRef = useRef(false);
useEffect(() => {
  if (account && !autoNavRef.current) {
    autoNavRef.current = true;
    navigate("/bot"); // bot-vs-bot self-play
  }
}, [account, navigate]);
```
  (add `useRef` to the React import; remove the now-unused `parseAgentConfig` import and
  the `sessionStorage` "blackjack_auto_navigated" logic.)

- [ ] **PlayerBot.tsx** — auto fund-if-low then auto-start, once per window. Add near
  the other effects (after `fundFromWallet`/`running`/`unfunded` are defined):
```tsx
const autoPilotRef = useRef(false);
const autoStartedRef = useRef(false);
useEffect(() => {
  if (!account || running) return;
  if (unfunded) {
    if (!autoPilotRef.current) {
      autoPilotRef.current = true;
      void fundFromWallet(); // wallet-fund only when a bot balance is 0
    }
    return;
  }
  if (!autoStartedRef.current) {
    autoStartedRef.current = true;
    game.startAuto();
  }
}, [account, running, unfunded, game]);
```
  (`useRef` is already imported.)

- [ ] **Verify:** `pnpm -C frontend tsc --noEmit` clean. Manually confirm the effect
  reads `unfunded`/`running` from the same names defined in the file.

- [ ] **Commit:** `git add frontend/src/games/blackjack/app/pages/Home.tsx frontend/src/games/blackjack/app/pages/PlayerBot.tsx`
  → `feat(blackjack): auto-play bot arena on open`

---

### Task 2: ttt auto-play funds from wallet (not faucet)

**Files:**
- Modify: `frontend/src/games/ticTacToe/app/App.tsx`

**Interfaces (existing):**
- `useCustomWallet()` exposes `isConnected` and `executeTransaction({ tx })`.
- `g.refresh()` re-reads bot balances; `g.startAuto()` starts the self-play loop;
  `funded = g.balances.x > 0n && g.balances.o > 0n`.
- From `@/games/ticTacToe/app/lib/bots`: `loadOrCreateBots()`, `buildFundTx(ids)`.

**Changes:**

- [ ] Pull `executeTransaction` from `useCustomWallet()` (currently only `isConnected`
  is destructured). Import `loadOrCreateBots`, `buildFundTx` from the bots lib.
- [ ] Replace the auto-pilot effect (the `?arena` branch + faucet `g.fund()`) with a
  single in-app path: per-instance refs for navigate-once and fund-once; on `setup`,
  wallet-fund if not funded (once), else `startAuto`:
```tsx
const autoNavRef = useRef(false);
const autoFundRef = useRef(false);

// Auto-pilot: skip login → setup → wallet-fund bots if low → start bot-vs-bot.
useEffect(() => {
  if (!isConnected) return;

  if (scene === "login") {
    if (!autoNavRef.current) {
      autoNavRef.current = true;
      setGameType(Math.random() > 0.5 ? "caro" : "ttt");
      setDifficulty("fast");
      setBoardSize(([15, 19, 25] as const)[Math.floor(Math.random() * 3)]);
      setMode("auto");
      setScene("setup");
    }
    return;
  }

  if (scene === "setup") {
    if (!funded) {
      if (!autoFundRef.current) {
        autoFundRef.current = true; // fund AT MOST ONCE per window (Global Constraint)
        console.log("[tictactoe] funding bots from wallet…");
        void (async () => {
          try {
            await executeTransaction({ tx: buildFundTx(loadOrCreateBots()) });
            await g.refresh();
          } catch (e) {
            // Do NOT reset autoFundRef — a retry would re-fire against the unstable
            // `g` dep and risk an infinite real-SUI fund loop. On failure the SetupScene
            // surfaces the error and the manual fund button remains as the recovery path.
            console.error("[tictactoe] wallet fund failed", e);
          }
        })();
      }
      return;
    }
    const timer = setTimeout(() => {
      setScene("game");
      g.startAuto();
    }, 1000);
    return () => clearTimeout(timer);
  }
}, [isConnected, scene, funded, g, executeTransaction]);
```
  Remove the `parseAgentConfig` import if it becomes unused. Keep the existing
  disconnect→login effect unchanged. The faucet `onFund={g.fund}` prop on `SetupScene`
  stays (manual button) — only the auto-path stops calling it.

- [ ] **Verify:** `pnpm -C frontend tsc --noEmit` clean.

- [ ] **Commit:** `git add frontend/src/games/ticTacToe/app/App.tsx`
  → `feat(ttt): auto-fund bots from wallet on open`

---

### Task 3: Remove the Playwright arena (`?arena` + arena.mjs)

**Files:**
- Delete: `frontend/agent/arena.mjs`; `frontend/agent/arena-fund-fail-*.png` (if present)
- Modify: `frontend/src/main.tsx` (drop `?arena` branch + `ProgrammaticWalletGate` import)
- Modify: `frontend/src/agent/agentConfig.ts` (remove `arena` field + parse)
- Modify: `frontend/src/agent/agentConfig.test.ts` (remove the two `arena` tests)
- Modify: `frontend/src/desktop/Desktop.tsx` (drop `arena` ternary → always `seedLayout`; remove the `arena` const + `parseAgentConfig` import if unused)
- Modify: `frontend/src/desktop/GameWindow.tsx` (remove the arena-only `data-game-window` attr)
- Modify: `frontend/agent/README.md` (remove the "Arena auto-pilot" section, restore to the fleet-only doc)

**Changes:**
- [ ] `main.tsx`: remove the `cfg.arena ? (<ProgrammaticWalletGate…><App/></…>) :`
  branch and the `ProgrammaticWalletGate` import — keep `cfg.enabled ? <AgentBoot> : <App/>`.
- [ ] `agentConfig.ts`: remove the `arena: boolean` field and `arena: p.get("arena") !== null,`.
- [ ] `agentConfig.test.ts`: remove the two arena tests; run `pnpm -C frontend exec tsx --test src/agent/agentConfig.test.ts` (or the package's test cmd) → green.
- [ ] `Desktop.tsx`: `useLocalStorageState<GridItem[]>("dopamint.desktop.layout.v3", seedLayout)`;
  delete the `const arena = …` line; remove `parseAgentConfig` import if now unused.
  The "arena desktop" doc comment may stay (it describes the self-playing floor concept).
- [ ] `GameWindow.tsx`: remove `data-game-window={domId}` (it existed only for the
  Playwright window locator). Leave the rest of the element.
- [ ] `README.md`: delete the Arena auto-pilot section (items 4 + env table + smoke).
- [ ] **Verify:** `grep -rn "arena" frontend/src` shows no `?arena`/`cfg.arena`
  references (the Desktop concept comment is acceptable); `pnpm -C frontend tsc --noEmit` clean.
- [ ] **Commit:** `git add frontend/src/main.tsx frontend/src/agent/agentConfig.ts frontend/src/agent/agentConfig.test.ts frontend/src/desktop/Desktop.tsx frontend/src/desktop/GameWindow.tsx frontend/agent/README.md && git rm frontend/agent/arena.mjs`
  → `chore(agent): remove playwright arena auto-pilot`

(Leave the in-game `data-testid`s on real controls — inert, harmless, and useful for
future tests. Leave the arena spec/plan docs as historical record.)
