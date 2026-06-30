# 0022 — Canonical protocol ID naming

- **Status**: Proposed
- **Date**: 2026-06-27
- **Refs**: refines [0017](0017-deterministic-seed-vs-commit-reveal.md), [0018](0018-multi-game-self-play-per-game-seed.md), [0020](../../backend/docs/decisions/0020-bot-fleet-topology-shared-core.md)

## Context

Protocol IDs cross the TS SDK, Rust ports, bots, benchmarks, frontend game
registry, matchmaking, persistence, state-hash domains, and future referee or
settlement adapters. We have accumulated mixed styles:

- snake_case segments: `api_credits.v1`, `quantum_poker.v2`
- kebab-case names: `world-canvas-pvp`
- generic wrappers: `*.multi.v1`
- game-mode variants: `blackjack.bet.v1`

Without a canonical naming rule, a port can preserve byte parity but still drift
at the protocol boundary because different layers pick different identifiers.

## Decision

Canonical protocol IDs use `snake_case` within each semantic segment, `.` between
segments, and an explicit `.vN` version suffix:

```text
<snake_case_family>.vN
<snake_case_family>.<snake_case_variant>.vN
<snake_case_family>.series.vN
```

Examples:

- `blackjack.v2`
- `blackjack.bet.v1`
- `tic_tac_toe.v1`
- `tic_tac_toe.series.v1`
- `world_canvas.cell.v1`
- `world_canvas.stroke.v1`

The segment before `.vN` names the protocol shape, not the UI route or asset
name. Kebab-case remains acceptable for URLs, package folders, CSS classes, and
human-facing game IDs, but not for canonical protocol IDs.

Use `.series` for repeated rounds over one tunnel. Do not introduce new `.multi`
protocol IDs; existing `*.multi.v1` IDs are legacy aliases.

Protocol domains that are already hashed into state are immutable for those
versions. Renaming a domain-bearing protocol ID creates a new canonical version
unless all persisted, wire, and settlement users migrate together.

## Consequences

- `docs/design/protocol-ports/README.md` is the canonical port inventory and
  records legacy aliases.
- New TS and Rust protocols must choose a canonical ID before implementation.
- Legacy aliases may be accepted at registry edges, but the Rust port should
  expose and test the canonical ID.
- `world_canvas.v1` is the legacy alias for `world_canvas.cell.v1`.
- `world-canvas-pvp` is the legacy alias for `world_canvas.stroke.v1`.
- `*.multi.v1` is the legacy alias shape for `*.series.v1`.
