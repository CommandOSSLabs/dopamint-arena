# 0010 — MTPS free-faucet stake token (SUI-free stakes)

- **Status**: Accepted
- **Date**: 2026-06-22
- **Renamed**: 2026-06-24 — the token was renamed **DOPAMINT → MTPS** (ticker + on-chain
  symbol/name) and a fresh package was published to testnet. The decision below is unchanged;
  only the name, package, and identifiers were updated. (ADR number stays 0010.)
- **Builds on**: [ADR-0009](0009-sponsor-create-and-fund-gas.md) (gas sponsorship). The faucet and
  the open/fund are both gas-sponsored, so a player needs no SUI at all.

## Context

After gas sponsorship (ADR-0009) the settler pays a game's gas in SUI, but the **stake** still came
from the player's own `Coin<SUI>` — so a fresh 0-SUI account (e.g. a Google zkLogin login) still
couldn't play. We want a fully free experience: no SUI, no funding step, nothing in the UI.

The tunnel framework is generic over the coin `T` (`create<T>`, `deposit<T>`, `close<T>`), and
quantum-poker already stakes a custom coin (`test_buck`) into tunnels — so a non-SUI stake token
needs no tunnel change, and the ADR-0009 "stake from a user coin" path is exactly what it needs.

## Decision

**Games stake MTPS — a free, faucet-minted token — instead of SUI; gas stays sponsored in SUI.**

1. **MTPS coin + faucet** (new Move package `mtps/`, modeled on `test_buck`):
   `coin::create_currency` + a shared `MtpsFaucet` holding the `TreasuryCap`, with a public
   `mint(faucet, amount, recipient)`. The faucet **mints new supply on demand** — it never draws
   from a reserve, so it can't run out (bounded only by the u64 supply ceiling).
2. **Backend** pins `TUNNEL_COIN_TYPE` to the MTPS coin type (sponsor type-check + close payout
   in MTPS) and allowlists `<pkg>::mtps::mint` so the faucet tx is itself gas-sponsored.
   The settler holds only SUI (for gas); it needs no MTPS.
3. **Frontend** stakes `Coin<MTPS>` (coinType threaded through the open/fund builders) and
   **auto-faucets invisibly**: before staking, if the player's MTPS balance is short, one
   gas-sponsored `mint` tops them up. No balance, no faucet button — nothing in the UI.
4. **Battleship first** (PvP + bot). Other games keep SUI until wired. Gated on the MTPS env:
   unset → the ADR-0009 SUI sponsored path (with sender-pays fallback) still applies.

## Consequences

- **Truly free play.** A 0-SUI + 0-MTPS player: connect → the faucet mints MTPS (sponsored)
  → open/fund stakes MTPS (sponsored) → play. No funding, no SUI, no UI surface.
- **MTPS can't run out** (mint-on-demand), so the only finite resource is the settler's **SUI
  for gas** — which still drains under load. Rate limiting + a spend budget remain a follow-up
  (deliberately skipped for now); monitor/refill the settler's SUI.
- **One coin type per backend.** `TUNNEL_COIN_TYPE` is global, so all *sponsored* games must use
  MTPS; SUI-sponsored games would fail the type pin. Non-sponsored (sender-pays) games are
  unaffected. The MTPS stake path is env-gated so the SUI path still works where MTPS is unset.
- **Not doing.** An MTPS balance/UI; rate limiting; non-battleship games (follow-ups); a capped
  or rate-limited faucet (the demo faucet is intentionally unlimited).
