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
