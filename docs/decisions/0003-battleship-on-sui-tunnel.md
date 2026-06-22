# 0003 — Battleship on the Sui tunnel: commit-reveal, public-only state

- **Status**: Accepted
- **Date**: 2026-06-18

## Context

Battleship is the first arena game with **hidden information**: each player's
fleet must stay secret until a hit is revealed. TicTacToe (the PvP template) is
fully observable — both clients hold the same board and hash it identically for
the co-sign. Battleship cannot: if the co-signed state hash covered the secret
boards, each client would need the *opponent's* fleet to compute it, defeating
the secrecy. We also will not edit the upstream SDK (`sui-tunnel-ts/`), so a new
protocol lives frontend-side and reuses the generic engine.

Three forces: (1) the off-chain engine co-signs `blake2b256(encodeState(state))`
every move and both parties MUST agree on those bytes; (2) ship placement is
private and a malicious peer must not be able to lie about a hit or field an
illegal fleet undetected; (3) we want a demoable vs-bot mode and real PvP from
the *same* protocol.

## Decision

**Protocol state is public-only.** `BattleshipState` holds only what both parties
can agree on: each side's 32-byte board **commitment** (a Merkle root), the shot
history with revealed hit/miss results, hit counters, turn/phase, balances.
`encodeState` hashes only these public fields, so two PvP clients holding
*different* secret boards still produce identical co-sign bytes. Secret boards
(ships + per-cell salts) live in the session driver/hook, never in protocol state.

**Fairness via commit-reveal (Tier 1, no ZK, no per-game Move module).** At
placement each side commits a Merkle root over its 100 cells (leaf =
`blake2b256(cell ‖ isShip ‖ salt)`). Each shot is answered by a `reveal` move
carrying `(isShip, salt, merkleProof)`; `applyMove` verifies the proof against
the committer's root and throws on mismatch — so a peer cannot advance state with
a lie. Legal-fleet enforcement (right ships, in-bounds, non-touching) is checked
at settlement when both reveal full boards; a peer who stalls to avoid revealing
is handled by the existing on-chain dispute + timeout-penalty path
(`tunnel.move::raise_dispute` / `force_close_after_timeout`). This mirrors the
framework's `example_rock_paper_scissors.move` commit-reveal precedent.

**Two modes, one protocol.** vs-bot self-play (driver holds both fleets, like
blackjack) and PvP over the relay (`quickMatch("battleship")` + `DistributedTunnel`,
like ticTacToe). The Rust matchmaker keys its queue on an arbitrary game string,
so PvP needs no backend change.

## Consequences

- `Protocol.randomMove` can only produce the secret-free `shoot` move; `commit`
  and `reveal` need fleet secrets the protocol state lacks. Self-play is therefore
  **driver-led** (the hook computes moves from the fleets it holds and calls
  `tunnel.step`), not `randomMove`-led. Battleship is not wired into the SDK's
  bulk simulator.
- A stalling cheater is *penalized*, not *prevented* (timeout path). Illegal
  fleets are caught at end-reveal, not at commit. **Tier 2** (deferred): a Groth16
  legal-placement proof at commit via `zk_verifier.move`, removing the end-reveal
  and enabling on-chain proof replay during disputes.
- Shot history grows in state (bounded ≤100/side), encoded length-prefixed; a
  `rollingDigest` is available if O(1) per-update ever matters.
- Alternatives rejected: a plaintext "trust the reported hit" state (not fair for
  PvP); a bespoke `battleship.move` module (unnecessary — the generic tunnel
  settles balances from the co-signed state hash).
