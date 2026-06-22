# Tic-Tac-Toe Tunnel (Sui state-channel) — autonomous bot-vs-bot

Tic-tac-toe (standard 3×3) played **bot-vs-bot, entirely in the browser, with no server and no
wallet**, built on the canonical **[`sui-tunnel-ts`](../reference/sui-tunnel-ts) SDK** and the
core **`tunnel`** Move module — a two-party off-chain signed **state channel** on Sui. Two
persistent bot identities (**Bot X** = perfect minimax from `@ttt/shared`, **Bot O** =
win/block/random) hold their own ed25519 keypairs and play each other: every half-move produces
a `TicTacToeState` whose hash is **dual-signed by both bots** and **verified on the spot**
(`OffchainTunnel.selfPlay` with `mode:"full"`), so each state is always settleable/disputable.
The two bots also **sign and submit every on-chain transaction themselves** (no wallet popups).

- **Tunnel package (testnet):** `0x8fd369d75838721d56b47b302e5eb85ff9c77cdb1182e81a08bdee5463027a46`

## Bot identities & funding (once)

Two ed25519 keypairs are generated and persisted in `localStorage` (`ttt_bot_x` / `ttt_bot_o`);
the same 32-byte seed is used both off-chain (`core.KeyPair`) and on-chain
(`@mysten/sui` `Ed25519Keypair`) so the on-chain party public key matches the off-chain signer.
Each bot needs **testnet SUI** (gas + a refundable 1-MIST deposit). The UI's **Fund bots** button
requests the testnet faucet for both addresses; because the keys persist, fund once and play
many games (only gas is spent — deposits are returned at settle). If the in-browser faucet is
rate-limited or blocked, send a little testnet SUI to the two addresses shown in the panel.

## Lifecycle (per game, 0 popups)

1. **`create_and_share`** (Bot X submits) — opens the tunnel with party A = Bot X, party B =
   Bot O, both ed25519, registering each party's public key.
2. **two `deposit`s of 1 MIST** — Bot X and Bot O each deposit 1 MIST from their own key; the
   tunnel requires deposits ≥ 1 MIST to activate.
3. **Off-chain self-play** — `OffchainTunnel.selfPlay` drives both sides; each new state is
   **dual-signed and dual-verified** (both bot keys) over the SDK state-update message. No
   per-move transaction; the UI animates the moves.
4. **Cooperative close** (`close_cooperative`, balances **1/1**, `final_nonce=1`,
   `timestamp = created_at`) — both bot signatures over the settlement message; the tunnel
   closes and each bot's 1 MIST is returned.

A dispute / force-close path is available through the SDK if a party stops cooperating. The
on-chain lifecycle is proven headlessly by `packages/client/scripts/bot-vs-bot.ts` (runs the
full create → deposit → self-play → close against testnet).

### Near-zero stake (no real betting)

The tunnel must hold deposits ≥ 1 MIST to activate, so each side deposits exactly **1 MIST** and
`TicTacToeProtocol(0n)` (stake 0) keeps balances pinned at **1/1** for the whole game. **Nobody
loses value** — the proof of the game is the co-signed transcript plus the on-chain cooperative
close, not a payout.

## Layout

Bun workspace, two TS packages (the game is **client-only** — no server, no database):
- `packages/shared` (`@ttt/shared`) — game rules + the tunnel wire helpers
  (`encodeStateHash`, `buildStateUpdateMsg`, `buildSettlementMsg`, in `src/tunnel/state.ts`).
- `packages/client` (`@ttt/client`) — Vite + React:
  - `lib/bots.ts` — the two persistent bot identities, `createSuiClient`, faucet/`buildFundTx`
    funding, balances, and `transferBetweenBots` (rebalance).
  - `lib/tunnel.ts` — SDK PTB builders (`buildCreateAndShareTx`, `buildDepositTx`,
    `buildSettleTx`, `parseTunnelId`).
  - `hooks/useBotGame.ts` — the autonomous game loop (create → deposit → self-play → close),
    auto-play, and rebalance.
  - `contexts/CustomWallet.tsx` — used only so the player can fund the bots from their wallet.

The SDK is consumed as a `file:` dep from `../reference/sui-tunnel-ts`. If its `dist/` is missing
or stale, build it there: `cd ../reference/sui-tunnel-ts && ./node_modules/.bin/tsc`.

## Prerequisites
- Bun (1.3.x).
- A **Slush wallet** (or Google/Enoki login) with a little **testnet SUI** — used once to fund the
  bots. (Or use the testnet faucet button, which may be rate-limited.)

## Setup

```bash
cd tik-tak-toe
bun install
cp -n packages/client/.env.example packages/client/.env   # if not already present
```

`packages/client/.env`:
```
VITE_API_URL="/api"
VITE_SUI_NETWORK="https://fullnode.testnet.sui.io:443"
VITE_SUI_NETWORK_NAME="testnet"
VITE_TTT_PACKAGE_ID="0x8fd369d75838721d56b47b302e5eb85ff9c77cdb1182e81a08bdee5463027a46"
# (Google/Enoki login is optional; VITE_ENOKI_API_KEY / VITE_GOOGLE_CLIENT_ID enable it.)
```

## Run

```bash
bun run dev          # client at http://localhost:3100
```
Open http://localhost:3100 → **Connect wallet** → **Fund bots from wallet** (one tx sends a little
SUI to each bot) → **New Game** (one game) or **▶ Auto-play** (loops until a bot is low on gas or
you press **⏹ Stop**). Use **⇄ Even out bots** to move gas from the richer bot to the poorer one.
Everything during play is signed and submitted by the bots themselves — no wallet popups.

## Verify

```bash
bun run --cwd packages/shared typecheck \
  && bun run --cwd packages/client typecheck
bun test packages/shared                      # shared unit tests
bun run --cwd packages/client build           # production build (dist/ emitted)

# Optional: prove the full on-chain lifecycle headlessly (create → deposit → self-play → close)
# on testnet. SUI_FUNDER_KEY is any funded testnet key (seeds two throwaway bots).
SUI_FUNDER_KEY=<suiprivkey…> bun run packages/client/scripts/bot-vs-bot.ts
```

## Notes
- **No server, no DB.** Two persistent bot keypairs live in `localStorage`; each uses one ed25519
  seed both off-chain (state co-signing) and on-chain (`Ed25519Keypair`, signs its own txs).
- **Per-move signing is instant and free** (off-chain). Only the 4 on-chain txs per game
  (create / deposit ×2 / close) cost gas, paid by the bots from their own balance.
- **Dual-signed + verified every state.** `OffchainTunnel.selfPlay(..., {mode:"full"})` co-signs
  AND verifies both bot signatures on each state, so the transcript is on-chain-settleable.
- **Near-zero stake:** 1-MIST deposits, balances pinned 1/1, refunded on close — nobody loses
  value. Each game costs only gas (~0.01 SUI for the busier bot).
