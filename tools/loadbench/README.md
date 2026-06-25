# loadbench

A **bun** package that benchmarks real off-chain games on the `sui-tunnel-ts`
engine. One match opens and cooperatively settles a real tunnel; the many moves
between those bookends are the throughput. It measures two things:

- **aggregate move-TPS** (default) — many concurrent matches across games.
- **per-game latency** (`--game <name>`) — open → play → settle, with per-move p50/p99.

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

Moves stay off-chain in both anchor modes. `--offchain --channel local` needs no
infra at all — start there.

## Prerequisites

- `bun`, `docker`, `cargo`, and the `sui` CLI on PATH.
- For `--anchor onchain` or `--channel relay`: run `bun run stack` once (below).
- Apple Silicon: the compose file uses an arm64 Sui image; first relay run
  compiles `tunnel-manager` via `cargo` and can take a few minutes.

## Env isolation

Each worktree or git branch runs its own **isolated stack** — no port conflicts,
no shared state, and parallel benches are fully independent.

**Env name:** Set `$LOADBENCH_ENV` to a stable name, or the system will use the
slugified git branch name (e.g. `feat-foo` from `feat/foo`), or fall back to
`default`. This name is used to:
- Name the Docker Compose project (`loadbench-<name>`).
- Route per-env Sui config to `~/.loadbench/<name>/sui_config`.
- Determine host ports via deterministic allocation (see below).

**Ports (deterministic, non-overlapping):** Each env's stack runs on an isolated
port band:
```
rpc    = 9000 + slot
valkey = 9200 + slot
relay  = 9300 + slot
faucet = 9400 + slot
```
where `slot = hash(<env-name>) % 100`, and `<env-name>` is the resolved env name
(after `$LOADBENCH_ENV` → slugified-branch → `default` fallback). The actual RPC
and relay URLs are written to `.env.local` on stack bring-up — read them from
there rather than assuming `:9000`. If two active envs collide on a port (rare;
the hash spreads to 100 slots), `bun run stack` will fail with "port already
allocated" — set `LOADBENCH_ENV` to a different name to move one env to a new slot.

**Parallel stacks:** Two worktrees can run `bun run stack` and benches
simultaneously; each publishes under its own `SUI_CONFIG_DIR` and never touches
the global `~/.sui`, so there is no contention.

**Container joins the current env:** `bun run bench --container …` automatically
uses the same env name, project, and ports as the host from which you invoke it.
No additional setup needed.

**Multi-arch support and host-`sui` fallback:** The localnet image runs on both
arm64 and x86_64. The host-`sui` fallback (when Docker is unavailable) is
single-stack and uses the default `9000`/`9123` ports.

**Migration from single stack:** If you had a legacy single-stack setup before
this change, the old stack runs under the Docker project `loadbench` (no env
suffix). Remove it with (from `tools/loadbench/`):
```bash
docker compose -f docker-compose.yml -p loadbench down
```
New stacks use per-env names (`loadbench-<name>`). Sui configs now live in
`~/.loadbench/` (per-env subdirs) instead of the global `~/.sui`.

## Commands

All commands run from `tools/loadbench/`.

### `bun run stack` — stand up the local infra (once per session)

Brings up Docker compose (Sui localnet, Valkey, and relay on env-derived ports),
waits for health, publishes the `sui_tunnel` Move package, funds a settler + N
bench keys via the faucet, and writes `.env.local` + `keys.json` (both
gitignored). The actual RPC and relay URLs are recorded in `.env.local`; read
them from there. Set `N` to change the key count (default 8):

```bash
bun run stack          # default 8 keys
N=16 bun run stack     # more keys
```

Re-run only after `docker compose down` or when you want a fresh genesis. Check
state with `docker compose ps` (both services should be `healthy`).

### `bun run bench [flags]` — run the benchmark

`bun run bench` is the single run entry point. It operates in two modes
selected by flag:

- **Default (no `--game`)**: aggregate move-TPS swarm — many concurrent matches
  across games, prints `tunnels settled/s`.
- **`--game <name>`**: per-game latency — open → play → settle for the named
  game, prints per-move p50/p99. Use `--game all` to run every playable game.

**Defaults:** `--channel local`, `--anchor onchain`, swarm mode.

The bench performs **no infra orchestration**. Bring infra up yourself (`bun run
stack` for a local one), then point `bench` at it via flags or `.env.local`.

#### Infra by flag

Infra values are resolved in this order: **flag → `.env.local` → process env**.
`.env.local` is written by `bun run stack` and holds the localnet coordinates
after a successful stack bring-up.

- **Onchain**: `--rpc-url <url>`, `--package-id <id>`, `--settler-key <key>`
- **Relay**: `--relay-url ws://…` connects to a relay you are already running.
  Omitted ⇒ the relay auto-spawns (`cargo run -p tunnel-manager`, in-memory
  store) as before.

#### Worked examples

```bash
# pure engine burst — no infra (start here):
bun run bench --offchain --channel local --duration 10

# one game's latency, no infra:
bun run bench --game blackjack --offchain --channel local --matches 50

# onchain swarm against a local stack you brought up with `bun run stack`:
bun run bench --channel local --matches 40

# onchain against an explicit endpoint (port comes from .env.local):
source .env.local
bun run bench --channel local --rpc-url "$SUI_RPC_URL" \
  --package-id 0x… --settler-key suiprivkey… --matches 40

# relay against a relay you're running:
bun run bench --channel relay --relay-url ws://127.0.0.1:8080/v1/mp --duration 10

# isolated in a container, capped at 8 cores / 8 GB:
bun run bench --container --cpus 8 --memory 8g --offchain --channel local --duration 10
```

### `bun test` — the unit + smoke suite

```bash
bun test
```

The on-chain smoke (`src/smoke.test.ts`) auto-runs when `.env.local` has a
published package (i.e. after `bun run stack`); otherwise it skips, keeping the
suite green with no infra. The offchain smoke always runs.

## Flags

All flags hang off `bun run bench`.

| flag | swarm | latency | notes |
|---|---|---|---|
| `--game <name\|all>` | — | yes | selects latency mode; one of the playable games or `all` |
| `--games a,b,c` | yes | — | comma-separated game filter; defaults to all |
| `--channel local\|relay` | yes | yes | default `local` |
| `--offchain` / `--anchor offchain\|onchain` | yes | yes | default `onchain` |
| `--rpc-url <url>` | yes | yes | onchain: Sui RPC endpoint |
| `--package-id <id>` | yes | yes | onchain: published tunnel package id |
| `--settler-key <key>` | yes | yes | onchain: settler private key |
| `--relay-url <ws-url>` | yes | yes | relay: WS URL of a running relay |
| `--matches N` | yes | yes | stop after N matches (swarm) / run N matches (latency) |
| `--concurrency N` | yes | yes | async matches in flight per worker |
| `--duration S` | yes | — | swarm: stop after S seconds |
| `--workers N\|auto` | yes | — | OS worker threads (true multi-core) |
| `--mem-budget-mb N` | yes | — | memory cap for auto concurrency (io mode) |
| `--per-match-kb N` | yes | — | per-match RSS estimate for auto concurrency |
| `--container` | yes | yes | re-exec this run inside the `loadbench` compose service |
| `--cpus N` | yes | yes | override compose CPU limit for `--container` run |
| `--memory Ng` | yes | yes | override compose memory limit for `--container` run |

**Playable games:** `ticTacToe, blackjack, battleship, quantumPoker, bombIt,
cross`. These map to the real frontend kit classes; any other name is rejected
with a message listing the valid options.

## Fleet sizing (`--workers` and `--concurrency`)

In swarm mode, `bench` distributes work across a fleet of OS worker threads:

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

`--container` re-execs the identical `bun run bench` invocation inside the
`loadbench` compose service (profile `bench`), sharing the same `sui-localnet`
network. `--cpus N` and `--memory Ng` override the compose CPU/memory limits
for that run. Infra flags (`--rpc-url`, `--package-id`, `--settler-key`) pass
through as `-e` env vars into the container. `.env.local` and `keys.json` are
mounted read-only from `tools/loadbench/`.

```bash
# build the image (once, or after code changes):
docker compose --profile bench build loadbench

# offchain burst inside the container:
bun run bench --container --offchain --channel local --duration 10

# onchain inside the container (stack must be up first):
bun run bench --container --channel local --matches 40

# cap at 8 cores / 8 GB for this run:
bun run bench --container --cpus 8 --memory 8g --offchain --channel local --duration 10
```

Key details:

- **CPU/memory limits**: the service defaults to `cpus: "4"` and `memory: 4g`
  via `deploy.resources.limits`; override per run with `--cpus` / `--memory`.
- **RPC**: the service resolves the env-derived RPC URL from the host's `.env.local`
  so the container reaches the localnet on the same env's port. The container
  and host share the same Docker network and env name.
- **`--channel relay` is host-only**: the relay process (`cargo run -p tunnel-manager`) is not included in the image, so relay benchmarks must run from the host without `--container`.

## Relay specifics

`--relay-url ws://…` connects `bench` to a relay you are already running.

Without `--relay-url`, `--channel relay` auto-spawns the relay (`cargo run -p
tunnel-manager`) if one isn't already healthy at `http://127.0.0.1:8080/healthz`,
and connects over `ws://127.0.0.1:8080/v1/mp`. The relay runs with its
**in-memory store by default** — `REDIS_*` env vars are stripped from the
spawned process. Set `REDIS_CACHE_URL` / `REDIS_PUBSUB_URL` only to benchmark
the redis path.

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
| `src/benchGame.ts` | latency mode (`--game`) entrypoint |
| `src/swarm.ts` | swarm entrypoint (fleet, resource monitor) |
| `src/worker.ts` | per-thread swarm worker |
| `src/cli.ts` | `bun run bench` CLI entry; routes to swarm or latency mode |
| `Dockerfile` | `loadbench` container image (bun + frontend kits; no cargo) |

Secrets (`.env.local`, `keys.json`) are localnet-only and gitignored.
