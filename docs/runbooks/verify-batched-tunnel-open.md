# Verify: batched tunnel open (ADR-0019)

The unit tests prove coalescing/correlation/chunking/fallback with fakes. The
sponsor-quota fix itself is only observable against the real backend + chain.

## Pre-req
- `tunnel-manager` backend up with the gas sponsor (`POST /v1/sponsor`) configured.
- `sui_tunnel` deployed; `VITE_TUNNEL_PACKAGE_ID` (and MTPS env, if used) set.

## Steps
1. `cd frontend && pnpm dev`; open the desktop on the Games workspace (all game
   windows tiled).
2. Open DevTools → Network, filter `sponsor`.
3. Connect the wallet (the auto-start trigger).
4. **Expect: ~2 `POST /v1/sponsor` requests total** (one address-balance ensure +
   one batched open), NOT one-per-window. With > MAX_BATCH games, expect
   `ceil(N / MAX_BATCH)` open calls (see the `[tunnelOpenBatcher] … → K PTBs` log).
5. **Expect: every game window funds and starts playing**; no HTTP 422; no 5 s
   retry storm in the console.
6. Read the open tx in an explorer: one PTB creates N `Tunnel` objects, each with
   the correct distinct party-A; balances per tunnel sum to its 2·perSeat stake.

## Regression signal
If Network shows one sponsor call per window (N calls) on connect, the windows
are NOT coalescing — check that `configureSharedBatcher` runs and that all windows
share the single `sharedTunnelOpenBatcher` module instance.
