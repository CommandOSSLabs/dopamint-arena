# 0015 — MTPS token hardening (supply cap, AdminCap, coin_registry, NFT split)

- **Status**: Accepted
- **Date**: 2026-06-25
- **Builds on**: [ADR-0010](0010-mtps-stake-token.md) (the MTPS free-faucet stake token). This
  hardens that token for a public mainnet-bound demo; the stake-from-faucet design is unchanged.

## Context

ADR-0010 shipped MTPS as a near-verbatim copy of quantum-poker's upstream **`test_buck`** _test_
fixture: a shared faucet holding the `TreasuryCap` with a fully permissionless `mint(amount)`, a
permissionless `set_can_mint` kill switch, the deprecated `coin::create_currency`, and no burn. A
review (yannis) flagged that this is fine for a benchmark fixture but a griefing/brick risk in a
public demo:

- **Unbounded permissionless mint + no burn.** `coin::mint` aborts at the u64 supply ceiling, so a
  single `mint(u64::max)` call bricks the faucet — every later mint aborts forever.
- **`set_can_mint` callable by anyone** — a free kill switch for trolls.
- **Deprecated currency standard** (`coin::create_currency`).
- An unrelated, free-form `MtpsNFT` living inside the coin contract.

MTPS has no real value (it's a free stake token) and 0-SUI players must keep faucet-ing it through
the gas sponsor, which allowlists `<pkg>::mtps::mint`/`mint_default` — so the public faucet has to
stay callable, and minting must stay generous enough that a player can always get enough to play.

## Decision

**Keep public minting open and un-throttled per call, but bound all minting by a hard
`MAX_SUPPLY`, and move privileged controls behind an owned `AdminCap`.** (Scope: on-chain only —
no backend change; `mint`/`mint_default` keep their exact signatures and the sponsor allowlist is
untouched.)

1. **Supply cap, not a per-call throttle.** `mint`/`mint_default` stay permissionless and accept
   any amount, but every mint asserts `amount <= MAX_SUPPLY - minted`. `MAX_SUPPLY` = 10B MTPS
   (10^19 raw) — ~54% of `u64::max`, so supply can never reach the ceiling and brick the coin,
   while still allowing ~10^6 default pulls. A per-call cap was rejected: it would throttle real
   play, and the total cap alone already defeats the `u64::max` brick (that call now just aborts).
2. **AdminCap (owned, to the deployer)** gates `set_can_mint` (the kill switch) and `admin_mint` —
   an admin top-up that mints even while the public faucet is paused, still bounded by `MAX_SUPPLY`.
3. **`burn`** (permissionless) destroys a coin and credits its value back against the cap, so live
   supply can recede.
4. **Migrate to `sui::coin_registry`** (`new_currency_with_otw` + `finalize_and_delete_metadata_cap`),
   dropping the deprecated `coin::create_currency` and the `deprecated_usage` allow.
5. **Split the NFT into its own `mtps_nft` package.** Minting stays permissionless (a mini-game can
   let players mint directly) but validates non-empty title/image and bounds field lengths.

A fresh package is published to testnet (new package id, faucet id, AdminCap id); the
`VITE_MTPS_*` (frontend) and `TUNNEL_COIN_TYPE` (backend) ids are updated to point at it.

## Consequences

- **Easier**: the `u64::max` brick is structurally impossible; the kill switch and large mints are
  no longer abusable; metadata uses the current standard; the coin contract is single-purpose.
- **Harder / committed**: the deployer must custody the AdminCap key (for `set_can_mint` /
  `admin_mint`); a redeploy rotates every id, so env/`Published.toml` must move together. The OTW
  `coin_registry` flow needs a one-time post-publish `finalize_registration` (the faucet works
  before it runs).
- **Explicitly NOT done**: moving the faucet fully off-chain to an admin HTTP endpoint (a larger
  backend+frontend change — deferred); a per-call mint cap (rejected, see above); changing
  `DECIMALS` (frontend hardcodes 9).
