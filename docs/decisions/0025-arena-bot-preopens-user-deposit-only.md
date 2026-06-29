# 0025 — Arena open: bot pre-creates + funds seat B at allocate; user joins deposit-only

- **Status**: Proposed
- **Date**: 2026-06-29
- **Refs**: **supersedes the open mechanics (steps 2–3) of**
  [0023](0023-arena-enter-one-sig-genuine-two-party.md) — keeps all of its goals
  (one signature, fund-own-seat, user=A/bot=B, bot drives settle) and its other
  steps (warm-pool allocation, genuine auto-play); only **who creates the tunnel**
  changes (user → bot). The on-chain
  create+fund-B is the `SuiAnchor` seam deferred by
  [0020](0020-bot-fleet-topology-shared-core.md); settle stays seat-agnostic per
  [0007](0007-settle-authorized-by-settlement-not-token.md); extends the batched
  open of [0019](0019-batched-tunnel-open.md).

## Context

ADR-0023 fixed the arena flow but, in its mechanics (step 2), had the **user's**
PTB create the tunnel and fund seat A (`buildOpenAndFundSeatA` =
`create_and_share` + `deposit_party_a`), with the bot depositing seat B
**after**, signalled via `/arena/opened`.

Reading `tunnel.move` pins the constraints:

- `deposit_party_a` / `deposit_party_b` each `assert!(sender == that party)` —
  **no party can fund the other's seat**.
- `create_and_fund` (both seats, one sender) is marked **self-play only**.
- `close_cooperative[_with_root]` has **no sender check** — both signatures are
  verified and funds route to the party addresses, so **any** submitter works
  (the settler does, gas-sponsored). Settle is seat-agnostic; the bot drives it
  because it is the always-online party (already 0023 step 4), not because of its
  seat.

So genuine two-party inherently needs **two deposits from two signers, and create
precedes both** → a minimum of two sequential on-chain confirmations before a
tunnel is live. The only freedom is **where the user's wait sits**. ADR-0023 put
it **after** the user signs (user creates+funds-A, then waits for the bot's
seat-B deposit) — the visible "I signed, why am I waiting?" lag.

## Decision

**Move tunnel creation + seat-B funding to the bot, at allocate time; the user's
open PTB becomes deposit-only.**

1. `allocate` reserves a bot and the fleet does `create_and_share(party_a=user,
   party_b=bot)` + `deposit_party_b`, returning the **`tunnelId`**. The user's
   ephemeral pubkey is needed at create time, so the allocate **request carries a
   per-game user ephemeral pubkey** (the FE generates one keypair per game).
2. The user's PTB is then `deposit_party_a × N` only (no create) against the
   returned tunnel ids — **one signature**, and the tunnel goes **Active on that
   signature** (the bot's half already landed).
3. The unavoidable create+fund-B confirmation moves to the **pre-popup
   allocate/loading** phase (maskable by a spinner, parallel across games), not
   after the user signs. Net wall-clock is similar; the wait is hidden in
   "loading…", not in post-signature dead time.

Everything else from 0023 holds: user = seat A, bot = seat B, bot/settler submits
the cooperative close (0007), per-game ephemeral keys co-sign moves + settlement
automatically (no wallet popup beyond the one open).

## Consequences

- **Griefing / DoS — the price of putting the house first.** `allocate` now makes
  the house spend sponsored gas + lock a funded seat **before the user commits
  anything**. An unauthenticated `allocate` loop is a gas/capital DoS on exactly
  the funded-bot pool. **Therefore `allocate` MUST be authenticated (a signature
  proving wallet control) + per-wallet rate-limited before this ships at the
  5000-CCU target.** ADR-0023's user-creates-first ordering ("1b") is structurally
  immune (griefer pays), but loses the instant post-sign feel. **Not yet built —
  recorded here as a hard requirement.**
- **`SuiAnchor` scope grows.** The fleet's on-chain seam now **creates** tunnels
  (naming an arbitrary `party_a = user`) and funds B in the allocate path — not
  just deposit-B + settle as 0020/0023 implied.
- **`allocate` becomes on-chain-bound:** multi-second, partially failing. Games
  whose create fails are **omitted** from the response (same shape as today's
  "omit games with no free bot").
- **Open-batching is a SuiAnchor design question.** Batching N creates+fund-B into
  one house-signed PTB likely needs a **new Move fn** (create + `deposit_party_b`
  + share, single seat) — `create_and_fund` funds both (self-play) and
  `deposit_party_b` asserts `sender == B`. Flagged for SuiAnchor; not solved here.
- **Abandonment.** allocate-but-never-join leaves a bot-created, B-funded tunnel;
  reclaim via `withdraw_before_active` (party B reclaims while `STATUS_CREATED`
  and `party_a_deposit == 0`). Cleanup ties to the reservation TTL.
- **Start signal retained.** The bot still needs "user joined → start playing"
  (watch the `TunnelActivated` event, or reuse `/arena/opened`).
- **Scaffold status.** The contract (per-game user eph pubkey in; `tunnelId` out)
  and the `ArenaTunnelOpener` seam (Noop now) are wired; the real on-chain
  create+fund-B is the boss's `SuiAnchor`. Inert until then.
