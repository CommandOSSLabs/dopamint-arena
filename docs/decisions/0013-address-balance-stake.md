# 0013 — Stake from the player's SIP-58 address balance

- **Status**: Proposed
- **Date**: 2026-06-24

## Context

Sponsored open/fund (ADR-0014) pays gas from the settler's **SIP-58
address-balance** (empty `gas_payment.objects` + `ValidDuring` nonce), so
concurrent sponsored closes/opens never equivocate on a gas coin. The **stake**,
however, still comes from a user-owned `Coin<T>` object: the open PTB does
`tx.object(stakeCoinId)` → `splitCoins`. Building pins that coin's _version_.

When several games auto-open on a page reload, they all fund their stake from the
**same** user coin at the **same** version. One commits (bumping the version),
the rest are rejected non-retriably:

> Transaction needs to be rebuilt because object `0x…` version `0x…` is
> unavailable for consumption, current version `0x…`

i.e. owned-object equivocation — the same failure SIP-58 already removes for gas.
A retry-with-rebuild (re-resolving the coin's current version every 5 s) was
added as the immediate unblock, but it only _serializes_ the contention: one open
succeeds per round, so N games take ~N rounds to all open.

The framework deployed under DOPAMINT supports SIP-58 (`0x2::coin::send_funds` /
`redeem_funds`, `funds_accumulator`), and `@mysten/sui` 2.18 already exposes
`tx.withdrawal({ amount, type })` — so no SDK bump and no `tunnel.move` change is
needed (its `create_and_fund`/`deposit` already take `Coin<T>`).

## Decision

We fund the stake from the **player's address balance** instead of a coin object,
on the sponsored path:

- **Open** builds the stake coin as
  `coin::redeem_funds<T>(tx.withdrawal({ amount, type: T }))` (source =
  `WithdrawFrom::Sender`) and passes it as the SDK `sourceCoin` — no
  `tx.object(coin)`, so nothing version-pinned. Concurrent opens each draw their
  own reservation from the one balance; they do not equivocate (replay guard is
  the per-tx `ValidDuring` nonce the settler already sets).
- **Funding** keeps the player's DOPAMINT _address balance_ above a threshold via
  the background top-up: faucet-mint a coin (`dopamint::mint`, unchanged) then
  sweep it into the address balance with `coin::send_funds(coin, sender)`. Both
  are serialized off the hot path, so their coin-object use never contends with
  game opens. The DOPAMINT package is **not** redeployed.
- **Sponsor allowlist** (the security boundary) grows by exactly the calls above
  and a new input check. `validate_sponsorable` must now:
  1. allow framework move calls `0x2::coin::redeem_funds<T>` and
     `0x2::coin::send_funds<T>` for the configured `T`;
  2. **reject any `FundsWithdrawal` input whose source is not
     `WithdrawFrom::Sender`.** A sponsored PTB that withdrew from
     `Sponsor` (the gas owner) would drain the _settler's_ address balance —
     an H1-class settler-drain, the address-balance analogue of the existing
     `Argument::Gas` guard. The user may only withdraw their **own** funds.

The cutover is gated behind `VITE_MTPS_ADDRESS_BALANCE` (default off): with it
unset, every game keeps the coin-object stake path verbatim. The retry from the
unblock stays as a belt-and-suspenders safety net regardless.

## Consequences

- **Easier**: concurrent opens stop equivocating at the source — all games open
  in parallel on reload, not one-per-retry-round. The stake joins gas on the
  contention-free SIP-58 path; the retry becomes a rare fallback, not the norm.
- **Harder / committed to**: the sponsor allowlist is now security-load-bearing
  for fund _withdrawals_, not just move calls — the `WithdrawFrom::Sender` check
  is mandatory and unit-tested. Funding has an extra invariant (keep the
  _address balance_ topped up, not the coin balance); reads use the SIP-58
  `fundsInAddressBalance`/`addressBalance` field.
- **Scope**: cutover is behind a flag and verified on testnet (the open path
  can't be exercised locally). Games adopt it one call site at a time
  (battleship first); SUI-fallback (sender-pays, single wallet tx — not
  reload-concurrent) keeps the coin-object stake. We explicitly do **not**
  redeploy `dopamint.move` (the TS `send_funds` sweep avoids a `mint_to_balance`
  function) and do **not** change `tunnel.move`.
