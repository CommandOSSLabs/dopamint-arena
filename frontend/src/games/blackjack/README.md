# Blackjack (tunnel self-play)

A self-contained arena game: the player only sets a stake, then two bots play
Blackjack against each other off-chain over a Sui tunnel. No server, no wallet
spend — purely client-side, driven by the `sui-tunnel-ts` SDK.

## How it works

- `useBlackjackSession.ts` generates two ephemeral ed25519 keypairs (player-bot A,
  dealer-bot B), opens an `OffchainTunnel.selfPlay` over the SDK's
  `BlackjackProtocol` with `{ a: stake, b: stake }`, and steps the bots on a timer.
  Each move is genuinely co-signed; the co-signed updates feed the desktop's live
  telemetry panels via `useTelemetry`. Play runs until one bot can't cover the
  wager (the protocol's terminal state).
- `session-core.ts` — pure driver (`stepSession`, `deriveView`, `sessionResult`),
  SDK type-only imports so it unit-tests under `tsx`.
- `cards.ts` — maps the protocol's card VALUES to display indices 0..51; faces are
  cosmetic, totals are authoritative from the SDK. `cardAssets.ts` resolves the
  game-local card SVGs (in `assets/`) to bundled URLs.
- `components/` — `CardDisplay` (ported), `BetPanel` (stake input), `BlackjackTable`
  (the casino table layout). `blackjack.css` carries the casino styling.
- `BlackjackWindow.tsx` is the registered game `Window`; `index.ts` registers it.

## Tests

```bash
pnpm test   # cards.test.ts + session-core.test.ts (node:test via tsx)
```
