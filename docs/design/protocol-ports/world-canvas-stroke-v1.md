# world_canvas.stroke.v1 Rust Port

## Status

Design. Canonical rename of `world-canvas-pvp`.

## Canonical Protocol

- ID: `world_canvas.stroke.v1`
- Legacy ID: `world-canvas-pvp`
- TS source: `sui-tunnel-ts/src/protocol/worldCanvasPvp.ts`
- Rust target: `rust/protocols/world-canvas`, module `stroke`

## Protocol Shape

Stroke canvas is a batched paint protocol. One co-signed move carries a run of
cells, making drag strokes efficient over a tunnel. Participant type is not part
of the protocol: humans and bots are both players.

State:

- canonical digest
- render-only capped cells
- paint count
- highest applied per-seat sequence for A and B
- balances

Move:

- list of cells up to `MAX_BATCH_CELLS`
- each cell has chunk coordinates, in-chunk coordinates, color, and per-seat
  sequence number

## Idempotency Contract

A cell folds into the digest only if its per-seat `seq` is greater than that
seat's applied sequence cursor. Resent or stale cells are skipped
deterministically on both sides.

The render cell list is not part of `encode_state`; only the digest is signed.
The sequence cursors are parity-critical state and must be restored on resume.

## Settlement And Unhappy Path

Balances never move and the protocol is non-terminal. Generic tunnel settlement
is sufficient. Stale or replayed batches are absorbed by the sequence gate.

## Tests

- batch limit and cell validation match TS.
- per-seat stale seq cells are skipped.
- fresh cells fold in array order.
- digest matches TS fixtures.
- render cap does not affect `encode_state`.
- balances remain constant.
