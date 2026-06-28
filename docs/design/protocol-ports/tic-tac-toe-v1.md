# tic_tac_toe.v1 Rust Port

## Status

Design.

## Canonical Protocol

- ID: `tic_tac_toe.v1`
- TS source: `sui-tunnel-ts/src/protocol/ticTacToe.ts`
- Rust target: `rust/protocols/tic-tac-toe`

## Protocol Shape

Classic 3x3 tic-tac-toe. Party A places mark `1`, party B places mark `2`, and
A moves first.

State:

- 9-cell board
- turn
- move count
- winner code
- balances
- per-game stake

Move:

- `{ cell }`

Winner codes are `0` none, `1` A, `2` B, `3` draw.

## Settlement And Unhappy Path

On a decisive win, the loser pays `stake` to the winner, clamped to the loser
balance. A draw leaves balances unchanged.

Tic-tac-toe is fully public and deterministic. The generic tunnel dispute path
is enough to enforce the latest co-signed result; no game-specific referee is
needed for the current model.

## Tests

- A moves first and turns alternate.
- occupied and out-of-range cells are rejected.
- all eight win lines match TS.
- draw at full board.
- decisive win shifts stake and conserves total.
- `encode_state` matches TS goldens.
- random move picks only empty cells.
