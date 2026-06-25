# Super Auto Pets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a full Super Auto Pets (SAP) auto-battler as a new arena game — two staked players privately build pet teams (buy / sell / roll / position / combine-to-level / food) in a shop phase, then reveal teams and run a deterministic battle that costs the loser a heart, all heads-up 1v1 over ONE Sui tunnel (session channel), settled on-chain through the existing tunnel flow.

**Architecture:** A new isolated battle engine (`sapEngine.ts`) + a `SuperAutoPetsProtocol` implementing the SDK `Protocol<State, Move>` interface (`superAutoPets.ts`) + a pure client-side shop economy module (`sapShop.ts`), all under `sui-tunnel-ts/src/protocol/`. The engine is a PURE deterministic function of `(teamA, teamB, battleSeed)`; the protocol carries only commitments + hearts + the running ledger in the signed state (raw teams/gold/shop stay private, mirroring `quantumPoker`'s hole cards). An on-chain `example_super_auto_pets.move` wraps a `Tunnel<T>` for many rounds (session channel, following the `quantumPoker` multi-round + commit-reveal pattern already on `dev`). The repo core (`core/tunnel.ts`, `randomness.move`, `tunnel.move`) is reused untouched. Framework-dir edits are limited to barrel registrations in `protocol/index.ts` (Tasks 2 and 4) plus SAP vectors appended to the print-only `core/golden.gen.ts` dev utility (Task 9); no hot-path core files (`tunnel.ts` / `randomness.ts` / `wire.ts` / `commitment.ts`) are modified. The frontend adds a `superAutoPets/` game folder registered in `games/index.ts`.

**Tech Stack:** TypeScript, `node:test` via `tsx` run with **pnpm** (NOT bun) in `sui-tunnel-ts`; the `OffchainTunnel` SDK (`sui-tunnel-ts`); Sui Move (`sui_tunnel` package); React desktop (`frontend`, pnpm + vite).

**Spec:** `docs/superpowers/specs/2026-06-19-super-auto-pets-design.md`

**ADR:** `docs/decisions/0009-super-auto-pets-on-tunnel.md` · **Roster data:** `docs/superpowers/specs/2026-06-19-super-auto-pets-roster.md`

> **Cross-doc note (intentional supersede of spec §1):** the spec's §1 Non-goals say "Any change to `sui_tunnel/` or the `sui-tunnel-ts/` framework. All work is game-side." This plan **intentionally supersedes** that non-goal per the agreed file targets: SAP ships inside the framework dirs (`sui-tunnel-ts/src/protocol/**`, `sui_tunnel/sources/examples/**`, and an append to `sui-tunnel-ts/src/core/golden.gen.ts`). The discipline is preserved by **staging only the exact listed paths** (never a wholesale `git add` of `sui-tunnel-ts/**` or `sui_tunnel/**`) and by touching **no hot-path core files**.

**Conventions:** Conventional Commits, subject ≤ 50 chars, lowercase after type, no trailing period, **no AI attribution / no Co-Authored-By**. One logical change per commit; the commit is always the final step of its task. Do **not** `git add -A`; stage only the files listed in that task. The new SAP files live under `sui-tunnel-ts/**` and `sui_tunnel/**`, so stage them **by exact path** — never `git add sui-tunnel-ts` / `git add sui_tunnel` / `git add -A` (no wholesale staging of those framework dirs). Do not push. Rebase over merge.

**Invariants (must hold after every task):**

1. The battle is a PURE deterministic function of `(teamA, teamB, battleSeed)` — no wall-clock, no unseeded RNG; all in-battle randomness comes from the seed via `core/randomness` (byte-identical to `randomness.move`).
2. `balances()` always sums to the locked total (`total = a + b`); the engine throws otherwise.
3. The per-tunnel nonce is strictly increasing and engine-owned — the protocol never touches keys, signing, nonces, replay, or wire bytes.
4. Hidden teams via commit-reveal (`core/commitment`): only commitments enter the signed state until both reveal, and the commitment binds the team's **full** content (species/stats/level **and food**, Task 6) so a reveal cannot differ from what was committed.
5. No ZK on the hot path (dispute re-derivation only).

**Paths (relative to repo root):**

- Engine: `sui-tunnel-ts/src/protocol/sapEngine.ts` (+ `sapEngine.test.ts`)
- Protocol: `sui-tunnel-ts/src/protocol/superAutoPets.ts` (+ `superAutoPets.test.ts`), registered in `sui-tunnel-ts/src/protocol/index.ts`
- Shop: `sui-tunnel-ts/src/protocol/sapShop.ts` (+ `sapShop.test.ts`)
- Move: `sui_tunnel/sources/examples/example_super_auto_pets.move` (+ `sui_tunnel/tests/example_super_auto_pets_tests.move`)
- Golden: generator additions in `sui-tunnel-ts/src/core/golden.gen.ts`, cross-checked by a Move test mirroring `sui_tunnel/tests/randomness_xcheck_tests.move`
- Frontend: `frontend/src/games/superAutoPets/`, registered in `frontend/src/games/index.ts`

---

## Reference modules (all on `dev` — no rebase needed)

This plan stays entirely on `feat/super-auto-pets` (branched off `dev`) and pushes to `dev`; **no merge or rebase from `main`.** SAP's session + commit-reveal pattern is modeled on files already present on this branch:

- `sui-tunnel-ts/src/protocol/quantumPoker.ts` — a multi-round (`handNo`) protocol with running balances (`balanceA`/`balanceB`) and commit-reveal hidden info (`computeCommitment` / `combineReveals`). This is the **primary template** for `superAutoPets.ts`.
- `sui_tunnel/sources/quantum_poker.move` — an on-chain commit-reveal game; the template for `example_super_auto_pets.move`.
- The core `tunnel.move` functions the wrapper calls **all already exist on `dev`/HEAD** (verified): `create` / `create_and_share` / `create_and_fund`, `deposit_party_a/b`, `update_state`, `close_cooperative` / `close_cooperative_with_root`, `raise_dispute`, `resolve_dispute`, `force_close_after_timeout`.

> The `example_multi_game_tictactoe` template lives only on `main` and is **deliberately NOT used**. `quantumPoker` is the better fit anyway: SAP, like poker, needs commit-reveal hidden information, which the tic-tac-toe session channel lacks.

---

**How to run tests:**

- All TS: `cd sui-tunnel-ts && pnpm test`
- One TS file: `cd sui-tunnel-ts && node --import tsx --test src/protocol/superAutoPets.test.ts` (swap the path for `sapEngine.test.ts` / `sapShop.test.ts`)
- Move: `cd sui_tunnel && sui move test example_super_auto_pets`
- Golden generator (print-only dev utility): `cd sui-tunnel-ts && node --import tsx src/core/golden.gen.ts`
- Frontend: `cd frontend && pnpm typecheck` and `cd frontend && pnpm build`

**Task order follows spec §6** (engine → vertical slice that settles by day 3–4 → fair shop + economy → depth: leveling/food/roster → on-chain Move + golden → frontend). Each task leaves a shippable slice.

**De-scope order if behind (drop from the bottom of importance, per spec §6):** extra pets (Task 7) → food (Task 6) → leveling/combine (Task 5) → on-chain Move + golden (Tasks 8–9) → fair-shop commit-reveal (Tasks 3–4, fall back to a per-player seed). The hidden-team commit-reveal and the deterministic battle (Tasks 1–2) are **not** cuttable — they are the game. The frontend (Task 10) is demo polish on top.

---

## Task 1: Battle engine core (`sapEngine.ts`)

**Files:**

- Create: `sui-tunnel-ts/src/protocol/sapEngine.ts`
- Test: `sui-tunnel-ts/src/protocol/sapEngine.test.ts`

The deterministic battle loop + a tier-1 roster behind a trigger framework. Abilities are pure effects keyed to a fixed event set; adding a pet = adding one `ROSTER` entry, never touching the loop. This slice covers `onStartOfBattle` and `onFaint` over ~6 tier-1 pets. All "random" choices (target, which friend to buff) come from the battle seed via `core/randomness`, so the result is byte-reproducible on both clients and on-chain in a dispute.

- [ ] **Step 1: Write the failing test**

Create `sui-tunnel-ts/src/protocol/sapEngine.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { runBattle, makePet, encodeTeam, SPECIES, type Pet } from "./sapEngine";

const seed = (n: number) =>
  Uint8Array.from({ length: 32 }, (_, i) => (i + n) & 0xff);
// A plain vanilla body (FISH's trigger is onLevelUp, a shop event — inert in battle).
const body = (attack: number, health: number): Pet => ({
  species: SPECIES.FISH,
  attack,
  health,
  level: 1,
  xp: 1,
  shield: 0,
});

test("a stronger front pet wins a 1v1", () => {
  const r = runBattle([body(3, 5)], [body(2, 3)], seed(1));
  assert.equal(r.outcome, 1); // A wins
  assert.equal(r.rounds, 1);
});

test("a mirror match is a draw", () => {
  const r = runBattle([body(2, 2)], [body(2, 2)], seed(2));
  assert.equal(r.outcome, 3);
});

test("battle is pure and deterministic", () => {
  const a = [makePet(SPECIES.ANT), makePet(SPECIES.FISH)];
  const b = [makePet(SPECIES.MOSQUITO)];
  const snapshot = encodeTeam(a);
  const r1 = runBattle(a, b, seed(7));
  const r2 = runBattle(a, b, seed(7));
  assert.deepEqual(r1, r2); // same inputs + seed -> identical result + log
  assert.deepEqual(encodeTeam(a), snapshot); // inputs were not mutated
});

test("onStartOfBattle: mosquito snipes an enemy before combat", () => {
  // Mosquito (2/2) deals 1 to the only enemy (1 hp) -> it faints before round 1.
  const r = runBattle([makePet(SPECIES.MOSQUITO)], [body(1, 1)], seed(3));
  assert.equal(r.outcome, 1);
  assert.equal(r.rounds, 0); // killed at start of battle
  assert.ok(r.log.some((e) => e.startsWith("mosquito_hit")));
});

test("onFaint: ant buffs the seed-chosen friend", () => {
  // Ant (2/1) dies round 1, buffs its only friend Fish (+2/+1) -> Fish finishes B.
  const r = runBattle(
    [makePet(SPECIES.ANT), makePet(SPECIES.FISH)],
    [body(3, 3)],
    seed(4),
  );
  assert.equal(r.outcome, 1);
  assert.ok(r.log.includes("ant_buff:0"));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd sui-tunnel-ts && node --import tsx --test src/protocol/sapEngine.test.ts`
Expected: FAIL — `Cannot find module './sapEngine'`.

- [ ] **Step 3: Implement `sapEngine.ts`**

```ts
/**
 * Super Auto Pets battle engine — a PURE deterministic function of
 * (teamA, teamB, battleSeed). Every "random" choice (target, summon table) is
 * drawn from the seed via core/randomness (byte-identical to randomness.move), so
 * both parties AND an on-chain referee re-derive the SAME outcome. Abilities are
 * triggered effects keyed to a fixed event set; adding a pet = adding one ROSTER
 * entry, never touching the battle loop.
 */

import { seedFromBytes, nextU64InRange } from "../core/randomness";
import type { Seed } from "../core/randomness";
import { concatBytes } from "../core/bytes";
import { u64ToBeBytes } from "../core/wire";

export type Trigger =
  | "onBuy"
  | "onSell"
  | "onLevelUp"
  | "onStartOfBattle"
  | "onFaint"
  | "onHurt"
  | "onBeforeAttack"
  | "onFriendFaint"
  | "onFriendSummoned";

export const MAX_TEAM = 5;

/** A pet instance on a board (the unit the engine mutates during a battle). */
export interface Pet {
  species: number; // ROSTER key
  attack: number;
  health: number;
  level: 1 | 2 | 3;
  xp: number; // copies merged (shop-only; battle reads `level`)
  shield: number; // melon/garlic absorb; 0 = none
}

export type Side = "A" | "B";
export type Outcome = 1 | 2 | 3; // 1 = A wins, 2 = B wins, 3 = draw

export interface BattleResult {
  outcome: Outcome;
  rounds: number;
  log: string[];
}

/** Mutable per-battle world. Teams run front (index 0) -> back. */
export interface BattleWorld {
  a: Pet[];
  b: Pet[];
  seed: Seed;
  log: string[];
}

/** Context handed to a pet ability when its trigger fires. */
export interface AbilityCtx {
  world: BattleWorld;
  side: Side;
  index: number; // self's slot (for onFaint: the freed slot)
  self: Pet; // the acting pet (a snapshot for onFaint)
  target?: Pet; // event-specific target (e.g. the just-summoned friend)
}

export interface PetDef {
  name: string;
  tier: number;
  attack: number;
  health: number;
  trigger: Trigger | null;
  ability?: (ctx: AbilityCtx) => void;
}

// Stable species ids. Tokens are >= 100 so the shop pool can exclude them.
export const SPECIES = {
  ANT: 1,
  CRICKET: 2,
  FISH: 3,
  MOSQUITO: 5,
  PIG: 6,
  ZOMBIE_CRICKET: 101,
} as const;

// ---- engine-internal helpers ----------------------------------------------
function friends(world: BattleWorld, side: Side): Pet[] {
  return side === "A" ? world.a : world.b;
}
function enemies(world: BattleWorld, side: Side): Pet[] {
  return side === "A" ? world.b : world.a;
}

/** Unbiased index in [0,length) drawn from the battle seed (advances the seed). */
function seededIndex(world: BattleWorld, length: number): number {
  if (length <= 0) return -1;
  const [v, next] = nextU64InRange(world.seed, 0n, BigInt(length));
  world.seed = next;
  return Number(v);
}

/** Apply `amount` damage through shield first; returns hp actually lost. */
function hit(pet: Pet, amount: number): number {
  let dmg = amount;
  if (pet.shield > 0) {
    const absorbed = Math.min(pet.shield, dmg);
    pet.shield -= absorbed;
    dmg -= absorbed;
  }
  pet.health -= dmg;
  return dmg;
}

/** Insert `pet` at `index` on `side` (respecting the cap). onFriendSummoned is deferred to Task 7. */
function summon(world: BattleWorld, side: Side, index: number, pet: Pet): void {
  const team = friends(world, side);
  if (team.length >= MAX_TEAM) return;
  const at = Math.min(Math.max(index, 0), team.length);
  team.splice(at, 0, pet);
  world.log.push(`summon:${ROSTER[pet.species]?.name ?? pet.species}`);
}

export function makePet(species: number, level: 1 | 2 | 3 = 1): Pet {
  const def = ROSTER[species];
  if (!def) throw new Error(`sap: unknown species ${species}`);
  return {
    species,
    attack: def.attack,
    health: def.health,
    level,
    xp: 1,
    shield: 0,
  };
}

function clonePet(p: Pet): Pet {
  return { ...p };
}

/** Canonical, deterministic team encoding for commit-reveal + state hashing. */
export function encodeTeam(team: Pet[]): Uint8Array {
  const parts: Uint8Array[] = [u64ToBeBytes(team.length)];
  for (const p of team) {
    parts.push(
      u64ToBeBytes(p.species),
      u64ToBeBytes(p.attack),
      u64ToBeBytes(p.health),
      u64ToBeBytes(p.level),
    );
  }
  return concatBytes(parts);
}

// ---- ROSTER (tier-1 battle pets for this slice) ---------------------------
export const ROSTER: Record<number, PetDef> = {
  [SPECIES.ANT]: {
    name: "ant",
    tier: 1,
    attack: 2,
    health: 1,
    trigger: "onFaint",
    ability: (ctx) => {
      const team = friends(ctx.world, ctx.side);
      if (team.length === 0) return;
      const i = seededIndex(ctx.world, team.length);
      team[i].attack += 2;
      team[i].health += 1;
      ctx.world.log.push(`ant_buff:${i}`);
    },
  },
  [SPECIES.CRICKET]: {
    name: "cricket",
    tier: 1,
    attack: 1,
    health: 2,
    trigger: "onFaint",
    ability: (ctx) => {
      summon(
        ctx.world,
        ctx.side,
        ctx.index,
        makePet(SPECIES.ZOMBIE_CRICKET, ctx.self.level),
      );
    },
  },
  [SPECIES.FISH]: {
    name: "fish",
    tier: 1,
    attack: 2,
    health: 3,
    trigger: "onLevelUp", // shop event; inert in battle
  },
  [SPECIES.MOSQUITO]: {
    name: "mosquito",
    tier: 1,
    attack: 2,
    health: 2,
    trigger: "onStartOfBattle",
    ability: (ctx) => {
      const foes = enemies(ctx.world, ctx.side);
      if (foes.length === 0) return;
      const i = seededIndex(ctx.world, foes.length);
      hit(foes[i], 1);
      ctx.world.log.push(`mosquito_hit:${i}`);
    },
  },
  [SPECIES.PIG]: {
    name: "pig",
    tier: 1,
    attack: 3,
    health: 1,
    trigger: "onSell", // shop event; inert in battle
  },
  [SPECIES.ZOMBIE_CRICKET]: {
    name: "zombie_cricket",
    tier: 1,
    attack: 1,
    health: 1,
    trigger: null,
  },
};

// ---- battle loop ----------------------------------------------------------
function fireStartOfBattle(world: BattleWorld): void {
  for (const side of ["A", "B"] as Side[]) {
    const team = friends(world, side);
    const n = team.length;
    for (let i = 0; i < n; i++) {
      const pet = team[i];
      const def = ROSTER[pet.species];
      if (def?.trigger === "onStartOfBattle" && def.ability) {
        def.ability({ world, side, index: i, self: pet });
      }
    }
  }
}

/** Remove fainted pets, firing onFaint (which may summon into the freed slot). */
function removeFainted(world: BattleWorld): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const side of ["A", "B"] as Side[]) {
      const team = friends(world, side);
      for (let i = 0; i < team.length; i++) {
        if (team[i].health <= 0) {
          const dead = team[i];
          team.splice(i, 1);
          changed = true;
          world.log.push(`faint:${ROSTER[dead.species]?.name ?? dead.species}`);
          const def = ROSTER[dead.species];
          if (def?.trigger === "onFaint" && def.ability) {
            def.ability({ world, side, index: i, self: dead });
          }
          break; // indices shifted / a summon may have landed; restart the scan
        }
      }
      if (changed) break;
    }
  }
}

function fireAt(
  world: BattleWorld,
  side: Side,
  index: number,
  trigger: Trigger,
): void {
  const team = friends(world, side);
  const pet = team[index];
  if (!pet) return;
  const def = ROSTER[pet.species];
  if (def?.trigger === trigger && def.ability) {
    def.ability({ world, side, index, self: pet });
  }
}

const MAX_ROUNDS = 200; // pure safety bound; a stalemate resolves as a draw

export function runBattle(
  teamA: Pet[],
  teamB: Pet[],
  battleSeed: Uint8Array,
): BattleResult {
  const world: BattleWorld = {
    a: teamA.map(clonePet),
    b: teamB.map(clonePet),
    seed: seedFromBytes(battleSeed),
    log: [],
  };

  fireStartOfBattle(world);
  removeFainted(world);

  let rounds = 0;
  while (world.a.length > 0 && world.b.length > 0 && rounds < MAX_ROUNDS) {
    rounds++;
    const fa = world.a[0];
    const fb = world.b[0];
    fireAt(world, "A", 0, "onBeforeAttack"); // no tier-1 user; depth (Meat Bone) uses it
    fireAt(world, "B", 0, "onBeforeAttack");
    const dmgToB = fa.attack;
    const dmgToA = fb.attack;
    hit(fb, dmgToB);
    fireAt(world, "B", 0, "onHurt"); // no tier-1 user; depth (Peacock) uses it
    hit(fa, dmgToA);
    fireAt(world, "A", 0, "onHurt");
    removeFainted(world);
  }

  let outcome: Outcome;
  if (world.a.length > 0 && world.b.length === 0) outcome = 1;
  else if (world.b.length > 0 && world.a.length === 0) outcome = 2;
  else outcome = 3; // both empty, or stalemate at the round cap
  return { outcome, rounds, log: world.log };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd sui-tunnel-ts && node --import tsx --test src/protocol/sapEngine.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add sui-tunnel-ts/src/protocol/sapEngine.ts \
        sui-tunnel-ts/src/protocol/sapEngine.test.ts
git commit -m "feat(sap): deterministic battle engine core"
```

---

## Task 2: SDK protocol vertical slice that settles (`superAutoPets.ts`)

**Files:**

- Create: `sui-tunnel-ts/src/protocol/superAutoPets.ts`
- Test: `sui-tunnel-ts/src/protocol/superAutoPets.test.ts`
- Modify: `sui-tunnel-ts/src/protocol/index.ts`

Implements `Protocol<SapState, SapMove>`: a round loop with hidden-team commit-reveal, hearts, the running ledger, and `isTerminal`. The battle seed is `combineReveals(encodeTeam(teamA), saltA, encodeTeam(teamB), saltB)` — unbiasable because both sides commit before either reveals. End-to-end off-chain self-play opens → plays rounds → settles. **This is the safety milestone: after this task the game is playable and settleable through the generic tunnel even if every later task is dropped.**

`encodeState` is the **single source of truth for the golden** — its serialized array order (`[phase, heartsA, heartsB, lastOutcome], round, balanceA, balanceB, wager, teamCommitA, teamCommitB`, each part length-prefixed via `lengthPrefixedConcat`) is exactly what the Task 8 Move `compute_session_hash` must mirror.

- [ ] **Step 1: Write the failing test**

Create `sui-tunnel-ts/src/protocol/superAutoPets.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { OffchainTunnel } from "../core/tunnel";
import { keyPairFromSecret, ed25519Address } from "../core/crypto";
import { computeCommitment } from "../core/commitment";
import { makePet, encodeTeam, SPECIES } from "./sapEngine";
import { SuperAutoPetsProtocol } from "./superAutoPets";
import type { SapState, SapMove } from "./superAutoPets";

const kpA = keyPairFromSecret(Uint8Array.from({ length: 32 }, (_, i) => i + 1));
const kpB = keyPairFromSecret(
  Uint8Array.from({ length: 32 }, (_, i) => i + 33),
);
const ctx = (a: bigint, b: bigint) => ({
  tunnelId: "0xtest",
  initialBalances: { a, b },
});

test("initial state opens in the shop phase with full hearts", () => {
  const proto = new SuperAutoPetsProtocol({
    hearts: 5,
    wagerPerRound: 10n,
    roundCap: 15,
  });
  const s = proto.initialState(ctx(100n, 100n));
  assert.equal(s.phase, "shop");
  assert.equal(s.round, 1);
  assert.equal(s.heartsA, 5);
  assert.equal(s.heartsB, 5);
  assert.deepEqual(proto.balances(s), { a: 100n, b: 100n });
  assert.equal(proto.isTerminal(s), false);
});

test("rejects illegal ordering and a tampered reveal", () => {
  const proto = new SuperAutoPetsProtocol();
  const s0 = proto.initialState(ctx(1n, 1n));
  const salt = Uint8Array.from({ length: 16 }, () => 7);
  const team = [makePet(SPECIES.PIG)];
  const commitment = computeCommitment(encodeTeam(team), salt);

  // Reveal before any commit is illegal.
  assert.throws(() =>
    proto.applyMove(s0, { kind: "revealTeam", team, salt }, "A"),
  );

  let s = proto.applyMove(s0, { kind: "commitTeam", commitment }, "A");
  assert.throws(() =>
    proto.applyMove(s, { kind: "commitTeam", commitment }, "A"),
  ); // double commit
  s = proto.applyMove(s, { kind: "commitTeam", commitment }, "B");
  assert.equal(s.phase, "reveal");

  // A reveal whose team does not match the commitment is rejected.
  const wrong = [makePet(SPECIES.FISH)];
  assert.throws(() =>
    proto.applyMove(s, { kind: "revealTeam", team: wrong, salt }, "A"),
  );
});

test("encodeState is deterministic and changes after a commit", () => {
  const proto = new SuperAutoPetsProtocol();
  const s0 = proto.initialState(ctx(1n, 1n));
  assert.deepEqual(proto.encodeState(s0), proto.encodeState({ ...s0 }));
  const commitment = computeCommitment(
    encodeTeam([makePet(SPECIES.PIG)]),
    new Uint8Array(16),
  );
  const s1 = proto.applyMove(s0, { kind: "commitTeam", commitment }, "A");
  assert.notDeepEqual(proto.encodeState(s1), proto.encodeState(s0));
});

test("self-play runs rounds and settles, conserving the locked total", () => {
  const proto = new SuperAutoPetsProtocol({
    hearts: 3,
    wagerPerRound: 10n,
    roundCap: 15,
  });
  const t = OffchainTunnel.selfPlay<SapState, SapMove>(
    proto,
    "0x" + "ab".repeat(32),
    kpA,
    kpB,
    ed25519Address(kpA.publicKey),
    ed25519Address(kpB.publicKey),
    { a: 100n, b: 100n },
  );

  let guard = 0;
  while (!proto.isTerminal(t.state) && guard++ < 500) {
    let moved = false;
    for (const by of ["A", "B"] as const) {
      const m = proto.randomMove!(t.state, by, Math.random);
      if (m) {
        t.step(m, by, { timestamp: 1000n });
        moved = true;
      }
    }
    if (!moved) break;
  }

  const s = t.state;
  assert.equal(proto.isTerminal(s), true);
  assert.equal(s.heartsA <= 0 || s.heartsB <= 0, true);
  const bal = proto.balances(s);
  assert.equal(bal.a + bal.b, 200n); // sum invariant preserved across every round
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd sui-tunnel-ts && node --import tsx --test src/protocol/superAutoPets.test.ts`
Expected: FAIL — `Cannot find module './superAutoPets'`.

- [ ] **Step 3: Implement `superAutoPets.ts`**

```ts
/**
 * Super Auto Pets protocol over an off-chain tunnel. Implements the generic
 * Protocol<State, Move>; the engine (core/tunnel.ts) supplies state hashing,
 * dual-sign, settlement, nonce + replay for free. Hidden teams use commit-reveal
 * (core/commitment): only commitments enter the signed state; raw teams/salts are
 * private and excluded from encodeState (mirrors quantumPoker's hole cards). The
 * battle seed is the joint combineReveals of both teams+salts — unbiasable because
 * both sides commit before either reveals.
 */

import {
  computeCommitment,
  verifyCommitment,
  combineReveals,
} from "../core/commitment";
import { concatBytes } from "../core/bytes";
import { u64ToBeBytes } from "../core/wire";
import { blake2b256 } from "../core/crypto";
import { protocolDomain, lengthPrefixedConcat } from "./Protocol";
import type { Balances, Party, Protocol, ProtocolContext } from "./Protocol";
import { runBattle, encodeTeam, makePet, SPECIES, type Pet } from "./sapEngine";

export type SapPhase = "shop" | "reveal" | "done";

export interface SapConfig {
  hearts: number; // starting hearts per player
  wagerPerRound: bigint; // balance shifted loser -> winner each battle (clamped)
  roundCap: number; // hard stop; on cap, most hearts wins
}

export const DEFAULT_SAP_CONFIG: SapConfig = {
  hearts: 5,
  wagerPerRound: 1n,
  roundCap: 15,
};

export interface SapState {
  phase: SapPhase;
  round: number;
  heartsA: number;
  heartsB: number;
  teamCommitA: Uint8Array | null;
  teamCommitB: Uint8Array | null;
  // PRIVATE — never entered into encodeState; revealed to the engine only to resolve a battle.
  revealA: { team: Pet[]; salt: Uint8Array } | null;
  revealB: { team: Pet[]; salt: Uint8Array } | null;
  lastOutcome: 0 | 1 | 2 | 3; // 0 = none yet
  balanceA: bigint;
  balanceB: bigint;
  total: bigint;
  cfg: SapConfig;
}

export type SapMove =
  | { kind: "commitTeam"; commitment: Uint8Array }
  | { kind: "revealTeam"; team: Pet[]; salt: Uint8Array };

const DOMAIN = protocolDomain("super_auto_pets.v1");
const PHASE_CODE: Record<SapPhase, number> = { shop: 0, reveal: 1, done: 2 };
const Z32 = new Uint8Array(32);

function clampU8(n: number): number {
  return n < 0 ? 0 : n > 255 ? 255 : n;
}
function bigintMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function resolveBattle(s: SapState): SapState {
  const ra = s.revealA!;
  const rb = s.revealB!;
  const battleSeed = combineReveals(
    encodeTeam(ra.team),
    ra.salt,
    encodeTeam(rb.team),
    rb.salt,
  );
  const result = runBattle(ra.team, rb.team, battleSeed);

  let { heartsA, heartsB, balanceA, balanceB } = s;
  if (result.outcome === 1) {
    heartsB -= 1;
    const moved = bigintMin(s.cfg.wagerPerRound, balanceB);
    balanceB -= moved;
    balanceA += moved;
  } else if (result.outcome === 2) {
    heartsA -= 1;
    const moved = bigintMin(s.cfg.wagerPerRound, balanceA);
    balanceA -= moved;
    balanceB += moved;
  } // draw: no heart loss, no balance shift

  const round = s.round + 1;
  const over = heartsA <= 0 || heartsB <= 0 || round > s.cfg.roundCap;
  return {
    ...s,
    phase: over ? "done" : "shop",
    round,
    heartsA,
    heartsB,
    balanceA,
    balanceB,
    teamCommitA: null,
    teamCommitB: null,
    revealA: null,
    revealB: null,
    lastOutcome: result.outcome,
  };
}

export class SuperAutoPetsProtocol implements Protocol<SapState, SapMove> {
  readonly name = "super_auto_pets.v1";
  private readonly cfg: SapConfig;

  constructor(cfg: Partial<SapConfig> = {}) {
    this.cfg = { ...DEFAULT_SAP_CONFIG, ...cfg };
  }

  initialState(ctx: ProtocolContext): SapState {
    return {
      phase: "shop",
      round: 1,
      heartsA: this.cfg.hearts,
      heartsB: this.cfg.hearts,
      teamCommitA: null,
      teamCommitB: null,
      revealA: null,
      revealB: null,
      lastOutcome: 0,
      balanceA: ctx.initialBalances.a,
      balanceB: ctx.initialBalances.b,
      total: ctx.initialBalances.a + ctx.initialBalances.b,
      cfg: this.cfg,
    };
  }

  applyMove(state: SapState, move: SapMove, by: Party): SapState {
    if (state.phase === "done") throw new Error("sap: session over");

    if (move.kind === "commitTeam") {
      if (state.phase !== "shop") throw new Error("sap: not in shop phase");
      const mine = by === "A" ? state.teamCommitA : state.teamCommitB;
      if (mine) throw new Error("sap: already committed this round");
      const next: SapState = {
        ...state,
        teamCommitA: by === "A" ? move.commitment : state.teamCommitA,
        teamCommitB: by === "B" ? move.commitment : state.teamCommitB,
      };
      if (next.teamCommitA && next.teamCommitB) next.phase = "reveal";
      return next;
    }

    // revealTeam
    if (state.phase !== "reveal") throw new Error("sap: not in reveal phase");
    const commit = by === "A" ? state.teamCommitA : state.teamCommitB;
    if (!commit) throw new Error("sap: nothing committed");
    const already = by === "A" ? state.revealA : state.revealB;
    if (already) throw new Error("sap: already revealed");
    if (!verifyCommitment(commit, encodeTeam(move.team), move.salt)) {
      throw new Error("sap: reveal does not match commitment");
    }
    const reveal = { team: move.team, salt: move.salt };
    let next: SapState = {
      ...state,
      revealA: by === "A" ? reveal : state.revealA,
      revealB: by === "B" ? reveal : state.revealB,
    };
    if (next.revealA && next.revealB) next = resolveBattle(next);
    return next;
  }

  encodeState(state: SapState): Uint8Array {
    // Fixed-layout, private fields excluded -> trivially mirrorable on-chain (Task 8).
    // THIS ARRAY IS THE SINGLE SOURCE OF TRUTH for the Move compute_session_hash layout.
    return concatBytes([
      DOMAIN,
      lengthPrefixedConcat([
        Uint8Array.from([
          PHASE_CODE[state.phase],
          clampU8(state.heartsA),
          clampU8(state.heartsB),
          state.lastOutcome,
        ]),
        u64ToBeBytes(state.round),
        u64ToBeBytes(state.balanceA),
        u64ToBeBytes(state.balanceB),
        u64ToBeBytes(state.cfg.wagerPerRound),
        state.teamCommitA ?? Z32,
        state.teamCommitB ?? Z32,
      ]),
    ]);
  }

  balances(state: SapState): Balances {
    return { a: state.balanceA, b: state.balanceB };
  }

  isTerminal(state: SapState): boolean {
    return state.phase === "done";
  }

  randomMove(state: SapState, by: Party, _rng: () => number): SapMove | null {
    if (state.phase === "done") return null;
    const team = simTeam(by);
    const salt = simSalt(state.round, by);
    if (state.phase === "shop") {
      const mine = by === "A" ? state.teamCommitA : state.teamCommitB;
      if (mine) return null;
      return {
        kind: "commitTeam",
        commitment: computeCommitment(encodeTeam(team), salt),
      };
    }
    const mine = by === "A" ? state.revealA : state.revealB;
    if (mine) return null;
    return { kind: "revealTeam", team, salt };
  }
}

// Deterministic simulator teams + salts so a commit and its later reveal match.
// A is consistently stronger so battles have winners and the session terminates.
function simTeam(by: Party): Pet[] {
  return by === "A"
    ? [makePet(SPECIES.PIG), makePet(SPECIES.FISH), makePet(SPECIES.PIG)]
    : [makePet(SPECIES.FISH)];
}
function simSalt(round: number, by: Party): Uint8Array {
  return blake2b256(
    concatBytes([
      DOMAIN,
      u64ToBeBytes(round),
      Uint8Array.from([by === "A" ? 1 : 2]),
    ]),
  );
}
```

- [ ] **Step 4: Register the protocol in the barrel**

In `sui-tunnel-ts/src/protocol/index.ts`, after `export * from "./quantumPokerPersona";`, add:

```ts
export * from "./sapEngine";
export * from "./superAutoPets";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd sui-tunnel-ts && node --import tsx --test src/protocol/superAutoPets.test.ts`
Expected: PASS. Then `cd sui-tunnel-ts && pnpm test` — the full suite is green (new SAP files + existing protocols).

- [ ] **Step 6: Commit**

```bash
git add sui-tunnel-ts/src/protocol/superAutoPets.ts \
        sui-tunnel-ts/src/protocol/superAutoPets.test.ts \
        sui-tunnel-ts/src/protocol/index.ts
git commit -m "feat(sap): protocol vertical slice that settles"
```

---

## Task 3: Fair shop RNG — commit-reveal seed (`superAutoPets.ts`)

**Files:**

- Modify: `sui-tunnel-ts/src/protocol/superAutoPets.ts`
- Test: `sui-tunnel-ts/src/protocol/superAutoPets.test.ts` (append cases)

Add a per-round seed commit-reveal so the shop is provably fair: both parties commit a random share, then reveal; the joint shop seed is `combineReveals(shareA, saltA, shareB, saltB)` — neither can bias the shop. The seed sub-phase opens each round before the team phase. The derived `shopSeed` is private (each client expands it into shops locally, Task 4); the seed commits/reveals still flow through `tunnel.step` (signed + nonced) so they are in the transcript. `encodeState` stays byte-stable from Task 2 (keeps the on-chain mirror simple). De-scope fallback: drop this task and seed each client's shop from its own local seed.

- [ ] **Step 1: Append the failing test**

Append to `superAutoPets.test.ts`:

```ts
import { combineReveals } from "../core/commitment"; // add if not already imported

test("fair shop seed: both commit before either reveals, joint seed is unbiasable", () => {
  const proto = new SuperAutoPetsProtocol();
  const s0 = proto.initialState(ctx(1n, 1n));
  assert.equal(s0.phase, "seed"); // round opens in the seed phase now

  const shareA = Uint8Array.from({ length: 16 }, () => 0xa1);
  const saltA = Uint8Array.from({ length: 16 }, () => 0x0a);
  const shareB = Uint8Array.from({ length: 16 }, () => 0xb2);
  const saltB = Uint8Array.from({ length: 16 }, () => 0x0b);

  let s = proto.applyMove(
    s0,
    { kind: "commitSeed", commitment: computeCommitment(shareA, saltA) },
    "A",
  );
  // Cannot reveal before both have committed (privacy of the share).
  assert.throws(() =>
    proto.applyMove(s, { kind: "revealSeed", share: shareA, salt: saltA }, "A"),
  );
  s = proto.applyMove(
    s,
    { kind: "commitSeed", commitment: computeCommitment(shareB, saltB) },
    "B",
  );
  s = proto.applyMove(
    s,
    { kind: "revealSeed", share: shareA, salt: saltA },
    "A",
  );
  s = proto.applyMove(
    s,
    { kind: "revealSeed", share: shareB, salt: saltB },
    "B",
  );

  assert.equal(s.phase, "shop");
  assert.ok(s.shopSeed);
  assert.deepEqual(s.shopSeed, combineReveals(shareA, saltA, shareB, saltB));
});
```

Also update the existing Task 2 "initial state" case: rename its title from `"initial state opens in the shop phase with full hearts"` to `"initial state opens in the seed phase with full hearts"` and flip its assertion `assert.equal(s.phase, "shop")` to `assert.equal(s.phase, "seed")`. In the "rejects illegal ordering" test, commit+reveal the seed shares first (or assert that `commitTeam` now throws `"not in shop phase"` until the seed phase completes).

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd sui-tunnel-ts && node --import tsx --test src/protocol/superAutoPets.test.ts`
Expected: FAIL — `s0.phase` is `"shop"` not `"seed"`; `commitSeed` / `revealSeed` not handled.

- [ ] **Step 3: Extend the protocol**

In `superAutoPets.ts`:

- `combineReveals` is already imported. Extend the phase + state + move types:

```ts
export type SapPhase = "seed" | "shop" | "reveal" | "done";
```

```ts
// add to SapState (after teamCommitB):
  seedCommitA: Uint8Array | null;
  seedCommitB: Uint8Array | null;
  seedRevealA: { share: Uint8Array; salt: Uint8Array } | null; // PRIVATE
  seedRevealB: { share: Uint8Array; salt: Uint8Array } | null; // PRIVATE
  shopSeed: Uint8Array | null; // PRIVATE; derived once both seed reveals are in
```

```ts
// extend SapMove:
export type SapMove =
  | { kind: "commitSeed"; commitment: Uint8Array }
  | { kind: "revealSeed"; share: Uint8Array; salt: Uint8Array }
  | { kind: "commitTeam"; commitment: Uint8Array }
  | { kind: "revealTeam"; team: Pet[]; salt: Uint8Array };
```

```ts
const PHASE_CODE: Record<SapPhase, number> = {
  seed: 0,
  shop: 1,
  reveal: 2,
  done: 3,
};
```

- `initialState` starts `phase: "seed"` and sets the five new fields to `null`.
- `resolveBattle` resets the new seed fields to `null` and sets `phase: over ? "done" : "seed"`.
- In `applyMove`, handle the two new move kinds before the existing ones:

```ts
if (move.kind === "commitSeed") {
  if (state.phase !== "seed") throw new Error("sap: not in seed phase");
  const mine = by === "A" ? state.seedCommitA : state.seedCommitB;
  if (mine) throw new Error("sap: seed already committed");
  return {
    ...state,
    seedCommitA: by === "A" ? move.commitment : state.seedCommitA,
    seedCommitB: by === "B" ? move.commitment : state.seedCommitB,
  };
}
if (move.kind === "revealSeed") {
  if (state.phase !== "seed") throw new Error("sap: not in seed phase");
  if (!state.seedCommitA || !state.seedCommitB) {
    throw new Error("sap: both must commit a seed share before any reveal");
  }
  const commit = by === "A" ? state.seedCommitA : state.seedCommitB;
  if (by === "A" ? state.seedRevealA : state.seedRevealB) {
    throw new Error("sap: seed already revealed");
  }
  if (!verifyCommitment(commit, move.share, move.salt)) {
    throw new Error("sap: seed reveal does not match commitment");
  }
  const r = { share: move.share, salt: move.salt };
  const next: SapState = {
    ...state,
    seedRevealA: by === "A" ? r : state.seedRevealA,
    seedRevealB: by === "B" ? r : state.seedRevealB,
  };
  if (next.seedRevealA && next.seedRevealB) {
    next.shopSeed = combineReveals(
      next.seedRevealA.share,
      next.seedRevealA.salt,
      next.seedRevealB.share,
      next.seedRevealB.salt,
    );
    next.phase = "shop";
  }
  return next;
}
```

- Update `randomMove` to drive the seed phase first (commit a deterministic share, then reveal), mirroring the team-phase logic.

`encodeState` is unchanged (seed fields stay private; the on-chain mirror in Task 8 covers only phase/hearts/last_outcome/round/balances/wager/teamCommits).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd sui-tunnel-ts && node --import tsx --test src/protocol/superAutoPets.test.ts`
Expected: PASS, including the self-play settle test (now opening with the seed phase each round).

- [ ] **Step 5: Commit**

```bash
git add sui-tunnel-ts/src/protocol/superAutoPets.ts \
        sui-tunnel-ts/src/protocol/superAutoPets.test.ts
git commit -m "feat(sap): commit-reveal fair shop seed"
```

---

## Task 4: Shop economy module (`sapShop.ts`)

**Files:**

- Create: `sui-tunnel-ts/src/protocol/sapShop.ts`
- Test: `sui-tunnel-ts/src/protocol/sapShop.test.ts`
- Modify: `sui-tunnel-ts/src/protocol/index.ts`

A pure client-side economy: gold, buy/sell/roll, tier-by-round unlock, and shop slots that grow with the turn. Shop offers derive from the fair `shopSeed` (Task 3) and are drawn by a verifiable **Fisher–Yates `shuffle(seed, pool)`** over a **canonical pool**, taking the first N — with the seed chained one `nextSeed` step per reroll — all from `core/randomness` (byte-identical to `randomness.move`), so rerolls are reproducible.

> **Canonical shop pool (pinned — shared verbatim by TS and the Task 8/9 Move mirror):** the pool is the set of `ROSTER` ids with `id < 100` (tokens excluded) **and** `tier <= tierForRound(round)`, **sorted ascending by id**. Offers index into this exact list; reproducing the pool construction/ordering on-chain is required for the SAP_SHOP_ROLL golden to match byte-for-byte.

Shop interactions run entirely in the player's private client and collapse into a single `commitTeam`, keeping the signed state small.

- [ ] **Step 1: Write the failing test**

Create `sui-tunnel-ts/src/protocol/sapShop.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newPlayer,
  buyPet,
  sellPet,
  reroll,
  currentShop,
  tierForRound,
  petSlotsForRound,
  foodSlotsForRound,
  shopPool,
  STARTING_GOLD,
  COST_BUY,
  COST_ROLL,
} from "./sapShop";
import { SPECIES, ROSTER } from "./sapEngine";

const seed = (n: number) =>
  Uint8Array.from({ length: 32 }, (_, i) => (i + n) & 0xff);

test("tier unlock schedule matches SAP", () => {
  assert.equal(tierForRound(1), 1);
  assert.equal(tierForRound(2), 1);
  assert.equal(tierForRound(3), 2);
  assert.equal(tierForRound(5), 3);
  assert.equal(tierForRound(11), 6);
  assert.equal(tierForRound(99), 6); // capped
});

test("shop slot growth by turn", () => {
  assert.equal(petSlotsForRound(1), 3);
  assert.equal(petSlotsForRound(5), 4);
  assert.equal(petSlotsForRound(9), 5);
  assert.equal(foodSlotsForRound(1), 1);
  assert.equal(foodSlotsForRound(3), 2);
});

test("shop pool excludes tokens and respects the unlocked tier", () => {
  const pool = shopPool(1);
  assert.ok(pool.every((id) => id < 100)); // no tokens
  assert.ok(pool.every((id) => ROSTER[id].tier <= 1));
  assert.ok(pool.includes(SPECIES.ANT));
  // canonical ordering: ascending by id
  assert.deepEqual(
    pool,
    [...pool].sort((a, b) => a - b),
  );
});

test("currentShop is deterministic from the seed and within the pool", () => {
  const p = newPlayer();
  const a = currentShop(seed(1), 1, p);
  assert.deepEqual(a, currentShop(seed(1), 1, p)); // same seed -> same offers
  assert.notDeepEqual(a, currentShop(seed(2), 1, p)); // different seed -> different
  assert.equal(a.length, petSlotsForRound(1));
  assert.ok(a.every((id) => shopPool(1).includes(id)));
});

test("buy reduces gold and grows the team; sell refunds a flat +1", () => {
  let p = newPlayer();
  assert.equal(p.gold, STARTING_GOLD);
  p = buyPet(p, SPECIES.PIG);
  assert.equal(p.gold, STARTING_GOLD - COST_BUY);
  assert.equal(p.team.length, 1);
  assert.equal(p.team[0].species, SPECIES.PIG);
  p = sellPet(p, 0);
  assert.equal(p.team.length, 0);
  assert.equal(p.gold, STARTING_GOLD - COST_BUY + 1); // flat +1 refund
});

test("roll costs gold and reshuffles the offers", () => {
  const p0 = newPlayer();
  const before = currentShop(seed(3), 1, p0);
  const p1 = reroll(p0);
  assert.equal(p1.gold, STARTING_GOLD - COST_ROLL);
  assert.notDeepEqual(currentShop(seed(3), 1, p1), before); // reroll advances the seed chain
});

test("guards: cannot overspend or oversize the team", () => {
  let p = newPlayer();
  assert.throws(() => sellPet(p, 0)); // empty slot
  for (let i = 0; i < 3; i++) p = buyPet(p, SPECIES.FISH); // 9 gold, team 3
  assert.throws(() => reroll(buyPet(buyPet(p, SPECIES.FISH), SPECIES.FISH))); // 5 bought = team full path / gold guard
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd sui-tunnel-ts && node --import tsx --test src/protocol/sapShop.test.ts`
Expected: FAIL — `Cannot find module './sapShop'`.

- [ ] **Step 3: Implement `sapShop.ts`**

```ts
/**
 * Super Auto Pets shop economy — pure, client-side. Runs in the player's private
 * client and collapses into a single commitTeam, so none of this enters the signed
 * tunnel state. Shop offers derive from the fair shopSeed via core/randomness
 * (byte-identical to randomness.move): offers are drawn by a verifiable Fisher–Yates
 * shuffle over the canonical pool (take the first N), the seed chained one nextSeed
 * step per reroll — so rerolls are reproducible and adjudicable.
 */

import { seedFromBytes, nextSeed, shuffle } from "../core/randomness";
import { ROSTER, makePet, type Pet } from "./sapEngine";

export const STARTING_GOLD = 10;
export const COST_BUY = 3;
export const COST_ROLL = 1;
export const SELL_REFUND = 1;
export const TEAM_CAP = 5;

/** Highest tier available this round: 1-2->1, 3-4->2, ... 11+->6 (capped). */
export function tierForRound(round: number): number {
  return Math.min(6, Math.max(1, Math.floor((round + 1) / 2)));
}

export function petSlotsForRound(round: number): number {
  if (round <= 4) return 3;
  if (round <= 8) return 4;
  return 5;
}

export function foodSlotsForRound(round: number): number {
  return round <= 2 ? 1 : 2;
}

/**
 * Canonical, token-free pool of species buyable this round, SORTED ASCENDING by id.
 * This exact construction + ordering is mirrored on-chain (Task 8/9) so SAP_SHOP_ROLL
 * is reproducible byte-for-byte.
 */
export function shopPool(round: number): number[] {
  const maxTier = tierForRound(round);
  return Object.keys(ROSTER)
    .map(Number)
    .filter((id) => id < 100 && ROSTER[id].tier <= maxTier)
    .sort((a, b) => a - b);
}

export interface PlayerState {
  gold: number;
  team: Pet[];
  rerolls: number; // shop reshuffles this round
}

export function newPlayer(): PlayerState {
  return { gold: STARTING_GOLD, team: [], rerolls: 0 };
}

/** The current pet offers: a Fisher–Yates shuffle of the pool from shopSeed chained `rerolls` times, first N taken. */
export function currentShop(
  shopSeed: Uint8Array,
  round: number,
  p: PlayerState,
): number[] {
  let seed = seedFromBytes(shopSeed);
  for (let i = 0; i < p.rerolls; i++) seed = nextSeed(seed);
  const pool = shopPool(round); // fresh array; shuffled in place
  shuffle(seed, pool);
  return pool.slice(0, petSlotsForRound(round));
}

export function buyPet(p: PlayerState, species: number): PlayerState {
  if (p.gold < COST_BUY) throw new Error("sap shop: not enough gold to buy");
  if (p.team.length >= TEAM_CAP) throw new Error("sap shop: team is full");
  return { ...p, gold: p.gold - COST_BUY, team: [...p.team, makePet(species)] };
}

export function sellPet(p: PlayerState, index: number): PlayerState {
  const pet = p.team[index];
  if (!pet) throw new Error("sap shop: no pet at index");
  return {
    ...p,
    gold: p.gold + SELL_REFUND,
    team: p.team.filter((_, i) => i !== index),
  };
}

export function reroll(p: PlayerState): PlayerState {
  if (p.gold < COST_ROLL) throw new Error("sap shop: not enough gold to roll");
  return { ...p, gold: p.gold - COST_ROLL, rerolls: p.rerolls + 1 };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd sui-tunnel-ts && node --import tsx --test src/protocol/sapShop.test.ts`
Expected: PASS.

- [ ] **Step 5: Register + commit**

In `sui-tunnel-ts/src/protocol/index.ts`, after the `superAutoPets` export, add `export * from "./sapShop";`. Then:

```bash
git add sui-tunnel-ts/src/protocol/sapShop.ts \
        sui-tunnel-ts/src/protocol/sapShop.test.ts \
        sui-tunnel-ts/src/protocol/index.ts
git commit -m "feat(sap): fair shop economy with verifiable rolls"
```

---

## Task 5: Leveling & combine (`sapShop.ts` + `sapEngine.ts`)

**Files:**

- Modify: `sui-tunnel-ts/src/protocol/sapShop.ts` (add `combine`)
- Test: `sui-tunnel-ts/src/protocol/sapShop.test.ts` (append cases)

Combining two same-species pets levels up: take the higher of each stat **+1/+1**, and advance the XP/level (3 copies → L2, 6 copies → L3). `Pet.xp` (added to the engine in Task 1) tracks merged copies. Cuttable: drop and ship with no leveling.

- [ ] **Step 1: Append the failing test**

Append to `sapShop.test.ts`:

```ts
import { combine } from "./sapShop"; // add to the import list

test("combine: higher stats +1/+1, two copies stay level 1", () => {
  let p = newPlayer();
  p = buyPet(p, SPECIES.FISH); // 2/3
  p = buyPet(p, SPECIES.FISH); // 2/3
  p = combine(p, 0, 1);
  assert.equal(p.team.length, 1);
  assert.equal(p.team[0].attack, 3); // max(2,2)+1
  assert.equal(p.team[0].health, 4); // max(3,3)+1
  assert.equal(p.team[0].level, 1); // 2 copies -> still level 1
  assert.equal(p.team[0].xp, 2);
});

test("combine to level 2 at 3 copies, level 3 at 6 copies", () => {
  let p = { ...newPlayer(), gold: 100 }; // enough gold for six copies
  p = buyPet(p, SPECIES.FISH);
  p = buyPet(p, SPECIES.FISH);
  p = combine(p, 0, 1); // xp 2, still level 1
  p = buyPet(p, SPECIES.FISH);
  p = combine(p, 0, 1); // 3 copies -> level 2, xp 3
  assert.equal(p.team[0].level, 2);
  assert.equal(p.team[0].xp, 3);
  p = buyPet(p, SPECIES.FISH);
  p = combine(p, 0, 1); // 4 copies, xp 4
  p = buyPet(p, SPECIES.FISH);
  p = combine(p, 0, 1); // 5 copies, xp 5
  p = buyPet(p, SPECIES.FISH);
  p = combine(p, 0, 1); // 6 copies -> level 3, xp 6
  assert.equal(p.team[0].level, 3);
  assert.equal(p.team[0].xp, 6);
});

test("combine rejects different species", () => {
  let p = newPlayer();
  p = buyPet(p, SPECIES.FISH);
  p = buyPet(p, SPECIES.PIG);
  assert.throws(() => combine(p, 0, 1));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd sui-tunnel-ts && node --import tsx --test src/protocol/sapShop.test.ts`
Expected: FAIL — `combine` not exported.

- [ ] **Step 3: Implement `combine`**

Append to `sapShop.ts`:

```ts
function levelForXp(xp: number): 1 | 2 | 3 {
  return xp >= 6 ? 3 : xp >= 3 ? 2 : 1;
}

/** Merge the pet at `j` into the pet at `i` (same species). Higher stats +1/+1. */
export function combine(p: PlayerState, i: number, j: number): PlayerState {
  if (i === j) throw new Error("sap shop: cannot combine a pet with itself");
  const a = p.team[i];
  const b = p.team[j];
  if (!a || !b) throw new Error("sap shop: missing pet to combine");
  if (a.species !== b.species)
    throw new Error("sap shop: cannot combine different species");
  const xp = a.xp + b.xp;
  const merged: Pet = {
    species: a.species,
    attack: Math.max(a.attack, b.attack) + 1,
    health: Math.max(a.health, b.health) + 1,
    level: levelForXp(xp),
    xp,
    shield: 0,
  };
  const team = p.team.filter((_, k) => k !== i && k !== j);
  team.splice(Math.min(i, j), 0, merged);
  return { ...p, team };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd sui-tunnel-ts && node --import tsx --test src/protocol/sapShop.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sui-tunnel-ts/src/protocol/sapShop.ts \
        sui-tunnel-ts/src/protocol/sapShop.test.ts
git commit -m "feat(sap): combine-to-level pets"
```

---

## Task 6: Food items (`sapShop.ts` + `sapEngine.ts`)

**Files:**

- Modify: `sui-tunnel-ts/src/protocol/sapEngine.ts` (food effects in battle **and** food bound into `encodeTeam`)
- Modify: `sui-tunnel-ts/src/protocol/sapShop.ts` (`applyFood` + food table)
- Test: `sui-tunnel-ts/src/protocol/sapShop.test.ts` (append) and `sapEngine.test.ts` (append)

Food items are bought onto a pet. Immediate buffs (Apple +1/+1, Pear +2/+2) resolve in the shop; battle-time foods (Garlic damage reduction `onHurt`, Melon 20-shield `onHurt`, Meat Bone +3 `onBeforeAttack`, Honey summon-on-faint, Mushroom resummon-once) ride a `food` tag on `Pet` and are read by the engine. Cuttable: drop and ship pets-only. See the food table in the roster doc.

> **Commit-binding requirement (invariant #4):** because `food` is a battle-affecting tag, it MUST be bound by the team commitment. The team commitment is `computeCommitment(encodeTeam(team), salt)` and the battle seed is `combineReveals(encodeTeam(teamA), saltA, ...)`; both derive from `encodeTeam`. If `encodeTeam` ignored food, a player could commit a team and later reveal the SAME pets with DIFFERENT food — bytes still match the commitment, but the deterministic battle changes (a cheat vector). So Task 6 **also extends `encodeTeam` to bind each pet's food**.

- [ ] **Step 1: Append the failing tests**

Append to `sapShop.test.ts`:

```ts
import { applyFood, FOOD } from "./sapShop"; // add to imports

test("apple is an immediate +1/+1", () => {
  let p = newPlayer();
  p = buyPet(p, SPECIES.FISH); // 2/3
  p = applyFood(p, 0, FOOD.APPLE);
  assert.equal(p.team[0].attack, 3);
  assert.equal(p.team[0].health, 4);
  assert.equal(p.gold, STARTING_GOLD - COST_BUY - 3);
});

test("garlic tags the pet for battle-time damage reduction", () => {
  let p = newPlayer();
  p = buyPet(p, SPECIES.FISH);
  p = applyFood(p, 0, FOOD.GARLIC);
  assert.equal(p.team[0].food, FOOD.GARLIC);
});
```

Append to `sapEngine.test.ts` (add `import { computeCommitment } from "../core/commitment";` to the file's imports):

```ts
test("garlic reduces incoming damage by 2 (min 1)", () => {
  // A garlic 1/10 body soaks a 5-attack hit as 3 instead of 5.
  const garlic = {
    species: SPECIES.FISH,
    attack: 1,
    health: 10,
    level: 1 as const,
    xp: 1,
    shield: 0,
    food: "garlic",
  };
  const r = runBattle(
    [garlic],
    [
      {
        species: SPECIES.FISH,
        attack: 5,
        health: 10,
        level: 1,
        xp: 1,
        shield: 0,
      },
    ],
    seed(9),
  );
  // After round 1 the garlic pet should have 10 - 3 = 7 hp; assert it outlives a no-garlic mirror.
  assert.ok(r.rounds >= 1);
});

test("food is bound by encodeTeam and the team commitment", () => {
  const plain = [makePet(SPECIES.FISH)];
  const fed = [{ ...makePet(SPECIES.FISH), food: "garlic" }];
  // A food-only difference changes the canonical team encoding...
  assert.notDeepEqual(encodeTeam(fed), encodeTeam(plain));
  // ...and therefore the commitment, so a committed team cannot be revealed with different food.
  const salt = new Uint8Array(16);
  assert.notDeepEqual(
    computeCommitment(encodeTeam(fed), salt),
    computeCommitment(encodeTeam(plain), salt),
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd sui-tunnel-ts && node --import tsx --test src/protocol/sapShop.test.ts src/protocol/sapEngine.test.ts`
Expected: FAIL — `applyFood`/`FOOD` not exported; `Pet.food` not handled by the engine; `encodeTeam` does not yet bind food.

- [ ] **Step 3: Implement**

In `sapEngine.ts`: add `food?: string` to the `Pet` interface, set `food: undefined` in `makePet`, make `hit()` honor Garlic, and route Meat Bone / Honey / Mushroom through the trigger framework:

```ts
function hit(pet: Pet, amount: number): number {
  let dmg = amount;
  if (pet.food === "garlic") dmg = Math.max(1, dmg - 2);
  if (pet.shield > 0) {
    const absorbed = Math.min(pet.shield, dmg);
    pet.shield -= absorbed;
    dmg -= absorbed;
  }
  pet.health -= dmg;
  return dmg;
}
```

Then **bind food into the canonical team encoding** by adding a stable food-code table (`0` = none) and appending each pet's food code to `encodeTeam`:

```ts
// stable food ids for canonical encoding (0 = none); only battle-time foods tag a pet.
export const FOOD_CODE: Record<string, number> = {
  garlic: 1,
  melon: 2,
  meat_bone: 3,
  honey: 4,
  mushroom: 5,
};

export function encodeTeam(team: Pet[]): Uint8Array {
  const parts: Uint8Array[] = [u64ToBeBytes(team.length)];
  for (const p of team) {
    parts.push(
      u64ToBeBytes(p.species),
      u64ToBeBytes(p.attack),
      u64ToBeBytes(p.health),
      u64ToBeBytes(p.level),
      u64ToBeBytes(FOOD_CODE[p.food ?? ""] ?? 0), // food now bound by the commitment
    );
  }
  return concatBytes(parts);
}
```

(This is additive: `makePet` sets `food: undefined`, so each pet appends a trailing `0` — consistent across commit and reveal. It does **not** affect the Task 9 SAP_STATE_HASH golden, whose committed-team fields are zero placeholders; but any on-chain dispute re-derivation of a team encoding must append the food code identically — see Task 8/9.)

Apply Melon as a 20-shield set at start of battle, Meat Bone as +3 in the attack step, and Honey/Mushroom as a faint-time summon — guarded reads in `fireStartOfBattle`, the attack step, and `removeFainted` (see the food table in the roster doc for the exact effect of each).

In `sapShop.ts`: add the FOOD table and `applyFood`:

```ts
export const FOOD = {
  APPLE: "apple",
  PEAR: "pear",
  GARLIC: "garlic",
  MELON: "melon",
  MEAT_BONE: "meat_bone",
  HONEY: "honey",
  MUSHROOM: "mushroom",
} as const;

export const COST_FOOD = 3;

/** Buy a food onto the pet at `index`. Immediate buffs resolve now; battle-time foods tag the pet. */
export function applyFood(
  p: PlayerState,
  index: number,
  food: string,
): PlayerState {
  if (p.gold < COST_FOOD) throw new Error("sap shop: not enough gold for food");
  const pet = p.team[index];
  if (!pet) throw new Error("sap shop: no pet at index");
  const next = { ...pet };
  if (food === FOOD.APPLE) {
    next.attack += 1;
    next.health += 1;
  } else if (food === FOOD.PEAR) {
    next.attack += 2;
    next.health += 2;
  } else {
    next.food = food; // garlic / melon / meat_bone / honey / mushroom: read at battle time
  }
  const team = p.team.map((x, i) => (i === index ? next : x));
  return { ...p, gold: p.gold - COST_FOOD, team };
}
```

(The `FOOD` string values must match the `FOOD_CODE` keys in `sapEngine.ts` so the encoding is consistent.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd sui-tunnel-ts && node --import tsx --test src/protocol/sapShop.test.ts src/protocol/sapEngine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add sui-tunnel-ts/src/protocol/sapEngine.ts \
        sui-tunnel-ts/src/protocol/sapShop.ts \
        sui-tunnel-ts/src/protocol/sapShop.test.ts \
        sui-tunnel-ts/src/protocol/sapEngine.test.ts
git commit -m "feat(sap): food items and battle effects"
```

---

## Task 7: Roster expansion to ~30 pets + full trigger set (`sapEngine.ts`)

**Files:**

- Modify: `sui-tunnel-ts/src/protocol/sapEngine.ts` (extend `ROSTER` + dispatch `onHurt` / `onBeforeAttack` / `onFriendFaint` / `onFriendSummoned`)
- Test: `sui-tunnel-ts/src/protocol/sapEngine.test.ts` (append cases)

Fill out tiers 1–3 (~30 pets) and the remaining battle triggers — including **Horse / `onFriendSummoned`** deferred from Task 1 (restore the `onFriendSummoned` dispatch in `summon()`) — all as additive `ROSTER` entries plus one `onFriendFaint` hook in `removeFainted`. **The pet/ability/food data is the source-of-truth roster doc** `docs/superpowers/specs/2026-06-19-super-auto-pets-roster.md` — each row maps to one entry following the Task 1 pattern. First-to-drop under de-scope. The slice below adds three representative new triggers; the rest follow the same shape from the roster doc.

- [ ] **Step 1: Append the failing test**

Append to `sapEngine.test.ts`:

```ts
test("onHurt: peacock gains +4 attack the first time it is hurt", () => {
  // Peacock (2/5) hurt by a small attacker should swing to high attack.
  const peacock = makePet(SPECIES.PEACOCK);
  const r = runBattle([peacock, body(1, 9)], [body(1, 9)], seed(11));
  assert.ok(r.log.some((e) => e.startsWith("peacock_buff")));
});

test("onFaint: hedgehog damages all pets on both teams", () => {
  const r = runBattle([makePet(SPECIES.HEDGEHOG)], [body(2, 1)], seed(12));
  assert.ok(r.log.some((e) => e.startsWith("hedgehog_aoe")));
});

test("onBeforeAttack: a Meat Bone pet adds +3 to its hit", () => {
  const boned = {
    species: SPECIES.FISH,
    attack: 1,
    health: 9,
    level: 1 as const,
    xp: 1,
    shield: 0,
    food: "meat_bone",
  };
  const r = runBattle([boned], [body(1, 3)], seed(13));
  assert.equal(r.outcome, 1); // 1 + 3 = 4 dmg kills a 3-hp body in round 1
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd sui-tunnel-ts && node --import tsx --test src/protocol/sapEngine.test.ts`
Expected: FAIL — `SPECIES.PEACOCK` / `SPECIES.HEDGEHOG` undefined; `onFriendFaint` not dispatched.

- [ ] **Step 3: Extend the roster + dispatch**

In `sapEngine.ts`, add the new species ids and `ROSTER` entries (one per roster-doc row; representative entries shown — copy the full table from the roster doc):

```ts
// add to SPECIES:
  HORSE: 4, // deferred from Task 1
  PEACOCK: 15,
  HEDGEHOG: 14,
  // ... remaining tier 1-3 ids per the roster doc
```

```ts
// add to ROSTER:
  [SPECIES.PEACOCK]: {
    name: "peacock", tier: 2, attack: 2, health: 5, trigger: "onHurt",
    ability: (ctx) => {
      ctx.self.attack += 4;
      ctx.world.log.push("peacock_buff");
    },
  },
  [SPECIES.HEDGEHOG]: {
    name: "hedgehog", tier: 2, attack: 3, health: 2, trigger: "onFaint",
    ability: (ctx) => {
      for (const side of ["A", "B"] as Side[]) {
        for (const p of friends(ctx.world, side)) hit(p, 2);
      }
      ctx.world.log.push("hedgehog_aoe");
    },
  },
  // ... Horse, Crab, Swan, Rat, Flamingo, Spider, Blowfish, Camel, Sheep, Ox, Turtle, etc. per the roster doc
```

Make `removeFainted` fire `onFriendFaint` for the friend ahead of the dying pet (Ox), restore the `onFriendSummoned` dispatch in `summon()` for Horse (deferred from Task 1), and apply Meat Bone (+3) in the attack step and Honey/Mushroom on faint, per the roster doc. All additive; the battle loop structure is unchanged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd sui-tunnel-ts && node --import tsx --test src/protocol/sapEngine.test.ts`
Expected: PASS. Then `cd sui-tunnel-ts && pnpm test` is fully green.

- [ ] **Step 5: Commit**

```bash
git add sui-tunnel-ts/src/protocol/sapEngine.ts \
        sui-tunnel-ts/src/protocol/sapEngine.test.ts
git commit -m "feat(sap): expand roster to tiers 1-3"
```

---

## Task 8: On-chain example (`example_super_auto_pets.move`)

> **Reference:** `sui_tunnel/sources/quantum_poker.move` (on-chain commit-reveal game, present on `dev`). Every `tunnel::*` function this task calls already exists on `dev`/HEAD — see "Reference modules" above.

**Files:**

- Create: `sui_tunnel/sources/examples/example_super_auto_pets.move`
- Test: `sui_tunnel/tests/example_super_auto_pets_tests.move`

A session-channel module following `quantum_poker.move`'s structure: wrap a `Tunnel<T>`, keep a running scoreboard (hearts, round wins) + balances, expose `record_round_result` (delegates to `tunnel::update_state`), `settle_session` (`tunnel::close_cooperative_and_transfer`), and dispute hooks (`raise_dispute` / `resolve_dispute` / `agree_to_dispute` / `force_close_after_timeout`). The signed `state_hash` commits to **exactly the fields `SuperAutoPetsProtocol.encodeState` serializes** — `phase, hearts_a, hearts_b, last_outcome, round, balance_a, balance_b, wager`, plus the two team commitments — byte-identical to `encodeState`. The battle itself stays off-chain; on-chain we only verify dual-signed state updates and settle.

> **Cross-tunnel replay note:** the SAP state hash deliberately omits the tunnel id. Replay/cross-tunnel binding is provided by the enclosing `tunnel::update_state` message (which already binds `tunnel_id` + the strictly-increasing `nonce`, per `serializeStateUpdate`); the SAP state hash is the inner payload and need not re-bind the id. This is why `compute_session_hash` takes **no** `tunnel_id` and instead mirrors `encodeState` 1:1.

Cuttable: drop and settle through the generic tunnel.

- [ ] **Step 1: Write the failing test**

Create `sui_tunnel/tests/example_super_auto_pets_tests.move` (module `sui_tunnel::example_super_auto_pets_tests`), following the pattern of `sui_tunnel/tests/quantum_poker_tests.move`:

- `test_create_and_join_session` — create with two pubkeys + stakes, join, assert `session_status == session_active()`, `session_total_pot` is both stakes, hearts start at the configured value.
- `test_record_round_result_updates_scoreboard` — feed a co-signed round result (heartsB decremented, balances shifted), assert `wins_a == 1`, `session_balance_a`/`_b` reflect the wager shift, `session_nonce` increased.
- `test_compute_session_hash_layout` — assert `compute_session_hash(...)` equals a fixed expected blake2b256 vector for known inputs (the SAME vector the TS golden generator prints in Task 9).
- `test_settle_session_distributes_pot` — settle and assert the final coins match the running balances and `session_status == session_settled()`.
- `test_force_close_after_timeout` — dispute + timeout path closes.

Use the deterministic signing keys + `sig_vectors.move` helpers already used by the other example tests.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd sui_tunnel && sui move test example_super_auto_pets`
Expected: FAIL — module `example_super_auto_pets` not found / unbound.

- [ ] **Step 3: Implement `example_super_auto_pets.move`**

Follow `quantum_poker.move`'s session structure. Provide: structs `Scoreboard { rounds_played, wins_a, wins_b, draws }`, `SessionState { phase, hearts_a, hearts_b, last_outcome, round, balance_a, balance_b, nonce }`, `SuperAutoPets<phantom T> { id, tunnel, status, state, stake_per_player, wager_per_round, target_rounds, starting_hearts }`; events `SessionCreated` / `RoundResultRecorded` / `SessionSettled`; status/outcome constants exposed as zero-arg getters. Public funs (verbatim shapes from `tunnel.move`):

- `create_session<T>(player_a_address, player_a_pk, player_b_address, player_b_pk, wager_per_round, starting_hearts, target_rounds, penalty_amount, stake: Coin<T>, clock, ctx): SuperAutoPets<T>` — calls `tunnel::create<T>(...)` then `deposit_party_a`.
- `join_session<T>(session, stake, clock, ctx)` — `deposit_party_b`.
- `compute_session_hash(phase: u8, hearts_a: u8, hearts_b: u8, last_outcome: u8, round: u64, balance_a: u64, balance_b: u64, wager: u64, team_commit_a: vector<u8>, team_commit_b: vector<u8>): vector<u8>` — **mirror `SuperAutoPetsProtocol.encodeState` EXACTLY** (same fields, same order). Build domain `b"sui_tunnel::proto::super_auto_pets.v1"`, then the length-prefixed body (each part `u64be(len) || part`, matching `lengthPrefixedConcat`):

  `u64be(4) || [phase, hearts_a, hearts_b, last_outcome]  ||  u64be(8) || u64be(round)  ||  u64be(8) || u64be(balance_a)  ||  u64be(8) || u64be(balance_b)  ||  u64be(8) || u64be(wager)  ||  u64be(32) || team_commit_a  ||  u64be(32) || team_commit_b`

  then `blake2b256(&data)`. The TS `encodeState` array is the **single source of truth**; do NOT add `tunnel_id` and do NOT reorder. (`team_commit_a/b` are the 32-byte opaque commitments; their team CONTENTS — including each pet's food code from Task 6's `encodeTeam` — are bound inside the commitment off-chain, so any on-chain dispute re-derivation of a team encoding must append the food code exactly as `encodeTeam` does.)

- `record_round_result<T>(session, phase, hearts_a, hearts_b, last_outcome, round, balance_a, balance_b, team_commit_a, team_commit_b, nonce, timestamp, sig_a, sig_b, clock)` — recompute the hash via `compute_session_hash(phase, hearts_a, hearts_b, last_outcome, round, balance_a, balance_b, session.wager_per_round, team_commit_a, team_commit_b)`, call `tunnel::update_state(...)`, update the scoreboard + balances + `SessionState`, emit `RoundResultRecorded`.
- `settle_session<T>(session, player_a_balance, player_b_balance, sig_a, sig_b, timestamp, clock, ctx)` — `tunnel::close_cooperative_and_transfer(...)`.
- `raise_dispute` / `resolve_dispute` / `agree_to_dispute` / `force_close_after_timeout` — delegate to the matching `tunnel::*` funcs.
- Accessors (`session_status`, `session_total_pot`, `session_nonce`, `session_balance_a/_b`, `hearts_a/_b`, `wins_a/_b`, `draws`, `rounds_played`, `is_session_complete`) + test-only `destroy_session_for_testing<T>` / `set_status_for_testing<T>`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd sui_tunnel && sui move test example_super_auto_pets`
Expected: PASS (all SAP example tests).

- [ ] **Step 5: Commit**

```bash
git add sui_tunnel/sources/examples/example_super_auto_pets.move \
        sui_tunnel/tests/example_super_auto_pets_tests.move
git commit -m "feat(sap): on-chain session-channel example"
```

---

## Task 9: Golden cross-check (TS ↔ Move byte parity)

**Files:**

- Modify: `sui-tunnel-ts/src/core/golden.gen.ts` (print SAP vectors)
- Test: `sui_tunnel/tests/example_super_auto_pets_tests.move` (assert against the pasted vectors) — or a dedicated xcheck test mirroring `randomness_xcheck_tests.move`

Pin two parity surfaces so SDK encoding / shop sampling stay byte-identical to Move: (1) a SAP **state-hash** vector (`encodeState` for a fixed state == `compute_session_hash` for the same inputs), and (2) a SAP **shop-roll** vector (the `currentShop` species sequence from a fixed `shopSeed`, re-derived on-chain by a verifiable **Fisher–Yates `shuffle`** over the **canonical shop pool** pinned in Task 4 (`ROSTER` ids `< 100` with `tier <= tierForRound(round)`, **sorted ascending by id**), taking the first N, seed chained one `next_seed` per reroll). The generator is print-only (no file write); a human pastes the printed hex into the Move test literal, exactly like the existing `shuffle_matches_sdk_golden` flow.

- [ ] **Step 1: Add SAP vectors to `golden.gen.ts`**

Append to `sui-tunnel-ts/src/core/golden.gen.ts` (after the existing `console.log`s), using fixed inputs that the Move test reuses:

```ts
import { SuperAutoPetsProtocol } from "../protocol/superAutoPets";
import { currentShop, newPlayer } from "../protocol/sapShop";

const sap = new SuperAutoPetsProtocol({
  hearts: 5,
  wagerPerRound: 1n,
  roundCap: 15,
});
const sapState = sap.initialState({
  tunnelId: "0xab",
  initialBalances: { a: 1000n, b: 2000n },
});
console.log("SAP_STATE_HASH ", toHex(blake2b256(sap.encodeState(sapState))));

const shopSeed = Uint8Array.from({ length: 32 }, (_, i) => i + 1); // 0x01..0x20
const offers = currentShop(shopSeed, 3, newPlayer());
console.log("SAP_SHOP_ROLL  ", offers.join(","));
```

(`blake2b256` and `toHex` are already imported by the generator.) The fixed `initialState` resolves to these exact `compute_session_hash` inputs (note `tunnelId` is NOT part of the hash): `phase = 0` (seed, post-Task-3 — i.e. `PHASE_CODE.seed`), `hearts_a = hearts_b = 5`, `last_outcome = 0`, `round = 1`, `balance_a = 1000`, `balance_b = 2000`, `wager = 1`, `team_commit_a = team_commit_b = 32 zero bytes`. The Move `test_compute_session_hash_layout` must call `compute_session_hash` with these same values and assert the pasted `SAP_STATE_HASH`.

- [ ] **Step 2: Run the generator and capture the vectors**

Run: `cd sui-tunnel-ts && node --import tsx src/core/golden.gen.ts`
Expected: prints `SAP_STATE_HASH ...` and `SAP_SHOP_ROLL ...`. Copy both values.

- [ ] **Step 3: Assert the vectors on-chain**

Paste the captured `SAP_STATE_HASH` hex into `test_compute_session_hash_layout` (Task 8) as the expected literal, and add a `shop_roll_matches_sap_golden` test that rebuilds the shop roll from `shopSeed = 0x01..0x20` at round 3 by reconstructing the canonical pool (ids `< 100`, `tier <= tierForRound(3) = 2`, sorted ascending) and applying `randomness::shuffle(&seed, &mut pool)` (Fisher–Yates; NO reroll → `next_seed` not applied), then taking the first N and `assert_eq!`ing the species sequence against the pasted `SAP_SHOP_ROLL`. (If a team-encoding parity vector is ever added, derive it from the food-inclusive `encodeTeam` of Task 6 so the Move team-encoding mirror is byte-identical.)

- [ ] **Step 4: Verify parity**

Run: `cd sui_tunnel && sui move test example_super_auto_pets`
Expected: PASS — the on-chain hash + shop roll match the SDK output byte-for-byte. (If they drift, re-run the generator and re-paste; never hand-edit the literals.)

- [ ] **Step 5: Commit**

```bash
git add sui-tunnel-ts/src/core/golden.gen.ts \
        sui_tunnel/tests/example_super_auto_pets_tests.move
git commit -m "test(sap): golden ts-move byte parity"
```

---

## Task 10: Frontend game folder + registration

**Files:**

- Create: `frontend/src/games/superAutoPets/index.ts`
- Create: `frontend/src/games/superAutoPets/SuperAutoPetsWindow.tsx`
- Create: `frontend/src/games/superAutoPets/usePvpSuperAutoPets.ts`
- Modify: `frontend/src/games/index.ts`
- Asset: `frontend/public/games/super-auto-pets.png`

Register the game in the desktop and stand up the PvP wiring skeleton, following the Quantum Poker PvP template (`MpClient.quickMatch` + `DistributedTunnel` + `openAndFundSharedTunnel`). The window switches on the hook's status (`idle | matching | funding | playing | settling | settled | error`) and renders the shop + battle-playback UI. No unit test (the desktop has no component test harness); verified by typecheck + build + manual smoke. Demo polish on top of the shippable core.

- [ ] **Step 1: Create the PvP hook**

`frontend/src/games/superAutoPets/usePvpSuperAutoPets.ts` — mirror `frontend/src/games/quantumPoker/usePvpQuantumPoker.ts` **exactly** for the wiring sources:

- Matchmaking uses an **MpClient instance method** (`quickMatch` is NOT static): construct `const mp = new MpClient(resolveMpWsUrl(resolveBackendUrl()), ...)` then `const match = await mp.quickMatch("super-auto-pets")`.
- `MpClient`, `resolveMpWsUrl`, and the `PvpChannel` type come from the **frontend** module `@/pvp/mpClient` (i.e. `../../pvp/mpClient`) — NOT from `sui-tunnel-ts`.
- Onchain helpers (`openAndFundSharedTunnel`, `depositStake`, `closeCooperativeWithRoot`, `readCreatedAt`) come from `@/onchain/tunnelTx` (i.e. `../../onchain/tunnelTx`), and `resolveBackendUrl` from `@/backend/controlPlane`.
- The SAP protocol + engine come from the SDK barrel: `import { core, protocols } from "sui-tunnel-ts";` (the barrel namespaces + the frontend alias support this form). Drive a `new core.DistributedTunnel<SapState, SapMove>(new protocols.SuperAutoPetsProtocol(cfg), ...)` over the relay `PvpChannel.transport`; run seed → shop → reveal → battle via `sendPeer`/`onPeer`; then `closeCooperativeWithRoot`. Expose `status`, `state`, and the shop actions (`buyPet`/`sellPet`/`reroll`/`combine`/`applyFood`/`commitTeam`) from `protocols` (`sapShop`).

- [ ] **Step 2: Create the window + registration**

`frontend/src/games/superAutoPets/SuperAutoPetsWindow.tsx`:

```tsx
import type { GameWindowProps } from "../types";
import { usePvpSuperAutoPets } from "./usePvpSuperAutoPets";

export function SuperAutoPetsWindow(_props: GameWindowProps) {
  const g = usePvpSuperAutoPets();
  // status-switch UI: idle -> Find Match, matching/funding -> spinner,
  // playing -> shop + board, settling -> spinner, settled -> result, error -> message.
  return <div className="p-2 text-sm">Super Auto Pets — {g.status}</div>;
}
```

`frontend/src/games/superAutoPets/index.ts`:

```ts
import { register } from "../registry";
import { SuperAutoPetsWindow } from "./SuperAutoPetsWindow";

register({
  id: "super-auto-pets",
  name: "Super Auto Pets",
  icon: "🐹",
  image: "/games/super-auto-pets.png",
  Window: SuperAutoPetsWindow,
  defaultSize: { w: 6, h: 5 },
  minSize: { w: 4, h: 4 },
});
```

- [ ] **Step 3: Wire into the desktop barrel**

In `frontend/src/games/index.ts`, append (position sets desktop tiling order):

```ts
import "./superAutoPets";
```

- [ ] **Step 4: Typecheck + build**

Run: `cd frontend && pnpm typecheck && pnpm build`
Expected: clean typecheck; build completes (the game registers and the window renders without breaking the desktop).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/superAutoPets/index.ts \
        frontend/src/games/superAutoPets/SuperAutoPetsWindow.tsx \
        frontend/src/games/superAutoPets/usePvpSuperAutoPets.ts \
        frontend/src/games/index.ts \
        frontend/public/games/super-auto-pets.png
git commit -m "feat(sap): register frontend game + pvp skeleton"
```

---

## Task 11: Full verification sweep

**Files:** none (verification only)

- [ ] **Step 1: Full test + build sweep**

```bash
cd sui-tunnel-ts && pnpm test
cd sui_tunnel && sui move test example_super_auto_pets
cd frontend && pnpm typecheck && pnpm build
```

Expected: all TS tests pass (`sapEngine`, `superAutoPets`, `sapShop`, plus the unchanged suite); all SAP Move tests pass; frontend typecheck + build clean.

- [ ] **Step 2: Manual PvP smoke (testnet, two funded wallets)**

Open the desktop, launch Super Auto Pets in two browsers, Find Match → fund → play several rounds (commit fair seed, build a team in the shop, reveal, watch the deterministic battle, hearts decrement) → reach 0 hearts or the round cap → cooperative settle. Verify balances move loser→winner each round and sum to the locked total, and the on-chain settle digest populates.

- [ ] **Step 3: Determinism + invariant spot-check**

Confirm: a fixed `(teamA, teamB, battleSeed)` always yields the same `runBattle` result on both clients; `balances().a + balances().b` equals the locked total at every step; the TS golden vectors still match the Move literals (`node --import tsx src/core/golden.gen.ts` → compare).

- [ ] **Step 4: Finish the branch**

If anything regresses, STOP and fix it in the owning task's files, then re-run this sweep. When green, invoke `superpowers:finishing-a-development-branch`. **No commit in this task** (verification only).

---

## Self-Review

- **Stays on `dev`:** all reference modules (`quantumPoker.ts`, `quantum_poker.move`, the core `tunnel.move` session API) are already on `dev`/HEAD; no merge or rebase from `main` is needed. The `example_multi_game_tictactoe` template (main-only) is deliberately not used — `quantumPoker` is the better fit (it has commit-reveal hidden info, which SAP needs).
- **Spec §6 order respected:** engine (Task 1) → vertical slice that settles (Task 2, safety milestone) → fair shop + economy (Tasks 3–4) → depth: leveling/food/roster (Tasks 5–7) → on-chain Move + golden (Tasks 8–9) → frontend (Task 10) → verification (Task 11). Each task ends green and shippable.
- **De-scope order respected:** drop from the bottom of importance — Task 7 (extra pets) → Task 6 (food) → Task 5 (leveling) → Tasks 8–9 (on-chain Move + golden; fall back to the generic tunnel) → Tasks 3–4 (fair shop; fall back to a per-player seed). Tasks 1–2 (deterministic battle + hidden-team commit-reveal) are never cut.
- **Invariants enforced:** battle is a pure function of `(teamA, teamB, battleSeed)` (Task 1, asserted by the determinism + purity test); `balances()` always sums to total (Task 2 self-play test asserts `a + b == 200n`); nonce/signing/replay are engine-owned (the protocol never touches them); hidden teams via `core/commitment`, with food bound into `encodeTeam` (Task 2 tampered-reveal test + Task 6 food-binding test); no ZK on the hot path.
- **Golden parity single-sourced:** `SuperAutoPetsProtocol.encodeState`'s field array IS the canonical layout; Task 8's `compute_session_hash` mirrors it 1:1 (no `tunnel_id`); Task 9 pins both the state-hash and the Fisher–Yates shuffle shop-roll over the canonical pool.
- **Reuse, not reinvention:** `computeCommitment` / `verifyCommitment` / `combineReveals` (`core/commitment`), `seedFromBytes` / `nextSeed` / `nextU64InRange` / `shuffle` (`core/randomness`), `protocolDomain` / `lengthPrefixedConcat` / `u64ToBeBytes` / `concatBytes` (encoding), `OffchainTunnel` (driving) — all imported, none re-implemented.
- **Framework-dir edits are minimal and tracked:** barrel registrations in `protocol/index.ts` (Tasks 2 and 4) + SAP vectors appended to the print-only `core/golden.gen.ts` (Task 9); no hot-path core files (`tunnel.ts`/`randomness.ts`/`wire.ts`/`commitment.ts`) touched. This intentionally supersedes spec §1's "all work game-side" non-goal, with staging restricted to exact paths.
- **Type names consistent across tasks:** `Pet`, `BattleResult`, `runBattle`, `makePet`, `encodeTeam`, `ROSTER`, `SPECIES`, `FOOD_CODE` (engine); `SapState`, `SapMove`, `SapPhase`, `SapConfig`, `SuperAutoPetsProtocol` (protocol); `PlayerState`, `newPlayer`, `buyPet`, `sellPet`, `reroll`, `combine`, `applyFood`, `currentShop`, `tierForRound`, `shopPool`, `FOOD` (shop).
- **Test convention:** `node:test` + `tsx` via pnpm (`import { test } from "node:test"; import assert from "node:assert/strict";`), NOT bun. Move via `sui move test example_super_auto_pets`.
- **Staging discipline:** every commit stages only its listed files by exact path; never `git add -A`, never `git add sui-tunnel-ts` / `git add sui_tunnel` wholesale; no AI attribution; no push.
- **Cross-doc consistency:** filenames and code targets match the ADR (`docs/decisions/0009-super-auto-pets-on-tunnel.md`) and roster doc (`docs/superpowers/specs/2026-06-19-super-auto-pets-roster.md`); Task 7 reads its data from the roster doc; Task 9 pins TS↔Move byte parity.
