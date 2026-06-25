# Agent fleet (P1)

Real-app browser agents that play tunnel games over the **live relay** — the same code,
origin, wallet flow, and relay path a human uses. Spec:
`docs/superpowers/specs/2026-06-18-scaled-relay-agent-fleet-design.md`.

## Scripts

1. **Fund / top up** the wallet pool (reuses `keys.json`, funds only what's missing — secrets
   are gitignored). Key is piped from the keystore, never printed:

   ```bash
   SUI_TREASURY_KEY=$(sui keytool export --key-identity "$(sui client active-address)" --json \
     | jq -r .exportedPrivateKey) N=10 node agent/fundTreasury.mjs
   ```

2. **Run agents** — browser contexts loading the real app with bare `?agent`; the
   engine rotates the canonical `GAME_KITS` set and counts completed tunnels. Keys
   come from `agent/keys.json` by default, `AGENT_KEYS_FILE`, or `AGENT_KEYS`
   (comma-separated secret keys or JSON array):

   ```bash
   BASE_URL=http://localhost:5074 K=10 TIMEOUT_MS=60000 node agent/runAgents.mjs
   ```

   To self-play only Quantum Poker with two pre-funded bot wallets:

   ```bash
   BASE_URL=http://localhost:5173 GAME=quantum-poker K=2 TIMEOUT_MS=120000 node agent/runAgents.mjs
   ```

3. **Relay frame-rate bench** (spec §Numbers#1) — direct to the ALB:

   ```bash
   MP_WS_URL=ws://<alb>/v1/mp T=25 D=15 PIPELINE=16 node agent/loadtestRelay.mjs
   ```

## Measured on dev (2026-06-19)

- **Ramp:** 10 agents → **61 real on-chain tunnels in 60s (~1/s)**, all 10 cycling. Each =
  `create → deposit → deposit → play → close` on testnet; verified `status: CLOSED, balance: 0`.
  Throughput here is **on-chain-finality-bound** (~4 txs/tunnel), not the relay.
- **Relay bench (from a laptop — WAN-distorted, NOT the relay's capacity):** ~95 frames/s
  synchronous (RTT-bound), **~1038 frames/s pipelined** (16 in flight). The authoritative
  §Numbers#1 number must be measured **co-located in us-east-1** (spec §4) — run
  `loadtestRelay.mjs` from an EC2 instance in-region, then compare to `R_min`.

## Known follow-ups (deferred)

- **Backend `POST /v1/tunnels/{id}/settle` → 404:** the engine falls back to an on-chain
  `close_cooperative_with_root` (settles, root anchored), but **Walrus archival is blocked**
  until that route is deployed. Pre-existing backend gap — also hits the human `usePvpTicTacToe`
  path.
- **Move-trigger:** the browser agent now drives games through the canonical
  `GAME_KITS` registry, so phase-based games use their own `GameBot.plan()` logic
  instead of the old SDK `randomMove` path.
- **`MpClient` multiplexing:** `M>1` concurrent tunnels per agent needs per-`matchId` routing;
  P1 runs `M=1`.
