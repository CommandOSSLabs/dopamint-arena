# battleship.series.v1 Rust Port

## Status

Design. Canonical rename of `battleship.multi.v1`.

## Canonical Protocol

- ID: `battleship.series.v1`
- Legacy ID: `battleship.multi.v1`
- TS source: `frontend/src/games/battleship/protocol/multiGameBattleship.ts`
- Rust target: `rust/protocols/battleship`, module `series_v1`

## Wrapper Shape

Composes `battleship.v1`. The inner protocol carries balances and stake. The
wrapper tracks `gamesPlayed`.

When an inner game is over and both sides can fund another stake, the next
`commit` starts a fresh inner game with carried balances. Non-commit moves are
rejected by the fresh inner protocol.

## Settlement And Unhappy Path

Terminal only between games when a side cannot fund the next stake. During a
game, settlement is player-driven from the latest checkpoint.

If a player disappears while owing a battleship reveal, the series wrapper does
not add new adjudication. The generic tunnel settles the latest co-signed
checkpoint plus timeout penalty.

## Tests

- wrapper domain differs from `battleship.v1`.
- completed game carries balances.
- next commit starts a new game.
- non-commit advance fails.
- terminal at stake exhaustion.
- `encode_state` matches TS goldens.
