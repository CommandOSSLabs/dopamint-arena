# Docker benchmark runner implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a reproducible, resource-pinned Docker container that builds and runs `frontend/src/bench/solo-local.ts` for all games.

**Architecture:** Single-stage Docker image based on `oven/bun:1.3.5` with Node 24 and pnpm; copies `sui-tunnel-ts/` and `frontend/` into the image, installs dependencies, builds bench bundles with `bun build --target bun`, and runs the benchmark. Resource limits (4 CPUs / 8 GB) are declared in a compose file.

**Tech Stack:** Bun 1.3.5, Node 24, pnpm 11.6.0, Docker Compose.

---

### Task 1: Fix `build:bench` to produce Bun-compatible bundles

**Files:**
- Modify: `frontend/package.json`

The current esbuild ESM bundles mix `import "node:crypto"` with CommonJS helpers and crash under Bun. Replace the script with a `bun build` invocation that respects the frontend `tsconfig.json` path aliases.

- [ ] **Step 1: Update the build:bench script**

```json
"build:bench": "bun build src/bench/offchainTps.ts src/bench/offchainTpsWorker.ts src/bench/solo.ts src/bench/solo-local.ts --outdir=dist/bench --target=bun --tsconfig-override=tsconfig.json"
```

- [ ] **Step 2: Verify the new command locally**

Run:
```bash
cd frontend
rm -rf dist/bench
pnpm build:bench
bun dist/bench/solo-local.js --duration 3000 --games tictactoe
```

Expected: no `node:crypto` ESM/CJS error; tictactoe benchmark reports a non-zero TPS.

- [ ] **Step 3: Commit**

```bash
git add frontend/package.json
git commit -m "build(frontend): use bun build for bench bundles"
```

---

### Task 2: Create the benchmark Dockerfile

**Files:**
- Create: `frontend/bench.Dockerfile`

- [ ] **Step 1: Write the Dockerfile**

```dockerfile
FROM oven/bun:1.3.5

# Install Node 24 and pnpm to match the host toolchain.
RUN apt-get update \
 && apt-get install -y curl ca-certificates \
 && curl -fsSL https://deb.nodesource.com/setup_26.x | bash - \
 && apt-get install -y nodejs \
 && npm install -g pnpm@11.6.0 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency manifests first for layer caching.
COPY sui-tunnel-ts/package.json sui-tunnel-ts/pnpm-lock.yaml ./sui-tunnel-ts/
COPY frontend/package.json frontend/pnpm-lock.yaml ./frontend/

# Install dependencies in both packages.
RUN cd sui-tunnel-ts && pnpm install --frozen-lockfile
RUN cd frontend && pnpm install --frozen-lockfile

# Copy the rest of the source.
COPY sui-tunnel-ts/ ./sui-tunnel-ts/
COPY frontend/ ./frontend/

WORKDIR /app/frontend

# Build the bench bundles.
RUN pnpm build:bench

# Run the full multi-game benchmark.
CMD ["bun", "dist/bench/solo-local.js", "--duration", "5000"]
```

- [ ] **Step 2: Commit**

```bash
git add frontend/bench.Dockerfile
git commit -m "build(frontend): add benchmark Dockerfile"
```

---

### Task 3: Create the Docker Compose file with pinned resources

**Files:**
- Create: `frontend/docker-compose.bench.yml`

- [ ] **Step 1: Write the compose file**

```yaml
services:
  bench:
    build:
      context: ..
      dockerfile: frontend/bench.Dockerfile
    deploy:
      resources:
        limits:
          cpus: "4.0"
          memory: 8G
```

- [ ] **Step 2: Commit**

```bash
git add frontend/docker-compose.bench.yml
git commit -m "build(frontend): add docker compose benchmark runner"
```

---

### Task 4: Build the image and run the benchmark in Docker

**Files:**
- None (verification step)

- [ ] **Step 1: Build and run**

Run:
```bash
cd frontend
docker compose -f docker-compose.bench.yml up --build
```

Expected: image builds successfully, benchmark starts, and the final output shows the ranked TPS table for all six games.

- [ ] **Step 2: Capture and report results**

Copy the final ranking table from the container output and report it back.

- [ ] **Step 3: (Optional) Re-run to check variance**

Run the compose command a second time without `--build`:
```bash
docker compose -f docker-compose.bench.yml up
```

Confirm results are within ~5% of the first run.

---

## Plan self-review

- **Spec coverage:** Dockerfile, compose file, resource pinning, Bun-compatible build, and benchmark execution are all covered.
- **No placeholders:** Every step includes exact commands and file content.
- **Type consistency:** N/A — no shared types across steps.
