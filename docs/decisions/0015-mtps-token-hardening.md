# 0015 — MTPS token hardening (admin-only mint, coin_registry)

- **Status**: Accepted
- **Date**: 2026-06-26
- **Builds on**: [ADR-0010](0010-mtps-stake-token.md) (the MTPS free-faucet stake token). This
  hardens that token for a public, mainnet-bound demo.

## Context

ADR-0010 shipped MTPS as a near-verbatim copy of an upstream permissionless test-coin fixture: a
shared faucet holding the `TreasuryCap` with a fully permissionless `mint(amount)`, a permissionless
`set_can_mint` kill switch, the deprecated `coin::create_currency`, and no burn. A contract review
flagged this as a griefing/brick risk in a public demo: an unbounded permissionless mint can be
driven to the u64 ceiling and brick the faucet; the kill switch is troll-accessible; the currency
standard is deprecated; and a free-form `MtpsNFT` was bundled into the coin contract.

We considered keeping a bounded public mint (a supply cap + per-call cap), but settled on a simpler,
stronger answer: **the backend faucets each player the exact amount they need.** With no public
mint at all, there is no abuse vector and no brick risk, so the cap/kill-switch machinery becomes
unnecessary.

## Decision

**Minting is AdminCap-only; the backend custodies the cap and faucets players off-chain.**
(Scope of *this* change is contract-only — the backend faucet endpoint and the frontend rewiring
are follow-ups.)

1. **No permissionless mint.** `AdminCap` wraps the `TreasuryCap`; `admin_mint(cap, amount,
   recipient)` is the only mint path, and `burn(cap, coin)` the only burn. No shared faucet, no
   supply cap, no per-call cap, no `can_mint` kill switch — the sole authority is who holds the
   cap. (Stricter than the review required, which only asked to gate the open mint.)
2. **`coin_registry` migration** (`new_currency_with_otw` + `finalize_and_delete_metadata_cap`,
   then a one-time post-publish `finalize_registration`), dropping the deprecated
   `coin::create_currency`.
3. **NFT dropped from the coin contract.** The `MtpsNFT` is removed entirely, leaving a
   single-purpose coin package. If a collectible is needed later it ships as its own standalone
   package — it does not belong in the token contract.

## Consequences

- **Easier**: the u64 brick and mint abuse are structurally impossible (no public mint); metadata
  uses the current standard; the coin contract is single-purpose.
- **Committed / harder**: the backend must custody the `AdminCap` key and pay gas for faucet txs.
- **Follow-ups (NOT in this change)**: the backend HTTP faucet endpoint (mints via `admin_mint`,
  rate-limited per address); the frontend swap from the sponsored in-line `mtps::mint` PTB to that
  endpoint; dropping the sponsor's `mtps::mint`/`mint_default` allowlist; and the redeploy + env id
  updates (`VITE_MTPS_*`, `TUNNEL_COIN_TYPE`). Until those land, MTPS stays on the ADR-0010 public
  faucet package.
- **Explicitly NOT done**: a per-call mint cap and a hard supply cap (unnecessary once minting is
  admin-only); changing `DECIMALS` (frontend hardcodes 9).
