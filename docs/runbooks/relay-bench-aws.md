# Relay TPS benchmark on AWS

Drive genuine two-party Blackjack tunnels through the dev backend's `/v1/mp`
WebSocket relay and Redis path. Each process controls both seats of every
tunnel (self-pairing), so every move traverses the network:
`propose -> backend -> opponent -> ack -> backend -> confirm`.

## Prerequisites

- AWS CLI with the `AdministratorAccess-129671602944` profile configured.
- SSM access to the bench instance: `i-06897ed2c3e759ca9`.
- The dev backend ALB is up: `dopamint-dev-alb-0fac7e0-1152788681.us-east-1.elb.amazonaws.com`.
- Bun >= 1.3 is installed on the bench instance at `$HOME/.bun/bin`.

## Build

From the repo root on the bench instance:

```bash
cd /opt/dopamint/repo-fresh/frontend
bun run build:bench
```

This produces `dist/bench-bun/relayBench.js`.

## Run

```bash
export HOME=/root
export PATH="$HOME/.bun/bin:$PATH"
cd /opt/dopamint/repo-fresh/frontend

BACKEND=http://dopamint-dev-alb-0fac7e0-1152788681.us-east-1.elb.amazonaws.com
TUNNELS=50
DURATION_MS=15000
SHARD=0

timeout 300 bun dist/bench-bun/relayBench.js "$BACKEND" "$TUNNELS" "$DURATION_MS" "$SHARD"
```

Arguments:

1. Backend HTTP base URL.
2. Tunnels per process (pairs created on one socket per side).
3. Benchmark duration in milliseconds.
4. Process / shard index (used to make the per-run game queue unique).

Run via SSM from a local workstation:

```bash
aws ssm send-command \
  --profile AdministratorAccess-129671602944 \
  --region us-east-1 \
  --instance-ids i-06897ed2c3e759ca9 \
  --document-name AWS-RunShellScript \
  --parameters "commands=\"export HOME=/root; export PATH=\\\"\\$HOME/.bun/bin:\\$PATH\\\"; cd /opt/dopamint/repo-fresh/frontend; timeout 300 bun dist/bench-bun/relayBench.js http://dopamint-dev-alb-0fac7e0-1152788681.us-east-1.elb.amazonaws.com 50 15000 0 > /tmp/relayBench_50.log 2>&1; cat /tmp/relayBench_50.log\""
```

## Output

Each shard prints progress to stderr and a final result line to stdout:

```
PROCESS=0 TUNNELS=50 STEPS_PER_S=1490 PEAK_TPS=2000 TOTAL_STEPS=22445 ERRORS=0
```

- `STEPS_PER_S`: average co-signed state transitions per second.
- `PEAK_TPS`: highest 100 ms sample.
- `TOTAL_STEPS`: transitions completed across all tunnels.
- `ERRORS`: tunnels that hit a timeout or exception.

## Recent results (dev environment)

| Tunnels | Duration | STEPS_PER_S | PEAK_TPS | TOTAL_STEPS | ERRORS |
|--------:|---------:|------------:|---------:|------------:|-------:|
| 1       | 5000 ms  | 54          | 100      | 270         | 0      |
| 10      | 10000 ms | 456         | 850      | 4582        | 0      |
| 50      | 15000 ms | 1490        | 2000     | 22445       | 0      |
| 100     | 20000 ms | 1643        | 1960     | 33018       | 0      |

Backend config for these runs: single Fargate task, Redis cache + pub/sub.

## Troubleshooting

- **Hang at matchmaking**: the bench now starts both `quickMatch` promises
  before awaiting either; awaiting the first join before starting the second
  deadlocks because A cannot be paired until B joins.
- **`bytesToHex is not a function`**: use `core.toHex` from `sui-tunnel-ts`;
  `bytesToHex` lives in the top-level utils namespace, not `core`.
- **`invalid hex address` tunnelId error**: the wire format requires a valid
  Sui address as `tunnelId`; the bench derives one deterministically from the
  match id.
- **`onPeer` messages dropped**: `MpClient.channel` keeps only one callback;
  the bench uses a single dispatcher per channel that routes by message type.
