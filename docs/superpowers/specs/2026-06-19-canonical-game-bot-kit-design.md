# Canonical Game Bot Kit — design

**Date:** 2026-06-19 · **Status:** proposed · **Scope:** preparation only (no fleet/infra)

## Problem

We want a flow of **bot-vs-bot** matches, generated on our server, whose on-chain
and relay footprint **looks exactly like humans playing the real shipped game**.
Four games (tic-tac-toe, blackjack, battleship, quantum-poker) were each built by
a different person, so the bot/auto-play surface diverges per game. A future
dev-server script must drive *any* game in a pool of tunnels uniformly — so the
per-game divergence has to be hidden behind one canonical contract first.

This spec covers **only that preparation** — the contract each game conforms to.
It does **not** build the fleet driver, multi-tunnel pooling, or any
AWS/Playwright/Node infra (deferred by request).

### What "looks exactly like human" reduces to

The relay counts move frames opaquely (`relay_payload_is_move`, `kind:"move"`),
so the live TPS *number* is already identical whether a bot or a human produces a
move. Two things actually matter — and timing is not one of them:

1. **Settlement footprint.** Each protocol's `encodeState()` begins with a
   domain-separation tag (e.g. `tic_tac_toe.multi.v1`). That tag is hashed into
   the co-signed state hash on every move and anchored on-chain at cooperative
   close. If the bot drives a *different* protocol class than the human frontend,
   its settlements carry a different stamp and are bucketable by anyone auditing
   on-chain — even though the TPS counter looks perfect.
2. **Move ordering.** Each tunnel must be a well-formed real game: moves emitted
   in the legal sequence a real game follows (turn alternation, commit→reveal→
   shoot, bet→play→settle), every one accepted by the protocol. Correct move
   *order* — not timing — is what makes a tunnel indistinguishable from human play.

**Speed is deliberately not a fidelity constraint.** Throughput is the whole
point, and a human could never produce the target TPS — so there is no artificial
human-paced delay. Bots play as fast as the relay/co-sign round-trip allows;
realism comes from the correct move sequence, not wall-clock cadence.

### The fidelity bar (decided)

**Byte-identical to the deployed game.** The bot must drive the **same protocol
class the human `usePvp*` hook uses**, so settlements are indistinguishable. The
frontend protocol is the source of truth — **not** the SDK base protocols, which
are treated as a parallel/preference implementation and are *not* authoritative
for the fleet.

### Verified starting state

| Game | Real wire protocol (human hook) | Headless bot brain that exists | Bot vs human settlement today |
|---|---|---|---|
| quantum-poker | `QuantumPokerProtocol` (SDK, shared by hook) | `QuantumPokerPersonaDriver` (per-seat, full betting + plumbing) | **byte-identical** ✅ |
| tic-tac-toe | `MultiGameTicTacToeProtocol` (`…multi.v1`) | `optimalMoves`/`pickCell` minimax | distinguishable (fleet drives SDK `…v1`) |
| blackjack | `BlackjackBetProtocol` (`…bet.v1`, variable bet) | basic strategy + `handValue` | distinguishable (fleet drives SDK `…v1`) |
| battleship | `BattleshipProtocol` (`…v1`) | `pickShot` + `selfPlay.ts` (owns **both** fleets) | no headless bot exists |

All four FE protocol classes are **pure TypeScript** (no React) and already
`implement` the SDK `Protocol<State, Move>` interface. The blocker was never React
coupling — it was that the headless fleet imported the wrong (SDK) classes, the
bot brains have four different signatures, and battleship has no registry entry
and a both-fleets-only driver.

## Decision — Approach A: per-game `GameKit` adapter + registry

Each game exports one small, pure-TS **adapter** that wraps its *existing* FE
protocol and *existing* AI behind a uniform contract. A central registry maps a
game id to its kit. A future driver — browser or Node — consumes only the
registry and stays game-agnostic.

Approach A was chosen over (B) canonicalizing at the React-hook level — which
ties scripting to browser infra and can't be driven from a light Node script —
and (C) extracting each game into a standalone core package — a large refactor of
code owned by four people, over-built for "preparation".

## The contract

```ts
type GameId = "tictactoe" | "blackjack" | "battleship" | "quantum-poker";

interface BotContext {
  rng: () => number;        // injected so play is reproducible in tests
  // (per-game tuning — difficulty, persona — may be added by a kit as needed)
}

interface GameKit<S, M> {
  id: GameId;
  protocol: Protocol<S, M>;                       // the REAL FE class the human hook uses
  createBot(seat: Party, ctx: BotContext): GameBot<S, M>;
  defaultStake: bigint;
}

interface GameBot<S, M> {
  next(state: S): M | null;   // this seat's next legal move, or null = "not my turn / waiting on peer"
}
```

### Invariants (these are what make it correct, not just uniform)

- **`protocol` is the FE class.** Never the SDK base class. A test asserts each
  kit's `protocol.name`/domain equals the domain the human `usePvp*` hook drives.
- **`createBot` is per-seat and stateful.** It generates and holds *only its own*
  secret (battleship fleet, poker slots) and memory (battleship targeting). It
  must never need the opponent's secret — that is what lets one bot instance be
  one seat in a genuine `wallet_i` vs `wallet_j` tunnel ([ADR-0006](../../decisions/0006-genuine-two-party-only-drop-self-play.md)).
- **`next(state)` covers every move kind this seat emits** — not just the "game"
  move: tic-tac-toe's advance trigger, blackjack's `bet` and next-hand,
  battleship's `commit`/`reveal`/`shoot`, poker's commit/reveal/bet/`next_hand`.
  It returns `null` when it is the other seat's turn or it is waiting on a peer
  reveal.
- **`next` is a pure function** of this seat's view of `state` plus the bot's own
  retained secret/memory and `ctx.rng`. No global state, no peer secret.

## Where it lives

Frontend-side — **not** the SDK (matches "don't rely on the SDK"; keeps upstream
`sui-tunnel-ts` clean per the repo convention):

- `frontend/src/agent/gameKit.ts` — the `GameKit` / `GameBot` / `BotContext`
  types and the `GAME_KITS` registry.
- `frontend/src/games/<game>/agent/kit.ts` — each game owns its adapter inside its
  own directory, so the four authors keep their own style. The adapter only
  *wraps* existing code; it does not modify game internals.

**Node-importability is an acceptance criterion, not an afterthought.** A kit and
everything it transitively imports must load under `tsx` outside vite:
no `import.meta.env` reached at module top-level, no asset imports, and the `@/…`
path alias must be tsx-resolvable (blackjack's `bjBetProtocol` →
`@/games/blackjack/app/lib/bjCards`). If a transitive dep reaches for a
browser-only API, that file gets a tiny shim. This is the main variable that can
turn an otherwise-low game annoying — so each kit must prove it imports cleanly
under `tsx`.

## Per-game adapter plan

| Game | Effort | `protocol` | Wraps | Adapter work |
|---|---|---|---|---|
| quantum-poker | near-zero | `QuantumPokerProtocol` | `QuantumPokerPersonaDriver.chooseMove(state, rng)` | wrap `chooseMove` as `next`. Driver already per-seat, covers betting + plumbing + `next_hand`, returns `null` off-turn. |
| tic-tac-toe | low | `MultiGameTicTacToeProtocol` | `optimalMoves`/`pickCell` | `next`: inner not terminal → `{cell: pickCell(...)}`; inner terminal & session not terminal → any `TicTacToeMove` to advance (value ignored by `applyMove`). |
| blackjack | low | `BlackjackBetProtocol` | basic strategy + `handValue` | `next`: betting phase → pick a plausible bet from `BET_OPTIONS` clamped to balance; player phase → hit `< 17` else stand; handle next-round. Play whichever seat is to act (`getPlayerParty(round)`). |
| battleship | **moderate** | `BattleshipProtocol` | `pickShot`, `merkle`, `fleet` | refactor `selfPlay.ts` from owning **both** fleets to a **per-seat** bot: generate only this seat's fleet, hold its secret + targeting memory; `next` emits `commit` (if not committed), truthful `reveal` (if a shot is pending against me), or `{type:"shoot", cell: pickShot(...)}`; else `null`. No new algorithms; reuses the commit-reveal design in `battleship/protocol/battleship.ts`. |

The shared one-time cost is `gameKit.ts` (types + registry) plus a local two-bot
test harness.

## Driver / data flow (contract fixed now, build deferred)

The contract is shaped so the future driver — Playwright-in-browser or a light
Node script — is the same handful of game-agnostic lines:

```
kit = GAME_KITS[gameId]
bot = kit.createBot(mySeat, ctx)            // genuine two-party: ONE bot per instance
on each confirmed state update:
  move = bot.next(state)
  if (move) tunnel.propose(move, mySeat)        // no artificial delay — as fast as co-sign allows
when protocol.isTerminal(state): settle root-anchored, exactly as a human
```

- **Genuine two-party** ([ADR-0006](../../decisions/0006-genuine-two-party-only-drop-self-play.md)):
  each fleet instance creates **one** bot for **one** seat and proposes only on
  its turn (`next` returns `null` otherwise). Hidden-info games therefore work
  because each instance knows only its own secret.
- **Local self-play harness** (tests only): one process creates **both** bots
  over a loopback tunnel and drives to terminal. Same kit, same contract — only
  the harness differs, and the harness is the deferred infra.
- **No cadence.** Bots emit the next move as soon as the prior one co-signs, so a
  lane runs at max throughput — a human pace could never hit the target TPS.
  Realism is the *correct move order*, which per-seat `next` + protocol legality
  already guarantee; timing is intentionally not modeled.

## Superseded path (flagged, not deleted)

This makes the SDK-protocol fleet path **non-canonical**.
`sui-tunnel-ts/scripts/agentFleet.mjs` (drives SDK `TicTacToeProtocol`) and the
`createBehaviorProtocol` → SDK-class mapping no longer represent "what a bot
drives". The `GAME_KITS` registry is canonical. We do **not** delete the SDK
fleet/protocols here (out of scope) — they are flagged for later cleanup so there
are not two competing answers to "what does a bot drive".

## Out of scope

- The fleet driver, multi-tunnel pooling, random-game-from-pool selection (the
  existing `AgentSwarm`/`Matchmaker` already covers most of this and is wired
  later against the registry).
- Browser-vs-Node execution choice and any AWS/Playwright infra.
- Deleting or migrating the SDK base protocols.
- Mainnet.

## Testing (verifies intent, not just behavior)

- **Domain-tag parity** *(the important one)*: each kit's `protocol` produces the
  same domain / `encodeState` shape as the corresponding human `usePvp*` hook.
  Fails loudly if a kit is pointed at an SDK base class.
- **Move legality**: two local bots driven to terminal never produce a move that
  `protocol.applyMove` rejects, and `balances(state).a + b` always equals the
  locked total at every step.
- **Full game to settlement**: a local two-bot harness drives each game to
  `isTerminal` and builds a cooperative-close root — proving the kit alone is
  enough to play and settle a real game headlessly.
- **Import hygiene**: each `kit.ts` imports and runs under `tsx` (no browser-only
  deps). Asserted by the harness running outside vite.

Tests are named by behavior (the name is the spec, the body is the proof).

## Acceptance criteria (per game)

1. `GAME_KITS[id].protocol` matches the deployed human hook's protocol domain.
2. `createBot(seat, ctx)` drives that seat to a legal `isTerminal` in the two-bot
   harness, with conserved balances.
3. The kit module imports cleanly under `tsx` (no browser-only deps).
4. The sequence of moves `next` produces forms a legal, complete game — no
   illegal or out-of-order move (the realism property).

## Risks

- **Import hygiene** is the main variable (see "Where it lives"). It is bot-logic
  that's easy; transitive browser-only imports are the thing to watch.
- **Battleship per-seat refactor** must keep reveals truthful (Merkle proofs valid
  against the committed root) — covered by the legality + full-game tests.
