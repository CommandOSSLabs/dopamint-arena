# caro.series.v1 Rust Port

## Status

Design. Canonical rename of `caro.multi.v1`.

## Canonical Protocol

- ID: `caro.series.v1`
- Legacy ID: `caro.multi.v1`
- TS source: `frontend/src/games/ticTacToe/packages/shared/src/caro/protocol.ts`
- Rust target: `rust/protocols/caro`, module `series_v1`

## Wrapper Shape

Composes `caro.v1`. The wrapper tracks `gamesPlayed` and `maxGames`. Stake is
currently zero, so balances remain constant across the series.

Between games, A may advance the session and reset the board.

## Settlement And Unhappy Path

Terminal when the current inner game is over and `maxGames` is reached. Generic
latest-state settlement is sufficient because state is public and balances do
not move.

## Tests

- wrapper domain differs from `caro.v1`.
- reset carries balances and board size.
- terminal at `maxGames`.
- `encode_state` matches TS goldens.
