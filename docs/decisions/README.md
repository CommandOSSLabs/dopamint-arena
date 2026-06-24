# Architecture Decision Records

Short records of non-trivial or contested decisions, written *before* the code
that depends on them. An ADR captures the decision and the reasoning so the
*why* survives after the people involved have moved on.

## Convention

- One file per decision: `NNNN-kebab-case-title.md` (zero-padded, monotonic).
- Copy `0000-template.md` to start.
- Status moves `Proposed → Accepted → (Superseded by NNNN)`. Never delete a
  superseded ADR — mark it and link forward, so the history stays readable.
- Keep it short. An ADR records a decision; it is not a design doc.

## Index

- [0001](0001-arena-baseline-architecture.md) — Baseline architecture: Rust
  control-plane backend, per-game `Protocol`. *(§1 self-play hot path superseded by 0006.)*
- [0002](0002-grid-layout-engine.md) — Owned grid-layout engine over a
  drag-and-drop library (React 19 + shadcn-style ownership).
- [0003](0003-battleship-on-sui-tunnel.md) — Battleship on the tunnel:
  commit-reveal fairness with public-only protocol state.
- [0005](0005-transaction-log-panels.md) — Transaction-log panels: client-local
  move feed + global settlement projection (verifiable proof surface) + settle-at-close
  cadence; generic payments out of scope.
- [0006](0006-genuine-two-party-only-drop-self-play.md) — Genuine two-party play is
  the only model; self-play dropped. Supersedes 0001 §1 and the removed 0004.
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
