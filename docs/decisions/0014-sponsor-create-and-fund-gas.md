# 0014 — Backend sponsors gas (only) for the user's open/fund tx

- **Status**: Accepted
- **Date**: 2026-06-22
- **Refs**: [ADR-0007](0007-settle-authorized-by-settlement-not-token.md) (the
  settler already sponsors the cooperative _close_ via SIP-58 address-balance
  gas), the zkLogin/Enoki Google sign-in (fresh zkLogin accounts hold 0 SUI).

## Context

After zkLogin (Enoki/Google) sign-in, players can connect with a fresh address
that holds 0 SUI. Today only the cooperative **close** is sponsored: the backend
"settler" pays its gas from its own SUI **balance** (SIP-58 address-balance gas —
empty `gas_payment.objects` + a `ValidDuring` expiration, `sui.rs:build_close_tx`).
Every _user-facing_ on-chain tx — opening + funding a tunnel (`tunnel::create_and_share`

- deposit; `create_and_fund` for self-play) — is **sender-pays**: the connected
  wallet pays its own gas (`tunnelTx.ts`, `usePvpTicTacToe.ts:207`), and the arena's
  `sponsorAndExecute` is an explicit stub. So a connected wallet must already hold SUI
  to start a game.

Two facts shape the mechanism:

1. **SIP-58 draws the gas FundsWithdrawal from `gas_payment.owner`, not the sender.**
   So a transaction with `sender = user`, `gas_payment.owner = settler`, empty
   `objects` charges gas to the **settler's balance** — the same plumbing the close
   already uses, with the owner pointed at the sponsor.
2. **The open/fund PTB funds the stake by splitting the gas coin**
   (`createAndFund.ts:94`, `buildDepositFromGas`). With SIP-58 there is no gas coin
   to split, and splitting a _sponsor_ gas coin would make the sponsor pay the stake.
   So gas-only sponsorship requires a PTB whose stake comes from a **user-owned coin**,
   kept separate from gas.

`sui-transaction-builder` v0.3 has no sender≠gas-owner API, but `sui_sdk_types::Transaction`
exposes public `kind`/`sender`/`gas_payment`/`expiration`, so the backend can assemble
the sponsored transaction from a client-supplied transaction _kind_.

## Decision

**We sponsor gas only — never user funds.** The backend gains a two-phase sponsor
endpoint that wraps a client-built `create_and_share`/deposit transaction _kind_ in
SIP-58 address-balance gas owned by the settler, dry-runs it (verify-before-gas, as
`/settle` does), and co-signs it as gas sponsor; the user signs as sender.

1. **Stake stays with the user.** The frontend builds the open/fund PTB so the stake
   is split from a **user-owned `Coin<SUI>`**, not the gas coin — composing the SDK's
   `buildCreateAndShare` + `buildDeposit` (no edit to the vendored SDK's gas-split path).
2. **`POST /v1/sponsor`** (create): body `{ sender, txKindBytes }`. The backend
   **allowlists** the kind (only `<pkg>::tunnel::{create_and_share, create_and_fund,
deposit*}` move calls + the configured coin type) and caps the gas budget, builds
   `Transaction { kind, sender = user, gas_payment { owner = settler, objects = [] },
expiration = ValidDuring }`, dry-runs, signs the sponsor signature, returns
   `{ txBytes, sponsorSig }`.
3. **`POST /v1/sponsor/execute`**: body `{ txBytes, userSig }`. The backend submits
   with `[userSig, sponsorSig]` and returns the digest. Reuses `SuiSettler` sign/execute/
   dry-run.
4. **Always sponsor** open/fund (every wallet, not just zkLogin) via a `sponsoredSignExec`
   that replaces the dapp-kit `signAndExecute` path for the open/fund step. **Battleship
   PvP is the first integration**; the others follow through the shared `tunnelTx.ts`.

## Consequences

- **One funded account, one mechanism.** Gas for both close and open/fund comes from
  the settler's address balance (SIP-58) — no gas-coin pool, no equivocation under
  concurrency. Operationally: keep the settler funded.
- **Anti-abuse is the allowlist + dry-run.** The backend pays gas, so it sponsors _only_
  the allowlisted tunnel move calls within a budget cap, and dry-runs before paying —
  mirroring `/settle`'s verify-before-gas. A new endpoint must not become an open gas faucet.
- **Gas-only is a deliberate limit.** A 0-SUI account still cannot fund the (tiny, e.g.
  500-MIST) stake, so this alone does not make zkLogin accounts fully gasless+stakeless —
  it removes the gas barrier only. Stake sponsorship is **explicitly out of scope** here.
- **Sponsored signing path.** The open/fund step switches from `signAndExecuteTransaction`
  to `signTransaction` (sign the sponsor-built bytes) + backend execute; close keeps its
  own `/settle` sponsor path.
- **Not doing.** (a) Stake sponsorship; (b) sponsoring per-move txs (moves are off-chain
  in the tunnel); (c) editing the vendored SDK's gas-split builder — we compose primitives
  frontend-side instead.
