# Collaborative Pixel Paint — design

**Date:** 2026-06-22 · **Status:** proposed · **Scope:** game protocol + frontend + gallery; **no** tunnel/core change

## Problem

We want a painting game on Dopamint where people draw a pixel canvas together,
and finished canvases become a browsable gallery (Mobbin/Godly-style grid). The
prompt that triggered this spec asked the load-bearing question directly: *can a
tunnel host everyone painting together, or only two?* — and whether a turn-based
paint game fits the tunnel/contract model the existing games use.

This spec answers that question, then specifies the game that *does* fit: a
turn-based two-painter **Pixel Duel** on the existing two-party tunnel, plus the
**gallery** of settled canvases. The N-painter "Paint Wall" is sketched as a
deferred composition tier, not built here.

## The tunnel reality (why this shapes the game)

A single tunnel is **strictly two-party** — verified end to end (see [[0010]] for
the full citations):

- On-chain `Tunnel<T>` = `party_a` / `party_b`, `party_a_balance` /
  `party_b_balance`; updates are 2-of-2 co-signatures; close splits the pot to two
  addresses (`sui_tunnel/sources/tunnel.move`).
- Off-chain `Party = "A" | "B"`, `balances {a, b}`, one opponent, one per-tunnel
  nonce (`sui-tunnel-ts/src/protocol/Protocol.ts`, `frontend/src/pvp/mpClient.ts`).
- It is a deliberate commitment ([[0006]]): genuine two-party co-signing is what
  makes a tunnel falsifiable. The framework reaches N parties only by *composing*
  2-party tunnels (`example_multi_party_channel.move`), never by one N-party
  channel.

**Turn-based fits natively.** The tunnel itself has no turn concept — it enforces
a monotonic nonce and 2-of-2 co-sign, nothing more. Whose turn it is lives in the
game `Protocol.applyMove` (tic-tac-toe does exactly this:
`example_tic_tac_toe.move` counts moves; `protocol/ticTacToe.ts` carries
`turn: Party`). So a turn-based paint protocol drops straight onto the canonical
`Protocol<State, Move>` interface with no framework work.

**Consequence:** the base game is two painters. "Everyone together" is a later
composition tier, not a single tunnel.

## Game: Pixel Duel (two-painter, live shared canvas)

UX target is **wplace.live / r/place**: a shared pixel wall where you pick a color
and place pixels **freely (no turns), gated by a cooldown / charges**, and the
other painter's pixels appear live. Overwriting is allowed (shared-wall feel).
Two painters share one fixed-size canvas; each placement is a co-signed tunnel
move. It is *cooperative* — the reward is the co-created artifact and its on-chain
provenance — with an optional competitive "judged" variant later.

**No turns.** Either party may place at any time (the chat protocol already shows
"either party acts"), so `applyMove` enforces bounds + palette, not whose-turn.
The **cooldown/charges** that pace wplace are a **client-side** concern in v1
(they shape the UX); rate-limiting can move into the protocol later via timestamped
moves. The session is terminal at a fixed **placement cap** — a deterministic
settle point that needs no wall-clock.

### Canvas & palette

- **Grid:** 32×32 cells (1024). Small enough that `encodeState` stays compact and
  deterministic; large enough to make real art. (16×16 "mini" and 64×64 "large"
  are config variants behind one constant.)
- **Palette:** fixed 16-color indexed palette (Sui/Dopamint themed). A cell is one
  `u8` palette index; `0` = empty/transparent.
- **Determinism:** the canvas is `Uint8Array(W*H)`; no floats, no randomness.

### Protocol shape (`Protocol<PaintState, PaintMove>`)

Implements the same interface every game uses
(`sui-tunnel-ts/src/protocol/Protocol.ts:45-77`):

As built in `sui-tunnel-ts/src/protocol/pixelPaint.ts` (domain
`pixel_paint.duo.v1`):

```
type Party = "A" | "B"            // unchanged framework type

interface PixelPaintState {
  width: number; height: number
  canvas: Uint8Array              // W*H palette indices (0 = empty, 1..16 color)
  placed: number                  // total placements; terminal at `cap`
  placedA: number; placedB: number
  cap: number
  balanceA: bigint; balanceB: bigint; total: bigint
}

interface PixelPaintMove {        // place one pixel (no turn field)
  x: number; y: number; color: number   // color ∈ [1..16]
}
```

- **`initialState(ctx)`** — empty canvas (W·H), `balances` = stakes from `ctx`.
- **`applyMove(state, move, by)`** — assert not-terminal, in-bounds, valid
  `color`; paint the cell (overwrite allowed), increment `placed`/`placed{A,B}`.
  **No turn check.** Pure; throws on any violation.
- **`encodeState(state)`** — domain tag ++ `W` ++ `H` ++ `canvas bytes` ++
  counters ++ balances. Deterministic, same-state → same-bytes. Co-signed every
  move and anchored at close.
- **`balances(state)`** — `{ a, b }`, constant in cooperative mode (both stakes
  returned at close); a judged variant would shift on a verdict.
- **`isTerminal(state)`** — `placed >= cap` (deterministic, clock-free).
- **`randomMove(state, _by, rng)`** — random cell + random color, for the bot/
  self-play harness; null at the cap.

### Why this is *simpler* than the existing games

No shared randomness and no hidden information in the base mode — both painters
see the whole canvas — so **no commit-reveal is needed** (battleship/poker need it;
paint does not). Fairness rests entirely on the 2-of-2 co-signature + nonce
ordering already provided by `DistributedTunnel`. Each pixel is a co-signed move
neither side can forge; the final artifact is tamper-evident by construction.

*Optional twist (later):* a "blind round" where both commit a batch of pixels and
reveal simultaneously — reuses the existing commit-reveal pattern
(`computeCommitment` + salt) for a fun simultaneous-reveal mechanic.

### Settlement & provenance

On cooperative close, `close_cooperative` anchors the final co-signed state hash
(which includes the full canvas via `encodeState`) and refunds both stakes
(cooperative: 50/50). The settlement projection (per [[0005]]) records the final
canvas hash + both party addresses → the canvas is **reconstructable from the
co-signed final state** and attributed to both painters. That settled record is
the gallery's data source — no separate trusted store of "who painted what."

## Gallery (finished canvases) — DEFERRED

The live wall is the product, **not** a gallery (per the wplace direction). A
"saved walls" view is a *later, optional* add-on, not part of v1. The rest of this
section is kept only as a sketch for if/when we want it.

Inspiration: **Image #4** (Mobbin/Godly-style showcase) — a justified card grid on
an airy field, each card a creator pill + ↗ open + optional badges, with a
"N online · updated Nm ago · Recent ▾" strip and a category rail.

For us each card is a **settled canvas**:

- **Thumbnail** — the pixel art rendered from the settled final state.
- **Co-authors** — both painters' wallet avatars/addresses (or ENS/SuiNS).
- **Provenance** — ↗ to the settlement tx / tunnel on an explorer (the proof).
- **Meta** — round count, palette, timestamp; optional likes.
- **Filters** — Recent / Top, by palette or size.

Data: the backend settlement projection already exists ([[0005]], [[0007]]); the
gallery is a read view over settled paint tunnels, no new trust surface.

## Paint tool UI

Inspiration: **Image #5 (Dither)** — a three-column dark editor with a mint accent:
left tools/palette, center canvas with a draggable compare/grid, right
export/presets and **pixel effects** (Dither, Bayer, Halftone, Dots) for a retro
aesthetic. We adopt the chrome and the pixel-effect vocabulary for export
(render the final canvas through an optional dither/Bayer filter for the gallery
thumbnail), in Dopamint's dark theme + Sui accent.

In-game (live, two painters):

- **Left:** 16-swatch palette, current-color, your remaining-pixel budget, turn
  indicator ("Your turn" / "Opponent painting…").
- **Center:** the W×H grid; click an empty cell with the active color to propose
  a pixel; the move co-signs over the tunnel and appears once confirmed.
- **Bottom/right:** stake/round HUD, settle-at-close, and on finish a
  "Publish to Gallery" affirmation.

## Deferred: Paint Wall (N painters via composition)

For the "everyone paints" social wall, **do not** fork the tunnel. Compose, per
`example_multi_party_channel.move`:

- A **Wall sequencer** (service with its own wallet) holds the global canvas.
- Each painter opens a **2-party tunnel with the sequencer**; strokes are
  co-signed 2-party (per-contribution attributable + tamper-evident).
- The sequencer assigns **global order** and broadcasts applied regions; on close
  it publishes the combined wall + a contributor manifest to the gallery.
- **Tradeoff (accepted in [[0010]]):** global ordering trusts the sequencer (a
  Lightning-hub coordination point), unlike pure 2-party state. Per-painter proofs
  remain. This is the honest way to do N-way paint on today's framework.

Out of scope here; specified only so the base design doesn't paint us into a
corner.

## Scope & phasing

- **P0 — Pixel Duel offline:** protocol + bot kit + local two-bot harness
  (`driveToTerminal`), and a frontend window with a wplace-style canvas (vs-bot /
  hot-seat), palette, and client-side cooldown/charges. No relay. *(protocol +
  tests ✅ done.)*
- **P1 — Pixel Duel PvP:** wire to `DistributedTunnel` + relay via a
  `usePvpPaint` hook (clone of `usePvpTicTacToe`), live shared canvas, settle on
  close.
- **P2 (deferred) — Paint Wall (N painters):** composition tier (wall sequencer),
  separate spec/ADR per [[0010]].
- **Later/optional — saved-walls gallery.**

## Open questions

- Cooperative-only, or a judged/voted competitive variant for a pot? (Start
  cooperative; judged needs a verdict source — out of scope for P0–P2.)
- Pixel budget vs. wall-clock rounds vs. a timer per turn — tune in P0.
- Canvas size default (32×32 proposed) and palette contents.
