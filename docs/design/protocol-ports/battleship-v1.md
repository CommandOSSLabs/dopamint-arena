# battleship.v1 Rust Port

## Status

Design.

## Canonical Protocol

- ID: `battleship.v1`
- TS source: `frontend/src/games/battleship/protocol/battleship.ts`
- Rust target: `rust/protocols/battleship`

## Protocol Shape

Battleship is a hidden-fleet game. Signed protocol state is public only:
commitment roots, pending shot, revealed shot results, hit counters, turn,
winner, and balances. Secret fleets and salts remain outside protocol state.

Phases:

- `awaitingCommits`
- `playing`
- `over`

Moves:

- `commit`
- `shoot`
- `reveal`

Each reveal verifies a Merkle proof against the defender's committed root.

## Settlement And Unhappy Path

Co-signed reveal outcomes are enforceable through the generic tunnel. If a
defender refuses to reveal after being shot, the current generic tunnel can only
settle the latest co-signed state plus timeout penalty. It cannot prove the shot
was a hit or miss without a game-specific dispute adapter.

A future rule-aware adapter could verify Merkle evidence or a legal-fleet proof
on-chain, but that is out of scope for the Rust parity port.

## Tests

- commit order A then B.
- shooting before both commits is rejected.
- duplicate shots are rejected.
- reveal must answer the pending shot.
- Merkle proof verification matches TS.
- final hit count shifts stake and conserves total.
- `encode_state` matches TS goldens.
