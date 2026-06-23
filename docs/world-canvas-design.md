# The World is Your Canvas — collaborative pixel wall on the Sui Tunnel arena

> **Status:** Research / design foundation (pre-ADR). Read-only study; no code changed.
> **Author:** design spike. **Date:** 2026-06-23.
> **Scope:** A *new, separate* arena game — an **infinite**, N-painter collaborative pixel canvas,
> driven by an "Agent AI" button that spawns bots painting forever alongside humans, optionally
> layered on an OpenStreetMap basemap. Does **not** touch pixel-duel (the 2-party fog-of-war duel),
> which stays as-is.

---

## 1. Concept and where it sits

**Wplace** (https://wplace.live) is a single, global, real-time **collaborative** pixel canvas
painted over the world map: anyone places a pixel, a per-pixel/per-painter **cooldown** rate-limits
them, and the art accretes globally and permanently. There is no winner — the wall *is* the artifact.

**The World is Your Canvas** is that, on the Sui tunnel arena, with one north-star reframing: **1 painted
pixel = 1 co-signed off-chain tunnel update = 1 TPS.** The whole point of the game is to turn a crowd of
painters — human *and* agent — into a fleet of high-frequency tunnels and show the throughput live on the
arena dashboard. The canvas is **infinite / unbounded**: it grows in every direction, stored sparsely
(only painted cells), so play never hits a wall.

### The core interaction: the "Agent AI" button

The product is built around one button. The canvas is shared and infinite; two kinds of painters fill it:

- **Human** — click a cell to place a pixel. Each placement co-signs one tunnel update with the hub.
- **"Agent AI" button** — **each click spawns one AI agent** that holds its own ephemeral key, opens its
  own 2-party tunnel to the Canvas Hub, and paints **random art continuously, forever** (autonomous
  strokes, no human in the loop). **Multiple clicks = multiple agents** painting in parallel on the same
  shared canvas. The agents never stop until explicitly closed → an endless stream of co-signed pixels →
  **endless TPS**.

Humans and agents paint the *same* canvas at the same time; every paint from either side is one co-signed
tunnel tx. The TPS dial is literally driven by how many Agent-AI bots are live and how fast they stroke —
spawn more agents, the number climbs. This is the demo: a human paints a few deliberate pixels while a
fleet of clicked-into-existence agents floods the wall around them, and the dashboard shows the throughput.

**Relation to pixel-duel / the deferred Paint Wall.** pixel-duel (on `feat/pixel-duel`) is a strict
**2-party** game: two players, fog-of-war, deterministic turns, settle to a winner. Its ADR explicitly
**deferred** the "Paint Wall" — an N-painter shared canvas — noting it is only reachable *"by composing
2-party tunnels."* The World is Your Canvas is that deferred game, built as a **separate** game package. It
shares patterns and infra with pixel-duel but **none of its rules**: no fog, no turns, no winner, unlimited
painters, transparent global state.

The hard constraint that makes this a design problem (not a copy-paste) is in
[`sui_tunnel/sources/tunnel.move`](../sui_tunnel/sources/tunnel.move): a tunnel has exactly
`party_a` and `party_b`, and `close_cooperative_with_root<T>` (L1065) settles on exactly **two**
signatures `sig_a`, `sig_b`. **There is no N-party tunnel.** Everything below is about getting an
N-painter wall out of a 2-party primitive *without forking the Move contract*.

---

## 2. The core problem: N painters on a 2-party tunnel

A tunnel is two parties co-signing a shared state. A wall is N painters (humans + agents) sharing one
canvas. The two do not line up. Four ways to bridge them:

| # | Architecture | Move change | Per-pixel TPS | Settlement | Verdict |
|---|---|---|---|---|---|
| **A** | **Hub-and-spoke** — each painter holds a 2-party tunnel with a Canvas Hub agent | **none** | 1 / pixel | per-painter cooperative close | **RECOMMENDED** |
| B | Region-sharded — one 2-party tunnel per map tile, painters pair into it | none | ~1/N (idle seats) | tile-consensus (not 2-party) | no — reintroduces N-party at the tile |
| C | Relay-broadcast — relay fans every move to all painters; all co-sign one wall | **yes** (N-sig close) | N on one tx (bad) | N signatures on-chain | no — needs the forked contract this game exists to avoid |
| D | Compose-per-pixel — a fresh transient tunnel per pixel, then aggregate | none | open/close churn | one settle *per pixel* | no — open/fund/close overhead per pixel kills it |

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
  painter's tunnel state is *that painter's own stroke list* (proves "painter X co-signed these pixel-
  ops" — provenance + TPS). The **global** canvas is the hub's aggregate across all tunnels; the hub
  is the ordering authority that merges concurrent writes (per-pixel **last-write-wins by timestamp**,
  cooldown enforced in `applyMove`). No tunnel ever needs to know about another painter.
- **Settlement is the standard cooperative close**, once per painter session, not per pixel: each
  painter and the hub sign `close_cooperative_with_root` (free mode → balances unchanged → a genuine
  draw every time, no dispute surface). The hub snapshots the merged wall root to Walrus.

**Honest caveat on the TPS claim.** A painter↔hub tunnel is a *genuine* two-party tunnel **only if the
hub is a real separate party** (its own key, its own process) and frames cross the real relay and are
co-signed there — which is the design here. If the hub instead co-located and both-signed locally, the
number degrades to **self-play TPS** (still a legitimate bot/stats showcase, but it is self-play, and
should be labelled as such on the dashboard). Phase 0 (Agent-AI bots) is explicitly self-play-flavoured;
Phase 1 (humans as party A vs the hub) is genuine two-party. Keep this distinction visible — don't quietly
claim genuine-tunnel TPS for a self-signing hub.

Rejected alternatives in one line each: **B** drags N-party consensus back to the tile level; **C**
needs the N-signature contract fork this game was created to avoid; **D** pays open/fund/close per
pixel. All three lose to A on either Move-change cost or per-pixel overhead.

---

## 3. Map, Coordinates & Rendering

**LIGHTWEIGHT is the #1 constraint.** A real-time pixel canvas must stay performant and trivial to run.
The decision that follows from that: **the map is not in the critical path** — the canvas is a self-
contained infinite chunked grid that runs with **zero** map dependency (Phase 0), and a basemap is layered
*under* it only when geographic anchoring is actually wanted (Phase 1). Pick the lightest thing that proves
the behaviour at each phase.

### 3.1 Map library — lightest-first, Mapbox rejected

| Library | Bundle (gz) | Token / cost | Rendering | Verdict |
|---|---|---|---|---|
| **Canvas-only** (no map) | **0 KB** | free | native Canvas2D | **Phase 0** — lightest possible; infinite grid, no basemap |
| **MapLibre GL** | ~160 KB | free, no token | WebGL vector | **Phase 1 default** — OSS Mapbox fork, drop-in, OSM basemap |
| **Leaflet** | ~40 KB | free, no token | Canvas2D raster tiles | Phase 1 light-budget alt (raster, less crisp) |
| **Mapbox GL JS** | ~180 KB | **token + usage pricing** | WebGL vector | **NO** — auth friction, pricing-at-scale risk, bundle bloat for a pixel overlay |
| deck.gl | 200+ KB | free | WebGL data-viz | NO — over-engineered for a pixel grid |

**Verdicts:**

- **Phase 0 → canvas-only.** No basemap, 0 KB added, maximum pixel-render perf (direct draw, no layer
  translation), full control over the infinite pan/zoom + chunk math. This is the lightweight MVP.
- **Phase 1 → MapLibre GL** when the OSM basemap and geo-anchoring land. Identical WebGL performance to
  Mapbox, **no token, no pricing, no auth** — and if we ever *did* want Mapbox, migration is a one-line
  import swap. The pixel grid sits on top as a custom layer or a viewport-synced canvas overlay.
- **Leaflet** is the fallback only if 160 KB is judged too heavy: ~4× lighter, but raster tiles (less
  crisp at zoom extremes) and Canvas2D rather than WebGL. Fine for cooldown-gated UX; choose only if
  load-time telemetry demands it.
- **Do NOT use Mapbox GL JS** — it is the heaviest *and* the only one with token + usage-pricing friction.
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
function latLonToWorldPixel(lat: number, lon: number, z: number): { x: number; y: number } {
  const n = 256 * 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * n;
  return { x, y };
}

// world-pixel → lat/long (inverse, for "what did I just click")
function worldPixelToLatLon(x: number, y: number, z: number): { lat: number; lon: number } {
  const n = 256 * 2 ** z;
  const lon = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * (y / n)))) * 180) / Math.PI;
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
  *all* visible chunk canvases are blitted to the screen canvas in a single composite. Redraw cost is
  bound by *new pixels this frame*, not by total wall size — network-RTT bound, not CPU bound.
- **rAF batching.** A single render loop per viewport (mounted once, torn down on unmount); inbound deltas
  are queued and applied once per frame, never per-message — so a flood of agent pixels still costs one
  composite per frame.

```typescript
// one render tick: redraw only dirty chunks, then blit visible ones
function renderFrame(screen: CanvasRenderingContext2D, cam: Camera, vis: ChunkRange) {
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
The throughput model is fleet-of-tunnels, not loops-on-one-tunnel — and the "Agent AI" button *is* the
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
  - *Self-play (Phase 0 Agent-AI bots):* the client sends throttled **action deltas** via `flushHeartbeat` —
    one action per verified `tunnel.step()`, never per render/retry; force-flush the tail on settle.
  - *PvP / human-vs-hub (Phase 1):* the **relay counts server-side** as it ingests co-signed frames,
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
  it scales with *tunnel count × settle frequency*, not pixels. Free mode = balances never shift =
  every close is a draw = zero dispute surface. The only finite resource under load is the **settler's
  SUI for gas** — monitor/refill it (the deferred rate-limit/budget from ADR-0010 applies here too).

---

## 5. Phased MVP (each phase shippable on its own)

**Lightweight-first ordering.** Phase 0 ships the *lightest thing that proves the loop*: a canvas-only
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
   If we ever want the *wall itself* trustlessly settled, that needs the contract fork (architecture C)
   and a fresh ADR.
3. **Hub trust / censorship.** The hub orders cross-painter writes and can in principle drop or reorder
   them. Mitigation: each painter's tunnel transcript root proves *their* co-signed strokes (dispute
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

| Layer | Reused as-is | New / adapted |
|---|---|---|
| **Move contract** | `tunnel` (`create`/`deposit`/`close_cooperative_with_root`), generic over coin `T` | none |
| **Stake / gas** | ADR-0009 sponsor (gas-only), ADR-0010 DOPAMINT faucet + invisible auto-faucet | none |
| **Relay** | opaque `match_id`/`game` frame forwarder (`mp/ws.rs`), `quickMatch`, `Connect`/`Resume` | none |
| **Protocol SDK** | `Protocol<State,Move>` interface, `rollingDigest`, `chat.ts` as the template | `worldCanvas.ts` |
| **TPS / dashboard** | `stats.rs` 5 s `RateWindow` derivative, `per_game` bucket, SSE log-scale chart | a `"world-canvas"` id |
| **Heartbeat** | `flushHeartbeat` self-play contract; relay-side counting for human-vs-hub | obey the split (§4) |
| **Agent fleet** | `?agent&m=N` runner, `AGENT_GAMES` rotation, `GameSpec` | one `GameSpec` entry + "Agent AI" button |
| **Frontend game shape** | blackjack self-play package layout; `useBlackjackSession` / `session-core` patterns; `onchain/tunnelTx.ts` `openAndFundSelfPlay` | `worldCanvas/` package |
| **Render** | pixel-duel `PixelCanvas` core (rAF, zoom/pan, snap, cull, ghost) | strip fog/turns; infinite 256×256 chunked grid; Phase 1 OSM Mercator under MapLibre |
| **Resilience** | ADR-0010 MP resume (rebind + peer-reconcile) for dropped painters | none |

---

### Bottom line
Build **hub-and-spoke**: N genuine 2-party painter↔hub tunnels — one per human, one per **Agent-AI** click
— with the global infinite wall as the hub's merged artifact anchored to Walrus, **zero** Move/relay
changes. Stay **lightweight-first**: Phase 0 is a canvas-only (0 KB map) infinite 256×256-chunked wall
painted by Agent-AI bots with live TPS, on the existing self-play + heartbeat + stats path. Phase 1 layers
an **OSM basemap via MapLibre** (free, no token — **never Mapbox**), Web-Mercator geo-locked coordinates,
cooldown, and human-vs-hub tunnels; Phase 2 shards for scale. Model the protocol on `chat.ts` (append-only
+ `rollingDigest`, free-mode draw). The one thing to keep honest throughout: only call it genuine-tunnel
TPS when the hub is a real co-signing party over the relay.

## 8. Build references

- **[hmldns/pix-canvas](https://github.com/hmldns/pix-canvas)** — reference for the pixel-canvas **drawing**: the infinite chunked canvas, pan/zoom camera, pixel placement, and chunk load/evict loop. Mine its rendering pipeline for the §3.3 chunk system.
- **[nianez/game-ui](https://github.com/nianez/game-ui)** — reference for the arena **game UI** (the earlier 2D version, **not** the latest 3D). Mine its component look + layout for the World Canvas window.

> Study these when starting Phase 0 (canvas-only infinite chunked wall + the Agent-AI button); adapt, don't copy wholesale.
