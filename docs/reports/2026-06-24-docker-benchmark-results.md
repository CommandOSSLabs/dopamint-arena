# Docker benchmark results

**Date:** 2026-06-24
**Branch:** `feat/find-best-game-tps`
**Commit:** `5bd5c25`

## Environment

- **Runtime:** Docker container (`frontend-bench:latest`)
- **Resources:** 4 CPUs / 8 GB RAM
- **Worker processes:** 4 (matching the 4 CPU limit)
- **Duration per game:** 30 seconds
- **Toolchain:** Bun 1.3.5, Node 26, pnpm 11.6.0

## How to reproduce

```bash
cd frontend
docker compose -f docker-compose.bench.yml up --build
```

## Results

| rank | game | avg TPS | peak TPS |
|---:|---|---:|---:|
| 1 | **blackjack** | **49,531** | 53,024 |
| 2 | chicken-cross | 45,539 | 48,906 |
| 3 | tictactoe | 43,916 | 47,910 |
| 4 | battleship | 36,201 | 39,865 |
| 5 | bomb-it | 30,784 | 34,132 |
| 6 | quantum-poker | 8,036 | 8,675 |

## Conclusion

Under identical, pinned resources, **blackjack is the fastest game** at **49,531 TPS**.

Chicken-cross and tic-tac-toe are close behind (~44–45k TPS). Quantum-poker is an order of magnitude slower (~8k TPS) due to its commit-reveal plumbing and betting phases.

## Files

- `frontend/bench.Dockerfile`
- `frontend/docker-compose.bench.yml`
- `frontend/src/bench/solo-local.ts`
- `frontend/package.json`
