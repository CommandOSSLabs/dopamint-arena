# 0020 — Bot fleets: user-serving and local self-competing over a shared core

- **Status**: Proposed
- **Date**: 2026-06-27
- **Refs**: supersedes the self-play hot path of [0001](0001-arena-baseline-architecture.md); relates to [0011](0011-local-first-pairing.md), [0012](0012-arena-attract-cabinet-seam.md)

## Context

ADR-0001's throughput model was a user running both ephemeral keys against
_themselves_ (`OffchainTunnel.selfPlay`). That hot path is retired: real users
now compete against **our bots**, not themselves. Two deployment shapes fall
out, with different runtime characteristics but identical game logic:

1. **Serving fleet** — bots are the counterparty to real users over the network.
   Genuine two-party PvP: each bot seat talks to a remote user, its move
   decision may consult strategy/an external service, and it co-signs with a
   managed key. The workload is **IO-bound** — many concurrent tunnels mostly
   waiting on the network and on human pace.
2. **Bench/load fleet** — bots vs bots, in-process on our own servers, to prove
   protocol throughput and correctness at scale. No network. The workload is
   **CPU-bound**.

If these two fleets fork the game/state-machine logic, they drift and the bench
stops proving anything about production. The only thing that legitimately
differs between them is the _implementation of the seams_ (transport, policy,
signer) and the concurrency runtime — never the protocol rules.

## Decision

Both fleets drive **one sans-IO protocol core** (the synchronous, pure,
transport-free state machine of ADR-0021). They differ only in:

- **Seam implementations** — Channel (network socket vs in-process), Policy
  (strategy/remote vs local sampler), Signer (managed key vs local ed25519).
- **Concurrency runtime** — the serving fleet uses an **async, tokio-based
  driver** where `await` is justified by real network IO; the bench fleet uses a
  **synchronous rayon runner** where there is no IO and parallelism across
  independent tunnels is the goal.

Async is confined to the edges; the shared core stays synchronous so both
runtimes can drive it.

## Consequences

- Bench numbers are meaningful: the hot-path logic under test is the same code
  that serves users.
- We maintain two thin runtimes (tokio driver, rayon runner) over one core + one
  set of seam traits — the cost of honest benchmarking.
- We commit to never doing IO inside the core; external/oracle/strategy inputs
  enter through the Policy seam as finished move data (consistent with ADR-0017).
- `tools/rustbench`'s forked engine becomes redundant and collapses onto the
  shared core (follow-up, not this ADR).
- We explicitly do **not** put a server on the per-move path for the bench
  fleet, and do **not** keep the ADR-0001 self-vs-self funding model.
- Bot↔user pairing for the serving fleet is **out of scope** here; matchmaking
  stays with ADR-0011.
