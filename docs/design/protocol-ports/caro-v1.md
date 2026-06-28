# caro.v1 Rust Port

## Status

Design.

## Canonical Protocol

- ID: `caro.v1`
- TS source: `frontend/src/games/ticTacToe/packages/shared/src/caro/protocol.ts`
- Rust target: `rust/protocols/caro`

## Protocol Shape

Caro is a configurable square-board five-in-a-row game. Party A moves first.
Stake is currently zero; balances stay constant.

State:

- board
- board size
- turn
- winner
- last move
- move count
- balances
- stake

Move:

- `{ cell }`

Winner codes are `0` none, `1` A, `2` B, `3` draw.

## Settlement And Unhappy Path

Current Caro is play-for-board-state with no balance movement. Generic latest
state settlement is sufficient. If a future stake is added, it should follow the
tic-tac-toe stake-shift pattern.

## Tests

- board size validation.
- A moves first and turns alternate.
- occupied and out-of-range cells are rejected.
- five-in-a-row detection matches TS `winnerAround`.
- draw on full board.
- `encode_state` matches TS goldens.
