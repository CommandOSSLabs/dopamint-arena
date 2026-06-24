# Docker benchmark runner design

## Goal
Provide a reproducible, resource-pinned Docker environment for running the local Bun TPS benchmark (`frontend/src/bench/solo-local.ts`) so results are comparable across machines and runs.

## Scope
- Add a single-stage Dockerfile at `frontend/bench.Dockerfile`.
- Add a compose file at `frontend/docker-compose.bench.yml` that pins CPU and memory.
- Fix the existing `pnpm build:bench` command so its bundles run under Bun inside the container.
- Run the full multi-game comparison (`solo-local.ts --duration 5000`).

## Non-scope
- No production deployment, no multi-stage image optimization, no CI wiring.
- Does not fix the broader typecheck/review findings from `origin/dev`; those remain separate work.

## Design

### Base image
`oven/bun:1.3.5` (Debian-based) with Node 24 and pnpm 11.6.0 installed to match the host toolchain.

### Source layout in the image
The repo root is copied to `/app`. Two directories matter:
- `/app/sui-tunnel-ts` — the SDK package.
- `/app/frontend` — the frontend package and benchmark harness.

`frontend/tsconfig.json` resolves `sui-tunnel-ts/*` via relative paths, so both directories must be present at build time.

### Dependency install
1. `pnpm install` in `/app/sui-tunnel-ts`.
2. `pnpm install` in `/app/frontend`.

### Bench bundle build
The current `pnpm build:bench` uses esbuild with `--format=esm`, which produces bundles containing `import * as nc from "node:crypto"` alongside CommonJS helpers; Bun rejects these at runtime. The Dockerfile will use `bun build --target bun` for the four bench entry points instead, outputting to `frontend/dist/bench`.

### Runtime command
```bash
bun dist/bench/solo-local.js --duration 5000
```

### Resource pinning
`docker-compose.bench.yml` sets:
- `deploy.resources.limits.cpus: "4.0"`
- `deploy.resources.limits.memory: 8G`

### Usage
```bash
cd frontend
docker compose -f docker-compose.bench.yml up --build
```

## Success criteria
- `docker compose -f docker-compose.bench.yml up --build` completes without errors.
- Output shows the ranked TPS table for all six games.
- Re-running the same command on the same hardware yields numbers within ~5% variance.
