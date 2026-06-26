# Architecture Decision Records

Short records of **architecture-level** decisions, written _before_ the code
that depends on them. An ADR captures the decision and the reasoning so the
_why_ survives after the people involved have moved on.

## Convention

- **Architectural only.** An ADR records a decision that shapes system
  structure, crosses a component or team boundary, or is costly to reverse
  (control-plane topology, settlement auth, randomness strategy, funding model).
  It is **not** for implementation details, library/component choices, or a game
  adopting an already-recorded pattern — those belong in a design doc or the PR.
- One file per decision: `NNNN-kebab-case-title.md` (zero-padded, monotonic and
  **unique** — never reuse a number).
- Copy `0000-template.md` to start.
- Status moves `Proposed → Accepted → (Superseded by NNNN)`. Never delete a
  superseded ADR — mark it and link forward, so the history stays readable.
- Keep it short. An ADR records a decision; it is not a design doc.

## Index

- [0001](0001-arena-baseline-architecture.md) — Baseline architecture: Rust
  control-plane backend, per-game `Protocol`. _(§1 self-play hot path retired —
  genuine two-party play is the only model.)_
- [0002](0002-backend-client-api-contract.md) — Backend ↔ client REST/SSE
  contract: sessions, heartbeat, settle, live stats. _(Settle-auth portion
  superseded by 0007.)_
- [0003](0003-battleship-on-sui-tunnel.md) — Battleship on the tunnel:
  commit-reveal fairness with public-only protocol state.
- [0005](0005-redis-backed-ha-control-plane.md) — HA control plane on Redis only
  (cache + pubsub clusters, no Postgres); delivery partitioned by instance;
  address-balance gas for concurrent settle.
- [0007](0007-settle-authorized-by-settlement-not-token.md) — Settlement is
  self-authenticating; `/settle` verifies the co-signed bytes against the tunnel's
  on-chain party pubkeys and drops the session bearer token. Supersedes the
  settle-auth portion of 0002.
- [0008](0008-quantum-poker-protocol-zk.md) — Quantum Poker: protocol-first
  tunnel model, per-slot asymmetric commit-reveal, n-deck/burn/Five-of-a-Kind
  rules, and optional ZK dispute adapter.
- [0009](0009-data-plane-local-control-plane-redis.md) — Partition by ownership:
  single-owned per-move state (relay, counters, routing cache) in-process; shared
  state (matchmaking, presence, match record, checkpoints, stats) on atomic Redis.
  Refines 0005; demotes its per-frame `SPUBLISH` to a fallback.
- [0010](0010-mp-resume-protocol.md) — MP resume: atomic `ConnRef` rebind,
  event-driven peer-cache eviction, peer-to-peer state reconciliation; on-chain
  settlement is the floor. Affinity/re-homing deferred to ADR-0011.
- [0011](0011-local-first-pairing.md) — Local-first pairing: bounded-hold
  matchmaking (same-instance preferred, ≤750 ms hold before cross-instance
  fallback) plus a reconnect affinity cookie for co-location.
- [0012](0012-arena-attract-cabinet-seam.md) — Arena attract mode: one shared
  cabinet shell (`GameCabinet` + `CabinetController`) owns hover → pause →
  take-over; auto-play is a config (the kit is the brain); take-over is cosmetic
  on-chain today (real ephemeral-key you-vs-bot deferred). Applies to every arena
  game (all share the auto-loop + take-a-seat shape); ttt is the reference.
- [0013](0013-address-balance-stake.md) — Fund the stake from the player's SIP-58
  address balance (`coin::redeem_funds`/`tx.withdrawal`) instead of a version-pinned
  `Coin<T>`, so concurrent reload opens stop equivocating. Sponsor allowlist gains
  `redeem_funds`/`send_funds` + a mandatory `WithdrawFrom::Sender` input guard
  (anti settler-drain). Behind `VITE_MTPS_ADDRESS_BALANCE`; no Move redeploy.
- [0014](0014-sponsor-create-and-fund-gas.md) — Backend sponsors gas (only) for
  the user's open/fund tx via SIP-58 address balance; the user's stake stays
  user-owned. Enables 0-SUI zkLogin onboarding.
- [0015](0015-deterministic-seed-vs-commit-reveal.md) — Derive randomness from a
  deterministic `tunnelId` seed for public symmetric fields (blackjack, bomb-it,
  chicken-cross); reserve commit-reveal for hidden-state games.
- [0016](0016-mtps-stake-token.md) — Free faucet-minted MTPS token for stakes
  (not SUI), auto-minted before stake; gas still sponsored in SUI. (Token renamed
  DOPAMINT → MTPS.)
- [0017](0017-multi-game-self-play-per-game-seed.md) — Multi-game wrappers with a
  synthetic per-game seed (`` `${tunnelId}:g${gamesPlayed}` ``) for bomb-it &
  chicken-cross, mirroring battleship's many-games-per-tunnel shape.
