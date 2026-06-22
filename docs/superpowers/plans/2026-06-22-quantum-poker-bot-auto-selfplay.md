# Quantum Poker Bot/Auto Self-Play Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Quantum Poker's Bot and Auto lanes as local self-play (matching Battleship/TTT/Blackjack), keeping the persona system, and delete the bespoke poker Node server.

**Architecture:** Both lanes run `OffchainTunnel.selfPlay` over `QuantumPokerProtocol` with seat bots from the canonical `createQuantumPokerKit(...).createBot(...)`. Auto = two persistent localStorage bots (bot A self-signs the open), looping. Play-vs-Bot = ephemeral seats funded by the connected wallet, with party A's betting driven by the human and its commit/reveal automated. Both close via the gas-sponsored backend `/settle`.

**Tech Stack:** React + `@mysten/dapp-kit`, `sui-tunnel-ts` SDK (`OffchainTunnel`, `Transcript`), `node:test` via `tsx` for unit tests, Tailwind for UI.

## Global Constraints

- Per-seat stake: `QUANTUM_POKER_STAKE` = `10_000n` MIST (from `constants.ts`).
- Hands per tunnel cap: `QUANTUM_POKER_HAND_CAP` = `1000n` (from `constants.ts`).
- Close ALWAYS via `getControlPlaneClient().settle` (gas-sponsored); fallback to `closeCooperativeWithRoot` only on `/settle` failure.
- `OffchainTunnel.selfPlay` needs NO `moveCodec` (moves applied in-process).
- Personas drawn randomly from `DEFAULT_QUANTUM_POKER_BOT_PROFILES` per tunnel.
- Co-locate `*.test.ts` next to the unit. Tests are off-chain only (no funding/settle).
- Commits: Conventional Commits, subject ≤50 chars, imperative, lowercase after type, **no AI attribution** (per `CLAUDE.md`).
- Sessions live OUT of React via `registerWindowDisposer` (`@/lib/windowSessions`), mirroring battleship.

---

## File Structure

- Create `frontend/src/games/quantumPoker/bots.ts` — persistent poker bot wallets + funding (Auto only). Mirrors `battleship/engine/bots.ts`.
- Create `frontend/src/games/quantumPoker/bots.test.ts` — bots persistence/threshold unit test.
- Create `frontend/src/games/quantumPoker/pokerSelfPlay.ts` — pure engine: auto stepper, human router, legal-action computation, persona pick, run-to-end (testable, no React/on-chain).
- Create `frontend/src/games/quantumPoker/pokerSelfPlay.test.ts` — engine self-play + human router tests.
- Create `frontend/src/games/quantumPoker/pokerSettle.ts` — shared settle helper (`/settle` + fallback).
- Create `frontend/src/games/quantumPoker/useQuantumPokerAuto.ts` — Auto session (mirror `useBattleshipAuto.ts`).
- Create `frontend/src/games/quantumPoker/useQuantumPokerBot.ts` — Play-vs-Bot session (mirror `useBattleship.ts`).
- Rewrite `frontend/src/games/quantumPoker/QuantumPokerBotVsBotWindow.tsx` — Auto view (uses `useQuantumPokerAuto`).
- Rewrite `frontend/src/games/quantumPoker/QuantumPokerWindow.tsx` — Bot lane table + human action bar (uses `useQuantumPokerBot`).
- Modify `frontend/src/games/quantumPoker/index.ts` — update lane comment.
- Delete `serverClient.ts`, `serverRuntime.ts`, `runtime.ts`, `packages/server/`.

---

## Task 1: Persistent poker bot wallets (`bots.ts`)

**Files:**
- Create: `frontend/src/games/quantumPoker/bots.ts`
- Test: `frontend/src/games/quantumPoker/bots.test.ts`

**Interfaces:**
- Consumes: `sui-tunnel-ts/core/crypto` (`generateKeyPair`, `keyPairFromSecret`, `KeyPair`), `@mysten/sui` keypair/tx/faucet utils.
- Produces:
  - `interface QuantumPokerBot { coreKey: KeyPair; keypair: Ed25519Keypair; address: string; publicKey: Uint8Array }`
  - `loadOrCreateQuantumPokerBots(): { A: QuantumPokerBot; B: QuantumPokerBot }`
  - `botBalances(client, bots): Promise<{ a: bigint; b: bigint }>`
  - `buildFundBotsTx(bots, perBotMist?): Transaction`
  - `fundBotsFromFaucet(client, bots): Promise<{ a: string; b: string }>`
  - `MIN_PLAY_MIST: bigint`, `FUND_PER_BOT_MIST: number`
  - `interface BotReadClient { getBalance(input:{owner:string}): Promise<{totalBalance:string}> }`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/games/quantumPoker/bots.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadOrCreateQuantumPokerBots, MIN_PLAY_MIST } from "./bots";

// Minimal localStorage shim for node:test (jsdom-free).
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage;

test("loadOrCreateQuantumPokerBots persists the same two identities", () => {
  const first = loadOrCreateQuantumPokerBots();
  const second = loadOrCreateQuantumPokerBots();
  assert.equal(first.A.address, second.A.address);
  assert.equal(first.B.address, second.B.address);
  assert.notEqual(first.A.address, first.B.address);
});

test("bot off-chain and on-chain public keys match", () => {
  const { A } = loadOrCreateQuantumPokerBots();
  assert.equal(
    Buffer.from(A.coreKey.publicKey).toString("hex"),
    Buffer.from(A.keypair.getPublicKey().toRawBytes()).toString("hex"),
  );
});

test("MIN_PLAY_MIST covers one open plus both stakes", () => {
  // 0.02 SUI must exceed 2x stake (20_000 MIST) by a wide margin for gas.
  assert.ok(MIN_PLAY_MIST > 20_000n);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx tsx --test src/games/quantumPoker/bots.test.ts`
Expected: FAIL — `Cannot find module './bots'`.

- [ ] **Step 3: Write the implementation**

```ts
// frontend/src/games/quantumPoker/bots.ts
/**
 * Two persistent on-chain bot identities for autonomous Quantum Poker self-play.
 * Mirrors battleship/ttt: each bot owns ONE ed25519 seed used both off-chain
 * (SDK KeyPair, co-signs tunnel state) and on-chain (@mysten/sui Ed25519Keypair,
 * signs open/close). Keys persist in localStorage so funding once covers many
 * tunnels — stakes are returned at each cooperative close, only gas is spent.
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { fromHex, toHex } from "@mysten/sui/utils";
import { requestSuiFromFaucetV2, getFaucetHost } from "@mysten/sui/faucet";
import {
  generateKeyPair,
  keyPairFromSecret,
  type KeyPair,
} from "sui-tunnel-ts/core/crypto";

export interface QuantumPokerBot {
  coreKey: KeyPair;
  keypair: Ed25519Keypair;
  address: string;
  publicKey: Uint8Array;
}

/** Below this gas balance (0.02 SUI) a bot can't reliably open another tunnel. */
export const MIN_PLAY_MIST = 20_000_000n;
/** Default top-up per bot when funding from the connected wallet: 0.1 SUI. */
export const FUND_PER_BOT_MIST = 100_000_000;

const STORAGE_A = "quantum_poker_bot_a";
const STORAGE_B = "quantum_poker_bot_b";

export interface BotReadClient {
  getBalance(input: { owner: string }): Promise<{ totalBalance: string }>;
}

function loadOrCreateBot(storageKey: string): QuantumPokerBot {
  let seed: Uint8Array;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(storageKey);
  } catch {
    /* ignore */
  }
  if (stored) {
    seed = fromHex(stored);
  } else {
    seed = generateKeyPair().secretKey;
    try {
      localStorage.setItem(storageKey, toHex(seed));
    } catch {
      /* ignore */
    }
  }
  const coreKey = keyPairFromSecret(seed);
  const keypair = Ed25519Keypair.fromSecretKey(seed);
  const address = keypair.getPublicKey().toSuiAddress();
  if (toHex(coreKey.publicKey) !== toHex(keypair.getPublicKey().toRawBytes())) {
    throw new Error("bot off/on-chain pubkey mismatch");
  }
  return { coreKey, keypair, address, publicKey: coreKey.publicKey };
}

export function loadOrCreateQuantumPokerBots(): {
  A: QuantumPokerBot;
  B: QuantumPokerBot;
} {
  return { A: loadOrCreateBot(STORAGE_A), B: loadOrCreateBot(STORAGE_B) };
}

export function buildFundBotsTx(
  bots: { A: QuantumPokerBot; B: QuantumPokerBot },
  perBotMist: number = FUND_PER_BOT_MIST,
): Transaction {
  const tx = new Transaction();
  const [coinA, coinB] = tx.splitCoins(tx.gas, [perBotMist, perBotMist]);
  tx.transferObjects([coinA], bots.A.address);
  tx.transferObjects([coinB], bots.B.address);
  return tx;
}

export async function botBalances(
  client: BotReadClient,
  bots: { A: QuantumPokerBot; B: QuantumPokerBot },
): Promise<{ a: bigint; b: bigint }> {
  const [ba, bb] = await Promise.all([
    client.getBalance({ owner: bots.A.address }),
    client.getBalance({ owner: bots.B.address }),
  ]);
  return { a: BigInt(ba.totalBalance), b: BigInt(bb.totalBalance) };
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function faucetStatus(recipient: string): Promise<string> {
  try {
    const res = await requestSuiFromFaucetV2({
      host: getFaucetHost("testnet"),
      recipient,
    });
    return res.status === "Success" ? "ok" : JSON.stringify(res.status);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export async function fundBotsFromFaucet(
  client: BotReadClient,
  bots: { A: QuantumPokerBot; B: QuantumPokerBot },
): Promise<{ a: string; b: string }> {
  const [a, b] = await Promise.all([
    faucetStatus(bots.A.address),
    faucetStatus(bots.B.address),
  ]);
  for (let i = 0; i < 10; i++) {
    const bal = await botBalances(client, bots);
    if (bal.a >= MIN_PLAY_MIST && bal.b >= MIN_PLAY_MIST) break;
    await wait(1500);
  }
  return { a, b };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx tsx --test src/games/quantumPoker/bots.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/quantumPoker/bots.ts frontend/src/games/quantumPoker/bots.test.ts
git commit -m "feat(poker): add persistent self-play bot wallets"
```

---

## Task 2: Pure self-play engine (`pokerSelfPlay.ts`)

**Files:**
- Create: `frontend/src/games/quantumPoker/pokerSelfPlay.ts`
- Test: `frontend/src/games/quantumPoker/pokerSelfPlay.test.ts`

**Interfaces:**
- Consumes: `OffchainTunnel` (`sui-tunnel-ts/core/tunnel`), `PokerState`/`PokerMove`/`PokerPhase`/`QuantumPokerProtocol` (`sui-tunnel-ts/protocol/quantumPoker`), `Party`/`otherParty` (`sui-tunnel-ts/protocol/Protocol`), `createQuantumPokerKit` (`@/agent/games/quantumPoker/kit`), `BotContext`/`GameBot` (`@/agent/gameKit`), `DEFAULT_QUANTUM_POKER_BOT_PROFILES`/`QuantumPokerBotProfile` (`sui-tunnel-ts/protocol/quantumPokerPersona`).
- Produces:
  - `type PokerTunnel = OffchainTunnel<PokerState, PokerMove>`
  - `type PokerSeatBot = GameBot<PokerState, PokerMove>`
  - `LIVE_BOT_CONTEXT: BotContext`
  - `randomPokerPersona(rng): QuantumPokerBotProfile`
  - `makeSeatBot(seat, stake, handCap, profile, ctx): PokerSeatBot`
  - `isHumanBettingTurn(state, humanSeat): boolean`
  - `interface PokerLegalActions { canFold; canCheck; canCall; callAmount; minBet; maxBet }` (all `boolean`/`bigint`)
  - `legalPokerActions(state, seat): PokerLegalActions`
  - `stepPokerAuto(tunnel, botA, botB, timestamp): { by: Party; move: PokerMove } | null`
  - `runPokerSelfPlayToEnd(tunnel, botA, botB, maxSteps): number`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/games/quantumPoker/pokerSelfPlay.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import { keyPairFromRng } from "sui-tunnel-ts/core/crypto";
import { ed25519Address } from "sui-tunnel-ts/core/crypto";
import { QuantumPokerProtocol } from "sui-tunnel-ts/protocol/quantumPoker";
import type { BotContext } from "@/agent/gameKit";
import {
  makeSeatBot,
  stepPokerAuto,
  runPokerSelfPlayToEnd,
  legalPokerActions,
} from "./pokerSelfPlay";

function mulberry32(seed: number) {
  let v = seed;
  return () => {
    v |= 0;
    v = (v + 0x6d2b79f5) | 0;
    let t = Math.imul(v ^ (v >>> 15), 1 | v);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STAKE = 10_000n;
const HAND_CAP = 3n; // small cap → terminal fast in tests

function newTunnel() {
  const keyRng = mulberry32(99);
  const a = keyPairFromRng(keyRng);
  const b = keyPairFromRng(keyRng);
  const protocol = new QuantumPokerProtocol(HAND_CAP);
  return OffchainTunnel.selfPlay(
    protocol,
    "0x" + "51".repeat(32),
    a,
    b,
    ed25519Address(a.publicKey),
    ed25519Address(b.publicKey),
    { a: STAKE, b: STAKE },
  );
}

test("two personas self-play a full poker tunnel to done, balance conserved", () => {
  const tunnel = newTunnel();
  const ctx: BotContext = { rngForSeat: (s) => mulberry32(s === "A" ? 1 : 2) };
  const botA = makeSeatBot("A", STAKE, HAND_CAP, { name: "Nari", persona: "tight" }, ctx);
  const botB = makeSeatBot("B", STAKE, HAND_CAP, { name: "Jules", persona: "loose" }, ctx);

  const steps = runPokerSelfPlayToEnd(tunnel, botA, botB, 5000);

  assert.equal(tunnel.state.phase, "done");
  assert.ok(steps > 0 && steps < 5000);
  assert.equal(tunnel.state.balanceA + tunnel.state.balanceB, STAKE * 2n);
});

test("stepPokerAuto returns null at terminal", () => {
  const tunnel = newTunnel();
  const ctx: BotContext = { rngForSeat: (s) => mulberry32(s === "A" ? 1 : 2) };
  const botA = makeSeatBot("A", STAKE, HAND_CAP, { name: "Nari", persona: "tight" }, ctx);
  const botB = makeSeatBot("B", STAKE, HAND_CAP, { name: "Jules", persona: "loose" }, ctx);
  runPokerSelfPlayToEnd(tunnel, botA, botB, 5000);
  assert.equal(stepPokerAuto(tunnel, botA, botB, 1n), null);
});

test("legalPokerActions allows check when nobody has bet this street", () => {
  const tunnel = newTunnel();
  const ctx: BotContext = { rngForSeat: (s) => mulberry32(s === "A" ? 1 : 2) };
  const botA = makeSeatBot("A", STAKE, HAND_CAP, { name: "Nari", persona: "tight" }, ctx);
  const botB = makeSeatBot("B", STAKE, HAND_CAP, { name: "Jules", persona: "loose" }, ctx);
  // Advance until a betting phase with equal street bets is reached.
  let ts = 1n;
  for (let i = 0; i < 200; i++) {
    const s = tunnel.state;
    if (
      (s.phase === "preflop_bet" || s.phase === "flop_bet") &&
      s.streetBetA === s.streetBetB
    ) {
      const acts = legalPokerActions(s, s.toAct);
      assert.equal(acts.canCheck, true);
      assert.equal(acts.callAmount, 0n);
      return;
    }
    if (!stepPokerAuto(tunnel, botA, botB, ts++)) break;
  }
  assert.fail("never reached an unbet betting street");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx tsx --test src/games/quantumPoker/pokerSelfPlay.test.ts`
Expected: FAIL — `Cannot find module './pokerSelfPlay'`.

- [ ] **Step 3: Write the implementation**

```ts
// frontend/src/games/quantumPoker/pokerSelfPlay.ts
// Pure, React-free, on-chain-free engine for poker self-play. Shared by the Auto
// loop and the Play-vs-Bot router, and unit-tested off-chain.
import type { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import {
  type PokerMove,
  type PokerPhase,
  type PokerState,
} from "sui-tunnel-ts/protocol/quantumPoker";
import {
  DEFAULT_QUANTUM_POKER_BOT_PROFILES,
  type QuantumPokerBotProfile,
} from "sui-tunnel-ts/protocol/quantumPokerPersona";
import { createQuantumPokerKit } from "@/agent/games/quantumPoker/kit";
import type { BotContext, GameBot } from "@/agent/gameKit";

export type PokerTunnel = OffchainTunnel<PokerState, PokerMove>;
export type PokerSeatBot = GameBot<PokerState, PokerMove>;

/** Real-time RNG context for kit bots (live play, not a seeded replay). */
export const LIVE_BOT_CONTEXT: BotContext = { rngForSeat: () => Math.random };

const BETTING_PHASES: ReadonlySet<PokerPhase> = new Set([
  "preflop_bet",
  "flop_bet",
  "turn_bet",
  "river_bet",
]);

export function randomPokerPersona(rng: () => number): QuantumPokerBotProfile {
  const list = DEFAULT_QUANTUM_POKER_BOT_PROFILES;
  return list[Math.floor(rng() * list.length)];
}

/** One canonical kit bot for a seat with a chosen persona. */
export function makeSeatBot(
  seat: Party,
  stake: bigint,
  handCap: bigint,
  profile: QuantumPokerBotProfile,
  ctx: BotContext,
): PokerSeatBot {
  return createQuantumPokerKit(stake, handCap, { profile }).createBot(
    seat,
    ctx,
  ) as PokerSeatBot;
}

export function isHumanBettingTurn(
  state: PokerState,
  humanSeat: Party,
): boolean {
  return BETTING_PHASES.has(state.phase) && state.toAct === humanSeat;
}

export interface PokerLegalActions {
  canFold: boolean;
  canCheck: boolean;
  canCall: boolean;
  /** MIST needed to call (clamped to the effective stack). */
  callAmount: bigint;
  /** Minimum legal `bet` move amount (raise increment); 0n if no raise is possible. */
  minBet: bigint;
  /** Maximum `bet` amount = remaining effective stack. */
  maxBet: bigint;
}

/** Legal betting options for `seat`, computed from public state (mirrors the
 *  protocol's bet/call/check rules: a bet must raise above the opponent's street
 *  bet, and nothing may exceed the effective (shorter) stack). */
export function legalPokerActions(
  s: PokerState,
  seat: Party,
): PokerLegalActions {
  const myStreet = seat === "A" ? s.streetBetA : s.streetBetB;
  const oppStreet = seat === "A" ? s.streetBetB : s.streetBetA;
  const myTotal = seat === "A" ? s.totalBetA : s.totalBetB;
  const effStack = s.balanceA < s.balanceB ? s.balanceA : s.balanceB;
  const available = effStack - myTotal > 0n ? effStack - myTotal : 0n;
  const toCall = oppStreet > myStreet ? oppStreet - myStreet : 0n;
  const callAmount = toCall <= available ? toCall : available;
  return {
    canFold: true,
    canCheck: toCall === 0n,
    canCall: toCall > 0n && available > 0n,
    callAmount,
    minBet: available > toCall ? toCall + 1n : 0n,
    maxBet: available,
  };
}

/** Apply exactly one auto move for whichever seat has one. Null = terminal/idle. */
export function stepPokerAuto(
  tunnel: PokerTunnel,
  botA: PokerSeatBot,
  botB: PokerSeatBot,
  timestamp: bigint,
): { by: Party; move: PokerMove } | null {
  const s = tunnel.state;
  if (s.phase === "done") return null;
  const order: Party[] = ["A", "B"];
  for (const by of order) {
    const bot = by === "A" ? botA : botB;
    const move = bot.plan(s);
    if (!move) continue;
    tunnel.step(move, by, { timestamp });
    bot.confirm(s, move);
    return { by, move };
  }
  return null;
}

/** Drive both seats to `phase==="done"`. Returns the number of moves applied. */
export function runPokerSelfPlayToEnd(
  tunnel: PokerTunnel,
  botA: PokerSeatBot,
  botB: PokerSeatBot,
  maxSteps: number,
): number {
  let steps = 0;
  let ts = 1n;
  while (steps < maxSteps && tunnel.state.phase !== "done") {
    const r = stepPokerAuto(tunnel, botA, botB, ts++);
    if (!r) break;
    steps += 1;
  }
  return steps;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx tsx --test src/games/quantumPoker/pokerSelfPlay.test.ts`
Expected: PASS (3 tests). If `ed25519Address` is not exported from `core/crypto`, import it from where `runtime.ts` did (`sui-tunnel-ts/core/crypto`) — confirm with `grep -n "ed25519Address" sui-tunnel-ts/src/core/crypto.ts`.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/quantumPoker/pokerSelfPlay.ts frontend/src/games/quantumPoker/pokerSelfPlay.test.ts
git commit -m "feat(poker): add pure self-play engine and legal actions"
```

---

## Task 3: Human router step (extend `pokerSelfPlay.ts`)

**Files:**
- Modify: `frontend/src/games/quantumPoker/pokerSelfPlay.ts`
- Test: `frontend/src/games/quantumPoker/pokerSelfPlay.test.ts` (append)

**Interfaces:**
- Consumes: everything from Task 2.
- Produces:
  - `type PokerHumanStep = { kind: "applied"; by: Party; move: PokerMove } | { kind: "await-human" } | { kind: "idle" }`
  - `stepPokerWithHuman(tunnel, botA, botB, humanSeat, timestamp): PokerHumanStep`
  - `applyHumanMove(tunnel, botA, humanSeat, move, timestamp): void`

- [ ] **Step 1: Write the failing test (append to pokerSelfPlay.test.ts)**

```ts
import { stepPokerWithHuman, applyHumanMove } from "./pokerSelfPlay";

test("human router pauses on the human's betting turn but auto-runs everything else", () => {
  const tunnel = newTunnel();
  const ctx: BotContext = { rngForSeat: (s) => mulberry32(s === "A" ? 1 : 2) };
  const botA = makeSeatBot("A", STAKE, HAND_CAP, { name: "You", persona: "balanced" }, ctx);
  const botB = makeSeatBot("B", STAKE, HAND_CAP, { name: "Jules", persona: "loose" }, ctx);

  let ts = 1n;
  let awaited = false;
  for (let i = 0; i < 500; i++) {
    const r = stepPokerWithHuman(tunnel, botA, botB, "A", ts++);
    if (r.kind === "idle") break;
    if (r.kind === "await-human") {
      awaited = true;
      // Human always checks/calls to keep the hand moving.
      const s = tunnel.state;
      const move: import("sui-tunnel-ts/protocol/quantumPoker").PokerMove =
        s.streetBetA === s.streetBetB ? { kind: "check" } : { kind: "call" };
      applyHumanMove(tunnel, botA, "A", move, ts++);
    } else {
      // Auto step must never be a betting move BY the human seat A.
      if (r.by === "A") {
        assert.ok(!["bet", "check", "call", "fold"].includes(r.move.kind));
      }
    }
  }
  assert.equal(awaited, true);
  assert.equal(tunnel.state.phase, "done");
  assert.equal(tunnel.state.balanceA + tunnel.state.balanceB, STAKE * 2n);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx tsx --test src/games/quantumPoker/pokerSelfPlay.test.ts`
Expected: FAIL — `stepPokerWithHuman` not exported.

- [ ] **Step 3: Add the implementation (append to pokerSelfPlay.ts)**

```ts
export type PokerHumanStep =
  | { kind: "applied"; by: Party; move: PokerMove }
  | { kind: "await-human" }
  | { kind: "idle" };

/** Like stepPokerAuto, but yields control on the human seat's BETTING turn.
 *  The human seat's mechanical moves (commit/reveal/next_hand) still auto-run via
 *  its kit bot — only bet/check/call/fold wait for the human. */
export function stepPokerWithHuman(
  tunnel: PokerTunnel,
  botA: PokerSeatBot,
  botB: PokerSeatBot,
  humanSeat: Party,
  timestamp: bigint,
): PokerHumanStep {
  const s = tunnel.state;
  if (s.phase === "done") return { kind: "idle" };
  if (isHumanBettingTurn(s, humanSeat)) return { kind: "await-human" };
  const r = stepPokerAuto(tunnel, botA, botB, timestamp);
  return r ? { kind: "applied", by: r.by, move: r.move } : { kind: "idle" };
}

/** Apply a human-chosen move for `humanSeat`; advances its kit bot's memory. */
export function applyHumanMove(
  tunnel: PokerTunnel,
  humanBot: PokerSeatBot,
  humanSeat: Party,
  move: PokerMove,
  timestamp: bigint,
): void {
  const s = tunnel.state;
  tunnel.step(move, humanSeat, { timestamp });
  humanBot.confirm(s, move);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx tsx --test src/games/quantumPoker/pokerSelfPlay.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/quantumPoker/pokerSelfPlay.ts frontend/src/games/quantumPoker/pokerSelfPlay.test.ts
git commit -m "feat(poker): add human-vs-bot move router"
```

---

## Task 4: Shared settle helper (`pokerSettle.ts`)

**Files:**
- Create: `frontend/src/games/quantumPoker/pokerSettle.ts`

**Interfaces:**
- Consumes: `Transcript` (`sui-tunnel-ts/proof/transcript`), `getControlPlaneClient` (`@/backend/controlPlane`), `coSignedToSettleRequest` (`@/backend/settleRequest`), `closeCooperativeWithRoot`/`SignExec`/`SuiReads`/`readCreatedAt` (`@/onchain/tunnelTx`), `PokerTunnel` (Task 2).
- Produces: `settlePokerTunnel(opts): Promise<void>` where `opts = { tunnel: PokerTunnel; transcript: Transcript; tunnelId: string; createdAt: bigint; fallbackSignExec: SignExec }`.

- [ ] **Step 1: Write the implementation** (settlement is exercised end-to-end by the Auto/Bot sessions; no isolated unit test — the off-chain engine is covered in Tasks 2–3, and `/settle` is already covered by battleship/caro.)

```ts
// frontend/src/games/quantumPoker/pokerSettle.ts
// Cooperative close for a poker self-play tunnel: build the root-anchored
// settlement, both seats co-sign in-process, then submit via the gas-sponsored
// backend /settle (Walrus). Fall back to a party-paid on-chain close if /settle
// is down. Mirrors useBattleshipAuto's settle path.
import type { Transcript } from "sui-tunnel-ts/proof/transcript";
import { getControlPlaneClient } from "@/backend/controlPlane";
import { coSignedToSettleRequest } from "@/backend/settleRequest";
import {
  closeCooperativeWithRoot,
  type SignExec,
} from "@/onchain/tunnelTx";
import type { PokerTunnel } from "./pokerSelfPlay";

export async function settlePokerTunnel(opts: {
  tunnel: PokerTunnel;
  transcript: Transcript;
  tunnelId: string;
  createdAt: bigint;
  fallbackSignExec: SignExec;
}): Promise<void> {
  const settlement = opts.tunnel.buildSettlementWithRoot(
    opts.createdAt,
    opts.transcript.root(),
    0n,
  );
  try {
    await getControlPlaneClient().settle(
      opts.tunnelId,
      coSignedToSettleRequest(settlement, opts.transcript.toRecord().entries),
    );
  } catch (e) {
    console.error("[poker] backend settle failed; bot-key close:", e);
    await closeCooperativeWithRoot({
      signExec: opts.fallbackSignExec,
      tunnelId: opts.tunnelId,
      settlement,
    });
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: no new errors in `pokerSettle.ts`. If `buildSettlementWithRoot` arg/return types mismatch, confirm against `useBattleshipAuto.ts:499` and `sui-tunnel-ts/core/tunnel.ts`.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/games/quantumPoker/pokerSettle.ts
git commit -m "feat(poker): add shared root-anchored settle helper"
```

---

## Task 5: Auto session hook (`useQuantumPokerAuto.ts`)

**Files:**
- Create: `frontend/src/games/quantumPoker/useQuantumPokerAuto.ts`

**Interfaces:**
- Consumes: `bots.ts` (Task 1), `pokerSelfPlay.ts` (Tasks 2–3), `pokerSettle.ts` (Task 4), `OffchainTunnel.selfPlay`, `Transcript`, `openAndFundSelfPlay`/`readCreatedAt`/`SignExec` (`@/onchain/tunnelTx`), `registerWindowDisposer` (`@/lib/windowSessions`), dapp-kit hooks, `QUANTUM_POKER_STAKE`/`QUANTUM_POKER_HAND_CAP` (`./constants`).
- Produces: `useQuantumPokerAuto(windowId): QuantumPokerAutoSession` with snapshot fields `{ status: "idle"|"funding"|"running"|"ended"|"error"; personas: { a: string; b: string } | null; score: { a: number; b: number }; tunnels: number; actions: number; balances: { a: bigint; b: bigint }; funded: boolean; canFundFromWallet: boolean; error: string | null }` and actions `{ fund(); fundFromWallet(); startAuto(); stopAuto(); reset() }`.

**Implementation guidance:** Copy `useBattleshipAuto.ts` structure verbatim (the `AutoSession` class kept out of React, `useSyncExternalStore`, `registerWindowDisposer`, faucet/wallet funding, gen-guarded loop, `botSignExec`). Apply these poker-specific changes:

- [ ] **Step 1: Scaffold from the battleship template**

```bash
cp frontend/src/games/battleship/useBattleshipAuto.ts \
   frontend/src/games/quantumPoker/useQuantumPokerAuto.ts
```

- [ ] **Step 2: Swap battleship internals for poker**

Make these edits in `useQuantumPokerAuto.ts`:

1. Imports: replace battleship `bots`/protocol/view/kit imports with:

```ts
import { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import { Transcript } from "sui-tunnel-ts/proof/transcript";
import { registerWindowDisposer } from "@/lib/windowSessions";
import {
  openAndFundSelfPlay,
  readCreatedAt,
  type SignExec,
} from "@/onchain/tunnelTx";
import { QUANTUM_POKER_STAKE, QUANTUM_POKER_HAND_CAP } from "./constants";
import {
  loadOrCreateQuantumPokerBots,
  botBalances,
  buildFundBotsTx,
  fundBotsFromFaucet,
  MIN_PLAY_MIST,
  type QuantumPokerBot,
  type BotReadClient,
} from "./bots";
import {
  makeSeatBot,
  randomPokerPersona,
  runPokerSelfPlayToEnd,
  LIVE_BOT_CONTEXT,
  type PokerSeatBot,
  type PokerTunnel,
} from "./pokerSelfPlay";
import { settlePokerTunnel } from "./pokerSettle";
```

2. Constants: `const STAKE = QUANTUM_POKER_STAKE;` and `const HAND_CAP = QUANTUM_POKER_HAND_CAP;`. Remove `LOCKED_PER_SEAT`/battleship `STAKE`/placement/difficulty fields. (Self-play locks `STAKE` for both seats.)

3. `bots` field: `private readonly bots = loadOrCreateQuantumPokerBots();`.

4. Per-tunnel setup inside `runMatch` (replace the battleship fleet/secret/placement block):

```ts
// Random personas per tunnel.
const personaA = randomPokerPersona(Math.random);
const personaB = randomPokerPersona(Math.random);
this.personas = { a: personaA.name, b: personaB.name };
const botA: PokerSeatBot = makeSeatBot("A", STAKE, HAND_CAP, personaA, LIVE_BOT_CONTEXT);
const botB: PokerSeatBot = makeSeatBot("B", STAKE, HAND_CAP, personaB, LIVE_BOT_CONTEXT);
```

5. Open + tunnel (replace battleship's `openAndFundSelfPlay` call args with equal `STAKE` and poker keys):

```ts
const tunnelId = await openAndFundSelfPlay({
  reads,
  signExec: this.botSignExec(this.bots.A),
  partyA: { address: this.bots.A.address, publicKey: this.bots.A.publicKey },
  partyB: { address: this.bots.B.address, publicKey: this.bots.B.publicKey },
  aAmount: STAKE,
  bAmount: STAKE,
});
const createdAt = await readCreatedAt(reads, tunnelId);
const transcript = new Transcript(tunnelId);
const tunnel: PokerTunnel = OffchainTunnel.selfPlay(
  new QuantumPokerProtocol(HAND_CAP), // import QuantumPokerProtocol from sui-tunnel-ts/protocol/quantumPoker
  tunnelId,
  this.bots.A.coreKey,
  this.bots.B.coreKey,
  this.bots.A.address,
  this.bots.B.address,
  { a: STAKE, b: STAKE },
);
tunnel.onUpdate = (u, bytes) => {
  transcript.append(u);
  this.deps?.report.bumpCounters({ updates: 1, signatures: 2, verifications: 2, bytes });
};
```

6. Play (replace battleship `playMatch` with the engine, paced for watchability):

```ts
this.stage = "playing";
this.pushView();
let ts = 1n;
const SPACE_MS = 60; // spectator pacing per move
while (tunnel.state.phase !== "done") {
  if (this.gen !== myGen) return;
  const r = stepPokerAuto(tunnel, botA, botB, ts++); // import stepPokerAuto
  if (!r) break;
  this.actions += 1;
  this.pushView();
  await sleep(SPACE_MS);
}
```

7. Settle (replace battleship settle block):

```ts
this.stage = "settling";
this.pushView();
this.deps.report.bumpCounters({ tunnelsClosed: 1, settlements: 1 });
await settlePokerTunnel({
  tunnel,
  transcript,
  tunnelId,
  createdAt,
  fallbackSignExec: this.botSignExec(this.bots.A),
});
```

8. Scoreboard (`bookMatch`): poker winner is `tunnel.state.lastResult?.winner` or compare final `balanceA`/`balanceB`. Use:

```ts
const st = this.tunnel?.state;
if (st && st.balanceA > st.balanceB) this.score.a += 1;
else if (st && st.balanceB > st.balanceA) this.score.b += 1;
// ties: no increment
```

9. Snapshot: replace battleship `view` with the fields listed under **Produces** (`personas`, `score`, `tunnels` (=`match`), `actions`, `balances`, `funded`, `canFundFromWallet`, `status`, `error`). Keep `MIN_PLAY_MIST` gating in `funded`. Keep `botSignExec`, `fund`, `fundFromWallet`, `refreshBalances`, `ensureBalances`, `startAuto`/`stopAuto`/`reset`/`dispose` from the template (they are bot-agnostic). Rename `getAutoSession`/`autoSessions`/`registerWindowDisposer` label to `"quantum-poker-auto"`.

- [ ] **Step 3: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors in `useQuantumPokerAuto.ts`.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/games/quantumPoker/useQuantumPokerAuto.ts
git commit -m "feat(poker): add auto self-play session hook"
```

---

## Task 6: Auto window (`QuantumPokerBotVsBotWindow.tsx`)

**Files:**
- Rewrite: `frontend/src/games/quantumPoker/QuantumPokerBotVsBotWindow.tsx`

**Interfaces:**
- Consumes: `useQuantumPokerAuto` (Task 5), `GameWindowProps` (`../types`).
- Produces: default-shaped `QuantumPokerBotVsBotWindow({ windowId, onExit })` component.

- [ ] **Step 1: Replace the server-driven body with the hook-driven view**

Replace the ENTIRE file. Remove all `QuantumPokerServerClient`/`runBotVsBot` usage. Render from `useQuantumPokerAuto(windowId)`: a fund gate (Faucet / Fund from wallet) when `!funded`, then a Start/Stop control, a scoreboard (`score.a`/`score.b`), the current `personas`, both `balances`, `tunnels`, `actions`, `status`, and `error`.

```tsx
import type { CSSProperties } from "react";
import type { GameWindowProps } from "../types";
import { useQuantumPokerAuto } from "./useQuantumPokerAuto";

const STYLE: CSSProperties & Record<`--${string}`, string> = {
  "--qp-ink": "#090d12",
  "--qp-gold": "#f7c45b",
  "--qp-green": "#2dd4bf",
  "--qp-rail": "#151a20",
};

function sui(mist: bigint): string {
  return (Number(mist) / 1e9).toFixed(3);
}

export function QuantumPokerBotVsBotWindow({
  windowId,
  onExit,
}: GameWindowProps & { onExit?: () => void }) {
  const s = useQuantumPokerAuto(windowId);
  const running = s.status === "running";

  return (
    <div
      style={STYLE}
      className="flex h-full min-h-[14rem] flex-col overflow-hidden bg-[var(--qp-ink)] text-slate-100"
    >
      <header className="flex h-8 shrink-0 items-center justify-between border-b border-white/10 bg-[var(--qp-rail)] px-2">
        <div className="flex items-center gap-1.5">
          {onExit && (
            <button
              type="button"
              onClick={onExit}
              disabled={running}
              className="h-5 rounded-sm border border-white/10 px-1.5 text-[10px] text-slate-300 disabled:opacity-40"
            >
              Back
            </button>
          )}
          <span className="rounded-sm bg-[var(--qp-gold)] px-1.5 py-0.5 text-[8px] font-black text-slate-950">
            AUTO
          </span>
          <span className="text-[11px] font-semibold">Bot arena</span>
        </div>
        <div className="flex items-center gap-1">
          {running ? (
            <button
              type="button"
              onClick={s.stopAuto}
              className="h-5 rounded-sm border border-rose-200/50 px-2 text-[10px] font-semibold text-rose-100"
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={s.startAuto}
              disabled={!s.funded || s.status === "funding"}
              className="h-5 rounded-sm bg-[var(--qp-gold)] px-2 text-[10px] font-black text-slate-950 disabled:opacity-45"
            >
              Start
            </button>
          )}
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col gap-2 p-2">
        {!s.funded && (
          <section className="rounded-md border border-white/10 bg-white/[0.04] p-2 text-[10px]">
            <div className="mb-1 text-slate-400">
              Fund both bots once (stakes are refunded each close; only gas is spent).
            </div>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={s.fund}
                disabled={s.status === "funding"}
                className="h-6 rounded-sm border border-[var(--qp-green)]/40 px-2 text-[10px] text-[var(--qp-green)] disabled:opacity-45"
              >
                {s.status === "funding" ? "Funding…" : "Faucet"}
              </button>
              {s.canFundFromWallet && (
                <button
                  type="button"
                  onClick={s.fundFromWallet}
                  disabled={s.status === "funding"}
                  className="h-6 rounded-sm border border-amber-200/40 px-2 text-[10px] text-amber-100 disabled:opacity-45"
                >
                  Fund 0.1 SUI / bot
                </button>
              )}
            </div>
          </section>
        )}

        <section className="grid grid-cols-2 gap-2 rounded-md border border-white/10 bg-white/[0.04] p-2">
          <div className="min-w-0">
            <div className="text-[9px] uppercase text-slate-500">Bot A</div>
            <div className="truncate text-[11px] font-semibold">
              {s.personas?.a ?? "—"}
            </div>
            <div className="text-[10px] tabular-nums text-[var(--qp-green)]">
              {sui(s.balances.a)} SUI · wins {s.score.a}
            </div>
          </div>
          <div className="min-w-0 text-right">
            <div className="text-[9px] uppercase text-slate-500">Bot B</div>
            <div className="truncate text-[11px] font-semibold">
              {s.personas?.b ?? "—"}
            </div>
            <div className="text-[10px] tabular-nums text-[var(--qp-green)]">
              {sui(s.balances.b)} SUI · wins {s.score.b}
            </div>
          </div>
        </section>

        <section className="grid grid-cols-3 gap-1.5 rounded-md border border-white/10 bg-black/20 p-2 text-center">
          <div>
            <div className="text-[9px] uppercase text-slate-500">Tunnels</div>
            <div className="text-[12px] font-semibold tabular-nums">{s.tunnels}</div>
          </div>
          <div>
            <div className="text-[9px] uppercase text-slate-500">Actions</div>
            <div className="text-[12px] font-semibold tabular-nums">{s.actions}</div>
          </div>
          <div>
            <div className="text-[9px] uppercase text-slate-500">Status</div>
            <div className="truncate text-[12px] font-semibold">{s.status}</div>
          </div>
        </section>

        {s.error && (
          <div className="rounded-sm border border-rose-300/30 bg-rose-400/10 px-2 py-1 text-[10px] text-rose-100">
            {s.error}
          </div>
        )}
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors in this file (snapshot field names match Task 5's **Produces**).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/games/quantumPoker/QuantumPokerBotVsBotWindow.tsx
git commit -m "feat(poker): rebuild auto window on local self-play"
```

---

## Task 7: Play-vs-Bot session + window

**Files:**
- Create: `frontend/src/games/quantumPoker/useQuantumPokerBot.ts`
- Rewrite: `frontend/src/games/quantumPoker/QuantumPokerWindow.tsx`

**Interfaces:**
- `useQuantumPokerBot.ts` consumes: `createParticipant` (`sui-tunnel-ts/core/keys`), `OffchainTunnel.selfPlay`, `Transcript`, `QuantumPokerProtocol`/`PokerMove`/`PokerState`, `openAndFundSelfPlay`/`readCreatedAt`/`SignExec`/`SuiReads` (`@/onchain/tunnelTx`), `pokerSelfPlay.ts` (Task 2–3), `pokerSettle.ts` (Task 4), `registerWindowDisposer`, dapp-kit hooks, `QUANTUM_POKER_STAKE`/`QUANTUM_POKER_HAND_CAP`.
- `useQuantumPokerBot.ts` produces: `useQuantumPokerBot(windowId): QuantumPokerBotSession` with snapshot `{ status: "idle"|"funding"|"playing"|"awaitHuman"|"settling"|"settled"|"error"; state: PokerState | null; humanHoles: number[]; legal: PokerLegalActions | null; error: string | null }` and actions `{ open(); act(move: PokerMove); reset() }`.
- `QuantumPokerWindow.tsx` consumes `useQuantumPokerBot`; keeps its existing presentational sub-components (`Card`, `CardRow`, `PlayerSeat`, `ChipStack`) verbatim.

**Implementation guidance:** Model the session on `useBattleship.ts` (`BotSession` out of React, `useSyncExternalStore`, gen guard, `registerWindowDisposer`). Party A and B are ephemeral `createParticipant`; the CONNECTED WALLET signs the single open; the engine auto-runs every move except party A's betting turns, which set `status:"awaitHuman"` and expose `legal`.

- [ ] **Step 1: Write the session hook**

```ts
// frontend/src/games/quantumPoker/useQuantumPokerBot.ts
import { useSyncExternalStore } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { createParticipant } from "sui-tunnel-ts/core/keys";
import { OffchainTunnel } from "sui-tunnel-ts/core/tunnel";
import { Transcript } from "sui-tunnel-ts/proof/transcript";
import {
  QuantumPokerProtocol,
  type PokerMove,
  type PokerState,
} from "sui-tunnel-ts/protocol/quantumPoker";
import { registerWindowDisposer } from "@/lib/windowSessions";
import {
  openAndFundSelfPlay,
  readCreatedAt,
  type SignExec,
  type SuiReads,
} from "@/onchain/tunnelTx";
import { QUANTUM_POKER_STAKE, QUANTUM_POKER_HAND_CAP } from "./constants";
import {
  makeSeatBot,
  randomPokerPersona,
  stepPokerWithHuman,
  applyHumanMove,
  legalPokerActions,
  LIVE_BOT_CONTEXT,
  type PokerSeatBot,
  type PokerTunnel,
  type PokerLegalActions,
} from "./pokerSelfPlay";
import { settlePokerTunnel } from "./pokerSettle";

const STAKE = QUANTUM_POKER_STAKE;
const HAND_CAP = QUANTUM_POKER_HAND_CAP;
const AUTO_MS = 45; // pacing between auto moves
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type QuantumPokerBotStatus =
  | "idle"
  | "funding"
  | "playing"
  | "awaitHuman"
  | "settling"
  | "settled"
  | "error";

export interface QuantumPokerBotSession {
  status: QuantumPokerBotStatus;
  state: PokerState | null;
  humanHoles: number[];
  legal: PokerLegalActions | null;
  error: string | null;
  open: () => void;
  act: (move: PokerMove) => void;
  reset: () => void;
}

interface BotDeps {
  account: { address: string } | null;
  client: unknown;
  signExec: SignExec;
}

interface Snap {
  status: QuantumPokerBotStatus;
  state: PokerState | null;
  humanHoles: number[];
  legal: PokerLegalActions | null;
  error: string | null;
}

const HUMAN: "A" = "A";

class BotSession {
  deps: BotDeps | null = null;

  private status: QuantumPokerBotStatus = "idle";
  private error: string | null = null;
  private snap: Snap = {
    status: "idle",
    state: null,
    humanHoles: [],
    legal: null,
    error: null,
  };
  private listeners = new Set<() => void>();

  private tunnel: PokerTunnel | null = null;
  private transcript: Transcript | null = null;
  private botA: PokerSeatBot | null = null;
  private botB: PokerSeatBot | null = null;
  private tunnelId = "";
  private createdAt = 0n;
  private ts = 1n;
  private gen = 0;
  private looping = false;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  };
  getSnapshot = (): Snap => this.snap;

  private emit() {
    const s = this.tunnel?.state ?? null;
    this.snap = {
      status: this.status,
      state: s,
      humanHoles: s && this.botA ? (this.botA as unknown as { /* kit bot */ }) && knownHoles(this.botA, s) : [],
      legal:
        this.status === "awaitHuman" && s ? legalPokerActions(s, HUMAN) : null,
      error: this.error,
    };
    for (const l of this.listeners) l();
  }

  private fail(e: unknown) {
    this.error = String((e as Error)?.message ?? e);
    this.status = "error";
    this.emit();
  }

  reset = () => {
    this.gen += 1;
    this.looping = false;
    this.tunnel = null;
    this.transcript = null;
    this.botA = null;
    this.botB = null;
    this.status = "idle";
    this.error = null;
    this.emit();
  };

  dispose = () => {
    this.gen += 1;
    this.looping = false;
    this.listeners.clear();
  };

  open = () => {
    const deps = this.deps;
    if (!deps) return;
    if (this.status !== "idle" && this.status !== "settled" && this.status !== "error") return;
    if (!deps.account) {
      this.fail("connect a wallet to stake the tunnel");
      return;
    }
    this.gen += 1;
    const myGen = this.gen;
    this.error = null;
    this.status = "funding";
    this.emit();

    void (async () => {
      try {
        const a = createParticipant("poker-you");
        const b = createParticipant("poker-foe");
        const reads = deps.client as unknown as SuiReads;
        const tunnelId = await openAndFundSelfPlay({
          reads,
          signExec: deps.signExec,
          partyA: { address: a.address, publicKey: a.keyPair.publicKey },
          partyB: { address: b.address, publicKey: b.keyPair.publicKey },
          aAmount: STAKE,
          bAmount: STAKE,
        });
        if (this.gen !== myGen) return;
        const createdAt = await readCreatedAt(reads, tunnelId);
        if (this.gen !== myGen) return;

        const tunnel: PokerTunnel = OffchainTunnel.selfPlay(
          new QuantumPokerProtocol(HAND_CAP),
          tunnelId,
          a.keyPair,
          b.keyPair,
          a.address,
          b.address,
          { a: STAKE, b: STAKE },
        );
        const transcript = new Transcript(tunnelId);
        tunnel.onUpdate = (u) => transcript.append(u);

        this.tunnel = tunnel;
        this.transcript = transcript;
        this.tunnelId = tunnelId;
        this.createdAt = createdAt;
        this.ts = 1n;
        this.botA = makeSeatBot("A", STAKE, HAND_CAP, randomPokerPersona(Math.random), LIVE_BOT_CONTEXT);
        this.botB = makeSeatBot("B", STAKE, HAND_CAP, randomPokerPersona(Math.random), LIVE_BOT_CONTEXT);
        this.status = "playing";
        this.emit();
        void this.drive(myGen);
      } catch (e) {
        if (this.gen === myGen) this.fail(e);
      }
    })();
  };

  /** Auto-run moves until the human must act, the tunnel ends, or gen changes. */
  private drive = async (myGen: number) => {
    if (this.looping) return;
    this.looping = true;
    try {
      const tunnel = this.tunnel;
      const botA = this.botA;
      const botB = this.botB;
      if (!tunnel || !botA || !botB) return;
      while (this.gen === myGen) {
        const r = stepPokerWithHuman(tunnel, botA, botB, HUMAN, this.ts++);
        if (r.kind === "await-human") {
          this.status = "awaitHuman";
          this.emit();
          return;
        }
        if (r.kind === "idle") break; // terminal
        this.emit();
        await sleep(AUTO_MS);
      }
      if (this.gen === myGen) await this.settle(myGen);
    } catch (e) {
      if (this.gen === myGen) this.fail(e);
    } finally {
      this.looping = false;
    }
  };

  act = (move: PokerMove) => {
    const tunnel = this.tunnel;
    const botA = this.botA;
    if (!tunnel || !botA || this.status !== "awaitHuman") return;
    const myGen = this.gen;
    try {
      applyHumanMove(tunnel, botA, HUMAN, move, this.ts++);
      this.status = "playing";
      this.emit();
      void this.drive(myGen);
    } catch (e) {
      this.fail(e);
    }
  };

  private settle = async (myGen: number) => {
    const tunnel = this.tunnel;
    const transcript = this.transcript;
    const deps = this.deps;
    if (!tunnel || !transcript || !deps) return;
    this.status = "settling";
    this.emit();
    try {
      await settlePokerTunnel({
        tunnel,
        transcript,
        tunnelId: this.tunnelId,
        createdAt: this.createdAt,
        fallbackSignExec: deps.signExec,
      });
      if (this.gen !== myGen) return;
      this.status = "settled";
      this.emit();
    } catch (e) {
      if (this.gen === myGen) this.fail(e);
    }
  };
}

/** Read the human seat's known hole cards from its kit bot's driver. */
function knownHoles(bot: PokerSeatBot, state: PokerState): number[] {
  const withHoles = bot as unknown as {
    knownHoleCards?: (s: PokerState) => number[] | null;
  };
  return withHoles.knownHoleCards?.(state) ?? state.shownHoleA ?? [];
}

const sessions = new Map<string, BotSession>();

function getSession(windowId: string): BotSession {
  let s = sessions.get(windowId);
  if (!s) {
    s = new BotSession();
    sessions.set(windowId, s);
    const created = s;
    registerWindowDisposer(windowId, "quantum-poker-bot", () => {
      created.dispose();
      sessions.delete(windowId);
    });
  }
  return s;
}

export function useQuantumPokerBot(windowId: string): QuantumPokerBotSession {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync } = useSignAndExecuteTransaction();
  const session = getSession(windowId);
  session.deps = {
    account,
    client,
    signExec: (async (tx) => {
      const r = await mutateAsync({ transaction: tx });
      return { digest: r.digest };
    }) as SignExec,
  };
  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return {
    ...snap,
    open: session.open,
    act: session.act,
    reset: session.reset,
  };
}
```

> **Note on `knownHoles`:** the kit's `QuantumPokerBot` does not expose `knownHoleCards`; that lives on `QuantumPokerPersonaDriver`. If the kit bot doesn't surface it, read the human's holes from the tunnel state instead — party A's revealed private holes are derivable via `expectedQuantumPokerRevealSlots`/`state.holeA` once opened. Simplest correct source: `state.holeA ?? state.shownHoleA ?? []` (local self-play holds `holeA`). Replace `knownHoles` with `state.holeA ?? state.shownHoleA ?? []` if the cast is unavailable. Verify with `grep -n "knownHoleCards\|holeA" sui-tunnel-ts/src/protocol/quantumPoker*.ts`.

- [ ] **Step 2: Typecheck the hook**

Run: `cd frontend && npx tsc --noEmit`
Expected: resolve any `knownHoles` typing per the note (prefer `state.holeA ?? state.shownHoleA ?? []`). No other errors.

- [ ] **Step 3: Rewrite `QuantumPokerWindow.tsx` to drive the hook + human action bar**

Keep the presentational helpers (`Card`, `CardRow`, `ChipStack`, `PlayerSeat`, `PHASE_LABEL`, `SUITS`, `RANKS`, `cardText`, `moveLabel`) from the current file verbatim. Replace the runtime/server logic and the body with:

```tsx
import { useCurrentAccount } from "@mysten/dapp-kit";
import type { CSSProperties } from "react";
import type { PokerMove } from "sui-tunnel-ts/protocol/quantumPoker";
import type { GameWindowProps } from "../types";
import { useQuantumPokerBot } from "./useQuantumPokerBot";
// ...keep existing Card/CardRow/ChipStack/PlayerSeat/PHASE_LABEL/etc. here...

const HEADS_UP_STYLE: CSSProperties & Record<`--${string}`, string> = {
  "--qp-felt": "#0f6b52",
  "--qp-felt-dark": "#08372f",
  "--qp-rail": "#14191d",
  "--qp-gold": "#f4c45d",
  "--qp-cyan": "#67e8f9",
};

function ActionBar({
  legal,
  onAct,
}: {
  legal: NonNullable<ReturnType<typeof useQuantumPokerBot>["legal"]>;
  onAct: (m: PokerMove) => void;
}) {
  const pot = 0n; // pot display optional; bet presets clamp to [minBet,maxBet]
  void pot;
  const raise = (amt: bigint) => onAct({ kind: "bet", amount: amt });
  const clamp = (v: bigint) =>
    v < legal.minBet ? legal.minBet : v > legal.maxBet ? legal.maxBet : v;
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-white/10 bg-black/30 p-2">
      <button
        type="button"
        onClick={() => onAct({ kind: "fold" })}
        className="h-7 rounded-sm border border-rose-300/40 px-3 text-[11px] font-semibold text-rose-100"
      >
        Fold
      </button>
      {legal.canCheck && (
        <button
          type="button"
          onClick={() => onAct({ kind: "check" })}
          className="h-7 rounded-sm border border-white/20 px-3 text-[11px] font-semibold text-slate-100"
        >
          Check
        </button>
      )}
      {legal.canCall && (
        <button
          type="button"
          onClick={() => onAct({ kind: "call" })}
          className="h-7 rounded-sm border border-[var(--qp-cyan)]/50 px-3 text-[11px] font-semibold text-cyan-100"
        >
          Call {legal.callAmount.toString()}
        </button>
      )}
      {legal.minBet > 0n && (
        <>
          <button
            type="button"
            onClick={() => raise(legal.minBet)}
            className="h-7 rounded-sm border border-amber-200/40 px-3 text-[11px] font-semibold text-amber-100"
          >
            Raise {legal.minBet.toString()}
          </button>
          <button
            type="button"
            onClick={() => raise(clamp(legal.maxBet / 2n))}
            className="h-7 rounded-sm border border-amber-200/40 px-3 text-[11px] font-semibold text-amber-100"
          >
            ½
          </button>
          <button
            type="button"
            onClick={() => raise(legal.maxBet)}
            className="h-7 rounded-sm bg-[var(--qp-gold)] px-3 text-[11px] font-black text-slate-950"
          >
            All-in {legal.maxBet.toString()}
          </button>
        </>
      )}
    </div>
  );
}

export function QuantumPokerWindow({
  onExit,
}: GameWindowProps & { lane?: "bot" | "auto"; onExit?: () => void }) {
  const account = useCurrentAccount();
  const game = useQuantumPokerBot(
    // windowId from props
    (arguments[0] as GameWindowProps).windowId,
  );
  const s = game.state;

  if (!s) {
    return (
      <div
        style={HEADS_UP_STYLE}
        className="flex h-full min-h-[14rem] flex-col items-center justify-center gap-3 bg-[#080b0d] p-5 text-center text-slate-100"
      >
        <span className="rounded-sm bg-[var(--qp-gold)] px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.14em] text-slate-950">
          bot mode
        </span>
        <p className="max-w-[17rem] text-[12px] text-slate-400">
          Open a real self-play tunnel: your wallet funds both seats once, you
          play party A, a random-persona bot plays party B, then it settles
          gas-free.
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={game.open}
            disabled={game.status === "funding" || !account}
            className="rounded-md bg-[var(--qp-gold)] px-4 py-2 text-[12px] font-bold text-slate-950 disabled:opacity-45"
          >
            {game.status === "funding"
              ? "Opening…"
              : account
                ? "Open tunnel"
                : "Connect wallet"}
          </button>
          {onExit && (
            <button
              type="button"
              onClick={onExit}
              className="rounded-md border border-white/15 px-4 py-2 text-[12px] font-semibold text-slate-200"
            >
              Back
            </button>
          )}
        </div>
        {game.error && (
          <div className="text-[10px] text-rose-300">{game.error}</div>
        )}
      </div>
    );
  }

  return (
    <div
      style={HEADS_UP_STYLE}
      className="flex h-full min-h-[14rem] flex-col overflow-hidden bg-[#080b0d] text-slate-100"
    >
      {/* Reuse the existing PlayerSeat/board/pot rendering, reading from `s`:
          - Seat B: name from bot persona (optional), balance s.balanceB, holes hidden
          - Board: s.board; Pot: s.totalBetA + s.totalBetB
          - Seat A: balance s.balanceA, holes = game.humanHoles */}
      {/* ...PlayerSeat B... board ... PlayerSeat A (holes={game.humanHoles}) ... */}

      {game.status === "awaitHuman" && game.legal && (
        <ActionBar legal={game.legal} onAct={game.act} />
      )}
      <div className="px-2 py-1 text-[10px] text-slate-500">
        {game.status === "settled"
          ? "Settled."
          : game.status === "settling"
            ? "Settling…"
            : `phase ${s.phase}`}
        {game.status === "settled" && (
          <button
            type="button"
            onClick={game.open}
            className="ml-2 rounded-sm border border-white/15 px-2 py-0.5 text-[10px]"
          >
            New tunnel
          </button>
        )}
      </div>
    </div>
  );
}
```

> **Fix the `windowId` access:** the snippet above uses `arguments[0]` for brevity — replace with a normal destructured prop: `export function QuantumPokerWindow({ windowId, onExit }: GameWindowProps & { lane?: "bot" | "auto"; onExit?: () => void })` and call `useQuantumPokerBot(windowId)`. Fill in the seat/board JSX by reusing the existing `PlayerSeat`/`CardRow`/`ChipStack` from the current file (party A `holes={game.humanHoles}`, party B `holes={[]}` hidden until showdown via `s.shownHoleB`). The `lane` prop is accepted for compatibility with `QuantumPokerModeWindow` but only the bot lane uses this window now.

- [ ] **Step 4: Typecheck**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/quantumPoker/useQuantumPokerBot.ts frontend/src/games/quantumPoker/QuantumPokerWindow.tsx
git commit -m "feat(poker): rebuild bot lane as human-vs-bot self-play"
```

---

## Task 8: Delete the server and wire-up cleanup

**Files:**
- Delete: `frontend/src/games/quantumPoker/serverClient.ts`, `serverRuntime.ts`, `runtime.ts`, `packages/server/` (whole dir).
- Modify: `frontend/src/games/quantumPoker/index.ts` (lane comment), `QuantumPokerModeWindow.tsx` (props passed unchanged; confirm it still compiles).

- [ ] **Step 1: Confirm nothing else imports the deleted modules**

Run:
```bash
cd frontend && grep -rnE "serverClient|serverRuntime|\\./runtime|QuantumPokerServerClient|runBotVsBot" src --include="*.ts" --include="*.tsx" | grep -v node_modules
```
Expected: only matches inside the files being deleted/rewritten (none in `QuantumPokerWindow.tsx`/`QuantumPokerBotVsBotWindow.tsx` after Tasks 6–7). If `QuantumPokerWindow.tsx` still references `serverRuntime`/`runtime`, those are leftovers — remove them.

- [ ] **Step 2: Delete the files**

```bash
cd frontend && git rm src/games/quantumPoker/serverClient.ts \
  src/games/quantumPoker/serverRuntime.ts \
  src/games/quantumPoker/runtime.ts
git rm -r src/games/quantumPoker/packages/server
```

- [ ] **Step 3: Update the lane comment in `index.ts`**

Replace the comment block above `register(...)` with:

```ts
// Quantum Poker lanes (all local/relay — no game server):
// - Bot: human plays party A; a random-persona bot plays party B over a
//   wallet-funded self-play tunnel, settled gas-free via /settle.
// - PvP: two real wallets over DistributedTunnel + quickMatch (like Tic-Tac-Toe).
// - Auto: two persistent persona bots open/play/settle and loop real tunnels.
```

- [ ] **Step 4: Typecheck + run all poker unit tests**

Run:
```bash
cd frontend && npx tsc --noEmit && \
  npx tsx --test src/games/quantumPoker/bots.test.ts src/games/quantumPoker/pokerSelfPlay.test.ts
```
Expected: typecheck clean; all tests PASS.

- [ ] **Step 5: Lint the changed package**

Run: `cd frontend && npx eslint src/games/quantumPoker --ext .ts,.tsx`
Expected: no errors (warnings from pre-existing rules are acceptable; fix anything introduced by the new files).

- [ ] **Step 6: Commit**

```bash
git add -A frontend/src/games/quantumPoker
git commit -m "refactor(poker): delete poker node server and shims"
```

---

## Self-Review

**Spec coverage:**
- Modes (Bot/Auto/PvP) — Tasks 5–7 (Bot/Auto), PvP untouched. ✓
- Persona random per tunnel — `randomPokerPersona` (Task 2), used in Tasks 5 & 7. ✓
- Engine `OffchainTunnel.selfPlay` + kit bots, no moveCodec — Task 2. ✓
- Commit-reveal handled (secrets in state) — covered by Task 2 self-play test reaching `done`. ✓
- Funding Pattern 1 (Bot: wallet opens, ephemeral) — Task 7. ✓
- Funding Pattern 2 (Auto: persistent bots, faucet/wallet, bot A self-signs) — Tasks 1 & 5. ✓
- Close via gas-sponsored `/settle` + fallback — Task 4, used by 5 & 7. ✓
- Server deletion — Task 8. ✓
- Tests: bots, engine self-play, human router — Tasks 1–3. ✓
- Gas/cost model: amortized via HAND_CAP, close sponsored — realized by always settling once per tunnel (Tasks 5,7) and `/settle` (Task 4). ✓

**Placeholder scan:** Two snippets contain explicit "verify/replace" notes (the `knownHoles` cast in Task 7 and the `arguments[0]` windowId shortcut) — both have concrete replacement instructions and a grep to confirm, not open TODOs. The Task 5 hook is a template-copy with an explicit, itemized edit list (acceptable for a near-verbatim battleship mirror; all poker-specific code is shown).

**Type consistency:** `PokerSeatBot`/`PokerTunnel`/`PokerLegalActions` defined in Task 2 and reused by name in Tasks 4–7. Snapshot field names in Task 5/7 **Produces** match the window reads in Tasks 6/7. `makeSeatBot(seat, stake, handCap, profile, ctx)` signature is identical across call sites.
