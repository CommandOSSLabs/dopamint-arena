# Bomb It (tunnel PvP + self-play)

A two-party Bomberman-style grid duel that settles over a real Sui tunnel.
PvP-default (human vs human over a shared tunnel) with a Solo self-play on-ramp;
every world tick is a genuinely co-signed state update — no trusted server.

## How it works

- `BombItWindow.tsx` — the registered game `Window`; a status router that picks
  Solo or PvP from the lobby and renders bet/funding/board/error by status.
- `useBombItSession.ts` — Solo (bot-vs-bot) self-play: opens + funds BOTH seats in
  one wallet signature (`openAndFundSelfPlay`), drives RNG moves through the
  protocol on a thermal-budgeted timer, then settles cooperatively on-chain.
  Feeds the desktop telemetry via `useTelemetry` and registers with the
  control-plane (best-effort, ADR-0002).
- `usePvpBombIt.ts` — PvP: `MpClient.quickMatch("bomb-it")`, ephemeral-key
  exchange, `openAndFundSharedTunnel` / `depositStake`, moves via
  `DistributedTunnel` (propose→ACK), root-anchored cooperative settle (with a
  wallet-submitted fallback).
- `session-core.ts` — pure driver (`stepSession`, `deriveView`, `sessionResult`),
  SDK type-only imports so it unit-tests under `tsx`.
- `components/` — `BombLobby` (mode + stake) and `BombBoard` (terrain + pieces +
  blast overlay). `bomb-it.css` carries the neon styling; shared `arcade-*` /
  `text-gold` chrome comes from `src/styles/index.css`.

The protocol lives in `sui-tunnel-ts/src/protocol/bombIt.ts`. Randomness (grid
layout) is seeded deterministically from the `tunnelId`; this is fair in PvP
because the grid is public and 180°-symmetric (see `docs/decisions/0010`).

## Gate

```bash
cd sui-tunnel-ts && node --import tsx --test src/protocol/bombIt.test.ts
cd frontend && node --import tsx --test "src/games/bombIt/session-core.test.ts"
cd frontend && pnpm typecheck && pnpm build
```
