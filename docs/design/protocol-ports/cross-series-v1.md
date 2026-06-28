# cross.series.v1 Rust Port

## Status

Design. Canonical rename of `cross.multi.v1`.

## Canonical Protocol

- ID: `cross.series.v1`
- Legacy ID: `cross.multi.v1`
- TS source: `sui-tunnel-ts/src/protocol/multiGameCross.ts`
- Rust target: `rust/protocols/cross`, module `series_v1`

## Wrapper Shape

Composes `cross.v1`, but owns the real carried balances. The inner race runs
with symbolic per-game balances only to determine the winner.

On a decided race, the wrapper shifts `stakePerGame` from loser to winner. The
first move after a finished race starts the next race using a synthetic per-game
tunnel ID:

```text
<real_tunnel_id>:g<game_number>
```

## Settlement And Unhappy Path

Terminal between games when either side cannot fund `stakePerGame`. Generic
latest-state settlement is sufficient for completed co-signed race outcomes.

If a peer disappears before the next tick, no future collision or finish is
enforceable. Settlement uses the latest co-signed checkpoint.

## Tests

- per-game seed differs across games.
- completed race swaps wrapper balances exactly once.
- push swaps nothing.
- reset starts fresh inner race.
- terminal at stake exhaustion.
- `encode_state` matches TS goldens.
