# bomb_it.v1 Rust Port

## Status

Design.

## Canonical Protocol

- ID: `bomb_it.v1`
- TS source: `sui-tunnel-ts/src/protocol/bombIt.ts`
- Rust target: `rust/protocols/bomb-it`

## Protocol Shape

Bomb It is a deterministic Bomberman-style duel. Every move advances one tick;
the acting seat can move, drop a bomb, or stay.

State:

- tick
- deterministic seed
- grid
- two players
- live bombs
- winner (`A`, `B`, `draw`, or none)
- balances

Move:

- optional action for A
- optional action for B

Actions are `north`, `south`, `east`, `west`, `bomb`, and `stay`.

## Randomness Contract

The board is public and 180-degree symmetric. It derives from tunnel ID using
the TS `FNV-1a` seed and `mulberry32` crate placement. The Rust port must match
grid generation, spawn-safe cells, fuse countdown, blast propagation, crate
destruction, chain reactions, and winner rules.

## Settlement And Unhappy Path

The single-game protocol shifts the pot on a kill; draw leaves balances
unchanged. Generic latest-state dispute is sufficient for co-signed outcomes.

If a peer disappears before signing the next tick, no future explosion or kill is
enforceable. Settlement falls back to the latest co-signed state and timeout
penalty.

## Tests

- grid generation matches TS fixtures.
- blast cells and crate blocking match TS.
- chain reactions match TS.
- movement rejects blocked cells and bombs.
- kill/draw/cap outcomes match TS.
- `encode_state` matches TS goldens.
- balances conserve on every tick.
