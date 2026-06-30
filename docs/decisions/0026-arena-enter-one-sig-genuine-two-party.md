# 0026 — Arena enter: one signature, fund-own-seat, all games vs the serving fleet

- **Status**: Proposed — **open mechanics (steps 2–3) superseded by
  [0028](0028-arena-bot-preopens-user-deposit-only.md)** (the bot, not the user,
  creates the tunnel; the user's PTB is deposit-only). Goals and all other steps
  stand.
- **Date**: 2026-06-29
- **Refs**: realizes the deferred genuine you-vs-bot of
  [0012](0012-arena-attract-cabinet-seam.md); fills the bot↔user pairing/funding
  deferred by [0020](0020-bot-fleet-topology-shared-core.md) and the agent-fleet
  pool deferred by [0011](0011-local-first-pairing.md); extends the batched-open
  machinery of [0019](0019-batched-tunnel-open.md); funding via
  [0013](0013-address-balance-stake.md)/[0014](0014-enoki-sponsor-with-settler-fallback.md);
  settle via [0007](0007-settle-authorized-by-settlement-not-token.md).

## Context

ADR-0012 made arena auto-play a local `OffchainTunnel.selfPlay` (both bot keys,
off-chain, settlement cosmetic) and explicitly deferred the genuine you-vs-bot
channel. ADR-0020 stood up a serving fleet as the genuine counterparty but
deferred how a user is paired with and funds a match against it. ADR-0019 proved
N opens coalesce into one sponsored PTB — but only for the self-play
(fund-both-seats) path.

We want: connect wallet → one signature → every arena game is a live, genuine
two-party channel against a warm fleet bot, auto-playing immediately, with the
user free to take any seat. Three forces fix the shape:

- **Genuine two-party (provenance).** Each party funds and co-signs its **own**
  seat; the user funding the bot's seat would be self-play with extra steps.
- **One signature.** Opening a tunnel needs both ephemeral pubkeys at create
  time, and a PTB is atomic — so "one signature" means every game's tunnel is
  created together, up front. There is no one-signature *and* lazy-open without a
  pooled balance the backend draws from (new Move, rejected below).
- **Instant.** The counterparty must already exist, so bots are a **warm pool
  allocated on demand**, not FIFO-matched.

## Decision

**Arena enter is one sponsored PTB that opens + funds-own-seat for every game
against pre-allocated fleet bots.**

1. On connect the backend **allocates N warm bots** (one per game) and returns
   each bot's ephemeral pubkey + match id. Direct allocation, not the FIFO
   bounded-hold of ADR-0011 — a bot is always available, so there is no hold.
2. The frontend extends ADR-0019's `TunnelOpenBatcher` with a
   **fund-seat-A-only** flush: it loops `buildOpenAndFundSeatA(userEph, botEph,
   stake)` once per game onto one `Transaction`, sponsored (ADR-0013/0014),
   correlated back by party-A address, chunked at `MAX_BATCH`, under the same
   `BatchCommittedError` no-double-open contract.
3. Each fleet bot **deposits its own seat B** server-side (gas-sponsored), so
   neither party funds the other.
4. The user is always **seat A** (funds seat A; under ADR-0028 the bot, not the
   user, creates the tunnel); the bot is always **seat B** and, as the
   always-online party, drives the cooperative settle (ADR-0007) — overriding any
   per-game "who hosts" convention.
5. Auto-play becomes genuine: when connected, each game's kit auto-loop co-signs
   the **user's** seat against the remote bot (realizing ADR-0012's deferred
   you-vs-bot). Take-over stops that game's auto-loop. Logged-out, the floor
   keeps ADR-0012's free local self-play attract.

## Consequences

- Genuine, attributable two-party play for every game from a single popup. This
  is the **provenance layer** of ADR-0020's TPS model (bulk TPS stays server
  self-play), so its volume is bounded by real user count, not the TPS target.
- **The fleet is the scaling long-pole.** A connected user drives N concurrent
  genuine channels co-signing over the relay. We commit to N warm bots reserved
  per connected user and to the fleet implementing deposit-B + settle (its
  `MatchAnchor`/`SuiAnchor` seam) and a per-game strategy.
- N tunnels open per user up front; with auto-on every one is live (not wasted),
  but all N must be closed/timed-out on leave (cooperative close, 3h dispute
  window). Abandonment cleanup is a fleet/backend responsibility.
- New backend surface: a bot-pool allocator + the bot's seat-B deposit path
  (today the backend only sponsors user txs and submits closes). The `is_bot`
  pairing guard already keeps any residual FIFO path from pairing two bots.
- We explicitly do **not**: fund both seats from one wallet (that is self-play,
  ADR-0019's path); put the user on the FIFO queue for the arena (allocation is
  direct); or build a pooled-balance/lazy-open model — one signature + atomic PTB
  means open-all-up-front, and a pool would need new Move for a free stake token.
- Rollout is game-by-game: the FE/backend plumbing is generic, but E2E lands per
  game as the fleet adds each protocol's strategy + anchor — **blackjack first**.
