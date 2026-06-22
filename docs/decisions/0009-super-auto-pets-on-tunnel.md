# 0009 — Super Auto Pets on the Sui tunnel

- **Status**: Proposed
- **Date**: 2026-06-19

## Context

We are adding a **full Super Auto Pets** (SAP) auto-battler as a new arena game,
played **heads-up 1v1, turn-based** over a single Sui tunnel. ADR 0001 sets the
architecture: one generic `sui_tunnel` Move package plus per-game TS `Protocol`
implementations. ADR 0008 (Quantum Poker) sets the commit-reveal precedent for
hidden information and a verifiable, dealerless shuffle. The multi-round session
pattern from `quantumPoker.ts` / `quantum_poker.move` (many hands in one tunnel)
shows how one tunnel hosts a whole ~10-round run (one open, one settle). The
design spec is `docs/superpowers/specs/2026-06-19-super-auto-pets-design.md`.

**Stays on `dev`.** All work happens on `feat/super-auto-pets` (branched off
`dev`) and pushes to `dev`; no merge or rebase from `main`. Every reference SAP
builds on is already present on `dev`: the multi-round, commit-reveal protocol
`sui-tunnel-ts/src/protocol/quantumPoker.ts`, the on-chain
`sui_tunnel/sources/quantum_poker.move`, and the core tunnel session API
(`update_state`, `close_cooperative` / `close_cooperative_with_root`,
`raise_dispute`). We deliberately do **not** use the `example_multi_game_tictactoe`
template (it lives only on `main`); `quantumPoker` is the better fit anyway since
SAP, like poker, needs commit-reveal hidden information.

The hot path is `Protocol.applyMove` → `OffchainTunnel.step`: each shop action
and round result becomes an off-chain co-signed `state_update`. The chain only
does open / deposit / cooperative close / generic dispute. The build is under a
**hard 1-week-build + 1-week-test deadline**, so deadline risk is itself a
decision to record.

Four decisions are contested and two reasonable people could resolve them
differently:

1. **Battle determinism + the ability framework.** SAP's battle is far richer
   than `example_tic_tac_toe::check_winner` — triggered abilities, summons,
   target selection. If any of that consults wall-clock or unseeded RNG the two
   parties desync and the on-chain referee cannot re-derive the result. How do we
   keep it a pure function *and* stop per-pet rules from leaking into the engine?
2. **Hidden teams + provably-fair shop, without a dealer.** A visible team during
   the shop phase enables counter-pick (game-breaking); a single-party shop seed
   is biasable. How do we get both with no trusted server?
3. **Where settlement lives.** A dedicated SAP session Move module versus the
   generic tunnel functions — and the fallback if the bespoke module slips.
4. **Shipping full scope under a 2-week deadline** without the safety slice ever
   being at risk.

## Decision

### Deterministic battle + trigger-event ability framework

We make the battle a **pure function** `resolve(teamA, teamB, battleSeed)` in
`sui-tunnel-ts/src/protocol/sapEngine.ts`. Every in-battle "random" choice
(target selection, tie-breaks, summon picks) is drawn from `battleSeed` through
the verifiable `core/randomness.ts` (`seedFromBytes` / `shuffle` /
`nextU64InRange`), which is byte-identical to `randomness.move`. No wall-clock, no
unseeded RNG — the same determinism property `check_winner` and the SDK
`ticTacToe` engine rely on, extended to triggered abilities.

Abilities are **triggered effects on a fixed event set** — `onBuy`, `onSell`,
`onLevelUp`, `onStartOfBattle`, `onFaint`, `onHurt`, `onBeforeAttack`,
`onFriendFaint`, `onFriendSummoned`. Each pet declares which events it reacts to
plus a pure effect function; the engine fires triggers in a fixed order
(leftmost-first, seed-broken ties). Adding a pet is one entry in the roster table
(`docs/superpowers/specs/2026-06-19-super-auto-pets-roster.md`), never an
engine-loop edit.

*Alternatives considered:* (a) a stateful event-bus engine where pets register
imperative callbacks — rejected: hard to keep pure and to re-derive on-chain;
(b) hardcoding each pet into the battle loop — rejected: does not scale to ~30+
pets and entangles roster with engine; (c) server-authoritative resolution —
rejected: breaks trustlessness and the dispute re-derivation guarantee.

### Hidden teams + fair-shop randomness via commit-reveal

We reuse the ADR 0008 / `quantumPoker` commit-reveal **unchanged**:
`core/commitment.ts` (`computeCommitment` / `verifyCommitment` /
`combineReveals`, salt ≥ 16 bytes) — never the buggy `utils.computeCommitment`.

**Hidden team:** during the private, parallel shop phase only the commitment
`H(team || salt)` enters the signed shared state (like poker hole cards); raw
`team`, `salt`, `gold`, and `shop` stay local and are excluded from
`encodeState`. Both reveal `(team, salt)` at battle and each verifies the other's
commitment; withholding a reveal is forfeit. No counter-pick is possible.

**Fair shop:** each round both parties commit a random share and then reveal; the
joint shop seed is `combineReveals(shareA, saltA, shareB, saltB)` →
`seedFromBytes` → `shuffle`, so neither side can bias the shop. This is the same
primitive as `example_coin_flip` / `example_rock_paper_scissors`.

*Alternatives considered:* (a) a trusted server/dealer for shop RNG — rejected,
not trustless; (b) a single-party or per-player seed — biasable, kept only as the
documented de-scope fallback below; (c) revealing teams during shopping —
rejected, it enables counter-pick and kills the game.

### Settlement: dedicated SAP session Move module, generic tunnel as fallback

We settle through a dedicated session module
`sui_tunnel/sources/examples/example_super_auto_pets.move` that wraps a
`Tunnel<T>` and follows the multi-round commit-reveal pattern of
`quantum_poker.move` / `quantumPoker.ts` (both on `dev`): a running scoreboard (hearts, round wins) plus
running balances, `record_round_result` delegating to `tunnel::update_state`,
`settle_session` via the `close_cooperative` transfer variant, and dispute hooks
delegating to the tunnel's `raise_dispute` / `resolve_dispute` /
`force_close_after_timeout`. The signed session `state_hash` commits to
`(hearts || round || running balances)`; the strictly-increasing per-tunnel nonce
is bound by the core `state_update` message and **excluded** from the session
hash (the SAP module computes this hash itself, as `quantum_poker.move` does; the
nonce is excluded because including it would make the on-chain and off-chain
hashes diverge). **This ADR
supersedes the source-of-truth spec §4.3 on this point** — the spec previously
listed `|| nonce` in the session hash and has been corrected to match this
(nonce excluded, bound only by the core `state_update` message); reintroducing
`|| nonce` would resurrect exactly the hash-divergence bug the framework warns
against, touching invariant (3). Byte parity is enforced by golden tests:
`sui-tunnel-ts/src/core/golden.gen.ts` cross-checked by a Move test mirroring
`sui_tunnel/tests/randomness_xcheck_tests.move`. The module is a thin wrapper —
it adds no new trust surface, and it requires **no changes to the `sui_tunnel`
framework core** (`tunnel.move`, `randomness.move`, etc.) or the `sui-tunnel-ts/`
framework core; the only Move additions are the new example module plus its test
under `sui_tunnel/sources/examples/` and `sui_tunnel/tests/`.

**De-scope fallback:** if the Move module slips the deadline, we settle through
the generic tunnel open / deposit / close / dispute functions directly (the happy
path needs only the latest dual-signed state) and add the bespoke scoreboard
module later. This is exactly the ADR 0008 stance — no game-specific Move is
required for a playable game.

*Alternatives considered:* (a) a `black_jack`-style game-specific manager
contract that owns funds — rejected, ADR 0008 already rejected this as a
settlement architecture; (b) generic-tunnel-only from the start — viable, and it
is the fallback, but the session module gives on-chain scoreboard/dispute
legibility and matches the shipped TTT session pattern; (c) a ZK battle proof at
settlement — rejected on the hot path (see Consequences), dispute-only later as
in 0008.

### Strict phased delivery + de-scope order (the deadline-risk decision)

We treat the deadline as a first-class constraint and commit to a strict phase
order with an always-shippable slice (spec §6): engine core (day 1–2) → a
**vertical slice that settles end-to-end off-chain** (day 3–4, the safety
milestone) → fair shop + economy (day 5) → depth: leveling/combine, food, roster
toward ~30 pets (day 6) → on-chain module + frontend wiring (day 7); week 2 is
golden parity, fuzz/property tests, PvP e2e on testnet, and FE polish. The plan
`docs/superpowers/plans/2026-06-19-super-auto-pets.md` sequences these
task-by-task.

**De-scope order if behind (drop from the bottom):** extra pets → food →
leveling/combine → the on-chain Move module (fall back to the generic tunnel) →
fair-shop commit-reveal (fall back to a per-player seed). The hidden-team
commit-reveal and the deterministic battle are **not** cuttable — they are the
game.

*Alternatives considered:* (a) build the full roster/features first and integrate
last — rejected, leaves nothing shippable if time runs out; (b) cut scope up
front to a minimal game — rejected, the trigger framework makes depth additive,
so we keep full scope as the target with depth as the cut line; (c) parallelize
all phases — rejected, the vertical slice must be green before depth so the
safety milestone holds.

## Consequences

- **Easier**: hidden teams and a provably-fair shop reuse the ADR 0008
  commit-reveal and verifiable shuffle unchanged; the whole game runs on the same
  `Protocol` + `OffchainTunnel` hot path as TTT and poker, inheriting state
  hashing, strictly-increasing nonce, dual-sign, and replay protection for free;
  a new pet is a single roster-table entry behind the trigger framework, never an
  engine change; one tunnel open plus one settle covers a ~10-round run via the
  session-channel pattern; there is always a shippable, settling slice from day
  3–4 onward.
- **Harder / committed to**: the battle engine is the largest single piece and
  must stay byte-identical to its Move re-derivation for disputes (golden parity
  via `golden.gen.ts` plus a `randomness_xcheck`-style Move test, kept in sync by
  hand — drift is only caught by re-running the generator); every "random" SAP
  effect must be re-expressed as a pure seed draw (each adaptation is flagged in
  the roster doc); balances must always sum to the locked total across rounds
  (only the clamped per-round wager moves loser→winner) or `OffchainTunnel`
  throws; state must stay small by excluding private `team`/`salt`/`gold`/`shop`
  from `encodeState` and sharing only commitments plus the running ledger
  (`rollingDigest` if needed).
- **Move footprint**: none is required for a playable game beyond the generic
  tunnel open / deposit / cooperative-close / dispute functions; the only Move
  additions are the new example module plus its test —
  `example_super_auto_pets.move` under `sui_tunnel/sources/examples/` and its
  test under `sui_tunnel/tests/` — with **no changes to the `sui_tunnel`
  framework core** (`tunnel.move`, `randomness.move`, etc.). The example module is
  a thin session wrapper with no new trust surface, and it is itself on the
  de-scope line — if it slips we settle through the generic tunnel.
- **Explicitly not done**: no ZK on the hot path (a battle proof, if ever, is
  dispute-only and deferred, mirroring ADR 0008); no trusted server/dealer for
  shop RNG or battle resolution; no full official ~170-pet roster or every
  interaction (a faithful, phase-growing subset behind one trigger framework); no
  counter-pick (teams stay committed until both reveal); no changes to the
  `sui_tunnel` framework core (`tunnel.move`, `randomness.move`, etc.) or the
  `sui-tunnel-ts/` framework core.
