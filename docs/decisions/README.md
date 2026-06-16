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
  control-plane backend, client self-play hot path, per-game `Protocol`.
