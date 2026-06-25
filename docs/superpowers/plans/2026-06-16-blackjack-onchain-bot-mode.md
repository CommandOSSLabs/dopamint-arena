# Blackjack on-chain bot mode (in the existing client) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Add a bot-vs-bot mode to the EXISTING Blackjack client (`frontend/src/games/blackjack/packages/client`), reusing its casino UI, driven by the deployed `sui_tunnel` framework + `sui-tunnel-ts` SDK — real on-chain create → off-chain self-play → settle. Mirror the ticTacToe in-browser bot integration.

**Proven foundation:** the on-chain flow already works end-to-end on testnet — see `sui-tunnel-ts/scripts/blackjackBotVsBot.ts` (ran: create→deposit×2→117 signed moves→close, coins moved). Deployed `sui_tunnel` PACKAGE_ID (testnet): `0x8b6cc035bc3d8c4defc27e80a398db428dde98bfdc669e5012bd80adb38af2d4`.

**Reference (copy + adapt these):** the ticTacToe client at `frontend/src/games/ticTacToe/packages/client/src`:

- `lib/bots.ts` — persistent bot identities (localStorage seed → `@mysten` keypair + SDK `coreKey`, asserts pubkey match), **faucet self-funding** (`fundBots` via `requestSuiFromFaucetV2`), `botBalances`, `transferBetweenBots`.
- `lib/tunnel.ts` — tx builders over `onchain.*`, with the @mysten/sui version cast (`tx as unknown as SdkTx`) because the client pins `@mysten/sui` 1.45.2 while the SDK uses 1.28.1.
- `hooks/useBotGame.ts` — the full state machine: fund → create → deposit×2 → animated `OffchainTunnel.selfPlay` (each `step` dual-signs+verifies) → `buildSettlement` → `closeCooperative`; auto-play loop, gas guard, score.

**Key facts:**

- Funding = **faucet self-fund** (no player wallet needed), per user "tự fund cho 2 bot như tictactoe".
- Coin = **SUI** for v1.
- Blackjack differs from TTT: balances VARY (TTT was stake 0, fixed 1/1). So deposit `STAKE` (>= protocol `WAGER`=100; use e.g. 500n) and settle with the protocol's actual final balances via `onchain.buildCloseFromSettlement(tx, tunnelId, settlement, coinType)` (NOT hardcoded balances).
- Turn from phase: `s.phase === "dealer" ? "B" : "A"`. Move: `proto.randomMove(state, by, Math.random)` (SDK basic-strategy bots). Loop until `proto.isTerminal(state)`.
- Card bridge: the existing `components/app/CardDisplay.tsx` takes card **indices 0–51** and computes the sum via `@poc/shared` `getCardSum`. The protocol stores card **values**. Provide `valueToCardIndex(value, seq)` that picks a rank whose blackjack value EQUALS the value (Ace→A, 10-value→10/J/Q/K, else face) so `getCardSum(indices) === handValue(values)` — then **CardDisplay is reused UNCHANGED**.

---

## Task 1: Wire the SDK into the client + baseline build

**Files:** `frontend/src/games/blackjack/packages/client/package.json`, a config constant.

- [ ] Add `sui-tunnel-ts` as a dependency of the client. Use a file/workspace ref to the repo SDK: `"sui-tunnel-ts": "file:../../../../../../sui-tunnel-ts"` (verify the relative depth from `packages/client/` to repo-root `sui-tunnel-ts/`). The SDK has no build step required for source consumption, but if `file:` needs a built dist, instead add a Vite alias in the client's `vite.config.ts` pointing `sui-tunnel-ts` → the SDK `src` (mirror the main frontend's alias) and a tsconfig `paths` entry.
- [ ] Add `PACKAGE_ID` to the client env/config: set `VITE_TUNNEL_PACKAGE_ID="0x8b6cc035bc3d8c4defc27e80a398db428dde98bfdc669e5012bd80adb38af2d4"` in `packages/client/.env`, and in code do `process.env.PACKAGE_ID ??= import.meta.env.VITE_TUNNEL_PACKAGE_ID` (the SDK's `buildTarget` reads `process.env.PACKAGE_ID`). Confirm how the SDK resolves the package id in-browser; if it only reads `process.env.PACKAGE_ID`, set it at module init in `lib/bjTunnel.ts`.
- [ ] `cd frontend/src/games/blackjack && bun install` then `bun run --cwd packages/client build` (or `typecheck`). Establish the client builds BEFORE adding bot code. If it fails on pre-existing issues (e.g. `@poc/shared`), note them; the bot route must not depend on `@poc/shared`.
- [ ] Commit: `feat(blackjack): wire sui-tunnel-ts into client`.

## Task 2: Bot identities + faucet funding (`lib/bjBots.ts`)

- [ ] Copy `ticTacToe/.../src/lib/bots.ts` → `blackjack/.../client/src/lib/bjBots.ts`. Change storage keys to `bj_bot_a` / `bj_bot_o`; rename `x`/`o` → `a`/`b` (player-bot A, dealer-bot B) for clarity. Keep faucet `fundBots`, `botBalances`, `transferBetweenBots`, `getSuiClient` (reads `import.meta.env.VITE_SUI_NETWORK`). Assert on/off-chain pubkey match.
- [ ] Commit: `feat(blackjack): bot identities and faucet funding`.

## Task 3: Card bridge (`lib/bjCards.ts`)

- [ ] Create `valueToCardIndex(value, seq)`, `handToCardIndices(values, salt)` (port from the off-chain `cards.ts` logic) so a hand of protocol values renders via the existing `CardDisplay` with correct suit art AND a matching `getCardSum`. Add a tiny test if a test runner is available in the client; otherwise assert the invariant `getCardSum([valueToCardIndex(v,seq)]) ⇒ v` manually.
- [ ] Commit: `feat(blackjack): card value-to-index bridge for reuse`.

## Task 4: Tunnel tx builders (`lib/bjTunnel.ts`)

- [ ] Mirror `ticTacToe/.../lib/tunnel.ts`: `proto = new protocols.BlackjackProtocol()`; `buildCreateAndShareTx(partyA, partyB)`; `buildDepositTx(tunnelId, amount)`; and settle via `onchain.buildCloseFromSettlement(tx as SdkTx, tunnelId, settlement, "0x2::sui::SUI")` (use the actual settlement, NOT 1/1). Set `process.env.PACKAGE_ID` at module load. Keep the `tx as unknown as SdkTx` cast boundary.
- [ ] Commit: `feat(blackjack): tunnel tx builders for bot mode`.

## Task 5: Bot game hook (`hooks/useBlackjackBot.ts`)

- [ ] Adapt `useBotGame.ts`: `proto = new protocols.BlackjackProtocol()`; STAKE=500n; deposit STAKE each; `selfPlay(proto, tunnelId, A.coreKey, B.coreKey, A.address, B.address, {a:STAKE,b:STAKE})`; play loop uses `proto.randomMove(state, partyForPhase(state), Math.random)` until `proto.isTerminal`. Expose a `BlackjackBotView`: `{ playerCards:number[](indices), dealerCards:number[](indices), playerSum, dealerSum, playerBalance, dealerBalance, round, phase, result:"win"|"lose"|"push"|null, phaseStatus, digests, balances, fund, startAuto, stopAuto, newGame, error }`. Derive `result` from final balanceA vs starting STAKE. Keep gas guard + auto-play + faucet fund. STEP_MS≈700 for watchable dealing.
- [ ] Commit: `feat(blackjack): bot-vs-bot game hook`.

## Task 6: Bot-mode page reusing the casino UI

- [ ] Create `pages/PlayerBot.tsx` (or `BotGame.tsx`): render the existing casino table — reuse `components/app/CardDisplay.tsx` (dealer hand top, player hand bottom), the `dealer-desk` background, gold HUD — fed by `useBlackjackBot()` instead of `useBlackJack()`. No Hit/Stand: show **Fund bots / Play / Auto / Stop** controls + balances + round + result banner + on-chain digest links (suiscan testnet). It must NOT import `@poc/shared` except the pure `getCardSum` (which `CardDisplay` already uses) — keep it independent of auth/enoki/server.
- [ ] Add a route in `src/App.tsx` (e.g. `/bot`) — render `PlayerBot` without the enoki/auth-gated layout if possible (a minimal layout), so bot mode runs without login. Add a link/button to reach it.
- [ ] Commit: `feat(blackjack): bot-mode page reusing casino UI`.

## Task 7: Verify

- [ ] `bun run --cwd packages/client build` passes.
- [ ] `bun run --cwd packages/client dev`, open `/bot`, click Fund (faucet), then Play — confirm: a tunnel is created on testnet, cards deal each ~700ms, balances move, result shows, and the close digest links to a real testnet tx. Capture the digests.
- [ ] Commit any fixes.

## Risks

- Getting the existing bun client to build (it references `@poc/shared`, enoki, etc.). The bot route is isolated and must not require the auth/server stack. If the whole client won't build due to other pages, consider gating those imports or a minimal bot-only entry.
- @mysten/sui 1.45.2 (client) vs 1.28.1 (SDK) — use the type-only cast at the builder boundary (TTT pattern). Built tx bytes are identical.
- Faucet rate limits on testnet — `fundBots` already returns statuses instead of throwing; surface them in the UI.
