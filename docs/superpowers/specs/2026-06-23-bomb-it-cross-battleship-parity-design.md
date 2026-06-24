# Bomb It & Chicken Cross — Battleship-tier parity — Design

> **Type:** design spec
> **Date:** 2026-06-23
> **Status:** approved (design), pre-implementation
> **Scope:** Bring the **solo self-play** mode of bomb-it and chicken-cross up to the
> reference tier held by battleship + tic-tac-toe: out-of-React session survival,
> multi-game-per-tunnel with running score + settle-anytime, and (bomb-it only) the
> gas-sponsor / DOPAMINT / backend-`/settle` funding path every other tunnel game
> already has. PvP is already at parity and stays untouched except re-verification.
> **Lands on:** PR #43 (`fix/bomb-it-gas-parity`) — landing strategy decided at
> integration time after the gate is green.

## Background

A parity review against the arena's two fully-built reference games — **battleship**
(the showcase: PRs #41/#42/#45) and **tic-tac-toe** (the original multi-game template)
— found three gaps in bomb-it + chicken-cross **solo** play. Measured across the six
real tunnel games:

| Game | Sponsor funding | Multi-game tunnel | Survives min/maximize (solo) |
|------|:---:|:---:|:---:|
| battleship | ✓ | ✓ | ✓ (out-of-React `BotSession`) |
| ttt | ✓ | ✓ | ✓ (resume adapter) |
| quantum poker | ✓ | ✗ | ✓ (out-of-React) |
| blackjack | ✓ | ✗ | ✗ |
| chicken-cross | ✓ | ✗ | ✗ |
| **bomb-it** | **✗** | ✗ | ✗ |

Findings that scope this work:

1. **bomb-it funding is a unique regression.** `useBombItSession.ts` still funds from
   the raw wallet (`openAndFundSelfPlay(signExec=wallet)` + `closeCooperative`), so a
   0-SUI / zkLogin player hits *"No valid gas coins."* It is the **only** tunnel game
   missing the sponsor path; chicken-cross already has it. Must fix regardless.
2. **Multi-game + survival are reference-tier**, held by battleship + ttt only. Closing
   them makes bomb-it/cross the #2/#3 games, not merely "caught up." The user has
   explicitly chosen full parity.
3. **Solo survival ≠ the PvP resume system.** Minimize/maximize/desktop-reflow unmounts
   the React component **without a page reload**; an out-of-React object in a
   module-scope map survives it. That is battleship's solo `BotSession` mechanism and is
   independent of the `frontend/src/pvp/resume.ts` cold-load system (which handles PvP
   *page reload*). bomb-it/cross **PvP** already survives via its out-of-React engine;
   only **solo** (in-React `refs`+`setInterval`) does not.

### What stays out of scope

- **PvP** for both games — already DistributedTunnel + sponsored (the generic hook, PR
  #43) + out-of-React (survives reflow). We only re-verify it after the solo refactor.
- **PvP page-reload (cold-load) resume** for bomb-it/cross — that is the separate
  `RebuildSpec`/`resumeActiveTunnels` system (`2026-06-22-6b-per-game-resume-design.md`),
  a much larger effort for the four other games; not a battleship-solo-parity item.
- **Sound, palette rework** — confirmed non-gaps in
  `2026-06-22-bomb-it-cross-consistency-hardening-design.md`.

## Decisions

- **Solo session model: rewrite both hooks to battleship's out-of-React `BotSession`
  pattern.** A plain class holds the whole session (status, tunnel, protocol, score,
  heartbeat state); the hook subscribes via `useSyncExternalStore`; instances live in a
  `windowId`-keyed module map disposed only by `registerWindowDisposer` on window close.
  This is the single mechanism that delivers survival **and** the multi-game advance loop
  **and** the sponsor path in one coherent rewrite — not three bolt-ons. Template:
  `frontend/src/games/battleship/useBattleship.ts`.
- **Multi-game wrapper lives in the SDK**, beside the base protocols:
  `sui-tunnel-ts/src/protocol/multiGameBombIt.ts` + `multiGameCross.ts`, with co-located
  `*.test.ts`. Consistent with ttt (`packages/shared/src/ttt/multiGameProtocol.ts`,
  colocated) and with where `bombIt.ts`/`cross.ts` already live. Adds the two files + a
  barrel export to `index.ts`; the base protocols are unchanged. (`docs/adding-a-tunnel-
  game.md` explicitly blesses "add a protocol following the existing protocol files.")
- **Per-game seed derivation, deterministic (extends ADR 0010).** A naive multi-game
  reset re-derives `seedFromTunnelId(tunnelId)` → the *identical* board/race every game.
  The wrapper instead resets the inner game with a **synthetic per-game id**
  `` `${tunnelId}:g${gamesPlayed}` ``. Because `gamesPlayed` is part of the co-signed
  multi-game state (and of `encodeState`), both parties and an on-chain replay derive the
  same per-game seed. This stays squarely inside ADR 0010: the field remains public,
  symmetric, party-independent, and seeded from an un-grindable id — no commit-reveal.
  Recorded as a short ADR (extends 0010).
- **bomb-it funding: adopt the chicken-cross/battleship sponsor path** in the rewrite —
  `useSponsoredSignExec`, `withSponsorFallback`, DOPAMINT stake (`isDopamintConfigured`),
  `settleViaBackend`, `close_cooperative_with_root`, transcript → Walrus. No new code
  path; reuse the one chicken-cross already runs.
- **bomb-it preserves its reaction cadence.** bomb-it advances one co-signed tick per
  `SOLO_STEP_MS` (legible fuse); chicken-cross batches ticks under a frame budget
  (throughput showcase). The multi-game rewrite keeps each game's existing per-tick
  pacing and only adds the between-games rematch beat. The 8× decouple-stepping-from-
  rendering work was battleship-specific and is **not** retrofitted.
- **UI: extend the existing themed shells**, do not impose battleship's lilac frame. Add
  running score, a settle-anytime control, and the auto-rematch beat to `BombBoard` /
  `CrossBoard` in their own `bomb-*` / `cross-*` design language.

## Architecture

### SDK — multi-game protocol wrappers

Each wrapper `implements Protocol<MultiGame*State, *Move>` by composing the single-game
protocol, mirroring `MultiGameBattleshipProtocol` exactly:

```
State  = { inner: <Base>State; gamesPlayed: number }
Move   = <Base>Move                       // first move after terminal starts next game

initialState(ctx)          → { inner: base.initialState(ctx), gamesPlayed: 0 }
applyMove(state, move, by) →
  inner NOT terminal       → delegate to base.applyMove
  inner terminal & funded  → reset inner via base.initialState({
                               tunnelId: `${tunnelId}:g${gamesPlayed+1}`,   // per-game seed
                               initialBalances: { a: inner.balanceA, b: inner.balanceB },
                             }), then apply `move` to the fresh state; gamesPlayed += 1
  inner terminal & broke   → throw (session terminal — settle only)
encodeState(state)         → domain("<base>.multi.v1")
                              || lengthPrefixedConcat([base.encodeState(inner),
                                                       u64be(gamesPlayed)])
balances(state)            → base.balances(inner)
isTerminal(state)          → inner not terminal ? false
                              : !canFundNextGame(inner)        // exhaustion stop only
randomMove(state, by, rng) → inner not terminal ? base.randomMove : null   // session drives rematch
```

The wrapper must hold the **real `tunnelId`** to build the per-game synthetic id. The
constructor takes `(tunnelId, stake?)`; `initialState` seeds game 1 from
`` `${tunnelId}:g1` `` for a uniform rule (game N seeds from `:g${N}`). `canFundNextGame`
= both inner balances ≥ the per-seat stake (stake 0 ⇒ always fundable, matching
battleship). Conservation holds: money moves only through the base protocol's terminal
balance flip; a reset carries `inner.balanceA/balanceB` forward verbatim.

> **Why the first move starts the next game (vs an explicit "reset" move):** identical to
> battleship, where the rematch `commit` both resets and advances. For these games the
> session steps a trivial seat-A kickoff (cross: `{ dirA: <bot dir> }`; bomb-it:
> `{ a: <bot action> }`) computed off the fresh inner state, keeping the wrapper's move
> alphabet equal to the base game's — no new move variant, no Move/Codec surface.

### Frontend — out-of-React solo session (per game)

A `BotSession`-shaped class per game (`bombIt/botSession.ts`, `chickenCross/botSession.ts`
or kept inside the rewritten hook file, matching battleship's single-file layout):

| Concern | Mirrors battleship |
|---|---|
| State out of React | class fields + `emit()` to `useSyncExternalStore` listeners |
| Window survival | `windowId`-keyed `Map`; `registerWindowDisposer(windowId, …)` on close |
| Funding | `isDopamintConfigured` ? DOPAMINT-staked sponsored open : `withSponsorFallback` SUI |
| Advance loop | drive bot ticks at the game's cadence; on inner-terminal → record + score + (auto ? rematch : stop) |
| Multi-game | one tunnel, `MultiGame*Protocol`, `gamesPlayed` from `tunnel.state` |
| Settle anytime | `settleNow()` stops the loop, builds settlement-with-root, `settleViaBackend` |
| Score | `{ you, foe }` tallied once per finished game (`lastScoredGames` guard) |
| Telemetry | `bumpCounters` per co-signed update; throttled control-plane heartbeat + tail flush |
| Autopilot | `auto` default **on**; toggling on while idle kicks the advance loop |

The advance loop keeps each game's pacing: chicken-cross batches under
`FRAME_BUDGET_MS`/`MAX_STEPS_PER_FRAME`; bomb-it steps one tick per `SOLO_STEP_MS`. The
loop is an off-React async driver (chicken-cross) or interval (bomb-it) owned by the
class, generation-guarded (`gen`) so reset/dispose abandons an in-flight loop — exactly
as battleship guards `advance()`.

### Frontend — UI additions (themed, in-shell)

- **Running score**: `you N – M foe` over `gamesPlayed` games, in the existing stat pane.
- **Settle control**: a `bomb-*`/`cross-*` styled button, visible whenever a tunnel is
  live (one tunnel, many games), calling `settleNow()`.
- **Between-games beat**: auto on → brief result flash, bump score, auto-rematch on the
  same tunnel; auto off → the existing result card's "again" starts the next game on the
  same tunnel (not a new fund) until funds are exhausted, then settles.
- **Funding/settling/settled panes** reuse `BombScreen`/`CrossScreen`.

## Per-game specifics

| Aspect | bomb-it | chicken-cross |
|---|---|---|
| Base protocol | `BombItProtocol` (`bomb_it.v1`) | `CrossProtocol` (`cross.v1`) |
| Multi-game name | `bomb_it.multi.v1` | `cross.multi.v1` |
| Cadence | 1 tick / `SOLO_STEP_MS` (reaction) | batched / frame budget (throughput) |
| Kickoff move | `{ a: hunterAction(fresh,"A") }` | `{ dirA: greedyDir(fresh,0) }` |
| Funding before | **raw wallet (bug)** → sponsor path | already sponsor path |
| Winner type | `"A" \| "B" \| "draw" \| null` | `"A" \| "B" \| null` (push) |
| Score on draw/push | no tally; "again"/auto continues | no tally; "again"/auto continues |

bomb-it carries a `"draw"` terminal and chicken-cross a `null`/push terminal — neither
moves balances, both are fundable-next, so multi-game treats them as a played-but-
unscored game and continues (battleship has no draw, so this is the one shape battleship's
wrapper doesn't exercise; covered by a dedicated test).

## Error handling

- **No wallet** → `error` status with "connect a wallet", as today.
- **Open/fund failure** → `withSponsorFallback` retries sender-pays (SUI path); DOPAMINT
  path surfaces the error (same as battleship/chicken-cross).
- **Settle failure** → `settleViaBackend` falls back to `closeCooperativeWithRoot`
  (sponsored or wallet by `isDopamintConfigured`); a thrown close surfaces `error`.
- **Reset/dispose mid-loop** → `gen` bump makes the in-flight advance bail before its next
  `tunnel.step`.
- **Exhaustion** → `isTerminal` true between games when a side can't fund the next stake;
  the loop stops and the UI offers settle (no silent hang).

## Testing strategy

Lowest tier that proves each behavior; runners idiomatic to each package.

**SDK multi-game protocols** (`node:test` via tsx, co-located), mirroring
`multiGameBattleship.test.ts`:
- balance **conservation** across a game boundary (reset carries balances; sum == total);
- **`encodeState` determinism + domain separation** (multi state never collides with the
  inner single-game encoding; same state ⇒ same bytes);
- **reset-on-terminal**: a move after terminal starts game 2 with a **different seed**
  (assert grid/hazard differs from game 1) and `gamesPlayed` increments;
- **exhaustion**: `isTerminal` flips only when the next stake is unfundable;
- **draw/push continuation** (bomb-it draw, cross push): played, unscored, fundable-next.

**Frontend session** (`session-core.test.ts` updates + a bounded session test):
- extend `stepSession`/`deriveView` to the multi-game state shape; keep the existing
  bounded settleability test (`verifyCoSignedUpdate` after ~50 ticks) green;
- a bounded **multi-game** test: play game 1 to terminal, drive one rematch, assert
  `gamesPlayed === 1` and the co-signed state still verifies.

**Re-verify** PvP unchanged (existing PvP tests) and battleship untouched.

**Gate** (per `docs/adding-a-tunnel-game.md` §Gate + the consistency-hardening spec):
```
cd sui-tunnel-ts && node --import tsx --test src/protocol/cross.test.ts src/protocol/bombIt.test.ts
cd sui-tunnel-ts && node --import tsx --test src/protocol/multiGameCross.test.ts src/protocol/multiGameBombIt.test.ts
cd frontend && node --import tsx --test "src/games/bombIt/session-core.test.ts" "src/games/chickenCross/session-core.test.ts"
cd frontend && pnpm typecheck
cd frontend && pnpm build
```

## File structure

**Created**
- `sui-tunnel-ts/src/protocol/multiGameBombIt.ts` + `multiGameBombIt.test.ts`
- `sui-tunnel-ts/src/protocol/multiGameCross.ts` + `multiGameCross.test.ts`
- `docs/decisions/00NN-multi-game-self-play-per-game-seed.md` (ADR, extends 0010)

**Modified**
- `sui-tunnel-ts/src/protocol/index.ts` — barrel-export the two wrappers
- `frontend/src/games/bombIt/useBombItSession.ts` — out-of-React `BotSession`; multi-game;
  sponsor/DOPAMINT/backend-settle; score; settle-anytime; heartbeat throttle
- `frontend/src/games/chickenCross/useChickenCrossSession.ts` — out-of-React; multi-game;
  score; settle-anytime (keeps its existing sponsor path)
- `frontend/src/games/*/session-core.ts` — view/step adapted to multi-game state
- `frontend/src/games/bombIt/BombItWindow.tsx`, `chickenCross/ChickenCrossWindow.tsx` —
  solo now survives remount (windowId store), so the mode store may persist "solo" too
- `frontend/src/games/bombIt/components/BombBoard.tsx`,
  `chickenCross/components/CrossBoard.tsx` — score, settle control, rematch beat
- `frontend/src/games/*/components/*Screen.tsx`, `*.css` — settle/score styling as needed
- `frontend/src/games/*/session-core.test.ts` — multi-game bounded test

**Unchanged (re-verified)**
- `usePvpBombIt.ts`, `usePvpChickenCross.ts`, `pvp/pvpMatchHook.ts`, all battleship files.

## Self-review notes (coverage)

- bomb-it funding bug → sponsor path adopted in the rewrite (decision §4) + the open/fund
  failure path tested via the existing fallback.
- Survival on min/maximize → out-of-React `BotSession` + windowId store (architecture
  §frontend); page-reload PvP resume explicitly out of scope.
- Multi-game identical-board pitfall → per-game synthetic-id seed (decision §3) + a
  reset-on-terminal **different-seed** assertion.
- Draw/push (the shape battleship lacks) → explicit continuation rule + dedicated test.
- ADR 0010 alignment → per-game seed stays deterministic/public/symmetric; recorded as an
  extending ADR.
- Cadence preserved → bomb-it 1-tick/step, cross frame-budget; no battleship TPS retrofit.
</content>
</invoke>
