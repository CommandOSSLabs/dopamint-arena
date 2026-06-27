# world_canvas.cell.v1 Rust Port

## Status

Design. Canonical rename of `world_canvas.v1`.

## Canonical Protocol

- ID: `world_canvas.cell.v1`
- Legacy ID: `world_canvas.v1`
- TS source: `sui-tunnel-ts/src/protocol/worldCanvas.ts`
- Rust target: `rust/protocols/world-canvas`, module `cell`

## Protocol Shape

Cell canvas is an append-only paint stream. Each move paints exactly one cell.
The signed state stores a rolling digest, not the full canvas.

State:

- rolling digest
- paint count
- last painter
- balances

Move:

- signed 64-bit chunk coordinates `cx`, `cy`
- in-chunk coordinates `x`, `y`
- palette index `color`

## Encoding Contract

Each paint delta encodes the painter byte, zigzag-encoded chunk coordinates,
cell coordinates, and color. The next digest is
`blake2b256(previous_digest || encoded_move)`.

`encode_state` is fixed-size: domain, digest, count, and balances.

## Settlement And Unhappy Path

Balances never move. The protocol is collaborative and effectively continuous,
with terminality only at a very large cap. Generic tunnel settlement is
sufficient because there is no winner and no hidden state.

## Tests

- zigzag encoding matches TS fixtures for positive and negative chunks.
- move encoding matches TS fixtures.
- rolling digest changes on every paint.
- bounds checks match TS.
- `encode_state` matches TS goldens.
