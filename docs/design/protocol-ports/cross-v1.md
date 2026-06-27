# cross.v1 Rust Port

## Status

Design.

## Canonical Protocol

- ID: `cross.v1`
- TS source: `sui-tunnel-ts/src/protocol/cross.ts`
- Rust target: `rust/protocols/cross`

## Protocol Shape

Chicken Cross is a discrete two-party lane race. Each tunnel move advances one
world tick with optional directions for A and B. Hazards are deterministic from
the tunnel-derived seed, lane, and tick.

State:

- tick
- deterministic seed
- two player positions, scores, and respawn immunity counters
- winner
- balances

Move:

- optional `dirA`
- optional `dirB`

Directions are `north`, `south`, `east`, `west`.

## Randomness Contract

The hazard field is public and party-independent, so it uses deterministic seed
from tunnel ID rather than commit-reveal. The Rust port must match TS `FNV-1a`,
`mulberry32`, lane kind, hazard span, water inversion, and collision rules.

## Settlement And Unhappy Path

The single-game protocol is winner-takes-all at a decisive finish. Because the
state is public and every collision is replayable, generic latest-state dispute
is sufficient for already co-signed outcomes.

If a peer disappears before signing the next tick, the chain cannot infer who
would have won on a future tick. Settlement falls back to the latest co-signed
state and timeout penalty.

## Tests

- seed from tunnel ID matches TS fixtures.
- lane kinds and hazards match TS fixtures.
- lethal/water rules match TS.
- movement clamps to board bounds.
- finish, cap, tie, and respawn behavior match TS.
- `encode_state` matches TS goldens.
- balances conserve on every tick.
