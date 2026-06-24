# Docker benchmark results

**Date:** 2026-06-24
**Branch:** `feat/find-best-game-tps`
**Commit:** `27d36db`

## Environment

- **Runtime:** Docker container (`frontend-bench:latest`)
- **Resources:** 4 CPUs / 8 GB RAM
- **Worker processes:** 4 (matching the 4 CPU limit)
- **Duration per game:** 10 seconds
- **Toolchain:** Bun 1.3.5, Node 26, pnpm 11.6.0

## How to reproduce

```bash
cd frontend
docker compose -f docker-compose.bench.yml up --build
```

## Results

| rank | game | avg TPS | peak TPS |
|---:|---|---:|---:|
| 1 | **blackjack** | **48,723** | 52,182 |
| 2 | chicken-cross | 44,957 | 48,259 |
| 3 | tictactoe | 44,219 | 47,979 |
| 4 | battleship | 35,580 | 39,106 |
| 5 | bomb-it | 30,199 | 33,301 |
| 6 | quantum-poker | 7,950 | 8,596 |

## Conclusion

Under identical, pinned resources, **blackjack is the fastest game** at **48,723 TPS**.

Chicken-cross and tic-tac-toe are close behind (~44–45k TPS). Quantum-poker is an order of magnitude slower (~8k TPS) due to its commit-reveal plumbing and betting phases.

## Files

- `frontend/bench.Dockerfile`
- `frontend/docker-compose.bench.yml`
- `frontend/src/bench/solo-local.ts`
- `frontend/package.json`
