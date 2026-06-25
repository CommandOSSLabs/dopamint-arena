# Bomb It & Chicken Cross — consistency hardening

> **Type:** design spec
> **Date:** 2026-06-22
> **Status:** approved, pre-implementation
> **Scope:** Close four consistency/contract gaps found when judging bomb-it and
> chicken-cross against the reference arena games (blackjack, tic-tac-toe).
> Behavior-preserving except one intentional fairness fix (the cross tiebreak).

## Background

bomb-it and chicken-cross are arena-native games (window + hook + `session-core`

- SDK `Protocol`), more integrated than the references (blackjack/ttt are thin
  wrappers around vendored apps). A parity review found them strongly consistent —
  file layout, hook wiring (telemetry, control-plane, settlement), the `Protocol`
  contract, the PvP `DistributedTunnel` pattern, and the shared `arcade-*`/`text-gold`
  chrome all match. Four narrow gaps remain. This spec resolves them.

Non-goals (verified, explicitly out of scope): adding sound (the references are
silent too — parity holds); reworking the neon play-surface palette (every game
hardcodes its own surface; ours consume all shared _chrome_ tokens). An incidental
discovery — `docs/decisions/README.md` is out of sync with the actual ADR files
(duplicate `0002`, a phantom `0006`/`0005` index entry) — is noted for the owner
but not addressed here.

## #1 — PvP seed fairness: deterministic seed, documented; fix the cross tiebreak

### Decision

Keep deterministic `seedFromTunnelId` for both games in solo **and** PvP. Do **not**
add commit-reveal. Record the decision as ADR `0010` and align the inline docs.

### Rationale

The repo already has both patterns, split by a clear line:

- **Commit-reveal** is used where a party holds **hidden information it could lie
  about** — battleship fleets (ADR-0003), quantum-poker hands (ADR-0008), Super
  Auto Pets teams (ADR-0009).
- **Deterministic seed from `(tunnelId, …)`** is used where the random field is
  **public and no party controls it** — blackjack's card stream (`blackjack.ts`
  header: _"bias-free without any commit-reveal round-trips"_).

bomb-it and chicken-cross are squarely in the second category: the hazard field
(per-lane, by `(seed, lane, tick)`) and the bomb grid (180°-rotationally
symmetric) are **public and identical for both seats**, and `tunnelId` is a
Sui-assigned object id no party can grind. There is no hidden state to commit, so
commit-reveal would add handshake round-trips and SDK surface for no fairness gain
(YAGNI) — and it would contradict the shipped blackjack precedent.

### Changes

- **`sui-tunnel-ts/src/protocol/cross.ts`** and **`bombIt.ts`** — add a short
  header note (mirroring `blackjack.ts:5-8`) stating _why_ deterministic
  tunnelId-seeding is fair here: public, symmetric, party-independent field;
  un-grindable id; no hidden state ⇒ no commit-reveal.
- **`docs/adding-a-tunnel-game.md`** (§"The protocol contract", Invariant 2,
  line ~56) — replace the absolute _"PvP should derive the seed from a two-party
  commit-reveal"_ with the real rule: deterministic seeding is fine when the random
  field is **public and party-independent**; commit-reveal is required only when a
  party holds **hidden state it could bias** (cite ADR-0003/0008/0009 vs blackjack).
- **`docs/decisions/0010-deterministic-seed-vs-commit-reveal.md`** — new ADR
  (Accepted) recording the public-symmetric-field ⇒ deterministic-seed line, with
  bomb-it/cross as instances and the two precedent groups above.

### The genuine fairness fix (cross tiebreak)

`cross.ts` is internally inconsistent on equal-score ties:

- `cross.ts:300` — equal score at `TICK_CAP` ⇒ **push** (`winner = null`).
- `cross.ts:294` — equal score on simultaneous `WIN_LANE` arrival ⇒ **awards A**.

In true human-vs-human PvP the second path silently favors seat A. Fix: a
simultaneous double-arrival with equal score resolves to **push**, matching the
tick-cap path. Higher score still wins; only the exact dead-heat changes.

```ts
// cross.ts applyMove — replace the aWon && bWon branch:
if (aWon && bWon) {
  if (players[0].score > players[1].score) winner = "A";
  else if (players[1].score > players[0].score) winner = "B";
  else winner = null; // exact dead heat ⇒ push, same as the TICK_CAP tie path
}
```

This keeps conservation intact (`null` winner leaves balances at `(S, S)`, which
already sum to `total`) and makes both tie paths consistent.

## #2 — delete the dead `.arena-win-banner` rule

`frontend/src/styles/index.css` (~lines 406-409) defines `.arena-win-banner` with
the comment _"Used by every arena game's result screen."_ It has **zero usages**
anywhere in `src`. Our boards already animate their result via
`.bomb-result__trophy` / `.cross-result__trophy` (custom scale+rotate pops); the
vendored references have their own. The class is dead and the comment is false.

- Remove the `.arena-win-banner` rule and its comment.
- **Keep** `@keyframes arena-win-pop` — `.arcade-card` still uses it (`index.css:446`).

Do **not** force-adopt the class onto the boards: it would double-animate against
the existing trophy pops.

## #3 — test honesty + settleability coverage

- **`frontend/src/games/chickenCross/session-core.test.ts:3-4`** — the header says
  it _"mirrors `blackjack/session-core.test.ts` exactly."_ It doesn't (it omits
  blackjack's settleability test and bounds at 120 ticks). Correct the comment to
  state the real shape: bounded advance + conservation, with full termination
  covered by the protocol's own SDK tests. (bomb-it's test makes no such claim.)
- **Add a bounded settleability test** to **both** `session-core.test.ts` files,
  modeled on `blackjack/session-core.test.ts:57-70` but bounded so it does not
  co-sign thousands of updates: play ~50 ticks via `stepSession`, then assert
  `verifyCoSignedUpdate(tunnel.latest, …)` passes. This proves the co-signed state
  is on-chain-settleable mid-game — the property blackjack's full-playout test
  proves, adapted to a long-running real-time game.

## #4 — per-game READMEs

Add `README.md` to `frontend/src/games/bombIt/` and `frontend/src/games/chickenCross/`
in the **blackjack README style** (short; arena-native focus), not ttt's
legacy-standalone style. Each covers:

- One-paragraph intro: PvP-default (human-vs-human over a shared tunnel) with a
  Solo self-play on-ramp; real Sui tunnel, genuine co-signing.
- "How it works" per-file bullets: `*Window.tsx` (status router), `use*Session.ts`
  (solo self-play hook), `usePvp*.ts` (DistributedTunnel + matchmaking + settle),
  `session-core.ts` (pure driver), the SDK `Protocol`, `components/` + `*.css`.
- A note on PvP determinism + the #1 seed rationale (public symmetric field,
  deterministic `tunnelId` seed, no commit-reveal).
- "Gate" block with the exact commands (below).

## Testing & gate

Per `docs/adding-a-tunnel-game.md` §Gate and CLAUDE.md §Testing:

```
cd sui-tunnel-ts && node --import tsx --test src/protocol/cross.test.ts
cd sui-tunnel-ts && node --import tsx --test src/protocol/bombIt.test.ts
cd frontend && node --import tsx --test "src/games/bombIt/session-core.test.ts" "src/games/chickenCross/session-core.test.ts"
cd frontend && pnpm typecheck
cd frontend && pnpm build
```

New/changed tests:

- `cross.test.ts` — equal-score double-arrival ⇒ push.
- both `session-core.test.ts` — bounded settleability (`verifyCoSignedUpdate`).

Behavior change surface is limited to the cross equal-score double-arrival tie
(push instead of A). Everything else is comments, docs, a dead-CSS deletion, new
tests, and new READMEs.

## Out of scope / follow-ups

- ADR index (`docs/decisions/README.md`) rot — flag to owner.
- Sound for the arena mini-games — enhancement, not a parity gap.
