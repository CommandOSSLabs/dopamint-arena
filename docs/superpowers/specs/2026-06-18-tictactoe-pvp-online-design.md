# Tic-Tac-Toe PvP Online — Design

**Date:** 2026-06-18
**Status:** Approved (brainstorming)
**Author:** pairing session

## Goal

Add an **online PvP mode** to the tic-tac-toe game: two real humans, matched over
the relay server, play turn-based games (both the classic 3×3 variant and the
N×N caro / 5-in-a-row variant), with each move co-signed off-chain through the
two-party `DistributedTunnel` engine and a single cooperative on-chain settlement
at the end. Includes an **auto mode** where a local strategy bot plays the user's
turns. This is a separate mode that leaves the existing bot-vs-bot self-play
untouched.

This mirrors the already-working blackjack PvP, adapted to tic-tac-toe's
*symmetric, alternating-turn* nature (no player-vs-dealer asymmetry).

## Decisions (settled during brainstorming)

- **Variants:** support **both** caro (N×N) and classic 3×3. The lobby picks the
  variant; the PvP hook is parameterized by it.
- **Stakes:** **minimal — 1 MIST per game**, fixed bankroll per seat. The point is
  the win/loss record, not gambling. A decisive game shifts the 1-MIST stake
  loser→winner; a draw pushes. No custom buy-in, no variable per-game betting.
- **Auto + loop:** auto = a local strategy bot plays *your* turns; play **many
  games in one tunnel until one side hits "Stop & settle"** (blackjack-style
  multi-game loop), then one cooperative close.
- **Engine acquisition:** **Approach 1** — point ttt's `sui-tunnel-ts` dependency
  at the repo-root SDK (the one blackjack uses), which is a superset at the same
  version and exports `DistributedTunnel`. Gated by a Task-0 verification.

## Architecture

A self-contained PvP flow living beside the existing self-play, reusing the
relay + on-chain tunnel infrastructure proven by blackjack PvP.

- **Roles:** the matchmaker assigns A/B. **A = X** (moves first, drives the
  "advance to next game" trigger, opens the tunnel, submits the cooperative
  close). **B = O.** Both seats are human; moves alternate.
- **Engine:** `core.DistributedTunnel<State, Move>` running the existing
  `MultiGameTicTacToeProtocol` (3×3) or `MultiGameCaroProtocol` (caro). These play
  N games in one tunnel and accumulate balances; the PvP hook drives proposals via
  the relay transport, exactly as the blackjack PvP hook does.
- **Variant parameterization:** the lobby chooses `variant: "ttt" | "caro"` (and a
  board size for caro). `usePvpTicTacToe(variant, ...)` selects the matching
  protocol, the matching local bot (`pickCell`/minimax for ttt, `pickCaroMove` for
  caro), and the matching board component.

### Task 0 — SDK dependency switch (hard gate before any feature code)

The ttt client currently depends on `sui-tunnel-ts: file:../../../reference/sui-tunnel-ts`,
an older snapshot **without** `distributed*` modules. The repo-root
`sui-tunnel-ts` (used by blackjack) is a superset at the same version (`0.1.0`)
that exports `DistributedTunnel`, `makeEndpoint`, `defaultBackend`, and the PvP
on-chain helpers (`buildCreateAndShare`, `buildDepositFromGas`,
`buildCloseFromSettlement`).

1. Change the ttt client's `sui-tunnel-ts` dependency target to the repo-root SDK
   (the same `file:` target blackjack uses), reinstall.
2. Run `bun test` for `@ttt/shared` and the client; typecheck + `vite build`; smoke
   the existing self-play.
3. **If green**, proceed. **If anything breaks** (API drift in the self-play path),
   fall back to vendoring `distributedTunnel.ts` + `distributedFrame.ts` into the
   ttt client (Approach 2) — recorded as the contingency, not the plan.

## Identity (single local keypair)

The ttt self-play uses **local self-signing keypairs** (no external wallet, no
zkLogin). PvP follows the same model rather than wiring in ttt's `CustomWallet`:

- Each player has **one persistent ed25519 keypair** ("me") in localStorage,
  faucet-funded, used as **both** the on-chain wallet (open/deposit/close) **and**
  the tunnel move-signer. One identity, like `loadOrCreateBots`.
- **No ephemeral key and no wallet attestation** (unlike blackjack): this is a
  throwaway testnet identity; the security boundary is the on-chain seat, and the
  lobby identity is self-asserted in v1 (same caveat blackjack carries).
- The relay handshake signs the connection nonce with this keypair.

## Data flow

```
Lobby:  loadOrCreateMe() (faucet top-up) → pick variant (+ board size if caro) → Find match
Match:  relay matches two players → assigns role A/B
Open:   A (X) submits create_and_share registering both parties
        → sends tunnelId to B over the app channel ({ t: "opened", tunnelId })
Fund:   EACH seat deposits its own bankroll (BANKROLL MIST)
        → poll until the tunnel is active (status >= 1 && both deposits > 0)
Engine: new DistributedTunnel(proto, { self, opponent, selfParty }, relay.transport(matchId), { a, b })
Play:   my turn (inner.turn === myParty, inner not terminal) → click cell (or Auto bot picks)
        → propose { cell } → both co-sign → onConfirmed advances the view
        game over → A triggers the next game (advance { cell: 0 }) via Auto or "Next game"; O waits
Stop:   either seat may "Stop & settle" between games → co-signed close → A (opener) submits
        (or auto-settle when a side can't fund the next stake / a round cap is hit)
```

- **Open model:** `create_and_share` + each seat `deposit`s its own bankroll
  (two separate wallets, so neither funds the other — exactly blackjack PvP).
- **Close:** cooperative close from the dual-signed settlement
  (`buildCloseFromSettlement`), **no transcript-root anchoring** (the root is a
  self-play nicety; PvP v1 keeps it simple, like blackjack PvP).
- **Numbers:** `STAKE = 1n` MIST per game; `BANKROLL = 1000n` MIST per seat
  (enough for many games at a 1-MIST swing). Both denominated in MIST.
- **Play-until-stop:** the `MultiGame*` protocols require a `maxGames`; set it to a
  high cap (`MAX_GAMES = 1000`) so the session effectively runs until a seat hits
  "Stop & settle" or runs out of bankroll — mirroring blackjack's round cap. The
  "round cap reached" edge case below means `gamesPlayed + 1 >= MAX_GAMES`.

## Components & files

New, in `frontend/src/games/ticTacToe/packages/client/src/`:

- **`lib/pvpRelay.ts`** — `RelayClient` ported from blackjack's `bjRelay`:
  game-agnostic, `queueJoin("tictactoe")`, the handshake (sign nonce), an
  app-channel (`sendApp`/`onApp` for `opened`/`settle`/`closed`/`stop`), and
  `transport(matchId)` multiplexing engine frames vs app messages.
- **`lib/pvpIdentity.ts`** — `loadOrCreateMe()` (one local keypair + faucet helper),
  plus the nonce-signing used by the relay handshake.
- **`lib/pvpOnchain.ts`** — `buildCreateAndShareTx(a, b, stake)`,
  `buildDepositTx(tunnelId, amount)`, `buildCloseTx(tunnelId, settlement)`,
  `parseTunnelId`. Built via the `onchain.*` helpers, falling back to raw
  `tx.moveCall` if the pinned SDK lacks a helper (the pattern already used in
  `lib/tunnel.ts`).
- **`hooks/usePvpTicTacToe.ts`** — the PvP engine hook. Takes the chosen variant;
  selects the protocol + bot; owns match/open/fund/play/auto/turn/settle; returns a
  view: `{ board, size, turn, role, isMyTurn, winner/draw, score {x,o,draws},
  games log, settle history, phase, auto, digests, error }` + actions
  `{ play(cell), setAuto(on), next(), stop(), queue(), leave() }`.
- **`scenes/PvpScene.tsx`** — the lobby (identity + faucet + variant select + Find
  match) **and** the table (interactive board + turn/role badge + score + per-game
  log + settled-tunnel history + Auto toggle + Stop & settle + Next game + on-chain
  digest links).

Modified:

- **`components/CaroBoard.tsx`** — add `onPlay?(cell)` + `disabled` props so it is
  *interactive* for PvP (it is currently render-only). `Board.tsx` (3×3) already has
  `onPlay`/`disabled`.
- **`App.tsx`** — add a `"pvp"` scene to the scene state machine and a "Play online"
  entry (from SetupScene or LoginScene).

## Auto & turn model

- **My turn:** `inner.turn === myParty` and the inner game is not terminal → the
  board accepts clicks → `play(cell)` proposes the move.
- **Auto:** a local *strategy* bot (not random) plays my turns —
  `pickCell(inner, by, "perfect")` (minimax) for 3×3,
  `pickCaroMove(inner, by, rng, "strong")` for caro. Auto applies to **me only**;
  the opponent drives their own seat.
- **Between games:** A (X) triggers the next game with the protocol's advance move
  (`{ cell: 0 }`) — via Auto or a "Next game" button shown only to X; O waits. This
  follows the protocol's `randomMove` convention (only A drives the advance),
  avoiding a double-advance race.
- **Auto resets when a new match/rematch starts** (lesson from blackjack: a
  carried-over auto flag blocked manual play).

## Error handling & edge cases

- Relay disconnect / error frame → phase `error`, surfaced message, leave button.
- Tunnel never activates after the poll budget (opponent didn't fund) → throw,
  surface the error.
- A side can't fund the next stake, or a round cap is reached (`isTerminal`) →
  auto Stop & settle.
- Opponent leaves mid-session → the remaining seat can Stop & settle at the last
  game boundary using the last co-signed state (balances reflect the last
  agreed state).
- `opened` / `settle` app messages arriving before their resolver is registered →
  buffered (the blackjack pattern: a resolver ref + a buffered-value ref).

## Testing

Per CLAUDE.md, the lowest tier that proves the behavior:

- **Unit (bun test, `@ttt/shared`):** the protocols/boards/bots already have unit
  tests — no new ones needed. The `CaroBoard` change is UI-only (no unit test).
- **Integration (headless, cross-boundary):** a `pvpTicTacToeE2E` test that runs two
  `DistributedTunnel`s against each other over an in-memory transport (mirroring
  blackjack's `pvpDuelE2E`), plays a few games in **both** variants, and asserts
  `combineSettlement` yields balances that are conserved and equal on both sides.
  This is the highest-value test — it proves the two-party engine drives the
  ttt/caro protocols correctly.
- **E2E (manual):** two browser windows over the live relay, golden path only (not
  automated).

## Out of scope (YAGNI for v1)

- Custom/selectable buy-in (stake fixed at 1 MIST; bankroll fixed).
- Variable per-game betting.
- On-chain transcript-root anchoring at close.
- Lobby anti-cheat / identity verification beyond the self-asserted v1 (the
  on-chain seat is the boundary).
- Extracting a shared PvP package across blackjack + ttt (defer to Approach 3 if a
  third game needs it).
