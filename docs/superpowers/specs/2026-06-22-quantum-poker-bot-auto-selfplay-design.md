# Quantum Poker — Bot & Auto modes as local self-play

- **Date:** 2026-06-22
- **Branch:** `poker-bot-kit`
- **Status:** Approved (design)

## Problem

Quantum Poker's three lanes diverge from the other arena games. PvP already
follows the canonical pattern (`DistributedTunnel` + `MpClient.quickMatch`,
root-anchored settle — see `usePvpQuantumPoker.ts`), and the agent kit
(`agent/games/quantumPoker/kit.ts`) already matches the `GameKit`/`GameBot`
contract of TicTacToe/Blackjack/Battleship. But the **Bot** and **Auto** lanes
are built on a bespoke poker Node server (`packages/server` +
`serverClient.ts` + `serverRuntime.ts`):

- **Auto** (`QuantumPokerBotVsBotWindow`) calls `runBotVsBot()` →
  `/api/quantum-poker/demo/persona-e2e`; the **server** leases two bot wallets,
  plays both seats, funds, and settles entirely server-side. The browser only
  renders the result. No local bot, no player funding.
- **Bot** (`QuantumPokerWindow` lane=`bot`) drives party A with a local persona
  over the server session protocol; the server owns party B and funds the
  tunnel. The player funds nothing.

No other game has a per-game server. The reference for an in-window bot/auto
experience is local self-play over `OffchainTunnel.selfPlay` with the canonical
kit, funded by the player.

## Goals

- Rebuild **Bot** and **Auto** as **local self-play**, matching how
  Battleship/Blackjack/TicTacToe fund and run their lanes.
- Keep the poker bot's **persona** system (it is the differentiator).
- Keep **PvP** exactly as-is.
- Delete the poker Node server and its client/runtime shims.

## Non-goals

- No change to the relay, the on-chain Move package, or the agent kit.
- No change to PvP.
- No "withdraw winnings back to wallet" sweep (testnet; funds stay where the
  close sends them — same as the other games).

## Decisions

### Modes (mode window keeps its 3 buttons)

| Mode | Player plays? | Opponent | Funding pattern | Close |
|---|---|---|---|---|
| **Play vs Bot** | Yes — bets/calls/folds; commit/reveal automated | persona bot (random) | **Pattern 1**: connected wallet opens directly, **ephemeral** seats | `/settle` (sponsored) + fallback wallet-submitted |
| **Auto** | No (watch) | two persona bots (random) | **Pattern 2**: **persistent** localStorage bots, bot A self-signs, player pre-funds | `/settle` (sponsored) + fallback bot-A submitted |
| **PvP** | unchanged (relay quickMatch) | — | each wallet funds its own seat | unchanged |

Both lanes match the existing reference exactly:
- Play vs Bot = Battleship **bot** lane (`useBattleship`): `createParticipant`
  makes fresh random ephemeral seats per session; the connected wallet signs the
  single `openAndFundSelfPlay`.
- Auto = Battleship **auto** lane (`useBattleshipAuto`) / TTT: persistent
  localStorage bot keypairs, pre-funded (faucet or one-click wallet transfer),
  bot A self-signs each open.

### Persona

Each tunnel draws random profile(s) from
`DEFAULT_QUANTUM_POKER_BOT_PROFILES` (Nari/Jules/Mika/Sol/Vale/Kai; personas
tight/loose/aggressive/passive/balanced). Play vs Bot randomizes party B; Auto
randomizes both seats.

### Engine (shared by both lanes)

- `OffchainTunnel.selfPlay(protocol, tunnelId, keyA, keyB, addrA, addrB,
  {a: stake, b: stake})`. `selfPlay` applies moves **in-process**
  (`protocol.applyMove`), so poker's byte-bearing moves (commit/salt) need **no**
  `moveCodec` — same as Battleship, whose moves also carry bytes. `moveCodec`
  remains only for the relay path (PvP/agent).
- Seat bots come from the canonical kit:
  `createQuantumPokerKit(stake, handCap, { profile }).createBot(seat, ctx)`.
- **Keep each seat's bot instance for the whole tunnel.** The persona driver
  retains the commit secrets it must later reveal (commit-reveal mental poker);
  recreating it mid-hand would lose that memory. Mirrors how Battleship-auto
  keeps `botA`/`botB` per match.
- Append every co-signed update to a `Transcript`; settle with its root.

### Funding & gas-cost model

Poker's randomness is two-party commit-reveal (nine slots) — **no external/
on-chain randomness and no server are needed** for card distribution.

- **Close is gas-sponsored** by the backend settler (`/settle` →
  `close_cooperative_with_root`, SIP-58 address-balance gas, non-party payer,
  authorized purely by the two co-signatures). Parties pay **0 gas** to close.
- **Open** (`openAndFundSelfPlay` → `create_and_fund`) sets **no fixed gas
  budget** → the wallet/SDK dry-run-estimates and unused gas is refunded. It
  costs computation + a one-object storage deposit (~0.002–0.004 SUI actual).
- **Stake** = `QUANTUM_POKER_STAKE` (10_000 MIST/seat = 0.00001 SUI; 20_000
  MIST = 0.00002 SUI for both seats) is locked then returned at close (`a + b`
  conserved). Not spent.

**The only real cost is the open gas.** Least-waste rules baked into the design:

1. Always close via `/settle` (sponsored). Fallback close (party-paid) only if
   `/settle` is down.
2. Many hands per tunnel: `HAND_CAP = 1000` → one open amortized over up to 1000
   hands. **Play vs Bot opens once per session**, plays many hands, settles once
   → real cost ≈ one open's gas regardless of hand count.
3. Auto: prefer the free testnet faucet; `buildFundBotsTx` (one-click wallet)
   only when rate-limited. Persistent bots are funded once and reused across
   tunnels; excess is recoverable. `MIN_PLAY_MIST` (~0.02 SUI) is a stop
   threshold, not a spend, sized to also cover a rare fallback close.
4. Keep stake small so the amount stranded in ephemeral seats (Play vs Bot) is
   negligible (~0.00002 SUI/session).
5. Optional zero-SUI **off-chain practice**: with no wallet, run purely local
   (`onChain = false`, random tunnel id) — same affordance Battleship's bot lane
   has. "Open real tunnel" only when an on-chain proof is wanted.

### Server deletion

Delete `serverClient.ts`, `serverRuntime.ts`, `runtime.ts`, and
`packages/server/`. They become dead code (no other game uses a server; PvP uses
the relay). Update the `index.ts` lane comment.

## Architecture / files

**New** (`frontend/src/games/quantumPoker/`):
- `bots.ts` — persistent bot keypairs + funding + balance reads, used **only by
  Auto**. Mirrors `ticTacToe/botKeys.ts` + `battleship/engine/bots.ts`:
  `loadOrCreateQuantumPokerBots()` → `{ a, b }` (localStorage `qp_bots.v1`; each
  bot has `coreKey`, Ed25519 `keypair`, `address`, `publicKey`),
  `botBalances`, `fundBotsFromFaucet`, `buildFundBotsTx`, `botSignExec`,
  `MIN_PLAY_MIST`.
- `useQuantumPokerBot.ts` — Play-vs-Bot session. Mirrors `useBattleship.ts`
  (`BotSession` kept out of React via `windowSessions`). Ephemeral seats +
  connected wallet.
- `useQuantumPokerAuto.ts` — Auto session. Mirrors `useBattleshipAuto.ts`
  (`AutoSession`). Persistent bots + loop + scoreboard.

**Rewrite:**
- `QuantumPokerWindow.tsx` — reuse the existing table (seats/board/pot/log) and
  add a human action bar (Fold / Check / Call / Bet[amount]); drive via
  `useQuantumPokerBot`.
- `QuantumPokerBotVsBotWindow.tsx` — auto watch view (scoreboard, personas,
  balances, stage, Start/Stop, fund controls); drive via `useQuantumPokerAuto`.

**Keep:** `QuantumPokerModeWindow.tsx`, `usePvpQuantumPoker.ts`, `constants.ts`,
`agent/games/quantumPoker/kit.ts`.

**Delete:** `serverClient.ts`, `serverRuntime.ts`, `runtime.ts`,
`packages/server/`.

**Reused on-chain helpers (unchanged):** `openAndFundSelfPlay`,
`readCreatedAt`, `closeCooperativeWithRoot` (`onchain/tunnelTx`),
`getControlPlaneClient().settle`, `coSignedToSettleRequest`, `Transcript`.

## Play vs Bot — move routing

Seats: **A = human-controlled**, **B = persona bot**. The session holds both
ephemeral keys and co-signs every update. Each step:

1. `phase === "done"` → settle.
2. Actor is B → `botB.plan()` (persona), auto.
3. Actor is A:
   - Betting phase (`preflop_bet`/`flop_bet`/`turn_bet`/`river_bet`) with
     `toAct === "A"` → **pause; wait for the human action**
     (Fold/Check/Call/Bet), then `tunnel.step(move, "A")`.
   - Mechanical phase (`commit`/`reveal_*`/`open_private_holes`/`showdown`/
     `hand_over` → `next_hand`) → `botA.plan()`, auto. A still needs a kit-bot
     instance for these (and to retain its commit secrets).

UI: show the human's hole cards (`knownHoleCards`); the action bar appears only
while waiting on A's bet; bet amounts are presets clamped to the legal range
(min-raise / ½ pot / pot / all-in). A funding gate precedes "Open tunnel". The
user can stop and settle at any time.

## Auto — loop

Per tunnel: pick random personas for both seats → `bots.a` signs
`openAndFundSelfPlay` → self-play to `done` (up to `HAND_CAP`) → settle via
`/settle` → refresh balances → loop until a bot is below `MIN_PLAY_MIST` or the
user stops. Surfaces a scoreboard (A/B wins), current personas, balances,
tunnels, total actions, stage, and end reason — mirroring Battleship's
`AutoBattleView`.

## Testing

`node:test` via tsx, co-located `*.test.ts`:

- **`bots.ts`** — load/persist (mock localStorage), `MIN_PLAY_MIST` threshold.
- **Engine self-play (core test)** — run one full poker self-play tunnel
  **off-chain** with two seeded personas to `phase === "done"`; assert
  (a) `a + b === 2 × stake` at every step, (b) terminal reached within
  `HAND_CAP`, (c) personas only emit legal moves, (d) commit-reveal completes
  (proves the retained-driver-instance requirement).
- **Human router** — party A pauses on its betting phases and auto-handles its
  commit/reveal; feed scripted human actions and assert progression.

No on-chain calls in unit tests; the open/settle path is already exercised by
Battleship/caro and the agent engine and is reused unchanged.

## Migration / cleanup

- Remove `serverClient`/`serverRuntime`/`runtime` imports from the windows.
- Delete `packages/server/`.
- Update the lane comment in `index.ts`.
