# Canonical Game Bot Kit — design

**Date:** 2026-06-19 · **Status:** proposed · **Scope:** preparation only (no fleet/infra)

## Problem

We want a flow of **bot-vs-bot** matches, generated on our server, whose on-chain
and relay footprint **looks exactly like humans playing the real shipped game**.
Four games (tic-tac-toe, blackjack, battleship, quantum-poker) were each built by
a different person, so the bot/auto-play surface diverges per game. A future
dev-server script must drive *any* game in a pool of tunnels uniformly — so the
per-game divergence has to be hidden behind one canonical contract first.

This spec covers **only that preparation** — the contract each game conforms to,
plus the minimal local two-bot test harness needed to prove the contract works.
It does **not** build the production fleet driver, multi-tunnel pooling, or any
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

## Stakeholders

| Stakeholder | Interest in this spec | Approval needed |
|---|---|---|
| Game authors (ttt / blackjack / battleship / poker) | Own `frontend/src/games/<game>/agent/kit.ts` and keep bot logic correct | Yes — per-kit acceptance |
| Fleet/driver author | Consumes `GAME_KITS` registry in the future driver | Yes — contract is usable |
| Protocol/audit reviewer | Verifies on-chain settlements are indistinguishable from human play | Yes — domain-tag parity |
| `sui-tunnel-ts` upstream maintainer | Confirms the SDK stays untouched | Advisory |

## Success metrics

- **Domain parity:** 100% of kits use the same protocol domain / `encodeState` shape as the corresponding human `usePvp*` hook.
- **Move legality:** 0 rejected moves per 1,000 full two-bot games per kit.
- **Balance conservation:** `balances(state).a + balances(state).b` equals the locked total at **every** step of every test game.
- **Import hygiene:** every `kit.ts` loads under `tsx` with no browser-only transitive dependencies.
- **Throughput readiness:** the contract supports max-throughput play with no artificial delay (validated per-lane once the deferred driver is built).

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
type StateHash = string;   // opaque digest of a protocol state; used for idempotency

interface BotContext {
  rngForSeat(seat: Party): () => number;   // per-seat, seeded, reproducible stream
  // (per-game tuning — difficulty, persona — may be added by a kit as needed)
}

interface GameKit<S, M> {
  id: GameId;
  protocol: Protocol<S, M>;                       // the REAL FE class the human hook uses
  stateHash(state: S): StateHash;                 // stable digest for idempotency checks
  createBot(seat: Party, ctx: BotContext): GameBot<S, M>;
  defaultStake: bigint;
}

interface GameBot<S, M> {
  // Purely decide this seat's next move given its view of the confirmed state.
  // Returns null when it is the other seat's turn or it is waiting on a peer reveal.
  plan(state: S): M | null;

  // Advance the bot's retained memory AFTER the move returned by plan() has been
  // accepted by the protocol / co-signer. This keeps the bot's internal state in
  // sync with the on-chain/relay state even if a proposal is rejected or dropped.
  confirm(state: S, move: M): void;

  // Tear down / reset the bot after an error or when the tunnel closes uncleanly.
  // The driver calls this before discarding the bot.
  abort(): void;
}
```

### Seat-scoped view (hidden-info games)

For games with secrets, `S` itself is the **public** protocol state visible to
both seats; the bot's private secret (fleet, hole slots, etc.) lives in the
`GameBot` instance created by `createBot`. The contract forbids passing the
opponent's secret into `plan()`. Where a game protocol currently exposes hidden
state inside `S`, the adapter must filter it to a `SeatView<S>` before calling
its internal AI. A test asserts that no kit's `plan()` reads opponent-hidden
fields.

### Invariants (these are what make it correct, not just uniform)

- **`protocol` is the FE class.** Never the SDK base class. A test asserts each
  kit's `protocol.name`/domain equals the domain the human `usePvp*` hook drives.
- **`createBot` is per-seat and stateful.** It generates and holds *only its own*
  secret (battleship fleet, poker slots) and memory (battleship targeting). It
  must never need the opponent's secret — that is what lets one bot instance be
  one seat in a genuine `wallet_i` vs `wallet_j` tunnel ([ADR-0006](../../decisions/0006-genuine-two-party-only-drop-self-play.md)).
- **`plan(state)` covers every move kind this seat emits** — not just the "game"
  move: tic-tac-toe's advance trigger, blackjack's `bet` and next-hand,
  battleship's `commit`/`reveal`/`shoot`, poker's commit/reveal/bet/`next_hand`.
  It returns `null` when it is the other seat's turn or it is waiting on a peer
  reveal.
- **`plan` is a pure function** of this seat's view of `state` plus the bot's own
  retained secret/memory and its per-seat RNG. No global state, no peer secret.
- **`confirm` is the only place bot memory advances.** It is called only after a
  move has been accepted by the protocol. Until `confirm` runs, the same state
  hash replayed must produce the same move (determinism).

## Where it lives

Frontend-side — **not** the SDK (matches "don't rely on the SDK"; keeps upstream
`sui-tunnel-ts` clean per the repo convention):

- `frontend/src/agent/gameKit.ts` — the `GameKit` / `GameBot` / `BotContext`
  types and the `GAME_KITS` registry.
- `frontend/src/agent/games/<game>/kit.ts` — each game owns its adapter in a
  dedicated, import-hygienic directory. The adapter only *wraps* existing code;
  it does not modify game internals.

**Boundary rule:** a kit module and everything it transitively imports may only
reach into pure-TS game logic under `frontend/src/games/<game>/lib/` (or the
existing equivalent). Imports from `app/`, `components/`, `hooks/`, assets, or any
browser-only module are forbidden and enforced by CI (e.g., a lightweight eslint
rule or an `import-no-restricted-paths` check). If a required helper currently
lives in a browser-only file, extract the pure part to `lib/` or add a tiny shim
— do not import the browser file.

**Node-importability is an acceptance criterion, not an afterthought.** A kit and
everything it transitively imports must load under `tsx` outside vite:
no `import.meta.env` reached at module top-level, no asset imports, and the `@/…`
path alias must be tsx-resolvable (blackjack's `bjBetProtocol` →
`@/games/blackjack/app/lib/bjCards`). Each kit must prove it imports cleanly
under `tsx`.

## Per-game adapter plan

| Game | Effort | `protocol` | Wraps | Adapter work |
|---|---|---|---|---|
| quantum-poker | near-zero | `QuantumPokerProtocol` | `QuantumPokerPersonaDriver.chooseMove(state, rng)` | wrap `chooseMove` as `plan`. Driver already per-seat, covers betting + plumbing + `next_hand`, returns `null` off-turn. `confirm` advances any internal hand/round memory only after the move co-signs. |
| tic-tac-toe | low | `MultiGameTicTacToeProtocol` | `optimalMoves`/`pickCell` | `plan`: inner not terminal → `{cell: pickCell(...)}`; inner terminal & session not terminal → any `TicTacToeMove` to advance (value ignored by `applyMove`). `confirm` is a no-op because there is no retained memory. |
| blackjack | low | `BlackjackBetProtocol` | basic strategy + `handValue` | `plan`: betting phase → pick a plausible bet from `BET_OPTIONS` clamped to balance; player phase → hit `< 17` else stand; handle next-round. Play whichever seat is to act (`getPlayerParty(round)`). `confirm` updates the bot's copy of the round only after the move is accepted. |
| battleship | **moderate** | `BattleshipProtocol` | `pickShot`, `merkle`, `fleet` | refactor `selfPlay.ts` from owning **both** fleets to a **per-seat** bot: generate only this seat's fleet, hold its secret + targeting memory; `plan` emits `commit` (if not committed), truthful `reveal` (if a shot is pending against me), or `{type:"shoot", cell: pickShot(...)}`; else `null`. `confirm` advances targeting memory only after the move co-signs. No new algorithms; reuses the commit-reveal design in `battleship/protocol/battleship.ts`. |

The shared one-time cost is `gameKit.ts` (types + registry) plus a local two-bot
test harness.

## Driver / data flow (contract fixed now, production driver deferred)

The contract is shaped so the future production driver — Playwright-in-browser or
a light Node script — is the same handful of game-agnostic lines:

```
kit = GAME_KITS[gameId]
bot = kit.createBot(mySeat, ctx)            // genuine two-party: ONE bot per instance
lastActedHash: StateHash | null = null

on each confirmed state update with state S:
  h = kit.stateHash(S)
  if (h === lastActedHash) return           // idempotency: already acted on this state

  move = bot.plan(S)
  if (move === null) return                 // not my turn / waiting on peer

  result = tunnel.propose(move, mySeat)
  if (result === accepted):
    bot.confirm(S, move)
    lastActedHash = h
  else if (result === rejected || timeout):
    // Do not confirm. Re-plan from the next confirmed state when it arrives.
    log(result)
  else if (result === channelClosed):
    bot.abort()
    teardown()

when protocol.isTerminal(state): settle root-anchored, exactly as a human
```

- **Genuine two-party** ([ADR-0006](../../decisions/0006-genuine-two-party-only-drop-self-play.md)):
  each fleet instance creates **one** bot for **one** seat and proposes only on
  its turn (`plan` returns `null` otherwise). Hidden-info games therefore work
  because each instance knows only its own secret.
- **Local self-play harness** (tests only, in scope): one process creates **both**
  bots over a loopback tunnel and drives to terminal. Same kit, same contract —
  only the harness differs. The production fleet driver is still deferred.
- **No cadence.** Bots emit the next move as soon as the prior one co-signs, so a
  lane runs at max throughput — a human pace could never hit the target TPS.
  Realism is the *correct move order*, which per-seat `plan` + protocol legality
  already guarantee; timing is intentionally not modeled.

## Failure modes & timeouts

Even though the production driver is deferred, the contract must behave sensibly
when things go wrong:

- **Rejected move.** `tunnel.propose` may return `rejected` if the move is illegal
  in the current state. The driver must **not** call `confirm`. It waits for the
  next confirmed state and calls `plan` again. A bot that repeatedly proposes
  rejected moves is a bug in the kit.
- **Timeout / unresponsive peer.** If a co-sign or opponent move does not arrive
  within a tunable timeout, the driver may close the tunnel via the normal
  dispute/timeout path and call `bot.abort()`. The exact timeout is driver-level
  config, not part of `GameBot`.
- **Channel closed.** On `channelClosed` the driver calls `bot.abort()` and tears
  down. The bot must release any memory and must not throw.
- **Replayed state.** The driver must track `lastActedHash` and skip `plan` when
  the same confirmed state is delivered twice.

## Superseded path (flagged, not deleted)

This makes the SDK-protocol fleet path **non-canonical**.
`sui-tunnel-ts/scripts/agentFleet.mjs` (drives SDK `TicTacToeProtocol`) and the
`createBehaviorProtocol` → SDK-class mapping no longer represent "what a bot
drives". The `GAME_KITS` registry is canonical. We do **not** delete the SDK
fleet/protocols here (out of scope) — they are flagged for later cleanup so there
are not two competing answers to "what does a bot drive".

## Out of scope

- The production fleet driver, multi-tunnel pooling, random-game-from-pool selection (the
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
- **Full game to settlement**: the local two-bot harness drives each game to
  `isTerminal` and builds a cooperative-close root — proving the kit alone is
  enough to play and settle a real game headlessly.
- **Import hygiene**: each `kit.ts` imports and runs under `tsx` (no browser-only
  deps). Asserted by the harness running outside vite.
- **Idempotency**: replaying the same confirmed state twice does not produce a
  duplicate move.
- **Rejected-move safety**: if `tunnel.propose` returns `rejected`, the bot's
  internal memory is unchanged and the next confirmed state produces a legal move.

Tests are named by behavior (the name is the spec, the body is the proof).

## Acceptance criteria (per game)

1. `GAME_KITS[id].protocol` matches the deployed human hook's protocol domain.
2. In the local two-bot harness, the pair of `createBot(seat, ctx)` instances
   drive the game to a legal `isTerminal` state, and `balances(state).a + b`
   equals the locked total at every step.
3. The kit module imports cleanly under `tsx` (no browser-only deps).
4. The sequence of moves `plan` produces forms a legal, complete game — no
   illegal or out-of-order move (the realism property).
5. Replaying a confirmed state does not produce a duplicate move.
6. After a rejected proposal, the bot's next `plan` still produces a legal move.

## Risks

- **Import hygiene** is the main variable (see "Where it lives"). It is bot-logic
  that's easy; transitive browser-only imports are the thing to watch. Mitigated
  by the `frontend/src/agent/games/` boundary rule and CI check.
- **Battleship per-seat refactor** must keep reveals truthful (Merkle proofs valid
  against the committed root) — covered by the legality + full-game tests.
- **Stateful-bot desync** if `confirm` is called before the move is truly
  accepted. Mitigated by the driver contract: `confirm` runs only on
  `result === accepted`.
