# Chicken Cross (tunnel PvP + self-play)

A two-party lane-hopper race that settles over a real Sui tunnel. PvP-default
(two humans race over a shared tunnel) with a Solo self-play on-ramp; every
world tick is a genuinely co-signed state update — no trusted server.

## How it works

- `ChickenCrossWindow.tsx` — the registered game `Window`; a status router that
  picks Solo or PvP from the lobby and renders bet/funding/board/error by status.
- `useChickenCrossSession.ts` — Solo (bot-vs-bot) self-play: opens + funds BOTH
  seats in one wallet signature (`openAndFundSelfPlay`), drives RNG hops through
  the protocol on a thermal-budgeted timer, then settles cooperatively on-chain.
  Feeds the desktop telemetry via `useTelemetry` and registers with the
  control-plane (best-effort, ADR-0002).
- `usePvpChickenCross.ts` — PvP: `MpClient.quickMatch("chicken-cross")`,
  ephemeral-key exchange, `openAndFundSharedTunnel` / `depositStake`, hops via
  `DistributedTunnel` (propose→ACK), root-anchored cooperative settle (with a
  wallet-submitted fallback).
- `session-core.ts` — pure driver (`stepSession`, `deriveView`, `sessionResult`),
  SDK type-only imports so it unit-tests under `tsx`.
- `components/` — `CrossLobby` (mode + stake) and `CrossBoard` (lanes + hazards +
  chickens). `cross.css` carries the neon styling; shared `arcade-*` / `text-gold`
  chrome comes from `src/styles/index.css`.

The protocol lives in `sui-tunnel-ts/src/protocol/cross.ts`. Randomness (the
hazard field) is seeded deterministically from the `tunnelId`; this is fair in
PvP because the field is public and identical for both seats (see
`docs/decisions/0010`). A simultaneous finish with equal score is a push.

## Gate

```bash
cd sui-tunnel-ts && node --import tsx --test src/protocol/cross.test.ts
cd frontend && node --import tsx --test "src/games/chickenCross/session-core.test.ts"
cd frontend && pnpm typecheck && pnpm build
```
