# Local benchmark stack + bun load tooling

**Status:** Design approved (2026-06-24). Next: implementation plan.
**Scope:** A standardized local stack and two bun benchmark scripts that drive
real off-chain games — one per game, one agent swarm for TPS — over either an
in-process **local channel** or the **relay channel** (`tunnel-manager`).

## Problem

There is no standardized *local* stack for benchmarking. Today's load tooling
points at remote infrastructure or fakes the boundary:

- `sui-tunnel-ts/src/bench/` is an in-process simulation harness — never touches
  the real relay, real signing wire, or the chain.
- `frontend/agent/runAgents.mjs` and `loadtestRelay.mjs` drive the real app /
  real relay, but default to the **deployed dev ALB**, need a pre-funded
  `keys.json`, and `loadtestRelay.mjs` forwards **opaque `"x"` frames** — it
  measures raw relay forwarding, not real game play.

We want to benchmark **real games** (real protocol state machines, real ed25519
signing, real on-chain open/settle) against a stack that runs entirely on the
developer's machine, and to measure two distinct throughput numbers:

1. **Per game** — latency and moves/sec for each playable game.
2. **Aggregate TPS** — an agent swarm saturating the move path.

## Key insight: the transport is the seam

`DistributedTunnel` (`sui-tunnel-ts/src/core/distributedTunnel.ts`) drives a
two-party game over a minimal transport:

```ts
interface Transport {
  send(frame: Uint8Array): void;
  onFrame(cb: (frame: Uint8Array) => void): void;
}
```

Everything above the transport — protocol `randomMove`, state encoding, ed25519
sign/verify, MOVE/ACK framing, terminal detection — is identical regardless of
how frames travel. So we benchmark two genuinely different things by swapping
only the transport:

- **Local channel** (in-process): two transports wired back-to-back in memory;
  A's `send` invokes B's `onFrame` and vice-versa. No server, no network. This
  measures the **engine + signing ceiling**.
- **Relay channel** (network): a headless WS client to `tunnel-manager`'s
  `GET /v1/mp`, frames carried as the opaque `relay` payload. This measures the
  **relay-served throughput** — the same path a real player uses, just with the
  relay server on localhost.

The gap between the two numbers *is* the relay's per-move overhead.

"Relay channel" stays a relay number even though the server is local: frames
still cross the WS protocol and the `tunnel-manager` forwarding path. It is not
a local channel that happens to be co-located.

## Architecture

### Components

```
tools/loadbench/                         # NEW top-level bun package
  package.json                           # bun; scripts: stack, bench:game, swarm
  docker-compose.yml                     # infra only: sui-localnet + valkey
  .env.local                             # written by setup (gitignored)
  keys.json                              # funded wallet pool (gitignored)
  src/
    stack.ts                             # bring infra up, health-gate, run setup
    setup.ts                             # publish Move pkg + faucet-fund keys
    relayProcess.ts                      # spawn/health-check `cargo run -p tunnel-manager`
    channels/
      localChannel.ts                    # pair() -> [transportA, transportB]
      relayChannel.ts                    # headless MpTransport over ws /v1/mp
    match.ts                             # runMatch(): one full game, channel-agnostic
    games.ts                             # playable-game registry + per-game config
    benchGame.ts                         # `bench:game` entrypoint
    swarm.ts                             # `swarm` entrypoint
    metrics.ts                           # latency/throughput aggregation + reporting
```

`tools/loadbench` imports `sui-tunnel-ts` **as a library** (`core`, `onchain`,
`protocol`, `agents`). The only edit to an upstream pnpm package is two lines in
`behaviors.ts` (see "Game coverage"). `frontend/` is not imported.

### The standardized local stack

```
docker compose up            # infra, stable backing services
  ├─ sui-localnet   RPC :9000, faucet :9123
  └─ valkey         :6379 (redis-compatible cache + pubsub)

bun run stack                # = compose up + wait-healthy + setup
  setup.ts:
    1. wait for localnet RPC + faucet healthy
    2. publish sui_tunnel Move package -> PACKAGE_ID into .env.local
    3. faucet-fund the settler key + N bench wallets -> keys.json

cargo run -p tunnel-manager  # relay; iterated on, so NOT in compose
  env from .env.local: SUI_RPC_URL=localnet, TUNNEL_PACKAGE_ID,
       SUI_SETTLER_KEY (funded)
  store: in-memory by default (valkey out of the move path); set
       REDIS_CACHE_URL/REDIS_PUBSUB_URL=valkey only to benchmark the redis path
```

Division of responsibility (approved):

- **Infra in Compose** — localnet and valkey are stable services you rarely
  touch; containerizing them makes the stack reproducible and one-command.
- **Relay via `cargo run`** — the relay is the thing under iteration; a Rust
  image rebuild per change is too slow. Run it from source.
- **Publish + fund as bun setup steps** — `setup.ts`, not an init container, so
  the artifacts (`PACKAGE_ID`, `keys.json`) are plain local files the bench
  scripts read.

Lifecycle ownership:

- `bun run stack` owns **infra + setup only**.
- `bench:game`/`swarm` **auto-spawn the relay** (`relayProcess.ts`) if a
  `--channel relay` run finds no healthy relay; `--channel local` runs never
  need it.
- Compose infra (localnet) is required by **both** channels, because on-chain
  open/settle is real in both.

`.env.local` and `keys.json` are gitignored. `keys.json` holds localnet-only
faucet keys (dust stakes), never real funds.

### The match runner (shared core)

`runMatch(game, partyA, partyB, { channel })` runs one full game and is the unit
both scripts compose:

```
ON-CHAIN open    : onchain/createAndFund.buildOpenAndFundMany   (real, localnet)   [both channels]
WIRE             : channel === 'local'
                     ? localChannel.pair()                       (in-memory seats)
                     : two relayChannel clients                  (challenge -> connect -> queue.join game)
MATCH            : local -> direct pairing; relay -> server match.found, roles A/B
PLAY (off-chain) : DistributedTunnel + protocol.randomMove, MOVE/ACK frames,
                   real ed25519 sign/verify per update, until protocol.isTerminal  [identical both channels]
ON-CHAIN settle  : onchain/txbuilders.buildCloseWithRootFromSettlement (cooperative) [both channels]
RETURN           : { channel, game, moves, bytes, openMs, playMs, settleMs, ok }
```

This is `examples/createAndFundBatch.ts` (the existing live on-chain create +
cooperative-settle harness with faucet funding) for the bookends, plus
`DistributedTunnel` for the moves, with the transport chosen by `channel`.

`relayChannel.ts`'s `MpTransport` mirrors the wire protocol of
`frontend/src/pvp/mpClient.ts` (challenge/connect/queue.join/match.found/relay)
but is headless: bun/`ws` `WebSocket`, no React, no resume/reconnect UI. It
authenticates by signing the server nonce with the ephemeral key, joins the
queue under the game name, and maps `DistributedTunnel` frames to/from the
opaque `relay` payload.

### The two scripts

**`bench:game <game> [--channel local|relay] [--matches N] [--concurrency C] [--all]`**

Runs N matches of one game (`--all` loops the playable set). Reports per game:
moves/match, p50/p99 move latency, moves/sec, open/play/settle ms, settle
success rate, channel. Running both channels and diffing yields the relay's
per-move cost for that game's traffic shape.

**`swarm [--channel local|relay] [--matches M] [--concurrency C] [--duration S] [--games a,b,c]`**

Fans out C concurrent `runMatch` calls continuously (optionally mixing games) to
saturate the move path. Headline output: **aggregate moves/sec**, labeled by
channel —

- `--channel local` -> **engine/signing-bound TPS** (no server in the path).
- `--channel relay` -> **relay-bound TPS** (through `tunnel-manager`).

Also reports tunnels-settled/sec (the on-chain-finality-bound number, for
contrast) so the move-TPS and lifecycle-TPS are never conflated.

`--channel relay` runs additionally read the relay's `live-stats` SSE counter
and cross-check it against the client-measured moves/sec.

## Game coverage

Real engine protocols with a `randomMove` (drivable autonomously):

| Game         | Protocol module      | Wired in `behaviors.ts`? |
|--------------|----------------------|--------------------------|
| payments     | `payments.ts`        | yes                      |
| blackjack    | `blackjack.ts`       | yes                      |
| ticTacToe    | `ticTacToe.ts`       | yes                      |
| chat         | `chat.ts`            | yes                      |
| quantumPoker | `quantumPoker.ts`    | yes (`poker`)            |
| bombIt       | `bombIt.ts`          | **no — add**             |
| cross        | `cross.ts`           | **no — add**             |

The **only** upstream edit: add `bombIt` and `cross` to `BehaviorName`,
`BEHAVIOR_NAMES`, and `createBehaviorProtocol` in
`sui-tunnel-ts/src/agents/behaviors.ts` — consistent with how Dopamint already
extends the framework, and minimal for re-sync.

Out of scope (no engine protocol exists): **battleship, coinFlip, dice, slots**.
`bench:game` rejects them with a clear "needs an engine protocol first" message.

## Testing

- **Unit** (`bun test`, co-located `*.test.ts`):
  - `MpTransport` frame encode/decode against the relay wire shape.
  - `localChannel.pair()` delivers A->B and B->A frames.
  - arg parsing and `metrics.ts` math (percentiles, rates).
- **Integration** (golden path, real boundary):
  - `bench:game payments --channel relay --matches 1` against an ephemeral local
    stack: real localnet open/settle + real relay move exchange. Never fakes the
    relay it verifies.
  - the same on `--channel local` to assert both channels complete a match.
- Stack readiness is gated by explicit health waits (RPC, faucet, relay
  `/health`); flakes are root-caused, not retry-looped.

## Decisions captured

- **Fidelity:** real off-chain engine (real protocol + signing), not synthetic
  opaque-frame traffic.
- **On-chain:** real `create_and_fund` open + cooperative settle against a Sui
  **localnet**; moves stay off-chain. Per-match lifecycle = chain bookends, the
  many moves between them are the throughput.
- **Two channels:** local (in-process) and relay (WS to `tunnel-manager`),
  selected per run; same engine path, different wire.
- **Location:** new top-level `tools/loadbench/` bun package; upstream pnpm
  packages stay pnpm and near-untouched (two-line `behaviors.ts` edit aside).
- **Infra:** Docker Compose for localnet + valkey; relay via `cargo run` with
  the **in-memory store by default** (valkey is opt-in, only to benchmark the
  redis path, so it stays out of the move path otherwise); publish + fund as bun
  setup steps.

## Out of scope

- Protocols for battleship/coinFlip/dice/slots.
- Browser-fidelity load (already covered by `frontend/agent/runAgents.mjs`).
- Multi-instance relay / re-homing load (separate concern).
- CI wiring of the benchmarks (local developer tool first).
