# Bomb It & Chicken Cross Take-over Cabinet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make bomb-it and chicken-cross adopt the shared attract-mode take-over cabinet UX (PR #46) by registering a `CabinetController` and adding a pause/resume primitive to each solo session, keeping their own board visuals.

**Architecture:** The Desktop already wraps every game window in `<GameCabinet>` (the shell that owns hover → pause → overlay → `attract→inviting→live`). Each game opts in by calling `useRegisterCabinet(controller)` from inside its window with five verbs (`active`, `pause`, `resume`, `takeOver`, `returnHome`). The only new engine primitive is a `paused` latch on each out-of-React `BotSession` that freezes its advance loop. The controller-building logic is shared in one tested helper (`src/shell/cabinet/soloCabinet.ts`) since both games are identical. Take-over is cosmetic on-chain (the solo tunnel co-signs both seats), matching ttt/ADR-0012.

**Tech Stack:** React + TypeScript (Vite), `node:test` via `tsx` (frontend test runner), pnpm.

## Global Constraints

- **Toolchain:** frontend uses **pnpm**, **prettier**, **`node:test` via `tsx`**. Do NOT introduce bun/vitest/jest. Run from `frontend/`.
- **Gate (must pass before done):** `pnpm typecheck` (0 errors) · `pnpm build` OK · `pnpm test` green.
- **No changes** to `sui-tunnel-ts/` (SDK), Move, `frontend/src/desktop/`, the PvP path, the board components' rendering, or `frontend/src/shell/cabinet/` internals (consume them, don't edit).
- **Take-over is cosmetic on-chain** — never imply genuine you-vs-bot stakes in copy, ADR, or comments.
- **Cabinet controller verbs must be stable** (`useCallback`/`useMemo`); rebuild the controller only when `active`/`auto` flips, else it re-registers every render.
- **Conventional Commits**, subject ≤ 50 chars, imperative, no AI attribution, one logical change per commit.
- The human always sits in **seat A** for solo; the bot plays **seat B**.

---

### Task 1: Rebase the branch onto `origin/dev` (bring in the cabinet)

The cabinet code (`frontend/src/shell/cabinet/`, the Desktop `<GameCabinet>` wrap, `seatControlState`, ADR-0012) lives in commit `a412c0c`, the single commit this branch is behind. Nothing else in the plan compiles without it.

**Files:** none created/modified by hand; this is a git operation that may require conflict resolution.

**Interfaces:**
- Produces (for all later tasks): `@/shell/cabinet/CabinetController` (`CabinetController` interface), `@/shell/cabinet/CabinetContext` (`useRegisterCabinet`), `@/shell/cabinet/GameCabinet` (already rendered by Desktop), `@/shell/seatControlState`.

- [ ] **Step 1: Confirm starting point**

Run: `cd frontend && git --no-pager log --oneline -1 && git --no-pager log --oneline origin/dev -1`
Expected: HEAD is the spec commit (`docs(arena): spec …`); `origin/dev` top is `a412c0c feat(arena): attract-mode take-over cabinet`.

- [ ] **Step 2: Rebase onto dev**

Run: `git fetch origin dev && git rebase origin/dev`
Expected: either "Successfully rebased" or a conflict to resolve.

- [ ] **Step 3: Resolve conflicts if any (preserve BOTH sides)**

Likely conflict points and the resolution rule:
- `frontend/src/desktop/Desktop.tsx` — keep dev's `<GameCabinet>` wrap **and** this branch's bomb-it/cross window registration/auto-start.
- `docs/adding-a-tunnel-game.md` (or the new-game checklist) — keep both the cabinet pointer (dev) and any branch additions.
- `docs/decisions/` — both sides only add files; keep all.
For each conflict: edit to include both intents, then `git add <file>` and `git rebase --continue`.

- [ ] **Step 4: Verify the cabinet is present and the tree builds**

Run: `ls frontend/src/shell/cabinet/ && cd frontend && pnpm install && pnpm typecheck && pnpm build`
Expected: `CabinetContext.tsx CabinetController.ts GameCabinet.tsx TakeOverOverlay.tsx` listed; typecheck 0 errors; build OK.

- [ ] **Step 5: No commit**

Rebase already rewrote history; there is nothing to commit here. Proceed.

---

### Task 2: Make the test runner include `shell/` and the two games

The `frontend` `test` script globs omit `src/shell/**`, `src/games/bombIt/**`, and `src/games/chickenCross/**`, so the existing `seatControlState.test.ts` (PR #46) and the two `session-core.test.ts` files (PR #43) never run in CI — and neither would the new tests in Task 3. Fix the glob.

**Files:**
- Modify: `frontend/package.json:12` (the `test` script)

**Interfaces:**
- Produces: a `pnpm test` that runs `src/shell/**`, `src/games/bombIt/**`, `src/games/chickenCross/**`.

- [ ] **Step 1: Show the orphaned tests are not run today**

Run: `cd frontend && pnpm test 2>&1 | grep -c -E 'seatControlState|bombIt/session-core|chickenCross/session-core' || true`
Expected: `0` (none of those names appear — they aren't collected).

- [ ] **Step 2: Add the missing globs to the `test` script**

In `frontend/package.json`, the current line 12 is:

```json
    "test": "node --import tsx --test \"src/agent/**/*.test.ts\" \"src/components/**/*.test.ts\" \"src/backend/**/*.test.ts\" \"src/pvp/**/*.test.ts\" \"src/games/blackjack/*.test.ts\" \"src/games/battleship/**/*.test.ts\" \"src/games/ticTacToe/tttColdLoad.test.ts\" \"src/games/quantumPoker/**/*.test.ts\"",
```

Replace it with (adds three globs at the end, before the closing quote):

```json
    "test": "node --import tsx --test \"src/agent/**/*.test.ts\" \"src/components/**/*.test.ts\" \"src/backend/**/*.test.ts\" \"src/pvp/**/*.test.ts\" \"src/shell/**/*.test.ts\" \"src/games/blackjack/*.test.ts\" \"src/games/battleship/**/*.test.ts\" \"src/games/bombIt/**/*.test.ts\" \"src/games/chickenCross/**/*.test.ts\" \"src/games/ticTacToe/tttColdLoad.test.ts\" \"src/games/quantumPoker/**/*.test.ts\"",
```

- [ ] **Step 3: Verify the previously-orphaned tests now run and pass**

Run: `cd frontend && pnpm test 2>&1 | grep -E 'seatControlState|session-core' | head`
Expected: those test names now appear; run exits 0 (all pass). If any pre-existing test fails, it is a latent bug surfaced by enabling it — stop and report, do not silently re-disable.

- [ ] **Step 4: Commit**

```bash
git add frontend/package.json
git commit -m "test(frontend): run shell + bomb-it + cross suites"
```

---

### Task 3: Shared solo-cabinet controller helper (TDD)

Both windows need identical controller logic. Extract it into one tested module so the wiring is proven once and DRY.

**Files:**
- Create: `frontend/src/shell/cabinet/soloCabinet.ts`
- Test: `frontend/src/shell/cabinet/soloCabinet.test.ts`

**Interfaces:**
- Consumes: `CabinetController` from `./CabinetController`, `useRegisterCabinet` from `./CabinetContext`.
- Produces (used by Tasks 5 & 7):
  - `isSoloOfferable(mode: "solo" | "pvp" | null, status: string, auto: boolean): boolean`
  - `soloCabinetController(args: { offerable: boolean; auto: boolean; pause(): void; resume(): void; toggleAuto(): void; goHome(): void }): CabinetController`
  - `useSoloCabinet(session: SoloCabinetSession, mode: "solo" | "pvp" | null, goHome: () => void): void`
  - `interface SoloCabinetSession { status: string; auto: boolean; pause(): void; resume(): void; toggleAuto(): void }`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/shell/cabinet/soloCabinet.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isSoloOfferable, soloCabinetController } from "./soloCabinet";

test("take-over is offerable only in solo mode, playing, on auto", () => {
  assert.equal(isSoloOfferable("solo", "playing", true), true);
  assert.equal(isSoloOfferable("solo", "playing", false), false); // already took over
  assert.equal(isSoloOfferable("pvp", "playing", true), false);
  assert.equal(isSoloOfferable(null, "playing", true), false);
  assert.equal(isSoloOfferable("solo", "funding", true), false);
  assert.equal(isSoloOfferable("solo", "settled", true), false);
});

test("controller.active mirrors offerable", () => {
  const verbs = { pause() {}, resume() {}, toggleAuto() {}, goHome() {} };
  assert.equal(
    soloCabinetController({ offerable: true, auto: true, ...verbs }).active,
    true,
  );
  assert.equal(
    soloCabinetController({ offerable: false, auto: true, ...verbs }).active,
    false,
  );
});

test("takeOver flips auto off then unfreezes, in that order", () => {
  const calls: string[] = [];
  const c = soloCabinetController({
    offerable: true,
    auto: true,
    pause: () => calls.push("pause"),
    resume: () => calls.push("resume"),
    toggleAuto: () => calls.push("toggleAuto"),
    goHome: () => calls.push("home"),
  });
  c.takeOver();
  assert.deepEqual(calls, ["toggleAuto", "resume"]);
});

test("takeOver does NOT re-toggle when already manual — only resumes", () => {
  const calls: string[] = [];
  const c = soloCabinetController({
    offerable: false,
    auto: false,
    pause() {},
    resume: () => calls.push("resume"),
    toggleAuto: () => calls.push("toggleAuto"),
    goHome() {},
  });
  c.takeOver();
  assert.deepEqual(calls, ["resume"]);
});

test("returnHome delegates to goHome", () => {
  let homed = false;
  const c = soloCabinetController({
    offerable: true,
    auto: true,
    pause() {},
    resume() {},
    toggleAuto() {},
    goHome: () => {
      homed = true;
    },
  });
  c.returnHome();
  assert.equal(homed, true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && pnpm test 2>&1 | grep -A2 soloCabinet | head`
Expected: FAIL — `Cannot find module './soloCabinet'`.

- [ ] **Step 3: Implement the helper**

Create `frontend/src/shell/cabinet/soloCabinet.ts`:

```ts
import { useMemo } from "react";
import type { CabinetController } from "./CabinetController";
import { useRegisterCabinet } from "./CabinetContext";

/** A window's top-level mode; solo is the only cabinet-offerable one. */
export type WindowMode = "solo" | "pvp" | null;

/** The slice of a solo session the cabinet drives. Both game sessions satisfy it structurally. */
export interface SoloCabinetSession {
  status: string;
  auto: boolean;
  pause(): void;
  resume(): void;
  toggleAuto(): void;
}

/**
 * Take-over is offerable only while the window shows solo AND the self-play loop
 * is actually running on auto — never in the lobby, pvp, funding/settling, or
 * after a take-over (auto off). Mirrors ttt's `scene === "game" && g.auto`.
 */
export function isSoloOfferable(
  mode: WindowMode,
  status: string,
  auto: boolean,
): boolean {
  return mode === "solo" && status === "playing" && auto;
}

/**
 * Build the five-verb controller. `takeOver` flips the loop to the human seat —
 * only when currently auto, so a stray call can't re-enable auto — then unfreezes
 * a hover-pause. Settlement stays self-play on-chain; take-over is cosmetic
 * (ADR-0013).
 */
export function soloCabinetController(args: {
  offerable: boolean;
  auto: boolean;
  pause(): void;
  resume(): void;
  toggleAuto(): void;
  goHome(): void;
}): CabinetController {
  return {
    active: args.offerable,
    pause: args.pause,
    resume: args.resume,
    takeOver: () => {
      if (args.auto) args.toggleAuto();
      args.resume();
    },
    returnHome: args.goHome,
  };
}

/**
 * Register a game window's solo session with the enclosing `<GameCabinet>`
 * (Desktop wraps every window). Call once near the top of the window component,
 * before any early return — it is a hook. `goHome` MUST be stable (useCallback in
 * the caller) so the controller doesn't re-register every render.
 */
export function useSoloCabinet(
  session: SoloCabinetSession,
  mode: WindowMode,
  goHome: () => void,
): void {
  const { status, auto, pause, resume, toggleAuto } = session;
  const offerable = isSoloOfferable(mode, status, auto);
  const controller = useMemo<CabinetController>(
    () =>
      soloCabinetController({
        offerable,
        auto,
        pause,
        resume,
        toggleAuto,
        goHome,
      }),
    [offerable, auto, pause, resume, toggleAuto, goHome],
  );
  useRegisterCabinet(controller);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && pnpm test 2>&1 | grep -E 'soloCabinet|pass|fail' | head`
Expected: the 5 soloCabinet tests PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
cd frontend && pnpm typecheck && cd ..
git add frontend/src/shell/cabinet/soloCabinet.ts frontend/src/shell/cabinet/soloCabinet.test.ts
git commit -m "feat(cabinet): shared solo controller + offerable gate"
```

---

### Task 4: Bomb-it session — pause/resume latch

Add the freeze primitive to `BombBotSession` and expose `pause`/`resume` on the hook.

**Files:**
- Modify: `frontend/src/games/bombIt/useBombItSession.ts` (interface ~77–95, field block ~167–174, `advance` while-loop ~315, after `toggleAuto` ~590, `start` reset block ~388–393, hook return ~643–657)

**Interfaces:**
- Consumes: nothing new.
- Produces: `BombItSession.pause(): void` and `BombItSession.resume(): void` (used by Task 5). Session field `private paused` (internal).

- [ ] **Step 1: Add `pause`/`resume` to the `BombItSession` interface**

In the `export interface BombItSession` block, after `settleNow: () => void;` add:

```ts
  /** Freeze the self-play loop in place (cabinet hover). No-op unless mid-play. */
  pause: () => void;
  /** Unfreeze and re-kick the loop (cabinet un-hover). No-op unless paused. */
  resume: () => void;
```

- [ ] **Step 2: Add the latch field**

In the field block of `class BombBotSession`, immediately after `private advancing = false;`, add:

```ts
  // Cabinet hover-freeze: when true the advance loop returns at the top of its
  // next iteration (freeze in place); resume() clears it and re-kicks the loop.
  private paused = false;
```

- [ ] **Step 3: Check the latch at the top of the advance loop**

In `advance`, the loop header is `while (tunnel && protocol) {`. Make its first statement:

```ts
      while (tunnel && protocol) {
        if (this.paused) return; // hover-freeze: stop here; resume() re-kicks
```

(`return` runs the `finally`, clearing `advancing`, so `resume()` can restart.)

- [ ] **Step 4: Clear the latch on (re)start**

In `start`, in the reset block that sets `this.pendingAction = undefined;`, add on the next line:

```ts
    this.paused = false;
```

- [ ] **Step 5: Add the `pause`/`resume` methods**

Immediately after the `toggleAuto = () => { … };` method, add:

```ts
  pause = () => {
    if (this.status !== "playing") return;
    this.paused = true;
  };

  resume = () => {
    if (!this.paused) return;
    this.paused = false;
    if (this.status === "playing") void this.advance();
  };
```

- [ ] **Step 6: Expose on the hook return**

In `useBombItSession`'s returned object, after `settleNow: session.settleNow,` add:

```ts
    pause: session.pause,
    resume: session.resume,
```

- [ ] **Step 7: Typecheck**

Run: `cd frontend && pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/games/bombIt/useBombItSession.ts
git commit -m "feat(bomb-it): pausable solo session for cabinet"
```

---

### Task 5: Bomb-it window — register the cabinet

Wire the bomb-it window into the cabinet via the shared helper. The Desktop already provides the `<GameCabinet>`, so this is registration only. Auto-start already runs solo with `auto = true` (session default), so the attract state is already correct — confirm, don't re-add.

**Files:**
- Modify: `frontend/src/games/bombIt/BombItWindow.tsx` (imports line 1–10, body ~25–61)

**Interfaces:**
- Consumes: `useSoloCabinet` from `@/shell/cabinet/soloCabinet` (Task 3); `useBombItSession` already exposes `pause`/`resume` (Task 4).

- [ ] **Step 1: Import the helper and `useCallback`**

Line 1 is `import { useEffect, useState } from "react";` → change to:

```ts
import { useCallback, useEffect, useState } from "react";
```

After the existing import block (e.g. after `import { BombScreen } from "./components/BombScreen";`), add:

```ts
import { useSoloCabinet } from "@/shell/cabinet/soloCabinet";
```

- [ ] **Step 2: Add a stable `goHome` and register the cabinet**

Immediately after the `backToMenu` definition (the `const backToMenu = () => { … };` block, ~line 49), add:

```ts
  // Cabinet "Return to Home": stop solo + show the chooser. Stable (module-const
  // modeStore + stable setModeState + session.reset) so the controller doesn't
  // re-register every render.
  const goHome = useCallback(() => {
    solo.reset();
    modeStore.delete(windowId);
    setModeState(null);
  }, [solo.reset, windowId]);

  useSoloCabinet(solo, mode, goHome);
```

(`useSoloCabinet` must run every render before the early returns — placing it here satisfies that.)

- [ ] **Step 3: Typecheck**

Run: `cd frontend && pnpm typecheck`
Expected: 0 errors. (If ESLint flags `goHome` deps, the listed deps are correct — `setModeState` and `modeStore` are stable and exempt.)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/games/bombIt/BombItWindow.tsx
git commit -m "feat(bomb-it): register take-over cabinet"
```

---

### Task 6: Chicken-cross session — pause/resume latch

Symmetric to Task 4, on `CrossBotSession`.

**Files:**
- Modify: `frontend/src/games/chickenCross/useChickenCrossSession.ts` (interface `export interface ChickenCrossSession` ~74–92, field block near `private advancing`, `advance` while-loop ~310, after `toggleAuto` ~574–580, `start` reset block, hook return ~633–646)

**Interfaces:**
- Produces: `ChickenCrossSession.pause(): void`, `ChickenCrossSession.resume(): void` (used by Task 7).

- [ ] **Step 1: Add `pause`/`resume` to the `ChickenCrossSession` interface**

After `settleNow: () => void;` in `export interface ChickenCrossSession`, add:

```ts
  /** Freeze the self-play loop in place (cabinet hover). No-op unless mid-play. */
  pause: () => void;
  /** Unfreeze and re-kick the loop (cabinet un-hover). No-op unless paused. */
  resume: () => void;
```

- [ ] **Step 2: Add the latch field**

In `class CrossBotSession`, immediately after `private advancing = false;`, add:

```ts
  // Cabinet hover-freeze: when true the advance loop returns at the top of its
  // next iteration (freeze in place); resume() clears it and re-kicks the loop.
  private paused = false;
```

- [ ] **Step 3: Check the latch at the top of the advance loop**

In `advance`, make the first statement inside `while (tunnel && protocol) {`:

```ts
      while (tunnel && protocol) {
        if (this.paused) return; // hover-freeze: stop here; resume() re-kicks
```

- [ ] **Step 4: Clear the latch on (re)start**

In `start`, in the reset block (where `this.pendingDir` / score are reset), add:

```ts
    this.paused = false;
```

(Place it beside the other field resets that run on each `start`.)

- [ ] **Step 5: Add the `pause`/`resume` methods**

Immediately after the `toggleAuto = () => { … };` method, add:

```ts
  pause = () => {
    if (this.status !== "playing") return;
    this.paused = true;
  };

  resume = () => {
    if (!this.paused) return;
    this.paused = false;
    if (this.status === "playing") void this.advance();
  };
```

- [ ] **Step 6: Expose on the hook return**

In `useChickenCrossSession`'s returned object, after `settleNow: session.settleNow,` add:

```ts
    pause: session.pause,
    resume: session.resume,
```

- [ ] **Step 7: Typecheck + commit**

```bash
cd frontend && pnpm typecheck && cd ..
git add frontend/src/games/chickenCross/useChickenCrossSession.ts
git commit -m "feat(cross): pausable solo session for cabinet"
```

---

### Task 7: Chicken-cross window — register the cabinet

Symmetric to Task 5.

**Files:**
- Modify: `frontend/src/games/chickenCross/ChickenCrossWindow.tsx` (imports, body ~25–61)

**Interfaces:**
- Consumes: `useSoloCabinet` (Task 3); `useChickenCrossSession` `pause`/`resume` (Task 6).

- [ ] **Step 1: Import the helper and `useCallback`**

Ensure the React import includes `useCallback` (change `import { useEffect, useState } from "react";` → `import { useCallback, useEffect, useState } from "react";`). After the existing import block add:

```ts
import { useSoloCabinet } from "@/shell/cabinet/soloCabinet";
```

- [ ] **Step 2: Add a stable `goHome` and register**

Immediately after the `backToMenu` definition (~line 49), add:

```ts
  const goHome = useCallback(() => {
    solo.reset();
    modeStore.delete(windowId);
    setModeState(null);
  }, [solo.reset, windowId]);

  useSoloCabinet(solo, mode, goHome);
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/games/chickenCross/ChickenCrossWindow.tsx
git commit -m "feat(cross): register take-over cabinet"
```

---

### Task 8: ADR + new-game checklist + PR honesty note

Record the cosmetic-take-over decision for these two games and list them as cabinet adopters.

**Files:**
- Create: `frontend`-adjacent `docs/decisions/0013-bomb-it-cross-takeover-cabinet.md`
- Modify: the new-game checklist that PR #46 pointed at the cabinet (find it in Step 2)

- [ ] **Step 1: Write the ADR**

Create `docs/decisions/0013-bomb-it-cross-takeover-cabinet.md`:

```markdown
# 0013 — Bomb It & Chicken Cross adopt the take-over cabinet

- **Status:** accepted
- **Date:** 2026-06-24
- **Extends:** [0012](0012-arena-attract-cabinet-seam.md)

## Context

ADR-0012 introduced the shared attract-mode take-over cabinet and adopted it for
tic-tac-toe; its scope note excluded bomb-it / chicken-cross as "TPS benches with
no human-play mode." PR #43 gave both games a real human solo mode (out-of-React
session, manual seat, score, settle), so that premise no longer holds, and the
maintainer requires every game to follow the cabinet UX while keeping its own
board visuals.

## Decision

Both games register a `CabinetController` and gain a `pause`/`resume` latch on
their solo `BotSession`; the Desktop's existing `<GameCabinet>` supplies the
hover/overlay/state machine. Take-over flips the solo loop to the human in seat A
and is **cosmetic on-chain** — the solo tunnel co-signs both seats from the same
keys, so settlement stays self-play even while a human steers. This matches
0012's deferral; genuine you-vs-bot (a fresh channel with the human's zkLogin
party A) remains deferred. The auto-move source stays `protocol.randomMove`
(the games' kits wrap the same call, so routing through them adds nothing).

## Consequences

- The two games inherit the standard UX with no per-game overlay code.
- Players may believe take-over is a real wager; the cosmetic nature is documented
  here and in the PR, to be replaced when the genuine channel lands.
```

- [ ] **Step 2: Find and update the new-game checklist**

Run: `rg -l -i 'cabinet|GameCabinet|adding-a-tunnel-game|new game' docs frontend/src/shell | head`
Then open the checklist doc PR #46 edited (most likely `docs/adding-a-tunnel-game.md`) and, in its cabinet step, add bomb-it and chicken-cross to the list of adopters (the exact sentence to edit will name ttt — extend it to read "tic-tac-toe, bomb-it, chicken-cross"). If no such list exists, add one line: "Cabinet adopters: tic-tac-toe, bomb-it, chicken-cross."

- [ ] **Step 3: Commit**

```bash
git add docs/decisions/0013-bomb-it-cross-takeover-cabinet.md docs/
git commit -m "docs(arena): ADR for bomb-it+cross cabinet adoption"
```

---

### Task 9: Full gate + in-browser verification

**Files:** none.

- [ ] **Step 1: Typecheck, build, full test**

Run: `cd frontend && pnpm typecheck && pnpm build && pnpm test`
Expected: typecheck 0 · build OK · all tests pass (including soloCabinet, seatControlState, both session-core suites).

- [ ] **Step 2: In-browser walk — bomb-it**

Run the app (`cd frontend && pnpm dev`), connect a wallet, open the Bomb It window. Verify:
- On open it auto-plays itself (bot-vs-bot, attract).
- Hovering the window freezes the frame and shows the take-over overlay.
- Moving the mouse away resumes the demo.
- "Play vs Bot" → the overlay clears and your keyboard (arrows/WASD + space) drives seat A while the bot plays B.
- "⌂ Home" / "Return to Home" → returns to the solo/pvp chooser.
- Minimize/maximize during a live human game preserves the game.

- [ ] **Step 3: In-browser walk — chicken-cross**

Same checklist for the Chicken Cross window (manual moves are arrow keys; seat A).

- [ ] **Step 4: Final confirmation**

Confirm the gate output and both in-browser walks are green. Do not claim completion without the actual command output and the manual walk.

---

## Self-Review

**Spec coverage:**
- Step-0 rebase → Task 1. ✓
- Pausable engine (the one new primitive) → Tasks 4 & 6. ✓
- Attract on open → already satisfied by `auto=true` default; confirmed in Task 5 Step 0 note + Task 9 walk. ✓
- Cabinet registration (controller, 5 verbs) → Task 3 (shared logic) + Tasks 5 & 7 (wiring). ✓ (Simplification vs spec: Desktop already renders `<GameCabinet>`, so games only register — recorded in Architecture.)
- `active` gate / takeOver guard / returnHome → `soloCabinet.ts` + tests, Task 3. ✓
- Cosmetic take-over + ADR + PR note → Task 8. ✓
- Return-Home → chooser → `goHome` in Tasks 5 & 7. ✓
- Keep `randomMove` → no task touches the auto source. ✓ (by omission, intentional)
- Testing: shared controller unit tests (Task 3), un-orphan existing suites (Task 2), in-browser walk (Task 9). ✓
- Out of scope (SDK/Move/Desktop/PvP/board) → Global Constraints forbid; no task touches them. ✓

**Deviations from spec, intentional:**
- Spec said "wrap the Window in `<GameCabinet>`"; investigation showed Desktop already wraps every window, so games only call `useRegisterCabinet`. Less code, same result.
- Spec said expose `paused` on the session interface; dropped as YAGNI — the cabinet tracks state via its own reducer and never reads `paused`. Only `pause()`/`resume()` are exposed.
- Spec proposed per-session pause unit tests; replaced with pure `soloCabinet` controller tests (the genuinely new logic) + enabling the existing suites, because a session-class test would have to fake the tunnel boundary (discouraged by CLAUDE.md) and ttt/PR #46 set the precedent of testing the reducer + verifying the verb glue in-browser.

**Placeholder scan:** none — every code step shows full content; Task 8 Step 2 names the exact edit and a fallback.

**Type consistency:** `pause`/`resume` typed `() => void` in both session interfaces and consumed structurally by `SoloCabinetSession`; `isSoloOfferable`/`soloCabinetController`/`useSoloCabinet` signatures match between Task 3's Produces block, the implementation, and the call sites in Tasks 5 & 7.
