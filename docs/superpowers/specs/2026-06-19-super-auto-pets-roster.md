# Super Auto Pets — Roster, Ability & Economy Reference

**Date:** 2026-06-19
**Status:** Draft (data reference); pairs with the design spec and implementation plan
**Scope:** The canonical *data* the SAP battle engine reads — economy constants, leveling rule,
tier-unlock schedule, the pet roster (tiers 1–3, ~30 pets), food items, and the
random→seed-deterministic mapping for every ability. No logic lives here; this is the table a
developer transcribes into `sui-tunnel-ts/src/protocol/sapEngine.ts`.

**Cross-references**
- Design: `docs/superpowers/specs/2026-06-19-super-auto-pets-design.md` (source of truth — read first)
- Plan: `docs/superpowers/plans/2026-06-19-super-auto-pets.md` (task-by-task build order)
- ADR: `docs/decisions/0009-super-auto-pets-on-tunnel.md` (determinism + commit-reveal rationale;
  also ratifies the trigger framework and the fixed event list)
- Engine consumer: `sui-tunnel-ts/src/protocol/sapEngine.ts` (+ `sapEngine.test.ts`)
- Protocol consumer: `sui-tunnel-ts/src/protocol/superAutoPets.ts`
- Seed primitives (reused, not reinvented): `sui-tunnel-ts/src/core/randomness.ts`,
  `sui-tunnel-ts/src/core/commitment.ts` (both byte-identical to `randomness.move`)

---

## 1. Purpose

The design spec (§2) fixes one hard constraint: a battle is a **pure deterministic function of
`(teamA, teamB, battleSeed)`**. To honor that, abilities cannot be free-form code — they are
*triggered effects* on a **fixed event set**, and any "random" choice (random target, random
summon, shop roll) is resolved by drawing from a seed. This document is the catalog of those
pets, foods, and effects, written so that:

1. each row maps to exactly one entry in the engine's roster table;
2. every ability is keyed to one event in the fixed set (§5);
3. every effect that *would* be random in classic SAP has an explicit, seed-driven adaptation
   (§9), so the same matchup always resolves identically and an on-chain referee can re-derive it
   in a dispute.

The first shippable engine slice (design §6, Day 1–2) reads only the `onStartOfBattle` / `onFaint`
subset of this roster — see the milestone note in §6 for exactly which pets stock it.

Where this doc and external SAP wikis disagree, **the design spec wins** (e.g. leveling
thresholds, flat sell refund). Numbers chosen here are the v1 values; the de-scope order in
design §6 governs what may be cut under deadline.

---

## 2. Economy

All gold is per-round and **does not carry over** (unspent gold is lost at end of shop phase).
Only **buying** and **rolling** cost gold; **selling, freezing, combining, and reordering are
free**.

### 2.1 Run / round constants

| Constant | Value | Source |
| --- | --- | --- |
| `HEARTS` (lives per player) | 5 | design §1 |
| Heart loss per battle loss | −1 (loser only; draw = no loss) | design §1 |
| `ROUND_CAP` (auto-end) | 15 → most hearts wins, tie = split | design §1 |
| `GOLD` per round | 10 (refreshed each round; not carried) | design §1 |
| Buy a pet (shop → team) | 3 gold | design §1 |
| Buy / apply a food item | 3 gold (Pill = 1 gold, see §8) | research |
| Roll / reroll the shop | 1 gold | design §1 |
| Sell a pet (refund) | **+1 gold flat** (v1) | design §1 |
| Team size (max pets on board) | 5 | design §1 |
| Freeze a shop slot (pet or food) | 0 gold (free) | research |
| Combine two same-species copies | 0 gold | research |
| Reorder / place a pet | 0 gold | research |

> **Sell refund note.** Classic SAP refunds `+1 × level` (L1=1, L2=2, L3=3). The design spec
> §1 fixes a **flat +1 gold** for v1; the level-scaled variant is a one-line change and is the
> first thing to restore if balance testing wants it. The engine should read the refund from a
> single constant so the swap is trivial.

### 2.2 Shop slot growth by turn

The shop offers a growing number of **pet (animal) slots** and **food slots**. Rolling reshuffles
all *unfrozen* slots from the currently unlocked tier pool (§4); a frozen slot is excluded from
the reshuffle and persists into the next turn.

| Turn(s) | Pet slots | Food slots |
| --- | --- | --- |
| 1–2 | 3 | 1 |
| 3–4 | 3 | 2 |
| 5–8 | 4 | 2 |
| 9–10 | 5 | 2 |
| 11+ | 5 | 2 |

---

## 3. Leveling

Leveling follows canonical SAP XP, which is also what design §1 fixes ("level 2 at 3 copies,
level 3 at 6"). Combining is dragging one pet onto another of the **same species**.

| Rule | Value |
| --- | --- |
| XP model | the base pet is the 1st copy (0 XP); **each additional same-species copy merged in = +1 XP** |
| Reach **Level 2** | 2 XP → **3 copies total** (base + 2) |
| Reach **Level 3** | 5 XP cumulative → **6 copies total** (i.e. two Level-2 pets combined) |
| Stat gain on each merge | merged pet keeps the **higher** of each stat, then **+1 attack / +1 health** |
| Effect of a level-up | fires `onLevelUp` (stronger/scaled ability — see per-pet "L2/L3" notes) and grants one **free shop pet from the next tier** that turn (the free pet is seed-pinned via the **shop** seed — see §9.2) |
| Sell value | **+1 gold flat** (v1, see §2.1) |

Ability scaling convention used in the roster table: the **Atk/HP** column and the effect text
are the **Level-1** values; inline `(L2 …, L3 …)` shows how the *ability* scales (typically the
buff size, target count, or summon stats grow). Base stats also rise +1/+1 per merge as above.

---

## 4. Tier-unlock schedule (by turn)

Each unlocked tier *adds* to the draw pool; lower-tier pets keep appearing. v1 ships the
**tier 1–3 roster** below (so the effective pool caps at tier 3 until tiers 4–6 are added — see
the de-scope order in design §6).

| Turn | Highest tier in shop |
| --- | --- |
| 1–2 | Tier 1 |
| 3–4 | Tier 2 |
| 5–6 | Tier 3 |
| 7–8 | Tier 4 *(roster TBD — additive)* |
| 9–10 | Tier 5 *(roster TBD — additive)* |
| 11+ | Tier 6 *(roster TBD — additive)* |

---

## 5. Fixed trigger event set

Every ability declares **exactly one** of these events (design §2, **as amended to include
`onFriendSummoned`** and ratified by ADR 0009 — see the source-of-truth note below). The engine
fires triggers in a deterministic order: **left → right within each team**, the two teams
**interleaved by board index** (`A[0], B[0], A[1], B[1], …`), with any true simultaneity tie
broken by the battle seed (§9.2). A pet's effect function is pure and may read the battle seed; it
never consults wall-clock time or unseeded RNG.

| Event | Phase | Fires when… |
| --- | --- | --- |
| `onBuy` | shop | the pet is bought from the shop, **or** a food item is applied to it |
| `onSell` | shop | the pet is sold |
| `onLevelUp` | shop | the pet reaches a new level via combine |
| `onStartOfBattle` | battle | once, after reveal, before the first attack (left→right, both teams) |
| `onFaint` | battle | the pet drops to 0 health and is removed from the board |
| `onHurt` | battle | the pet takes damage **and survives** |
| `onBeforeAttack` | battle | an attack step begins; observed by the attacking front pet and by allies that key off it (e.g. the friend directly behind) |
| `onFriendFaint` | battle | a **friendly** pet faints (effect predicate may scope to "the friend directly ahead/behind") |
| `onFriendSummoned` | battle/shop | a **friendly** pet enters the board after start (a summon, or a combine that produces a new instance) |

> **Source of truth for the event set.** `onFriendSummoned` was added to design §2's fixed event
> set — taking it from eight to nine events — because Horse, Dog, and Rabbit depend on it; ADR 0009
> ratifies the trigger framework and this nine-event list. The **amended design spec is the
> canonical list**, *not* this roster; the `SapEvent` enum in §10 merely mirrors it. If the spec
> and this table ever diverge, the spec wins (per §1).

---

## 6. Pet roster (tiers 1–3)

Columns: **Name | Tier | Atk/HP (L1) | Trigger event | Deterministic effect (L1, with L2/L3
scaling inline)**. `(seed)` marks an effect whose target/summon is chosen via the battle seed —
see §9 for the exact rule. Stat notation is `attack/health`.

| Name | Tier | Atk/HP | Trigger | Deterministic effect |
| --- | --- | --- | --- | --- |
| Ant | 1 | 2/1 | `onFaint` | Give a `(seed)`-chosen friend +2/+1. *(L2 +4/+2, L3 +6/+3)* |
| Cricket | 1 | 1/2 | `onFaint` | Summon a **Zombie Cricket** token in its slot at 1/1. *(L2 2/2, L3 3/3)* |
| Fish | 1 | 2/3 | `onLevelUp` | On reaching L2, give all friends +1/+1. *(L3 +2/+2)* |
| Horse | 1 | 2/1 | `onFriendSummoned` | Give the just-summoned friend +1 attack until end of battle. *(L2 +2, L3 +3)* |
| Mosquito | 1 | 2/2 | `onStartOfBattle` | Deal 1 damage to a `(seed)`-chosen enemy. *(L2 2 enemies, L3 3 enemies)* |
| Beaver | 1 | 2/2 | `onSell` | Give 2 `(seed)`-chosen friends +1 health each. *(L2 +2, L3 +3)* |
| Duck | 1 | 1/3 | `onSell` | Give all current shop pets +1 health. *(L2 +2, L3 +3)* |
| Pig | 1 | 3/1 | `onSell` | Gain +1 gold this turn. *(L2 +2, L3 +3)* |
| Otter | 1 | 1/2 | `onBuy` | Give a `(seed)`-chosen friend +1/+1. *(L2 +2/+2, L3 +3/+3)* |
| Crab | 2 | 3/1 | `onStartOfBattle` | Set Crab's health to a multiple of the **highest-health friend's** current health (excluding Crab), taking the higher of that and Crab's own health so it never lowers. *(L1 ×1.0, L2 ×1.5, L3 ×2.0, floored)* |
| Swan | 2 | 1/2 | `onStartOfBattle` | Gain +1 gold (resolved into the next shop; see §9.3 gold-timing note). *(L2 +2, L3 +3)* |
| Rat | 2 | 4/5 | `onFaint` | Summon N 1/1 **Dirty Rat** tokens on the **enemy** front (see §9.2 spawn rule). *(N Dirty Rats: L1 1, L2 2, L3 3)* |
| Hedgehog | 2 | 3/2 | `onFaint` | Deal 2 damage to **all** pets, both teams. *(L2 4, L3 6)* |
| Peacock | 2 | 2/5 | `onHurt` | Gain +4 attack (first time hurt only). *(L2 +8, L3 +12)* |
| Flamingo | 2 | 3/1 | `onFaint` | Give the 2 friends directly behind it +1/+1. *(L2 +2/+2, L3 +3/+3)* |
| Kangaroo | 2 | 1/2 | `onBeforeAttack` | When the friend **directly ahead** attacks (predicate on the same `onBeforeAttack` step), gain +2/+2. *(L2 +4/+4, L3 +6/+6)* |
| Spider | 2 | 2/2 | `onFaint` | Summon the `(seed)`-chosen tier-3 pet at base stats **overridden to 2/2**, keeping its **innate trigger** (a real pet, not a vanilla token). *(stat override: L1 2/2, L2 3/3, L3 4/4)* |
| Dodo | 2 | 4/2 | `onStartOfBattle` | Give the friend directly ahead +50% of Dodo's own attack (floor). *(L2 100%, L3 150%)* |
| Elephant | 2 | 3/5 | `onBeforeAttack` | Before **Elephant** attacks, deal 1 damage to the friend directly behind it. *(L2 2 friends behind, L3 3)* |
| Bluebird | 2 | 2/1 | `onStartOfBattle` | Give a `(seed)`-chosen friend +1 attack. *(L2 +2, L3 +3)* |
| Badger | 3 | 5/4 | `onFaint` | Deal damage equal to its attack to the pets directly **ahead and behind** it. |
| Blowfish | 3 | 3/5 | `onHurt` | Deal 2 damage to a `(seed)`-chosen enemy. *(L2 4, L3 6)* |
| Camel | 3 | 2/5 | `onHurt` | Give the friend directly behind it +1/+2. *(L2 +2/+4, L3 +3/+6)* |
| Dog | 3 | 2/3 | `onFriendSummoned` | Gain +1/+1. *(L2 +2/+2, L3 +3/+3)* |
| Sheep | 3 | 2/2 | `onFaint` | Summon two 2/2 **Ram** tokens. *(L2 4/4, L3 6/6)* |
| Ox | 3 | 1/4 | `onFriendFaint` | When the friend **directly ahead** faints, gain +2 attack and Melon armor (20-shield, blocks one hit). *(L2 +4, L3 +6)* |
| Rabbit | 3 | 3/2 | `onFriendSummoned` | Give the just-summoned friend +1 health. *(L2 +2, L3 +3)* |
| Snail | 3 | 2/2 | `onBuy` | If you **lost** the last battle, give all friends +2/+1. *(L2 +4/+2, L3 +6/+3)* |
| Turtle | 3 | 1/2 | `onFaint` | Give the friend directly behind it Melon armor (20-shield, blocks one hit). *(L2 2 friends, L3 3)* |

> **Multi-pet shared events are intentional.** e.g. Horse / Rabbit / Dog all key `onFriendSummoned`
> but with disjoint effects; Kangaroo / Elephant both key `onBeforeAttack` with different
> predicates (friend-ahead-attacks vs self-attacks). The engine fires each listener in left→right
> order.

> **Day 1–2 milestone subset (design §6).** The Day 1–2 engine slice ships only
> `onStartOfBattle` + `onFaint` and "~6 tier-1 pets". Three tier-1 pets key those events directly —
> **Ant** (`onFaint`), **Cricket** (`onFaint`), **Mosquito** (`onStartOfBattle`). To reach ≥6 pets
> exercising only those two triggers *before* the shop/economy layer exists, the slice also pulls
> forward the `onFaint` / `onStartOfBattle` **tier-2** pets **Hedgehog**, **Flamingo**, **Rat**, and
> **Crab** (none of which need the shop). Spider is excluded from this subset because its summon
> needs a seed draw (§9.2). Cross-referenced from §1 and design §6.

### 6.1 Summoned tokens (not buyable)

These have no shop presence; they exist only as summon targets and need stats in the engine
table. `null` trigger = vanilla. The word **token** is reserved for these vanilla entities — a
Spider-summoned tier-3 pet (§6) is *not* a token: it keeps its innate trigger.

| Token | Atk/HP (L1) | Trigger | Summoned by |
| --- | --- | --- | --- |
| Zombie Cricket | 1/1 | none | Cricket `onFaint` (scales with Cricket's level) |
| Dirty Rat | 1/1 | none | Rat `onFaint` (spawns on the **enemy** side) |
| Ram | 2/2 | none | Sheep `onFaint` (scales with Sheep's level) |
| Bee | 1/1 | none | Honey food `onFaint` |

---

## 7. Held items / status applied during battle

Several foods do not buff stats once and vanish — they **attach a held-item trigger** to the
equipped pet, which then reacts during battle. The engine models a held item as an optional
second trigger on a pet instance (resolved before the pet's innate trigger on the same event):

- **Honey** → adds an `onFaint` listener (summon a 1/1 Bee).
- **Mushroom** → adds an `onFaint` listener (resummon self once as 1/1).
- **Meat Bone** → adds an `onBeforeAttack` listener (+3 attack damage on each attack).
- **Garlic** / **Melon** → add an `onHurt` listener (damage reduction / one-hit shield).

Melon armor (also granted by Ox / Turtle) is a one-shot 20-point shield consumed by the next hit.

---

## 8. Food items

Columns: **Food | Cost | Trigger | Deterministic effect**. Most foods are consumed in the shop
(`onBuy` = applied to a target); held items (§7) attach a battle trigger to the equipped pet.

| Food | Cost | Trigger | Deterministic effect |
| --- | --- | --- | --- |
| Apple | 3 | `onBuy` | Target pet gains +1/+1 (permanent). |
| Pear | 3 | `onBuy` | Target pet gains +2/+2 (permanent). |
| Cupcake | 3 | `onBuy` | Target pet gains +3/+3 **until end of next battle only** (temporary). |
| Salad Bowl | 3 | `onBuy` | Give 2 `(seed)`-chosen friends +1/+1 each. |
| Chocolate | 3 | `onBuy` | Give target pet +1 experience (advances leveling per §3). |
| Canned Food | 3 | `onBuy` | Permanently give **all current and future shop pets** +1/+1. |
| Pill (Sleeping Pill) | 1 | `onBuy` | Faints the target friendly pet immediately (used to trigger `onFaint`). |
| Honey | 3 | `onFaint` | Equipped pet, on faint, summons a 1/1 Bee in its slot. |
| Mushroom | 3 | `onFaint` | Equipped pet, on faint, resummons itself once as a 1/1. |
| Meat Bone | 3 | `onBeforeAttack` | Equipped pet deals +3 attack damage on every attack. |
| Garlic | 3 | `onHurt` | Incoming damage to the equipped pet is reduced by 2 (minimum 1). |
| Melon | 3 | `onHurt` | One-shot shield: absorbs the next hit up to 20 damage, then is consumed. |

---

## 9. Determinism notes

This is the contract the engine must satisfy:

> Given `(teamA, teamB, battleSeed)`, the entire battle — including every "random" target, summon,
> and tie-break — resolves to one fixed outcome. Shop contents are reproducible from
> `(playerState, shopSeed, turn)`. No effect consults wall-clock time or unseeded randomness.

### 9.1 Seed pipeline (reuse, do not reinvent)

Both the battle seed and the shop seed are derived through the existing commit-reveal +
verifiable-shuffle primitives, so an off-chain result can be re-derived on-chain in a dispute:

1. Each party commits a random share with `computeCommitment(share, salt)`
   (`core/commitment.ts`; salt ≥ `MIN_SALT_LEN` = 16 bytes), then reveals.
2. The joint seed = `combineReveals(shareA, saltA, shareB, saltB)` — a 32-byte value neither
   party can bias.
3. Wrap it with `seedFromBytes(...)` to get a chainable `Seed`.
4. Per-effect draws use the byte-exact helpers from `core/randomness.ts`:
   - `nextU64InRange(seed, min, max)` — unbiased index into an eligible list (rejection sampling, no modulo bias). **Throws `"invalid randomness range"` when `min >= max`.**
   - `shuffle(seed, arr)` — Fisher–Yates ordering of a candidate list (e.g. enemy targets); returns the seed unchanged (zero draws) when `arr.length <= 1`.
   - `drawFromVector(seed, arr)` — swap-remove draw for "pick N distinct"; **throws `"empty vector"`** when `arr` is empty.

The **battle seed** and the **shop seed** are separate derivations (different draws of the same
commit-reveal flow) so a reroll never perturbs the battle and vice-versa.

### 9.2 Random-ability adaptations

Each classically-random effect is pinned to a fixed, reproducible rule.

**Degenerate eligible lists — pin seed consumption (invariant #1).** Before any draw, the TS
engine and the Move referee MUST consume an *identical* number of seed draws, so the rule for
short lists is fixed:

> - **Empty list** → the effect is a **no-op that consumes ZERO seed draws**. Do **not** call
>   `nextU64InRange(seed, 0, 0)` / `drawFromVector(seed, [])`; both throw on an empty range.
> - **`len >= 1`** → **always** draw `nextU64InRange(seed, 0, len)`. This consumes **exactly one**
>   draw even when `len == 1` (the helper still advances the seed counter for a range of 1 — it
>   does **not** "skip the draw when there is only one target").
> - **Pick-N-distinct** → draw `min(N, len)` times via `drawFromVector` on a **copy** of the
>   eligible list, consuming exactly that many draws (zero if the list is empty).
> - **`shuffle`-based effects** (Mosquito, Blowfish) → `shuffle(seed, list)` consumes `n-1`
>   internal draws for `n >= 2` and **zero** for `n <= 1`; then apply the first `min(N, len)` of
>   the shuffled order. Because `shuffle` is byte-identical to Move, both sides stay in lock-step.

A naive "only one candidate, so skip the draw" shortcut is a **bug**: it consumes a different
number of draws than the strict path and desyncs the engine from the referee, breaking
invariant #1.

| Pet / Food | Classic randomness | Deterministic adaptation |
| --- | --- | --- |
| Ant, Otter, Bluebird | buff a **random** friend | Build the eligible-friend list left→right; pick index `nextU64InRange(seed, 0, len)` (see the degenerate-list rule above for empty / single-element lists). |
| Beaver, Salad Bowl | buff **2 random** friends | `drawFromVector` on a **copy** of the eligible list, `min(2, len)` times (distinct targets); per the degenerate-list rule, an empty list is a no-op and a single-element list draws exactly once. |
| Mosquito | hit **random** enemies | `shuffle(seed, enemies)`; apply the N hits to the first `min(N, len)` of that fixed order (`shuffle` consumes 0 draws when ≤1 enemy). |
| Blowfish | hit a **random** enemy | Same shuffle rule; target = first of the seeded order (no-op if no enemies). |
| Spider | summon a **random** tier-3 pet | `nextU64InRange(seed, 0, len)` indexes the **sorted tier-3 table** (roster §6 order); summon that pet at base stats **overridden to 2/2** (L2 3/3, L3 4/4), **keeping its innate trigger** (it is a real pet, not a §6.1 token). |
| Level-up free pet (`onLevelUp`) | grant a **random** next-tier pet | `nextU64InRange(`**shopSeed**`, 0, len)` over the sorted next-tier table (roster §6 order), using the **shop seed**, *not* the battle seed; if no next-tier pet is available (tier locked/empty or beyond tier 6) it is a no-op (zero draws). Equivalently, expose it as a free shop slot resolved by the normal shop-roll mechanism. |
| Rat → Dirty Rat | spawn position varies | Fixed rule: spawn at the **front of the enemy** line (N copies per Rat's level, §6). |
| Shop rolls | random shop contents | Driven by the **shop seed** + `shuffle` over the unlocked-tier pool; **freeze** removes a slot from the reshuffle. Same `(playerState, shopSeed, turn)` → same roll sequence. |
| Trigger-order ties (intra- and cross-team) | order ambiguity | Within a team resolve **left→right**; across teams **interleave by board index** (`A[0], B[0], A[1], B[1], …`); any remaining true tie breaks with `nextU64InRange(seed, …)` so both clients agree. |

### 9.3 Gold-timing note

Gold-producing triggers (Swan `onStartOfBattle` in battle, Pig `onSell` in shop) accrue to the
**player's gold for the next shop**; they never alter battle state or the running balance ledger.
Battle outcome is independent of gold, preserving the pure `(teamA, teamB, battleSeed)` function.
Hearts/wager balance shifts happen only in the protocol layer (`superAutoPets.ts`), never inside
the engine.

---

## 10. How the engine reads this (implementation-ready shape)

A developer transcribes each roster/food row into a static table keyed by a stable kebab-case id.
The effect is a pure function that reads a battle context (which carries the seed cursor) and
mutates a working copy of the board only — never the signed protocol state.

```ts
// Mirrors design §2 (amended) / ADR 0009. The amended design spec is the canonical
// event list; this enum follows it — do not add events here without amending the spec.
export type SapEvent =
  | "onBuy"
  | "onSell"
  | "onLevelUp"
  | "onStartOfBattle"
  | "onFaint"
  | "onHurt"
  | "onBeforeAttack"
  | "onFriendFaint"
  | "onFriendSummoned";

export interface PetDef {
  id: string;                  // stable kebab id, e.g. "ant", "zombie-cricket"
  name: string;
  tier: 1 | 2 | 3 | 4 | 5 | 6; // tiers 4–6 reserved now so they are genuinely additive
  atk: number;                 // level-1 base attack
  hp: number;                  // level-1 base health
  buyable: boolean;            // false for tokens (Bee, Zombie Cricket, Dirty Rat, Ram)
  trigger: SapEvent | null;    // null = vanilla (no ability)
  effect?: (ctx: BattleCtx, self: PetInstance) => void; // pure; reads ctx seed via nextU64InRange/shuffle
}

export interface FoodDef {
  id: string;
  name: string;
  cost: number;               // 3, or 1 for the Pill
  trigger: SapEvent;          // onBuy for consumables; onFaint/onHurt/onBeforeAttack for held items
  effect: (ctx: ShopCtx | BattleCtx, target: PetInstance) => void;
}
```

Engine-side rules the table relies on:

- Triggers fire **left → right within a team**, the two teams **interleaved by board index**;
  remaining ties are seed-broken (§9.2).
- All randomness flows from `ctx.seed` via `nextU64InRange` / `shuffle` / `drawFromVector`
  (`core/randomness.ts`) — adding a pet never touches the battle loop. Seed-consumption on empty
  / single-element / pick-N lists follows the degenerate-list rule in §9.2 (identical draw counts
  across TS and Move).
- Effects operate on a working board copy; the protocol (`superAutoPets.ts`) keeps balances summing
  to the locked total and excludes raw teams/gold/shop from `encodeState` (design §4.2).
- New pets/foods are **additive**: append a row here and one `PetDef`/`FoodDef` entry — no engine
  change (tiers 4–6 are already in the `tier` union, so adding them needs no type change). This is
  what makes the phased roster growth in design §6 cheap.
