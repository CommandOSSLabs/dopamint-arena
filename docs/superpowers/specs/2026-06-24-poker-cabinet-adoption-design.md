# Quantum Poker — attract/take-over cabinet adoption (design)

**Goal:** Adopt the shared arcade cabinet (PR #46 / ADR-0012) for Quantum Poker
so the poker window boots into a living bot-vs-bot **attract** demo and a human
can **take over** seat A in the *same* tunnel (cosmetic, instant feel), exactly
like Tic-Tac-Toe. PvP / Find Match stays outside the cabinet (spec §6).

## Decisions (locked)

- **Approach A — cosmetic take-over.** Take-over hands the human seat A of the
  *ongoing watch-bot tunnel* (still `OffchainTunnel.selfPlay`, both bot keys —
  the human's moves are co-signed as seat A's bot key). No new tunnel.
- **Engine = the watch-bot** (`useQuantumPokerAuto`), extended in place. It keeps
  its TPS machinery (recycle, ~16 ms render-throttle, instant moves) for attract
  and gains a manual (take-over) mode.
- **Take-over stack = seat A's LIVE balance** at the moment of take-over (it
  started at the watch-bot's 1M stake but has drifted with the bot's play). No
  reset.
- **Take-over timing = next-hand boundary.** The current bot-driven hand finishes;
  from the next hand the human plays seat A.
- **Retire the standalone PvBot lane** — `useQuantumPokerBot` +
  `QuantumPokerWindow` + the mode-menu "Play vs Bot" button are removed; the
  cabinet take-over is now the only "play vs bot". The sketchy table
  (`QuantumPokerTable`) and `PokerActionBar` are **reused** for the live view.
- **PvP unchanged**, reached by a "Find PvP Match" button (outside the cabinet).

## Cabinet contract (from ADR-0012, unchanged)

```ts
interface CabinetController {
  active: boolean;   // true only while attract is offerable (auto + playing + funded)
  pause(): void;     // hover-freeze the auto loop (latch)
  resume(): void;    // unfreeze
  takeOver(): void;  // hand seat A to the human
  returnHome(): void;// leave the live game, back to attract
}
```
Registered via `useRegisterCabinet(controller)`; the desktop already wraps every
game window in `<GameCabinet>`, so no window-wrapper change is needed.

## Shell state machine (shell-owned, unchanged)

`attract` → hover → `inviting` (paused + overlay) → **Play vs Bot** → `live`;
`inviting` → unhover / Return-to-Home → `attract`; `live` → Home → `attract`.

## Units touched

### 1. `useQuantumPokerAuto.ts` — attract + take-over engine
- Add `auto: boolean` (default **true**) + `setAuto(on)`. `true` = bot-vs-bot
  attract (recycle on); `false` = human plays seat A, recycle **off**.
- Manual play: when `!auto`, drive the loop with `stepPokerWithHuman` (seat A =
  human, seat B = bot); add `act(move)`, `legal`, `secondsLeft` + the per-turn
  countdown — ported from the retired `useQuantumPokerBot`.
- `takeOver` = `setAuto(false)`; it latches and takes effect at the next
  `hand_over → next_hand` boundary (the in-flight hand finishes bot-driven).
- `returnHome` = `setAuto(true)` → the bot resumes seat A and recycle continues
  (the tunnel is never abandoned; cosmetic).
- `pause()/resume()` = a `pausedRef` latch read at the top of the loop tick
  (hover-freeze); no timer teardown.
- Recycle guard: only auto-reopen the next tunnel when `auto` is true.
- Expose `auto, setAuto, act, legal, secondsLeft, pause, resume, paused` on the
  hook view + snapshot.

### 2. `QuantumPokerBotVsBotWindow.tsx` — the cabinet lane window
- Build a `CabinetController` from the hook's stable callbacks and
  `useRegisterCabinet(controller)`. `active = funded && auto && playing`.
- Render `QuantumPokerTable` for both attract and live. When live + the human's
  turn, render `PokerActionBar` + the turn timer (reusing PR #52's shared UI).
- Keep the wallet gate (attract needs a connected wallet to stake); when not
  funded, `active=false` (cabinet inert).
- Add a small "Find PvP Match" affordance that routes to the PvP lane.

### 3. Retire the standalone PvBot lane
- Delete `useQuantumPokerBot.ts` and `QuantumPokerWindow.tsx`.
- `QuantumPokerModeWindow.tsx`: drop the "Play vs Bot" button + the `bot` mode;
  default to the attract (auto) lane; keep only the route to PvP.

## On-chain / honesty

Take-over is **cosmetic**: the tunnel stays `selfPlay` with both bot keys, so the
human's seat-A moves settle as the bot seat. This matches ADR-0012; genuine
ephemeral-key you-vs-bot is out of scope (future ADR-0010+ work).

## Out of scope / non-goals

- Real you-vs-bot identity (ephemeral key) — deferred.
- PvP inside the cabinet — PvP stays a separate lane (spec §6).
- Changing the watch-bot's TPS tuning (stake, render-throttle, recycle cadence).
