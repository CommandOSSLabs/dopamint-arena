# Arena Auto-Pilot — Playwright UI bot for ttt + blackjack — design

**Date:** 2026-06-22 · **Status:** proposed · **Scope:** a TS/Playwright bot that
drives the **real desktop UI** into bot-vs-bot auto-play for tic-tac-toe and
blackjack, funding the in-game bots from the wallet only when needed.

## Problem / goal

We want a one-command "arena" bot that, when started, opens the real Dopamint
desktop, selects the **bot-vs-bot** mode for tic-tac-toe and blackjack, **funds
the in-game bots from the wallet if (and only if) they're low**, and lets the
screen **auto-play** — so a demo/observer sees real games running end-to-end
without manual clicking. It must NOT use the testnet faucet (rate-limited; we
just removed the auto-faucet) and must NOT fund unconditionally.

## Decisions (from brainstorming)

1. **External Playwright script** (not an in-app toggle): `frontend/agent/arena.mjs`,
   mirroring the existing `frontend/agent/runAgents.mjs`. It drives real clicks
   on the live app.
2. **Wallet via desktop injection:** Playwright has no real wallet extension, and
   funding goes through the connected wallet (`fundFromWallet`). So we inject a
   **programmatic wallet into the normal desktop** (reusing `AgentBoot`'s logic)
   behind a new `?arena&key=<suiprivkey>` mode — the desktop renders as usual but
   with a connected wallet the script can fund from.
3. **Both games simultaneously**, **duration-based** run with a short report
   (like `runAgents.mjs`).
4. **Fund only when low:** the script reads the on-screen funded state and clicks
   "Fund from wallet" only if a bot is below the play threshold. No faucet.

## Non-goals

- battleship / quantum-poker (out of scope).
- The headless `?agent` / `AgentRunner` / `runAgents.mjs` path is unchanged.
- No change to game logic; the script only drives the existing bot-vs-bot UI
  (`mode="auto"` + `startAuto` for ttt; the `PlayerBot` page for blackjack).

## Architecture

Two parts.

### Part 1 — Frontend: desktop wallet injection + stable selectors

- **Reusable wallet injector.** Extract `AgentBoot`'s programmatic-wallet logic
  (`programmaticWalletFromSecret` → `getWallets().register` → `connect`) into a
  small wrapper component (e.g. `ProgrammaticWalletGate`) that renders its
  children once connected. `AgentBoot` becomes a thin user of it (no behavior
  change for `?agent`).
- **New `?arena` mode** in `main.tsx`: when `parseAgentConfig` reports the arena
  flag with a `key`, render `<ProgrammaticWalletGate key=…><App/></ProgrammaticWalletGate>`
  — i.e. the **normal desktop** with an injected wallet. `?agent` still renders
  the headless `AgentRunner`. Extend `agentConfig.ts` to parse `arena` + `key`.
- **`data-testid`s** on the bot-vs-bot controls the script must click, so
  selectors don't depend on brittle copy:
  - the desktop game launcher entries for "Tic Tac Toe" and "Blackjack",
  - ttt: the **Bots** tab, **Fund bots from wallet** button, **Start playing**,
  - blackjack: the **PlayerBot** (bot-vs-bot) entry, **Fund from wallet**, the
    **Start auto** control,
  - a funded/low indicator the script can read (or it reads the balance text /
    the disabled state of Start).

### Part 2 — `frontend/agent/arena.mjs` (the bot)

- Launches Chromium **headed** by default (so the screen is watchable; `HEADLESS=true`
  to hide), with the same anti-throttle args as `runAgents.mjs`.
- Navigates to `${BASE_URL}/?arena&key=${KEY}`, waits for the wallet to connect
  (the `ProgrammaticWalletGate` renders `<App/>`).
- For each game in `GAMES`:
  - **ttt:** open the Tic-Tac-Toe window → select bot-vs-bot (`mode="auto"`) →
    if a bot is low, click **Fund bots from wallet** and wait for the balance to
    rise → click **Start playing** (`startAuto`).
  - **blackjack:** open the Blackjack window → **PlayerBot** → fund-from-wallet
    if low → **Start auto**.
- Runs **both** for `DURATION_MS`, polling a progress signal (settled-tunnel
  count via console logs, mirroring `runAgents.mjs`'s `[agentstatus]` pattern, or
  the on-screen scoreboard), then prints a report and closes.

### Config (env)

`KEY` (funded testnet `suiprivkey…`, required), `GAMES=ttt,blackjack` (default
both), `DURATION_MS=60000`, `HEADLESS=false`, `BASE_URL=http://localhost:5173`.

## Data flow

`arena.mjs` (Playwright) → real clicks on `<App/>` (with injected wallet) →
existing game hooks (`useBotGame` `setMode("auto")`/`startAuto`/fund;
`useBlackjackBot`/`PlayerBot` `startAuto`/`fundFromWallet`) → relay + chain. The
script never touches game internals — only the DOM the user would.

## Error handling

- No wallet connect within a timeout → fail fast with a clear message (bad/empty
  `KEY`, or the dev server not pointed at a reachable backend).
- Fund click but balance doesn't rise within N polls → log a warning and continue
  (the bots may already be sufficiently funded; Start is gated by the UI).
- A game window's controls not found → log which selector failed (the
  `data-testid`s make this precise) and continue with the other game.

## Testing

- **Selector smoke test:** a short Playwright run (`DURATION_MS=8000`) that asserts
  both windows reach the bot-vs-bot playing state (the Start control becomes
  disabled / a move/round count increments). Treated like `runAgents.mjs` (a
  manual/CI smoke, not a unit test).
- **Frontend unit:** `agentConfig.ts` parses the `arena` flag + `key` correctly
  (co-located `*.test.ts`, `node:test`).
- Reuse the existing dev backend (`VITE_BACKEND_URL`) — no new infra.

## Risks

- **Auto-connecting a programmatic wallet on the desktop** widens the
  injection path beyond `?agent`; gate it strictly on the `arena` param + a
  provided `key` so normal users are unaffected.
- **Selector brittleness** if `data-testid`s are skipped — the plan adds them.
- **Fresh Playwright context = fresh in-game bot keys** (localStorage) each run →
  always needs one wallet-funding click; acceptable (one small transfer/run) and
  matches "fund if low".
