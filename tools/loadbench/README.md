# loadbench

A **bun** package that benchmarks real off-chain games on the `sui-tunnel-ts`
engine. One match opens and cooperatively settles a real tunnel; the many moves
between those bookends are the throughput. It measures two things:

- **per-game latency** (`bench:game`) — open → play → settle, with per-move p50/p99.
- **aggregate move-TPS** (`swarm`) — many concurrent matches across games.

It swaps only the **transport** under a fixed engine path, so the numbers are
comparable across two channels and two anchor modes (below).

The bench drives the **real frontend protocol classes** via the game kits
(`frontend/src/agent/gameKit.ts`). On-chain settlements are byte-identical to
the shipped games — not synthetic SDK behaviors.

> Toolchain: this is a **bun** package. Do not convert it (or `sui-tunnel-ts/`)
> to anything else. It imports engine code from `../../sui-tunnel-ts/src` via
> relative paths.

## Channels and anchors

Every run picks one **channel** and one **anchor**, and every printed line is
labelled `[channel/anchor]` — never conflate them.

| | meaning | needs |
|---|---|---|
| `--channel local` | two transports paired in memory (engine/signing ceiling) | nothing |
| `--channel relay` | headless WS client through the `tunnel-manager` relay | the relay |
| `--anchor onchain` (default) | real `create_and_fund` open + `close_cooperative_with_root` settle on a Sui localnet | the stack |
| `--offchain` / `--anchor offchain` | no chain at all; synthetic tunnel id, pure move loop | nothing (local) / relay only |

Moves stay off-chain in both anchor modes. `offchain --channel local` needs no
infra at all — start there.

## Prerequisites

- `bun`, `docker`, `cargo`, and the `sui` CLI on PATH.
- For `--anchor onchain` or `--channel relay`: run `bun run stack` once (below).
- Apple Silicon: the compose file uses an arm64 Sui image; first relay run
  compiles `tunnel-manager` via `cargo` and can take a few minutes.

## Commands

All commands run from `tools/loadbench/`.

### `bun run stack` — stand up the local infra (once per session)

Brings up Docker compose (Sui localnet on `:9000`/`:9123`, Valkey on `:6379`),
waits for health, publishes the `sui_tunnel` Move package, funds a settler + N
bench keys via the faucet, and writes `.env.local` + `keys.json` (both
gitignored). Set `N` to change the key count (default 8):

```bash
bun run stack          # default 8 keys
N=16 bun run stack     # more keys
```

Re-run only after `docker compose down` or when you want a fresh genesis. Check
state with `docker compose ps` (both services should be `healthy`).

### `bun run bench:game <game> [flags]` — one game

```bash
# pure engine ceiling — no chain, no relay (start here):
bun run bench:game ticTacToe --channel local --offchain

# real on-chain match on the localnet (onchain is the default anchor):
bun run bench:game blackjack --channel local

# more matches, run concurrently:
bun run bench:game ticTacToe --channel local --offchain --matches 50 --concurrency 8

# every playable game in one go:
bun run bench:game --all --channel local --offchain
```

Defaults: `--channel relay`, `--anchor onchain`, `--matches 1`, `--concurrency 1`.

### `bun run swarm [flags]` — aggregate move-TPS

```bash
# pure-burst engine TPS, no infra:
bun run swarm --offchain --channel local --duration 10

# fixed match count, on-chain, default game rotation:
bun run swarm --channel local --matches 40

# pick games and run for a duration:
bun run swarm --offchain --channel local --games blackjack,quantumPoker --duration 15

# explicit fleet size:
bun run swarm --offchain --channel local --workers 4 --concurrency 6 --duration 10
```

Defaults: `--channel relay`, `--anchor onchain`, `--workers auto`, `--concurrency
auto`, all playable games. If you pass neither `--matches` nor `--duration`, it
runs for 15s. The `tunnels settled/s` line prints only for `--anchor onchain`.

### `bun test` — the unit + smoke suite

```bash
bun test
```

The on-chain smoke (`src/smoke.test.ts`) auto-runs when `.env.local` has a
published package (i.e. after `bun run stack`); otherwise it skips, keeping the
suite green with no infra. The offchain smoke always runs.

## Flags

| flag | `bench:game` | `swarm` | notes |
|---|---|---|---|
| `<game>` (positional) | yes | — | one of the playable games below |
| `--all` | yes | — | run every playable game |
| `--games a,b,c` | — | yes | comma-separated; defaults to all |
| `--channel local\|relay` | yes | yes | default `relay` |
| `--offchain` / `--anchor offchain\|onchain` | yes | yes | default `onchain` |
| `--matches N` | yes | yes | swarm: stops at this count |
| `--concurrency N` | yes | yes | async matches in flight per worker |
| `--duration S` | — | yes | swarm: stop after S seconds |
| `--workers N\|auto` | — | yes | OS worker threads (true multi-core) |
| `--mem-budget-mb N` | — | yes | memory cap for auto concurrency (io mode) |
| `--per-match-kb N` | — | yes | per-match RSS estimate for auto concurrency |

**Playable games:** `ticTacToe, blackjack, battleship, quantumPoker, bombIt,
cross`. These map to the real frontend kit classes; any other name is rejected
with a message listing the valid options.

## Fleet sizing (`--workers` and `--concurrency`)

`swarm` distributes work across a fleet of OS worker threads:

- **`--workers`** = number of Node.js `worker_threads`. Each thread runs on its
  own OS core, giving **true multi-core parallelism**. `auto` resolves to
  `round(1.5 × os.availableParallelism())`.

- **`--concurrency`** = async matches in flight **per worker**. This overlaps
  I/O waiting within a thread but does not add cores. `auto` is mode-aware:

  | mode | when | auto concurrency |
  |---|---|---|
  | cpu | `--offchain --channel local` | 2/worker — cores already saturated; more async tasks only thrash |
  | io | onchain or relay | memory-capped: `floor(budgetBytes / perMatchBytes) / workers`, min 1 |

  Pass `--mem-budget-mb` and `--per-match-kb` to tune the io-mode cap; defaults
  are 70 % of system RAM and 512 KB/match.

  Explicit `--workers N` or `--concurrency N` always overrides `auto`.

The swarm prints the resolved fleet on every run:

```
[local/offchain] fleet: workers=6 concurrency=2 (auto)
```

## Resources line

Every run prints a `resources:` line after the final result:

```
resources: cpu avg=3.8 cores (380%) peak=5.2 cores (520%), rss avg=312MB peak=401MB, samples=22
```

CPU is derived from `process.cpuUsage()` (user + system, all threads); RSS from
`process.memoryUsage().rss`, sampled every 500 ms. Both avg and peak are
reported for CPU (cores + %) and RSS.

## Container

The `loadbench` service in `docker-compose.yml` (profile `bench`) runs the
bench inside Docker, sharing the same `sui-localnet` network:

```bash
# build the image (once, or after code changes):
docker compose --profile bench build loadbench

# offchain burst — no chain needed:
docker compose --profile bench run --rm loadbench \
  --offchain --channel local --workers auto --duration 10

# onchain — stack must be up first (bun run stack):
docker compose --profile bench run --rm loadbench \
  --channel local --anchor onchain --workers auto --duration 10
```

Key details:

- **CPU/memory limits**: the service defaults to `cpus: "4"` and `memory: 4g`
  via `deploy.resources.limits`. Override per run with
  `docker run --cpus N --memory Ng`.
- **RPC**: `SUI_RPC_URL=http://sui-localnet:9000` is baked into the service
  environment so the container reaches the localnet by name.
- **Secrets**: `.env.local` and `keys.json` are mounted read-only from
  `tools/loadbench/` into the container.
- **`--channel relay` is host-only**: the relay process (`cargo run -p
  tunnel-manager`) is not included in the image. Run relay benchmarks from the
  host with `bun run swarm`.

## Relay specifics

`--channel relay` auto-spawns the relay (`cargo run -p tunnel-manager`) if one
isn't already healthy at `http://127.0.0.1:8080/healthz`, and connects over
`ws://127.0.0.1:8080/v1/mp` (override with `MP_WS_URL`). The relay runs with its
**in-memory store by default** — `REDIS_*` env vars are stripped from the spawned
process. Set `REDIS_CACHE_URL` / `REDIS_PUBSUB_URL` only to benchmark the redis
path.

## Status / known gaps

- **`--channel local` is verified end-to-end** — the golden smoke opens and
  cooperatively settles a real tunnel on the localnet.
- **`--channel relay` has not been run end-to-end.** The relay transport and the
  spawn/health logic are unit-tested, but a live relay-served run hit a relay
  startup env error. If a relay run hangs on health, that's the open gap — check
  the relay's startup env (it inherits `.env.local`) before trusting relay
  numbers.

## Files

| file | role |
|---|---|
| `src/metrics.ts` | percentile / summarize / rate |
| `src/channels/localChannel.ts` | in-process transport pair |
| `src/channels/relayChannel.ts` | headless relay WS transport |
| `src/channels/relayEnvelope.ts` | engine frame ↔ relay payload |
| `src/match.ts` | channel-agnostic match driver (`makeSeats`, `playMatch`) |
| `src/games.ts` | game → kit registry (6 games; drives real FE protocol classes) |
| `src/resourceMonitor.ts` | process CPU + RSS sampling; `resources:` line |
| `src/onchain.ts` | open / settle bookends |
| `src/stack.ts` + `docker-compose.yml` | localnet + valkey + publish + funding |
| `src/relayProcess.ts` | relay spawn + health gate |
| `src/runMatch.ts` | composes channel + anchor into one full match |
| `src/benchGame.ts` | `bench:game` entrypoint |
| `src/swarm.ts` | `swarm` entrypoint (fleet, resource monitor) |
| `src/worker.ts` | per-thread swarm worker |
| `Dockerfile` | `loadbench` container image (bun + frontend kits; no cargo) |

Secrets (`.env.local`, `keys.json`) are localnet-only and gitignored.
