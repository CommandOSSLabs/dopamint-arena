# series.v1 Wrapper Design

## Status

Canonical naming design for former `.multi.v1` protocols.

## Canonical Protocol

Use:

```text
<family>.series.v1
```

Legacy aliases:

- `tic_tac_toe.multi.v1`
- `caro.multi.v1`
- `battleship.multi.v1`
- `cross.multi.v1`
- `bomb_it.multi.v1`

## Semantics

A series protocol runs many complete inner games inside one funded tunnel and
settles once. It is a protocol wrapper, not a smart-contract mode.

Common state:

- `inner`: current base protocol state
- `gamesPlayed`: completed games behind the current one
- carried balances, either owned by the wrapper or carried by the inner state
- `stakePerGame` or equivalent funding rule
- optional max games

The wrapper has a distinct domain tag and length-prefixes the inner state
encoding so single-game and series hashes cannot collide.

## Per-Game Reset

For deterministic-randomness games, each new inner game must derive a distinct
public seed. Use a synthetic per-game tunnel ID:

```text
<real_tunnel_id>:g<game_number>
```

The game number must be included in the signed series state.

## Settlement And Unhappy Path

The generic tunnel can settle only the latest co-signed series state. This is
enough for:

- carried balances after completed inner games
- current in-progress inner game checkpoint
- exhaustion or max-game terminal states

It is not enough to adjudicate an unco-signed future inner-game outcome. If a
player disappears between games, the latest carried balances settle. If a player
disappears while owing a reveal or response inside a hidden-state game, the
generic tunnel cannot apply the rule-level forfeit unless a forfeit state was
already co-signed.

Rule-aware forced outcomes require a game-specific referee or proof adapter.

## Tests

Every series wrapper needs:

- domain differs from inner protocol.
- encoding cannot collide with inner encoding.
- completed game carries or swaps balances exactly once.
- reset starts a fresh inner game.
- deterministic games use distinct per-game seeds.
- terminal policy matches the specific protocol.
