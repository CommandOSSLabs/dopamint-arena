# Blackjack: tunnel-SDK bot self-play

Date: 2026-06-16
Status: Approved (design); pending implementation plan

## Problem

The Blackjack game under `frontend/src/games/blackjack/` is a whole standalone
monorepo (`packages/{client,server,move,shared}`) ported from an earlier PoC. It
plays a human against a **server** (axios + BLS dealer signatures + on-chain
moves + IndexedDB). This diverges from every sibling game in the arena, which is
a single self-contained folder that registers one `Window` component and is meant
to drive a `sui-tunnel-ts` `Protocol` with a **bot self-play** loop (see the stub
text in `games/GamePlaceholder.tsx` and `games/regularPayments/PaymentsWindow.tsx`).

We want Blackjack to match that model: **the player only provides a bet; two bots
play each other over a tunnel**, with no server.

## Goals

- Replace the server-driven blackjack with **bot-vs-bot self-play** driven by the
  existing SDK `protocols.BlackjackProtocol` + `core.OffchainTunnel.selfPlay`.
- **Preserve the existing casino UI** (table, cards, HUD, theme, animations).
- Player input is limited to **setting a stake and pressing Deal/Reset**. No
  hit/stand/settle controls — the bots auto-play.
- Off-chain, **client-side only** (no gas, no server, no deployed package).
- Feed the bots' co-signed activity into the desktop's **live telemetry panels**.

## Non-goals

- Real on-chain settlement / wallet-funded bets (a clean seam is left for a later
  phase, but it is not built here).
- Draggable/resizable windows (the table scales into the fixed tile for now).
- Migrating the other sibling games to this pattern (Blackjack is the reference).
- Perfect casino-rule fidelity — the SDK protocol's simplified rules are
  authoritative (see "Rules" below).

## Decisions (locked with the user)

1. **Scope** — Replace the standalone client/server/shared/move packages with one
   self-contained game folder. Keep the game's own assets _inside_ the folder.
2. **Settlement realism** — Off-chain, client-side simulation. The bet is a number
   the player sets; nothing touches the chain.
3. **Session length** — Bots play round after round until one side can't cover the
   next wager (or `ROUND_CAP`), i.e. the protocol's natural terminal state.
4. **Bet model** — Symmetric: the single stake is the starting balance for _both_
   bots (`initialBalances = { a: stake, b: stake }`). The player "wins" iff bot A
   (the player-bot) ends at or above its starting stake.
5. **Engine driving** — Use the full `OffchainTunnel.selfPlay` so each transition is
   genuinely co-signed off-chain (not bare `Protocol` stepping). This is the truest
   "uses the tunnel SDK" and produces a signed-update stream for the panels.
6. **Keep the existing UI** — Port the presentational layer as-is; rewrite only the
   data layer.

## What gets deleted vs kept

The Explore inventory classified the existing `packages/client/src` cleanly.

**Port as-is (pure / props-driven):**

- `components/app/CardDisplay.tsx` (one minor edit, see "Card model bridge")
- `components/general/{LoadingModal,PageLoader,GameCardScale,SuitSpinner,Spinner}.tsx`
- `styles/globals.css` casino styles (`.casino-felt`, `.casino-chip`, `.text-gold`,
  `.gold-glow*`, `.menu-background`, `.fade-in-up`, `.suit-anim`) and the blackjack
  theme tokens from `tailwind.config.cjs` (gold `#d4af37`, mahogany `#2d1810`,
  felt gradient). These fold into the frontend's existing Tailwind v4 setup.
- Assets actually referenced in code: `cards/**` (52 SVGs), `dealer-desk.png`,
  `menu-background.png`, plus `card-back.png` (used for the optional hole card).
  Moved into `games/blackjack/assets/` and imported via Vite (game-local).

**Delete (server/chain-coupled):**

- `packages/server/**`, `packages/shared/**`, `packages/move/**`
- `hooks/useBlackJack.ts` (~885 lines: axios, BLS, chain, IndexedDB)
- `contexts/{CustomWallet,Balance,Authentication}.tsx`, all auth/lobby/admin pages,
  `docker-compose.yaml`, the duplicate build tooling (`bun.lock`, nested
  `tsconfig*`, `node_modules`, `dist`).

**Rewrite (keep markup, swap data source):**

- `pages/PlayerGame.tsx` → `BlackjackTable.tsx`: keep the layout (dealer-desk
  background, dealer hand top, player hand lower, bottom HUD, confetti on win) but
  read from `useBlackjackSession` instead of `useBlackJack`. Remove Hit/Stand/Settle.
- `pages/Player.tsx` setup → fold the stake input into a small `BetPanel`.

## Target folder layout

```
frontend/src/games/blackjack/
  index.ts                 register({ id:"blackjack", name:"Blackjack", icon:"🃏",
                                       Window: BlackjackWindow })
  BlackjackWindow.tsx       GameWindowProps entry; BetPanel (idle) ↔ table (playing),
                             wrapped in GameCardScale to fit the tiled window
  useBlackjackSession.ts    the driver hook (see below)
  cards.ts                  valueToCardIndex(value, drawSeq) + cardUrl(suit, name)
                             asset resolver (import.meta.glob over assets/cards)
  components/
    BlackjackTable.tsx      ported PlayerGame layout, fed by session view-state
    CardDisplay.tsx         ported as-is, hand total taken as a prop
    BetPanel.tsx            stake input + Deal; Reset/Play-again on terminal
    (LoadingModal, PageLoader, GameCardScale, SuitSpinner, Spinner ported)
  assets/
    cards/**, dealer-desk.png, menu-background.png, card-back.png
  README.md                 (exists; updated)
```

## Architecture & data flow

```
BetPanel.stake ─▶ useBlackjackSession(stake)
                    │  generate 2 ed25519 keypairs (core/keys ParticipantRegistry)
                    │  tunnel = OffchainTunnel.selfPlay(
                    │     new protocols.BlackjackProtocol(),
                    │     tunnelId, keyA, keyB, addrA, addrB,
                    │     { a: stake, b: stake })
                    │
                    ▼  timer tick (~600ms) while !protocol.isTerminal(tunnel.state):
                       by   = phase→party  (player→A, dealer→B, round_over→A)
                       move = protocol.randomMove(tunnel.state, by, rng)
                       if move == null → stop
                       tunnel.step(move, by)        // co-signs the new state
                       telemetry.bumpCounters(+1 update, +2 sig, +2 verify)
                       on a settled round → telemetry.pushTxn("Blackjack …", ±wager)
                    │
                    ▼  view-state derived from tunnel.state each tick:
                       { playerCards, dealerCards, playerSum, dealerSum,
                         playerBalance, dealerBalance, round, phase,
                         lastResult, isTerminal }
                    │
                    ▼  on terminal: settlement = tunnel.buildSettlement(now)
                       result = balanceA >= stake ? "player up" : "player down"

BlackjackTable renders the view-state (existing casino layout).
```

- **Whose turn**: derived purely from `state.phase`. `randomMove` already returns
  `null` for the wrong party / terminal, so the loop self-terminates.
- **Dealer auto-play** (`resolveDealer`) draws multiple cards atomically inside one
  `stand` step; the table animates it as a reveal at move granularity. Card-by-card
  dealer animation is out of scope.
- **Stepping** runs on the main thread via a timer; per-step work is tiny (one hash,
  two ed25519 signs/verifies). No Web Worker needed for a single table.

## Card model bridge

`CardDisplay` renders a card as an **index 0–51** (`suit*13 + rank` → real suit
SVG). The SDK `BlackjackState.{playerHand,dealerHand}` are arrays of card **values**
(Ace=11 pre-reduction, J/Q/K=10, else face), with no suit/rank.

`cards.ts` adds a pure `valueToCardIndex(value, drawSeq)`:

- picks a real **rank whose blackjack value equals `value`** (value 11 → Ace; value
  10 → one of 10/J/Q/K chosen by `drawSeq` for variety; 2–9 → that rank),
- picks a **suit** by `drawSeq % 4` (rotating).

Result: the existing `CardDisplay` renders unchanged with real card faces, and totals
remain authoritative because they are read from the SDK protocol, not recomputed.
The faces are cosmetic — a faithful rendering of the SDK's values, not a shuffled
deck.

`CardDisplay` gets two minimal edits, both to remove deleted dependencies:

1. It takes the hand total as a **prop** (the SDK's `handValue`) instead of importing
   the deleted `getCardSum`.
2. Because assets are now game-local (under `assets/cards/`, not the shared
   `public/`), its dynamic `/cards/{suit}/{suit}-{name}.svg` path string is routed
   through a `cardUrl(suit, name)` helper that resolves the bundled URL via
   `import.meta.glob("./assets/cards/**/*.svg", { eager: true })`. The card layout/
   markup is otherwise unchanged.

Optional casino touch: hide the dealer's second card with `card-back.png` while
`phase !== "round_over"`, revealed on resolution. Cosmetic; can ship in a follow-up.

## Browser-safety: the `node:crypto` import

`OffchainTunnel` statically imports `core/crypto-native.ts`, whose top line is
`import * as nc from "node:crypto"` (and uses `Buffer`). At runtime it auto-falls
back to `@noble` in the browser (`nativeBackendSupported()` try/catches the
`createPrivateKey` failure), but the **static** import would still break the Vite
bundle.

Fix lives entirely in the frontend, leaving the upstream SDK untouched (so it can be
re-synced): add a Vite `resolve.alias` mapping `node:crypto` to a tiny local stub
module (an empty/throwing shim). `nativeBackendSupported()` then returns `false` and
the engine uses pure-JS `@noble` — correct and browser-safe. The stub lives at
`frontend/src/shims/node-crypto.ts`; the alias is added in `vite.config.ts` (and the
type path is harmless since the SDK is type-only there today).

## Telemetry feed to the live panels

The panels (`LiveTransactionsFeed`, `SystemDashboard`, `TpsChart`,
`TransactionLog`, `RecentDeposits`) consume a `panels/types.ts:TelemetrySnapshot`.
Today `Desktop.tsx` hardcodes `PLACEHOLDER_SNAPSHOT`; the type's own doc comment
says to replace it with a live source, not by editing panels.

- New `frontend/src/telemetry/TelemetryProvider.tsx` exposes `useTelemetry()` →
  `{ snapshot, report }`. Mounted in `App.tsx` **above** `Desktop` so both the aside
  panels and the game windows share it.
- `snapshot` is seeded from `PLACEHOLDER_SNAPSHOT` so the shell still looks populated
  before any play, then updated live.
- Writer API: `pushTxn(row)`, `bumpCounters(delta)`, `setActive(n)`. `rate` is
  computed with the SDK's `telemetry.Counters` + `rateReport(counters, elapsedSec)`
  for fidelity. Each `tunnel.step` contributes 1 update + 2 signatures + 2
  verifications.
- **Bounded**: `txns` capped to the most recent ~12, `tpsSeries` to ~20. No unbounded
  growth.
- `Desktop.tsx` reads `useTelemetry().snapshot` instead of importing the placeholder.
- `useBlackjackSession` calls the writer on each step and each settled round.

Other games can adopt the same writer later; wiring them is out of scope here.

## Rules (authoritative = the SDK protocol)

From `protocol/blackjack.ts`: two-party dealerless blackjack. `WAGER = 100n` fixed
per round. A round begins only while both sides hold `>= WAGER`; otherwise the game
is terminal (also terminal after `ROUND_CAP = 1000`). Cards come from a deterministic
per-round seed (`blake2b256(domain || round)`), so both parties agree on every draw.
Player (A) draws to a basic-strategy threshold; dealer (B) auto-draws to ≥17. Winner
takes the wager (clamped to the loser's balance), so balances never go negative and
always sum to the locked total. The UI never re-implements any of this.

## Testing

- `useBlackjackSession` driver logic is unit-tested with `node:test` (the repo's TS
  runner): a fixed seed drives the tunnel to a terminal state; assert the session
  reaches terminal, balances are conserved (`a + b == 2 * stake`), and
  `tunnel.buildSettlement` produces a co-signed update that `verifyCoSignedUpdate`
  accepts. The session's step/derive logic is factored into pure functions so it
  tests without React or timers.
- `valueToCardIndex` is unit-tested: every produced index maps back to a rank whose
  blackjack value equals the input value; suits rotate.
- The `BlackjackProtocol` itself is already covered by the SDK's own tests — not
  re-tested here.
- `pnpm typecheck` (frontend) must pass; the Vite build must resolve `node:crypto`
  via the stub.

## Risks / known limitations

- **Tile size**: the casino table renders small in the ~16rem desktop tile until
  drag/resize lands. `GameCardScale` keeps it legible; not a blocker.
- **Card faces are cosmetic** (derived from SDK values), by design.
- **Vite stub** must be kept in sync if the SDK changes its crypto backend entry
  point; documented inline in the stub and vite config.
- Porting `globals.css` into a Tailwind v4 project may need minor token reconciliation
  (the old client used a Tailwind v3 `tailwind.config.cjs`); the casino classes are
  plain CSS and should drop in.

## Open follow-ups (not in this work)

- On-chain settlement seam (fund the bet from the connected wallet, settle on Sui).
- Migrate sibling games to the same Protocol + telemetry writer.
- Card-by-card dealer reveal animation; draggable/resizable windows.
