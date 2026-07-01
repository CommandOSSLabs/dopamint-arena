# 0021 — Adopt sans-IO: a synchronous protocol core, async only at the edges

- **Status**: Proposed
- **Date**: 2026-06-27
- **Refs**: required by [0020](../../backend/docs/decisions/0020-bot-fleet-topology-shared-core.md); relates to [0017](0017-deterministic-seed-vs-commit-reveal.md)

## Context

We are reimplementing the tunnel harness from scratch, so the protocol seam's
shape is an open architectural choice rather than a migration. The prior design
made the protocol transition (`apply_move`, `initial_state`) async, which
conflates two unlike operations: **deciding** a move — which can be genuinely
IO-bound (an API, an LLM, an oracle) — and **applying** one, which validates and
advances state.

A state channel constrains the second hard: the transition must be deterministic
and replayable, because both seats _and_ the on-chain referee recompute it
byte-for-byte to co-sign and to adjudicate disputes, and it must mirror the
on-chain Move `apply`, which has no async. So IO inside a transition is a
correctness hazard, not flexibility. At the same time, we don't want to
over-correct into a dogma that bans async everywhere — some _actions_ (a strategy
bot consulting a service, a remote-KMS signature, the network transport itself)
are legitimately IO-bound. The decision is where to draw the line, once, so
neither fleet in ADR-0020 has to redraw it.

## Decision

We adopt the **sans-IO** pattern inside the Rust tunnel harness: the protocol
transition and `PartyRuntime` state machine are I/O-free, synchronous, and pure.
IO enters only through explicit harness seams that pump bytes and decisions in.

- **Core is synchronous and pure** — `initial_state`, `apply_move`,
  `encode_state`, `balances`, `is_terminal`, `sample_move` carry no futures, no
  IO, no clock, no RNG of their own. This is the default precisely to avoid the
  over-engineering of speculative async on CPU-bound code.
- **Async is confined to the harness seams where IO is real** —
  `FrameTransport` (transport), `MoveStrategy::plan_move` (may call
  APIs/LLMs/oracles), and `PartyDriver` (the generic loop that awaits those
  seams). The default `Signer::sign` is synchronous (local ed25519); a
  remote-KMS signer is a future async variant of that seam.
- **Future async actions extend at the seam, never the core** — when an action
  needs IO (a move whose value comes from an external service, a managed remote
  key), the IO happens in the MoveStrategy or Signer seam and the _result_ — a
  finished `Move`, a finished signature — is handed to the sync core as plain data.
  Randomness and external inputs follow ADR-0017's seed/commit-reveal model. This
  is the documented escape hatch: we are not closing the door on async, we are
  routing it through the edges.

## Consequences

- The pure runtime is drivable with no executor at all (a bare rayon worker) or
  through the harness `PartyDriver` inside a tokio task — which is what lets
  ADR-0020's bench and serving fleets share one implementation.
- New async requirements are absorbed by the seams without touching the core, so
  the determinism/replay guarantee is structurally protected rather than
  maintained by discipline alone.
- Cross-language golden parity stays honest: a synchronous, pure transition maps
  1:1 onto the Move `apply`.
- We accept that anything needing IO must be expressed as a seam
  (FrameTransport/MoveStrategy/Signer) rather than reached for ad hoc inside
  game logic — the one constraint sans-IO imposes, and the one we want.
