# Backend architecture decisions

ADRs for decisions **internal to the backend** — those that don't cross into the
frontend, on-chain Move, or the protocol/SDK contract. System-wide decisions
(anything spanning those boundaries) stay in the root
[`docs/decisions/`](../../../docs/decisions/).

Numbering is **shared** with the root sequence (a number is unique repo-wide and
never reused), so an `ADR-00NN` reference in code resolves regardless of which
folder the record lives in. See the root
[README](../../../docs/decisions/README.md) for the full convention and template.

## Index

- [0020](0020-bot-fleet-topology-shared-core.md) — Two bot fleets over one
  sans-IO core: a user-serving fleet (async/tokio, real PvP counterparty) and a
  local self-competing bench fleet (sync/rayon), differing only in seam
  implementations and runtime. Supersedes ADR-0001's self-play hot path.
- [0027](0027-serving-fleet-topology-wsclient-then-colocated.md) — Serving-fleet
  topology: WS-client for the demo → co-located game-server at 5000 CCU; the
  `RelayTransport` seam is the swap point (capacity win, latency user-invisible).
- [0029](0029-async-queued-batched-settlement.md) — `/settle` becomes
  asynchronous: validate → durable Redis stream → 202; a worker pool coalesces up
  to K `close_cooperative_with_root` calls into one PTB (retry-by-split), behind a
  governed AIMD+backoff RPC layer; confirmation via the `explorer:proofs` event.
  Stays on the public fullnode, living under its ceiling by raising S. Scales the
  0020 provenance layer; batches settles the way 0019 batches opens.
