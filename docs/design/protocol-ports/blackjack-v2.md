# blackjack.v2 Rust Port

## Status

Design. This is the first new Rust port target.

## Canonical Protocol

- ID: `blackjack.v2`
- TS source: `sui-tunnel-ts/src/protocol/blackjack.ts`
- Rust target: `rust/protocols/blackjack`, module `v2`

## Protocol Shape

`blackjack.v2` is fixed-wager blackjack with per-card commit-reveal randomness.
Every dealt card runs a two-party commit phase, reveal phase, rank derivation,
and continuation.

Phases:

- `draw_commit`
- `draw_reveal`
- `player`
- `round_over`

Moves:

- `deal`
- `commit`
- `reveal`
- `hit`
- `stand`
- `forfeit`

Signed state includes pending commitments and reveals. Local secrets are needed
by a policy or driver but must not be included in `encode_state`.

## Randomness Contract

Commitment and reveal combination must be byte-exact with
`sui-tunnel-ts/src/core/commitment.ts` and `randomness.move`:

- commitment:
  `blake2b256(DOMAIN_COMMIT_REVEAL || lp(value) || lp(salt))`
- combined reveal seed:
  `blake2b256(DOMAIN_COMMIT_REVEAL || lp(value_a) || lp(salt_a) || lp(value_b) || lp(salt_b))`
- rank:
  `nextU64InRange(seedFromBytes(combineReveals(...)), 0, 13) + 1`

Salt length validation follows TS: commit creation requires salt length at least
16; reveal verification returns false for mismatches.

## Settlement And Unhappy Path

Round outcomes move the fixed wager between seats. The latest co-signed state is
always settleable.

Forfeit is protocol-level: it only takes effect if a `forfeit` move is proposed
and co-signed while the opponent owes a commit or reveal. If a peer disappears
before co-signing the forfeit state, the generic tunnel can only settle the last
co-signed balances plus timeout penalty. A rule-aware forced forfeit would need a
game-specific dispute adapter.

## Tests

- initial state encodes to TS golden bytes.
- commit/reveal sequence derives the same rank as TS.
- local secrets do not affect `encode_state`.
- duplicate commits and reveals are rejected.
- invalid reveals are rejected.
- forfeit is claimable only when the opponent owes commit or reveal.
- self-play through `PartyRuntime` conserves balances and reaches terminal.
