# Agent Allowance — Coding Patterns & Principles

> **Status:** Active  
> **Date:** 2026-07-01  
> **Last updated:** 2026-07-01  
> **Scope:** Coding standards for the `agentAllowance` package.

These rules govern Agent Allowance implementation. **Styling and session shape align with
Regular Payments and Streaming Payments** — see
[Regular Payments coding patterns](../../regularPayments/docs/2026-06-28-coding-patterns.md),
[Streaming Payments coding patterns](../../streamingPayment/docs/2026-06-30-coding-patterns.md),
and [design doc](./2026-07-01-agent-allowance-design.md).

**Visual source of truth:** Walrus Memory — `/design-system`, `frontend/src/designSystem/tokens.ts`,
`frontend/src/styles/index.css`.

---

## 1. Props & State Management (Pass Objects)

Pass a session object from the hook into screen components — same pattern as Regular Payments /
Streaming Payments.

```tsx
<AgentAllowanceLobby session={session} />
<AgentAllowanceDashboard session={session} />
```

The hook (`useAgentAllowanceSession`) owns: in-memory session state, post-tx chain reads, meter tick,
tx runners, lobby form state (`agentName`, `providerIdx`, `capInput`, `rateInput`, `expiryIdx`), and
the activity ledger.

**No `localStorage` persistence** until a resume adapter lands. Components stay presentational.

---

## 2. Package Layout

```
frontend/src/games/agentAllowance/
├── index.ts                 # register({ id: "agent-allowance", catalog: false, ... })
├── docs/
│   ├── 2026-07-01-agent-allowance-design.md
│   └── 2026-07-01-coding-patterns.md
├── types/
│   └── index.ts             # Screen, SessionPhase, LedgerEntry, MandateMeta, ...
├── utils/
│   ├── constants.ts         # GAME_ID, PROVIDERS, EXPIRY_OPTIONS, CLAIM_SKEW_MS, explorer URLs
│   ├── formatMtps.ts
│   ├── mandateInputs.ts     # parseWholeMtps, validateMandateInputs (lobby deploy gate)
│   └── index.ts
├── hooks/
│   └── useAgentAllowanceSession.ts
└── components/
    ├── AgentAllowanceWindow/
    │   └── index.tsx        # screen router; wallet + env gates
    ├── AgentAllowanceLobby/
    │   ├── index.tsx                      # deploy form
    │   ├── AgentAllowanceLobbyField.tsx
    │   └── AgentAllowanceLobbyNumberInput.tsx
    ├── BadgeStatus/
    │   └── index.tsx        # Active / Paused / Revoked pill
    └── AgentAllowanceDashboard/
        ├── index.tsx        # header, actions, composes stats + activity
        ├── AgentAllowanceDashboardStats.tsx
        └── AgentAllowanceDashboardActivity.tsx
```

**Order of concern:** `utils` → `hooks` → `components` → `types` (types may be imported everywhere).

On-chain tx builders and accrual math stay in `frontend/src/onchain/agentAllowance.ts` — do not
duplicate Move parity logic in the game package.

---

## 3. Styling & Design System

Match **Walrus Memory** — same rules as Regular Payments §3 and Streaming Payments §3.

- **shadcn/ui** — `Button`, etc.
- **Icons:** `lucide-react`
- **Semantic tokens** + `.wal-display`, `.wal-mono`, `.wal-eyebrow`, `.wal-glow`
- **Lobby hero:** glassy `rounded-[20px] border border-border bg-card/75 backdrop-blur-xl wal-glow`

**Spend meter:** custom progress bar in `AgentAllowanceDashboardStats`; amounts in `wal-mono`.
Source: hook-derived `session.available`, `session.entitled`, `session.fillPct` (from on-chain
accrual math + local `nowMs` tick).

---

## 4. TypeScript Patterns

### 4.1 Core types (shipped)

```typescript
export type Screen = "lobby" | "dashboard";

export type SessionPhase =
  | "idle"
  | "deploying"
  | "active"
  | "claiming"
  | "pausing"
  | "resuming"
  | "revoking";

export function isSessionTxPhase(phase: SessionPhase): boolean;

export type LedgerKind = "create" | "pull" | "pause" | "resume" | "revoke";

export interface LedgerEntry {
  kind: LedgerKind;
  amount?: bigint;
  digest: string;
  at: number;
}
```

### 4.2 BigInt & meter

- Amounts are `bigint` — display format in `utils/formatMtps.ts`; lobby deploy uses
  `parseWholeMtps` / `validateMandateInputs` (whole MTPS only, rate ≤ budget).
- **Accrual truth:** `computeEntitled` / `computeAvailable` from `@/onchain/agentAllowance`.
- **Meter refresh:** `METER_INTERVAL_MS` (250ms) via **`setInterval`** when allowance is ACTIVE —
  not `requestAnimationFrame` (RAF pauses when the tab is backgrounded).
- **Claim safety:** `CLAIM_SKEW_MS` subtracted from wall-clock before `buildClaimTx` amount.

---

## 5. Session & on-chain conventions

| Rule | Detail |
|------|--------|
| Signing (chain) | `useSponsoredSignExec` — principal: deploy / claim / pause / resume / revoke |
| Stake funding (ADR-0013) | `ensureStakeBalance` before deploy; `stakeFromBalance` in `buildCreateAllowanceTx` |
| Mandate discovery | `findCreatedAllowanceId` after deploy |
| Post-tx reads | `fetchAllowanceAfterMutation` — poll until status/spent/escrow reflects the write (indexer lag) |
| External updates (future) | Bot-server WS push → `session.refreshFromChain()` (no background `getObject` poll) |
| Error surface | Single `error` on session |
| Tx guard (session) | `isSessionTxPhase(phase)` — internal guards only |
| Tx guard (UI) | `session.busy` — hook-derived boolean; spinners use `session.phase === "deploying"` etc. |
| Revoke UX | Single-click **Stop** on dashboard (no two-tap confirm) |
| After revoke | `screen` → `lobby`; deploy form shows revoked banner via `session.isRevoked` |

**Hook return** — snapshot fields plus derived conveniences (not stored on the session class):

```typescript
const busy = isSessionTxPhase(snap.phase);

return {
  ...snap,
  busy,
  walletConnected,
  entitled,
  available,
  claimable,
  fillPct,
  providerName,
  displayAgent,
  expiryLabel,
  isRevoked,
  isPaused,
  /* actions */,
};
```

### 5.1 `busy` field (match Streaming Payments)

- **`phase`** is the source of truth on the session snapshot.
- **`busy`** is a **boolean** derived in the hook — never a string label (`"Paying…"` retired).
- Components: `disabled={session.busy}` for competing actions; `session.phase === "claiming"` for
  spinner + inline button copy.
- Do **not** call `isSessionTxPhase` in components.

### 5.2 Session lifecycle

- One `AgentAllowanceSession` per `windowId` (Map + `useSyncExternalStore`).
- `registerWindowDisposer` on first session create — `dispose()` bumps `gen` on window close.
- `deps` refreshed each render from dapp-kit + `useSponsoredSignExec`.

### 5.3 Chain reads (no idle polling)

- **Meter tick** (`METER_INTERVAL_MS`, 250ms) is local only — advances `nowMs` for off-chain
  accrual math; zero RPC.
- **After each mutation** (deploy / claim / pause / resume / revoke): `fetchAllowanceAfterMutation`
  with a predicate matching the expected new state — same pattern as Streaming Payments
  `fetchStreamAfterMutation`.
- **No background `getObject` interval** while the dashboard is open. Cross-party updates (bot claim,
  payee pull) will arrive via **bot-server WebSocket** → `refreshFromChain()` once that layer ships.

---

## 6. Component conventions

| Component | Role |
|-----------|------|
| `AgentAllowanceWindow` | Env gate → wallet gate → `lobby` / `dashboard` router |
| `AgentAllowanceLobby` | Deploy form; `session.deploy` |
| `AgentAllowanceDashboard` | Agent → provider header, pay/pause/stop actions |
| `AgentAllowanceDashboardStats` | Meter + budget-left / paid / per-sec tiles |
| `AgentAllowanceDashboardActivity` | Ledger list + explorer links |
| `BadgeStatus` | On-chain `AllowanceStatus` pill |

Pass `session` only — stats sub-component also receives `allowance` when it needs the raw chain
fields without re-deriving.

Explorer links: reuse `TX_EXPLORER_URL` from `streamingPayment/utils/constants` in activity rows
(shared testnet URL helper).

---

## 7. What not to do

- Do not route through `tunnel.move`, `requestTunnelOpen`, or `POST /settle`.
- Do not use `prepareStake` / owned-coin `splitCoins` — ADR-0013 address balance only.
- Do not persist mandate id / ledger in `localStorage` until a resume adapter exists.
- Do not store `busy` on the session snapshot — derive it in the hook.
- Do not use string `busy` labels for button text rotation.
- Do not duplicate accrual math in components — import from `@/onchain/agentAllowance`.
- Do not rename existing component folders — extend the layout above in place.