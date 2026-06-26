# 0018 — Multi-game self-play + per-game seed for bomb-it & chicken-cross

- **Status**: Accepted
- **Date**: 2026-06-23

## Context

Battleship and tic-tac-toe host MANY games inside ONE funded tunnel and settle
once (multi-game wrappers composing the single-game protocol). bomb-it and
chicken-cross funded a fresh tunnel per game. Bringing them to that tier needs a
multi-game wrapper too — but unlike battleship (whose per-game randomness is a
fresh fleet commit), their boards are seeded by `seedFromTunnelId(tunnelId)`,
which is FIXED per tunnel. A naive reset would replay the identical board/race
every game.

## Decision

Add `MultiGameBombItProtocol` / `MultiGameCrossProtocol` mirroring
`MultiGameBattleshipProtocol`. On a between-games reset the wrapper re-seeds the
inner game from a SYNTHETIC per-game id `` `${tunnelId}:g${gamesPlayed}` ``.
`gamesPlayed` is part of the co-signed multi-game state and of `encodeState`, so
both parties and an on-chain disputer derive the same per-game seed.

This stays inside ADR 0017: the field is still public, symmetric, and
party-independent, seeded from an un-grindable id — no commit-reveal is added.

## Consequences

- Solo bomb-it/cross fund once and play an unbounded series of distinct games,
  settling on demand (or at stake exhaustion), matching battleship/ttt.
- Each game's board/hazard-field differs (per-game seed), so a rematch is a new
  challenge, not a replay.
- Single-game PvP is unchanged (still seeds from the plain `tunnelId`).
- The wrappers live in `sui-tunnel-ts/src/protocol/`, beside the base protocols
  and ttt's multi-game wrapper, per `docs/guide/adding-a-tunnel-game.md`.
