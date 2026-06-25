# Chicken Cross — original-look UI port (design)

**Date:** 2026-06-19
**Status:** approved design, pre-plan
**Branch:** `feat/chicken-cross-ui` (worktree off `feat/chicken-cross`)

## Goal

Replace the arena Chicken Cross emoji-grid renderer with the **original**
standalone game's low-poly Three.js scene, fed by a pure adapter that converts
the arena's `CrossView` snapshot into the scene's input. Render must be **fluid
at any size** — the current ~256 px desktop tile, 400×400, or larger — with no
desktop-chrome change. Port the original's 6 sounds.

This is a **presentation-only** change. Nothing below the renderer moves:
`CrossView`, `deriveView`/`stepSession`/`sessionResult`, both hooks, the SDK
protocol, the backend, and Move are untouched.

## Non-goals

- No protocol / hook / `session-core` / SDK / backend / Move edits.
- No new `CrossView` fields (e.g. `invulnTicks`, pot `total`) — would be a
  contract change, out of scope. Respawn-immunity flash is therefore omitted.
- No desktop window resize/maximize feature (chose **fluid-fit current tile**).
- No camera-mode settings UI in v1 (default isometric `'3d'`; toggle is a later
  optional add).

## Invariants (must not change)

Verified against the code; the renderer is the _only_ thing that moves.

- **`CrossView`** = `{ tick:number; seed:number; players:{lane:number; col:number;
score:number}[]; winner:"A"|"B"|null; balanceA:number; balanceB:number }`.
  `players[0]` = party A, `players[1]` = party B (positional identity; no id field).
- **`CrossBoard` prop signature stays identical** so `ChickenCrossWindow` is
  unchanged: `{ view:CrossView; winner:"A"|"B"|null; role:"A"|"B"|null;
onDir:(d:CrossDir)=>void; onPlayAgain:()=>void; seed:number }`.
- **`setDir` stays a thin write** with auto-forward (default `"north"`, resets to
  `"north"` after each propose). Input capture must not debounce/batch/hold it
  differently — that would leak presentation into game outcome.
- **`STEP_MS = 300`** is protocol pacing, not an animation knob — untouched.
- Geometry SSoT is **imported, never re-hardcoded**: `hazardsAt`, `laneKind`,
  `COLUMN_COUNT=9`, `SPAWN_COL=4`, `WIN_LANE=20` from
  `sui-tunnel-ts/src/protocol/cross.ts`.
- Terminal/settlement decisions come from the **hook** (`winner`/status), never
  re-derived from `view`.
- SDK stays on its pnpm / `node:test` toolchain; no edits to `sui-tunnel-ts`.

## Architecture

```
frontend/
  public/sounds/                 NEW  hop|splat|splash|win|room-join|click .mp3
  src/games/chickenCross/
    scene/
      CrossScene.ts              PORTED  + container-scoped resize + full dispose
      facing.ts                  PORTED  dir → yaw
      screenInput.ts             PORTED  logical screen dir → world dir (iso-aware)
      crossViewToSnapshot.ts     NEW   pure: (view, prev, role, feeder) → snapshot
      crossViewToSnapshot.test.ts NEW  node:test
      crossSounds.ts             PORTED SoundManager (6 mp3s, silent-on-missing)
      crossInput.ts              NEW   canvas-scoped keyboard/swipe → logical dir
    components/
      CrossCanvas.tsx            NEW   owns canvas + scene lifecycle (RAF, RO, sounds, teardown)
      CrossBoard.tsx             EDIT  shell: HUD header + <CrossCanvas/> + D-pad + result overlay
      CrossLobby.tsx             EDIT  add click sound on create/join
    cross.css                    EDIT  drop 9-col grid; keep HUD/D-pad/overlay chrome
```

Each unit has one job:

- **`crossViewToSnapshot`** — pure data mapping; the only place that knows both
  the arena view and the scene wire shape. Unit-tested.
- **`CrossScene`** — render the scene from a snapshot. Ported as-is except scoped
  resize + full disposal.
- **`CrossCanvas`** — React lifecycle glue: create canvas, drive RAF, feed
  snapshots, fire sounds, tear down. No game logic.
- **`CrossBoard`** — layout shell; same props as today.

## The adapter — `crossViewToSnapshot`

Signature (pure; running state threaded explicitly so it stays testable):

```
crossViewToSnapshot(
  view: CrossView,
  prev: CrossView | null,
  role: "A" | "B" | null,
  feeder: FeederState,          // { deaths:[number,number]; facing:[CrossDir,CrossDir]; }
): { snapshot: CrossSnapshot; feeder: FeederState }
```

The scene's wire type (from the original) — fields we must produce:

```
CrossSnapshot = { type:'cross:snapshot'; protocol; roomCode; phase; serverTime;
  world:{ minLane; maxLane; lanes: CrossLaneSnapshot[] }; players: CrossPlayerState[];
  winnerId: string|null }
CrossLaneSnapshot = { index; kind:'grass'|'road'|'water'|'rails'; hazards: CrossHazardSnapshot[] }
CrossHazardSnapshot = { id; laneIndex; x; width; vx; kind:'car'|'log'|'train' }
CrossPlayerState = { id; name; column; laneIndex; score; deaths; alive; connected; facing }
```

### Lanes

`minLane=0`, `maxLane=WIN_LANE` (20). For each lane `L` in `0..WIN_LANE`:

- `kind = laneKind(L)` (arena's — same archetype as the original: 0–1 grass, then
  `(L-2)%6` → road,road,water,rails,grass,grass).
- `hazards = hazardsAt(BigInt(seed), L, BigInt(tick))` → spans `{center,half}`,
  mapped below. `grass` → no hazards.

### Hazards (the subtle part)

`hazardsAt` returns `HazardSpan[] {center, half}` — **no id, no velocity**. But the
generator is seeded by `(seed, lane)` only (tick-independent count/phase/dir/speed;
only `center` advances with `tick`). So per lane the **array length and per-index
identity are stable across ticks**. Therefore:

- **`id = `${L}:${ordinal}`** — stable, lets the scene persist & lerp a mesh
  instead of destroy/recreate each tick.
- **`x = center`**, **`width = half * 2`** (column units; cars half 0.9→w1.8,
  logs 1.4→w2.8, train 3.0→w6.0).
- **`kind`** by lane: road→`car`, water→`log`, rails→`train`.
- **`vx`** (orientation only): sign of `center(tick+1) − center(tick)`, wrap-aware
  (sample `hazardsAt` at `tick+1`). Magnitude not load-bearing.
- **Wrap handling:** `center` wraps `mod COLUMN_COUNT`; when a mesh's target jumps
  by more than a threshold (≈ half the board) the scene must **snap, not lerp**,
  that frame — flagged for the CrossScene adaptation, else a car zips across.

### Players

Two players, `players[0]`→A, `players[1]`→B. For party `i`:

- `id = "A"|"B"`, `name = "A"|"B"` (local seat may show "You" via `setLocalPlayerId`).
- `column = col`, `laneIndex = lane`, `score = score`.
- `alive = true`, `connected = true` (arena respawns instantly; no eliminated state).
- **`deaths`** = running counter, **incremented when this party's lane transitions
  `prev>0 → now===0`** (death resets lane→0, col→SPAWN_COL=4). Drives the scene's
  death/respawn animation. Held in `feeder.deaths`.
- **`facing`** = on death → `"north"`; else from position delta vs `prev`
  (lane↑ north, lane↓ south, col↑ east, col↓ west, no change → keep
  `feeder.facing[i]`). Cosmetic yaw only.

### Winner / terminal

`winnerId` mirrors `view.winner` for the scene's banner, **but** the win **sound**
and settle UI are driven by the hook's `winner` prop transition, not re-derived
from `view`.

### Stub fields

`type='cross:snapshot'`, `protocol`=scene's version constant, `roomCode=""`,
`phase='playing'` (constant — `CrossBoard` only renders during play and the scene
ignores `phase`), `serverTime = tick` — the scene reads `world`/`players`/
`winnerId`; the rest are inert.

## CrossScene port adaptations

Lift the original `CrossScene.ts` (33 KB, all-procedural geometry — no model/image
files) with three changes:

1. **Container-scoped sizing.** Replace `window.innerWidth/innerHeight`,
   `window.devicePixelRatio`, and the construction-time `window` resize listener
   with measurements of the canvas's parent via a `ResizeObserver` owned by
   `CrossCanvas`. Ortho frustum recomputed from the container aspect (DPR capped 2).
2. **Full disposal.** The original `dispose()` frees only `grassTexture` +
   `renderer` and **leaks** all lane/hazard/player/scenery geometries, materials,
   and runtime CanvasTextures, and never removes its resize listener. Add a real
   teardown: traverse the scene graph disposing every geometry/material/texture,
   clear the mesh Maps, then `renderer.dispose()`. (This is exactly the failure
   class behind the prior `chicken-cross pvp teardown` fix.)
3. **Hazard wrap snap** (see adapter): persist meshes by `id`, but snap on a
   large `x` jump instead of lerping.

Keep its public API: `new CrossScene(canvas)`, `applySnapshot(snapshot,
localPlayerId)`, `render()`, `setCameraMode('3d'|'direct')`, `setLocalPlayerId`,
`worldDirectionFromScreenInput`, `dispose()`. Port `facing.ts` and `screenInput.ts`
as-is. **Do not port the original `input.ts`** (window-bound) — `crossInput.ts`
binds keyboard/swipe to the canvas element instead.

## CrossCanvas lifecycle

A focused React component:

- On mount: create `<canvas>`, `new CrossScene(canvas)`,
  `setCameraMode('3d')`, `setLocalPlayerId(role)`; attach `ResizeObserver` to the
  wrapper; bind `crossInput` to the canvas; start the RAF loop (`scene.render()`).
- On `view` change (every 300 ms tick): `crossViewToSnapshot(view, prevRef, role,
feederRef)` → `scene.applySnapshot(snapshot, role)`; the per-frame RAF lerps
  positions between snapshots (smooths the 300 ms cadence — an upgrade over the
  stepped emoji board); update `prevRef`/`feederRef`; fire sounds (below).
- Input path: `crossInput` emits a logical screen dir →
  `scene.worldDirectionFromScreenInput(dir)` → `onDir(worldDir)` (= `setDir`,
  thin write preserved).
- On unmount: `cancelAnimationFrame`, `ResizeObserver.disconnect()`, unbind input,
  `scene.dispose()`. No `window`-global listeners survive.

## Responsiveness — fluid-fit

Top-down: `ResizeObserver` on the canvas wrapper → `renderer.setSize(w,h)` +
ortho frustum from aspect, so the same ~9-lane play area always fits vertically
at any box. The canvas fills the existing 16 rem desktop tile and scales fluidly;
no `Desktop.tsx`/`GameWindow.tsx` change. Built size-agnostic so a future
maximize/resize feature works for free.

## Sounds

6 mp3s → `frontend/public/sounds/` (served at `/sounds/*.mp3`). `crossSounds.ts`
ported (silent-on-missing). Triggers (presentation-only — read state, never mutate):

| sound     | trigger (in `CrossCanvas`/`CrossLobby`)                         |
| --------- | --------------------------------------------------------------- | ---- |
| hop       | any player's `lane` increased vs prev view                      |
| splat     | death (`prev>0 → now===0`) and `laneKind(prevLane) !== "water"` |
| splash    | death and `laneKind(prevLane) === "water"`                      |
| win       | `winner` prop transitions `null → "A"                           | "B"` |
| room-join | `CrossBoard` first mount (match has started)                    |
| click     | lobby create/join buttons + D-pad presses                       |

Death detection is view-only (`invulnTicks` is not in `CrossView`); `prev>0 →
now===0`, corroborated by `col===SPAWN_COL`, is the reliable signal.

## Dependencies

Add to **frontend** (pnpm): `three@^0.184.0`, `@types/three@^0.184.1` (matching
the original's pin). Adds **~135 KB gz** to the shared Vite bundle — accepted
trade for the original look. Pin the version and verify
`renderer.outputColorSpace` / `ColorManagement` so the hand-tuned palette renders
as in the original 0.184 build.

## Testing

- **Unit (`crossViewToSnapshot.test.ts`, `node:test` via `tsx`)** — co-located,
  matching `session-core.test.ts` style. Covers: lane-kind mapping over a range;
  hazard `id`/`x`/`width`/`kind` from a known `(seed,lane,tick)`; A/B positional
  order; `deaths` increments on `prev>0→0`; `facing` from deltas and reset on
  death; `winner` passthrough. Run: `node --import tsx --test
"src/games/chickenCross/*.test.ts"` (the default `test` script globs blackjack
  only — note this; do not change the script in this work).
- **Smoke** — `CrossCanvas` mount→unmount throws nothing and `dispose()` runs
  (guard against the teardown regression).
- **Gate** — `cd frontend && pnpm typecheck && pnpm build` stays green (now
  includes `three`).
- **Manual E2E** — run the app: original look renders in the tile; fluid at
  ~256 px and 400×400; 6 sounds fire on the right events; PvP re-match mounts
  cleanly (no leak, no double-audio).

## Risks

- **Color management** — recent three default sRGB/ColorManagement may shift the
  palette; verify output color space. _Mitigation: pin 0.184, eyeball vs original._
- **Hazard wrap** — must snap-not-lerp on `mod` wrap or cars teleport-slide.
  _Mitigation: threshold check in `applySnapshot`._
- **Teardown** — leaks across PvP re-matches if disposal is incomplete (known
  prior bug). _Mitigation: full graph dispose + scoped listeners; smoke test._
- **Bundle weight** — +135 KB gz. _Accepted; single isolated game dep._
- **Death-sound edge** — if death and a hop coincide, `laneKind(prevLane)` vs the
  exact death lane may differ by one; only affects splat-vs-splash choice on a
  sound. _Accepted._

## Out of scope (future)

Camera-mode toggle UI; desktop maximize/resize; respawn-immunity flash (needs a
`CrossView` contract change); nametag polish; mobile haptics.
