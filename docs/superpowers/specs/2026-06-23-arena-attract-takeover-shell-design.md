# Arena Attract Mode & Take-Over Shell — design

- **Status**: Implemented — tic-tac-toe is the reference.
- **Scope**: Frontend only (`frontend/`).
- **Decisions / rationale**: [ADR-0012](../../decisions/0012-arena-attract-cabinet-seam.md).

## 1. Vision

Connect the wallet and you don't land on a menu — you land on a **living arcade
floor**. Every game window is a cabinet already mid-match, playing _itself_. The
moment you show interest in one, it **pauses on the frame** and offers you the
controls. Take them, and you continue against the bot. The behavior is identical
on every game, so the _common part_ lives in **one shared shell**, not per-game
code.

## 2. The three layers (and who owns each)

1. **Kit** — `GAME_KITS` (`src/agent/gameKit.ts`): per game, a pure `protocol`
   (rules) + `createBot(seat).plan(state) → move | null` (the JS bot). The
   **auto move source** and single source of truth, shared with the agent test
   harness. See the [canonical game-bot kit](2026-06-19-canonical-game-bot-kit-design.md).
   _Game-owned._
2. **In-game engine + UI** — each game's hook/scene: `auto` / `setAuto` /
   `myTurn` / `playCell` plus the board. **Auto on → the kit plays both seats;
   auto off → you play your seat via the board.** _Game-owned._
3. **Common cabinet** — `src/shell/cabinet/`: a shared `GameCabinet` wrapping
   **every** desktop window. It owns hover → **pause** → the take-over overlay →
   the `attract → inviting → live` state machine. _Shell-owned, written once._

## 3. Canonical pattern — "auto is a config; the kit is the brain"

The move loop of a kit-driven game is exactly:

```
move = manual ? yourUiInput : kit.bot.plan(state)
```

**Tic-tac-toe is the reference**: `useBotGame` drives its auto move from
`GAME_KITS.tictactoe.bot.plan()` — no bespoke picker, one source shared with the
harness. Take-over flips `manual` on and feeds your board clicks in. The cabinet
shell adds hover-pause + the overlay on top of any game that registers a
controller.

## 4. Shell / game boundary

**Shell owns** (`GameCabinet`): hover detection, the take-over overlay, the
`attract → inviting → live` machine, and the `CabinetController` contract it
consumes.

**Game owns**: its kit (bot + protocol); its engine (auto-play loop +
`pause`/`resume` + a manual mode); its board/HUD; **its own auto indicator**. The
shell adds no `AUTO` badge and imposes no cadence — attract runs the game's own
engine at its native speed.

## 5. Control state machine

```
  connect ─▶ ATTRACT ─ hover ▶ INVITING ──[Play vs Bot]──▶ LIVE
  (auto-playing,       (PAUSED +            │                │
   game-owned)          overlay)            │                │
       ▲   unhover ──────┘                  │       ⌂ Home ──┘
       │                                    │   (game → its home)
       └──── Return to Home ◀───────────────┘   (game → its home)
```

- **ATTRACT** — the game is auto-playing (watch). The shell is offerable (`active`).
- **INVITING** — hover froze the auto-play (free, reversible) and shows the overlay.
- **LIVE** — you took the seat (game in manual mode); you play via the board.

`unhover` simply resumes the demo. `Return to Home` and the in-game `⌂` both send
the game back to its **own** home screen (its title/login scene) and stop the
auto-play loop.

## 6. The take-over UX

- **Hover** a cabinet → `pause()` freezes the loop; the dimmed, scanlined frame
  shows the overlay. Move the mouse away → `resume()` (keep watching).
- The overlay is an **arcade attract screen**: one glowing **`Play vs Bot`** CTA
  (→ `takeOver()`: manual mode + resume; you play your seat) and a quiet
  **`Return to Home`** link (→ `returnHome()`: stop auto + return to the game's
  own home screen). PvP / Find Match is **not** here — it's a Home-page / per-game
  concern.
- **Take-over is cosmetic on-chain today** (the tunnel is `OffchainTunnel.selfPlay`
  holding both bot keys); the real ephemeral-key you-vs-bot channel is deferred.
  See [ADR-0012](../../decisions/0012-arena-attract-cabinet-seam.md).

## 7. The `CabinetController` contract

What each game's App registers (`useRegisterCabinet`) so the shell can drive it:

```ts
interface CabinetController {
  active: boolean; // true while auto-playing (offerable) — gates hover/overlay
  pause(): void; // freeze the auto-play loop (hover)
  resume(): void; // unfreeze (unhover / keep watching)
  takeOver(): void; // hand the seat to the human (manual mode)
  returnHome(): void; // stop auto + send the game to its own home screen
}
```

`GameCabinet` wraps every window in `Desktop`; a game that registers nothing
leaves the shell **inert** (no overlay), so adoption is incremental.

## 8. Adoption recipe (other self-play games follow ttt)

A second game inherits this UX with two small, copy-paste changes — the shared
shell never changes. (Verified against blackjack, whose `useBlackjackBot` already
has the `auto`/manual/`startAuto`/`stopAuto` + poll-loop shape this needs.)

1. **Drive auto from your kit**: `move = manual ? ui : GAME_KITS[id].bot.plan(state)`.

2. **Make the engine pausable.** Hover-pause is one latch the interval tick reads —
   no timer to stop/re-arm (the interval keeps firing harmless no-op ticks, the
   same poll-and-bail shape manual play already uses while awaiting your move):

   ```ts
   const pausedRef = useRef(false);
   const [paused, setPaused] = useState(false);

   const tick = () => {
     if (pausedRef.current) return; // hover-paused: skip this frame
     /* …one game step (manual mode returns early here until the user moves)… */
   };

   const pause = useCallback(() => {
     pausedRef.current = true;
     setPaused(true);
   }, []);
   const resume = useCallback(() => {
     pausedRef.current = false;
     setPaused(false);
   }, []);
   // expose { paused, pause, resume } on the hook's view (required, not optional)
   ```

3. **Register a `CabinetController`** in your App (the Desktop `<GameCabinet>` wrap
   is automatic). Destructure the engine's **stable** callbacks — not `g` itself,
   which is a fresh object each render — so the controller rebuilds only when
   `active` flips:

   ```ts
   const { setAuto, pause, resume, stopAuto } = g;
   const offerable = scene === "game" && g.auto; // offer only while auto-playing
   const takeOver = useCallback(() => {
     setAuto(false);
     resume();
   }, [setAuto, resume]);
   const returnHome = useCallback(() => {
     stopAuto();
     setScene("home");
   }, [stopAuto]); // your title scene
   const cabinet = useMemo<CabinetController>(
     () => ({
       active: offerable,
       pause,
       resume,
       takeOver,
       returnHome,
     }),
     [offerable, pause, resume, takeOver, returnHome],
   );
   useRegisterCabinet(cabinet);
   ```

This applies **uniformly across the arena** — every game already has the same
shape: a self-play/auto loop plus a path for a human to take a seat (ttt's auto
toggle, blackjack's hit/stand, battleship's autopilot, quantum poker's watch →
Play-vs-Bot modes, bomb-it / chicken-cross's `HumanSeat`). The cabinet just
standardizes the hover → pause → take-over UX on top; ttt is the reference and the
rest adopt by registering a controller (the engine mechanics vary — a flag flip vs
a mode switch). See [ADR-0012](../../decisions/0012-arena-attract-cabinet-seam.md).
