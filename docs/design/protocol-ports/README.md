# Rust Protocol Port Designs

This directory is the source of truth for porting TypeScript tunnel protocols to
Rust. Each document covers one canonical protocol ID or one shared wrapper
pattern.

## Protocol ID Convention

Architecture decision: [ADR-0022](../../decisions/0022-canonical-protocol-id-naming.md).

Canonical protocol IDs use:

```text
<snake_case_family>[.<snake_case_variant>].vN
<snake_case_family>.series.vN
```

Use `_` inside a segment, `.` between semantic segments, and always end canonical
IDs with `.vN`. Kebab-case remains acceptable for UI game IDs, routes, assets,
and CSS names, but not protocol IDs.

## Canonical IDs

| Canonical ID | Current TS source | Rust status |
| --- | --- | --- |
| `payments.v1` | `sui-tunnel-ts/src/protocol/payments.ts` | ported |
| `blackjack.v2` | `sui-tunnel-ts/src/protocol/blackjack.ts` | design |
| `blackjack.bet.v1` | `frontend/src/games/blackjack/app/lib/bjBetProtocol.ts` | ported, legacy |
| `blackjack.duel.v1` | `frontend/src/games/blackjack/app/lib/bjDuelProtocol.ts` | design |
| `tic_tac_toe.v1` | `sui-tunnel-ts/src/protocol/ticTacToe.ts` | design |
| `tic_tac_toe.series.v1` | legacy `tic_tac_toe.multi.v1` | design |
| `caro.v1` | `frontend/src/games/ticTacToe/packages/shared/src/caro/protocol.ts` | design |
| `caro.series.v1` | legacy `caro.multi.v1` | design |
| `battleship.v1` | `frontend/src/games/battleship/protocol/battleship.ts` | design |
| `battleship.series.v1` | legacy `battleship.multi.v1` | design |
| `cross.v1` | `sui-tunnel-ts/src/protocol/cross.ts` | design |
| `cross.series.v1` | legacy `cross.multi.v1` | design |
| `bomb_it.v1` | `sui-tunnel-ts/src/protocol/bombIt.ts` | design |
| `bomb_it.series.v1` | legacy `bomb_it.multi.v1` | design |
| `world_canvas.cell.v1` | legacy `world_canvas.v1` | design |
| `world_canvas.stroke.v1` | legacy `world-canvas-pvp` | design |
| `api_credits.v1` | `sui-tunnel-ts/src/protocol/apiCredits.ts` | design |
| `chat.v1` | `sui-tunnel-ts/src/protocol/chat.ts` | design |
| `quantum_poker.v2` | `sui-tunnel-ts/src/protocol/quantumPoker.ts` | design |

## Legacy Aliases

The following IDs may need compatibility aliases because they already appear in
state domains, tests, local storage, matchmaking, or existing code:

- `world_canvas.v1` -> `world_canvas.cell.v1`
- `world-canvas-pvp` -> `world_canvas.stroke.v1`
- `*.multi.v1` -> `*.series.v1`

Aliases do not change old state hashes. A protocol whose domain is renamed must
be treated as a new canonical version unless all persisted and wire users migrate
at once.

## Rust Harness Vocabulary

Rust ports keep the protocol rules pure and deterministic:

- `Protocol` owns validation, transition, encoding, balances, terminal checks,
  and optional random move sampling.
- `PartyRuntime` owns one party's signed state-channel state: nonce, pending
  proposal, frame construction, frame verification, and checkpoint advancement.
- `MoveStrategy` chooses moves outside the protocol rules.
- `FrameTransport` carries encoded frames and knows nothing about game state.
- `PartyDriver` wires `PartyRuntime + MoveStrategy + FrameTransport` for async
  serving.

These abstractions live in `rust/engine/tunnel-harness`. Fleet crates consume
the harness and provide runtime-specific orchestration.

## Settlement Model

The Sui tunnel contract is generic. It verifies signatures, monotonic nonces,
balance conservation, and timeout/dispute rules. It does not replay game rules.

For every port:

- `apply_move` must be pure and deterministic.
- `encode_state` must be byte-exact with the canonical TS protocol.
- `balances` must always sum to the locked total.
- latest fully co-signed state is the enforceable on-chain floor.
- half-signed pending moves are not enforceable.

Generic unhappy paths:

- malformed or illegal move: peer refuses to sign after replaying the transition.
- stale state: rejected by nonce.
- forged state: rejected by signature verification.
- peer drops: resume adopts the highest valid co-signed checkpoint; otherwise the
  staying party can dispute and force-close after timeout.
- peer owes a reveal/forfeit move and disappears: generic tunnel can only settle
  the latest co-signed balances plus any configured timeout penalty. Rule-aware
  forced outcomes require a game-specific referee or proof adapter.

## Port Order

1. `blackjack.v2`
2. `tic_tac_toe.v1`
3. `cross.v1`
4. `bomb_it.v1`
5. `*.series.v1` wrappers
6. `world_canvas.cell.v1`, `world_canvas.stroke.v1`
7. `api_credits.v1`, `chat.v1`
8. `battleship.v1`, `caro.v1`, `blackjack.duel.v1`
9. `quantum_poker.v2`
