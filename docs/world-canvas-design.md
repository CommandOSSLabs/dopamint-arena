# The World is Your Canvas — collaborative pixel wall on the Sui Tunnel arena

> **Status:** Research / design foundation (pre-ADR). Read-only study; no code changed.
> **Author:** design spike. **Date:** 2026-06-23.
> **Scope:** A _new, separate_ arena game — an **infinite**, N-painter collaborative pixel canvas,
> driven by an "Agent AI" button that spawns bots painting forever alongside humans, optionally
> layered on an OpenStreetMap basemap. Does **not** touch pixel-duel (the 2-party fog-of-war duel),
> which stays as-is.

---

## 1. Concept and where it sits

**Wplace** (https://wplace.live) is a single, global, real-time **collaborative** pixel canvas
painted over the world map: anyone places a pixel, a per-pixel/per-painter **cooldown** rate-limits
them, and the art accretes globally and permanently. There is no winner — the wall _is_ the artifact.

**The World is Your Canvas** is that, on the Sui tunnel arena, with one north-star reframing: **1 painted
pixel = 1 co-signed tunnel move = 1 TPS.** This is the standard Sui **state-channel** model — the same one
every other arena game (tic-tac-toe, battleship, blackjack, …) runs on: paints are **executed off the L1
hot path** for throughput, but each is a real dual-signed state transition **secured and settled on-chain** —
the tunnel **opens on-chain** and **periodically anchors its co-signed state root on-chain** via
`close_cooperative_with_root`. "On-chain game, off-chain execution," not "off-chain game." The whole point
is to turn a crowd of painters — human _and_ agent — into a fleet of high-frequency tunnels and show the
throughput live on the arena dashboard. The canvas is **infinite / unbounded**: it grows in every direction,
stored sparsely (only painted cells), so play never hits a wall.

### The core interaction: the "Agent AI" button

The product is built around one button. The canvas is shared and infinite; two kinds of painters fill it:

- **Human** — click a cell to place a pixel. Each placement co-signs one tunnel update with the hub.
- **"Agent AI" button** — **each click spawns one AI agent** that holds its own ephemeral key, opens its
  own 2-party tunnel to the Canvas Hub, and paints **random art continuously, forever** (autonomous
  strokes, no human in the loop). **Multiple clicks = multiple agents** painting in parallel on the same
  shared canvas. The agents never stop until explicitly closed → an endless stream of co-signed pixels →
  **endless TPS**.

Humans and agents paint the _same_ canvas at the same time; every paint from either side is one co-signed
tunnel tx. The TPS dial is literally driven by how many Agent-AI bots are live and how fast they stroke —
spawn more agents, the number climbs. This is the demo: a human paints a few deliberate pixels while a
fleet of clicked-into-existence agents floods the wall around them, and the dashboard shows the throughput.

**Relation to pixel-duel / the deferred Paint Wall.** pixel-duel (on `feat/pixel-duel`) is a strict
**2-party** game: two players, fog-of-war, deterministic turns, settle to a winner. Its ADR explicitly
**deferred** the "Paint Wall" — an N-painter shared canvas — noting it is only reachable _"by composing
2-party tunnels."_ The World is Your Canvas is that deferred game, built as a **separate** game package. It
shares patterns and infra with pixel-duel but **none of its rules**: no fog, no turns, no winner, unlimited
painters, transparent global state.

The hard constraint that makes this a design problem (not a copy-paste) is in
[`sui_tunnel/sources/tunnel.move`](../sui_tunnel/sources/tunnel.move): a tunnel has exactly
`party_a` and `party_b`, and `close_cooperative_with_root<T>` (L1065) settles on exactly **two**
signatures `sig_a`, `sig_b`. **There is no N-party tunnel.** Everything below is about getting an
N-painter wall out of a 2-party primitive _without forking the Move contract_.

---

## 2. The core problem: N painters on a 2-party tunnel

A tunnel is two parties co-signing a shared state. A wall is N painters (humans + agents) sharing one
canvas. The two do not line up. Four ways to bridge them:

| #     | Architecture                                                                    | Move change           | Per-pixel TPS     | Settlement                    | Verdict                                                  |
| ----- | ------------------------------------------------------------------------------- | --------------------- | ----------------- | ----------------------------- | -------------------------------------------------------- |
| **A** | **Hub-and-spoke** — each painter holds a 2-party tunnel with a Canvas Hub agent | **none**              | 1 / pixel         | per-painter cooperative close | **RECOMMENDED**                                          |
| B     | Region-sharded — one 2-party tunnel per map tile, painters pair into it         | none                  | ~1/N (idle seats) | tile-consensus (not 2-party)  | no — reintroduces N-party at the tile                    |
| C     | Relay-broadcast — relay fans every move to all painters; all co-sign one wall   | **yes** (N-sig close) | N on one tx (bad) | N signatures on-chain         | no — needs the forked contract this game exists to avoid |
| D     | Compose-per-pixel — a fresh transient tunnel per pixel, then aggregate          | none                  | open/close churn  | one settle _per pixel_        | no — open/fund/close overhead per pixel kills it         |

### Recommendation: A — Hub-and-spoke

```
Human painter   (browser, ephemeral key) ⇄ relay ⇄ Canvas Hub agent (party B)   ┐
Agent-AI bot #1 (spawned key)            ⇄ relay ⇄ Canvas Hub agent (party B)   ├─ N independent 2-party tunnels
Agent-AI bot #2 (spawned key)            ⇄ relay ⇄ Canvas Hub agent (party B)   ┘
                                              │
                                              ▼
                                   Global wall (hub-owned merge):
                                   pixel[x,y] = last-write-wins by (ts)
```

Each Agent-AI click adds one more spoke; the human is just another spoke. The hub is party B on all of
them.

**Why A, concretely:**

- **Zero Move changes, zero relay changes.** Each painter↔hub link is an ordinary 2-party tunnel.
  The relay ([`backend/tunnel-manager/src/mp/ws.rs`](../backend/tunnel-manager/src/mp/ws.rs)) is an
  **opaque frame forwarder** keyed by `match_id`/`game` — it never sees state, never signs. N painters
  = N matches it already multiplexes. It does not learn the word "canvas."
- **Parallelism is by tunnel count, not concurrency on one tunnel** — exactly the framework's
  throughput model. TPS scales ~linearly with painter count (= spawned agents + humans) until the hub's
  signing rate or relay bandwidth saturates.
- **The shared wall lives in the hub, not in any tunnel's state.** This is the key insight: each
  painter's tunnel state is _that painter's own stroke list_ (proves "painter X co-signed these pixel-
  ops" — provenance + TPS). The **global** canvas is the hub's aggregate across all tunnels; the hub
  is the ordering authority that merges concurrent writes (per-pixel **last-write-wins by timestamp**,
  cooldown enforced in `applyMove`). No tunnel ever needs to know about another painter.
- **On-chain settlement is a periodic cooperative close, not per pixel.** Instead of closing only once
  at the end (the finite games' model — they settle when a winner emerges), the endless wall **checkpoints**:
  every `CHECKPOINT_EVERY` co-signed paints a tunnel cooperatively closes via `close_cooperative_with_root`
  (free mode → balances unchanged → a genuine draw, no dispute surface), **anchoring its transcript root
  on-chain**, then immediately reopens so painting never stops. This is what makes the wall genuinely
  "on-chain": the paints execute off the hot path, but their co-signed state is committed on-chain at every
  checkpoint (and the full transcript is archivable to Walrus, exactly like the finite games' settle).

**Honest caveat on the TPS claim — what's actually shipped.** A painter↔hub tunnel is a _genuine_ two-party
tunnel **only if the hub is a real separate party** (its own key, its own process) co-signing over the real
relay. **The shipped Phase 0 is self-play**: each painter (human and every Agent-AI) holds _both_ seat
keypairs and co-signs both sides locally on its **own** 2-party tunnel. This still respects the framework's
2-party rule (every tunnel has exactly two seats) and produces real dual-signed, on-chain-settled moves —
but it is **self-play TPS**, and should be labelled as such (the dashboard chip reads "Self-play"). Phase 1
(humans as party A vs a genuine separate hub party B over the relay) is the upgrade to genuine two-party
TPS. Keep this distinction visible — don't quietly claim genuine-tunnel TPS for a self-signing painter.

Rejected alternatives in one line each: **B** drags N-party consensus back to the tile level; **C**
needs the N-signature contract fork this game was created to avoid; **D** pays open/fund/close per
pixel. All three lose to A on either Move-change cost or per-pixel overhead.

---

## 3. Map, Coordinates & Rendering

**LIGHTWEIGHT is the #1 constraint.** A real-time pixel canvas must stay performant and trivial to run.
The decision that follows from that: **the map is not in the critical path** — the canvas is a self-
contained infinite chunked grid that runs with **zero** map dependency (Phase 0), and a basemap is layered
_under_ it only when geographic anchoring is actually wanted (Phase 1). Pick the lightest thing that proves
the behaviour at each phase.

### 3.1 Map library — lightest-first, Mapbox rejected

| Library                  | Bundle (gz) | Token / cost              | Rendering             | Verdict                                                                         |
| ------------------------ | ----------- | ------------------------- | --------------------- | ------------------------------------------------------------------------------- |
| **Canvas-only** (no map) | **0 KB**    | free                      | native Canvas2D       | **Phase 0** — lightest possible; infinite grid, no basemap                      |
| **MapLibre GL**          | ~160 KB     | free, no token            | WebGL vector          | **Phase 1 default** — OSS Mapbox fork, drop-in, OSM basemap                     |
| **Leaflet**              | ~40 KB      | free, no token            | Canvas2D raster tiles | Phase 1 light-budget alt (raster, less crisp)                                   |
| **Mapbox GL JS**         | ~180 KB     | **token + usage pricing** | WebGL vector          | **NO** — auth friction, pricing-at-scale risk, bundle bloat for a pixel overlay |
| deck.gl                  | 200+ KB     | free                      | WebGL data-viz        | NO — over-engineered for a pixel grid                                           |

**Verdicts:**

- **Phase 0 → canvas-only.** No basemap, 0 KB added, maximum pixel-render perf (direct draw, no layer
  translation), full control over the infinite pan/zoom + chunk math. This is the lightweight MVP.
- **Phase 1 → MapLibre GL** when the OSM basemap and geo-anchoring land. Identical WebGL performance to
  Mapbox, **no token, no pricing, no auth** — and if we ever _did_ want Mapbox, migration is a one-line
  import swap. The pixel grid sits on top as a custom layer or a viewport-synced canvas overlay.
- **Leaflet** is the fallback only if 160 KB is judged too heavy: ~4× lighter, but raster tiles (less
  crisp at zoom extremes) and Canvas2D rather than WebGL. Fine for cooldown-gated UX; choose only if
  load-time telemetry demands it.
- **Do NOT use Mapbox GL JS** — it is the heaviest _and_ the only one with token + usage-pricing friction.
  MapLibre is the free, faster-onboarding, drop-in equivalent. There is no scenario in this game where
  Mapbox wins.

### 3.2 Coordinate mapping — Web-Mercator, geo-locked across zoom

Pixels are addressed in **Web-Mercator (EPSG:3857) world-pixel space** — the same projection OSM / Google
/ Mapbox use — so a pixel painted in Ho Chi Minh City stays **locked to that lat/long forever**, at every
zoom level. Tiles are 256×256 at every zoom; the world at zoom `z` is `256·2^z` px per side; latitude is
clamped to ±85.0511°, longitude wraps at ±180°. A practical **base zoom** for "1 paintable pixel" is
**z = 16** (≈ 3 m on the ground per pixel — neighbourhood scale, and one paint cell aligns 1:1 with an OSM
tile texel).

```typescript
// lat/long → world-pixel (continuous coords at zoom z)
function latLonToWorldPixel(
  lat: number,
  lon: number,
  z: number,
): { x: number; y: number } {
  const n = 256 * 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * n;
  return { x, y };
}

// world-pixel → lat/long (inverse, for "what did I just click")
function worldPixelToLatLon(
  x: number,
  y: number,
  z: number,
): { lat: number; lon: number } {
  const n = 256 * 2 ** z;
  const lon = (x / n) * 360 - 180;
  const lat =
    (Math.atan(Math.sinh(Math.PI * (1 - 2 * (y / n)))) * 180) / Math.PI;
  return { lat, lon };
}
```

**Why it stays locked:** the transform is zoom-aware and deterministic. A cell's world-pixel coordinate at
the base zoom is its identity; the map camera (or, in Phase 0, the canvas camera) reprojects it to the
screen on pan/zoom, but the underlying geo-coordinate never moves. To paint from a screen click in Phase 1,
unproject the click to lat/long via the map, then `latLonToWorldPixel(...)` at the base zoom to get the
cell — and send that cell to the hub.

### 3.3 Chunked grid — 256×256, viewport culling, dirty-chunk redraw

The infinite world is divided into a grid of **256×256-pixel chunks** (65 536 cells each — matches the
slippy-map tile size, so projections/tooling stay familiar and a chunk fits one `OffscreenCanvas` with no
perf cliff). Only chunks intersecting the viewport are loaded and rendered; everything else stays cold.
This is what keeps the canvas lightweight at unbounded size and many painters.

```typescript
function worldPixelToChunk(px: number, py: number) {
  return { chunkX: Math.floor(px / 256), chunkY: Math.floor(py / 256) };
}
function chunkOrigin(chunkX: number, chunkY: number) {
  return { x: chunkX * 256, y: chunkY * 256 };
}
```

Longitude wraps (chunk X is modular); latitude is clamped (chunk Y does not wrap). The render/storage
pipeline:

- **Viewport culling.** On mount/pan/zoom, compute the visible chunk range from the camera's world-pixel
  bounds (`floor(minX/256) … floor(maxX/256)` × same for Y); fetch/subscribe only those chunks.
- **LRU chunk cache.** Keep a bounded set of chunks resident (e.g. ~64 ≈ an 8×8 screen + margin, ~4 MB of
  canvas data); on cache miss fetch from the hub, promote on hit, evict the least-recently-used when over
  capacity. Memory stays ~constant regardless of how big the wall grows.
- **Dirty-chunk redraw.** One `OffscreenCanvas(256,256)` per resident chunk. Incoming paint deltas mark
  their chunk **dirty**; once per `requestAnimationFrame` tick, only dirty chunks are re-rasterized, then
  _all_ visible chunk canvases are blitted to the screen canvas in a single composite. Redraw cost is
  bound by _new pixels this frame_, not by total wall size — network-RTT bound, not CPU bound.
- **rAF batching.** A single render loop per viewport (mounted once, torn down on unmount); inbound deltas
  are queued and applied once per frame, never per-message — so a flood of agent pixels still costs one
  composite per frame.

```typescript
// one render tick: redraw only dirty chunks, then blit visible ones
function renderFrame(
  screen: CanvasRenderingContext2D,
  cam: Camera,
  vis: ChunkRange,
) {
  for (const key of dirty) redrawChunkOffscreen(key); // rasterize sparse cells → 256×256 canvas
  dirty.clear();
  for (let cx = vis.minX; cx <= vis.maxX; cx++)
    for (let cy = vis.minY; cy <= vis.maxY; cy++) {
      const off = chunkCanvases.get(`${cx},${cy}`);
      if (!off) continue;
      const sx = (cx * 256 - cam.worldX) * cam.scale + cam.centerX;
      const sy = (cy * 256 - cam.worldY) * cam.scale + cam.centerY;
      screen.drawImage(off, sx, sy);
    }
}
```

**Storage (backend), unchanged from §2's hub model.** Hot chunks live in the existing Redis/Valkey control
plane, keyed `z/{chunkX},{chunkY}`, each a **sparse** list of `{cell, color, ts, painter}` (only painted
cells, never a full grid). Cold chunks are reconstructed from periodic Walrus snapshots + redo log. The
client mirrors this: sparse `Map<cellId, color>` per chunk, never a dense allocation.

### 3.4 Per-pixel cooldown (the core gate, not a wager)

- **Per-painter, per-session timer**, default ~5 s (config). Tracked as `lastPaintAt`; a placement with
  `now - lastPaintAt < COOLDOWN_MS` is **rejected in the protocol's `applyMove`** (throws → illegal
  move, never advances the tunnel) and pre-empted client-side for UX. Applies to humans; Agent-AI bots run
  their own (faster) stroke cadence so the fleet keeps the TPS high.
- **Server is authoritative; client is optimistic.** Client paints immediately on click and starts a
  radial-ring countdown (gray→accent "READY"); on a sync mismatch it trusts the server's `lastPaintAt`.
  Resets on placement, session start, and region change — **not** on a failed placement, zoom/pan, or
  palette change.
- **Palette:** 16 colours, matching the duel protocol's `NUM_COLORS`, so colour encoding is shared.

### 3.5 First screen (region → paint)

Region picker (search place / presets / drag-bounds) → enter → map (Phase 1) + pixel overlay + bottom
palette dock + the **"Agent AI"** spawn button + cooldown ring + a collapsible right sidebar: **Activity**
(recent placements in viewport, click a row to pan), **Painters** (live presences via heartbeat cursors,
humans and agents distinguished), **Regional stats** (online now, pixels/h, live TPS, heatmap toggle).
Presence rides the relay/SSE the arena already runs.

---

## 4. TPS story and economy

### TPS — driven by the Agent-AI fleet

The throughput model is fleet-of-tunnels, not loops-on-one-tunnel — and the "Agent AI" button _is_ the
throttle the user controls:

```
effective TPS = (live Agent-AI bots + human painters) × (pixels/sec per tunnel)
```

- **Concurrent tunnels:** every Agent-AI click adds a spoke. The agent runner is already URL-driven —
  [`frontend/src/agent/agentConfig.ts`](../frontend/src/agent/agentConfig.ts): `?agent` turns the real
  app into a self-driving agent, `?m=N` sets concurrent tunnel slots, `AGENT_GAMES` is the rotation set
  (currently **tic-tac-toe only** — the others are commented out because only its move-trigger is
  protocol-driven; re-adding a game means making its trigger protocol-driven, then adding a `GameSpec`).
  Add `{ id: "world-canvas", behavior: "world-canvas", stake: 500n }` once Phase 0 lands.
- **Pixels/sec per tunnel:** network-RTT bound, not CPU bound. Agent-vs-hub ~10–100 ops/s; humans
  ~1 every cooldown. 100 Agent-AI tunnels × ~20 ops/s ≈ 2 000 effective TPS — and it composes upward
  with more agent processes / more clicks.
- **Measurement is already built.** [`backend/tunnel-manager/src/stats.rs`](../backend/tunnel-manager/src/stats.rs):
  a `RateWindow` computes a **5 s sliding-window derivative** (Prometheus-`rate()` style) of a monotonic
  action counter on a 500 ms tick, per game (`per_game` map keyed by the game id string). The dashboard
  log-normalizes (`log10(tps)/6`) over an SSE feed.
- **Reporting contract** ([`docs/adding-a-tunnel-game.md`](adding-a-tunnel-game.md) §Reporting TPS):
  - _Self-play (Phase 0 Agent-AI bots):_ the client sends throttled **action deltas** via `flushHeartbeat` —
    one action per verified `tunnel.step()`, never per render/retry; force-flush the tail on settle.
  - _PvP / human-vs-hub (Phase 1):_ the **relay counts server-side** as it ingests co-signed frames,
    so the client must **not** send `actionsDelta` (double-count). This split is mandatory — do not copy
    the self-play heartbeat into the human hook.

### Economy — free to play, no SUI required

- **Gas sponsorship** ([ADR-0009](decisions/0009-sponsor-create-and-fund-gas.md)): the settler pays all
  gas in SUI; the player pays nothing. Painters never hold SUI.
- **DOPAMINT stake** ([ADR-0010 stake token](decisions/0010-dopamint-stake-token.md)): an unlimited
  faucet-minted token. Before staking, if a painter's balance is short, one gas-sponsored `mint` tops
  them up **invisibly** (no balance UI, no faucet button). A 0-SUI / 0-DOPAMINT visitor connects →
  faucet mints (sponsored) → open/fund stakes DOPAMINT (sponsored) → paints. Fully free.
- **Per-game flat stake, no per-pixel cost.** A pixel is an off-chain move — it costs nothing on-chain.
  On-chain cost is **open/fund/close only** (~3 txs per painter session), and is independent of TPS;
  it scales with _tunnel count × settle frequency_, not pixels. Free mode = balances never shift =
  every close is a draw = zero dispute surface. The only finite resource under load is the **settler's
  SUI for gas** — monitor/refill it (the deferred rate-limit/budget from ADR-0010 applies here too).

---

## 5. Phased MVP (each phase shippable on its own)

**Lightweight-first ordering.** Phase 0 ships the _lightest thing that proves the loop_: a canvas-only
infinite chunked wall painted by Agent-AI bots — **no map, no humans, 0 KB of map dependency.** The map
(MapLibre/OSM), human painters, and geo-anchoring are deliberately deferred to Phase 1, because none of
them are needed to prove "Agent-AI click → endless co-signed pixels → live TPS." Add weight only when the
prior phase has earned it.

### Phase 0 — Prove the TPS: canvas-only infinite chunked wall, Agent-AI bots, no map, no humans

**Goal:** a live, growing **infinite** shared grid driven entirely by Agent-AI bots, rendered with the
256×256 chunked-grid + viewport-culling + dirty-chunk-redraw pipeline (§3.3) on a **plain Canvas2D camera —
no basemap, no map library**. The dashboard shows real per-game TPS. No OSM, no cooldown, no human UI.

- **Protocol** `sui-tunnel-ts/src/protocol/worldCanvas.ts` implementing `Protocol<State, Move>`. Model
  it on **`chat.ts`**, which is the closest existing fit: append-only moves, **`rollingDigest`** for an
  O(1) `encodeState` of unbounded state, `isTerminal()` settle-on-demand, balances conserved (free mode).
  - `State`: `{ canvas: Map<cellId,{color,ts,painter}>, placed: bigint, balances, seed }` — sparse, so
    the infinite canvas costs only what's painted.
  - `Move`: `{ x, y, color }`. `applyMove`: paint cell, bump `placed`, balances untouched.
  - `encodeState`: `domain || placed || rollingDigest(canvas)`. `balances`: unchanged (draw).
  - `isTerminal`: explicit close (the Agent-AI bots paint **forever** by default; an optional cap exists
    only for bounded test runs). `randomMove`: random cell + random colour (drives the bots' random art).
  - Co-locate `worldCanvas.test.ts` (`node:test` via `tsx`): conservation, determinism, terminal draw.
- **Frontend package** `frontend/src/games/worldCanvas/` (copy the blackjack self-play shape):
  `useWorldCanvasSession.ts` (open/fund self-play, heartbeat, settle), `session-core.ts` (pure
  `stepSession`, type-only SDK imports), `WorldCanvasWindow.tsx` (status router + grid + TPS counter +
  the **"Agent AI"** spawn button), `components/WorldGrid.tsx` (the infinite chunked Canvas2D camera —
  pan/zoom/cull/dirty-redraw, adapted from pixel-duel's `PixelCanvas` core, **no fog/turns**),
  `index.ts` register, and `import "./worldCanvas"` in `frontend/src/games/index.ts`.
- **No backend / no Move changes.** `game: "world-canvas"` auto-routes through the generic relay,
  settle route, and stats `per_game` bucket.
- **Hub:** one house-agent wallet funds the painter tunnels; each Agent-AI click cycles a spoke that paints
  cells/colours indefinitely. (Phase 0 may run the hub self-signing — label the TPS as self-play; see §2
  caveat.)

### Phase 1 — Real wall: add the map (MapLibre/OSM), cooldown, human painters

- Layer an **OSM basemap under the existing chunked grid** — **MapLibre GL** (free, no token; §3.1), with
  Leaflet as the light-budget fallback. The Phase 0 canvas becomes a custom map layer / viewport-synced
  overlay; the chunk math is unchanged, now driven by the map camera. Coordinate mapping per §3.2 locks
  every pixel to its lat/long. Humans click to paint via their own tunnel.
- **Genuine two-party:** human is party A, the **Canvas Hub agent** is party B over the real relay.
  Switch the engine from `OffchainTunnel.selfPlay` → `DistributedTunnel`; match via
  `MpClient.quickMatch("world-canvas")` (the relay path PvP games already use). Heartbeat: drop the
  client counter, let the **relay** count (§4). Agent-AI bots keep running alongside the humans.
- Add per-painter cooldown to `applyMove` + the radial-ring HUD + presence/Activity sidebar over SSE.
- Hub merges all painter tunnels into the global wall (last-write-wins by ts), publishes periodic
  Walrus snapshots.

### Phase 2 — Scale out: region sharding

- Split the world into regions; one hub per region (or multi-hop composition via the framework's `hop`
  module for cross-region strokes). Paint stays off-chain per shard; periodic shard roots anchored to
  Walrus. This is where "thousands of concurrent painters" actually lands. Deferred to its own ADR.

---

## 6. Open questions and risks

1. **Genuine-tunnel vs self-play framing (highest-leverage).** The headline TPS is only honest if the
   hub is a real remote party co-signing over the relay. Decide per phase and label the dashboard
   accordingly. A self-signing hub is fine for a showcase but must not be sold as genuine-tunnel TPS.
2. **N-party settlement is sidestepped, not solved.** Hub-and-spoke keeps each settle 2-party; the
   global wall has no single on-chain owner — it is the hub's merged artifact, anchored by Walrus roots.
   If we ever want the _wall itself_ trustlessly settled, that needs the contract fork (architecture C)
   and a fresh ADR.
3. **Hub trust / censorship.** The hub orders cross-painter writes and can in principle drop or reorder
   them. Mitigation: each painter's tunnel transcript root proves _their_ co-signed strokes (dispute
   floor), and the hub can later decentralize via multisig/threshold co-signing. Out of scope for MVP.
4. **Persistent global state.** Redis-only (resets on restart) for MVP; periodic Walrus snapshots +
   chain anchor for production. Where the canonical wall lives long-term is an ADR.
5. **Settler SUI drain.** Every close burns settler gas; under fleet load this is the real bottleneck.
   Rate-limit + spend-budget (deferred in ADR-0010) become load-bearing here.
6. **Agent-AI spawn caps.** Each click spawns a forever-painting agent; unbounded clicks can saturate the
   hub signer / relay / settler. Need a per-client spawn cap + a global concurrency ceiling, decided under
   load testing.
7. **Cooldown fairness & per-region concurrency caps.** Global vs per-region vs per-tile cooldown, and
   whether to cap painters per region for responsiveness — defer to load testing.
8. **Moderation.** Offensive pixels persist; needs a moderation flag + Walrus purge in v2.
9. **Agent move-trigger.** Only tic-tac-toe is move-trigger-ready in `AGENT_GAMES`; World Canvas must
   ship a protocol-driven trigger to join the fleet rotation, not a phase-based one that would stall.

---

## 7. What it reuses from the arena

| Layer                   | Reused as-is                                                                                                                     | New / adapted                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **Move contract**       | `tunnel` (`create`/`deposit`/`close_cooperative_with_root`), generic over coin `T`                                               | none                                                                                |
| **Stake / gas**         | ADR-0009 sponsor (gas-only), ADR-0010 DOPAMINT faucet + invisible auto-faucet                                                    | none                                                                                |
| **Relay**               | opaque `match_id`/`game` frame forwarder (`mp/ws.rs`), `quickMatch`, `Connect`/`Resume`                                          | none                                                                                |
| **Protocol SDK**        | `Protocol<State,Move>` interface, `rollingDigest`, `chat.ts` as the template                                                     | `worldCanvas.ts`                                                                    |
| **TPS / dashboard**     | `stats.rs` 5 s `RateWindow` derivative, `per_game` bucket, SSE log-scale chart                                                   | a `"world-canvas"` id                                                               |
| **Heartbeat**           | `flushHeartbeat` self-play contract; relay-side counting for human-vs-hub                                                        | obey the split (§4)                                                                 |
| **Agent fleet**         | `?agent&m=N` runner, `AGENT_GAMES` rotation, `GameSpec`                                                                          | one `GameSpec` entry + "Agent AI" button                                            |
| **Frontend game shape** | blackjack self-play package layout; `useBlackjackSession` / `session-core` patterns; `onchain/tunnelTx.ts` `openAndFundSelfPlay` | `worldCanvas/` package                                                              |
| **Render**              | pixel-duel `PixelCanvas` core (rAF, zoom/pan, snap, cull, ghost)                                                                 | strip fog/turns; infinite 256×256 chunked grid; Phase 1 OSM Mercator under MapLibre |
| **Resilience**          | ADR-0010 MP resume (rebind + peer-reconcile) for dropped painters                                                                | none                                                                                |

---

### Bottom line

Build **hub-and-spoke**: N genuine 2-party painter↔hub tunnels — one per human, one per **Agent-AI** click
— with the global infinite wall as the hub's merged artifact anchored to Walrus, **zero** Move/relay
changes. Stay **lightweight-first**: Phase 0 is a canvas-only (0 KB map) infinite 256×256-chunked wall
painted by Agent-AI bots with live TPS, on the existing self-play + heartbeat + stats path. Phase 1 layers
an **OSM basemap via MapLibre** (free, no token — **never Mapbox**), Web-Mercator geo-locked coordinates,
cooldown, and human-vs-hub tunnels; Phase 2 shards for scale. Model the protocol on `chat.ts` (append-only

- `rollingDigest`, free-mode draw). The one thing to keep honest throughout: only call it genuine-tunnel
  TPS when the hub is a real co-signing party over the relay.

## 8. Build references

- **[hmldns/pix-canvas](https://github.com/hmldns/pix-canvas)** — reference for the pixel-canvas **drawing**: the infinite chunked canvas, pan/zoom camera, pixel placement, and chunk load/evict loop. Mine its rendering pipeline for the §3.3 chunk system.
- **[nianez/game-ui](https://github.com/nianez/game-ui)** — reference for the arena **game UI** (the earlier 2D version, **not** the latest 3D). Mine its component look + layout for the World Canvas window.

> Study these when starting Phase 0 (canvas-only infinite chunked wall + the Agent-AI button); adapt, don't copy wholesale.

## 10. Smooth brush + modes + templates (TPS)

> **This section supersedes the directions above where they conflict.** Specifically it
> retires (a) the **r/place pixel-grid aesthetic** — World Canvas is now a _smooth,
> anti-aliased brush-painting_ game, no visible grid — and (b) the **on-chain canvas
> object / Walrus persistence / OSM-map / region-shard** roadmap (§3 map, §5 Phases 1–2,
> §6 persistence). On-chain stays **minimal: tunnel open + optional cooperative settle
> only** — no canvas object, no deploy, no map. Everything else below reuses the
> _already-built_ path verbatim: per-painter self-play tunnels, the chunked render store,
> click+drag smooth paint, Agent-AI bots, speed controls, owner-hover, Players/Activity +
> Leaderboard. **No Move / SDK / protocol changes** — the signed move is frozen.

### 10.1 The one frozen fact (everything bends around it)

A co-signed move is **strictly an integer cell + a 16-palette index** and is golden-pinned
in the upstream SDK: `WorldCanvasMove = {cx,cy:bigint, x,y:int∈[0,256), color:int∈[0,16)}`,
hard-rejected if non-integer/out-of-range (`sui-tunnel-ts/src/protocol/worldCanvas.ts:163-185`),
with a `GOLDEN_DIGEST` byte-parity test. **There is no float / sub-pixel / alpha channel on
the wire.** Therefore:

> **Smoothness is a _render-layer_ property, never a _data_ property.** Every "smooth"
> stroke is computed in float path-space, **rasterized to integer cells as the final step**,
> and the renderer manufactures the soft, anti-aliased look. The grid never leaves the data
> model; it only leaves the screen.

### 10.2 The brush → co-signed-move → TPS contract (already true; keep it exact)

`1 newly-painted cell = 1 verified `tunnel.step()` = 1 action = ~1 TPS` — the same
denominator as a Sui on-chain function call (`docs/adding-a-tunnel-game.md` "Reporting TPS").
The chain is already in place and must stay byte-identical:

- **Gate:** only `r.verified` (both signatures check) books a move —
  `coSignPaint()` (`useWorldCanvasOnchain.ts:563-583`): `run.moveCount++ → run.actions++ →
totalMovesRef++ → paintCell → recordPaint → flushHeartbeat`.
- **No no-op:** the rolling digest folds the painter byte + coordinate, so every paint
  strictly mutates the co-signed state hash (overpaint is a legal, counted move).
- **Stroke decomposition (built, do not re-derive):** a drag emits pointer samples →
  `interpolateCells()` Bresenham-walks the gap (`WorldCanvas.tsx:69-97`) → `stampBrush()`
  expands each sample to an N×N footprint (`:516-524`) → `placeAt()` dedupes against
  `strokeSet` so **each cell co-signs exactly once per stroke** (`:496-512`), echoes the
  pixel optimistically, and fires `onPaint` without awaiting. **A fast brush stroke = a TPS
  burst** (many unique cells co-signed in a few ms); a tap = 1.
- **Parallel painters:** human paints seat A of its persistent tunnel; **each Agent-AI owns
  its own tunnel** and paints seat B (`useWorldCanvasOnchain.ts:9-19, 816-855`). N agents ⇒
  N+1 independent co-signing pairs ⇒ additive TPS, no nonce contention.
- **The TPS levers** stay: brush size (cells/sample = N²), stroke speed (samples × line
  length), agent count, agent paint interval (`AGENT_SPEED_INTERVALS` 240/120/50 ms), and —
  **new in §10.4** — per-agent _batch_ (cells co-signed per tick).

> **Risk already mitigated:** stroke-overlap double-co-signs (which would corrupt the
> tunnel nonce) are prevented by the active `strokeSet` dedupe — keep it; never co-sign a
> cell twice within one logical stroke or stamp.

### 10.3 The SMOOTH render (no pixel grid) — what changes in `ui/WorldCanvas.tsx`

The blockiness comes from three lines, all in the renderer, none on the wire:
`ctx.imageSmoothingEnabled = false` (`WorldCanvas.tsx:315`), `imageRendering:"pixelated"`
(`:651`), and the `v.scale >= 8` per-cell grid draw (`:374-391`). The data model — per-chunk
`buf:Uint8Array` of `color+1`, `writeCell` O(1) raster, eviction, hover/ownership — stays
**100% unchanged** (it is the canonical color truth). We render that same truth _softly_ in
three composited layers:

1. **Soft color field (the static substrate).** Keep `writeCell` and the 256-res per-chunk
   `ImageData` exactly as is (cheap, O(1), last-write-wins = exact overpaint truth). On the
   final blit, flip to **`imageSmoothingEnabled = true`** (bilinear upscale) and drop
   `imageRendering:"pixelated"`. Delete the grid block (`:373-391`). This alone melts the
   hard cell edges — the already-painted wall reads as a soft field, not squares, at **zero**
   per-cell cost.
2. **Live vector stroke ribbons (the headline "no-pixel" feel).** While the human drags
   (and for a ~250 ms fade after `pointerUp`), capture a **screen-space stroke buffer** in
   the existing pointer handlers (`onPointerDown/Move/Up:526-587`) and overlay a true vector
   path — `lineCap/lineJoin = "round"`, `imageSmoothingEnabled = true`, width =
   `brushSize × scale × k`, drawn in two passes (outer low-alpha glow + inner solid core).
   Because it is screen-space vector, it is resolution-independent and genuinely anti-aliased
   — no pixels. It overlays the field, then fades as the co-signed cells underneath take
   over. Cheap: a handful of `stroke()` calls per frame, only for the active stroke. Agents
   get the same look from a short **per-agent recent-dab trail** (last K co-signed cells,
   soft round dabs in the agent tint, fading).
3. **(Optional, perf-gated) soft-dab field finish.** To make even the static field painterly
   rather than bilinear-blocky, re-raster _dirty + visible_ tiles by stamping a small
   radial-gradient dab per cell into a modestly **supersampled (×2 → 512²) offscreen tile**,
   under an LRU cap on resident supersampled tiles. Ship only if Layer 1+2 don't read smooth
   enough; gate behind a per-frame budget.

Also: replace the square hover ghost (`:406-425` `fillRect`+`strokeRect`) with a **soft round
brush preview** (radial-gradient disc + faint ring, radius = brush footprint). Keep the agent
marker pill/pin; add a faint tint glow halo. **Cursor:** `crosshair` → a soft dot.

> **Biggest render risk:** Canvas2D `stroke()` + glow cost at high zoom / fast drag. Mitigate
> by culling off-screen trail segments, batching consecutive segments into one
> `beginPath()…stroke()`, and dropping the glow pass to every other frame above zoom ~20.
> Target 60 FPS at default zoom (scale 10); 30 FPS fallback at zoom 20+ with glow halved.

### 10.4 Agent drawing-MODE system + catalog (the Intelligence ↔ TPS dial)

**Today** `designForMode(mode, i): PixelDesign` returns a flat `DesignCell[]` in reveal order
and `tickAgent` co-signs **exactly one cell per tick** (`useWorldCanvasOnchain.ts:799-805`), so
all modes share the same TPS at a given speed. Generalize `designs.ts` into a **two-layer stroke
generator** + make density a real TPS lever:

```ts
// designs.ts — the mode becomes a registry entry, not a union member
export interface ModeContext {
  width: number;
  height: number;
  rng: () => number;
  numColors: number;
}
export interface AgentDrawMode {
  id: AgentModeId;
  label: string;
  group: "art" | "gesture" | "structure" | "fluid"; // groups the pills
  footprint: { width: number; height: number }; // sizes this mode's placement slot
  density: "sparse" | "medium" | "dense"; // TPS class → batch factor + tooltip
  /** Lazy iterator of integer cells in reveal order (finite = a flag; endless = a flow field). */
  strokes(ctx: ModeContext): Iterator<DesignCell>;
}
export const AGENT_MODES: Record<AgentModeId, AgentDrawMode> = {
  /* registry */
};
```

The **only float→integer funnel** is one shared `rasterizeStroke(points: {x,y}[], radius,
spacing): DesignCell[]` (~20 lines): walk each float polyline at sub-cell `spacing`, stamp a
round footprint of `radius` (≈πr² cells), dedupe in reveal order. Every mode calls only this,
so all modes are **smooth-by-construction and the wire stays integer**. `artist/scatter/filler`
survive by wrapping their existing arrays in an iterator. Promote `inPolygon`/`starPolygon`
(`designs.ts:42-74`) into a shared `geometry.ts` for reuse.

| Mode (group)                          | Generator                                                                                       | Visual character                              | TPS profile                         |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------- |
| **Artist** (art) _exists_             | Pre-baked flag/template cells, field-then-emblem reveal                                         | Recognizable flag/logo; exercises overpaint   | medium, finite                      |
| **Scatter** (fluid) _exists_          | Uniform random cells/colors                                                                     | Noise spray                                   | medium                              |
| **Filler** (fluid) _exists_           | BFS flood from center, 1 color                                                                  | Expanding diamond blob                        | dense                               |
| **Sweep — vẽ dài** (gesture)          | Start + heading; long arcs, `heading += small_noise`; len 200–600; slow color drift; r≈3        | Long smooth ribbon gestures                   | **high burst**, large footprint     |
| **Scribble — nguệch ngoạc** (gesture) | Momentum random-walk; bounce in a loose box; r≈1–2                                              | Energetic organic doodle                      | medium-high, continuous             |
| **Calligraphy** (art)                 | Catmull-Rom/Bézier through few control pts; **radius modulated by path speed** (nib)            | Tapered swooshes — purest "no-pixel" showcase | medium, bursty at thick joints      |
| **Geometric — cấu trúc** (structure)  | grid/lattice · Archimedean spiral · rings+starburst; thin brush, 1–2 colors                     | Clean architectural / mathematical            | grid=high, spiral=steady medium     |
| **Flow field** (fluid)                | Perlin vector field; K particles trace streamlines; color by field angle; respawn → **endless** | Silky parallel currents — the modern headline | **high, sustained** (K streamlines) |
| **Wash / Gradient** (fluid)           | Filler upgraded: row/radial fill following a palette ramp + dithered edge                       | Soft gradient color field                     | **very high** (a fill)              |
| **Stipple** (art)                     | Poisson-disc dabs, density falloff toward center                                                | Airy pointillist cloud                        | low-medium (contrast mode)          |

**Make density a real TPS dial (the key mechanism).** Change `tickAgent` to co-sign a **batch
per tick** instead of one cell: `batch = clamp(round(densityFactor(mode) × speedFactor(speed)),
1, BATCH_CAP)`; pull `batch` cells from the iterator and `coSignPaint` each (each still one
independent verified `step` → `actions++` → `totalMovesRef++`, **no double-count** — the existing
loop already books per cell). Per-agent TPS becomes `batch × 1000/interval`, so flow/wash/grid
**burst** and calligraphy/stipple **sip**. Bound it with `BATCH_CAP` (~12), the existing
`MAX_RETAINED_CELLS = 200_000` eviction, and rAF coalescing.

**Placement becomes per-mode:** size each agent's slot (and spiral spacing) from `mode.footprint`
instead of the global `MAX_DESIGN_WIDTH/HEIGHT` (`useWorldCanvasOnchain.ts:107-109, 748-761`);
endless modes (flow/scribble) carry a soft `maxCellsPerRegion` so they still relocate.

**Pills:** replace the `AgentMode` union with `AGENT_MODES`; the Intelligence row maps
`Object.values(AGENT_MODES)` (`CanvasView.tsx:161, 205-216`) — a new mode = one registry entry,
zero UI plumbing. Ten modes won't fit one row → render **grouped by `mode.group`** (short rows or
a dropdown). Keep **Speed** orthogonal (interval, unchanged). Add a per-agent **Brush/Density**
pill mirroring the human `brushSize` selector (`PaletteDock.tsx`) — the explicit TPS-burst lever
that feeds `densityFactor`.

### 10.5 TEMPLATE library (CommandOSS + Vietnam arts) + picker

New module `frontend/src/games/worldCanvas/templates/` (registry + builders), resolution-independent
vectors, colors pre-quantized to the 16-index palette:

```ts
export interface StrokeTemplate {
  id: string;
  name: string;
  category: "logo" | "vietnam" | "shape" | "text";
  aspect: { w: number; h: number }; // unit box; placement maps it to world cells
  paths: TemplatePath[]; // REVEAL ORDER (fills first, emblem strokes last)
  dedupe?: boolean; // default true; false keeps deliberate overpaint
}
export type TemplatePath =
  | {
      kind: "stroke";
      color: number;
      points: Vec2[];
      closed?: boolean;
      radius: number;
    } // smooth band
  | { kind: "fill"; color: number; rings: Vec2[][] }; // even-odd region(s)
```

**Bridge (the only new hot-path logic):** `rasterizeTemplate(tpl, scale): PixelDesign` —
`stroke` walks the polyline by arc length stamping a disc of `DAB_RADIUS` every `DAB_SPACING`;
`fill` scanlines the ring bbox with even-odd `inPolygon`; dedupe via a `Set` unless
`dedupe:false`. Output is the **existing `PixelDesign` shape**, so the agent loop, `submitPaint`,
and `coSignPaint` are untouched. `estimateMoves(tpl, scale)` shows "**≈ N paints**" before stamping
(the burst guard). A **human stamp** = enqueue all N points back-to-back via `submitHumanPaint`
(synchronous local co-sign in self-play) → an **instant TPS spike**; agents stream the points one
(or one batch) per tick.

**Seed set** (`templates/`): `vn-flag` (port `buildVietnam` `designs.ts:77-92` to vector: `fill`
rect red-5 + `fill` star ring yellow-8, `dedupe:false` to keep field→star overpaint), `vn-star`,
**`commandoss`** (CommandOSS logo as stroke paths in Sui-blue-13 / white-0 — ship a placeholder
geometric mark until the real SVG is dropped in; content task, not a code blocker), `lotus`
(parametric rotated teardrop petals pink-4 + stem green-9), `dong-ho` (one Đông Hồ line-art motif
in brown-7 strokes — highest content effort, ship one first), `heart` (closed-bezier `fill` red-5),
`star` (`starPolygon` `fill` yellow-8), `text` (`buildText(str,color)` from a tiny built-in
A–Z/0–9 stroke font — keeps text data-driven, no font file).

**Picker (data-driven, no image assets):** a single `TEMPLATES` registry feeds two surfaces —
(1) an **agent template strip** shown when Intelligence = Artist (the chosen template feeds the
agent loop), and (2) a **human Stamp dock** mirroring `PaletteDock.tsx`, each thumbnail drawn from
the template's own vectors into a small canvas (so adding a template auto-adds its thumbnail),
grouped by `category`. **Human stamp mode** in `WorldCanvas.tsx`: arming a template draws a ghost
outline following the cursor (extend the hover ghost `:406-425`); click sets `origin + scale` and
enqueues all rasterized points, **chunked across `requestAnimationFrame`** and capped behind the
visible `estimateMoves` guard. The human becomes a stamper / TPS-burster.

### 10.6 How it matches the other arena games

- **Window/state pattern:** World Canvas already follows the per-phase router shape
  (`idle/opening/open/demo/error`) of `ChickenCrossWindow`/`TicTacToeWindow`; the status chip with
  phase tint + pulse is in place (`CanvasView.tsx:144-153, 267-294`).
- **HUD tokens:** reuse the existing **frosted glass** panels (`tokens.ts:38-45`), **stat cards**
  (uppercase mono label 9.5px / bold tinted value 19px — `CanvasView.tsx:115-142`), **segmented
  pills** (`agentPill`, `tokens.ts:56-74`), **draggable panels** w/ sessionStorage, and the
  **Leaderboard + Activity** feed (`panels.tsx`). New modes/templates plug into these — no new look.
- **TPS visualization:** keep the rolling-TPS readout (`useRollingTps`, `CanvasView.tsx:91-113`);
  optionally add the arena's scrolling-bar TPS histogram (`/src/panels/TpsChart.tsx`) so brush
  bursts show as visible spikes.
- **On-chain surface:** identical to the arena's sponsored self-play path — `makeKeypairSponsored
SignExec` + `withSponsorFallback` open, per-tunnel `flushHeartbeat`, demo fallback. **No Move
  changes, no canvas object, no map, no Walrus** (this section retires those).

### 10.7 Phased build plan (over the existing `frontend/src/games/worldCanvas/` files)

> Reuse the already-built smooth-drag + per-agent-tunnel + chunk-render work. No Move/SDK edits.
> Each phase is shippable on its own; **Phase R is the mandate and unblocks the look first.**

**Phase R — Smooth render (no pixel grid).** _Files: `ui/tokens.ts`, `ui/WorldCanvas.tsx`._

1. `tokens.ts`: add a `BRUSH` token block — `radiusForSize(size,scale)`, glow inner/outer alphas,
   `trailOpacity`, `cap/join = "round"`, field-smoothing flag, fade-ms.
2. `WorldCanvas.tsx`: flip `imageSmoothingEnabled = true` on the field blit; drop
   `imageRendering:"pixelated"`; **delete the `scale>=8` grid block (`:373-391`).** (Smallest
   self-contained change — already kills the r/place look.)
3. `WorldCanvas.tsx`: add a screen-space stroke buffer in the pointer handlers + `drawSmoothStroke`
   (round caps/joins, two-pass glow) overlaid for the active stroke with a short fade; replace the
   square hover ghost with a soft round brush preview; add the per-agent recent-dab trail.
   _Gate (exit):_ 60 FPS at default zoom on a fast drag; the wall reads as soft paint, not squares;
   co-signed move count unchanged for an identical stroke (render-only change proven).

**Phase M — Agent modes + TPS-burst batching.** _Files: `designs.ts`, `useWorldCanvasOnchain.ts`,
`ui/CanvasView.tsx`._

1. `designs.ts`: add `AgentDrawMode` + `ModeContext` + `rasterizeStroke` + `geometry.ts`; implement
   the catalog generators (sweep, scribble, calligraphy, geometric, flow, wash, stipple); wrap
   artist/scatter/filler as iterators; export `AGENT_MODES` and replace the `AgentMode` union.
2. `useWorldCanvasOnchain.ts`: iterator-based `tickAgent` co-signing a **clamped batch per tick**
   (density × speed); size placement slots from `mode.footprint`; `maxCellsPerRegion` for endless
   modes.
3. `CanvasView.tsx`: render the Intelligence selector grouped by `mode.group` (rows/dropdown); add
   a per-agent Brush/Density pill. _Gate:_ dense modes visibly burst more TPS than sparse ones at
   the same Speed; no double-counted moves; placement never overlaps.

**Phase T — Template library + stamp.** _Files: new `templates/`, `ui/WorldCanvas.tsx`,
`ui/PaletteDock.tsx` (+ new `ui/StampDock.tsx`), `ui/CanvasView.tsx`._

1. `templates/`: `StrokeTemplate` types + `rasterizeTemplate` + `estimateMoves` + seeds (vn-flag,
   vn-star, commandoss placeholder, lotus, dong-ho, heart, star, text); Artist mode consumes
   `rasterizeTemplate(template, scale)`.
2. `WorldCanvas.tsx`: human stamp mode — armed-template ghost → click → rasterize → enqueue via
   `submitHumanPaint`, chunked across rAF, capped by `estimateMoves`.
3. UI: agent template strip (when Artist) + a `StampDock` mirroring `PaletteDock`, vector
   thumbnails, grouped by category. _Gate:_ one template object → appears in both surfaces with a
   free thumbnail; a stamp produces an instant, bounded TPS spike; CommandOSS + a Vietnam-arts seed
   render recognizably.

### 10.8 First 3 build steps (ordered)

1. **`ui/tokens.ts` — add the `BRUSH` render-token block** (`radiusForSize`, glow inner/outer
   alphas, `trailOpacity`, round `cap/join`, field-smoothing flag, fade-ms). Pure additive; no
   behavior change yet. _(Phase R.1)_
2. **`ui/WorldCanvas.tsx` — flip to smooth + kill the grid:** set `imageSmoothingEnabled = true` on
   the field blit, remove `imageRendering:"pixelated"`, and delete the `scale>=8` per-cell grid
   block (`:373-391`). This single change retires the pixel aesthetic with zero protocol impact.
   _(Phase R.2)_
3. **`ui/WorldCanvas.tsx` — live vector stroke ribbon + soft hover:** capture a screen-space stroke
   buffer in the existing `onPointerDown/Move/Up` handlers and overlay `drawSmoothStroke` (round
   caps/joins + two-pass glow) for the active stroke with a ~250 ms fade; replace the square hover
   ghost (`:406-425`) with a soft round radial-gradient brush preview. _(Phase R.3)_
