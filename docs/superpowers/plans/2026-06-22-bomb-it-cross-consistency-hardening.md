# Bomb It & Chicken Cross Consistency Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close four consistency/contract gaps between bomb-it/chicken-cross and the reference arena games, behavior-preserving except one intentional cross fairness fix.

**Architecture:** Edits span the two game protocols in the (otherwise upstream-vendored, but game-protocol-editable) `sui-tunnel-ts/src/protocol/`, the frontend game packages + shared design CSS, and docs/ADRs. One real behavior change: the cross equal-score dead-heat resolves to a push instead of awarding seat A. Everything else is comments, docs, a dead-CSS deletion, new tests, and new READMEs.

**Tech Stack:** TypeScript, `node:test` via `tsx` (run with `node --import tsx --test`), pnpm (frontend), Vite. Move untouched. Backend untouched.

## Global Constraints

- **Toolchain stays:** `sui-tunnel-ts/` and `frontend/` keep pnpm + `node:test` via `tsx`. Do NOT convert to bun/biome. (CLAUDE.md §Repository layout)
- **SDK edit scope:** only the game protocols `sui-tunnel-ts/src/protocol/cross.ts` + `bombIt.ts` (ours) and their tests are edited — no other SDK file.
- **Conventional Commits, subject ≤ 50 chars, imperative, lowercase after type, no trailing period. NO AI attribution / no Co-Authored-By.** (CLAUDE.md §Git)
- **Test runner — SDK protocol tests:** `cd sui-tunnel-ts && node --import tsx --test src/protocol/<file>.test.ts`
- **Test runner — frontend session-core:** `cd frontend && node --import tsx --test "src/games/<game>/session-core.test.ts"`
- **Import discipline (frontend `*.test.ts`):** runtime SDK imports use RELATIVE `.ts` paths (`../../../../sui-tunnel-ts/src/...`), never the bare `sui-tunnel-ts/...` specifier. (docs/adding-a-tunnel-game.md §Import discipline)
- **Branch:** `feat/bomb-it-pvp` (already checked out). Commit per task.

---

### Task 1: Fix the cross equal-score dead-heat (push, not A-win)

**Files:**

- Modify: `sui-tunnel-ts/src/protocol/cross.ts:291-294` (the `aWon && bWon` branch) and the header (lines 1-14)
- Test: `sui-tunnel-ts/src/protocol/cross.test.ts` (add one test)

**Interfaces:**

- Consumes: `CrossProtocol`, `WIN_LANE`, `MIN_STAKE`, `SPAWN_COL`, `CrossState` — already imported in `cross.test.ts:3-12`; `CTX` already defined at `cross.test.ts:70`.
- Produces: no new exports. Behavior: `applyMove` returns `winner: null` (push) when both seats reach `WIN_LANE` on the same tick with equal score.

- [ ] **Step 1: Write the failing test**

Add to `sui-tunnel-ts/src/protocol/cross.test.ts` (after the existing `applyMove throws once terminal` test, before the `mulberry32ForTest` helper at line 146):

```ts
test("simultaneous WIN_LANE arrival with equal score is a push, not an A-win", () => {
  const p = new CrossProtocol();
  // Both chickens one hop from the finish, dead even — the exact dead-heat case.
  // Lane WIN_LANE is grass (always safe), so both hops land and both arrive this tick.
  const deadHeat: CrossState = {
    ...p.initialState(CTX),
    tick: 10n,
    players: [
      {
        lane: WIN_LANE - 1,
        col: SPAWN_COL,
        score: WIN_LANE - 1,
        invulnTicks: 0,
      },
      {
        lane: WIN_LANE - 1,
        col: SPAWN_COL,
        score: WIN_LANE - 1,
        invulnTicks: 0,
      },
    ],
  };
  const next = p.applyMove(deadHeat, { dirA: "north", dirB: "north" }, "A");
  assert.equal(next.players[0].lane >= WIN_LANE, true);
  assert.equal(next.players[1].lane >= WIN_LANE, true);
  assert.equal(next.winner, null); // dead heat ⇒ push, matching the TICK_CAP tie path
  assert.equal(next.balanceA, next.balanceB); // stakes returned, no payout
  assert.equal(next.balanceA + next.balanceB, next.total);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd sui-tunnel-ts && node --import tsx --test src/protocol/cross.test.ts`
Expected: FAIL — the new test reports `next.winner` is `"A"` (old code awards A on equal score), `expected null`.

- [ ] **Step 3: Implement the fix**

In `sui-tunnel-ts/src/protocol/cross.ts`, replace lines 291-294:

```ts
// Simultaneous double-arrival is broken deterministically by higher score, ties to A.
// Deterministic (replay-stable) is required so both parties agree; the A-bias is harmless
// in self-play (both seats are the same funding wallet). Revisit for PvP fairness.
if (aWon && bWon) winner = players[0].score >= players[1].score ? "A" : "B";
```

with:

```ts
// Simultaneous double-arrival: higher score wins; an exact dead heat is a PUSH (winner
// null), matching the TICK_CAP tie path below. Resolving by score is replay-stable so both
// parties agree, and the push removes the old seat-A bias in human-vs-human PvP.
if (aWon && bWon) {
  if (players[0].score > players[1].score) winner = "A";
  else if (players[1].score > players[0].score) winner = "B";
  else winner = null;
}
```

- [ ] **Step 4: Add the PvP seed-fairness note to the cross.ts header**

In `sui-tunnel-ts/src/protocol/cross.ts`, replace the header's closing lines 12-14:

```ts
 * total is 2S. Balances stay (S, S) for the whole race and flip to (2S, 0) / (0, 2S)
 * only on the winning tick — so the invariant balanceA + balanceB === total holds for
 * every reachable state (required by OffchainTunnel.step).
 */
```

with:

```ts
 * total is 2S. Balances stay (S, S) for the whole race and flip to (2S, 0) / (0, 2S)
 * only on the winning tick — so the invariant balanceA + balanceB === total holds for
 * every reachable state (required by OffchainTunnel.step).
 *
 * PvP fairness: the seed is a deterministic function of the Sui-assigned tunnelId, NOT a
 * commit-reveal. Safe here because the hazard field is PUBLIC and identical for both seats —
 * neither party holds hidden state it could bias, and the tunnelId cannot be ground.
 * Commit-reveal is reserved for hidden-information games (see docs/decisions/0010).
 */
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd sui-tunnel-ts && node --import tsx --test src/protocol/cross.test.ts`
Expected: PASS — 12 tests pass (11 existing + 1 new), 0 fail.

- [ ] **Step 6: Commit**

```bash
git add sui-tunnel-ts/src/protocol/cross.ts sui-tunnel-ts/src/protocol/cross.test.ts
git commit -m "fix(cross): push on equal-score dead heat"
```

---

### Task 2: Document the deterministic-seed decision (bomb-it header, doc, ADR)

**Files:**

- Modify: `sui-tunnel-ts/src/protocol/bombIt.ts` (header, lines 1-11)
- Modify: `docs/adding-a-tunnel-game.md` (Invariant 2, line 56)
- Create: `docs/decisions/0010-deterministic-seed-vs-commit-reveal.md`

**Interfaces:** Documentation only — no code, no tests, no exports.

- [ ] **Step 1: Add the seed-fairness note to the bombIt.ts header**

In `sui-tunnel-ts/src/protocol/bombIt.ts`, replace the header's closing lines 8-11:

```ts
 * (S, S) and flip to (2S, 0) / (0, 2S) only on the killing tick, so
 * balanceA + balanceB === total holds for every reachable state.
 */
```

with:

```ts
 * (S, S) and flip to (2S, 0) / (0, 2S) only on the killing tick, so
 * balanceA + balanceB === total holds for every reachable state.
 *
 * PvP fairness: the seed derives deterministically from the Sui-assigned tunnelId, not a
 * commit-reveal. Safe because the grid is PUBLIC and 180°-rotationally symmetric — both seats
 * face the same layout, the tunnelId cannot be ground, and there is no hidden state to bias.
 * Commit-reveal is reserved for hidden-information games (see docs/decisions/0010).
 */
```

- [ ] **Step 2: Correct the doc's PvP-seeding guidance**

In `docs/adding-a-tunnel-game.md`, in the Invariant 2 block (line 56), replace the final sentence:

```
Self-play may seed from `tunnelId`; PvP should derive the seed from a two-party commit-reveal for fairness.
```

with:

```
Seed from the `tunnelId` when the random field is **public and party-independent** (no seat can bias it and the id can't be ground) — e.g. blackjack's card stream, chicken-cross's hazard field, bomb-it's symmetric grid. Use a two-party **commit-reveal** only when a party holds **hidden state it could bias** (battleship fleets, poker hands — see ADRs 0003/0008/0009 and 0010).
```

- [ ] **Step 3: Create ADR 0010**

Create `docs/decisions/0010-deterministic-seed-vs-commit-reveal.md`:

```markdown
# 0010 — Deterministic tunnelId seed vs commit-reveal for game randomness

- **Status**: Accepted
- **Date**: 2026-06-22

## Context

Tunnel games derive their randomness (shuffles, hazard fields, crate layouts)
from a seed that is part of `encodeState`, so both parties and an on-chain
disputer replay identically. Two seeding strategies exist in the repo and a
new game must pick one:

- **Deterministic** — the seed is a pure function of `(tunnelId, …)`. Blackjack
  uses this for its card stream (`blackjack.ts` header: _"bias-free without any
  commit-reveal round-trips"_).
- **Commit-reveal** — both parties commit to secret randomness, then reveal.
  Used by battleship (0003), quantum poker (0008), and Super Auto Pets (0009).

The ambiguity: chicken-cross and bomb-it ship PvP and both seed from
`seedFromTunnelId(tunnelId)`. `docs/adding-a-tunnel-game.md` previously said PvP
_should_ use commit-reveal, which no shipped game does.

## Decision

We seed from the `tunnelId` when the random field is **public and
party-independent**, and reserve commit-reveal for games where a party holds
**hidden state it could bias**.

chicken-cross (per-lane hazard field, identical for both seats) and bomb-it
(180°-rotationally symmetric grid) are public-and-symmetric: neither seat
controls or benefits from the seed, and the Sui-assigned `tunnelId` cannot be
ground. So both keep deterministic seeding — the same category as blackjack's
card stream.

## Consequences

- No commit-reveal handshake or SDK surface is added for cross/bomb-it (YAGNI),
  and they stay consistent with the blackjack precedent.
- The distinguishing test for future games: _does any party hold hidden state it
  could bias?_ If yes → commit-reveal (0003/0008/0009). If the field is public
  and symmetric → deterministic `tunnelId` seed.
- A separate, real bias (chicken-cross's equal-score dead-heat awarding seat A)
  is fixed independently to a push; it was a tiebreak bug, not a seeding one.
```

- [ ] **Step 4: Verify docs reference consistently**

Run: `cd /Users/realestzan/Projects/code/dopamint-arena && rg -n "0010|commit-reveal" docs/adding-a-tunnel-game.md sui-tunnel-ts/src/protocol/cross.ts sui-tunnel-ts/src/protocol/bombIt.ts docs/decisions/0010-deterministic-seed-vs-commit-reveal.md`
Expected: each file references the decision; the doc and both headers point at `docs/decisions/0010`.

- [ ] **Step 5: Commit**

```bash
git add sui-tunnel-ts/src/protocol/bombIt.ts docs/adding-a-tunnel-game.md docs/decisions/0010-deterministic-seed-vs-commit-reveal.md
git commit -m "docs: deterministic-seed rationale + ADR 0010"
```

---

### Task 3: Delete the dead `.arena-win-banner` rule

**Files:**

- Modify: `frontend/src/styles/index.css:406-410` (remove comment + rule; keep `@keyframes arena-win-pop`)

**Interfaces:** CSS only. `@keyframes arena-win-pop` is retained — `.arcade-card` (`index.css:446`) still references it.

- [ ] **Step 1: Confirm the class is dead before deleting**

Run: `cd /Users/realestzan/Projects/code/dopamint-arena/frontend && rg -n "arena-win-banner" src`
Expected: exactly ONE match — the definition at `src/styles/index.css:407`. (Zero usages ⇒ safe to delete.)

- [ ] **Step 2: Delete the comment + rule**

In `frontend/src/styles/index.css`, remove these lines (406-410):

```css
/* Win/outcome banner — the most-remembered moment of a match. A gold pop the
   board mounts when a game settles. Used by every arena game's result screen. */
.arena-win-banner {
  animation: arena-win-pop 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}
```

Leave the following `@keyframes arena-win-pop { … }` block intact (it is used by `.arcade-card`).

- [ ] **Step 3: Verify the class is gone and the keyframe stays**

Run: `cd /Users/realestzan/Projects/code/dopamint-arena/frontend && rg -n "arena-win-banner" src; rg -n "@keyframes arena-win-pop|animation: arena-win-pop" src/styles/index.css`
Expected: `arena-win-banner` → no matches; `@keyframes arena-win-pop` present AND `.arcade-card`'s `animation: arena-win-pop` reference present.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/styles/index.css
git commit -m "chore(css): remove dead arena-win-banner"
```

---

### Task 4: Fix test comment + add bounded settleability tests

**Files:**

- Modify: `frontend/src/games/chickenCross/session-core.test.ts:3-4` (comment) + import + add one test
- Modify: `frontend/src/games/bombIt/session-core.test.ts` (import + add one test)

**Interfaces:**

- Consumes: `verifyCoSignedUpdate` from `../../../../sui-tunnel-ts/src/core/tunnel.ts`; `tunnel.latest`, `tunnel.partyA.{publicKey,scheme}`, `tunnel.partyB.{publicKey,scheme}` on `OffchainTunnel` (same surface used by `blackjack/session-core.test.ts:57-70`). `freshTunnel()` already exists in both files and returns `{ protocol, tunnel }`.
- Produces: no new exports.

- [ ] **Step 1: Add the failing settleability test to chicken-cross**

In `frontend/src/games/chickenCross/session-core.test.ts`, change the import line:

```ts
import { OffchainTunnel } from "../../../../sui-tunnel-ts/src/core/tunnel.ts";
```

to:

```ts
import {
  OffchainTunnel,
  verifyCoSignedUpdate,
} from "../../../../sui-tunnel-ts/src/core/tunnel.ts";
```

Then append this test:

```ts
test("a co-signed update verifies after bounded play (settleable mid-game)", () => {
  const { protocol, tunnel } = freshTunnel();
  // Bounded window: a long real-time race co-signs thousands of updates, so we prove the
  // co-signed state is on-chain-settleable from a slice rather than a full playout.
  for (let i = 0; i < 50; i++) {
    if (!stepSession(protocol, tunnel, Math.random)) break;
  }
  const u = tunnel.latest;
  assert.ok(u, "has a co-signed update");
  assert.ok(
    verifyCoSignedUpdate(
      u!,
      { publicKey: tunnel.partyA.publicKey, scheme: tunnel.partyA.scheme },
      { publicKey: tunnel.partyB.publicKey, scheme: tunnel.partyB.scheme },
    ),
    "settleable co-signed state",
  );
});
```

- [ ] **Step 2: Fix the false "mirrors exactly" comment in chicken-cross**

In `frontend/src/games/chickenCross/session-core.test.ts`, replace lines 3-4:

```ts
// Runtime SDK imports use RELATIVE .ts paths (tsx ignores the vite alias / tsconfig paths at
// runtime). This mirrors frontend/src/games/blackjack/session-core.test.ts exactly.
```

with:

```ts
// Runtime SDK imports use RELATIVE .ts paths (tsx ignores the vite alias / tsconfig paths at
// runtime). Same shape as the blackjack/bomb-it session-core tests: bounded advance +
// conservation here; full termination is covered by the protocol's own fast SDK tests.
```

- [ ] **Step 3: Add the same settleability test to bomb-it**

In `frontend/src/games/bombIt/session-core.test.ts`, change the import line:

```ts
import { OffchainTunnel } from "../../../../sui-tunnel-ts/src/core/tunnel.ts";
```

to:

```ts
import {
  OffchainTunnel,
  verifyCoSignedUpdate,
} from "../../../../sui-tunnel-ts/src/core/tunnel.ts";
```

Then append this test:

```ts
test("a co-signed update verifies after bounded play (settleable mid-game)", () => {
  const { protocol, tunnel } = freshTunnel();
  // Bounded window: a long real-time duel co-signs thousands of updates, so we prove the
  // co-signed state is on-chain-settleable from a slice rather than a full playout.
  for (let i = 0; i < 50; i++) {
    if (!stepSession(protocol, tunnel, Math.random)) break;
  }
  const u = tunnel.latest;
  assert.ok(u, "has a co-signed update");
  assert.ok(
    verifyCoSignedUpdate(
      u!,
      { publicKey: tunnel.partyA.publicKey, scheme: tunnel.partyA.scheme },
      { publicKey: tunnel.partyB.publicKey, scheme: tunnel.partyB.scheme },
    ),
    "settleable co-signed state",
  );
});
```

- [ ] **Step 4: Run both session-core test files**

Run: `cd frontend && node --import tsx --test "src/games/bombIt/session-core.test.ts" "src/games/chickenCross/session-core.test.ts"`
Expected: PASS — 8 tests total (3 existing bomb-it + 1 new, 3 existing cross + 1 new), 0 fail.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/bombIt/session-core.test.ts frontend/src/games/chickenCross/session-core.test.ts
git commit -m "test(games): bomb-it/cross settleability"
```

---

### Task 5: Add per-game READMEs

**Files:**

- Create: `frontend/src/games/bombIt/README.md`
- Create: `frontend/src/games/chickenCross/README.md`

**Interfaces:** Docs only. Style mirrors `frontend/src/games/blackjack/README.md` (short, arena-native focus).

- [ ] **Step 1: Create the bomb-it README**

Create `frontend/src/games/bombIt/README.md`:

````markdown
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
````

````

- [ ] **Step 2: Create the chicken-cross README**

Create `frontend/src/games/chickenCross/README.md`:

```markdown
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
````

````

- [ ] **Step 3: Verify both READMEs exist**

Run: `cd /Users/realestzan/Projects/code/dopamint-arena && ls frontend/src/games/bombIt/README.md frontend/src/games/chickenCross/README.md`
Expected: both paths listed (no "No such file").

- [ ] **Step 4: Commit**

```bash
git add frontend/src/games/bombIt/README.md frontend/src/games/chickenCross/README.md
git commit -m "docs(games): add bomb-it/cross READMEs"
````

---

### Task 6: Full gate

**Files:** none (verification only). If the gate fails, fix in the owning task's files and amend/commit.

**Interfaces:** none.

- [ ] **Step 1: Run both protocol test suites**

Run: `cd sui-tunnel-ts && node --import tsx --test src/protocol/cross.test.ts src/protocol/bombIt.test.ts`
Expected: PASS — cross 12/12, bomb-it 20/20, 0 fail.

- [ ] **Step 2: Run both session-core test suites**

Run: `cd frontend && node --import tsx --test "src/games/bombIt/session-core.test.ts" "src/games/chickenCross/session-core.test.ts"`
Expected: PASS — 8 tests, 0 fail.

- [ ] **Step 3: Typecheck the frontend**

Run: `cd frontend && pnpm typecheck`
Expected: exit 0, no type errors.

- [ ] **Step 4: Build the frontend**

Run: `cd frontend && pnpm build`
Expected: exit 0 — tsc + vite build succeeds (a passing build also confirms single game registration; the registry throws on duplicate id).

- [ ] **Step 5: Confirm clean tree**

Run: `cd /Users/realestzan/Projects/code/dopamint-arena && git status --short`
Expected: empty (all changes committed across Tasks 1-5).

---

## Self-Review

**1. Spec coverage:**

- #1 deterministic-seed docs → Task 1 (cross header), Task 2 (bomb-it header, doc:56, ADR 0010). ✓
- #1 cross tiebreak fix + test → Task 1. ✓
- #2 delete dead `.arena-win-banner` (keep keyframe) → Task 3. ✓
- #3 false "mirrors exactly" comment + bounded settleability tests (both games) → Task 4. ✓
- #4 blackjack-style READMEs (both games) → Task 5. ✓
- Gate (cross+bombIt protocol, both session-core, typecheck, build) → Task 6. ✓

**2. Placeholder scan:** No TBD/TODO/"appropriate"/"similar to Task N". Every code/CSS/doc step shows the exact content and every command shows expected output. ✓

**3. Type consistency:** `freshTunnel()` returns `{ protocol, tunnel }` (matches both existing test files); `verifyCoSignedUpdate(update, partyAPub, partyBPub)` and `tunnel.latest` / `tunnel.partyA` / `tunnel.partyB` match `blackjack/session-core.test.ts:57-70`; `CrossState` field names (`lane`, `col`, `score`, `invulnTicks`, `winner`, `balanceA/B`, `total`) match `cross.ts`; `WIN_LANE`, `SPAWN_COL`, `MIN_STAKE`, `CTX` are already in `cross.test.ts` scope. ✓

```

```
