# Scaling PvP Load-Test Hardware

This runbook shows how to turn up AWS hardware for the tic-tac-toe PvP Mode 1 load test. All changes are driven through `infra/Pulumi.dev.yaml` and applied with `pulumi up`.

> **Reminder:** hardware scaling only raises the ceiling. The current `DistributedTunnel` protocol is synchronous (one MOVE in flight at a time), which caps each generator instance at roughly **1,000 actions/sec**. To reach **1,000,000 actions/sec** you must also either (a) pipeline moves in the protocol or (b) run a synthetic relay benchmark. See `docs/reports/2026-06-18-pvp-load-test-bottleneck-analysis.md` for the full analysis.

## Before you start

- Work on the `feat/1m-tps-stakeholder-demo` branch (or the relevant load-test branch).
- Have the AWS profile `AdministratorAccess-129671602944` exported.
- Confirm you have enough AWS service quota for the instance family you choose. The dev account is currently limited to **384 vCPUs**, which allows only two `c7i.48xlarge` instances.

## Quick reference: knobs that matter

| Knob | File | What it controls |
|---|---|---|
| `dopamint:backend-desired-count` | `infra/Pulumi.dev.yaml` | Number of Fargate backend tasks |
| `dopamint:backend-task-cpu` | `infra/Pulumi.dev.yaml` | vCPU per backend task (1024 = 1 vCPU) |
| `dopamint:backend-task-memory` | `infra/Pulumi.dev.yaml` | Memory per backend task in MB |
| `dopamint:cache-node-type` | `infra/Pulumi.dev.yaml` | ElastiCache Redis node type |
| `dopamint:benchmark-instance-type` | `infra/Pulumi.dev.yaml` | EC2 instance type for generators |
| `dopamint:benchmark-max-size` | `infra/Pulumi.dev.yaml` | Maximum benchmark ASG size |
| `dopamint:benchmark-pairs-per-instance` | `infra/Pulumi.dev.yaml` | Pairs each generator instance plays |
| `dopamint:benchmark-duration-ms` | `infra/Pulumi.dev.yaml` | Duration of each generator run |

## Backend (Fargate)

### Valid task sizes

Fargate supports the following CPU/memory combinations. The largest single task is:

```yaml
dopamint:backend-task-cpu: "16384"      # 16 vCPU
dopamint:backend-task-memory: "32768"   # 32 GB (minimum for 16 vCPU)
```

You can also use `memory: "65536"`, `"98304"`, or `"120000"` with 16 vCPU.

### Horizontal scaling

```yaml
dopamint:backend-desired-count: "10"
```

> **PvP caveat:** the design intentionally keeps pairs on the **same backend task** so relay stays in local memory. Raising `desired-count` splits pairs across tasks and forces every MOVE through Redis pub/sub, which usually lowers effective throughput. Prefer fewer, larger tasks until a single-task ceiling is proven.

### Example: maximum single-task backend

```yaml
dopamint:backend-desired-count: "1"
dopamint:backend-task-cpu: "16384"
dopamint:backend-task-memory: "32768"
```

## Redis (ElastiCache)

### Scale the node

```yaml
dopamint:cache-node-type: cache.r6g.4xlarge
```

Larger options:

- `cache.r6g.8xlarge`
- `cache.r6g.12xlarge`
- `cache.r6g.16xlarge`

### Cluster mode

Cluster mode can scale read throughput, but the codebase currently uses a single primary for pub/sub and cache. Enabling it requires changes to key patterns and the `fred` client configuration and is out of scope for this runbook.

## Benchmark fleet (EC2 load generators)

### Instance type

```yaml
dopamint:benchmark-instance-type: c7i.48xlarge
```

Options:

| Type | vCPUs | Memory | Notes |
|---|---|---|---|
| `c7i.48xlarge` | 192 | 384 GB | Default; good balance |
| `c7i.metal-48xl` | 192 | 384 GB | Bare metal; slightly less hypervisor overhead |
| `c7a.48xlarge` | 192 | 384 GB | AMD EPYC; often cheaper per core |
| `c6i.32xlarge` | 128 | 256 GB | Smaller shard if vCPU quota is tight |

### ASG size

```yaml
dopamint:benchmark-max-size: "10"
```

Set this to the largest fleet you want to allow. The fleet starts at `min-size: 0`, so nothing runs until you explicitly set desired capacity.

### Generator sizing

```yaml
dopamint:benchmark-pairs-per-instance: "100"
dopamint:benchmark-duration-ms: "30000"
```

- `pairs-per-instance` controls how many concurrent tic-tac-toe pairs each generator plays.
- `duration-ms` controls how long each run lasts.

Because the protocol is synchronous, adding more pairs per instance does not linearly increase throughput. It is mainly useful to ensure the event loop stays saturated. Profile first before raising it aggressively.

## Step-by-step: apply a new hardware profile

1. **Edit the config**

   ```bash
   cd infra
   code Pulumi.dev.yaml
   ```

2. **Build and preview**

   ```bash
   pnpm build
   pulumi preview
   ```

3. **Apply**

   ```bash
   pulumi up -y
   ```

4. **Wait for the backend to stabilize**

   ```bash
   aws ecs wait services-stable \
     --cluster $(pulumi stack output clusterName) \
     --services $(pulumi stack output backendServiceName)
   ```

5. **Scale the benchmark fleet**

   ```bash
   aws autoscaling set-desired-capacity \
     --auto-scaling-group-name $(pulumi stack output benchmarkAsgName) \
     --desired-capacity 2
   ```

6. **Verify instances are running**

   ```bash
   aws ec2 describe-instances \
     --filters "Name=tag:aws:autoscaling:groupName,Values=$(pulumi stack output benchmarkAsgName)" \
               "Name=instance-state-name,Values=running" \
     --query 'Reservations[*].Instances[*].InstanceId'
   ```

## Running the test after scaling

1. **Upload the current code artifact**

   ```bash
   cd sui-tunnel-ts
   rm -f /tmp/sui-tunnel-ts.zip
   zip -r /tmp/sui-tunnel-ts.zip src package.json pnpm-lock.yaml tsconfig.json pnpm-workspace.yaml
   aws s3 cp /tmp/sui-tunnel-ts.zip s3://$(cd ../infra && pulumi stack output reportsBucketName)/artifact/sui-tunnel-ts.zip
   ```

2. **Broadcast the start signal**

   ```bash
   cd sui-tunnel-ts
   pnpm tsx src/bench/pvpCoordinator.ts broadcast \
     --bucket $(cd ../infra && pulumi stack output reportsBucketName)
   ```

3. **Wait for the run to finish**, then aggregate

   ```bash
   pnpm tsx src/bench/pvpCoordinator.ts aggregate \
     --bucket $(cd ../infra && pulumi stack output reportsBucketName)
   ```

4. **Scale the fleet back to 0**

   ```bash
   aws autoscaling set-desired-capacity \
     --auto-scaling-group-name $(pulumi stack output benchmarkAsgName) \
     --desired-capacity 0
   ```

## AWS quota checklist

| Limit | Current dev value | How to raise |
|---|---|---|
| EC2 vCPUs for `c7i` | 384 | AWS Service Quotas console or support case |
| EC2 vCPUs for `c7a` | check | AWS Service Quotas console or support case |
| Fargate On-Demand vCPUs | check | AWS Service Quotas console |
| ElastiCache nodes per region | check | AWS Service Quotas console |

You need roughly **1,000 `c7i.48xlarge` instances** to hit 1,000,000 actions/sec under the current synchronous protocol, so request quota well in advance if you go the scale-out route.

## Rollback

To return to the baseline dev profile:

```yaml
# infra/Pulumi.dev.yaml
dopamint:backend-desired-count: "10"
dopamint:backend-task-cpu: "4096"
dopamint:backend-task-memory: "8192"
dopamint:cache-node-type: cache.r6g.4xlarge
dopamint:benchmark-instance-type: c7i.48xlarge
dopamint:benchmark-max-size: "10"
dopamint:benchmark-pairs-per-instance: "100"
dopamint:benchmark-duration-ms: "30000"
```

Then run:

```bash
cd infra
pulumi up -y
aws autoscaling set-desired-capacity \
  --auto-scaling-group-name $(pulumi stack output benchmarkAsgName) \
  --desired-capacity 0
```

## See also

- `docs/superpowers/specs/2026-06-18-tictactoe-pvp-mode1-load-test-design.md`
- `docs/superpowers/plans/2026-06-18-tictactoe-pvp-mode1-load-test-plan.md`
- `docs/reports/2026-06-18-pvp-load-test-bottleneck-analysis.md`
