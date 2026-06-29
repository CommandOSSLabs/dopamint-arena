# bomb_it.series.v1 Rust Port

## Status

Design. Canonical rename of `bomb_it.multi.v1`.

## Canonical Protocol

- ID: `bomb_it.series.v1`
- Legacy ID: `bomb_it.multi.v1`
- TS source: `sui-tunnel-ts/src/protocol/multiGameBombIt.ts`
- Rust target: `rust/protocols/bomb-it`, module `series_v1`

## Wrapper Shape

Composes `bomb_it.v1`, but owns the real carried balances. The inner duel runs
with symbolic per-game balances only to determine the winner.

On a decided duel, the wrapper shifts `stakePerGame` from loser to winner.
`draw` and `null` swap nothing. The first move after a finished duel starts the
next duel using a synthetic per-game tunnel ID:

```text
<real_tunnel_id>:g<game_number>
```

## Settlement And Unhappy Path

Terminal between games when either side cannot fund `stakePerGame`. Generic
latest-state settlement is sufficient for completed co-signed duel outcomes.

If a peer disappears before a future explosion or kill is co-signed, that future
outcome is not enforceable. Settlement uses the latest co-signed checkpoint.

## Tests

- per-game grid seed differs across games.
- completed duel swaps wrapper balances exactly once.
- draw swaps nothing.
- reset starts fresh inner duel.
- terminal at stake exhaustion.
- `encode_state` matches TS goldens.
