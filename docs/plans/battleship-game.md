# Plan — Battleship on Sui Tunnel

A full end-to-end plan for a **Battleship** game in dopamint-arena, modeled on
the existing `frontend/src/games/ticTacToe` (real PvP over the tunnel) and
`frontend/src/games/blackjack` (vs-bot self-play). Battleship's twist over
TicTacToe is **hidden information** (each player's fleet is secret), so it adds a
**commit-reveal** fairness layer on top of the same co-signed off-chain engine.

> Status: Proposed. Author the ADR (§9) before writing the code that depends on it.

---

## 0. What the framework already gives us (verified)

These are confirmed by reading the code — they shape the whole plan:

- **The off-chain engine is generic.** `Protocol<State, Move>`
  (`sui-tunnel-ts/src/protocol/Protocol.ts`) is implemented per game;
  `DistributedTunnel<State, Move>` (PvP over a relay) and
  `OffchainTunnel.selfPlay(...)` (one process drives both seats) are
  game-agnostic. We only write a new `Protocol`.
- **No `battleship` protocol exists** in the SDK (`sui-tunnel-ts/src/protocol/`
  has blackjack/chat/payments/quantumPoker/ticTacToe only). We build it.
- **PvP needs no backend change.** The Rust matchmaker
  (`backend/tunnel-manager/src/mp/ws.rs`) keys its queue on an _arbitrary_ game
  string (`QueueJoin { game }` → `join_or_pair(&game, …)`); nothing special-cases
  `"tictactoe"`. `mp.quickMatch("battleship")` pairs two battleship players.
- **On-chain helpers are game-agnostic** (`frontend/src/onchain/tunnelTx.ts`):
  `openAndFundSharedTunnel`, `depositStake`, `closeCooperative`, `readCreatedAt`
  for PvP; `openAndFundSelfPlay` for vs-bot. They route by tunnel id, not game.
- **`useTelemetry()` / `report.pushTxn(row)`** lets a game light up the Live /
  Local activity feeds (`game: "battleship"`).
- **A game is pure registry + window** — no route needed. `register({...})` in
  `index.ts`, imported for side-effect from `frontend/src/games/index.ts`. The
  `Window` mounts inside a floating, draggable, resizable GridLayout window and
  receives `{ windowId, onClose }`.

**Constraint:** `sui-tunnel-ts/` is upstream-authoritative — do **not** add the
protocol there. The `BattleshipProtocol` lives in the frontend game folder and
_imports_ the `Protocol` interface from the SDK. (Precedent: ticTacToe's
`packages/shared/.../multiGameProtocol.ts` wraps an SDK protocol game-side.)

---

## 1. The hidden-information design (the heart of it)

TicTacToe is fully observable; both clients see the whole board. Battleship is
not — A must never learn B's fleet until B chooses to reveal a hit. Two
distrusting browsers co-sign every state, so the protocol itself must make
cheating (lying about a hit, moving ships, fielding an illegal fleet)
**detectable**. The canonical solution is **commit-reveal with a Merkle board**,
exactly the pattern the framework's `example_rock_paper_scissors.move`
demonstrates (commit a hash, reveal later, verify against the commitment).

**Per player, at placement (commit):**

- Build a 10×10 board (1 = ship cell, 0 = water). Standard fleet = 17 ship cells:
  Carrier 5, Battleship 4, Cruiser 3, Submarine 3, Destroyer 2.
- For each of the 100 cells, leaf = `blake2b256(cellIndex ‖ isShip ‖ cellSalt)`
  with a fresh random `cellSalt`. Compute the **Merkle root** over the 100 leaves.
- Co-sign a `commit` move carrying only the 32-byte **root** (+ declared fleet
  size). The opponent now has a binding commitment but learns nothing.

**Per shot (reveal-with-proof):**

- Shooter co-signs `shoot(cell)`. Defender answers with `reveal(cell, isShip,
cellSalt, merkleProof)`. Both verify `merkleProof` against the defender's
  committed root → proves the hit/miss is truthful **for that one cell** without
  exposing any other cell. Both co-sign the resulting state (records the cell +
  result, bumps the hit counter).

**Win / settle:**

- A player loses when all 17 of their ship cells have been revealed as hits.
- At settlement both reveal their **full board + salts**; the protocol checks
  (a) every per-shot reveal matched, and (b) the fleet was _legal_ (exactly the
  right ships, no overlaps, in-bounds). A cheat is caught here and resolved via
  the cooperative-close balances, or — if a cheater stalls/refuses to reveal —
  the on-chain **dispute + timeout penalty** path (`raise_dispute` /
  `force_close_after_timeout` in `sui_tunnel/sources/tunnel.move`) makes the
  honest player whole. No ZK required.

**Fairness tiers** (build Tier 1; record Tier 2 as future in the ADR):

- **Tier 1 (MVP, no ZK, no new Move module):** Merkle-root commit + per-shot
  Merkle-proof reveal + full reveal & legality check at settlement, backed by the
  existing dispute/penalty path. Robust and shippable.
- **Tier 2 (hardened, ADR-gated, future):** a Groth16 circuit
  (`sui_tunnel/sources/zk_verifier.move` already verifies Groth16) proving _legal
  fleet placement_ at commit so the end-reveal is unnecessary, plus on-chain
  replay of Merkle proofs during disputes. Explicitly out of scope for v1.

> vs-bot self-play (Milestone 1) runs both seats in one process, so it knows both
> boards — the commit-reveal layer is exercised but trivially honest. It becomes
> load-bearing only for real PvP (Milestone 2).

---

## 2. State & Move model (the `Protocol` contract)

Implements `Protocol<BattleshipState, BattleshipMove>`. All encodings must be
**canonical** (same state → same bytes on both clients — the co-sign hashes it).

```ts
type Party = "A" | "B"; // from sui-tunnel-ts/protocol/Protocol
type Cell = number; // 0..99, row-major (row*10 + col)
type Winner = 0 | 1 | 2; // 0 none, 1 A wins, 2 B wins

interface ShotResult {
  cell: Cell;
  isHit: boolean;
}

interface BattleshipState {
  phase: "awaitingCommits" | "playing" | "over";
  turn: Party; // whose shot it is (A first)
  pendingShot: { by: Party; cell: Cell } | null; // set after a shoot, cleared by reveal
  commitA: Uint8Array | null; // 32-byte Merkle root; null until committed
  commitB: Uint8Array | null;
  shotsAtA: ShotResult[]; // shots B fired at A (≤100)
  shotsAtB: ShotResult[]; // shots A fired at B
  hitsOnA: number; // A loses at FLEET_CELLS (17)
  hitsOnB: number;
  winner: Winner;
  balanceA: bigint;
  balanceB: bigint;
  total: bigint;
  stake: bigint;
}

type BattleshipMove =
  | { type: "commit"; root: Uint8Array } // place fleet (commit only)
  | { type: "shoot"; cell: Cell } // fire at the foe
  | {
      type: "reveal";
      cell: Cell;
      isShip: boolean; // answer the incoming shot
      salt: Uint8Array;
      proof: Uint8Array[];
    }
  | { type: "revealBoard"; ships: number[]; salts: Uint8Array[] }; // settlement full reveal
```

**Required methods (mirror `ticTacToe.ts`):**

- `name = "battleship.v1"` — also the state-encoding domain tag.
- `initialState(ctx)` — empty boards, `phase: "awaitingCommits"`, `turn: "A"`,
  balances from `ctx.initialBalances`, `stake` clamped to the smaller balance.
- `applyMove(state, move, by)` — **pure**, throws on any illegal move. Enforces:
  - move-type matches `phase`/`pendingShot` (e.g. after a `shoot`, only the
    defender's `reveal` for that exact cell is legal next);
  - whose turn it is; cell in range and not already shot;
  - `reveal` proof verifies against the committer's root (else throw → the
    co-sign fails and the cheater can't advance state);
  - updates shot history, hit counters, `winner` (loser = first to 17 hits), and
    shifts `stake` loser→winner on a decisive result (clamped, like ttt).
- `encodeState(state)` — canonical concat: domain ‖ phase ‖ turn ‖ pendingShot ‖
  commitA ‖ commitB ‖ serialized shotsAtA/shotsAtB ‖ hits ‖ winner ‖ balances ‖
  stake. (Histories are bounded ≤100; full encode is fine. Note `rollingDigest`
  as an optional O(1) optimization.)
- `balances(state)` → `{ a: balanceA, b: balanceB }` (must sum to `total`).
- `isTerminal(state)` → `winner !== 0`.
- `randomMove(state, by, rng)` — drives the bot + simulator: if it's `by`'s shot,
  pick an un-shot cell (random for v1; a hunt/target AI is a nice upgrade); if
  `by` owes a reveal, return the truthful `reveal` from `by`'s own locally-known
  board (+ Merkle proof). Enables `OffchainTunnel.selfPlay`.

---

## 3. Engine (pure, unit-tested, no React/IO)

`frontend/src/games/battleship/engine/`

- `fleet.ts` — `FLEET` spec (5/4/3/3/2 = 17 cells), `placeFleetRandom(rng)`,
  `isLegalFleet(board)` (right ships, no overlap, in-bounds, contiguous),
  `boardToCells` / `cellsToBoard`, coord helpers (`0..99 ↔ {row,col}`, A–J/1–10).
- `merkle.ts` — `commitBoard(board, salts) → { root, leaves }`,
  `proveCell(leaves, cell) → proof`, `verifyCell(root, cell, isShip, salt, proof)`.
  Use the SDK's hash (`blake2b256`) so roots match the co-sign hash function.
- `bot.ts` — `randomMove` impl + an optional hunt/target AI for a believable
  opponent; shared by the protocol's `randomMove` and the simulator.
- `*.test.ts` — fleet legality, merkle commit/prove/verify round-trips + tamper
  detection, bot always returns a legal move.

---

## 4. UI (`làm kĩ` — the careful part)

Battleship needs two 10×10 grids and a placement flow — richer than ttt's 3×3.
Tailwind + arena tokens (`arena-panel/accent/edge/text/muted`), reusing shadcn
primitives (`Button`, `Badge`, `Tooltip`, `Tabs`, `Dialog`) from
`@/components/ui/*`. Must look right inside a small, resizable floating window:
the two boards sit **side-by-side on wide**, **stack on narrow** (or `Tabs`:
"Your Fleet" / "Enemy Waters"). Cells are `aspect-square`, grid uses
`grid-cols-10`, labels A–J across / 1–10 down.

**Status machine** (mirrors ttt + blackjack):
`idle → (matching → funding | funding) → placement → playing → settling →
settled` plus `error`. vs-bot skips `matching`.

- **idle** — title + stake line + two CTAs: **Play vs Bot** (self-play, instant)
  and **Find Match** (PvP). (ttt has one "Find Match" button; we add the bot
  button like blackjack's start.)
- **matching / funding** — "Finding an opponent…" / "Opening + funding the tunnel
  on-chain…", show truncated opponent wallet.
- **placement** — your grid with drag-to-place + rotate (R) + **Auto-place** /
  **Randomize** / **Ready (commit)**; a `FleetRoster` listing each ship with
  placed/remaining status; reject overlaps/out-of-bounds. "Ready" computes the
  Merkle root and co-signs the `commit` move; wait for the opponent's commit.
- **playing** — two boards: **Enemy Waters** (click a cell to fire on your turn;
  renders your hits 💥 / misses ○ / sunk-ship outlines; ships hidden) and **Your
  Fleet** (your ships + incoming shots). Turn banner ("Your turn — fire!" /
  "Opponent is aiming…"), last-shot highlight, sunk-ship toast.
- **settling / settled** — "settling on-chain…" → "settled ✓".
- **over** — win/lose banner (`Dialog` or inline) + fleet-damage summary +
  **Play Again** (→ `reset`).

**Components** (`frontend/src/games/battleship/components/`):
`PlacementBoard.tsx`, `FleetRoster.tsx`, `FiringBoard.tsx` (enemy waters),
`OwnBoard.tsx` (your fleet under fire), `GridFrame.tsx` (A–J/1–10 labels +
`grid-cols-10`), `CellButton.tsx`.

**Telemetry:** push a `TxnRow` (`game: "battleship"`) on each resolved shot
(type `"Hit"`/`"Miss"`/`"Sunk"`) and on game end (`"Battleship Win"`/`"Loss"`),
like blackjack — so the Live/Local feeds light up.

---

## 5. Session hook — `useBattleship.ts`

One hook exposing both modes (mirror `usePvpTicTacToe.ts` for PvP and
`useBlackjackSession.ts` for vs-bot). Returns:

```ts
interface BattleshipSession {
  status;
  mode: "bot" | "pvp" | null;
  role: Party | null;
  phase;
  myTurn: boolean;
  winner: Winner;
  opponentWallet: string | null;
  myBoard;
  enemyView;
  fleetRoster;
  pendingShot;
  error;
  playBot(): void; // self-play: openAndFundSelfPlay + OffchainTunnel.selfPlay + timer
  findMatch(): void; // PvP: MpClient.quickMatch("battleship") + DistributedTunnel
  place(ship, cell, orient): void; // placement edits (local, pre-commit)
  autoPlace(): void;
  randomize(): void;
  commit(): void; // compute root, propose {type:"commit"}
  fire(cell): void; // propose {type:"shoot"}; defender side auto-reveals
  reset(): void;
}
```

- **vs-bot (Milestone 1):** `openAndFundSelfPlay({reads, signExec, partyA, partyB,
aAmount, bAmount})` → `OffchainTunnel.selfPlay(proto, tunnelId, aKey, bKey,
aAddr, bAddr, {a,b})`. A `setInterval` steps the bot via `proto.randomMove`
  (it answers reveals truthfully from the locally-known board). Settle with
  `tunnel.buildSettlement(createdAt)` + `closeCooperative`. The human plays seat A
  (their fires go through `propose`); the bot drives seat B + all reveals.
- **PvP (Milestone 2):** copy ttt's flow exactly — ephemeral keypair, `MpClient`,
  `quickMatch("battleship")`, peer hello/pubkey exchange, role A
  `openAndFundSharedTunnel` / role B `depositStake`, `DistributedTunnel<
BattleshipState, BattleshipMove>` over `channel.transport`, `dt.onConfirmed`
  → sync + detect terminal → `settle()` with `buildSettlementHalf` /
  `combineSettlement` / `closeCooperative` (role A submits). The extra peer
  messages vs ttt: exchanging the per-shot reveal happens _inside_ the tunnel
  moves (shoot → reveal), so the relay transport carries it natively — no new
  side-channel needed beyond ttt's hello/open/ready/settleHalf.

---

## 6. Files

**New:**

- `frontend/src/games/battleship/index.ts` — `register({ id:"battleship",
name:"Battleship", icon:"🚢", image:"/games/battleship.png", Window:
BattleshipWindow })`.
- `frontend/src/games/battleship/BattleshipWindow.tsx` — orchestrator/status.
- `frontend/src/games/battleship/useBattleship.ts` — session hook.
- `frontend/src/games/battleship/components/{PlacementBoard,FleetRoster,FiringBoard,OwnBoard,GridFrame,CellButton}.tsx`
- `frontend/src/games/battleship/protocol/battleship.ts` (+ `battleship.test.ts`)
- `frontend/src/games/battleship/engine/{fleet,merkle,bot}.ts` (+ `*.test.ts`)
- `frontend/public/games/battleship.png` — 2816×1536 JPG, naval/grid art
  (matches the other game thumbnails).
- `docs/decisions/0003-battleship-on-sui-tunnel.md` — the ADR (§9).

**Modify:**

- `frontend/src/games/index.ts` — add `import "./battleship";`.
- `frontend/package.json` — extend the test glob with
  `"src/games/battleship/**/*.test.ts"`.

**Reuse unchanged:** the SDK (`Protocol`, `DistributedTunnel`, `OffchainTunnel`,
`makeEndpoint`, `defaultBackend`, `generateKeyPair`, `blake2b256`),
`onchain/tunnelTx.ts`, `pvp/mpClient.ts`, `backend/controlPlane.ts`,
`telemetry/*`, `components/ui/*`, the registry + GameWindow + GridLayout.

---

## 7. Milestones (ship incrementally; stop for review at each)

- **M0 — logic only (no UI):** ADR + asset + `engine/*` + `protocol/battleship.ts`
  - all unit tests green. Provable correctness with zero UI risk.
- **M1 — vs-bot e2e (demoable):** `BattleshipWindow` + `useBattleship` bot path +
  placement/battle/over UI. One browser, one wallet, real tunnel open + co-signed
  play + on-chain settle, telemetry rows appear. **This is the demo deliverable.**
- **M2 — real PvP:** `quickMatch("battleship")` + `DistributedTunnel` + the
  commit-reveal fairness layer exercised between two distrusting browsers.
- **M3 — hardened (future, ADR-gated):** ZK legal-placement proof + on-chain
  dispute proof replay. Out of scope for v1.

---

## 8. Verification (full e2e)

- **Unit (`pnpm test`, node:test via tsx):** protocol `applyMove` rules + win
  detection + balance shift; `encodeState` determinism (golden — same state →
  same bytes, both clients must agree or co-sign breaks); fleet legality; merkle
  prove/verify + tamper rejection; bot legality.
- **Typecheck/build baseline:** the change is clean if
  `pnpm typecheck 2>&1 | grep "error TS" | grep -v "sui-tunnel-ts/src"` is empty
  (9 pre-existing SDK errors are not regressions; `vite build` also fails on the
  same upstream `@noble` import — that's the documented baseline).
- **E2E vs-bot:** `pnpm dev` + headless Chrome — open the window, auto-place,
  Ready, play to completion; verify on-chain open/settle on devnet and that
  Live/Local feeds show `battleship` rows. Screenshot placement / battle / over.
- **E2E PvP:** backend up + two browser contexts (two funded wallets) →
  `quickMatch` pairs them → full game over the relay → cooperative settle. Confirm
  neither client ever holds the other's unrevealed board.

---

## 9. ADR to author first — `docs/decisions/0003-battleship-on-sui-tunnel.md`

Per CLAUDE.md, record the decision before the code. Key points to capture:

- **Decision:** Battleship is a generic-tunnel game with game logic in a
  frontend-side `BattleshipProtocol` (SDK stays upstream-clean); two modes
  (vs-bot self-play, PvP over relay) reusing the ttt/blackjack patterns.
- **Hidden info:** Tier-1 commit-reveal (Merkle root + per-shot proof + end
  reveal, backed by the on-chain dispute/penalty path). No ZK, no per-game Move
  module in v1.
- **Alternatives weighed:** (a) plaintext-board "trust the report" — rejected,
  not fair for PvP; (b) ZK legal-placement up front — deferred to Tier 2
  (trusted-setup + circuit cost not justified for v1); (c) a bespoke
  `battleship.move` module — unnecessary, the generic tunnel + co-signed state
  hash already settles balances.
- **Consequences:** a stalling cheater is handled by timeout penalty, not
  prevented; legality is enforced at end-reveal, not at commit (Tier 2 fixes
  this); shot history grows in state (bounded ≤100/side; `rollingDigest` if O(1)
  ever matters).

---

## 10. Conventions (apply throughout)

- pnpm only in `frontend/`; never edit `sui-tunnel-ts/` or `sui_tunnel/`.
- Conventional Commits, ≤50-char subject, **no AI attribution**, human-authored.
- Rebase over merge; one logical change per commit; PR base = `dev`.
- Names describe purpose (no `Manager`/`Helper`/`Data`); comments explain _why_.
- Tests named by behavior; co-locate `*.test.ts`.
