# loadbench: kit-driven fidelity + max-scale parallelism + container — design

**Date:** 2026-06-25 · **Status:** approved · **Scope:** evolves the existing
`tools/loadbench/` bun package (built per
`docs/superpowers/plans/2026-06-24-local-bench-stack.md`).

## Problem

The bench works but has three gaps the user wants closed:

1. **Fidelity.** It drives `createBehaviorProtocol(...)` from
   `sui-tunnel-ts/agents/behaviors` — SDK agent wrappers, *not* the protocol
   classes the shipped frontend games use. Per
   `docs/superpowers/specs/2026-06-19-canonical-game-bot-kit-design.md`, a bench
   whose on-chain settlement footprint must look like real human play has to
   drive the **same FE protocol class the `usePvp*` hooks use**. The canonical
   game-bot kit (`frontend/src/agent/gameKit.ts`) exists precisely for this.
2. **Compute utilization.** `--concurrency` is async fan-out inside one
   single-threaded bun process. For the headline CPU-bound burst
   (`--offchain --channel local`, ed25519 signing), one thread pins one core;
   no amount of async concurrency uses a second core. To max out a large box
   (target: a 192-vCPU `c7i.48xlarge`) the bench needs a real multi-core layer.
3. **Isolation / resource allocation.** Runs should be containerizable with an
   explicitly allocated CPU/memory slice, and the run should report the compute
   resources it actually used.

## Goals

- Drive each game through its **canonical kit** so settlements are
  byte-identical to the deployed game.
- Use **all allocated cores** via `worker_threads`, with `auto` defaults that
  push workers and concurrency to the ceiling (memory-bounded, not OOM).
- Report **avg + peak CPU and memory** for every run.
- Run the bench as a **compose service** with a configurable resource slice
  (`--channel local` modes: offchain + onchain).

## Non-goals

- Containerizing the relay / `--channel relay` from inside the container
  (relay stays host-side; deferred).
- Adaptive load-ramp controllers, cgroup-based metric sourcing (process APIs
  only), or production fleet/AWS orchestration.
- Converting any package off its toolchain (loadbench stays bun;
  `sui-tunnel-ts`/`frontend` stay as they are).

---

## Phase A — Kit-driven match engine (fidelity)

### A1. Resolve the `sui-tunnel-ts` alias under bun

The frontend kits import via bare specifiers (`sui-tunnel-ts`,
`sui-tunnel-ts/protocol/bombIt`, …). The frontend resolves these with a tsconfig
`paths` map + a vite alias to `../sui-tunnel-ts/src`. bun honors tsconfig
`paths`, so add to `tools/loadbench/tsconfig.json`:

```jsonc
"baseUrl": ".",
"paths": {
  "sui-tunnel-ts": ["../../sui-tunnel-ts/src/index.ts"],
  "sui-tunnel-ts/*": ["../../sui-tunnel-ts/src/*"]
}
```

Existing loadbench files keep their relative `../../../sui-tunnel-ts/src/...`
imports (no churn); the alias exists solely so the imported frontend kits
resolve. **Validation gate:** importing `frontend/src/agent/gameKit` must pull
in no React/browser/`window` coupling under bun — the kit spec asserts the
protocol classes are pure TS; a focused smoke import proves it before the rest
of Phase A is built. If a kit transitively touches the DOM, that kit is fixed in
`frontend/` (out-of-scope games dropped) or escalated.

### A2. Kit registry (`src/games.ts`, rewritten)

`GAME_KITS` (`frontend/src/agent/gameKit.ts`) provides 6 games. The bench
registry maps a stable bench id → kit, and exposes the kit, not a bare protocol:

| bench id | `GameId` in `GAME_KITS` |
|---|---|
| `ticTacToe` | `tictactoe` |
| `blackjack` | `blackjack` |
| `battleship` | `battleship` |
| `quantumPoker` | `quantum-poker` |
| `bombIt` | `bomb-it` |
| `cross` | `chicken-cross` |

New surface:
- `PLAYABLE: readonly string[]` — the 6 ids above (`payments`/`chat` removed).
- `isPlayable(game): boolean`.
- `kitFor(game): GameKit<unknown, unknown>` — throws for unknown ids with the
  playable list.
- `gameStake(game): bigint` — returns the kit's `defaultStake`
  (replaces the flat `gameBalances`); seat balances are `{ a: stake, b: stake }`.

### A3. Match driver drives bots (`src/match.ts`)

`GameKit<S,M>` shape (from the kit):
```ts
interface GameKit<S,M> {
  id; protocol: Protocol<S,M>; stateHash(s): StateHash;
  createBot(seat: Party, ctx: { rngForSeat(seat): () => number }): GameBot<S,M>;
  defaultStake: bigint;
}
interface GameBot<S,M> {
  plan(state: S): M | null;            // null = waiting / not my turn
  confirm(state: S, move: M): void;    // advance memory after acceptance
  abort(): void;                       // teardown on error
}
```

`playMatch` is reworked to accept a `GameKit` instead of a bare `Protocol`:
- Build `dtA`/`dtB` `DistributedTunnel`s with `kit.protocol` (unchanged seat /
  endpoint / counting-transport setup; the existing bigint+bytes `moveCodec`
  stays, covering kit move types).
- Create one bot per seat: `botA = kit.createBot("A", { rngForSeat })`,
  `botB = kit.createBot("B", …)`, where `rngForSeat` yields a seeded,
  reproducible stream derived from `opts.seed` + seat (so runs are deterministic).
- Move loop: for the seat to act, `move = bot.plan(dt.state)`; `null` → that seat
  is waiting, try the other / advance the turn (mirrors today's `randomMove`
  null handling and the `!progressed` termination). On a non-null move:
  `proposeAndAwait(dt, move, ts)`, then `bot.confirm(dt.state, move)`. Bound by
  `maxMoves` and `protocol.isTerminal`.
- On any thrown error during the loop: call `botA.abort()`/`botB.abort()` before
  rethrowing.
- Settlement (root, timestamp, combine) unchanged.

`makeSeats` is unchanged (derived hex `tunnelId`, etc.). `runFullMatch`
(`runMatch.ts`) changes only its `playMatch(kitFor(game), …)` call and uses
`gameStake` for balances.

### A4. behaviors.ts edit stays

The Task-5 upstream addition of `bombIt`/`cross` to
`sui-tunnel-ts/agents/behaviors.ts` is **left in place** — the frontend kits
import `sui-tunnel-ts/agents/behaviors`, so reverting risks breaking them, and
the edit is harmless. The loadbench `behaviors`-based code path is removed.

### A5. Tests (Phase A)

- `games.test.ts` — `isPlayable` accepts the 6, rejects others; each of the 6
  kits drives a full match to a settlement whose balances sum to the locked
  total (kit-driven, over the local channel). Non-terminating games are bounded
  by `maxMoves` as before.
- Update `match.test.ts` to construct via a kit (use one concrete kit, e.g.
  blackjack) instead of `PaymentsProtocol`.
- Update `smoke.test.ts` to a kit game (e.g. `blackjack`) for the gated onchain
  and the offchain assertions.

---

## Phase B — Max-scale parallelism, metrics, container

### B1. Worker layer (`src/worker.ts`)

A `worker_threads` entry point. Receives `{ workerId, channel, anchor, games,
concurrency, matches, durationMs, seedBase, envForOnchain }` via `workerData`,
runs `runSwarm` over its **slice** of the work using `runFullMatch`, and posts
back `{ moves, matches, latencies, error? }`. Each worker builds its own
`SuiClient`/funder (onchain) and its own relay seats (not used in container;
host relay only). A worker that throws posts `{ error }` and exits non-fatally;
the parent excludes it and logs it — one worker dying never aborts the run.

Determinism: each worker derives seeds from `seedBase + workerId` so matches
stay reproducible across the fleet.

### B2. `swarm.ts` refactor (the fleet driver)

- `parseSwarmArgs` gains `--workers <n|auto>`; `--concurrency` accepts
  `<n|auto>`. Defaults: `--workers auto`, `--concurrency auto`.
- **`auto` resolution:**
  - `workers auto` = `os.availableParallelism()` (all cores; in the container we
    pass an explicit `--workers` matching the CPU limit).
  - `concurrency auto` = pushed to a high value, **capped by a memory budget**:
    `maxInFlight = floor(availableMemoryBudget / PER_MATCH_MEM_ESTIMATE)`, then
    `concurrency = max(1, floor(maxInFlight / workers))`. `PER_MATCH_MEM_ESTIMATE`
    is a conservative constant (documented, tunable via `--per-match-kb`); the
    memory budget defaults to **70% of `os.totalmem()`** (overridable via
    `--mem-budget-mb`, which is what the container sets to match its slice).
    This makes "as many as we can" mean "as many as fit", not OOM.
- **Work distribution:** spawn `workers` threads. `--matches N` → each worker
  gets `ceil(N/workers)` (last worker trimmed so the total is exactly `N`).
  `--duration S` → every worker runs the full `S`. Parent `await`s all workers,
  merges `{moves, matches}` (sum) and `latencies` (concatenate) for aggregate
  move-TPS + p50/p99.
- Output keeps the `[channel/anchor]` label and adds a fleet line:
  `workers=<w> concurrency=<c> (auto)` and the existing `tunnels settled/s`
  (onchain only).

`bench:game` keeps its single-process per-game latency role (no worker fleet)
but gains the resource report (B3).

### B3. Resource monitor (`src/resourceMonitor.ts`)

- `startResourceMonitor({ intervalMs = 500, now?, cpuUsage?, memUsage? })` →
  handle; `stop()` → summary. Injectable clock + samplers for unit testing.
- Each tick samples `process.cpuUsage()` (process-wide — includes all
  `worker_threads`) and `process.memoryUsage().rss`.
- Summary: `cpu: { avgPct, peakPct, avgCores, peakCores }` (CPU% normalized by
  elapsed wall-time; cores = pct/100), `mem: { avgRssMb, peakRssMb }`,
  `samples`. `avgPct` uses total cpu-time delta / elapsed; `peakPct` is the max
  per-interval delta / interval.
- Printed beneath the throughput/latency lines for both `swarm` and `bench:game`.

### B4. Container (`Dockerfile` + compose `loadbench` service)

- `tools/loadbench/Dockerfile` — `oven/bun` base; copies `tools/loadbench`,
  `sui-tunnel-ts/src`, and `frontend/src/agent` (the kits + their deps);
  `bun install`; entrypoint runs `bun run src/swarm.ts` (args via compose
  `command`/env). Build context is the repo root so all three trees are
  available.
- `docker-compose.yml` gains a `loadbench` service on the existing network,
  `profiles: ["bench"]` (so `bun run stack` doesn't start it), with
  `deploy.resources.limits.cpus`/`.memory` (overridable by `docker run
  --cpus/--memory`). It mounts `./.env.local` and `./keys.json` read-only.
- **RPC URL becomes env-driven:** `benchGame.ts`/`swarm.ts` use
  `process.env.SUI_RPC_URL ?? getFullnodeUrl("localnet")`. `stack.ts` already
  writes `SUI_RPC_URL`; the compose service sets it to
  `http://sui-localnet:9000` so onchain resolves over the compose network.
- Container runs `--channel local` only (offchain + onchain). `--channel relay`
  is host-only and errors clearly if requested in-container.

### B5. Tests (Phase B)

- `resourceMonitor.test.ts` — avg/peak aggregation from injected cpu/mem samples
  + a fake clock (deterministic).
- `swarm.test.ts` additions — `parseSwarmArgs` parses `--workers`/`auto`; the
  `auto` resolver computes workers/concurrency from injected core-count + memory
  budget; the matches/duration **slice math** distributes `N` across `W` workers
  exactly (unit-tested with a fake run fn, mirroring existing `runSwarm` tests).
- Manual integration: `bun run swarm --offchain --channel local --workers auto`
  shows multi-core CPU (peakCores ≈ workers) in the report; the `loadbench`
  compose service runs an onchain swarm against the localnet with a CPU/mem cap.

---

## Sequencing

Phase A first (it changes the move engine and the playable set), then Phase B
(wraps the kit-driven match in the worker fleet + metrics + container). The two
phases may become two implementation plans; each phase's tests gate the next.

## Risks

- **Kit purity under bun (A1).** If `gameKit` transitively imports browser-only
  code, the import smoke fails early; mitigation is to drop the offending game or
  fix it in `frontend/`. Gated before the rest of Phase A.
- **Kit move codecs.** A kit move type may carry fields the current
  bigint+bytes codec doesn't cover; the per-game settlement test surfaces this,
  fixed by extending the codec (as done for quantumPoker).
- **Memory cap accuracy (B2).** `PER_MATCH_MEM_ESTIMATE` is heuristic; it is
  documented and overridable, and the resource report shows actual RSS so the
  estimate can be tuned against reality.
