# Poker Table + Heartbeat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a shared `QuantumPokerTable` component, render it in both the Bot and Auto windows, and add batched off-chain throughput + session heartbeat reporting to the Auto lane.

**Architecture:** Three coordinated edits — (1) extract presentational poker table from `QuantumPokerWindow.tsx` into a new shared component, (2) refactor `QuantumPokerWindow.tsx` to import it, (3) wire the table + heartbeat into `useQuantumPokerAuto.ts` and `QuantumPokerBotVsBotWindow.tsx`. No new tests added; existing tests must still pass.

**Tech Stack:** React/TypeScript (TSX), `sui-tunnel-ts/protocol/quantumPoker` (PokerState), `@/backend/controlPlane` (RegisterSessionResult, getControlPlaneClient), Tailwind CSS classes.

## Global Constraints

- Branch: `poker-bot-kit` in `/Users/aaronphan/Documents/projects/quantum_poker/dopamint-arena`
- Sources under `frontend/src/`
- `cd frontend && npm run typecheck` must pass clean after all changes
- `cd frontend && node --import tsx --test src/games/quantumPoker/pokerSelfPlay.test.ts src/games/quantumPoker/bots.test.ts` must all pass
- Do NOT add new tests (UI/telemetry wiring not tested)
- ONE commit total, Conventional Commits, ≤50-char subject, no AI attribution
- Stage ONLY the four touched files; do NOT `git add -A`
- Suggested commit subject: `feat(poker): show table + report off-chain throughput`
- No emojis
- Write post-task report to `/Users/aaronphan/Documents/projects/quantum_poker/dopamint-arena/.superpowers/sdd/post-table-heartbeat-report.md`

---

### Task 1: Extract QuantumPokerTable component

**Files:**

- Create: `frontend/src/games/quantumPoker/QuantumPokerTable.tsx`
- Modify: `frontend/src/games/quantumPoker/QuantumPokerWindow.tsx`

**Interfaces:**

- Produces:

  ```tsx
  export function QuantumPokerTable(props: {
    state: PokerState;
    holesA: number[];
    holesB: number[];
    nameA: string;
    nameB: string;
  }): JSX.Element;
  ```

  Exported from `frontend/src/games/quantumPoker/QuantumPokerTable.tsx`.

- [ ] **Step 1: Create `QuantumPokerTable.tsx`**

  Create the file with these exact contents — all presentational helpers are MOVED (not copied) from `QuantumPokerWindow.tsx`:

  ```tsx
  import type { CSSProperties } from "react";
  import type { PokerPhase } from "sui-tunnel-ts/protocol/quantumPoker";
  import type { PokerState } from "sui-tunnel-ts/protocol/quantumPoker";
  import type { Party } from "sui-tunnel-ts/protocol/Protocol";

  // ---------------------------------------------------------------------------
  // Presentational constants
  // ---------------------------------------------------------------------------

  export const PHASE_LABEL: Record<PokerPhase, string> = {
    commit: "Commit",
    open_private_holes: "Private open",
    preflop_bet: "Preflop",
    reveal_flop: "Flop reveal",
    flop_bet: "Flop",
    reveal_turn: "Turn reveal",
    turn_bet: "Turn",
    reveal_river: "River reveal",
    river_bet: "River",
    showdown: "Showdown",
    hand_over: "Settled",
    done: "Done",
  };

  export const SUITS = ["♠", "♥", "♦", "♣"] as const;
  export const RANKS = [
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "T",
    "J",
    "Q",
    "K",
    "A",
  ];

  export const HEADS_UP_STYLE: CSSProperties & Record<`--${string}`, string> = {
    "--qp-felt": "#0f6b52",
    "--qp-felt-dark": "#08372f",
    "--qp-rail": "#14191d",
    "--qp-gold": "#f4c45d",
    "--qp-cyan": "#67e8f9",
  };

  // ---------------------------------------------------------------------------
  // Presentational helpers
  // ---------------------------------------------------------------------------

  export function cardText(card: number): string {
    return `${RANKS[card % 13]}${SUITS[Math.floor(card / 13)]}`;
  }

  function Card({ card, hidden }: { card: number | null; hidden?: boolean }) {
    const suit = card === null ? "" : SUITS[Math.floor(card / 13)];
    const red = suit === "♥" || suit === "♦";
    return (
      <span
        className={[
          "grid h-10 w-7 shrink-0 place-items-center rounded-[4px] border text-[10px] font-bold shadow-[0_3px_10px_rgba(0,0,0,.28)]",
          hidden
            ? "border-cyan-200/25 bg-[repeating-linear-gradient(135deg,rgba(103,232,249,.16)_0_3px,rgba(8,20,24,.9)_3px_7px)] text-cyan-100"
            : red
              ? "border-rose-200/50 bg-[#f1eadc] text-rose-700"
              : "border-slate-200/50 bg-[#f1eadc] text-slate-950",
        ].join(" ")}
      >
        {hidden || card === null ? "" : cardText(card)}
      </span>
    );
  }

  function CardRow({
    cards,
    hidden,
    size = 5,
  }: {
    cards: number[];
    hidden?: boolean;
    size?: number;
  }) {
    return (
      <div className="flex items-center justify-center gap-1">
        {Array.from({ length: size }, (_, i) => (
          <Card
            key={i}
            card={cards[i] ?? null}
            hidden={hidden || cards[i] === undefined}
          />
        ))}
      </div>
    );
  }

  function ChipStack({ value }: { value: bigint }) {
    return (
      <div className="flex items-center gap-1 text-[10px] tabular-nums text-slate-300">
        <span className="h-2.5 w-2.5 rounded-full border border-amber-100/50 bg-[var(--qp-gold)] shadow-[0_0_0_2px_rgba(244,196,93,.18)]" />
        <span>{value.toString()}</span>
      </div>
    );
  }

  function PlayerSeat({
    party,
    name,
    balance,
    bet,
    holes,
    active,
    winner,
    side,
  }: {
    party: Party;
    name: string;
    balance: bigint;
    bet: bigint;
    holes: number[];
    active: boolean;
    winner: boolean;
    side: "top" | "bottom";
  }) {
    return (
      <section
        className={[
          "relative flex min-h-[4.6rem] min-w-0 items-center justify-between gap-2 rounded-md border px-2 py-1.5 shadow-[0_8px_24px_rgba(0,0,0,.24)]",
          active
            ? "border-cyan-200/60 bg-cyan-200/10"
            : "border-white/10 bg-[rgba(20,25,29,.82)]",
        ].join(" ")}
      >
        <div
          className={[
            "absolute left-1/2 h-2 w-10 -translate-x-1/2 rounded-full bg-black/35",
            side === "top" ? "-bottom-1" : "-top-1",
          ].join(" ")}
        />
        <div className="flex min-w-0 items-center gap-2">
          <div
            className={[
              "grid h-8 w-8 shrink-0 place-items-center rounded-full border text-[12px] font-bold",
              active
                ? "border-cyan-200 bg-cyan-200 text-slate-950"
                : "border-white/15 bg-black/35 text-slate-100",
            ].join(" ")}
          >
            {party}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-200">
              <span>{name}</span>
              {winner && (
                <span className="rounded-sm bg-emerald-300 px-1 text-[8px] text-slate-950">
                  WIN
                </span>
              )}
            </div>
            <ChipStack value={balance} />
            <div className="text-[9px] tabular-nums text-slate-500">
              street {bet.toString()}
            </div>
          </div>
        </div>
        <div className="rounded-md bg-black/18 p-1">
          <CardRow cards={holes} hidden={holes.length === 0} size={2} />
        </div>
      </section>
    );
  }

  // ---------------------------------------------------------------------------
  // QuantumPokerTable — shared felt rendering for Bot and Auto lanes
  // ---------------------------------------------------------------------------

  export function QuantumPokerTable({
    state,
    holesA,
    holesB,
    nameA,
    nameB,
  }: {
    state: PokerState;
    holesA: number[];
    holesB: number[];
    nameA: string;
    nameB: string;
  }): JSX.Element {
    const pot = state.totalBetA + state.totalBetB;
    const result = state.lastResult;

    return (
      <section className="relative flex min-h-0 flex-1 flex-col justify-between gap-2 rounded-lg border border-emerald-200/20 bg-[linear-gradient(145deg,rgba(255,255,255,.06),transparent_28%),radial-gradient(ellipse_at_center,var(--qp-felt)_0%,var(--qp-felt-dark)_68%,#031615_100%)] p-2 shadow-[inset_0_0_0_5px_rgba(0,0,0,.2)]">
        {/* Opponent seat (party B, top) */}
        <PlayerSeat
          party="B"
          name={nameB}
          balance={state.balanceB}
          bet={state.totalBetB}
          holes={holesB}
          active={state.toAct === "B"}
          winner={result?.winner === "B"}
          side="top"
        />

        {/* Board + pot */}
        <div className="relative grid min-h-[5.8rem] place-items-center rounded-[999px] border border-amber-100/20 bg-black/15 px-2 py-2">
          <div className="absolute top-1 flex items-center gap-1 rounded-full border border-amber-100/25 bg-black/35 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-amber-100">
            <span className="h-2 w-2 rounded-full bg-[var(--qp-gold)]" />
            <span>{pot.toString()}</span>
          </div>
          <CardRow cards={state.board} size={5} />
          <div className="absolute bottom-1 flex max-w-[92%] items-center gap-2 overflow-hidden text-[9px] uppercase tracking-[0.08em] text-emerald-50/70">
            <span className="truncate">{PHASE_LABEL[state.phase]}</span>
            <span className="h-1 w-1 rounded-full bg-emerald-100/45" />
            <span>hand {state.handNo.toString()}</span>
          </div>
        </div>

        {/* Human/Bot A seat (party A, bottom) */}
        <PlayerSeat
          party="A"
          name={nameA}
          balance={state.balanceA}
          bet={state.totalBetA}
          holes={holesA}
          active={state.toAct === "A"}
          winner={result?.winner === "A"}
          side="bottom"
        />
      </section>
    );
  }
  ```

- [ ] **Step 2: Refactor `QuantumPokerWindow.tsx` to import from the shared component**

  Remove the blocks now moved to `QuantumPokerTable.tsx`: the constants `PHASE_LABEL`, `SUITS`, `RANKS`, `HEADS_UP_STYLE`, the helpers `cardText`, `Card`, `CardRow`, `ChipStack`, and the local `PlayerSeat`. Keep `moveLabel` inline (it's only used here), and keep `ActionBar`.

  Replace the imports at the top:
  - Remove the `import type { CSSProperties } from "react"` line (no longer needed here after the move).
  - Add: `import { QuantumPokerTable, HEADS_UP_STYLE } from "./QuantumPokerTable";`

  Replace the felt section in the JSX (inside `<main>`) — the `<section className="relative flex min-h-0...">` block that contains both `PlayerSeat` calls and the board — with:

  ```tsx
  <QuantumPokerTable
    state={s}
    holesA={game.humanHoles}
    holesB={holesB}
    nameA="You"
    nameB="Bot"
  />
  ```

  The `holesB` local variable (`const holesB = s.shownHoleB ?? [];`) must still be declared before the return. The `pot` and `result` local variables are no longer needed — delete them.

  Keep the idle/connect screen, `ActionBar`, and status footer unchanged.

- [ ] **Step 3: Verify typecheck passes on these two files**

  ```bash
  cd /Users/aaronphan/Documents/projects/quantum_poker/dopamint-arena/frontend && npm run typecheck 2>&1 | grep -E "error TS|QuantumPokerTable|QuantumPokerWindow" | head -20
  ```

  Expected: no `error TS` lines mentioning these files.

---

### Task 2: Wire heartbeat + snapshot table state in `useQuantumPokerAuto.ts`

**Files:**

- Modify: `frontend/src/games/quantumPoker/useQuantumPokerAuto.ts`

**Interfaces:**

- Consumes: `RegisterSessionResult`, `getControlPlaneClient` from `@/backend/controlPlane`; `PokerState` from `sui-tunnel-ts/protocol/quantumPoker`
- Produces (on `QuantumPokerAutoSession` and `AutoSnapshot`):

  ```ts
  state: PokerState | null;
  holesA: number[];
  holesB: number[];
  ```

- [ ] **Step 1: Add imports**

  At the top of `useQuantumPokerAuto.ts`, add these imports:

  ```ts
  import type { PokerState } from "sui-tunnel-ts/protocol/quantumPoker";
  import {
    getControlPlaneClient,
    type RegisterSessionResult,
  } from "@/backend/controlPlane";
  ```

- [ ] **Step 2: Extend `QuantumPokerAutoSession` interface**

  Add three fields after `error: string | null;`:

  ```ts
  /** Live poker table state (null before the first tunnel opens). */
  state: PokerState | null;
  /** Party A hole cards to display (both shown in auto/spectator mode). */
  holesA: number[];
  /** Party B hole cards to display. */
  holesB: number[];
  ```

- [ ] **Step 3: Extend `AutoSnapshot` interface**

  Add the same three fields to `AutoSnapshot` (after `error: string | null;`):

  ```ts
  state: PokerState | null;
  holesA: number[];
  holesB: number[];
  ```

- [ ] **Step 4: Initialize the snap with the new fields**

  In the `snap` initializer inside the `AutoSession` class (the `private snap: AutoSnapshot = { ... }` block), add:

  ```ts
  state: null,
  holesA: [],
  holesB: [],
  ```

- [ ] **Step 5: Add heartbeat fields to `AutoSession`**

  Inside `class AutoSession`, add these private fields (after the `private gen = 0;` line):

  ```ts
  private session: RegisterSessionResult | null = null;
  private heartbeatActions = 0;
  private lastHeartbeatAt = 0;
  private moveCount = 0;
  ```

- [ ] **Step 6: Update `emit()` to populate table state**

  Replace the `emit()` method's `this.snap = { ... }` assignment so it includes the new fields (add after `error: this.error,`):

  ```ts
  state: this.tunnel?.state ?? null,
  holesA: this.tunnel?.state.holeA ?? [],
  holesB: this.tunnel?.state.holeB ?? [],
  ```

  Note: `holeA` and `holeB` on `PokerState` are `number[] | null`, so `?? []` is correct.

- [ ] **Step 7: Add `flushHeartbeat` method to `AutoSession`**

  Add this method to the `AutoSession` class (before `runMatch`):

  ```ts
  private flushHeartbeat(tunnelId: string, force: boolean) {
    const session = this.session;
    if (!session || this.heartbeatActions === 0) return;
    const now = Date.now();
    const windowMs = now - this.lastHeartbeatAt;
    if (!force && windowMs < 1000) return;
    const actionsDelta = this.heartbeatActions;
    this.heartbeatActions = 0;
    this.lastHeartbeatAt = now;
    getControlPlaneClient()
      .sendHeartbeat(session.sessionId, session.statsToken, {
        tunnelId,
        nonce: String(this.moveCount),
        actionsDelta,
        windowMs: Math.max(1, windowMs),
      })
      .catch((e) => console.error("[poker auto] heartbeat failed:", e));
  }
  ```

- [ ] **Step 8: Replace the play loop in `runMatch`**

  Inside `runMatch`, after `this.deps.report.setActive(2);`, replace the entire block that begins `this.stage = "playing";` through the closing `await sleep(SPACE_MS);` (the old paced loop), with:

  ```ts
  this.stage = "playing";
  this.pushView();

  // Register session for heartbeat (best-effort).
  this.session = null;
  this.heartbeatActions = 0;
  this.lastHeartbeatAt = Date.now();
  this.moveCount = 0;
  try {
    this.session = await getControlPlaneClient().registerSession({
      userAddress: this.deps?.account?.address ?? this.bots.A.address,
      game: "quantum-poker",
      tunnels: [
        { tunnelId, partyA: this.bots.A.address, partyB: this.bots.B.address },
      ],
    });
  } catch (e) {
    console.error("[poker auto] registerSession failed:", e);
  }

  let ts = 1n;
  let pending = 0;
  let lastFlush = Date.now();
  const FLUSH_MS = 80;
  const flush = async () => {
    if (pending > 0) {
      this.deps?.report.bumpCounters({
        updates: pending,
        signatures: pending * 2,
        verifications: pending * 2,
      });
      pending = 0;
    }
    this.flushHeartbeat(tunnelId, false);
    this.pushView();
    await sleep(0);
    lastFlush = Date.now();
  };
  while (tunnel.state.phase !== "done") {
    if (this.gen !== myGen) return;
    const r = stepPokerAuto(tunnel, botA, botB, ts++);
    if (!r) break;
    this.actions += 1;
    this.moveCount += 1;
    this.heartbeatActions += 1;
    pending += 1;
    if (Date.now() - lastFlush >= FLUSH_MS) await flush();
  }
  // Final flush — force the heartbeat so the last window is never dropped.
  if (pending > 0) {
    this.deps?.report.bumpCounters({
      updates: pending,
      signatures: pending * 2,
      verifications: pending * 2,
    });
    pending = 0;
  }
  this.flushHeartbeat(tunnelId, true);
  this.pushView();
  ```

  Also delete the `tunnel.onUpdate` callback's old `this.deps?.report.bumpCounters(...)` call (the one inside `tunnel.onUpdate = (u, bytes) => { ... }`). Keep only `transcript.append(u)` there:

  ```ts
  tunnel.onUpdate = (u) => {
    transcript.append(u);
  };
  ```

  The `bytes` parameter can be dropped since it's no longer used.

- [ ] **Step 9: Remove the now-unused `SPACE_MS` constant**

  Delete this line from the top of the file:

  ```ts
  /** Spectator pacing per off-chain move (ms). */
  const SPACE_MS = 60;
  ```

- [ ] **Step 10: Update the `useQuantumPokerAuto` hook's return object**

  In the `return { ... }` block of `useQuantumPokerAuto`, add:

  ```ts
  state: snap.state,
  holesA: snap.holesA,
  holesB: snap.holesB,
  ```

- [ ] **Step 11: Verify typecheck**

  ```bash
  cd /Users/aaronphan/Documents/projects/quantum_poker/dopamint-arena/frontend && npm run typecheck 2>&1 | grep -E "error TS|useQuantumPokerAuto" | head -20
  ```

  Expected: no `error TS` lines.

---

### Task 3: Render table in Auto window + commit

**Files:**

- Modify: `frontend/src/games/quantumPoker/QuantumPokerBotVsBotWindow.tsx`

**Interfaces:**

- Consumes:
  - `s.state: PokerState | null` from `useQuantumPokerAuto`
  - `s.holesA: number[]`, `s.holesB: number[]` from `useQuantumPokerAuto`
  - `s.personas: { a: string; b: string } | null` from `useQuantumPokerAuto`
  - `QuantumPokerTable` from `./QuantumPokerTable`
  - `HEADS_UP_STYLE` from `./QuantumPokerTable`

- [ ] **Step 1: Add imports to `QuantumPokerBotVsBotWindow.tsx`**

  Add at the top (after the existing imports):

  ```tsx
  import { QuantumPokerTable, HEADS_UP_STYLE } from "./QuantumPokerTable";
  ```

- [ ] **Step 2: Apply `HEADS_UP_STYLE` to the root div**

  The existing root `<div style={STYLE} ...>` uses the local `STYLE` const. Merge both styles:

  ```tsx
  <div
    style={{ ...STYLE, ...HEADS_UP_STYLE }}
    className="flex h-full min-h-[14rem] flex-col overflow-hidden bg-[var(--qp-ink)] text-slate-100"
  >
  ```

  This makes the `--qp-felt`, `--qp-felt-dark`, `--qp-gold`, `--qp-cyan` CSS vars available to the table component.

- [ ] **Step 3: Render the table when state is available**

  Inside `<main>`, after the fund gate section (`{!s.funded && ...}`) and BEFORE the scoreboard section, add:

  ```tsx
  {
    s.state && (
      <QuantumPokerTable
        state={s.state}
        holesA={s.holesA}
        holesB={s.holesB}
        nameA={s.personas?.a ?? "Bot A"}
        nameB={s.personas?.b ?? "Bot B"}
      />
    );
  }
  ```

- [ ] **Step 4: Full typecheck**

  ```bash
  cd /Users/aaronphan/Documents/projects/quantum_poker/dopamint-arena/frontend && npm run typecheck 2>&1 | tail -5
  ```

  Expected: ends with `0 errors.` (or similar clean output).

- [ ] **Step 5: Run the existing tests**

  ```bash
  cd /Users/aaronphan/Documents/projects/quantum_poker/dopamint-arena/frontend && node --import tsx --test src/games/quantumPoker/pokerSelfPlay.test.ts src/games/quantumPoker/bots.test.ts 2>&1 | tail -15
  ```

  Expected: all tests pass, no failures.

- [ ] **Step 6: Commit the four changed files**

  ```bash
  cd /Users/aaronphan/Documents/projects/quantum_poker/dopamint-arena && git add frontend/src/games/quantumPoker/QuantumPokerTable.tsx frontend/src/games/quantumPoker/QuantumPokerWindow.tsx frontend/src/games/quantumPoker/useQuantumPokerAuto.ts frontend/src/games/quantumPoker/QuantumPokerBotVsBotWindow.tsx
  ```

  Then commit:

  ```bash
  cd /Users/aaronphan/Documents/projects/quantum_poker/dopamint-arena && git commit -m "feat(poker): show table + report off-chain throughput"
  ```

- [ ] **Step 7: Write the report**

  Create `/Users/aaronphan/Documents/projects/quantum_poker/dopamint-arena/.superpowers/sdd/post-table-heartbeat-report.md` with:
  - Status (pass/fail)
  - Commit SHA + subject
  - Typecheck result
  - Test result
  - Per-file summary of changes
  - Any concerns or edge cases

---

## Self-Review

### Spec coverage

| Spec requirement                                                                                  | Task                                      |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Extract `Card`, `CardRow`, `ChipStack`, `PlayerSeat`, `PHASE_LABEL`, `SUITS`, `RANKS`, `cardText` | Task 1, Step 1                            |
| Export `QuantumPokerTable` with exact signature                                                   | Task 1, Step 1                            |
| `QuantumPokerWindow.tsx` imports and uses `<QuantumPokerTable>`                                   | Task 1, Step 2                            |
| `SPACE_MS` removed                                                                                | Task 2, Step 9                            |
| `bumpCounters` no longer called per-move                                                          | Task 2, Step 8                            |
| Batched flush every 80ms                                                                          | Task 2, Step 8                            |
| `registerSession` after tunnel opens                                                              | Task 2, Step 8                            |
| `flushHeartbeat` method                                                                           | Task 2, Step 7                            |
| `state`, `holesA`, `holesB` in `AutoSnapshot` + `QuantumPokerAutoSession`                         | Task 2, Steps 2-4, 10                     |
| Both holes shown in auto (spectator)                                                              | Task 2, Step 6 (`holeA`/`holeB` directly) |
| `QuantumPokerBotVsBotWindow` renders table                                                        | Task 3, Steps 3                           |
| CSS vars passed to table component                                                                | Task 3, Step 2                            |
| typecheck clean                                                                                   | Tasks 1-3, verify steps                   |
| Tests pass                                                                                        | Task 3, Step 5                            |
| Single commit, four files staged                                                                  | Task 3, Steps 6                           |
| Report written                                                                                    | Task 3, Step 7                            |

### Placeholder scan

No TBDs, TODOs, or "similar to Task N" references. All code blocks are complete.

### Type consistency

- `PokerState` is imported in `QuantumPokerTable.tsx` from `sui-tunnel-ts/protocol/quantumPoker` — matches every other use in the codebase.
- `holesA`/`holesB` are `number[]` throughout (props, snapshot fields, return value).
- `HEADS_UP_STYLE` is exported from `QuantumPokerTable.tsx` and imported in both `QuantumPokerWindow.tsx` and `QuantumPokerBotVsBotWindow.tsx`.
- `flushHeartbeat(tunnelId: string, force: boolean)` is called as `this.flushHeartbeat(tunnelId, false)` inside the loop and `this.flushHeartbeat(tunnelId, true)` after — matches the signature.

### Known concerns

1. `PlayerSeat` in the original had a `persona` prop shown as `{persona} · street {bet}`. The extracted version drops `persona` (the outer component passes `name` which already carries the persona). The `street {bet}` line is preserved. This is intentional — the Auto window shows persona names as `nameA`/`nameB` which come from `s.personas`.

2. In `emit()`, `this.tunnel?.state.holeA ?? []` — because `holeA` is `number[] | null` on `PokerState`, the `?? []` handles the `null` case correctly. The optional chain handles `tunnel` being `null`.

3. The `onUpdate` callback no longer receives `bytes`. The original signature was `(u, bytes)` and passed `bytes` to `bumpCounters`. With the batched approach, `bytes` is intentionally dropped (batch-level byte counting would require summing, which adds complexity for limited benefit). This matches the spec.
