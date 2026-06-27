# tic_tac_toe.series.v1 Rust Port

## Status

Design. Canonical rename of `tic_tac_toe.multi.v1`.

## Canonical Protocol

- ID: `tic_tac_toe.series.v1`
- Legacy ID: `tic_tac_toe.multi.v1`
- TS source: `frontend/src/games/ticTacToe/packages/shared/src/ttt/multiGameProtocol.ts`
- Rust target: `rust/protocols/tic-tac-toe`, module `series_v1`

## Wrapper Shape

Composes `tic_tac_toe.v1`. The inner protocol carries balances; the wrapper
tracks `gamesPlayed` and `maxGames`.

Between games, a move acts as an advance trigger and resets the inner board with
carried balances. The TS wrapper lets A drive the advance with `{ cell: 0 }`.

## Settlement And Unhappy Path

Terminal when the current inner game is over and either `maxGames` is reached or
the next game's stake cannot be funded. Generic latest-state settlement is
sufficient because tic-tac-toe is public and deterministic.

## Tests

- wrapper domain differs from `tic_tac_toe.v1`.
- inner game resolves and carries balances.
- reset increments `gamesPlayed`.
- terminal at `maxGames`.
- `encode_state` matches TS goldens.
