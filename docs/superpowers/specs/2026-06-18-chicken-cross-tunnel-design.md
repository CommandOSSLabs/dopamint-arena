# Chicken Cross — arena self-play over a Sui tunnel (design)

**Date:** 2026-06-18
**Status:** Approved (design); implementation pending
**Author:** session with realestzan

## 1. Goal

Add **Chicken Cross** as a fully-wired arena game that plays over a _real_ on-chain Sui
tunnel, parity with the existing self-play game (Blackjack). A wallet opens+funds two bot
seats in one signature; two bot chickens race across a lane grid; every tick is a
dual-signed off-chain state update; the winner is paid on-chain at cooperative close.

The reference game at `/Users/realestzan/Projects/code/dopamint/games/chicken-cross` is a
**standalone** Crossy-Road clone (Three.js + a Bun WebSocket server, "no `@dopamint/sdk` or
Move contracts"). It is used here as a **gameplay spec only** — lane layout, hazard kinds,
collision rules, respawn. Its architecture (Three.js scene, authoritative WS server, rooms)
is **not** ported. Chicken Cross bends to the arena; never the reverse.

## 2. Scope

**In scope (this build):**

- One SDK protocol class `CrossProtocol` in `sui-tunnel-ts/src/protocol/cross.ts`.
- One frontend game folder `frontend/src/games/chickenCross/` (self-play, blackjack-shaped).
- One import line in `frontend/src/games/index.ts`.
- Unit tests for the protocol and the pure session core.

**Out of scope (explicitly deferred):**

- **Human PvP** (the tic-tac-toe `DistributedTunnel` + `MpClient` path). Designed for in §11,
  built later as an additive second hook reusing the same `CrossProtocol`.
- **Casino cashout / multiplier economy** (Stake-style "Chicken"). Different `applyMove`/
  `balances`; not this build.
- **Three.js rendering.** Arena-native 2D React/CSS, consistent with Blackjack/TTT.
- **Backend changes.** The control-plane (`tunnel-manager`) is already game-agnostic — a new
  game is just a new `game` string. Zero Rust edits.
- **Move changes.** `sui_tunnel::tunnel` is a generic 2-party state channel; all games settle
  through the same generic entry functions. Zero Move edits. No `example_chicken_cross.move`.

## 3. Constraints (load-bearing arena facts)

- **`OffchainTunnel.step(move, by)` asserts `balanceA + balanceB === total` every step.** The
  protocol must conserve the locked total in _every_ reachable state.
- **Settlement balances come from `protocol.balances(finalState)`.** To pay the winner, the
  terminal state's balances must be `(total, 0)` or `(0, total)`.
- **`buildSettlement(createdAt)` uses `finalNonce = onchainNonce + 1` with `onchainNonce = 0`**
  — correct only because self-play never submits an on-chain `update_state` (cooperative close
  only). We follow the blackjack path exactly: no on-chain `update_state`, `finalNonce = 1`.
- **Settlement timestamp must be `>= tunnel.created_at`.** The hook reads `created_at` via
  `readCreatedAt` and passes it to `buildSettlement`, same as blackjack.
- **`encodeState` must be canonical** (same state → same bytes) — it is hashed (blake2b256)
  into the tunnel `state_hash` that both signatures cover.
- **`PACKAGE_ID` must be defined before any on-chain builder runs** (vite `define` already
  injects it for the arena; we reuse the shared `onchain/tunnelTx.ts`, so no new glue).

## 4. Architecture

```
sui-tunnel-ts/src/protocol/
  cross.ts            CrossProtocol<CrossState, CrossMove>  (NEW)
  cross.test.ts       determinism, collision, balance, termination tests (NEW)
  index.ts            + export * from "./cross"  (1 line)

frontend/src/games/chickenCross/                     (NEW folder)
  index.ts            register({ id:"chicken-cross", name:"Chicken Cross", icon:"🐔", Window })
  ChickenCrossWindow.tsx   status router (idle→BetPanel, funding, playing/settled→Board, error)
  useChickenCrossSession.ts  self-play hook (copy of useBlackjackSession.ts)
  session-core.ts     pure stepSession / deriveView / sessionResult  (type-only SDK imports)
  session-core.test.ts
  components/
    BetPanel.tsx      stake input → onStart(stake)
    CrossBoard.tsx    2D lane grid from deriveView; win banner; Play Again
  cross.css           arena-themed styles (reuses arena-* Tailwind tokens)

frontend/src/games/index.ts   + import "./chickenCross";  (1 line; position = tiling order)
```

Reused unchanged (imported by the hook): `frontend/src/onchain/tunnelTx.ts`
(`openAndFundSelfPlay`, `readCreatedAt`, `closeCooperative`), `frontend/src/backend/controlPlane.ts`
(`getControlPlaneClient`), `frontend/src/telemetry/TelemetryProvider.tsx` (`useTelemetry`),
`sui-tunnel-ts/core/tunnel` (`OffchainTunnel`), `sui-tunnel-ts/core/keys` (`createParticipant`).

## 5. The CrossProtocol

A discrete, deterministic, replayable reformulation of the reference sim — the one piece of
real engineering. Models the reference's continuous 25 Hz world as **per-tick deterministic
hazard positions**, so it fits the turn-based dual-signed channel.

```ts
export interface CrossPlayer {
  lane: number; // 0 = spawn, increasing = forward; furthest progress is `score`
  col: number; // integer column 0..COLUMN_COUNT-1
  alive: boolean; // false only transiently within a tick; respawns same tick
  score: number; // max lane reached this run (survives respawn)
  invulnTicks: number; // post-respawn collision immunity, counts down
}

export interface CrossState {
  tick: bigint; // advances by 1 each applyMove; drives hazard positions
  seed: bigint; // hazard RNG seed, derived from tunnelId at initialState
  players: [CrossPlayer, CrossPlayer]; // index 0 = A, 1 = B
  winner: Party | null; // set when a player reaches WIN_LANE (or tick cap → furthest)
  balanceA: bigint;
  balanceB: bigint;
  total: bigint;
}

// One tick command. Each side's intended hop for this tick (or undefined = stay).
export interface CrossMove {
  dirA?: CrossDir; // "north" | "south" | "east" | "west"
  dirB?: CrossDir;
}
```

**`applyMove(state, move, by)`** (pure) advances the world exactly one tick:

1. `tick' = tick + 1`.
2. For each player, if a `dir` is given and the destination cell is **not** known-lethal at
   `tick'` and the player is not invuln-blocked, apply the hop (clamp col to `0..8`, lane `>= 0`).
   _(Mirrors the reference: you cannot voluntarily hop into a known-lethal cell.)_
3. **Log carry** on water lanes runs _before_ the death check (a log can rescue you that tick):
   a player standing on an overlapping log is carried by the log's per-tick column delta.
4. **Collision / respawn:** for each player past invuln, if its cell is lethal at `tick'`
   (grass safe; road/rails lethal on hazard overlap; **water inverted** — open water kills,
   a log saves), respawn to `(lane 0, col SPAWN_COL)` and set `invulnTicks = RESPAWN_INVULN`.
   `score = max(score, lane)`.
5. **Win:** if any player's lane `>= WIN_LANE`, set `winner` and move balances all-to-winner.
6. **Tick cap:** if `tick' >= TICK_CAP` and no winner, the player with the higher `score`
   wins (ties → push, balances unchanged); guarantees termination.

`by` is attribution for the engine's co-sign flow; `applyMove` updates the whole world (both
players) deterministically — self-play alternates/loops `by` like blackjack.

**Hazard function** `hazardsAt(seed, laneIndex, tick) → occupied spans`, pure:

- `laneKind(L)`: `L < 2` → grass; else `(L-2) % 6` → `{0,1: road, 2: water, 3: rails, 4,5: grass}`
  (exactly the reference cycle).
- Per hazardous lane, a seeded `mulberry32(seed ⊕ laneIndex)` fixes phase/speed/width/count;
  position at `tick` = `(phase + tick * speed) mod COLUMN_COUNT` (wraps). Road = 1–2 narrow
  cars; water = 1–2 wide logs (platforms); rails = 1 very wide train.
- `isLethal(seed, col, lane, tick)`: grass=false; road/rails = any hazard span covers `col`;
  water = **NOT** (any log span covers `col`). Overlap uses the reference's strict-exclusive
  center test (chicken center = `col + 0.5`).

**`encodeState`** — canonical bytes: `DOMAIN || u64be(tick) || u64be(seed) || u64be(balanceA)
|| u64be(balanceB)`, then per player `u64be(lane) || u64be(col) || u8(alive) || u64be(score)
|| u64be(invulnTicks)`, then `u8(winnerCode)` (0=none,1=A,2=B). All integers big-endian,
fixed-order — same pattern as `blackjack.encodeState`.

**`balances`** returns `(balanceA, balanceB)` — `(S, S)` for every non-terminal state, flipped
to `(total, 0)` / `(0, total)` only at the winning tick. Always sums to `total`.

**`isTerminal`** = `winner !== null`. **`randomMove(state, by, rng)`** = greedy bot: prefer
`north` if the cell ahead is safe at `tick+1`; else dodge to a safe `east`/`west`; else stay.

**Determinism:** state is a pure function of `(seed, ordered move list)`. `seed` lives in
state and in `encodeState`, so an on-chain disputer (or the PvP counterparty later) replays
identically. _This is the property that makes the game tunnel-settleable._

## 6. Game → tunnel mapping

| Game concept                                         | Tunnel mechanism                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| One world tick (hazards advance + both bots may hop) | one `tunnel.step(move, by)` → one dual-signed `state_update`                                |
| Both bots stake `S`                                  | `openAndFundSelfPlay({ aAmount: S, bAmount: S })` → locked total `2S`                       |
| Race in progress                                     | `balances = (S, S)`, conserved every tick                                                   |
| A bot reaches `WIN_LANE`                             | terminal state with `balances = (2S, 0)` to the winner                                      |
| Settle                                               | `buildSettlement(createdAt)` (finalNonce 1) → `closeCooperative` → winner's seat holds `2S` |

Each tick is a real co-signed update — so a Chicken Cross session contributes genuine
throughput to the live TPS panel, same as blackjack rounds.

## 7. Self-play flow (mirrors `useBlackjackSession.ts` exactly)

1. `start(stake)`: guard `useCurrentAccount()`; `signExec` wraps `useSignAndExecuteTransaction`;
   `reads = client`.
2. `a = createParticipant("chicken-a"); b = createParticipant("chicken-b");
protocol = new CrossProtocol()`.
3. `status = "funding"`: `tunnelId = await openAndFundSelfPlay({ reads, signExec, partyA, partyB,
aAmount: stakeBig, bAmount: stakeBig })`; `createdAt = await readCreatedAt(reads, tunnelId)`.
4. `tunnel = OffchainTunnel.selfPlay(protocol, tunnelId, a.keyPair, b.keyPair, a.address,
b.address, { a: stakeBig, b: stakeBig })`; wire `tunnel.onUpdate = (_u, bytes) =>
report.bumpCounters({ updates:1, signatures:2, verifications:2, bytes })` **before** the first step.
5. `report.setActive(2)`, `report.bumpCounters({ tunnelsOpened:1 })`, `setView(deriveView(tunnel.state))`,
   `status = "playing"`.
6. Best-effort `getControlPlaneClient().registerSession({ userAddress, game:"chicken-cross",
tunnels:[{ tunnelId, partyA:a.address, partyB:b.address }] })` (`.catch(log)`); aggregated
   `sendHeartbeat` ~1/s (windows `< 1000ms` skipped, force-flush before settle).
7. `setInterval(STEP_MS)`: `stepSession(protocol, tunnel, Math.random)` →
   `protocol.randomMove(state, by, rng)` then `tunnel.step(move, by)`; re-derive view; on a
   position/score change push a telemetry txn; `flushHeartbeat(false)`. When
   `protocol.isTerminal(state)` (or no move): stop timer, `flushHeartbeat(true)`, settle.
8. `settleOnChain`: `status="settling"`; `setResult(sessionResult(...))`;
   `settlement = tunnel.buildSettlement(createdAt)`; `await closeCooperative({ signExec,
tunnelId, settlement })`; `status="settled"`; `report.bumpCounters({ tunnelsClosed:1,
settlements:1 })`, `report.setActive(0)`. Wrapped in try/catch → `status="error"`.

`STEP_MS` ~ 250–400 ms (faster than blackjack's 900 ms — chicken hops are quick).

## 8. Rendering

`CrossBoard` is pure presentation over `deriveView(state)`:

- A vertical strip of lanes (`WIN_LANE + a few` rows), newest/forward lane at top.
- Each lane row colored by kind (grass/road/water/rails) with hazard cells marked at their
  `tick` positions; two chicken tokens (🐔) at `(lane, col)`, distinct accent per side.
- Hazards may animate cosmetically between ticks (CSS transition); **the renderer never
  decides outcomes** — the protocol is the sole authority.
- Win banner shows the winning side + final balances; "Play Again" calls `reset`.

`deriveView(state): CrossView` flattens bigints → numbers and exposes lanes, hazard spans,
both players' `(lane, col, score, alive)`, `winner`, balances.

## 9. Backend / control-plane integration

Zero backend code. The hook registers the session with `game: "chicken-cross"` and sends
coarse aggregated heartbeats — the generic control-plane keys per-game counters by that string
and the game appears in the dashboard automatically. Every backend call is best-effort
(`.catch(console.error)`); a dead backend never blocks play (ADR-0002).

## 10. Testing

- `cross.test.ts` (node:test via tsx, runtime SDK imports allowed here):
  - **Determinism:** same `seed` + same move sequence ⇒ identical `encodeState` bytes.
  - **Collision rules:** grass safe; car/train overlap lethal; **water inverted** (open water
    kills, log saves); **log carry runs before death** (a log rescues on the entry tick);
    respawn resets to spawn with `invulnTicks = RESPAWN_INVULN`.
  - **Balance conservation:** `balanceA + balanceB === total` for every state across a long
    random playout (the invariant `OffchainTunnel.step` enforces).
  - **Termination & payout:** every random playout reaches `isTerminal` within `TICK_CAP`, and
    the terminal `balances` pay the full `total` to exactly one side (or push on a score tie).
- `session-core.test.ts`: `stepSession` advances and reports terminal; `sessionResult` maps
  balances → win/lose/push; type-only SDK imports so it runs without Vite.
- Gates: `cd sui-tunnel-ts && pnpm test`; `cd frontend && pnpm typecheck`. The on-chain hook
  is exercised end-to-end against testnet manually.

## 11. Faithfulness & deferred PvP

**Refactor vs reference (authorized):** we drop continuous real-time hazard motion for
per-tick deterministic positions; game _feel_ is preserved by cosmetic animation, game _truth_
is discrete, replayable, and dual-signable. We drop the WS server, rooms, and Three.js
entirely. We keep: lane cycle, hazard kinds, water-inverted + log-carry semantics, "can't hop
into a known-lethal cell", respawn+invuln, furthest-lane scoring, race-to-a-fixed-lane win.

**PvP later (additive, same `CrossProtocol`):** a `useChickenCrossPvp.ts` hook mirroring
`usePvpTicTacToe.ts` — ephemeral key, `MpClient.quickMatch("chicken-cross")`, seat A
`openAndFundSharedTunnel` + seat B `depositStake`, `DistributedTunnel` exchanging each side's
`dir` per tick; both replay the shared seed-driven sim to agree on collisions (the seed becomes
a two-party commit-reveal for fairness). No protocol or Move changes needed — only a new hook
and a new game-id queue string (already supported by the backend).

## 12. Risks

- **Tick model balance/feel:** too-fast hazards make a bot stall forever. Mitigation: greedy
  bot dodges, `TICK_CAP` guarantees termination, hazard density tuned via config constants.
- **`encodeState` growth:** state is fixed-size (2 players), so per-update cost is O(1); no
  rolling digest needed (unlike chat/poker).
- **@mysten/sui version skew / PACKAGE_ID:** already handled by the shared `onchain/tunnelTx.ts`
  - vite `dedupe`/`define`; we add no new on-chain glue, so we inherit the working setup.

```

```
