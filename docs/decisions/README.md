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
- [0009](0009-super-auto-pets-on-tunnel.md) — Super Auto Pets on the tunnel:
  deterministic trigger-event battle, commit-reveal hidden teams + fair shop,
  session-channel settlement, phased de-scope.
- [0010](0010-pixel-duel.md) — Pixel Duel: battleship-monochrome paint duel on the
  two-party tunnel. Strictly 2-party tunnel (no N-of-N core fork; N-painter "Paint
  Wall" only by composing 2-party tunnels, deferred); simultaneous secret-template
  duel with a public-only paint/own/lock mechanic (borrowed from
  `pixel_paint.war.v1`) + commit-reveal scoring terminal; monochrome/cooldown/
  memorize are self-imposed client-side; settles on the generic tunnel (no new
  Move module). Builds on 0006.
