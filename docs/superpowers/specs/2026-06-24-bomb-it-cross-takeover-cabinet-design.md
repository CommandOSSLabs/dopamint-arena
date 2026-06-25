# Bomb It & Chicken Cross — Take-over cabinet adoption — Design

> **Type:** design spec
> **Date:** 2026-06-24
> **Status:** approved (design), pre-implementation
> **Scope:** Make **bomb-it** and **chicken-cross** adopt the shared attract-mode
> take-over **cabinet** UX introduced for tic-tac-toe in PR #46 (`GameCabinet` /
> `CabinetController`), so the two games match the arena UX standard while keeping
> their own 2D-arcade board visuals. Take-over is cosmetic on-chain (self-play
> tunnel), consistent with PR #46 / ADR-0012. No SDK, Move, PvP, or Desktop changes.
> **Lands on:** PR #43 (`fix/bomb-it-gas-parity`).

## Background

PR #46 shipped the **attract-mode take-over cabinet**: an unattended self-play
game window auto-plays itself (_attract_); hovering freezes the frame and offers
**Play vs Bot** (_inviting_); taking the seat hands the human control while the
bot plays the other seat (_live_); **Return to Home** sends the game back to its
own title screen. The behavior lives in **one shared shell** —
`frontend/src/shell/cabinet/` (`GameCabinet`, `CabinetController`,
`TakeOverOverlay`, the `attract → inviting → live` reducer) — so each game opts
in cheaply and supplies only a 5-member controller.

PR #46's body scoped bomb-it / chicken-cross **out**, on the premise they were
"TPS benches — no human-play mode." PR #43 invalidated that premise: both games
now have a real human solo mode (out-of-React session, manual seat, running
score, settle-anytime). The cabinet seam's own design spec
(`2026-06-23-arena-attract-takeover-shell-design.md`) always listed
"bomb-it / chicken-cross's `HumanSeat`" as an intended adopter — PR #46 simply
shipped tic-tac-toe first. The maintainer's standing instruction is that every
game keeps its **own UI** but must follow **this UX**. This spec closes that gap
for the two PR #43 games.

### What already exists (no work needed)

Both games are at battleship parity on the session/control layer:

- Out-of-React `BotSession` kept in a `Map<windowId, …>`, subscribed via
  `useSyncExternalStore`, disposed via `registerWindowDisposer` → survives
  minimize/maximize/remount.
- `auto` flag + `toggleAuto()` (bot self-play ⇄ human manual seat).
- Multi-game-per-tunnel with running `score`, `gamesPlayed`, and `settleNow()`.
- Manual seat already wired: keyboard → `queueAction` (bomb-it) / `setDir`
  (chicken-cross) → consumed one move per tick.
- Auto-start solo on wallet-connect; a solo/pvp **mode chooser** as the game's
  home screen.
- Per-game kits (`agent/games/{bombIt,chickenCross}/kit.ts`) whose `bot.plan()`
  wraps `protocol.randomMove` — identical to what the solo loop already runs.

### What is missing (the gap)

One primitive and one wiring:

1. **Pausable engine** — neither `BombBotSession` nor `CrossBotSession` can
   freeze mid-run and resume. The cabinet calls `pause()` on hover and
   `resume()` on un-hover.
2. **Cabinet registration** — neither `BombItWindow` nor `ChickenCrossWindow`
   wraps itself in `GameCabinet` or registers a `CabinetController`.

### What stays out of scope

- **Genuine you-vs-bot channel** (fresh tunnel, human zkLogin party A,
  ephemeral bot seat B, sponsored). Deferred exactly as PR #46 deferred it.
- **Kit rerouting.** The solo loop keeps `protocol.randomMove`; routing through
  `GAME_KITS[id].bot.plan()` is behaviorally identical for these random-bot
  games and would be pure churn (unlike ttt, which had a bespoke minimax picker
  to dedup).
- **SDK / Move / `Desktop.tsx` / PvP** — untouched.
- **Board / overlay restyling.** The shared `TakeOverOverlay` is reused as-is
  (the UX); each game's 2D board stays (the UI).

## Decisions

Resolved during brainstorming:

1. **Take-over is cosmetic on-chain** — the solo tunnel co-signs both seats from
   the same keys, so settlement stays self-play even while a human steers seat A.
   Matches PR #46 / ADR-0012. Recorded in a short ADR that references 0012's
   deferral, plus a line in the PR body.
2. **Return to Home → the solo/pvp mode chooser** — stop auto, reset the solo
   session, show the game's own chooser. Mirrors ttt returning to its title.
3. **Auto-move source stays `protocol.randomMove`** — see out-of-scope above.

## Architecture

The cabinet contract (from PR #46) is three layers; bomb-it and chicken-cross
each implement the same shape. Tic-tac-toe's `games/ticTacToe/app/App.tsx`
(lines ~68–92) is the reference.

### Layer 1 — Pausable engine (`useBombItSession.ts` / `useChickenCrossSession.ts` + session classes)

Add a pause latch to each `BotSession` class:

- A `paused` boolean field (read live by the advance loop, like `auto` is read
  live each frame today).
- The advance loop checks it at the top of each scheduled tick: when paused, it
  stops scheduling the next tick (does **not** co-sign) and returns. State is
  left exactly where it was — pause is freeze-in-place, not stop.
- `pause()` sets the latch. `resume()` clears it and **re-kicks** the advance
  loop, reusing the existing re-kick path that `toggleAuto` already uses
  (`useBombItSession` re-kick at ~line 589, `useChickenCrossSession` ~line 579).
- Pause must be re-entry safe with the existing `gen` guard: resuming must not
  spawn a second concurrent loop. Use the same generation check the loop
  already performs.

Expose on the session interface:

```ts
interface BombItSession {
  // and ChickenCrossSession, symmetric
  /* …existing… */
  paused: boolean;
  pause(): void;
  resume(): void;
}
```

`settleNow()` / `reset()` keep their current stop semantics (the `gen` bump);
pause is orthogonal and never settles.

### Layer 2 — Attract on open (`BombItWindow.tsx` / `ChickenCrossWindow.tsx`)

Auto-start solo already runs on wallet-connect. Ensure the auto-started session
begins with `auto = true` (bot self-play) so an unattended window is in the
attract state. If auto-start currently lands in manual, set the initial auto on
for the auto-start path only (an explicit user "Play" from the chooser may still
start however it does today — verify during implementation).

### Layer 3 — Register the cabinet (`BombItWindow.tsx` / `ChickenCrossWindow.tsx`)

Wrap the **solo** render subtree in `<GameCabinet>` (it provides the
`CabinetRegistry` context, renders the shared `TakeOverOverlay` in the
_inviting_ state and the ⌂ Home control in _live_). The cabinet is rendered by
the game's own Window component (self-contained, like ttt's App) — the desktop
shell is untouched. Place `<GameCabinet>` so its hover root covers the board
play surface inside the existing `GameWindow` chrome.

Build a memoized `CabinetController` and register it:

```ts
const offerable = scene === "solo" && solo.status === "playing" && solo.auto;

const takeOver = useCallback(() => {
  if (solo.auto) solo.toggleAuto(); // hand seat A to the human
  solo.resume(); // unfreeze if hover paused it
}, [solo.auto, solo.toggleAuto, solo.resume]);

const returnHome = useCallback(() => {
  solo.reset(); // stop auto + clear session
  setMode(null); // back to the solo/pvp chooser
}, [solo.reset]);

const cabinet = useMemo<CabinetController>(
  () => ({
    active: offerable,
    pause: solo.pause,
    resume: solo.resume,
    takeOver,
    returnHome,
  }),
  [offerable, solo.pause, solo.resume, takeOver, returnHome],
);

useRegisterCabinet(cabinet);
```

`active` is true only while the game auto-plays in the solo scene — so the shell
stays inert in the chooser, in pvp, and after a take-over (when `auto` is off).
The shell owns every hover/overlay/state-machine transition; the games add zero
overlay code.

## Per-game specifics

- **bomb-it** — manual move enters via `queueAction(BombItAction)` (keyboard
  arrows/WASD + space). `takeOver` flips to manual and the existing keyboard
  path drives seat A; the bot plays B. Reaction-paced (`SOLO_STEP_MS = 120`)
  cadence unchanged.
- **chicken-cross** — manual move enters via `setDir(CrossDir)`. Otherwise
  symmetric. Frame-budget batched stepping unchanged; pause simply halts the
  batch loop between frames.

Both keep their `role="A"` solo seat and their 2D board components
(`BombBoard` / `CrossBoard`) unchanged — no board-prop changes are required,
because the overlay and Home control are rendered by `GameCabinet`, outside the
board.

## Error handling

- **Pause during funding/settling/error** — `pause()`/`resume()` are no-ops
  unless `status === "playing"`; `active` already gates the shell to `playing`,
  so the overlay can't appear off-play. Guard `pause`/`resume` defensively
  anyway (best-effort, matching the cabinet's "no-op when not mid-play"
  contract).
- **Take-over mid-frame** — flipping `auto` off is already safe mid-run (read
  live each frame); the bot finishes the current tick attribution, the human
  drives from the next manual tick.
- **Return Home during settle** — `reset()` after a `settleNow()` in flight must
  not double-settle; rely on the existing `gen` guard. Verify the ordering in
  implementation.

## Testing strategy

- **Unit (co-located `*.test.ts`)** — for each session: `pause()` stops the loop
  ticking (tick/move count frozen across a scheduler turn), `resume()` continues
  from the same state (no rewind, no skipped settlement), and pause/resume is
  idempotent + re-entry safe (no double loop). Name by behavior.
- **Reuse** the shared `seatControlState` reducer tests (already green) — the
  state machine is unchanged, so no new reducer tests.
- **In-browser walk (both games)** — attract self-play → hover freezes the frame
  - overlay appears → **Play vs Bot** → keyboard drives seat A, bot plays B →
    **Return to Home** → solo/pvp chooser. Plus: minimize/maximize during _live_
    preserves the human game (session survival already covered, re-verify).
- **Gate** — `pnpm typecheck` 0 · `pnpm build` OK · existing session-core +
  protocol tests green. No SDK/Move test changes expected.

## File structure

Touched:

- `frontend/src/games/bombIt/useBombItSession.ts` — pause latch + `pause`/
  `resume`/`paused` on the session.
- `frontend/src/games/bombIt/session-core.ts` — only if the advance-loop pause
  check belongs in the pure core (decide in implementation; prefer keeping the
  latch in the session class if the loop lives there).
- `frontend/src/games/bombIt/BombItWindow.tsx` — `GameCabinet` wrap + controller
  - attract-on-open auto.
- `frontend/src/games/bombIt/useBombItSession.test.ts` (or session-core test) —
  pause/resume unit tests.
- `frontend/src/games/chickenCross/useChickenCrossSession.ts` — symmetric.
- `frontend/src/games/chickenCross/session-core.ts` — symmetric (if needed).
- `frontend/src/games/chickenCross/ChickenCrossWindow.tsx` — symmetric.
- `frontend/src/games/chickenCross/useChickenCrossSession.test.ts` — symmetric.
- `docs/decisions/0013-bomb-it-cross-takeover-cabinet.md` — short ADR referencing
  0012's cosmetic-take-over deferral for these two games. (0012 arrives with the
  step-0 rebase; 0013 is the next free number on the integrated branch.)
- The PR #46 new-game checklist / cabinet pointer — confirm bomb-it +
  chicken-cross are now listed as cabinet adopters.

Prerequisite (not a code change): **rebase the branch onto `origin/dev`** to pull
in the cabinet commit (`a412c0c`) — `frontend/src/shell/cabinet/` does not exist
on the branch otherwise.

Not touched: any `sui-tunnel-ts/` SDK, Move, `frontend/src/desktop/`, the PvP
path, the board components' rendering, the shared `shell/cabinet/` internals.

## Self-review notes (coverage)

- **Premise conflict surfaced** — PR #46's "no human-play mode" exclusion is
  explicitly invalidated by PR #43 and recorded above, so a reviewer reading
  both PRs sees why the scope changed.
- **Cosmetic-take-over honesty** — stated in Decisions + Error handling +
  carried into an ADR, not hidden.
- **No board-prop churn** — overlay/Home come from `GameCabinet`, so
  `BombBoard`/`CrossBoard` signatures are untouched; reviewers won't expect board
  diffs.
- **Pause re-entry** — called out as the one correctness risk (double loop on
  resume) and tied to the existing `gen` guard.
