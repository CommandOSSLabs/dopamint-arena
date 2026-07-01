# 0020 — Settleable-at-every-state balances (cash-out invariant)

- **Status**: Accepted
- **Date**: 2026-07-01

## Context

A tunnel gives **safety** cryptographically — dual signatures + a monotonic
nonce, and the chain settles only co-signed balances, never game rules. But
**liveness** is not automatic. On a stall, either party escalates on-chain and
`force_close_after_timeout` settles the **last co-signed state**; an online
counterparty dodges any penalty via `agree_to_dispute`.

Until now every game followed *"keep the split constant during play"*: balances
frozen at `(S, S)` for the whole game, flipped to winner-take-all only on the
deciding tick. That frozen split is a griefing vector — a trailing player stops
co-signing the losing move and settles the pre-win `(S, S)` state, turning a loss
into a **refund-draw** for free, penalty-free while online. With PvP as the
default (ADR-0006) and a player-vs-house roadmap, this is a real threat, not
hypothetical.

## Decision

`balances(state)` MUST equal the fair **settle-if-halted-here** split at **every
reachable state** — the *cash-out invariant* — not a frozen split. Winner-take-all
applies only at a real terminal.

Chicken Cross implements it with `settleShare` (`sui-tunnel-ts/src/protocol/cross.ts`):
the lead in furthest-lane `score` maps linearly to the pot as a fraction of the
race distance (level ⇒ 50/50; a full-distance lead ⇒ winner-take-all). A stalling
chicken only locks its current share, which *erodes* as the opponent advances.

The invariant needs a **progress gradient**. Elimination / hidden-information
games (bomb-it, battleship, quantum poker) have none mid-game; they must instead
force the rule-mandated move on-chain via `zk_verifier` / `resolve_dispute_verified`
(ADR-0008). That path is **out of scope here** and built per-game when such a game
ships real-money PvP.

This keeps the Move/engine layer game-agnostic — `balances()` is computed
off-chain and the contract settles whatever co-signed numbers it is handed. No
Move, backend, relay, or wire-format change.

## Consequences

- **Easier**: the griefing-draw class is eliminated for progress-gradient games;
  abandoned / timed-out matches settle fairly by progress; a reusable invariant
  test guards the regression; zero on-chain change.
- **Trade-offs**: an abandoned match now settles **proportional to progress
  instead of refunding both stakes** — a deliberate, fairer behaviour change the
  team owns. The progress metric is a fair *proxy*, not a true win-probability, so
  a near-certain winner can still be shaved slightly by a stalling opponent down
  to their progress share; closing that last mile needs the forceable-move path. A
  non-monotonic `balances()` in a future game would be a new vector, so the
  invariant test is mandatory.
- **Committed to**: amending Invariant 1 in `docs/guide/adding-a-tunnel-game.md`;
  elimination / hidden-info games stay winner-take-all-at-terminal until the
  forceable path ships per-game.
- **Rejected**: on-chain game-rule enforcement as the default (breaks
  game-agnosticism); a trusted referee as the foundation (reintroduces trust).

Design detail and threat model: `docs/design/tunnel-settlement-fairness.md`.
