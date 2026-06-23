# Collaborative Pixel Paint — implementation plan

> **For agentic workers:** Implement task-by-task; steps use checkbox (`- [ ]`)
> syntax for tracking. Each task lists files to create/edit and a proof (test or
> manual check) before moving on.

**Goal:** Ship a turn-based two-painter **Pixel Duel** on the existing two-party
Sui Tunnel — offline first, then PvP over the relay, then a **gallery** of settled
canvases. Do **not** modify `sui_tunnel/**` or the `sui-tunnel-ts` core; the game
is pure `Protocol<State, Move>` + frontend, per the canonical recipe.

**UX target:** wplace.live / r/place — a live shared pixel wall (pick a color,
place freely with a cooldown/charges, the other painter's pixels appear live),
scoped to two painters per tunnel. **Not** a gallery.

**Architecture:** New isolated `pixelPaint/` protocol implementing the SDK
`Protocol` interface (deterministic indexed canvas, **no turns** — either party
places, like the chat protocol; no commit-reveal), a `GameKit` bot adapter, a
`usePvpPaint` client hook cloned from `usePvpTicTacToe`, and a `PaintWindow`
canvas component with a palette + client-side cooldown.

**Tech stack:** TypeScript (`sui-tunnel-ts` SDK + `node:test` via `tsx`), React 19
frontend (vite), Sui testnet tunnel package. Matches the stack of the existing
games.

**Spec:** `docs/superpowers/specs/2026-06-22-collab-paint-canvas-design.md`
**Decision:** `docs/decisions/0010-collaborative-paint-party-topology.md`

**Conventions:** Conventional Commits, subject ≤ 50 chars, **no AI attribution**.
Do **not** `git add -A`; stage only listed files. Do not stage `sui-tunnel-ts/**`
or `sui_tunnel/**`. Do not push without explicit go-ahead.

**Encoding convention:** cell `0` = empty; palette colors `1..16`. Domain tag
`pixel_paint.duo.v1`. Default canvas 64×64, terminal at a placement `cap`.
Cooldown/charges are client-side UX (not in the co-signed state).

---

## P0 — Pixel Duel offline (protocol + bot + local board)

### Task 1: Paint protocol (`pixelPaint.ts`) ✅ DONE
**Files:**
- Create: `sui-tunnel-ts/src/protocol/pixelPaint.ts`
- Create: `sui-tunnel-ts/src/protocol/pixelPaint.test.ts`

- [x] Define `PixelPaintState`, `PixelPaintMove`, palette/dims as named consts.
- [x] Implement `Protocol<PixelPaintState, PixelPaintMove>`: `initialState`,
      `applyMove` (assert not-terminal/bounds/color, paint, no turn check),
      `encodeState` (domain-tagged, deterministic), `balances`, `isTerminal`
      (`placed >= cap`), `randomMove`.
- [x] **Tests:** no-turns (either party places); overwrite allowed; rejects
      out-of-bounds + bad color; balances conserved; terminal at cap; encodeState
      stable/changes; no input mutation; randomMove legal until cap. **10/10 green.**
- [x] Proof: `cd sui-tunnel-ts && node --import tsx --test src/protocol/pixelPaint.test.ts`

### Task 2: Bot kit adapter
**Files:**
- Create: `frontend/src/agent/games/pixelPaint/kit.ts`
- Create: `frontend/src/agent/games/pixelPaint/kit.test.ts`
- Edit: `frontend/src/agent/gameKit.ts` (register `"pixel-paint"` in `GAME_KITS`)

- [ ] `createPixelPaintKit(stake)` → `GameKit`; bot `plan()` uses `randomMove`
      (paints an empty cell) and returns `null` when not its turn.
- [ ] Proof: kit test drives two bots to terminal via the existing
      `driveToTerminal` harness — legality, balance conservation, no infinite loop.

### Task 3: Offline canvas window (hot-seat / vs-bot)
**Files:**
- Create: `frontend/src/games/pixelPaint/PaintWindow.tsx`
- Create: `frontend/src/games/pixelPaint/usePaintLocal.ts`
- Create: `frontend/src/games/pixelPaint/index.ts` (register window; **do not**
  import in `games/index.ts` until P1 is demoable)

- [ ] Render the W×H grid from `state.canvas`; 16-swatch palette; turn + budget
      HUD; click empty cell → `applyMove`. Vs-bot mode steps the bot on its turn.
- [ ] Adopt the Dither-style chrome (left palette, center grid, right export) in
      the dark + Sui-accent theme.
- [ ] Proof: launch the app, open the window, paint a full game vs bot to terminal.

---

## P1 — Pixel Duel PvP (relay + settlement)

### Task 4: PvP hook
**Files:**
- Create: `frontend/src/games/pixelPaint/usePvpPaint.ts` (clone of
  `frontend/src/games/ticTacToe/.../usePvpTicTacToe.ts`)

- [ ] Matchmake via relay, open `DistributedTunnel<PaintState, PaintMove>` with
      `selfParty` from match role, deposit stakes, `propose` each pixel, advance on
      `onConfirmed`, `buildSettlementHalf` on terminal.
- [ ] Wire `PaintWindow` to switch between local and PvP via a mode flag; register
      in `frontend/src/games/index.ts`.
- [ ] Proof: two browser sessions paint a shared canvas to terminal and settle;
      final canvas hash appears in the settlement projection.

---

## P2 — Saved-walls gallery (DEFERRED / optional)

The live wall is the product, not a gallery. This is an optional later add-on.

### Task 5: Gallery read view (optional)
**Files:**
- Create: `frontend/src/games/pixelPaint/Gallery.tsx`
- Edit: settlement projection read path as needed to expose paint finals
  (canvas hash/bytes + both party addresses + tx) — read-only, no new trust store.

- [ ] Justified card grid (Image #4): thumbnail rendered from settled canvas,
      co-author avatars, ↗ provenance link, meta + Recent/Top filter.
- [ ] Optional: render thumbnails through a dither/Bayer filter for the retro look.
- [ ] Proof: settled duels from P1 appear as cards with correct co-authors and a
      working provenance link.

---

## Deferred (separate spec/ADR, not in this plan)

- **P3 — Paint Wall (N painters):** composition tier — per-painter 2-party tunnel
  with a wall sequencer, Lightning-hub style (`example_multi_party_channel.move`).
  Needs its own spec + ADR per [[0010]]; **do not** start without one.

## Done-when

- P0–P2 tasks checked, tests green, two-painter PvP settles and shows in the
  gallery. No edits under `sui_tunnel/**` or `sui-tunnel-ts` core beyond the new
  `protocol/pixelPaint.ts`.
