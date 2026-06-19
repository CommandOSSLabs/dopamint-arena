# Bomb It — PvP mode (design)

**Date:** 2026-06-19
**Status:** Approved (design); implementation pending
**Branch:** `feat/bomb-it-pvp` (off `feat/chicken-cross`; `main` lacks the PvP framework)

## 1. Goal & scope

Add **Bomb It** — a minimal Bomberman-style grid duel — as a **PvP-default** arena game over one
on-chain tunnel, winner takes the pot. Solo policy: **invite / 2-tabs only** — no bot fallback, per
the PvP-default policy in `docs/adding-a-tunnel-game.md`.

Two seats share a symmetric grid. Each tick a seat moves one cell **or** drops a bomb; bombs fuse
then explode in a `+` cross, destroying crates and killing any player in the blast (including its
owner). **Last player standing wins**; mutual death is a push. v1 scope is deliberately minimal:
**no power-ups**, one bomb per player, fixed blast radius.

Unlike Chicken Cross (which reused an existing protocol), Bomb It adds **one new SDK protocol**
(`BombItProtocol`) plus a frontend game package mirroring `frontend/src/games/chickenCross/`.
**No backend or Move changes** — both layers are game-agnostic and key off the game-id string.

## 2. Protocol — `BombItProtocol` (`sui-tunnel-ts/src/protocol/bombIt.ts`, name `"bomb_it.v1"`)

Implements `Protocol<BombItState, BombItMove>` (`sui-tunnel-ts/src/protocol/Protocol.ts`). Pure,
deterministic, winner-take-all — so the counterparty and an on-chain disputer replay identically.

### Constants

```
GRID_W = 9   GRID_H = 9   CELL_COUNT = 81
SPAWN_A = (row 1, col 1)   SPAWN_B = (row 7, col 7)
FUSE_TICKS = 8   BLAST_RADIUS = 2   MAX_BOMBS_PER_PLAYER = 1
CRATE_DENSITY = 0.75   BOMB_IT_TICK_CAP = 400n
STAKE = 500n (per seat; total 1000n)   BOMB_IT_MIN_STAKE = 100n
```

### State & Move

```ts
type BombItAction = "north" | "south" | "east" | "west" | "bomb" | "stay";

interface BombItPlayer { row: number; col: number; alive: boolean; }
interface BombItBomb   { row: number; col: number; fuse: number; owner: Party; }

interface BombItState {
  tick: bigint;
  seed: bigint;                          // seedFromTunnelId(tunnelId); part of encodeState
  grid: Uint8Array;                      // length 81; 0 floor · 1 wall · 2 crate
  players: [BombItPlayer, BombItPlayer]; // index 0 = A, 1 = B
  bombs: BombItBomb[];                   // ≤ 2 live (1 per player)
  winner: Party | "draw" | null;         // null = ongoing
  balanceA: bigint; balanceB: bigint; total: bigint;
}

interface BombItMove { a?: BombItAction; b?: BombItAction } // proposer fills only its own side

class BombItProtocol implements Protocol<BombItState, BombItMove> { readonly name = "bomb_it.v1"; }
```

### Board layout (deterministic, symmetric)

- `cell(r,c)` index = `r*9 + c`. **Wall** (`1`) if on the border (`r∈{0,8}` or `c∈{0,8}`) **or** an
  interior lattice pillar (`r∈{2,4,6}` **and** `c∈{2,4,6}`). Center `(4,4)` is a pillar.
- **Crates** (`2`) placed on remaining floor cells via `mulberry32(seed, cellIndex)` rolled against
  `CRATE_DENSITY`, **then mirrored 180°**: `(r,c)` mirrors `(8−r, 8−c)`. Generating the canonical
  half and mirroring makes the layout **identical for both seats regardless of seed** — this
  resolves the A-bias fairness footnote Chicken Cross carried; no commit-reveal needed (map is
  public, not hidden information).
- **Spawn-safe zone** kept crate-free so each player can drop and escape: A's `(1,1),(1,2),(2,1)`
  and (by symmetry) B's `(7,7),(7,6),(6,7)`.

### `applyMove(state, move, by)` — pure; one actor per call

The proposer's field (`a` for A, `b` for B) carries the action; the opposite seat is implicitly
`"stay"`. Throws on a terminal state or a malformed action. Order:

1. **Actor action.** `north/south/east/west` → move one cell if the target is in-bounds, not a
   wall/crate, not occupied by a live bomb, and not occupied by the other living player; otherwise a
   no-op. `"bomb"` → place a bomb on the actor's cell if it has `< MAX_BOMBS_PER_PLAYER` live bombs
   and the cell has none; the actor stays on it (dropping is legal even though the cell now holds a
   bomb — you simply cannot move *back onto* any bomb cell, including your own, once you leave).
   Soft-invalid actions resolve to a deterministic **no-op `"stay"`** so
   both seats re-derive the identical next state and co-sign — they never throw.
2. **World advance** (every call, after the action): decrement every bomb's `fuse`; collect the
   detonation set at `fuse ≤ 0` and grow it to a fixpoint (a bomb inside any blast detonates too);
   union all blast cells (each `+` arm extends `BLAST_RADIUS`, stopping at a wall and stopping *after*
   destroying the first crate); destroy crated blast cells (`2→0`), kill any player standing in a
   blast cell, remove detonated bombs.
3. `tick += 1n`.
4. **Terminal & balances.** With `aliveA/aliveB` after the blast: both dead → `winner="draw"`; only
   B dead → `"A"`; only A dead → `"B"`; else `tick ≥ BOMB_IT_TICK_CAP` → `"draw"`; else `null`. On a decisive
   winner, write `balanceA/balanceB` to `(total,0)` / `(0,total)`; a draw leaves `(STAKE,STAKE)`.

`balances(state)` returns `{a: balanceA, b: balanceB}` — `(STAKE,STAKE)` for the whole game, flipping
only on the killing tick, so the conservation invariant (`a+b===total`) holds at every reachable
state. `isTerminal(state) = state.winner !== null`. `randomMove` is provided (pick uniformly among
valid actions) to drive the simulator and protocol tests; it is not used by the PvP hook.

### `encodeState` — fixed-width, canonical (no length prefixes)

```
protocolDomain("bomb_it.v1")
  || u64be(tick) || u64be(seed) || u64be(balanceA) || u64be(balanceB)
  || grid[81 bytes]
  || per player { u64be(row) || u64be(col) || byte(alive: 0|1) }        // A then B
  || 2 fixed bomb slots { byte(active) || u64be(row) || u64be(col) || u64be(fuse) || byte(owner: A=0,B=1) }
  || byte(winner: none=0, A=1, B=2, draw=3)
```

Bombs occupy a fixed 2-slot array **indexed by owner** (slot 0 = A's live bomb or zero-padded,
slot 1 = B's), so the byte run is bounded, canonical, and order-independent of placement. All multi-byte integers are 8-byte big-endian via `u64ToBeBytes` — matching
the Move wire format (golden vectors at `sui_tunnel/tests/wire_format_tests.move`).

## 3. Constraints from the real engine (verified)

- `DistributedTunnel.propose(move, ts)` (`sui-tunnel-ts/src/core/distributedTunnel.ts`) is
  **half-duplex by nonce**: throws if a proposal is pending; `onMove` requires
  `frame.by !== selfParty` and `frame.nonce === nonce + 1`. ⇒ **exactly one seat proposes per
  nonce.**
- `onConfirmed(u)` fires on each co-signed update (ACK for the proposer, MOVE for the responder).
  `state` is confirmed (settlement/security); `displayState` shows the proposer's pending move
  pre-ACK (**render only**).
- `MpClient` (`frontend/src/pvp/mpClient.ts`) exposes `quickMatch(game)` (open queue keyed by the
  game string), `channel(matchId)` (engine `transport` + `sendPeer`/`onPeer`), `announceTunnel`. The
  earlier waiter is assigned role `A`.

## 4. Play model — alternate-proposer ping-pong (lockstep)

`BombItProtocol` advances the world one tick per call; the engine is one-proposer-per-nonce. Bridge
(same as Chicken Cross): **each seat proposes only on its turn, carrying only its own action; the
world advances each propose.** Because bomb fuses tick down on *every* world tick, the world must
keep advancing even while a player idles (so a placed bomb detonates) — this is the **continuous**
hook pattern (timer-driven), not the turn-gated tic-tac-toe pattern.

```
turn(nonce) = (nonce % 2 == 0) ? "A" : "B"        // A: nonce 0→1, B: 1→2, A: 2→3, ...
each seat keeps `nextAction`, default "stay"; arrow/WASD queues a move, space queues "bomb",
  consumed (reset to "stay") after the propose fires — no auto-forward (unlike Chicken Cross)
on my turn (after each onConfirmed, if turn(nonce) == selfParty and not terminal):
    after STEP_MS pacing:
      A: dt.propose({ a: nextAction }, 0n)         // B stays this tick
      B: dt.propose({ b: nextAction }, 0n)         // A stays this tick
responder re-applies the SAME BombItMove (deterministic) → matches → co-signs (ACK)
both re-render from dt.displayState via deriveView(...)
```

Each player acts on alternate world-ticks (fuses advance every tick); both get equal cadence. Pace
is round-trip-bound. `STEP_MS ≈ 250`. (A "both act every tick via a side-channel" variant is a
future refinement requiring an `mpClient` peer-message addition — out of scope.)

## 5. Lobby & matchmaking — invite code via private queue

No directed-challenge API exists; use a **per-match private queue name** (like Chicken Cross). No
backend change.

| Action | Flow |
| --- | --- |
| Create | generate a short code; `quickMatch("bomb-it:" + code)` parks first ⇒ this seat is `A` (opener/funder); show the code while awaiting `match.found` |
| Join | enter the code; `quickMatch("bomb-it:" + code)` ⇒ seat `B` |

Same machine = two tabs (one creates, one joins). Distinct on-chain stakes need two wallet accounts.

## 6. Match lifecycle (mirrors `usePvpChickenCross`)

```
1. ephemeral = generateKeyPair(); mp = new MpClient(resolveMpWsUrl(resolveBackendUrl()), wallet, ephemeral); await mp.connect()
2. match = await mp.quickMatch("bomb-it:" + code); role = match.role
3. channel = mp.channel(match.matchId); waitPeer = makeInbox(channel)         // copy makeInbox from chickenCross
4. exchange ephemeral pubkeys: sendPeer({t:"hello", ...}); oppPub = (await waitPeer("hello"))
5. fund: A → openAndFundSharedTunnel({partyA:{wallet, ephemeral.pub}, partyB:{opponentWallet, oppPub}, amount: STAKE})
            mp.announceTunnel(matchId, tunnelId); sendPeer({t:"open", tunnelId})
         B → tunnelId = (await waitPeer("open")).tunnelId; depositStake({tunnelId, amount: STAKE})
6. engine: proto = new BombItProtocol(); self = makeEndpoint(backend, wallet, ephemeral, true);
            opp = makeEndpoint(backend, opponentWallet, {publicKey: oppPub, scheme: ephemeral.scheme}, false);
            dt = new DistributedTunnel(proto, {tunnelId, self, opponent: opp, selfParty: role}, channel.transport, {a: STAKE, b: STAKE})
7. dt.onConfirmed = () => { render(); if terminal → settle once (guard); else if my turn → schedule propose }
8. readiness handshake (A awaits "ready", B sends "ready") AFTER dt is live — same as chickenCross
9. settle: createdAt = readCreatedAt(...); half = dt.buildSettlementHalf(createdAt, 0n);
            exchange halves over sendPeer/waitPeer("settleHalf"); co = dt.combineSettlement(...);
            role A → closeCooperative({tunnelId, settlement: co})
```

`STAKE` is a per-seat constant (MIST); winner-take-all is automatic from `BombItProtocol.balances`,
so no stake-shift parameter is needed (unlike tic-tac-toe).

## 7. Files

| File | Change |
| --- | --- |
| `sui-tunnel-ts/src/protocol/bombIt.ts` | NEW — `BombItProtocol` + types + constants + `seedFromTunnelId`/`mulberry32` helpers |
| `sui-tunnel-ts/src/protocol/bombIt.test.ts` | NEW — `tsx` unit tests: applyMove rules, fuse/blast/chain, win/draw/cap, encodeState determinism & symmetry |
| `sui-tunnel-ts/src/protocol/index.ts` | EDIT — add `export * as bombIt from "./bombIt"` alongside existing protocols |
| `frontend/src/games/bombIt/index.ts` | NEW — `register({ id: "bomb-it", name: "Bomb It", icon: "💣", Window: BombItWindow })` |
| `frontend/src/games/bombIt/BombItWindow.tsx` | NEW — status router: lobby → board → result; statuses idle/matching/funding/playing/settling/settled/error |
| `frontend/src/games/bombIt/usePvpBombIt.ts` | NEW — the PvP hook (continuous pattern: STEP_MS timer + scoped `maybePropose` + `reset()` and unmount teardown, per commit 8deb445) |
| `frontend/src/games/bombIt/session-core.ts` | NEW — pure, React-free `deriveView(state): BombItView` + view types (type-only SDK import so it runs under `tsx`) |
| `frontend/src/games/bombIt/session-core.test.ts` | NEW — `tsx` unit test of `deriveView` |
| `frontend/src/games/bombIt/components/BombLobby.tsx` | NEW — create/join-code screen |
| `frontend/src/games/bombIt/components/BombBoard.tsx` | NEW — 9×9 grid render from `deriveView(dt.displayState)`; arrows/WASD → dir, space → "bomb" → `nextActionRef` |
| `frontend/src/games/bombIt/bomb-it.css` | NEW — grid/board styles |
| `frontend/src/games/index.ts` | EDIT — add `import "./bombIt"` (registration side-effect; import position = desktop tile order) |

**UNCHANGED:** backend (`tunnel-manager`), Move (`sui_tunnel`), `frontend/src/games/registry.ts`,
`frontend/src/games/types.ts`. PvP-only — no self-play/bot hook (`randomMove` covers sim/tests).

## 8. Testing & gate

- **Protocol unit tests** (`tsx`, the highest-value tier — the protocol is the authority):
  movement/collision rules, bomb placement caps, fuse countdown, `+` blast with wall/crate stops,
  chain detonation, self-kill, mutual-death draw, `BOMB_IT_TICK_CAP` push, and **encodeState determinism +
  180° map symmetry** (same seed → byte-identical state both seats; mirrored layout).
- **`deriveView`** unit test (`tsx`).
- **Gate:** `cd sui-tunnel-ts && npx tsx --test src/protocol/bombIt.test.ts` green; `cd frontend &&
  pnpm typecheck && pnpm build` green (`build` also enforces single registration).
- **Full e2e is manual** (cannot run headless): backend `tunnel-manager` `/v1/mp` relay up, two tabs
  (two testnet wallet accounts, `sui_tunnel` deployed at `VITE_TUNNEL_PACKAGE_ID`), create+join a
  code, duel, confirm the winner is paid.

## 9. Risks & tradeoffs accepted

- **Relay required** (PvP, unlike self-play): needs `tunnel-manager` `/v1/mp` up; set
  `VITE_BACKEND_URL` against a deployed backend.
- **Pace.** Round-trip-bound alternate-action ping-pong, not true-simultaneous Bomberman — keeps the
  "two files + registration" envelope (no `mpClient` change). The dir-side-channel variant (both act
  per tick) is the future smoothing.
- **First-actor edge.** A acts on tick 0. Mitigated by far, symmetric spawns; bombs take `FUSE_TICKS`
  to threaten, so the half-tick lead is not a kill advantage. Noted, not resolved.
- **tunnelId-seeded map** (no commit-reveal): acceptable because the layout is symmetric by
  construction and fully public — neither seat is advantaged and there is no hidden information.
- **Minimal scope.** Single bomb, fixed radius, no power-ups (the chosen v1). Power-ups are an
  additive future protocol bump (`bomb_it.v2`) — they grow State + encodeState but reuse the wiring.
- **Disconnect/timeout.** v1 has no reconnect; a dropped peer strands the match. The on-chain
  `timeout`/dispute path (`force_close_after_timeout`) is the safety net; reconnect is out of scope.
```
