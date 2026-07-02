# Agent Allowance — Capped agent spending mandate (x402)

> **Status:** Approved — **showcase shipped**  
> **Date:** 2026-07-01  
> **Last updated:** 2026-07-01  
> **Scope:** **Agent Allowance** — a payment-workspace app in the arena.  
> **Package:** `frontend/src/games/agentAllowance/`  
> **Register id:** `agent-allowance`  
> **Does NOT cover:** Regular Payments (tunnel checkout), Streaming Payments (time stream),
> agent micropayments (tunnel M2M).

**Coding patterns (styling, props, layout):** [2026-07-01-coding-patterns.md](./2026-07-01-coding-patterns.md)

---

## 1. Problem & goals

The arena needs a **delegated spending** showcase — fund an autonomous agent with a capped budget
to pay metered API/compute providers (x402 / “OAuth for money”). Agent Allowance demonstrates:

- **Escrowed budget** — principal locks MTPS into a shared `Allowance` object.
- **Rate accrual** — entitlement grows per second up to `spendCap` (and optional expiry).
- **Pull payments** — payee/delegate/principal calls `entry_claim` with no per-charge co-signature.
- **Principal control** — pause, resume, revoke (refund unspent escrow).
- **On-chain honesty** — `agent_allowance` + Sui `Clock` are the financial source of truth.

### Goals

| Goal | Detail |
|------|--------|
| Product truth | Agent pays a provider over time within a revocable cap |
| On-chain honesty | Real Move `Allowance`; UI meter mirrors `computeEntitled` / `computeAvailable` |
| Arena consistency | Walrus Memory design system — same session pattern as Streaming Payments |
| Sender-first UX | This window is the **funder's** dashboard; claim simulates agent/provider pull |
| ADR-0013 funding | Stake from SIP-58 address balance — no per-deploy owned-coin faucet |

### Non-goals

- `tunnel.move` / tunnel `/settle`
- Merging with Regular Payments, Streaming Payments, or agent micropayments UIs
- `localStorage` resume (in-memory session until adapter lands)
- Voucher / delegate signing UI in v1 (rate-only mandate; empty `principalPublicKey`)
- Tunnel batcher (`requestTunnelOpen`) — standalone `agent_allowance` package

---

## 2. Core concept

**Agent Allowance** is a floating arena widget (`workspace: "payment"`, `catalog: false`, Add
dialog Payment group, 🤖 icon).

### Parties

```
Principal  =  Connected wallet (funds escrow, pause/resume/revoke)
Payee      =  Sample provider address (AI Inference / Web Search / Market Data)
Agent      =  UX label only in v1 — claim tx stands in for agent/provider pull
```

### Round flow (shipped)

1. **Lobby** — agent name, provider, budget, rate/sec, expiry → **Start agent**.
2. **Deploy** — `ensureStakeBalance` → `entry_create_and_share`; shared `Allowance` created.
3. **Dashboard** — live meter, pay now, pause/resume, stop; activity ledger.
4. **Revoke** — `entry_revoke`; unused escrow refunds; screen returns to lobby with banner.
5. **New mandate** — deploy again from lobby (no persisted state).

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  AgentAllowanceWindow                                       │
│    useAgentAllowanceSession(windowId)                       │
│      ├─ lobby  → AgentAllowanceLobby                        │
│      └─ dashboard → AgentAllowanceDashboard                 │
│            ├─ AgentAllowanceDashboardStats                  │
│            └─ AgentAllowanceDashboardActivity               │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  frontend/src/onchain/agentAllowance.ts                     │
│    buildCreateAllowanceTx / buildClaimTx / buildPauseTx …   │
│    computeEntitled / computeAvailable / fetchAllowanceAfterMutation │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Move: agent_allowance (slim standalone package)      │
└─────────────────────────────────────────────────────────────┘
```

### Session (out-of-React class)

Mirrors Streaming Payments / Regular Payments:

- `useSyncExternalStore` + per-`windowId` singleton
- `gen` counter aborts stale async tx results
- In-memory ledger and form state only

### Chain reads & future bot-server sync

| When | Mechanism |
|------|-----------|
| Live meter (accrual display) | Off-chain `computeEntitled` / `computeAvailable` + local `nowMs` tick (250ms, no RPC) |
| After principal txs | `fetchAllowanceAfterMutation` — short poll until object reflects the write |
| Bot / payee mutates object (future) | Bot-server emits over WebSocket → `session.refreshFromChain()` |

**No idle `getObject` polling** while the dashboard is open. Background interval reads were removed;
external updates will use the bot-server push path instead of spamming the fullnode every few seconds.

---

## 4. On-chain surface

| Action | Builder | Move entry |
|--------|---------|------------|
| Deploy | `buildCreateAllowanceTx` | `entry_create_and_share` |
| Pay (claim) | `buildClaimTx` | `entry_claim` |
| Pause | `buildPauseTx` | `pause` |
| Resume | `buildResumeTx` | `resume` |
| Stop | `buildRevokeTx` | `entry_revoke` |
| Top up (future) | `buildTopUpTx` | `entry_top_up` |

### ADR-0013 stake (shipped)

Deploy (and future top-up) fund escrow via address balance:

```typescript
await ensureStakeBalance(cap);
buildCreateAllowanceTx({
  stakeFromBalance: { amount: cap, coinType: MTPS_COIN_TYPE },
  fundAmount: cap,
  payee,
  ratePerSecond: rate,
  spendCap: cap,
  expiryMs,
});
```

Gas sponsored (ADR-0009); stake is player MTPS from `redeem_funds` — not tunnel batcher.

### Accrual math (UI + claim)

```
entitled = min(rate × elapsed, spendCap, voucher, expiry-bound accrual)
available = min(entitled − spent, escrowBalance)
claimable = available at (now − CLAIM_SKEW_MS)   // Sui Clock lag guard
```

Implemented in `frontend/src/onchain/agentAllowance.ts`.

---

## 5. Env & configuration

| Var | Purpose |
|-----|---------|
| `VITE_AGENT_ALLOWANCE_PACKAGE_ID` | Published slim package id |
| `VITE_MTPS_COIN_TYPE` | Shared arena stake token |
| `VITE_MTPS_PACKAGE_ID` | MTPS env gate (with coin type) |

`isAgentAllowanceConfigured` requires package id + MTPS coin type.

---

## 6. Comparison with sibling payment apps

| App | On-chain module | Funding path | Session pattern |
|-----|-----------------|--------------|-----------------|
| Regular Payments | `tunnel` + `payments` | ADR-0013 + **batcher** | `useRegularPaymentsSession` |
| Streaming Payments | `streaming_payment` | ADR-0013 direct | `useStreamingPaymentSession` |
| **Agent Allowance** | `agent_allowance` | ADR-0013 direct | `useAgentAllowanceSession` |

All three share `ensureStakeBalance` + `redeem_funds`; only downstream Move calls differ.

---

## 7. Test plan (manual)

- [ ] Wallet connect → lobby form renders
- [ ] Start agent with 0 MTPS → balance top-up → mandate created
- [ ] Dashboard meter accrues while Active
- [ ] Pay now after a few seconds → claim tx succeeds
- [ ] Pause → badge/meter update promptly; Resume → accrual continues without multi-second lag
- [ ] Stop → revoke tx; lobby shows refunded banner
- [ ] Window close / reopen → fresh session (no localStorage restore)