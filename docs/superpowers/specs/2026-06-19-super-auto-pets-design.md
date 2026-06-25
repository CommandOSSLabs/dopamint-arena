# Super Auto Pets Game Mode — Design

**Date:** 2026-06-19
**Status:** Draft (design); pending review → implementation plan
**Scope:** Add a **full** Super Auto Pets (SAP)–style auto-battler as a new arena game,
played **heads-up 1v1, turn-based** over a single Sui tunnel, settled on-chain through the
existing tunnel flow. No changes to the repo core (`sui_tunnel/`, `sui-tunnel-ts/` framework).
**Timeline:** 1 week build + 1 week test (hard deadline). See §6.

---

## 1. Goal

Two staked players. Each round: privately build a team of pets in a **shop phase** (buy / sell /
roll / position / **combine-to-level-up** / **food items**), then reveal teams and run a
**deterministic battle** that costs the loser a heart. First player to drop the opponent to 0
hearts wins the pot. Implemented as a new `Protocol<State, Move>` in the SDK + a battle engine +
an on-chain example module, reusing the patterns shipped for Tic-Tac-Toe (session channel) and
Quantum Poker (commit-reveal hidden info).

### Why SAP fits the tunnel

| Tunnel property                                                                         | SAP feature it enables                                     |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Off-chain dual-signed updates (instant, no gas)                                         | Every shop action is instant and free                      |
| Session channel = many rounds, one tunnel (`quantumPoker` multi-hand pattern, on `dev`) | A full run is ~10+ rounds → one open, one settle           |
| Commit-reveal + verifiable shuffle (`quantumPoker`, `coin_flip`)                        | **Provably fair shop** + **hidden team** (no counter-pick) |
| Strictly-increasing nonce + dual signatures                                             | Replay protection + dispute safety, inherited free         |
| Running balances that sum to the locked total                                           | Wager shifts loser→winner each round; settle once          |

### Decisions to lock during review

- **Lives:** start at `HEARTS = 5`; lose a battle → −1 heart; 0 hearts = eliminated.
- **Round economy:** `GOLD = 10`/round, team size 5, buy = 3g, roll = 1g, sell refund = 1g.
- **Leveling:** 3 levels; combine 2 same-tier copies → level-up (stats + stronger trigger),
  matching SAP (level 2 at 3 copies, level 3 at 6).
- **Food items:** included (apple +1/+1, and a small set — see roster doc).
- **Tiers:** pets unlock by round number (tier 1 from round 1, higher tiers later).
- **End:** first to 0 hearts, or round cap (default 15) → most hearts wins; tie → draw split.
- **Roster:** full target ~30 pets across tiers (delivered in phases — see §6).

### Non-goals

- The exact official ~170-pet roster and every interaction. We build a faithful **subset that
  grows by phase**, behind one trigger framework, so more pets are additive.
- On-chain ZK battle proof in v1 (use dispute re-derivation; mirror Quantum Poker's
  dispute-only circuit later if needed).
- Any change to `sui_tunnel/` or the `sui-tunnel-ts/` framework. All work is game-side.

---

## 2. The one hard constraint: determinism

The battle MUST be a pure function of `(teamA, teamB, battleSeed)` so both parties compute the
same result, co-sign it, and an on-chain referee can re-derive it in a dispute. Any in-battle
randomness (random target, ability order ties) is drawn from the seed. No wall-clock, no unseeded
RNG in the engine. Same property `example_tic_tac_toe::check_winner` and the SDK `ticTacToe`
engine rely on, extended to a richer battle with triggered abilities.

**Ability model (the complexity to control):** abilities are _triggered effects_ on a fixed event
set — `onBuy`, `onSell`, `onLevelUp`, `onStartOfBattle`, `onFaint`, `onHurt`, `onBeforeAttack`,
`onFriendFaint`. Each pet declares which events it reacts to and a pure effect function. The
engine fires triggers in a deterministic order (left→right, seed-broken ties). Adding a pet =
adding one entry to the roster table; it never touches the engine loop.

---

## 3. Round structure (1v1, turn-based)

Both players stake equal amounts at open; pot = stakeA + stakeB.

1. **Shop phase (private, parallel).** Each player gets gold and a shop drawn from a **shared
   fair seed**. Actions: `buy`, `sell`, `roll`, `place`/`reorder`, `combine` (level-up), `applyFood`.
   The built team stays **private**; only a commitment `H(team || salt)` enters the signed shared
   state — like poker hole cards.
2. **Reveal + Battle (deterministic).** Both reveal `(team, salt)`; each verifies the other's
   commitment. The battle engine runs leftmost-pet-attacks-first, firing triggers, until one side
   is empty. Loser loses a heart; running balances shift by `wagerPerRound` (clamped). Both
   co-sign the new state.

### Fairness

- **Fair shop RNG:** each round both parties commit-reveal a random share
  (`core/commitment.ts`), combined into a joint seed (`combineReveals`), expanded into shops via
  the verifiable Fisher–Yates `shuffle` in `core/randomness.ts` (byte-identical to
  `randomness.move`). Neither can bias the shop.
- **Hidden team / no counter-pick:** only the team commitment is shared during shopping, so
  neither sees the opponent's board until both reveal (same principle as
  `example_rock_paper_scissors`).
- **Deterministic battle:** reproducible and adjudicable on-chain in a dispute.

---

## 4. Architecture (what we build, mirroring existing games)

### 4.1 Battle engine — `sui-tunnel-ts/src/protocol/sapEngine.ts`

The deterministic battle + pet roster table + ability triggers + leveling + food, unit-tested in
isolation from the tunnel. This is the largest single piece; build and test it first (§6).

### 4.2 SDK protocol — `sui-tunnel-ts/src/protocol/superAutoPets.ts`

Implement the existing `Protocol<State, Move>` interface (`protocol/Protocol.ts`). The off-chain
engine (`core/tunnel.ts`) then provides state encoding, dual-sign flow, settlement, and replay
protection for free.

```ts
type SapPhase = "shop" | "reveal" | "battle" | "done";

interface SapState {
  phase: SapPhase;
  round: bigint;
  heartsA: number;
  heartsB: number;
  seedCommitA: Uint8Array | null;
  seedCommitB: Uint8Array | null; // fair shop RNG
  teamCommitA: Uint8Array | null;
  teamCommitB: Uint8Array | null; // hidden teams
  // private (excluded from encodeState): teamA, saltA, teamB, saltB, gold, shop
  balanceA: bigint;
  balanceB: bigint;
  total: bigint; // sum invariant
  wagerPerRound: bigint;
}

type SapMove =
  | { kind: "commitSeed"; commitment: Uint8Array }
  | { kind: "revealSeed"; share: Uint8Array; salt: Uint8Array }
  | { kind: "commitTeam"; commitment: Uint8Array } // end of private shop phase
  | { kind: "revealTeam"; team: Pet[]; salt: Uint8Array };
```

- `applyMove` pure, throws on illegal moves; battle resolves once both `revealTeam` are in.
- `encodeState` canonical encoding (or `rollingDigest`) → tunnel `state_hash`; private fields excluded.
- `balances` returns `{a, b}` (sum = total). `isTerminal` = a player at 0 hearts (or round cap).
- `randomMove` drives the simulator / self-play bot lane (benchmark + bot mode).

Shop interactions (buy/sell/roll/combine/food) run in the player's **private client** and collapse
into a single `commitTeam`, keeping the shared/signed state small and the hot path fast.

### 4.3 On-chain example — `sui_tunnel/sources/examples/example_super_auto_pets.move`

Follow the multi-round commit-reveal pattern of `quantum_poker.move` (on `dev`): wrap a
`Tunnel<T>`, keep a running scoreboard (hearts, round wins) + running balances, expose
`record_round_result` (delegates to `tunnel::update_state`), `settle_session`
(`close_cooperative`), and dispute hooks. Signed `state_hash` commits to
`(hearts || round || running balances)`. The strictly-increasing per-tunnel nonce is
**excluded** from the session hash — it is bound only by the core `state_update` message;
including it here would make the on-chain and off-chain hashes diverge (the SAP module computes
this hash itself, as `quantum_poker.move` does). See ADR 0009.

### 4.4 Cross-language correctness

Golden tests so SDK encoding / shop-shuffle / commit-reveal are **byte-identical** to Move,
following `wire_format_tests` / `randomness_xcheck_tests`. Standing repo invariant.

### 4.5 Frontend (this branch builds on dev)

`frontend/src/games/superAutoPets/` registered in `frontend/src/games/index.ts`, following the
Tic-Tac-Toe / Quantum Poker PvP wiring (`DistributedTunnel` + `MpClient.quickMatch`, a
`usePvpSuperAutoPets` hook + window component). Shop drag-and-drop + battle playback UI.

---

## 5. Risks & mitigations

- **Full SAP in 2 weeks is aggressive (acknowledged).** Mitigation = strict phasing (§6): a thin
  vertical slice settles end-to-end on day 3–4, then features are layered. If time runs out, the
  unlayered features drop but the game still ships and settles.
- **Ability determinism / desync** → all randomness from the battle seed; engine is pure; golden
  tests pin SDK==Move. The trigger framework keeps per-pet code tiny.
- **State size growth** → `rollingDigest` for `encodeState`; share only commitments + the running
  ledger; keep raw teams/gold/shop private.
- **Frontend shop UX scope** → reuse arena window + grid primitives; drag-and-drop last, click-to-
  place first.
- **Hot-path cost** → no ZK on the hot path; ZK battle proof (if added) runs only at dispute time.

---

## 6. Delivery plan for the deadline (1 week build + 1 week test)

Ordered so there is **always a shippable slice**. Each phase is independently demoable.

**Week 1 — build**

- **Day 1–2 — engine core.** `sapEngine.ts`: pet/team model, leftmost-attack battle loop,
  `onStartOfBattle` + `onFaint` triggers, ~6 tier-1 pets. Unit tests on the engine only.
- **Day 3–4 — vertical slice (settles!).** `superAutoPets.ts` protocol on the `Protocol`
  interface: round loop, hidden-team commit-reveal, balances/hearts, `isTerminal`. End-to-end
  off-chain self-play that opens → plays rounds → settles. **This is the safety milestone.**
- **Day 5 — fair shop + economy.** Commit-reveal shop seed + verifiable shuffle; gold, roll,
  buy/sell; tiers by round.
- **Day 6 — depth.** Leveling/combine, food items, expand roster toward ~30 pets and the full
  trigger set. (Cuttable if behind.)
- **Day 7 — on-chain + FE start.** `example_super_auto_pets.move` (+ tests) and the
  `superAutoPets/` frontend folder + PvP wiring skeleton.

**Week 2 — test**

- Golden tests (TS↔Move byte parity); engine fuzz/property tests; PvP e2e on testnet (two funded
  wallets); FE polish (shop UX, battle playback); bug-fix + telemetry. Treat flakes as bugs.

**De-scope order if behind (drop from the bottom):** extra pets → food → leveling/combine → on-
chain Move module (fall back to settling through the generic tunnel) → fair-shop commit-reveal
(fall back to per-player seed). The hidden-team commit-reveal and the deterministic battle are
**not** cuttable — they are the game.

---

## 7. Reference examples to copy from

- `sui-tunnel-ts/src/protocol/quantumPoker.ts` — multi-round session + commit-reveal hidden info + verifiable shuffle (primary reference, on `dev`)
- `sui_tunnel/sources/quantum_poker.move` — on-chain commit-reveal game (settlement reference, on `dev`)
- `sui-tunnel-ts/src/protocol/ticTacToe.ts` + `protocol/Protocol.ts` — minimal protocol shape
- `sui_tunnel/sources/examples/example_coin_flip.move` / `example_rock_paper_scissors.move` — commit-reveal fairness
- `docs/decisions/0008-quantum-poker-protocol-zk.md` — ADR precedent for a commit-reveal game

## 8. Follow-ups after this design is approved

1. **ADR** `docs/decisions/0009-super-auto-pets-on-tunnel.md` — determinism model, hidden-team
   commit-reveal, ability-trigger framework, de-scope order.
2. **Implementation plan** `docs/superpowers/plans/2026-06-19-super-auto-pets.md` — task-by-task,
   checkbox format, matching the caro plan, ordered per §6.
3. **Roster doc** — pet/ability/food table (the data the engine reads).
