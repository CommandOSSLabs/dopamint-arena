# 0001 — Arena baseline: control-plane backend, client self-play, per-game protocols

- **Status**: Accepted
- **Date**: 2026-06-16
- **Refs**: DOP-168 (milestone), DOP-170 (tunnel backend), DOP-181 (client
  runtime), DOP-173 (catalog), DOP-174–180 (game clients), DOP-169 (infra)

## Context

The July-4 demo (DOP-168) is a single page: connect wallet → pick a game →
agents play it at max throughput through Sui Tunnels, with a live TPS panel.
The 1M+ TPS is **off-chain effective TPS**: only tunnel open/close and final
settlement hit the chain; every in-game move is an off-chain co-signed state
update. The model is a **2-party tunnel**, and a user runs **multiple agents
with ephemeral keys competing against each other** — no wallet popups mid-game.

`sui-tunnel-ts/core/tunnel.ts` is explicit: the per-update hot path is an
in-memory engine where the process **holding both keypairs co-signs and
verifies each transition locally** (`OffchainTunnel.selfPlay`). Throughput
comes from running _many_ tunnels, not from a server mediating each move.

## Decision

Three planes, with clear ownership of the throughput-critical path:

1. **Per-update hot path = client-side self-play.** Both parties are the **same
   user's** ephemeral keys; the TS agent runtime (DOP-181) holds both keypairs and
   co-signs+verifies every move on the `sui-tunnel-ts` engine. The user funds both
   stakes (win/loss is self-vs-self — purely generating signed volume). **No
   server is in the per-update loop and no server is a counterparty** — that is
   what lets it scale to 1M effective TPS.

2. **Control plane = Rust tunnel backend (DOP-170)** — the demo's
   _measure / prove / display_ spine, **never on the per-move path**. Greenfield
   axum over the Sui Rust SDK. Jobs: (a) **tunnel registry/assignment** by
   indexing on-chain `TunnelCreated`/`Activated`/`Closed` events (opens are the
   user's wallet PTB; the backend observes them); (b) **settlement + proof** —
   takes the client's final co-signed settlement + transcript, submits
   `close_cooperative_with_root` (no sender gate, so a non-party can), and
   archives the transcript to Walrus, anchoring its root on-chain; (c)
   **real-time stats** — aggregates per-client off-chain action rates into the
   global TPS / active-tunnel figures the catalog panel shows (irreducibly
   server-side); (d) **observability** for the live event. It does **not** sign
   moves, mediate gameplay, hold a bankroll, or act as counterparty.

3. **Per-game integration = the SDK `Protocol` interface.** Each game
   (DOP-174–180) supplies only domain logic (`initialState`, `applyMove`,
   `encodeState`, `balances`, `isTerminal`); the framework provides signing,
   settlement, and replay protection. The shared client runtime (DOP-181)
   writes key-gen + tunnel-client + action-loop once for all games.

4. **One generic `sui_tunnel` Move package + per-game TS protocols** — _not_
   per-game Move tunnel modules (the `black_jack::tunnel` reference pattern).
   This preserves the cross-language golden parity and "written once, not seven
   times."

## Open questions

- **Funding the opens.** Ephemeral keys are generated fresh client-side — they
  hold no SUI for gas and no stake to lock, yet the on-chain open/lock + settle
  must be paid for. The page is popup-free, so the funding source is TBD.
  Code constraint (`tunnel.move`): `create`/`create_and_share` take parties as
  params with **no sender check** (a wallet PTB can batch-open N tunnels for
  ephemeral parties), but `deposit_party_a/b` **assert `sender == party`** and
  activation needs **both** deposits — so a single wallet PTB can _open_ but
  **cannot fund** tunnels whose parties are the ephemeral keys. Resolutions:
  (A) add a `create_and_fund` entry to the fork that credits both deposits from
  the sender's coins (one wallet PTB opens+funds+activates N tunnels; off-chain
  wire format untouched), or (B) PTB funds the ephemeral keys then they
  auto-deposit client-side (no Move change, 2N extra txs), or (C) backend
  sponsorship. Settlement needs no sender (just both co-sigs), so the backend
  can batch-submit closes + Walrus archival with no popup. Leaning (A).
- **Backend↔client API contract.** On the critical path — the 7 game clients
  block on the session-register / stats-heartbeat / settle-and-archive API shape.
  Being defined now (control-plane only; the per-move loop is client-local).
- **Cloud.** AWS+Pulumi (DOP-169/172) vs GCP/Railway (raised in the milestone
  brief) is unresolved; POC owned by Max. Not on the dev critical path.

## Consequences

- The backend's scope is **lifecycle + observability**, not gameplay
  mediation — so it stays off the throughput-critical path while remaining the
  central service.
- The arena now needs **Rust tooling** (Cargo workspace, rustfmt/clippy) and a
  **multi-process local dev-env** (backend + agents + catalog) — this pulls the
  previously-deferred dev-env/scaffolding batch forward (a follow-up ADR records
  its shape when the backend service lands).
- Reuse from the old Dopamint platform is limited: the backend is largely
  greenfield over the Sui Rust SDK + a Walrus client + a tunnel registry. The
  old `sessions`/`points`/identity-mesh services are **not** migrated — they
  belong to a different product and are out of DOP-168 scope (wallet connect is
  one-time and client-side; in-game identity is ephemeral keys).
