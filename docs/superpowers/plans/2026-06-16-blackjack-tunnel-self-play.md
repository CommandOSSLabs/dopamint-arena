# Blackjack Tunnel Self-Play Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the server-driven Blackjack game with a client-side, bot-vs-bot self-play table driven by the `sui-tunnel-ts` `BlackjackProtocol` over `OffchainTunnel.selfPlay`, preserving the existing casino UI, where the player only sets a stake.

**Architecture:** A new self-contained `frontend/src/games/blackjack/` folder. Pure logic (card display mapping, session driver) is SDK-type-only and unit-tested under `tsx`; a React hook (`useBlackjackSession`) generates two in-browser keypairs, opens a self-play tunnel, and steps the two bots on a timer until the protocol is terminal. The ported presentational components render the tunnel state. A new `TelemetryProvider` feeds the bots' co-signed activity into the desktop's live panels. A Vite `node:crypto` stub keeps the SDK browser-safe without editing the SDK.

**Tech Stack:** React 19, Vite 8, Tailwind v4, TypeScript; `sui-tunnel-ts` (off-chain engine, `@noble` crypto in browser); `node:test` via `tsx` for unit tests.

---

## Reference facts (verified against the codebase)

- **Game registry contract** (`frontend/src/games/types.ts`): a game is `{ id, name, icon, Window: ComponentType<GameWindowProps> }`; `GameWindowProps = { windowId, onClose }`. Register via `register(...)` in the game's `index.ts`. `games/index.ts` already imports `./blackjack`.
- **SDK path alias**: `tsconfig.json` maps `sui-tunnel-ts` and `sui-tunnel-ts/*` to `../sui-tunnel-ts/src/*`; `vite.config.ts` aliases the runtime. Deep imports like `sui-tunnel-ts/protocol/blackjack` work (the panels already do `import type { RateReport } from "sui-tunnel-ts/telemetry/metrics"`).
- **SDK APIs used:**
  - `createParticipant(id: string, rng?): { id, address, keyPair }` from `sui-tunnel-ts/core/keys`.
  - `OffchainTunnel.selfPlay(protocol, tunnelId, keyA, keyB, addrA, addrB, { a, b })` from `sui-tunnel-ts/core/tunnel`; instance has `.state`, `.step(move, by)`, `.latest`, `.onUpdate` (observer `(u, bytes) => void`), `.buildSettlement(timestamp: bigint)`, `.partyA/.partyB` (each `{ publicKey, scheme }`).
  - `verifyCoSignedUpdate(u, { publicKey, scheme }, { publicKey, scheme })` from `sui-tunnel-ts/core/tunnel`.
  - `BlackjackProtocol`, `WAGER`, types `BlackjackState`, `BlackjackMove`, `BlackjackPhase` from `sui-tunnel-ts/protocol/blackjack`. `BlackjackState` fields: `phase`, `round: bigint`, `playerHand: number[]` (card VALUES, Ace=11), `dealerHand: number[]`, `balanceA: bigint`, `balanceB: bigint`. `protocol.isTerminal(state)`, `protocol.randomMove(state, by, rng)`.
  - `Party` (`"A" | "B"`) from `sui-tunnel-ts/protocol/Protocol`.
  - `newCounters(): Counters`, `rateReport(c: Counters, elapsedMs: number): RateReport`, type `Counters` (`updates, signatures, verifications, bytes, tunnelsOpened, tunnelsClosed, settlements, errors`) from `sui-tunnel-ts/telemetry/metrics`.
- **Telemetry seam**: `frontend/src/panels/types.ts:TelemetrySnapshot`; `frontend/src/placeholders.ts:PLACEHOLDER_SNAPSHOT`; `Desktop.tsx` currently does `const snapshot = PLACEHOLDER_SNAPSHOT;`.
- **Existing UI** (under `frontend/src/games/blackjack/packages/client/src`): `pages/PlayerGame.tsx` (table layout, fed by `useBlackJack()`), `components/app/CardDisplay.tsx` (card = index 0–51 = `suit*13+rank`; SVG `/cards/{suit}/{suit}-{name}.svg`; sums via `@poc/shared` `getCardSum`), plus pure `components/general/{LoadingModal,PageLoader,GameCardScale,SuitSpinner,Spinner}.tsx`. Casino CSS in `packages/client/src/styles/globals.css`. Assets in `packages/client/public/`.

## File structure (created / modified / deleted)

**Created:**
- `frontend/src/shims/node-crypto.ts` — Vite stub for `node:crypto`.
- `frontend/src/telemetry/TelemetryProvider.tsx` — live `TelemetrySnapshot` context.
- `frontend/src/games/blackjack/cards.ts` — pure card-value→display helpers (no SDK runtime, no Vite-only APIs).
- `frontend/src/games/blackjack/cards.test.ts`
- `frontend/src/games/blackjack/cardAssets.ts` — `cardUrl()` via `import.meta.glob` (Vite-only; never imported by tests).
- `frontend/src/games/blackjack/session-core.ts` — pure session driver (SDK type-only imports).
- `frontend/src/games/blackjack/session-core.test.ts`
- `frontend/src/games/blackjack/useBlackjackSession.ts` — React hook (timer + SDK runtime).
- `frontend/src/games/blackjack/components/BetPanel.tsx`
- `frontend/src/games/blackjack/components/BlackjackTable.tsx` — ported `PlayerGame` layout.
- `frontend/src/games/blackjack/components/{CardDisplay,LoadingModal,PageLoader,GameCardScale,SuitSpinner,Spinner}.tsx` — ported.
- `frontend/src/games/blackjack/BlackjackWindow.tsx`
- `frontend/src/games/blackjack/blackjack.css` — ported casino classes.
- `frontend/src/games/blackjack/assets/**` — salvaged card SVGs + table images.

**Modified:**
- `frontend/vite.config.ts` — add `node:crypto` alias.
- `frontend/package.json` — add `tsx` devDep + `test` script.
- `frontend/src/App.tsx` — wrap `Desktop` in `TelemetryProvider`.
- `frontend/src/desktop/Desktop.tsx` — read `useTelemetry().snapshot`.
- `frontend/src/games/blackjack/index.ts` — register the real `BlackjackWindow`.

**Deleted (after assets salvaged):**
- `frontend/src/games/blackjack/packages/**`, `docker-compose.yaml`, `bun.lock`, `package.json` (the nested one), `tsconfig.base.json`, `.gitignore` (the nested one), `index.ts`/`README.md` retained.

---

## Task 1: Vite `node:crypto` stub (unblock browser bundling)

**Files:**
- Create: `frontend/src/shims/node-crypto.ts`
- Modify: `frontend/vite.config.ts`

- [ ] **Step 1: Create the stub module**

```ts
// frontend/src/shims/node-crypto.ts
/**
 * Browser stub for `node:crypto`. The sui-tunnel-ts engine statically imports
 * core/crypto-native.ts (`import * as nc from "node:crypto"`), but at runtime it
 * probes that backend in a try/catch and falls back to pure-JS @noble in the
 * browser. We only need the static import to RESOLVE during the Vite build; the
 * native code path never runs here. Every export throws so any accidental use is
 * loud rather than silently wrong. Keeps the SDK itself untouched (upstream re-sync).
 */
function unavailable(): never {
  throw new Error("node:crypto is not available in the browser (sui-tunnel-ts falls back to @noble)");
}
export const createPrivateKey = unavailable;
export const createPublicKey = unavailable;
export const sign = unavailable;
export const verify = unavailable;
export default {} as Record<string, unknown>;
```

- [ ] **Step 2: Add the alias in `vite.config.ts`**

Replace the `resolve.alias` block so it reads:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // The off-chain engine statically imports node:crypto in crypto-native.ts but
      // falls back to @noble at runtime in the browser. Map node:crypto to a stub so
      // the bundle resolves; the native path is never taken here.
      "node:crypto": fileURLToPath(new URL("./src/shims/node-crypto.ts", import.meta.url)),
      "sui-tunnel-ts": fileURLToPath(new URL("../sui-tunnel-ts/src", import.meta.url)),
    },
  },
});
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/shims/node-crypto.ts frontend/vite.config.ts
git commit -m "build(frontend): stub node:crypto for browser engine"
```

---

## Task 2: Frontend test tooling

**Files:**
- Modify: `frontend/package.json`

- [ ] **Step 1: Add `tsx` devDependency and a `test` script**

In `frontend/package.json`, add to `"scripts"`:

```json
    "test": "node --import tsx --test \"src/**/*.test.ts\""
```

and add to `"devDependencies"`:

```json
    "tsx": "^4.22.4"
```

- [ ] **Step 2: Install**

Run: `cd frontend && npm install`
Expected: installs `tsx`; exit 0.

- [ ] **Step 3: Verify the runner finds no tests yet (sanity)**

Run: `cd frontend && npm test`
Expected: `node:test` reports `tests 0` (or "no test files"), exit 0.

- [ ] **Step 4: Commit**

```bash
git add frontend/package.json frontend/package-lock.json
git commit -m "test(frontend): add tsx node:test runner"
```

---

## Task 3: Pure card helpers (`cards.ts`) — TDD

These map the protocol's card VALUES to display card indices (0–51) for the ported `CardDisplay`. No SDK runtime imports, no `import.meta.glob` — so they run under `tsx`.

**Files:**
- Create: `frontend/src/games/blackjack/cards.ts`
- Test: `frontend/src/games/blackjack/cards.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/games/blackjack/cards.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  handValue,
  rankIndexValue,
  valueToCardIndex,
  handToCardIndices,
} from "./cards.ts";

test("handValue sums with soft-ace reduction", () => {
  assert.equal(handValue([11, 10]), 21); // blackjack
  assert.equal(handValue([11, 11]), 12); // one ace reduced 11->1
  assert.equal(handValue([11, 5, 10]), 16); // ace reduced once
  assert.equal(handValue([5, 6]), 11);
});

test("valueToCardIndex yields a 0..51 index whose rank value matches", () => {
  for (let seq = 0; seq < 8; seq++) {
    for (const value of [11, 10, 9, 2]) {
      const idx = valueToCardIndex(value, seq);
      assert.ok(idx >= 0 && idx < 52, `index ${idx} in range`);
      const rankIdx = idx % 13;
      assert.equal(rankIndexValue(rankIdx), value, `rank value matches for ${value}`);
    }
  }
});

test("value 11 is always an Ace; value 10 varies across 10/J/Q/K", () => {
  assert.equal(valueToCardIndex(11, 3) % 13, 0); // Ace rank index
  const faces = new Set([0, 1, 2, 3].map((s) => valueToCardIndex(10, s) % 13));
  assert.ok(faces.size > 1, "ten-valued cards vary by seq");
  for (const r of faces) assert.ok(r >= 9 && r <= 12, "ten-valued rank is 10/J/Q/K");
});

test("handToCardIndices is stable for the same inputs and preserves length", () => {
  const a = handToCardIndices([11, 10, 5], 7);
  const b = handToCardIndices([11, 10, 5], 7);
  assert.deepEqual(a, b);
  assert.equal(a.length, 3);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && node --import tsx --test src/games/blackjack/cards.test.ts`
Expected: FAIL — cannot find module `./cards.ts` / exports undefined.

- [ ] **Step 3: Implement `cards.ts`**

```ts
// frontend/src/games/blackjack/cards.ts
/**
 * Bridge the SDK BlackjackProtocol's card VALUES (Ace=11, J/Q/K=10, else face) to
 * display card indices (0..51) understood by the ported CardDisplay, where
 * `index = suit*13 + rankIndex`, suit ∈ clubs/diamonds/hearts/spades,
 * rankIndex 0..12 = A,2..10,J,Q,K.
 *
 * The protocol never stores suit/rank, so faces are COSMETIC: we pick a real rank
 * whose blackjack value equals the protocol value, and a suit, both from a caller
 * `seq` so a hand is stable within a round yet visually varied. Totals stay
 * authoritative because they come from the protocol (mirrored here by handValue).
 */

/** rankIndex -> blackjack value (Ace high = 11; reduced later by handValue). */
export function rankIndexValue(rankIndex: number): number {
  if (rankIndex === 0) return 11; // Ace
  if (rankIndex >= 9) return 10; // 10, J, Q, K
  return rankIndex + 1; // rankIndex 1..8 -> 2..9
}

/** Hand total with soft-ace handling, mirroring protocol/blackjack.ts handValue. */
export function handValue(values: number[]): number {
  let total = 0;
  let aces = 0;
  for (const v of values) {
    total += v;
    if (v === 11) aces++;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
}

/** rankIndex whose value equals `value`; ten-valued cards vary across 10/J/Q/K by seq. */
function valueToRankIndex(value: number, seq: number): number {
  if (value === 11) return 0; // Ace
  if (value === 10) return 9 + (((seq % 4) + 4) % 4); // 9..12 = 10,J,Q,K
  return value - 1; // 2..9 -> rankIndex 1..8
}

/** Map a protocol value to a display card index 0..51 (suit rotates with seq). */
export function valueToCardIndex(value: number, seq: number): number {
  const suit = (((seq % 4) + 4) % 4);
  return suit * 13 + valueToRankIndex(value, seq);
}

/** Map a hand of values to display indices; `salt` keeps a round's faces stable. */
export function handToCardIndices(values: number[], salt: number): number[] {
  return values.map((v, i) => valueToCardIndex(v, salt * 31 + i * 7));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && node --import tsx --test src/games/blackjack/cards.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/blackjack/cards.ts frontend/src/games/blackjack/cards.test.ts
git commit -m "feat(blackjack): add card value-to-face display helpers"
```

---

## Task 4: Pure session driver (`session-core.ts`) — TDD

Pure functions over the SDK engine: which party moves, how to step once, how to derive the view-state. Production imports SDK **types only** (erased at runtime); the test imports SDK **runtime** values by relative path so it runs under `tsx` without path-alias config.

**Files:**
- Create: `frontend/src/games/blackjack/session-core.ts`
- Test: `frontend/src/games/blackjack/session-core.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/games/blackjack/session-core.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

// Relative SDK imports (runtime): tsx needs no path-alias config this way.
import { createParticipant } from "../../../../sui-tunnel-ts/src/core/keys.ts";
import { OffchainTunnel, verifyCoSignedUpdate } from "../../../../sui-tunnel-ts/src/core/tunnel.ts";
import { BlackjackProtocol } from "../../../../sui-tunnel-ts/src/protocol/blackjack.ts";

import { partyForPhase, stepSession, deriveView, sessionResult } from "./session-core.ts";

function newTunnel(stake: bigint) {
  const a = createParticipant("player-bot");
  const b = createParticipant("dealer-bot");
  const protocol = new BlackjackProtocol();
  const tunnel = OffchainTunnel.selfPlay(
    protocol,
    "0xblackjacktest",
    a.keyPair,
    b.keyPair,
    a.address,
    b.address,
    { a: stake, b: stake },
  );
  return { protocol, tunnel };
}

test("partyForPhase routes turns: dealer->B, else A", () => {
  assert.equal(partyForPhase("player"), "A");
  assert.equal(partyForPhase("round_over"), "A");
  assert.equal(partyForPhase("dealer"), "B");
});

test("stepSession drives the tunnel to a terminal state, conserving balances", () => {
  const stake = 500n;
  const { protocol, tunnel } = newTunnel(stake);
  let guard = 0;
  while (stepSession(protocol, tunnel, Math.random)) {
    assert.equal(tunnel.state.balanceA + tunnel.state.balanceB, stake * 2n);
    if (++guard > 100_000) throw new Error("did not terminate");
  }
  assert.ok(protocol.isTerminal(tunnel.state), "reached terminal state");
  assert.equal(tunnel.state.balanceA + tunnel.state.balanceB, stake * 2n);
});

test("the latest co-signed update verifies after play", () => {
  const { protocol, tunnel } = newTunnel(500n);
  while (stepSession(protocol, tunnel, Math.random)) {}
  const u = tunnel.latest;
  assert.ok(u, "has a co-signed update");
  assert.ok(
    verifyCoSignedUpdate(
      u!,
      { publicKey: tunnel.partyA.publicKey, scheme: tunnel.partyA.scheme },
      { publicKey: tunnel.partyB.publicKey, scheme: tunnel.partyB.scheme },
    ),
    "settleable co-signed state",
  );
});

test("deriveView and sessionResult report the bankroll outcome", () => {
  const stake = 500n;
  const { protocol, tunnel } = newTunnel(stake);
  while (stepSession(protocol, tunnel, Math.random)) {}
  const view = deriveView(tunnel.state, stake);
  assert.equal(view.playerCards.length, view.playerCardCount);
  assert.ok(["win", "lose", "push"].includes(sessionResult(tunnel.state, stake)));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && node --import tsx --test src/games/blackjack/session-core.test.ts`
Expected: FAIL — `./session-core.ts` exports not found.

- [ ] **Step 3: Implement `session-core.ts`**

```ts
// frontend/src/games/blackjack/session-core.ts
/**
 * Pure driver for a bot-vs-bot Blackjack tunnel session. No React, no timers, no
 * runtime SDK imports (types only, erased at build) so it is trivially unit-tested.
 * The React hook (useBlackjackSession) owns keypairs, the timer, and telemetry.
 */
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import type {
  BlackjackProtocol,
  BlackjackState,
  BlackjackMove,
  BlackjackPhase,
} from "sui-tunnel-ts/protocol/blackjack";
import type { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";

import { handValue, handToCardIndices } from "./cards.ts";

/** Whose turn it is, derived purely from the protocol phase. */
export function partyForPhase(phase: BlackjackPhase): Party {
  return phase === "dealer" ? "B" : "A";
}

/**
 * Advance the session by one bot move. Returns false when the game is terminal or
 * no legal move exists (the caller then stops the timer and settles).
 */
export function stepSession(
  protocol: BlackjackProtocol,
  tunnel: OffchainTunnel<BlackjackState, BlackjackMove>,
  rng: () => number,
): boolean {
  const state = tunnel.state;
  if (protocol.isTerminal(state)) return false;
  const by = partyForPhase(state.phase);
  const move = protocol.randomMove(state, by, rng);
  if (!move) return false;
  tunnel.step(move, by);
  return true;
}

/** Player-bankroll outcome relative to the starting stake. */
export type SessionResult = "win" | "lose" | "push";

export function sessionResult(state: BlackjackState, stake: bigint): SessionResult {
  if (state.balanceA > stake) return "win";
  if (state.balanceA < stake) return "lose";
  return "push";
}

/** Flat, render-friendly snapshot of a BlackjackState (bigints -> numbers, faces mapped). */
export interface BlackjackView {
  playerCards: number[]; // display indices 0..51 for CardDisplay
  dealerCards: number[];
  playerSum: number;
  dealerSum: number;
  playerCardCount: number;
  dealerCardCount: number;
  playerBalance: number;
  dealerBalance: number;
  round: number;
  phase: BlackjackPhase;
  isTerminal: boolean;
}

export function deriveView(state: BlackjackState, stake: bigint): BlackjackView {
  const round = Number(state.round);
  return {
    playerCards: handToCardIndices(state.playerHand, round * 2),
    dealerCards: handToCardIndices(state.dealerHand, round * 2 + 1),
    playerSum: handValue(state.playerHand),
    dealerSum: handValue(state.dealerHand),
    playerCardCount: state.playerHand.length,
    dealerCardCount: state.dealerHand.length,
    playerBalance: Number(state.balanceA),
    dealerBalance: Number(state.balanceB),
    round,
    phase: state.phase,
    isTerminal:
      state.phase === "round_over" &&
      (state.balanceA < stake || state.balanceB < stake || Number(state.round) >= 1000),
  };
}
```

Note: `isTerminal` here mirrors the protocol's terminal predicate using the known `WAGER`/`ROUND_CAP`. The authoritative check used by `stepSession` is `protocol.isTerminal`; `deriveView.isTerminal` is for display only. We avoid importing `WAGER` at runtime by comparing to `stake` (both bots start at `stake`, wager is 100, so "can't cover" reduces to `< stake` only when `stake <= 100`; for larger stakes use the protocol check in the hook). The hook uses `protocol.isTerminal(tunnel.state)` for the real terminal decision (see Task 6).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && node --import tsx --test src/games/blackjack/session-core.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/blackjack/session-core.ts frontend/src/games/blackjack/session-core.test.ts
git commit -m "feat(blackjack): add pure tunnel session driver"
```

---

## Task 5: Telemetry provider feeding the live panels

**Files:**
- Create: `frontend/src/telemetry/TelemetryProvider.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/desktop/Desktop.tsx`

- [ ] **Step 1: Create the provider**

```tsx
// frontend/src/telemetry/TelemetryProvider.tsx
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { newCounters, rateReport } from "sui-tunnel-ts/telemetry/metrics";
import type { Counters } from "sui-tunnel-ts/telemetry/metrics";
import type { TelemetrySnapshot, TxnRow } from "../panels/types";
import { PLACEHOLDER_SNAPSHOT } from "../placeholders";

const MAX_TXNS = 12;
const MAX_SERIES = 20;

/** Writer API games call to push their off-chain activity into the live panels. */
export interface TelemetryWriter {
  /** Prepend a transaction row (capped to the most recent MAX_TXNS). */
  pushTxn: (row: TxnRow) => void;
  /** Accumulate engine counters from one or more co-signed updates. */
  bumpCounters: (delta: Partial<Counters>) => void;
  /** Set the number of bots currently running. */
  setActive: (n: number) => void;
}

interface TelemetryContextValue {
  snapshot: TelemetrySnapshot;
  report: TelemetryWriter;
}

const TelemetryContext = createContext<TelemetryContextValue | null>(null);

export function TelemetryProvider({ children }: { children: ReactNode }) {
  // Seed from the placeholder so the shell looks populated before any play.
  const [txns, setTxns] = useState<TxnRow[]>(PLACEHOLDER_SNAPSHOT.txns);
  const [tpsSeries, setTpsSeries] = useState<number[]>(PLACEHOLDER_SNAPSHOT.tpsSeries);
  const [botsRunning, setBotsRunning] = useState<number>(PLACEHOLDER_SNAPSHOT.botsRunning);
  const [hasActivity, setHasActivity] = useState(false);

  const counters = useRef<Counters>(newCounters());
  const startMs = useRef<number>(Date.now());

  const pushTxn = useCallback((row: TxnRow) => {
    setHasActivity(true);
    setTxns((cur) => [row, ...cur].slice(0, MAX_TXNS));
  }, []);

  const bumpCounters = useCallback((delta: Partial<Counters>) => {
    setHasActivity(true);
    const c = counters.current;
    c.updates += delta.updates ?? 0;
    c.signatures += delta.signatures ?? 0;
    c.verifications += delta.verifications ?? 0;
    c.bytes += delta.bytes ?? 0;
    c.tunnelsOpened += delta.tunnelsOpened ?? 0;
    c.tunnelsClosed += delta.tunnelsClosed ?? 0;
    c.settlements += delta.settlements ?? 0;
    c.errors += delta.errors ?? 0;
    const elapsed = Math.max(1, Date.now() - startMs.current);
    const ups = rateReport(c, elapsed).updatesPerSec;
    setTpsSeries((cur) => [...cur, Math.round(ups)].slice(-MAX_SERIES));
  }, []);

  const setActive = useCallback((n: number) => setBotsRunning(n), []);

  const snapshot = useMemo<TelemetrySnapshot>(() => {
    if (!hasActivity) return PLACEHOLDER_SNAPSHOT;
    const elapsed = Math.max(1, Date.now() - startMs.current);
    const rate = rateReport(counters.current, elapsed);
    return {
      rate,
      txns,
      deposits: PLACEHOLDER_SNAPSHOT.deposits,
      tpsSeries,
      botsRunning,
      totalBalance: PLACEHOLDER_SNAPSHOT.totalBalance,
      successRate: rate.errors === 0 ? 100 : (rate.updates / (rate.updates + rate.errors)) * 100,
    };
  }, [hasActivity, txns, tpsSeries, botsRunning]);

  const value = useMemo<TelemetryContextValue>(
    () => ({ snapshot, report: { pushTxn, bumpCounters, setActive } }),
    [snapshot, pushTxn, bumpCounters, setActive],
  );

  return <TelemetryContext.Provider value={value}>{children}</TelemetryContext.Provider>;
}

export function useTelemetry(): TelemetryContextValue {
  const ctx = useContext(TelemetryContext);
  if (!ctx) throw new Error("useTelemetry must be used within a TelemetryProvider");
  return ctx;
}
```

- [ ] **Step 2: Wrap `Desktop` in the provider (`App.tsx`)**

Replace the file with:

```tsx
import { WalletGate } from "./wallet/WalletGate";
import { Desktop } from "./desktop/Desktop";
import { TelemetryProvider } from "./telemetry/TelemetryProvider";

export function App() {
  return (
    <WalletGate>
      <TelemetryProvider>
        <Desktop />
      </TelemetryProvider>
    </WalletGate>
  );
}
```

- [ ] **Step 3: Read the live snapshot in `Desktop.tsx`**

In `frontend/src/desktop/Desktop.tsx`: remove the import `import { PLACEHOLDER_SNAPSHOT } from "../placeholders";`, add `import { useTelemetry } from "../telemetry/TelemetryProvider";`, and replace `const snapshot = PLACEHOLDER_SNAPSHOT;` with:

```tsx
  const { snapshot } = useTelemetry();
```

- [ ] **Step 4: Verify typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS (exit 0).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/telemetry/TelemetryProvider.tsx frontend/src/App.tsx frontend/src/desktop/Desktop.tsx
git commit -m "feat(frontend): live telemetry provider for panels"
```

---

## Task 6: `useBlackjackSession` hook

Owns keypairs, the self-play tunnel, the stepping timer, and telemetry emission.

**Files:**
- Create: `frontend/src/games/blackjack/useBlackjackSession.ts`

- [ ] **Step 1: Implement the hook**

```ts
// frontend/src/games/blackjack/useBlackjackSession.ts
import { useCallback, useEffect, useRef, useState } from "react";
import { createParticipant } from "sui-tunnel-ts/core/keys";
import { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import { BlackjackProtocol, WAGER } from "sui-tunnel-ts/protocol/blackjack";
import type { BlackjackState, BlackjackMove } from "sui-tunnel-ts/protocol/blackjack";
import { useTelemetry } from "../../telemetry/TelemetryProvider";
import {
  deriveView,
  sessionResult,
  stepSession,
  type BlackjackView,
  type SessionResult,
} from "./session-core";

/** Milliseconds between bot moves (animation pacing). */
const STEP_MS = 600;

export type SessionStatus = "idle" | "playing" | "settled";

export interface BlackjackSession {
  status: SessionStatus;
  view: BlackjackView | null;
  result: SessionResult | null;
  stake: number;
  start: (stake: number) => void;
  reset: () => void;
}

export function useBlackjackSession(): BlackjackSession {
  const { report } = useTelemetry();
  const [status, setStatus] = useState<SessionStatus>("idle");
  const [view, setView] = useState<BlackjackView | null>(null);
  const [result, setResult] = useState<SessionResult | null>(null);
  const [stake, setStake] = useState<number>(0);

  const protocolRef = useRef<BlackjackProtocol | null>(null);
  const tunnelRef = useRef<OffchainTunnel<BlackjackState, BlackjackMove> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stakeRef = useRef<bigint>(0n);

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    stopTimer();
    protocolRef.current = null;
    tunnelRef.current = null;
    report.setActive(0);
    setStatus("idle");
    setView(null);
    setResult(null);
    setStake(0);
  }, [report, stopTimer]);

  const start = useCallback(
    (nextStake: number) => {
      stopTimer();
      // Stake must cover at least one wager; clamp to a whole multiple for clean play.
      const stakeBig = BigInt(Math.max(Number(WAGER), Math.floor(nextStake)));
      stakeRef.current = stakeBig;
      setStake(Number(stakeBig));

      const a = createParticipant("player-bot");
      const b = createParticipant("dealer-bot");
      const protocol = new BlackjackProtocol();
      const tunnelId =
        "0x" + a.address.slice(2, 10) + b.address.slice(2, 10) + Date.now().toString(16);
      const tunnel = OffchainTunnel.selfPlay(
        protocol,
        tunnelId,
        a.keyPair,
        b.keyPair,
        a.address,
        b.address,
        { a: stakeBig, b: stakeBig },
      );
      // Feed each co-signed update into the live panels.
      tunnel.onUpdate = (_u, bytes) =>
        report.bumpCounters({ updates: 1, signatures: 2, verifications: 2, bytes });

      protocolRef.current = protocol;
      tunnelRef.current = tunnel;
      report.bumpCounters({ tunnelsOpened: 1 });
      report.setActive(2);
      setResult(null);
      setStatus("playing");
      setView(deriveView(tunnel.state, stakeBig));

      timerRef.current = setInterval(() => {
        const p = protocolRef.current;
        const t = tunnelRef.current;
        if (!p || !t) return;
        const prevBalanceA = t.state.balanceA;
        const moved = stepSession(p, t, Math.random);
        setView(deriveView(t.state, stakeRef.current));

        // A settled round (now round_over with a balance change) => a panel txn.
        if (moved && t.state.phase === "round_over" && t.state.balanceA !== prevBalanceA) {
          const delta = t.state.balanceA - prevBalanceA;
          report.pushTxn({
            time: new Date().toLocaleTimeString("en-GB"),
            bot: "Player Bot",
            type: delta > 0n ? "Blackjack Win" : "Blackjack Loss",
            status: "Success",
            amount: `${delta > 0n ? "+" : "-"}$${Math.abs(Number(delta)).toFixed(2)}`,
          });
        }

        if (!moved || p.isTerminal(t.state)) {
          stopTimer();
          t.buildSettlement(0n); // co-signed cooperative settlement artifact
          report.bumpCounters({ tunnelsClosed: 1, settlements: 1 });
          report.setActive(0);
          setResult(sessionResult(t.state, stakeRef.current));
          setStatus("settled");
        }
      }, STEP_MS);
    },
    [report, stopTimer],
  );

  // Clean up the timer if the window unmounts mid-session.
  useEffect(() => stopTimer, [stopTimer]);

  return { status, view, result, stake, start, reset };
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS (exit 0).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/games/blackjack/useBlackjackSession.ts
git commit -m "feat(blackjack): tunnel self-play session hook"
```

---

## Task 7: Salvage assets + port pure presentational components

**Files:**
- Create: `frontend/src/games/blackjack/assets/**` (copied)
- Create: `frontend/src/games/blackjack/components/{LoadingModal,PageLoader,GameCardScale,SuitSpinner,Spinner}.tsx` (copied)
- Create: `frontend/src/games/blackjack/blackjack.css` (ported casino classes)
- Create: `frontend/src/games/blackjack/cardAssets.ts`

- [ ] **Step 1: Copy assets into the game folder**

```bash
cd /Users/alvin/Developer/dopamint-arena/frontend/src/games/blackjack
mkdir -p assets
cp -R packages/client/public/cards assets/cards
cp packages/client/public/dealer-desk.png assets/
cp packages/client/public/menu-background.png assets/
cp packages/client/public/card-back.png assets/
```

- [ ] **Step 2: Create the card asset resolver (Vite-only)**

```ts
// frontend/src/games/blackjack/cardAssets.ts
/**
 * Resolve bundled URLs for game-local card art. CardDisplay builds a card index
 * 0..51; this maps (suit,name) to the imported asset URL. Vite-only (import.meta.glob)
 * — never import this from a test.
 */
const SUITS = ["clubs", "diamonds", "hearts", "spades"] as const;
const NAMES = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;

const urls = import.meta.glob("./assets/cards/**/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

import cardBack from "./assets/card-back.png";

export function cardUrlFromIndex(cardIndex: number): string {
  const suit = SUITS[Math.floor(cardIndex / 13)];
  const name = NAMES[cardIndex % 13];
  return urls[`./assets/cards/${suit}/${suit}-${name}.svg`];
}

export const cardBackUrl: string = cardBack;
```

- [ ] **Step 3: Copy the pure components**

```bash
cd /Users/alvin/Developer/dopamint-arena/frontend/src/games/blackjack
mkdir -p components
cp packages/client/src/components/general/LoadingModal.tsx components/
cp packages/client/src/components/general/PageLoader.tsx components/
cp packages/client/src/components/general/GameCardScale.tsx components/
cp packages/client/src/components/general/SuitSpinner.tsx components/
cp packages/client/src/components/general/Spinner.tsx components/
```

- [ ] **Step 4: Fix imports/assets in the copied components**

Open each copied file under `components/` and:
- Replace any `@/` path-alias imports with correct relative paths within `components/`.
- In `PageLoader.tsx`, replace the `dealer-desk.png` / `menu-background.png` background references (previously `/dealer-desk.png` etc.) with imported URLs:
  ```ts
  import dealerDesk from "../assets/dealer-desk.png";
  import menuBackground from "../assets/menu-background.png";
  ```
  and use `style={{ backgroundImage: \`url(${dealerDesk})\` }}` (and `menuBackground` for the lobby theme) instead of the literal `/...png` path.
- Remove any `lucide-react` import in `Spinner.tsx` if `lucide-react` is not a frontend dependency; replace with a minimal inline spinner:
  ```tsx
  export function Spinner({ className = "" }: { className?: string }) {
    return <span className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent ${className}`} />;
  }
  ```

- [ ] **Step 5: Port the casino CSS**

Create `frontend/src/games/blackjack/blackjack.css` and copy the casino-specific classes from `packages/client/src/styles/globals.css`: `.casino-felt`, `.wood-rim`, `.text-gold`, `.gold-glow`, `.gold-glow-hover`, `.casino-chip`, `.menu-background`, `.fade-in-up` (+ its `@keyframes`), `.suit-anim` (+ its `@keyframes`). Do NOT copy Tailwind base/`@layer`/CSS-variable theme blocks (the frontend has its own Tailwind v4 setup). Adjust `.menu-background`'s `url(...)` to an imported asset if it references an image (or drop the background-image line and set it inline where used).

- [ ] **Step 6: Verify typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS. (If a copied component still references deleted modules, fix the import; do not pull in `@poc/shared`.)

- [ ] **Step 7: Commit**

```bash
git add frontend/src/games/blackjack/assets frontend/src/games/blackjack/components \
        frontend/src/games/blackjack/blackjack.css frontend/src/games/blackjack/cardAssets.ts
git commit -m "feat(blackjack): salvage assets and port pure components"
```

---

## Task 8: Port `CardDisplay` (sum-as-prop + game-local art)

**Files:**
- Create: `frontend/src/games/blackjack/components/CardDisplay.tsx` (ported + edited)

- [ ] **Step 1: Copy the file**

```bash
cd /Users/alvin/Developer/dopamint-arena/frontend/src/games/blackjack
cp packages/client/src/components/app/CardDisplay.tsx components/CardDisplay.tsx
```

- [ ] **Step 2: Edit the copied `CardDisplay.tsx`**

Apply these precise changes (keep all layout/markup otherwise):
- Remove the `getCardSum` import from `@poc/shared`.
- Add to the component props an explicit total: change the props interface to include `sum: number` and render that instead of `getCardSum(cards)`.
- Replace the inline SVG path construction `` `/cards/${suit}/${suit}-${name}.svg` `` with the bundled URL:
  ```tsx
  import { cardUrlFromIndex } from "../cardAssets";
  // ...for each card index:
  const src = cardUrlFromIndex(cardIndex);
  ```
  (The card index→suit/name math already lives in the component; feed `cardUrlFromIndex(cardIndex)` the index it already computes.)

The resulting prop shape is:
```tsx
interface CardDisplayProps {
  cards: number[];      // display indices 0..51
  sum: number;          // authoritative total from the SDK (handValue)
  title: string;
  isWinning?: boolean;
  isPlayer?: boolean;
  className?: string;
}
```

- [ ] **Step 3: Verify typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/games/blackjack/components/CardDisplay.tsx
git commit -m "feat(blackjack): port CardDisplay to SDK sum and local art"
```

---

## Task 9: `BetPanel` + `BlackjackTable` (ported layout, fed by the session)

**Files:**
- Create: `frontend/src/games/blackjack/components/BetPanel.tsx`
- Create: `frontend/src/games/blackjack/components/BlackjackTable.tsx`

- [ ] **Step 1: Create `BetPanel`**

```tsx
// frontend/src/games/blackjack/components/BetPanel.tsx
import { useState } from "react";

/** Idle-state control: the player only sets a stake; the bots play it out. */
export function BetPanel({ onDeal }: { onDeal: (stake: number) => void }) {
  const [stake, setStake] = useState<number>(500);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
      <p className="text-sm text-arena-text">Set a stake — two bots play it out.</p>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] uppercase text-arena-muted">Stake</span>
        <input
          id="blackjack-stake"
          name="stake"
          type="number"
          min={100}
          step={100}
          value={stake}
          onChange={(e) => setStake(Number(e.target.value))}
          className="w-40 rounded border border-arena-edge bg-arena-bg px-2 py-1.5 text-center text-arena-text"
        />
      </label>
      <button
        onClick={() => onDeal(stake)}
        className="rounded bg-arena-accent px-4 py-2 font-medium text-arena-bg hover:opacity-90"
      >
        Deal
      </button>
      <p className="text-[11px] text-arena-muted">
        Bots co-sign each move over a Sui tunnel; play runs until one is out of chips.
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Create `BlackjackTable`**

Port the visual layout of `packages/client/src/pages/PlayerGame.tsx` here, but fed by the session view (no `useBlackJack`, no action buttons). Use the inventory: dealer-desk background, dealer `CardDisplay` at top, player `CardDisplay` lower, a bottom HUD showing balances/round, and a result banner + a Play Again button on settle.

```tsx
// frontend/src/games/blackjack/components/BlackjackTable.tsx
import { CardDisplay } from "./CardDisplay";
import type { BlackjackView, SessionResult } from "../session-core";
import dealerDesk from "../assets/dealer-desk.png";

interface BlackjackTableProps {
  view: BlackjackView;
  result: SessionResult | null;
  settled: boolean;
  onPlayAgain: () => void;
}

export function BlackjackTable({ view, result, settled, onPlayAgain }: BlackjackTableProps) {
  return (
    <div
      className="relative flex h-full w-full flex-col justify-between bg-cover bg-center p-3 text-gold"
      style={{ backgroundImage: `url(${dealerDesk})` }}
    >
      <CardDisplay
        title="Dealer Bot"
        cards={view.dealerCards}
        sum={view.dealerSum}
        isWinning={settled && result === "lose"}
      />

      <div className="flex items-center justify-between text-xs">
        <span>Round {view.round}</span>
        <span>Player ${view.playerBalance} · Dealer ${view.dealerBalance}</span>
      </div>

      <CardDisplay
        title="Player Bot"
        cards={view.playerCards}
        sum={view.playerSum}
        isPlayer
        isWinning={settled && result === "win"}
      />

      {settled && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60">
          <p className="text-lg font-semibold text-gold">
            {result === "win" ? "Player Bot wins" : result === "lose" ? "Dealer Bot wins" : "Push"}
          </p>
          <button
            onClick={onPlayAgain}
            className="rounded bg-arena-accent px-4 py-2 font-medium text-arena-bg hover:opacity-90"
          >
            Play Again
          </button>
        </div>
      )}
    </div>
  );
}
```

Note: this is a faithful but compact port of the layout. Pull additional flourishes (confetti on win, chip styling via `.casino-chip`, the fan-out card rotation) from the original `PlayerGame.tsx`/`CardDisplay.tsx` as desired — they are presentational and already available in the ported components/CSS.

- [ ] **Step 3: Verify typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/games/blackjack/components/BetPanel.tsx frontend/src/games/blackjack/components/BlackjackTable.tsx
git commit -m "feat(blackjack): bet panel and self-play table view"
```

---

## Task 10: `BlackjackWindow` + register the real game

**Files:**
- Create: `frontend/src/games/blackjack/BlackjackWindow.tsx`
- Modify: `frontend/src/games/blackjack/index.ts`

- [ ] **Step 1: Create the window**

```tsx
// frontend/src/games/blackjack/BlackjackWindow.tsx
import type { GameWindowProps } from "../types";
import { useBlackjackSession } from "./useBlackjackSession";
import { BetPanel } from "./components/BetPanel";
import { BlackjackTable } from "./components/BlackjackTable";
import { GameCardScale } from "./components/GameCardScale";
import "./blackjack.css";

/** Bot-vs-bot Blackjack over a Sui tunnel. The player only sets a stake. */
export function BlackjackWindow(_props: GameWindowProps) {
  const { status, view, result, start, reset } = useBlackjackSession();

  if (status === "idle" || !view) {
    return <BetPanel onDeal={start} />;
  }

  return (
    <GameCardScale className="h-full w-full">
      <BlackjackTable
        view={view}
        result={result}
        settled={status === "settled"}
        onPlayAgain={reset}
      />
    </GameCardScale>
  );
}
```

- [ ] **Step 2: Register it (replace the placeholder)**

Replace `frontend/src/games/blackjack/index.ts` with:

```ts
import { register } from "../registry";
import { BlackjackWindow } from "./BlackjackWindow";

register({
  id: "blackjack",
  name: "Blackjack",
  icon: "🃏",
  Window: BlackjackWindow,
});
```

- [ ] **Step 3: Verify typecheck**

Run: `cd frontend && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/games/blackjack/BlackjackWindow.tsx frontend/src/games/blackjack/index.ts
git commit -m "feat(blackjack): register tunnel self-play window"
```

---

## Task 11: Delete the standalone monorepo + final verification

**Files:**
- Delete: `frontend/src/games/blackjack/packages/**` and the standalone tooling.

- [ ] **Step 1: Confirm nothing outside the game folder imports the old packages**

Run: `cd /Users/alvin/Developer/dopamint-arena && grep -rn "@poc/shared\|packages/client\|packages/server\|packages/shared" frontend/src --include=*.ts --include=*.tsx | grep -v "frontend/src/games/blackjack/packages"`
Expected: no matches (only the doomed `packages/` tree referenced them).

- [ ] **Step 2: Delete the standalone app**

```bash
cd /Users/alvin/Developer/dopamint-arena/frontend/src/games/blackjack
git rm -r packages
git rm -f docker-compose.yaml bun.lock tsconfig.base.json package.json .gitignore 2>/dev/null || true
ls -la   # expect: index.ts, README.md, BlackjackWindow.tsx, useBlackjackSession.ts,
         #         session-core.ts(+test), cards.ts(+test), cardAssets.ts, blackjack.css,
         #         assets/, components/
```

- [ ] **Step 3: Run the unit tests**

Run: `cd frontend && npm test`
Expected: PASS — all `cards.test.ts` and `session-core.test.ts` tests green, `fail 0`.

- [ ] **Step 4: Typecheck the whole frontend**

Run: `cd frontend && npm run typecheck`
Expected: PASS (exit 0).

- [ ] **Step 5: Production build (validates the `node:crypto` stub end-to-end)**

Run: `cd frontend && npm run build`
Expected: `tsc --noEmit` passes AND `vite build` completes with no "Could not resolve node:crypto" / "Buffer is not defined" errors. The blackjack chunk bundles the SDK via `@noble`.

- [ ] **Step 6: Manual smoke (optional but recommended)**

Run: `cd frontend && npm run dev`, open the app, connect the wallet gate, find the Blackjack window, set a stake, press Deal. Expected: cards deal, hands update every ~600ms, balances move, a result banner appears at terminal, and the Live Transactions Feed / TPS panels react.

- [ ] **Step 7: Commit**

```bash
cd /Users/alvin/Developer/dopamint-arena
git add -A
git commit -m "refactor(blackjack): remove standalone server app"
```

---

## Self-review notes (author)

- **Spec coverage**: replace-with-SDK-window (Tasks 7–11), off-chain client sim (Tasks 4/6), symmetric stake (Task 6 `{ a: stake, b: stake }`), play-until-bankrupt (`protocol.isTerminal` in Task 6), keep UI (Tasks 7–9 ports), card-model bridge (Tasks 3/8), `node:crypto` stub (Task 1), telemetry feed (Tasks 5/6), `node:test` driver tests (Tasks 3/4), assets game-local (Task 7). All covered.
- **Terminal decision** is made by `protocol.isTerminal(tunnel.state)` in the hook (authoritative); `deriveView.isTerminal` is display-only and documented as such.
- **Type consistency**: `BlackjackView`/`SessionResult` defined in `session-core.ts` (Task 4) and consumed unchanged in Tasks 6/9; `TelemetryWriter` defined in Task 5 and used in Task 6; `cardUrlFromIndex` defined in Task 7 and used in Task 8.
- **Known limitation**: the casino table renders small in the ~16rem desktop tile until drag/resize lands (`GameCardScale` keeps it legible).
```
