# Solo Full Tunnel Benchmark Runbook

Run a single-process, full-lifecycle benchmark that opens a real on-chain tunnel, plays a self-play game off-chain, and settles through the tunnel-manager backend.

## What it does

`frontend/src/bench/solo-full-tunnel.ts` exercises the complete lifecycle:

1. **Open** — `create_and_fund` a shared tunnel on Sui testnet, staking MTPS for both parties.
2. **Register** — tell the tunnel-manager backend about the new tunnel (`POST /v1/sessions`).
3. **Play** — run two bots inside an `OffchainTunnel`, co-signing every state update.
4. **Heartbeat** — send coarse action deltas to the backend (`~1/s`).
5. **Settle** — build a co-signed root settlement off-chain and submit it to the backend (`POST /v1/tunnels/{id}/settle`), which executes `close_cooperative_with_root` on-chain and archives the transcript.

## Prerequisites

- Node.js + pnpm (matching `frontend/.nvmrc` if present).
- Installed dependencies: `cd frontend && pnpm install`.
- A funded testnet account with:
  - SUI for gas.
  - MTPS for stakes (the script mints more from the faucet if needed, but gas is required to mint).
- The tunnel-manager backend URL (default is `https://relay-dev.millionstps.io`).

## Required environment

| Variable | Purpose | Example |
|----------|---------|---------|
| `SUI_FUNDER_KEY` | Base64 `suiprivkey1...` of the account that opens+funds tunnels | `suiprivkey1qppngxa6...` |
| `BACKEND_URL` | tunnel-manager control-plane base URL | `https://relay-dev.millionstps.io` |
| `SUI_RPC_URL` | Optional. Override the Sui RPC endpoint. Defaults to `https://rpc.testnet.sui.io`. | `https://rpc.testnet.sui.io` |
| `SUI_NETWORK` | Optional. `testnet` (default), `mainnet`, or `localnet`. | `testnet` |
| `PACKAGE_ID` | Optional. Deployed `sui_tunnel` package. Defaults to testnet dev package. | `0x0b89...` |
| `MTPS_PACKAGE_ID` | Optional. Defaults to testnet dev package. | `0x62e3...` |
| `MTPS_FAUCET_ID` | Optional. Defaults to testnet dev faucet. | `0x65df...` |
| `MTPS_COIN_TYPE` | Optional. Defaults to testnet dev coin type. | `0x62e3...::mtps::MTPS` |

## Run one process

```bash
cd frontend
export BACKEND_URL=https://relay-dev.millionstps.io
export SUI_FUNDER_KEY=suiprivkey1qppngxa6t69l38vh437nh6vqhgsa3rzsvg78lyfq5t9acpxm25jkk5j5zmu

npx vite-node --config vite.bench.config.ts src/bench/solo-full-tunnel.ts -- <gameId> <mode> <durationMs> <seed>
```

Example:

```bash
npx vite-node --config vite.bench.config.ts src/bench/solo-full-tunnel.ts -- blackjack full 30000 1
```

Arguments:

- `<gameId>` — `blackjack`, `tictactoe`, `battleship`, `quantum-poker`, `bomb-it`, `chicken-cross`, `world-canvas`, `micro-payments`.
- `<mode>` — `full` (sign + verify), `sign-only`, or `none` (protocol overhead only).
- `<durationMs>` — how long the play phase should run. The script keeps opening tunnels until the deadline.
- `<seed>` — deterministic seed for keys/bots. Use distinct seeds when fanning out.

## Fan out across cores

Launch one process per core with distinct seeds and sum each `STEPS_PER_S` line:

```bash
cd frontend
export BACKEND_URL=https://relay-dev.millionstps.io
export SUI_FUNDER_KEY=...

for seed in 1 2 3 4; do
  npx vite-node --config vite.bench.config.ts src/bench/solo-full-tunnel.ts -- blackjack full 30000 $seed &
done
wait
```

## Expected output

A successful run prints logs like:

```
[solo-full-tunnel] opening tunnel #0 with stake 100...
[solo-full-tunnel] using MTPS coin 0x00ff...
[solo-full-tunnel] signing and executing create_and_fund...
[solo-full-tunnel] open tx digest: Ha6Urmrc9gUKVPJyBJ8LBv49RZdB3bfJK8XaWhEq6C9w
[solo-full-tunnel] waiting for transaction...
[solo-full-tunnel] tunnel id: 0x4e19...
[solo-full-tunnel] registering backend session...
[solo-full-tunnel] session sess_628ff6305e554b37bc1a59b572ab733e
[solo-full-tunnel] settled 0x4e19... -> AUTsrW4UDLWdouvhMHic6Q3VN4QzgiE8LyGn1aWr4w2p
STEPS_PER_S=4
```

`STEPS_PER_S` is dominated by on-chain open/settle latency when `durationMs` is short; it rises when multiple off-chain moves fit between on-chain boundaries.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `ConnectTimeoutError: fullnode.testnet.sui.io:443` | The default `getFullnodeUrl("testnet")` endpoint is unreachable from this network. | The script already defaults to `https://rpc.testnet.sui.io`. Override with `SUI_RPC_URL` if needed. |
| `settle failed: 422 object ... is not a shared tunnel` | The script created an off-chain tunnel without opening it on-chain. | Use the current version of `solo-full-tunnel.ts`, which calls `create_and_fund` before play. |
| `settle failed: 409 tunnel already closed on-chain` | Harmless duplicate settle after a terminal state. The script now skips already-settled tunnels. | No action needed. |
| Low `STEPS_PER_S` | Each tunnel lifecycle includes two on-chain transactions. | Increase `durationMs` so more off-chain moves amortize the open/settle cost, or fan out across cores. |

## High-TPS variant: batch lifecycle

For peak off-chain TPS, use `frontend/src/bench/solo-batch-lifecycle.ts`. It opens a pool of tunnels in **one** on-chain PTB, runs every tunnel in its own async play loop, then settles sequentially.

```bash
cd frontend
export BACKEND_URL=https://relay-dev.millionstps.io
export SUI_FUNDER_KEY=...

npx vite-node --config vite.bench.config.ts src/bench/solo-batch-lifecycle.ts -- <gameId> <mode> <durationMs> <tunnelCount> <seed> [--skip-settle] [--sustain] [--duration=<n>[smh]]
```

Flags:

- `--skip-settle` — skip the on-chain settle/close phase. Use this to keep the benchmark running for a long time without spending gas on closes.
- `--sustain` — when a tunnel reaches a terminal state, reset it off-chain and keep playing. This is required for long runs with terminating games like blackjack; without it, average TPS collapses once all hands finish.
- `--duration=<n>[smh]` — override the positional duration. e.g. `--duration=30s`, `--duration=5m`, `--duration=1h`.

Example (blackjack, full crypto, 10s play, 100 tunnels):

```bash
npx vite-node --config vite.bench.config.ts src/bench/solo-batch-lifecycle.ts -- blackjack full 10000 100 1
```

Long-running sustained play (best for backend dashboard TPS):

```bash
npx vite-node --config vite.bench.config.ts src/bench/solo-batch-lifecycle.ts -- blackjack full 0 10 1 --skip-settle --sustain --duration=30m
```

Observed on this setup:

| Tunnels | Mode | Duration | Sustain | Play TPS |
|---------|------|----------|---------|----------|
| 10 | full | 5s | no | ~68 |
| 50 | full | 10s | no | ~143 |
| 100 | full | 10s | no | ~289 |
| 10 | full | 15s | yes | ~5,750 |
| 20 | full | 15s | yes | ~6,240 |
| 50 | full | 15s | yes | ~4,050 |
| 100 | full | 15s | yes | ~2,460 |
| 10 | full | 2m | yes | ~6,525 |

With `--sustain`, peak single-process throughput is **~6,200 steps/s** using 10–20 tunnels. Higher tunnel counts add event-loop overhead and lower total TPS on one Node process. To scale further, fan out multiple processes with distinct seeds (each opens its own pool).

The practical cap without sustain is the funder's SUI gas balance: a 200-tunnel open exhausted the test funder.

To go higher, fan out multiple processes with distinct seeds (each opens its own tunnel pool).

## Files involved

- `frontend/src/bench/solo-full-tunnel.ts` — single-tunnel lifecycle benchmark.
- `frontend/src/bench/solo-batch-lifecycle.ts` — high-TPS batch benchmark.
- `frontend/vite.bench.config.ts` — Vite config for `vite-node`; keeps the v1/v2 SDK shims but does **not** stub `node:crypto`, so the SDK can use the native crypto backend in Node.
