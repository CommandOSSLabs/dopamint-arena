# Running a Swarm with fleet-superx

`fleet-superx` runs staged **open → play → settle** swarms under a supervisor
daemon. This guide is task-oriented: bring the daemon up, start a run in each
mode, watch it live, stop it gracefully, and wire the Sui account pool. For how
and why the subsystem works, see the [design doc](../design/2026-07-02-fleet-superx.md)
and [ADR-0029](../decisions/0029-fleet-superx-staged-swarm-supervisor.md).

One binary carries every subcommand: `daemon | start | stop | ls | watch` for
operators, plus a hidden `run-swarm` the daemon spawns per swarm.

## 1. Bring the daemon up

```bash
cargo run -p fleet-superx -- daemon
```

Flags:

- `--socket PATH` — Unix control socket. Default:
  `$XDG_RUNTIME_DIR/fleet-superx.sock`, else `/tmp/fleet-superx.sock`.
- `--ws HOST:PORT` — also serve the control plane over WebSocket (same JSON).
- `--sink-addr HOST:PORT` — bind the localhost heartbeat sink so `watch` shows
  live in-flight progress (use `127.0.0.1:0` for an ephemeral port in tests).
- `--accounts-file PATH` — JSON pool of Sui funding slots (see §5). A
  missing/malformed file aborts startup.

The client subcommands connect to the same default socket with no flags, or to
`--connect <PATH>` for a Unix socket, or `--connect ws://HOST:PORT` for WebSocket.

## 2. Start a run

```bash
# replicate: each of 3 swarms runs the full per-swarm config (3 × 4 = 12 tunnels)
fleet-superx start --mode replicate --swarms 3 --tunnels 4 \
  --protocol blackjack.v2 --scenario golden --anchor memory --for 30s
```

`start` returns a `run_id` immediately; the run executes in the background.

Key flags (`start --help` for the full list):

| Flag | Meaning |
|---|---|
| `--mode` | `replicate` \| `distribute` \| `sequential` (default `replicate`) |
| `--swarms N` | number of swarm subprocesses |
| `--tunnels N` | per-swarm tunnel count (split across swarms in `distribute`) |
| `--protocol` | e.g. `blackjack.v2`, `payments.v1` |
| `--scenario` | `golden` (fixed seed, reproducible) or `varied` |
| `--anchor` | `memory` or `sui-sponsored` |
| `--for 30s` / `--until-stop` | wall-clock budget (`30s`/`10m`/`1h`) or run until `stop` |
| `--open-cohort` / `--settle-cohort` | Layer-1 concurrency cap (unset = no cap) |
| `--open-spacing-ms` / `--settle-spacing-ms` | delay between cohorts |
| `-- <extra>` | args forwarded verbatim to each `run-swarm` (e.g. `--sui-*`) |

### Spawn modes

- **replicate** — every swarm runs the same config; `N` swarms × `tunnels` each.
- **distribute** — the **tunnel count** is split across swarms (remainder to low
  swarms); per-tunnel caps like `--moves` pass through unchanged. Total tunnels
  are conserved across the fleet.
- **sequential** — same mapping as replicate, but one swarm at a time.

### Two batching layers

`--open-cohort`/`--settle-cohort` are **Layer 1**: how many tunnels fly
concurrently (anchor-agnostic). The Sui `--sui-open-batch`/`--sui-settle-batch`
knobs are **Layer 2**: how many the Sui anchor packs into one PTB. They compose
for `sui-sponsored`; only Layer 1 applies to `memory`. See the design doc's
batching table.

## 3. Watch live

```bash
fleet-superx watch <run_id>
```

Streams state transitions and a live aggregate (folded from swarm heartbeats via
the daemon's `--sink-addr`) until the run ends with `Ended`. Without a sink the
aggregate first appears at completion (the merged rollup).

## 4. List and stop

```bash
fleet-superx ls                 # every run + state + aggregate-so-far
fleet-superx stop <run_id>      # graceful drain (SIGTERM each swarm)
```

`stop` is graceful: each swarm finishes its current phase and settles — there are
never half-open tunnels. The run lands in `Finished` with a merged aggregate.

## 5. Sui account/gas pool (`sui-sponsored`)

Concurrent sponsored swarms must fund from **disjoint** accounts so their opens
never contend on shared coins. Provide a pool to the daemon:

```jsonc
// accounts.json — one slot per concurrent swarm you intend to run
[
  { "address": "0x…a", "key_ref": "suiprivkey1…", "gas_coin_ids": ["0x…c1"] },
  { "address": "0x…b", "key_ref": "suiprivkey1…", "gas_coin_ids": ["0x…c2"] }
]
```

```bash
fleet-superx daemon --accounts-file accounts.json --sink-addr 127.0.0.1:9099
```

Each `sui-sponsored` run checks out one slot per swarm; if the pool cannot cover
the swarm count the run is **rejected** (no overcommit). Slots return to the pool
when the run finishes.

## 6. Live-Sui smoke (manual, not CI)

There is no live Sui node in CI, so the sponsored path is exercised by hand. With
a funded `accounts.json` and a reachable node/backend:

```bash
fleet-superx daemon --accounts-file accounts.json --sink-addr 127.0.0.1:9099 &

fleet-superx start --mode distribute --anchor sui-sponsored \
  --swarms 2 --tunnels 8 --protocol payments.v1 --scenario golden --for 2m \
  --open-cohort 4 --open-spacing-ms 250 \
  --settle-cohort 4 --settle-spacing-ms 250 \
  -- \
    --sui-rpc-url https://fullnode.testnet.sui.io:443 \
    --sui-backend-url https://<sponsor-backend> \
    --sui-package-id 0x<pkg> \
    --sui-funder-priv-key suiprivkey1… \
    --sui-open-batch 8 --sui-settle-batch 8

fleet-superx watch <run_id>
```

Expect: the daemon logs one slot checked out per swarm; `watch` shows the open
wave, then play, then the settle wave pacing to the cohort; `ls` ends `finished`
with `tunnels_settled == 16`. The Layer-1 cohorts shape in-flight concurrency
while the `--sui-*-batch` knobs pack each PTB; both are visible in the settle
pacing.
