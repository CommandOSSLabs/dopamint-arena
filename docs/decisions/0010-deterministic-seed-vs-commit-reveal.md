# 0010 — Deterministic tunnelId seed vs commit-reveal for game randomness

- **Status**: Accepted
- **Date**: 2026-06-22

## Context

Tunnel games derive their randomness (shuffles, hazard fields, crate layouts)
from a seed that is part of `encodeState`, so both parties and an on-chain
disputer replay identically. Two seeding strategies exist in the repo and a
new game must pick one:

- **Deterministic** — the seed is a pure function of `(tunnelId, …)`. Blackjack
  uses this for its card stream (`blackjack.ts` header: *"bias-free without any
  commit-reveal round-trips"*).
- **Commit-reveal** — both parties commit to secret randomness, then reveal.
  Used by battleship (0003), quantum poker (0008), and Super Auto Pets (0009).

The ambiguity: chicken-cross and bomb-it ship PvP and both seed from
`seedFromTunnelId(tunnelId)`. `docs/adding-a-tunnel-game.md` previously said PvP
*should* use commit-reveal, which no shipped game does.

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
- The distinguishing test for future games: *does any party hold hidden state it
  could bias?* If yes → commit-reveal (0003/0008/0009). If the field is public
  and symmetric → deterministic `tunnelId` seed.
- A separate, real bias (chicken-cross's equal-score dead-heat awarding seat A)
  is fixed independently to a push; it was a tiebreak bug, not a seeding one.
