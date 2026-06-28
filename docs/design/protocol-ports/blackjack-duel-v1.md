# blackjack.duel.v1 Rust Port

## Status

Design.

## Canonical Protocol

- ID: `blackjack.duel.v1`
- TS source: `frontend/src/games/blackjack/app/lib/bjDuelProtocol.ts`
- Rust target: `rust/protocols/blackjack`, module `duel_v1`

## Protocol Shape

Head-to-head blackjack duel. Both seats play separate hands against a shared
deterministic dealer. The better result versus the dealer wins the pot.

State:

- deterministic seed from tunnel ID
- dealer hand
- A hand
- B hand
- phase (`a_turn`, `b_turn`, `over`)
- draw index
- balances
- wager

Move:

- `hit`
- `stand`

Dealer draws to 17 after both seats finish.

## Settlement And Unhappy Path

The protocol is terminal after B finishes and the shared dealer resolves. The
winner receives the wager from the loser, clamped to available balance. Generic
latest-state dispute is sufficient for co-signed terminal outcomes.

If a seat disappears during its turn, no future hit/stand is enforceable without
a co-signed state. Settlement falls back to the latest co-signed checkpoint plus
timeout penalty.

## Tests

- initial deal matches TS seed fixtures.
- turn order A then B.
- hit/bust/stand behavior matches TS.
- dealer resolution and `settleOutcome` match TS.
- `encode_state` matches TS goldens.
- balances conserve.
