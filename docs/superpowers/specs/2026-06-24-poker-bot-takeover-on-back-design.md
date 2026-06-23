# PvBot bot-takeover on Back (without settle) — design

**Goal:** In Quantum Poker PvBot, when the human clicks **Back** (to the menu)
without settling, a bot takes over the human's seat and the match keeps playing
in the background until a seat busts → it auto-settles (closes the tunnel).
Replaces today's behaviour where the abandoned seat just turn-timer-auto-folds
and the tunnel is left open forever.

**Scope:** PvBot only (`useQuantumPokerBot`). PvP is deferred — `usePvpQuantumPoker`
is a plain component hook, not a background store, so it can't run after unmount;
making it run in the background needs a separate store refactor.

## Why it works with the existing code

- `BotSession` already lives in a `Map` behind `useSyncExternalStore`, so it keeps
  running after the window navigates to the menu (it's only disposed on real
  window close).
- The `drive` loop already plays seat B with a kit bot; the same `PokerSeatBot`
  (used by PvP's `auto` mode) can drive seat A.
- A cooperative close already exists (`settle` → `settlePokerTunnel`).

## Behaviour

1. **Trigger:** the PvBot window's **Back** action calls a new
   `handOffToBot()` on the session, then navigates to the menu. (The existing
   **Settle** button is unchanged — it still cooperatively closes immediately.)
2. **Takeover:** `handOffToBot()` sets `humanLeft = true` and re-kicks the drive
   loop if it was parked waiting for the human. From then on, whenever it is seat
   A's turn, the loop plays the kit bot's move instead of arming the turn timer.
   The match becomes bot-vs-bot, running in the background.
3. **End — bust → settle:** when a seat can no longer cover the ante (busts), the
   loop stops dealing new hands and calls the existing cooperative `settle`,
   closing the tunnel. No rebuy / no new tunnel (matches "until settle or bust").
4. If the human comes Back to the same window before it settled, they see the
   match still in progress (bot playing their seat) and can hit **Settle**.

## Units touched

- `useQuantumPokerBot.ts` — add `humanLeft` flag + `handOffToBot()`; in `drive`,
  branch seat-A turns to the kit bot when `humanLeft`; add bust detection →
  `settle`. Build a `PokerSeatBot` for seat A (mirror PvP's `autoBotRef`).
- `QuantumPokerWindow.tsx` — Back calls `game.handOffToBot()` before `onExit()`.

## Out of scope / non-goals

- PvP takeover (separate store refactor).
- Rebuy-after-bust (this feature settles on bust).
- Changing the Settle button or the turn timer for a present human.
