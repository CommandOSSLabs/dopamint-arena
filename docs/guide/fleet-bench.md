# Fleet Bench Run Control

`fleet-bench` is a throughput benchmark for tunnel lifecycles. It tries to keep
the requested number of tunnels active, lets protocols continue legally for as
long as they can, and only closes tunnels at protocol-declared close boundaries.

## Core Model

A tunnel lifecycle is:

1. Open the tunnel.
2. Play protocol moves.
3. Settle the latest valid state.

`--tunnel-concurrency` controls how many of these lifecycles may be in flight at
once. When a tunnel naturally reaches a terminal state before the benchmark stop
signal, the bench settles it and launches another tunnel so the pool stays full.

The benchmark is optimized for throughput:

- use protocol-legal minimum economics in fleet-bench adapters where possible;
- allow each tunnel to run for as long as protocol invariants permit;
- when a tunnel cannot legally continue, close it and refill the pool until the
  run stop signal is reached;
- never force a close in the middle of a protocol episode.

## Flag Combination Semantics

### `--tunnel-concurrency N`

Keeps at most `N` tunnel lifecycles active. The initial `N` tunnels are launched
immediately. If one finishes before the run stop signal, another tunnel is
launched to replace it.

`--tunnel-concurrency auto` resolves to the worker count.

### `--duration T`

Measures the active play window, not the full process wall time. The timer starts
when the first tunnel reaches the move loop. Opening and settling are still
included in wall-clock elapsed metrics, but they do not consume the requested
play duration.

When the duration expires:

1. stop launching new tunnels;
2. request graceful close for active tunnels;
3. continue playing each active tunnel until it reaches a legal close boundary;
4. settle the active tunnels.

### `--moves N`

Sets a global graceful move target across the benchmark run. It is not a
per-tunnel move cap.

When completed tunnel samples report at least `N` total committed moves:

1. stop launching new tunnels;
2. request graceful close for active tunnels;
3. let active tunnels pass `N` if needed to reach a legal close boundary;
4. settle the active tunnels.

### `--moves max`

Disables the global move target. The run is then duration-led unless the
protocols naturally exhaust their legal continuation conditions. Internally,
per-tunnel move allowance is effectively unbounded for practical benchmark runs.

## Combined Behavior

| Flags | Behavior |
| --- | --- |
| `--duration 120 --tunnel-concurrency 100` | Keep 100 live tunnel lifecycles. Refill naturally completed tunnels until 120 seconds of play time elapse, then gracefully drain active tunnels. |
| `--moves 1000000 --tunnel-concurrency 100` | Keep 100 live tunnel lifecycles until completed samples reach at least 1,000,000 moves, then gracefully drain active tunnels. |
| `--duration 120 --moves 1000000 --tunnel-concurrency 100` | The first observed stop signal wins: either duration expires or completed samples reach the move target. Then no new tunnels are launched and active tunnels drain gracefully. |
| `--duration 120 --moves max --tunnel-concurrency 100` | Pure duration run. Keep refilling until 120 seconds of play time elapse, then gracefully drain active tunnels. |

## Protocol Close Boundaries

Fleet bench does not invent an invalid stop state. A tunnel may close only when
the protocol says it can gracefully close:

- terminal state;
- episode or round boundary for finite games;
- latest valid state for naturally open-ended protocols.

For finite economic games, a tunnel can still close early if the state cannot
legally continue, for example when a side cannot fund the next minimum bet. The
benchmark should make those cases rare by using minimum legal stakes or wagers
where that is a fleet-bench adapter choice, not by weakening protocol rules.

## Metrics Notes

The report separates several time windows:

- wall elapsed includes open, play, settle, and chain wait time;
- play-only throughput uses the active move-production window;
- open and settle throughput use their own active windows;
- setup overhead is non-play tunnel time as a share of tunnel end-to-end time.

This means a duration-led benchmark can report a wall elapsed time larger than
`--duration`, because graceful draining and on-chain settlement still happen
after the move window has stopped accepting new work.
