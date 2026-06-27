# quantum_poker.v2 Rust Port

## Status

Design. Complex hidden-state port; defer until simpler public-state protocols and
commit-reveal helpers are stable.

## Canonical Protocol

- ID: `quantum_poker.v2`
- TS source: `sui-tunnel-ts/src/protocol/quantumPoker.ts`
- Rust target: `rust/protocols/quantum-poker`

## Protocol Shape

Quantum Poker is a heads-up hidden-card protocol with dealerless
commit-reveal randomness, asymmetric reveals, betting, showdown, and optional
future proof support.

The Rust port must mirror the TS protocol and ADR-0008:

- slot-based commitments
- asymmetric private-hole reveal
- public board reveal
- showdown reveal
- n-deck card model
- duplicate-aware hand evaluation with Five of a Kind
- betting and balance settlement

## Settlement And Unhappy Path

Happy-path settlement uses the latest co-signed state, just like every other
tunnel protocol. If a player withholds a required reveal before a forfeit state
is co-signed, generic tunnel timeout can only settle the latest checkpoint plus
penalty.

Rule-aware forced poker outcomes require the optional dispute adapter described
in ADR-0008. The Rust parity port should not depend on that adapter, but should
structure public inputs and transcript data so the adapter remains possible.

## Tests

- commitment and reveal helpers match TS/Move fixtures.
- card derivation and board collision behavior match TS.
- hidden duplicate and board-burn rules match TS.
- hand evaluator matches TS goldens.
- betting transitions and balance settlement match TS.
- `encode_state` matches TS goldens for every phase.
- serialization supports fleet/bench codecs.
