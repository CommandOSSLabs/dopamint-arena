# blackjack.bet.v1 Rust Port

## Status

Rust port exists in `rust/protocols/blackjack`. It is legacy but should remain
available while callers migrate.

## Canonical Protocol

- ID: `blackjack.bet.v1`
- TS source: `frontend/src/games/blackjack/app/lib/bjBetProtocol.ts`
- Rust target: `rust/protocols/blackjack`, module `bet_v1`

## Protocol Shape

Variable-bet blackjack. The player starts each round by choosing a bet. Cards
come from a deterministic stream keyed by protocol domain and round.

Phases:

- `round_over`
- `player`
- `dealer`

Moves:

- `bet`
- `hit`
- `stand`

The player role rotates every two rounds by default.

## Naming Note

The `.bet` segment is intentional. It distinguishes this older variable-bet
protocol from fixed-wager `blackjack.v2`. The ID is part of the state domain and
must not be renamed without treating it as a new protocol version.

## Settlement And Unhappy Path

Each completed round moves the chosen bet between seats. Generic latest-state
settlement is sufficient for co-signed outcomes. If a peer disappears between
rounds or mid-round, the tunnel can only settle the latest co-signed state plus
timeout penalty.

## Tests

Existing Rust tests cover move JSON, state hash goldens, first-round cards,
balance conservation, wrong turn rejection, and fleet self-play. Keep those as
compatibility gates while adding `blackjack.v2`.
