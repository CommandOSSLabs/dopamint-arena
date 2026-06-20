# Runbook: Off-chain TPS benchmark on AWS

> **Goal:** Run the canonical game-bot-kit off-chain TPS benchmark on the existing AWS benchmark fleet, end-to-end, with full dual-sign/verify and no on-chain traffic.

This runbook assumes you have **zero prior knowledge** of the repo. It covers the AWS setup check, code deployment, running the benchmark, monitoring it, and reading the results.

---

## 1. What you are running

The benchmark (`frontend/src/bench/offchainTps.ts`) does the following:

- Uses one of the frontend game kits (`tictactoe` or `blackjack`) from `GAME_KITS`.
- Opens **N concurrent off-chain tunnels** in self-play mode.
- For every state transition, both parties **sign** the canonical `state_update` message and, in `full` mode, **verify** both signatures.
- Counts fully signed/verified transitions per second.
- Does **not** hit Sui on-chain (no open/deposit/settle txs).

The kit contract guarantees that the same protocol classes and wire format the human `usePvp*` hooks use are the ones being exercised.

---

## 2. Prerequisites

### 2.1 Local tooling

Install on your laptop:

- `git`
- `node` (>= 20) and `pnpm`
- AWS CLI v2
- Pulumi CLI (only if you plan to change the fleet size)

### 2.2 AWS access

You need an AWS profile that can:

- Call `sts:GetCallerIdentity`
- Read EC2 / AutoScaling / CloudWatch
- Run SSM commands on the benchmark instances (`ssm:SendCommand`, `ssm:ListCommandInvocations`)

The profile used for this runbook is named `AdministratorAccess-129671602944`. If yours is different, replace it in every command.

### 2.3 Verify access

```bash
aws sts get-caller-identity --profile AdministratorAccess-129671602944
```

You should see an ARN and account `129671602944`.

### 2.4 Verify the benchmark fleet exists

```bash
aws autoscaling describe-auto-scaling-groups \
  --profile AdministratorAccess-129671602944 \
  --region us-east-1 \
  --query 'AutoScalingGroups[?contains(Tags[?Key==`Name`].Value, `dopamint-dev-benchmark`)].{Name:AutoScalingGroupName,Min:MinSize,Max:MaxSize,Desired:DesiredCapacity,Instances:Instances}' \
  --output table
```

You should see an ASG named like `dopamint-dev-benchmark-<hash>` with `c7i.48xlarge` instances in `InService` state. The dev stack uses `min=2 max=2` by default.

---

## 3. One-time repo setup

Clone the repo and switch to the benchmark branch:

```bash
git clone https://github.com/CommandOSSLabs/dopamint-arena.git
cd dopamint-arena
git checkout feat/offchain-tps-bench
```

No local install is required to run on AWS, but it is useful for local smoke tests:

```bash
cd frontend
pnpm install
pnpm run typecheck
```

---

## 4. Deploy the latest benchmark code to the AWS instances

The instances already have a shallow clone at `/opt/dopamint/repo`. You only need to fetch the branch you want and reset the working tree.

### 4.1 Get the instance IDs

```bash
aws autoscaling describe-auto-scaling-groups \
  --profile AdministratorAccess-129671602944 \
  --region us-east-1 \
  --query 'AutoScalingGroups[?contains(Tags[?Key==`Name`].Value, `dopamint-dev-benchmark`)].Instances[*].InstanceId' \
  --output text
```

Save the two IDs. In this runbook they are:

- `i-07ab8681b54a8c1e9`
- `i-089589b8ee6fab47c`

### 4.2 Pull the benchmark branch and install deps on every instance

Run this SSM command once. It updates the shallow clone and installs the frontend dependencies:

```bash
aws ssm send-command \
  --profile AdministratorAccess-129671602944 \
  --region us-east-1 \
  --instance-ids i-07ab8681b54a8c1e9 i-089589b8ee6fab47c \
  --document-name AWS-RunShellScript \
  --parameters commands='["cd /opt/dopamint/repo && git fetch --depth 1 origin feat/offchain-tps-bench && git reset --hard FETCH_HEAD && cd frontend && pnpm install --frozen-lockfile"]'
```

Save the returned `CommandId` and poll until both instances report `Success`:

```bash
aws ssm list-command-invocations \
  --profile AdministratorAccess-129671602944 \
  --region us-east-1 \
  --command-id <COMMAND_ID> \
  --details \
  --output table \
  --query 'CommandInvocations[*].[InstanceId,Status,CommandPlugins[0].Output]'
```

This install step only needs to be repeated when:

- the benchmark code changes, or
- the frontend `pnpm-lock.yaml` changes.

---

## 5. Build and run the benchmark

### 5.1 Choose your parameters

The benchmark CLI supports these flags:

| Flag | Meaning | Example |
|---|---|---|
| `--game` | `tictactoe` or `blackjack` | `--game blackjack` |
| `--tunnels` | Concurrent tunnels per instance | `--tunnels 1000` |
| `--workers` | Worker threads per instance | `--workers 180` |
| `--duration` | Run for N milliseconds | `--duration 10000` |
| `--updates-per-tunnel` | Stop after N transitions per tunnel | `--updates-per-tunnel 1000` |
| `--sign-mode` | `full` (sign+verify), `sign-only`, or `none` | `--sign-mode full` |
| `--json` | Write a JSON report to a file | `--json /tmp/report.json` |

Use **either** `--duration` **or** `--updates-per-tunnel`. If neither is supplied it defaults to 100 updates per tunnel.

For a 5M-TPS oriented test, start with:

- `blackjack` (the faster game)
- `full` sign mode (the honest metric)
- 1000–5000 tunnels
- 180 workers (each `c7i.48xlarge` has 192 vCPUs)
- 10–20 second duration

### 5.2 Build + run via SSM

The benchmark must be bundled with esbuild on the instance because Node worker threads cannot reliably resolve the frontend `tsconfig` path aliases at runtime.

```bash
aws ssm send-command \
  --profile AdministratorAccess-129671602944 \
  --region us-east-1 \
  --instance-ids i-07ab8681b54a8c1e9 i-089589b8ee6fab47c \
  --document-name AWS-RunShellScript \
  --parameters commands='["cd /opt/dopamint/repo && git fetch --depth 1 origin feat/offchain-tps-bench && git reset --hard FETCH_HEAD && cd frontend && ./node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild src/bench/offchainTps.ts src/bench/offchainTpsWorker.ts --bundle --platform=node --format=esm --outdir=dist/bench --tsconfig=tsconfig.json && node dist/bench/offchainTps.js --game blackjack --tunnels 1000 --duration 10000 --workers 180 --sign-mode full --json /tmp/bench-blackjack-full.json"]'
```

Save the `CommandId`.

### 5.3 Monitor progress

Poll until both instances are no longer `InProgress`/`Pending`:

```bash
for i in {1..90}; do
  echo "--- poll $i ---"
  aws ssm list-command-invocations \
    --profile AdministratorAccess-129671602944 \
    --region us-east-1 \
    --command-id <COMMAND_ID> \
    --details \
    --output text \
    --query 'CommandInvocations[*].[InstanceId,Status]'

  statuses=$(aws ssm list-command-invocations \
    --profile AdministratorAccess-129671602944 \
    --region us-east-1 \
    --command-id <COMMAND_ID> \
    --query 'CommandInvocations[*].Status' \
    --output text 2>/dev/null)
  if ! echo "$statuses" | grep -qE 'InProgress|Pending'; then
    break
  fi
  sleep 10
done
```

A 10-second run usually finishes in 30–60 seconds including bundle time and worker startup.

### 5.4 Read the results

```bash
aws ssm list-command-invocations \
  --profile AdministratorAccess-129671602944 \
  --region us-east-1 \
  --command-id <COMMAND_ID> \
  --details \
  --output text \
  --query 'CommandInvocations[*].[InstanceId,Status,CommandPlugins[0].Output]'
```

Each instance prints a human-readable report and writes JSON to `/tmp/bench-blackjack-full.json`.

---

## 6. Aggregate results across instances

The benchmark is per-instance. To get the fleet total, add the `effective TPS` and `interactions` lines from each instance.

You can also read the JSON files:

```bash
aws ssm send-command \
  --profile AdministratorAccess-129671602944 \
  --region us-east-1 \
  --instance-ids i-07ab8681b54a8c1e9 i-089589b8ee6fab47c \
  --document-name AWS-RunShellScript \
  --parameters commands='["cat /tmp/bench-blackjack-full.json"]'
```

Then sum `avgTps` and `totalInteractions`.

---

## 7. Check instance specs and CPU

### 7.1 Instance type details

```bash
aws ec2 describe-instance-types \
  --profile AdministratorAccess-129671602944 \
  --region us-east-1 \
  --instance-types c7i.48xlarge \
  --query 'InstanceTypes[0].{Type:InstanceType,Vcpus:Vcpus,MemoryMiB:MemoryInfo.SizeInMiB,ClockGhz:ProcessorInfo.SustainedClockSpeedInGhz,Network:NetworkInfo.NetworkPerformance}' \
  --output table
```

### 7.2 CloudWatch CPU during the run

```bash
for id in i-07ab8681b54a8c1e9 i-089589b8ee6fab47c; do
  echo "--- $id ---"
  aws cloudwatch get-metric-statistics \
    --profile AdministratorAccess-129671602944 \
    --region us-east-1 \
    --namespace AWS/EC2 \
    --metric-name CPUUtilization \
    --dimensions Name=InstanceId,Value=$id \
    --statistics Average Maximum \
    --start-time 2026-06-20T10:00:00Z \
    --end-time   2026-06-20T12:00:00Z \
    --period 60 \
    --output table
done
```

Adjust the timestamps to the actual test window. Note that the default 60-second CloudWatch granularity averages a short benchmark over a full minute, so the reported percentage will look low unless the run is long.

---

## 8. Scaling the fleet

The dev stack is capped at **2 benchmark instances** by default. To hit higher TPS you must raise the ASG size.

### Option A: quick ASG change (not persistent)

```bash
aws autoscaling update-auto-scaling-group \
  --profile AdministratorAccess-129671602944 \
  --region us-east-1 \
  --auto-scaling-group-name dopamint-dev-benchmark-<hash> \
  --min-size 6 --max-size 6 --desired-capacity 6
```

Wait for new instances to become `InService`, then run the benchmark against all instance IDs.

### Option B: persistent Pulumi change

Edit `infra/Pulumi.dev.yaml`:

```yaml
dopamint:benchmark-min-size: "6"
dopamint:benchmark-max-size: "6"
```

Then:

```bash
cd infra
pulumi up --stack dev
```

---

## 9. Local smoke test (optional)

Before running on AWS, verify the benchmark works locally:

```bash
cd frontend
node --import tsx src/bench/offchainTps.ts \
  --game blackjack --tunnels 100 --duration 3000 --workers 8 --sign-mode full
```

Expected output shape:

```
Off-chain kit TPS benchmark
  game           : blackjack
  config         : 100 concurrent tunnels, 8/12 workers, signMode=full
  elapsed        : 3.08s
  interactions   : 165,571
  effective TPS  : avg 53,844  peak 53,844  (per-core 6,731)
  signatures/sec : 107,688
  verifies/sec   : 107,688
  bandwidth      : 6,461,307 B/s (120 B/update)
```

---

## 10. Troubleshooting

### `Cannot find package '@/agent' imported from ...offchainTpsWorker.ts`

The worker thread cannot resolve the frontend `tsconfig` path aliases. **Fix:** bundle with esbuild before running, as shown in step 5.2.

### `fatal: refusing to fetch into branch ... checked out`

The instance has a shallow clone. Always use:

```bash
git fetch --depth 1 origin feat/offchain-tps-bench && git reset --hard FETCH_HEAD
```

not `git pull`.

### `esbuild` binary not found

Find it dynamically on the instance:

```bash
ESBUILD=$(find node_modules/.pnpm -path '*esbuild*/bin/esbuild' -type f | head -1)
$ESBUILD ...
```

### SSM command times out

- Increase `--timeout-seconds` (default is 3600).
- Reduce `--tunnels` or `--duration` for a quicker sanity check.

### Results are much lower than expected

- Blackjack is the faster game; tictactoe is ~20× slower in this benchmark.
- Full sign mode is ~7× slower than `none`.
- Make sure you are not using a `tictactoe` kit with a very low `maxGames` value; short sessions spend more time opening new tunnels.

---

## 11. Files involved

- Benchmark code: `frontend/src/bench/offchainTps.ts`, `frontend/src/bench/offchainTpsWorker.ts`
- Kits used: `frontend/src/agent/gameKit.ts`, `frontend/src/agent/games/{blackjack,ticTacToe}/kit.ts`
- Protocols exercised: `frontend/src/games/blackjack/app/lib/bjBetProtocol.ts`, `frontend/src/games/ticTacToe/packages/shared/src/ttt/multiGameProtocol.ts`
- Infra fleet: `infra/src/components/BenchmarkFleet.ts`, `infra/Pulumi.dev.yaml`
