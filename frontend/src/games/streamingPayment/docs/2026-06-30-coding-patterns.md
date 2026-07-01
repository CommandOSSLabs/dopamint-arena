# Streaming Payments — Coding Patterns & Principles

> **Status:** Active  
> **Date:** 2026-06-30  
> **Last updated:** 2026-07-02
> **Scope:** Coding standards for the `streamingPayment` package.

These rules govern Streaming Payments implementation (Variant A self-play showcase shipped).
**Styling and session shape align with Regular Payments** — see
[Regular Payments coding patterns](../../regularPayments/docs/2026-06-28-coding-patterns.md)
and [design doc](./2026-06-30-streaming-payment-design.md).

**Visual source of truth:** Walrus Memory — `/design-system`, `frontend/src/designSystem/tokens.ts`,
`frontend/src/styles/index.css`.

---

## 1. Props & State Management (Pass Objects)

Pass a session object from the hook into screen components — same pattern as Regular Payments.

```tsx
<StreamingPaymentDashboard session={session} />
```

The hook (`useStreamingPaymentSession`) owns: in-memory session state, **auto loop**,
**clock vest watch**, **`streaming.v1` tick loop** (telemetry), heartbeat, tx runners, and lobby
form state (`budgetAmount`, `durationIdx`, `autoMode`).

**No `localStorage` persistence** until a resume adapter lands. Components stay presentational.

---

## 2. Package Layout

```
frontend/src/games/streamingPayment/
├── index.ts
├── docs/
├── types/index.ts
├── utils/
│   ├── constants.ts
│   ├── formatMtps.ts
│   ├── sessionCore.ts
│   ├── sessionCore.test.ts
│   └── index.ts
├── hooks/
│   ├── useStreamingPaymentSession.ts
│   └── useStreamClockMeter.ts
└── components/
    ├── StreamingPaymentWindow/
    ├── StreamingPaymentLobby/
    ├── BadgeStatus/
    └── StreamingPaymentDashboard/
        ├── index.tsx
        ├── StreamingPaymentDashboardStats.tsx
        ├── StreamingPaymentDashboardActivity.tsx
        └── StreamingPaymentDashboardComplete.tsx
```

On-chain tx builders and unlock math stay in `frontend/src/onchain/streamingPayment.ts` — do not
duplicate Move parity logic in the game package.

---

## 3. Styling & Design System

Match **Walrus Memory** — same rules as Regular Payments §3.

- **shadcn/ui** — `Button`, `Progress`, `Badge`, etc.
- **Icons:** `lucide-react`
- **Semantic tokens** + `.wal-display`, `.wal-mono`, `.wal-eyebrow`, `.wal-glow`
- **Terminal banner:** bordered inline card on dashboard (not a separate screen)

**Unlock meter:** shadcn `Progress`; amounts in `wal-mono`. Source: `useStreamClockMeter`, not
session tick fields.

---

## 4. TypeScript Patterns

### 4.1 Core types (shipped)

```typescript
export type Screen = "lobby" | "dashboard";

export type SessionPhase =
  | "idle"
  | "creating"
  | "streaming"
  | "toppingUp"
  | "cancelling"
  | "error";

export function isSessionTxPhase(phase: SessionPhase): boolean;

export type LedgerKind = "create" | "topup" | "cancel" | "complete";

export interface LedgerEntry {
  kind: LedgerKind;
  amount?: bigint;
  digest?: string;  // tx digest, or streamId for clock-complete
  at: number;
}
```

### 4.2 BigInt, clock meter, TPS

- Amounts are `bigint` — parse/format in `utils/formatMtps.ts`.
- **UI meter:** `computeUnlocked` / `computeAvailable` / `computeLocked` from
  `@/onchain/streamingPayment` inside `useStreamClockMeter`.
- **Meter refresh:** `CLOCK_METER_INTERVAL_MS` (100ms) via **`setInterval`** — not
  `requestAnimationFrame` (RAF pauses when the tab is backgrounded).
- **TPS:** verified tick co-signs → heartbeat only. **Do not** show a TPS chip. **Do not** count
  clock meter ticks as TPS. **Do not** drive `fillPct` from `verifiedAccrued`.

---

## 5. Session & on-chain conventions

| Rule | Detail |
|------|--------|
| Signing (chain) | `useSponsoredSignExec` — A: create / top-up / cancel |
| Stream discovery | `findCreatedStreamId` after create; **`fetchStreamAfterMutation`** after top-up / cancel |
| Who opens stream | **A only** — `buildCreateStreamTx` |
| Self-play | Local B keypair per stream (`createParticipant`) |
| Error surface | Single `error` on session |
| Tx guard (session) | `isSessionTxPhase(phase)` — internal guards only |
| Tx guard (UI) | `session.busy` — hook-derived from `phase`; spinners use `phase === "toppingUp"` etc. |
| **Auto loop** | `bindAutoLoop(walletConnected)` in hook **`useEffect`** after `session.deps` assigned; cleanup `bindAutoLoop(false)` on unmount — **not** in `session.init()` |
| **Round end** | `completeRound()` → lobby (keeps `autoMode`); `newStream()` aliases it |
| **Vest end** | `applyVestComplete()` at `endMs` — activity `complete`, `vestComplete` flag |
| Cancel | Immediate tx; terminal banner 3s (no two-tap confirm) |
| Duration | `durationIdx` + `setDurationIdx` → `DURATIONS[i].ms` in `startStream` |

**Hook return** — snapshot fields plus derived conveniences (not stored on the session class):

```typescript
const busy =
  snap.phase === "creating" ||
  snap.phase === "toppingUp" ||
  snap.phase === "cancelling";

return { ...snap, busy, walletConnected, formRate, recipientName, /* actions */ };
```

### 5.1 Auto loop (shipped)

```typescript
const walletConnected = Boolean(account?.address) && sponsored.ready;

useEffect(() => {
  session.bindAutoLoop(walletConnected);
  return () => session.bindAutoLoop(false);
}, [walletConnected, snap.autoMode]);
```

`runAutoLoop`: lobby → `startStream` → wait dashboard → wait vest or cancel → wait lobby (3s
banner) → repeat.

### 5.2 BOT-SERVER ingress (P7 — planned, not shipped)

When relay WIP lands, remote terminal events call **`applyRemoteStreamEvent()`** on the session
(single code path for opponent cancel/complete). WS subscriber lives in the hook; **do not** branch
UI or meter on transport. See design doc §12.

---

## 6. TPS & heartbeat

Follow [adding-a-tunnel-game.md](../../../../docs/guide/adding-a-tunnel-game.md) heartbeat
invariants — ticks instead of `tunnel.step`:

1. **`registerSession`** once before first tick (`game: "streaming-payment"`, `streamId` anchor).
2. **One action per verified co-sign** — after B accepts tick, not per clock meter refresh.
3. **Throttled `sendHeartbeat`** — `actionsDelta` since last flush.
4. **Force-flush** on cancel, vest complete, `completeRound`, dispose.

**No TPS chip** on dashboard.

---

## 7. What not to do

- Do not route through `tunnel.move` or `POST /settle`.
- Do not change Move for ticks — off-chain lane only.
- Do not drive the **UI meter** from `verifiedAccrued` or `displayAccrued`.
- Do not store `busy` on the session snapshot — **`phase`** is the source of truth; the hook derives **`busy: boolean`** for disables.
- Do not call `isSessionTxPhase` in components — use **`session.busy`** for `disabled`; use **`session.phase`** for spinners and inline labels (no label helper utils).
- Do not compare UI strings like `"Adding funds…"` — retired `busy` string labels.
- Do not use RAF for the clock meter.
- Do not start auto loop in `session.init()` before `deps` is wired.
- Do not add a **`thankYou` screen** — inline `StreamingPaymentDashboardComplete` only.
- Do not block showcase work on BOT-SERVER — document P7 ingress; implement when WIP lands.
- Do not duplicate unlock math in components — import from `@/onchain/streamingPayment`.