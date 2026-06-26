# 0008 — Quantum Poker: protocol-first model, optional ZK dispute adapter

- **Status**: Accepted
- **Date**: 2026-06-16

## Context

We are adding heads-up **Quantum Poker** on top of the Sui Tunnel framework.
ADR 0001 sets the architecture: one generic `sui_tunnel` Move package plus
per-game TS `Protocol` implementations. The game hot path must therefore run
through `QuantumPokerProtocol` and `OffchainTunnel`, not through a
game-specific Move tunnel.

Quantum Poker differs from normal Hold'em in its card model, and the existing
`protocol/quantumPoker.ts` does not implement it. Concretely we must decide:

1. How cards are dealt without a dealer **and** with per-card privacy that
   survives until showdown (the current code reveals both global seed shares
   before betting, so either party can open the other's hole-card commitments —
   privacy is broken).
2. The card model: `n` independent virtual 52-card decks (one per card slot),
   hidden cards may duplicate, board cards unique among themselves, a board card
   that matches a hidden card **burns** that hidden card, and **Five of a Kind**
   is legal and ranks above a straight flush.
3. Whether a zero-knowledge proof path is required for the playable milestone,
   and how to keep it compatible with Sui's Groth16 verifier if we add it later.

The hot path is `Protocol.applyMove` → `OffchainTunnel.step`: each poker move
becomes an off-chain co-signed `state_update`. The chain only does
open / deposit / cooperative close / generic dispute. A poker-specific
Move/ZK adapter is optional and dispute-only.

## Decision

### Card model & per-slot asymmetric commit-reveal

Nine card **slots**, each its own independent virtual deck:
`0,1` = A holes, `2,3` = B holes, `4,5,6` = flop, `7` = turn, `8` = river.

At `commit`, **each** party commits (blake2b, length-prefixed — the existing
`core/commitment.ts` primitive, byte-identical to `randomness.move`) to one
`(share, salt)` per slot. Only the 18 commitments enter shared/signed state; no
secret is sent. Each slot's deck seed is
`combineReveals(shareA_i, saltA_i, shareB_i, saltB_i)` — unbiased because both
sides commit before any reveal.

Privacy comes from **asymmetric reveal**: a slot's seed needs _both_ shares, so
revealing one share is useless alone.

- `open_private_holes`: B reveals its shares for slots `0,1`; A reveals its
  shares for slots `2,3`. Now A (holding its own hidden `0,1` shares) can derive
  A's holes; B can derive B's holes; neither can derive the other's (missing the
  opponent's hidden share).
- Board reveals (`reveal_flop/turn/river`): **both** sides reveal, so the board
  is public.
- `showdown`: each side reveals its remaining hidden hole shares; the opponent
  re-derives and verifies against the original commitment. Withholding the
  reveal = forfeit (see non-reveal below).

A card is derived by: build `[0..51]`, Fisher-Yates shuffle (the verifiable
`core/randomness.ts` shuffle, byte-identical to Move) under the slot seed, take
`deck[0]`. **Board** slots must be unique among the board; on collision we
re-derive with an incremented counter (`blake2b(slotSeed || u64be(k))`) until
unique. **Hidden** slots never retry (duplicates allowed). A hidden card equal
to any board card is **burned** and ignored at evaluation.

### Hand evaluator

Best five from each player's (un-burned holes ∪ board), `C(n,5)` with `n ≤ 7`.
The 5-card scorer is **duplicate-aware** (the old one rejected duplicates, which
is incompatible with the n-deck model) and adds **Five of a Kind** (five cards
of one rank) as the top category, above straight flush.

### Tunnel integration

Quantum Poker follows the SDK protocol model:

- `QuantumPokerProtocol` owns rule validation, card derivation, betting, fold,
  showdown, and balance calculation.
- `OffchainTunnel` owns state hashing, nonce replay protection, dual signatures,
  and settlement artifacts.
- The playable path does **not** submit each poker action on-chain. It signs many
  off-chain state updates and submits one cooperative close at the end, optionally
  with a transcript root.

This is the opposite of the old Blackjack POC pattern (`black_jack::tunnel` and
a game-specific manager contract). Blackjack is useful as product/UI reference,
not as the settlement architecture for Quantum Poker.

### ZK: optional dispute layer, derivation proof later

**A single full "result proof" is NOT feasible this milestone**, because card
derivation re-runs blake2b-based Fisher-Yates (seed chaining + rejection
sampling, ~50+ blake2b invocations _per slot_, ×9). blake2b is not
SNARK-friendly; proving it in Groth16 is enormous and would force the whole
randomness layer onto a SNARK hash (Poseidon), breaking byte-parity with
`randomness.move`.

So ZK is **not required** for the playable protocol milestone:

- **MVP:** the dealerless-fairness + no-substitution
  guarantee is already trustless _without_ ZK — both parties derive identical
  cards from committed shares, and any lie fails the cheap blake2b commitment
  check. Happy-path settlement needs only the latest dual-signed tunnel state.
- **Optional dispute adapter:** if a party withholds a final signature after
  enough evidence exists, a poker-specific verifier can resolve a disputed
  tunnel. The result-circuit spec, public-input encoding, prover interface, and
  `Unavailable*` prover are scaffolding for that adapter, not hot-path gameplay.
- **Later derivation privacy:** a derivation proof (Poseidon-committed shares)
  can be added behind the same public-input schema without changing the Move
  surface.

The Move verifier path is the **real** native `sui::groth16` (via
`zk_verifier::verify_circuit_proof`), never a mock. As in the framework's own
`zk_verifier_tests.move`, an end-to-end _passing_ proof needs the trusted-setup
artifacts and is a deploy-time integration test; in-repo tests cover binding,
schema, gating order, and settlement math up to and including the native call.

### Public-input schema (8 scalars, all `< r`)

A blake2b digest (256 bits) can exceed the BN254 scalar field modulus
`r` (`2^253 < r < 2^254`), which makes `public_proof_inputs_from_bytes` reject
it. Every hash-derived public input is therefore **field-safe**: clear the top 3
bits of the most-significant (little-endian byte 31) so the value is `< 2^253 < r`.
This `fieldSafeScalar` is defined once in TS (`zk/scalars.ts`) and mirrored in
the referee module (app code — we do **not** edit upstream `zk_verifier.move`).

Canonical order (index → name → encoding):

| #   | scalar            | encoding                                 |
| --- | ----------------- | ---------------------------------------- |
| 0   | `rules_hash`      | fieldSafe(blake2b256(rules descriptor))  |
| 1   | `tunnel_id_hash`  | fieldSafe(blake2b256(tunnel id bytes))   |
| 2   | `state_hash`      | fieldSafe(tunnel disputed `state_hash`)  |
| 3   | `hand_id`         | u64 little-endian, zero-padded           |
| 4   | `winner`          | u64 LE (0 = A, 1 = B, 2 = tie)           |
| 5   | `party_a_balance` | u64 LE                                   |
| 6   | `party_b_balance` | u64 LE                                   |
| 7   | `result_hash`     | fieldSafe(blake2b256(result descriptor)) |

`input_schema_hash = blake2b256(canonical layout descriptor)` can be stored on
the optional circuit/session and checked on dispute settlement. The **minimal sound
subset** for the first _compiled_ circuit is `{rules_hash, tunnel_id_hash,
state_hash, party_a_balance, party_b_balance}` (5 scalars) — `winner`,
`hand_id`, and `result_hash` are bindings/auditing and can be dropped to leave
headroom. The wire format pins all 8 so it is forward-compatible.

### Optional proof-gated resolver surface

The playable milestone should not depend on a poker-specific Move contract. If
we ship the optional ZK dispute adapter, the smallest safe surface is **one**
package-private function in `tunnel.move`:

```move
public(package) fun resolve_dispute_verified<T>(
    tunnel: &mut Tunnel<T>, party_a_balance: u64, party_b_balance: u64,
    clock: &Clock, ctx: &mut TxContext,
)
```

It settles a `DISPUTED` tunnel exactly like `resolve_dispute_external` but with
**no referee/address check** — the gate is Move package visibility. The intended
in-package caller is `quantum_poker_referee::resolve_with_proof`, which (1) binds the
`PokerSession` to the tunnel, (2) checks `rules_hash`, (3) builds the public
inputs in the schema above, (4) calls the real `zk_verifier::verify_circuit_proof`
against the session's circuit, and only on `true` calls
`resolve_dispute_verified`. No human/address referee can reach the settlement
surface, so settlement cannot bypass the proof.

We deliberately do **not** reuse `set_referee`/`resolve_dispute_external` for
poker: those trust an address that could settle any split without a proof.

## Consequences

- **Easier**: real per-card privacy that survives to showdown; an n-deck model
  with duplicates, burns, and Five of a Kind; gameplay that uses the same
  `Protocol + OffchainTunnel` path as the rest of the arena; a forward-compatible
  public-input wire format for later disputes.
- **Harder / committed to**: card derivation uses blake2b, so a _derivation_ ZK
  proof later needs a Poseidon-committed parallel path (documented, not built).
  The result circuit's compiled artifacts + trusted setup are a deploy step;
  until then the prover is `Unavailable*` and the happy-path proof test is
  deploy-time.
- **Move footprint**: none is required for playable Quantum Poker beyond the
  generic tunnel open/deposit/close/dispute functions. Any `quantum_poker.move`
  / `quantum_poker_referee.move` code is optional dispute infrastructure and
  should not block frontend/runtime delivery.
- **Explicitly not done**: proving the blake2b shuffle in-circuit; a trusted
  human referee for poker; escrowing per-street bets (bets are tracked, only the
  matched amount moves at resolution, so balances always sum to the locked
  total).
