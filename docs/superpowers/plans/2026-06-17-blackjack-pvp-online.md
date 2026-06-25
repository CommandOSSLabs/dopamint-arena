# Blackjack PvP (Online) Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a separate online PvP blackjack mode where two people are matched over the `tunnel-manager` relay and play a blackjack duel through a Sui tunnel; each seat is played by the human or auto-played by their bot.

**Architecture:** A new game-side `BlackjackDuelProtocol` (shared auto-dealer, head-to-head pot) runs inside the SDK's `DistributedTunnel` engine over a relay-WebSocket transport. Each browser holds a faucet-funded wallet keypair (on-chain identity) + a per-match ephemeral key (move signer). Open/fund/settle are plain on-chain PTBs; settle is a client-side cooperative close.

**Tech Stack:** TypeScript, blackjack monorepo (**bun** + vite), `sui-tunnel-ts` SDK (top-level, `file:` dep), `@mysten/sui` + `@mysten/dapp-kit` (already wired), relay backend `tunnel-manager` (Rust, run locally).

**Spec:** `docs/superpowers/specs/2026-06-17-blackjack-pvp-online-design.md`

**Conventions:** Conventional Commits, subject ≤ 50 chars, **no AI attribution**. Stage only the files each task lists (never `git add -A`). The **only** SDK-source edit allowed is Task 1 (`src/core/index.ts`); never stage `sui_tunnel/**` or other `sui-tunnel-ts/**` source. Do not push.

**Paths:**

- SDK: `sui-tunnel-ts/`
- Client: `frontend/src/games/blackjack/packages/client/` (run bun commands from `frontend/src/games/blackjack`)

**Test commands:**

- Protocol/identity units: `cd frontend/src/games/blackjack && bun test packages/client/src/lib/<file>.test.ts`
- Typecheck: `bun run --cwd packages/client typecheck`
- Build: `bun run build`

**Run the relay backend** (needed for Task 6 integration test + Task 9 e2e), from repo root:

```bash
TUNNEL_MANAGER_ADDR=127.0.0.1:8080 \
SUI_RPC_URL=https://fullnode.testnet.sui.io:443 \
TUNNEL_PACKAGE_ID=0x0b89fe86e42cdbfd1e614757a83d014b455d12923d0dded58842ab18f8a5a22b \
SUI_SETTLER_KEY="$(head -c 32 /dev/urandom | base64)" \
WALRUS_PUBLISHER_URL=http://localhost:9 WALRUS_AGGREGATOR_URL=http://localhost:9 \
cargo run -p tunnel-manager
```

**Milestone boundary:** Tasks 1–6 deliver a _headless, tested_ PvP duel (protocol + relay + engine, proven by a node integration test against the live relay). Tasks 7–9 add the browser UI.

---

## Task 1: Expose `DistributedTunnel` from the SDK + rebuild dist

**Files:**

- Modify: `sui-tunnel-ts/src/core/index.ts`

The client consumes the compiled `dist`. `makeEndpoint` (via `./tunnel`) and `defaultBackend`
(via `./crypto-native`) are already exported; only `DistributedTunnel` is missing.

- [ ] **Step 1: Add the barrel export**

In `sui-tunnel-ts/src/core/index.ts`, after the line `export * from "./tunnel";`, add:

```ts
export * from "./distributedTunnel";
```

- [ ] **Step 2: Rebuild dist and verify the symbol lands**

```bash
cd /Users/alvin/Developer/dopamint-arena/sui-tunnel-ts && npx tsc
```

Then verify:

```bash
ls dist/core/distributedTunnel.js && grep -c "distributedTunnel" dist/core/index.js
node -e "const s=require('/Users/alvin/Developer/dopamint-arena/sui-tunnel-ts/dist'); console.log(typeof s.core.DistributedTunnel, typeof s.core.makeEndpoint, typeof s.core.defaultBackend)"
```

Expected: `distributedTunnel.js` exists; grep ≥ 1; node prints `function function function`.

- [ ] **Step 3: Remove any regenerated workspace file + commit**

```bash
cd /Users/alvin/Developer/dopamint-arena
rm -f sui-tunnel-ts/pnpm-workspace.yaml 2>/dev/null || true
git add sui-tunnel-ts/src/core/index.ts
git commit -m "feat(sdk): export DistributedTunnel from core barrel"
```

(`dist/` is gitignored — do not stage it.)

---

## Task 2: `BlackjackDuelProtocol` (game-side) + unit tests

**Files:**

- Create: `frontend/src/games/blackjack/packages/client/src/lib/bjDuelProtocol.ts`
- Test: `frontend/src/games/blackjack/packages/client/src/lib/bjDuelProtocol.test.ts`

Implements the SDK `Protocol<DuelState, DuelMove>`. Mirrors the proven card-stream + soft-ace
`handValue` + draw-to-17 dealer from `sui-tunnel-ts/src/protocol/blackjack.ts`, with TWO player
hands + a shared dealer + a head-to-head settle. Reuses `handValue` from `@/lib/bjCards`.

- [ ] **Step 1: Write the failing test**

Create `bjDuelProtocol.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import {
  BlackjackDuelProtocol,
  settleOutcome,
  STAKE,
  type DuelState,
} from "./bjDuelProtocol";

const ctx = (tunnelId: string) => ({
  tunnelId,
  initialBalances: { a: STAKE, b: STAKE },
});

describe("settleOutcome (head-to-head vs shared dealer)", () => {
  // dealer=20. A=21 beats dealer (WIN); B=19 loses (LOSE) -> A wins.
  test("higher result-vs-dealer wins", () => {
    expect(settleOutcome([10, 11], [10, 9], [10, 10])).toBe("A"); // A 21 win, B 19 lose
  });
  // both beat dealer (dealer 17): tie-break by hand value (A 20 > B 18).
  test("both beat dealer -> closer to 21 wins", () => {
    expect(settleOutcome([10, 10], [10, 8], [10, 7])).toBe("A");
  });
  // A busts (LOSE), B 18 vs dealer 17 (WIN) -> B wins.
  test("bust loses to a standing hand", () => {
    expect(settleOutcome([10, 10, 5], [10, 8], [10, 7])).toBe("B");
  });
  // both bust -> both LOSE, equal value 0 -> push.
  test("both bust -> push", () => {
    expect(settleOutcome([10, 10, 5], [10, 10, 6], [10, 7])).toBe("push");
  });
  // identical results and values -> push.
  test("equal result and value -> push", () => {
    expect(settleOutcome([10, 9], [10, 9], [10, 7])).toBe("push"); // both 19, both beat dealer 17
  });
});

describe("BlackjackDuelProtocol", () => {
  const proto = new BlackjackDuelProtocol();

  test("initial state deals dealer/A/B two cards each, A to move", () => {
    const s = proto.initialState(ctx("0xtunnel1"));
    expect(s.dealerHand.length).toBe(2);
    expect(s.handA.length).toBe(2);
    expect(s.handB.length).toBe(2);
    expect(s.phase).toBe("a_turn");
    expect(s.balanceA).toBe(STAKE);
    expect(s.balanceB).toBe(STAKE);
  });

  test("encodeState is deterministic for the same tunnelId, differs across tunnels", () => {
    const a1 = proto.encodeState(proto.initialState(ctx("0xtunnelA")));
    const a2 = proto.encodeState(proto.initialState(ctx("0xtunnelA")));
    const b = proto.encodeState(proto.initialState(ctx("0xtunnelB")));
    expect(Buffer.from(a1).toString("hex")).toBe(
      Buffer.from(a2).toString("hex"),
    );
    expect(Buffer.from(a1).toString("hex")).not.toBe(
      Buffer.from(b).toString("hex"),
    );
  });

  test("rejects out-of-turn moves and moves after the duel is over", () => {
    const s = proto.initialState(ctx("0xtunnel1"));
    expect(() => proto.applyMove(s, { action: "stand" }, "B")).toThrow(); // A's turn
    // A stands -> B's turn; A can't move now
    const s2 = proto.applyMove(s, { action: "stand" }, "A");
    expect(s2.phase).toBe("b_turn");
    expect(() => proto.applyMove(s2, { action: "stand" }, "A")).toThrow();
  });

  test("a full both-stand game resolves the dealer and is terminal with conserved balances", () => {
    let s = proto.initialState(ctx("0xtunnelFull"));
    s = proto.applyMove(s, { action: "stand" }, "A");
    s = proto.applyMove(s, { action: "stand" }, "B"); // triggers dealer + settle
    expect(s.phase).toBe("over");
    expect(proto.isTerminal(s)).toBe(true);
    expect(s.dealerHand.length).toBeGreaterThanOrEqual(2); // dealer drew to >=17 (or stood)
    expect(s.balanceA + s.balanceB).toBe(STAKE * 2n); // conserved
    expect(() => proto.applyMove(s, { action: "stand" }, "A")).toThrow(); // over
  });

  test("randomMove plays basic strategy for the side to move only", () => {
    const s = proto.initialState(ctx("0xtunnel1"));
    const mv = proto.randomMove(s, "A", Math.random);
    expect(mv === null || mv.action === "hit" || mv.action === "stand").toBe(
      true,
    );
    expect(proto.randomMove(s, "B", Math.random)).toBeNull(); // not B's turn
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend/src/games/blackjack && bun test packages/client/src/lib/bjDuelProtocol.test.ts`
Expected: FAIL — `Cannot find module "./bjDuelProtocol"`.

- [ ] **Step 3: Implement `bjDuelProtocol.ts`**

```ts
/**
 * Blackjack DUEL protocol (game-side; implements the SDK `Protocol`). Two players (A, B)
 * each play their own hand against a SHARED deterministic dealer; head-to-head for one pot.
 * Mirrors the deterministic dealerless card stream + soft-ace handValue + draw-to-17 dealer of
 * `sui-tunnel-ts/src/protocol/blackjack.ts`. Stake is fixed; balances only ever swap A<->B.
 */
import { core, protocols } from "sui-tunnel-ts";
import { handValue } from "@/lib/bjCards";

type Party = protocols.Party; // "A" | "B"
type Balances = protocols.Balances;
type ProtocolContext = protocols.ProtocolContext;

/** Per-seat stake (MIST). 0.01 SUI — tiny on testnet (gas dominates). Pot = 2*STAKE. */
export const STAKE = 10_000_000n;
const DEALER_STANDS_AT = 17;
const BUST_AT = 21;

export type DuelPhase = "a_turn" | "b_turn" | "over";
export interface DuelState {
  seed: number[]; // 32-byte deterministic card-stream seed (from tunnelId)
  dealerHand: number[];
  handA: number[];
  handB: number[];
  phase: DuelPhase;
  drawIndex: number;
  balanceA: bigint;
  balanceB: bigint;
  wager: bigint;
}
export interface DuelMove {
  action: "hit" | "stand";
}

const DOMAIN = protocols.protocolDomain("blackjack.duel.v1");
const PHASE_CODE: Record<DuelPhase, number> = { a_turn: 0, b_turn: 1, over: 2 };

/** Deterministic card byte at `drawIndex` for a seed; advances a rolling digest every 32 draws. */
function drawRank(seed: number[], drawIndex: number): number {
  let digest = Uint8Array.from(seed);
  const block = Math.floor(drawIndex / 32);
  for (let b = 0; b < block; b++) {
    digest = core.blake2b256(core.concatBytes([digest, core.u64ToBeBytes(b)]));
  }
  return (digest[drawIndex % 32] % 13) + 1;
}
/** rank (1..13) -> raw blackjack value (Ace = 11, reduced later by handValue). */
function rankValue(rank: number): number {
  if (rank === 1) return 11;
  if (rank >= 11) return 10;
  return rank;
}
const isBust = (hand: number[]) => handValue(hand) > BUST_AT;

/**
 * Head-to-head outcome of two hands vs a shared (already-resolved) dealer hand.
 * Rank each seat by (result-vs-dealer: WIN=2/PUSH=1/LOSE=0, then hand value, bust=0); higher
 * wins, fully-equal is a push. Exported pure so it can be unit-tested directly.
 */
export function settleOutcome(
  handA: number[],
  handB: number[],
  dealerHand: number[],
): "A" | "B" | "push" {
  const dv = handValue(dealerHand);
  const dealerBust = dv > BUST_AT;
  const rank = (hand: number[]) => {
    if (isBust(hand)) return { res: 0, val: 0 };
    const v = handValue(hand);
    const res = dealerBust || v > dv ? 2 : v < dv ? 0 : 1;
    return { res, val: v };
  };
  const ra = rank(handA);
  const rb = rank(handB);
  if (ra.res !== rb.res) return ra.res > rb.res ? "A" : "B";
  if (ra.val !== rb.val) return ra.val > rb.val ? "A" : "B";
  return "push";
}

export class BlackjackDuelProtocol implements protocols.Protocol<
  DuelState,
  DuelMove
> {
  readonly name = "blackjack.duel.v1";

  initialState(ctx: ProtocolContext): DuelState {
    const seedBytes = core.blake2b256(
      core.concatBytes([DOMAIN, new TextEncoder().encode(ctx.tunnelId)]),
    );
    const seed = Array.from(seedBytes);
    let drawIndex = 0;
    const dealTwo = () => {
      const h: number[] = [];
      for (let i = 0; i < 2; i++)
        h.push(rankValue(drawRank(seed, drawIndex++)));
      return h;
    };
    const dealerHand = dealTwo();
    const handA = dealTwo();
    const handB = dealTwo();
    return {
      seed,
      dealerHand,
      handA,
      handB,
      phase: "a_turn",
      drawIndex,
      balanceA: ctx.initialBalances.a,
      balanceB: ctx.initialBalances.b,
      wager: STAKE,
    };
  }

  applyMove(state: DuelState, move: DuelMove, by: Party): DuelState {
    if (move.action !== "hit" && move.action !== "stand") {
      throw new Error(`unknown action: ${String(move.action)}`);
    }
    if (state.phase === "over") throw new Error("duel is over");
    const seat: Party = state.phase === "a_turn" ? "A" : "B";
    if (by !== seat) throw new Error(`it is ${seat}'s turn`);

    let hand = seat === "A" ? state.handA : state.handB;
    let drawIndex = state.drawIndex;
    let turnEnded: boolean;
    if (move.action === "hit") {
      hand = [...hand, rankValue(drawRank(state.seed, drawIndex))];
      drawIndex += 1;
      turnEnded = isBust(hand); // a bust ends this seat's turn; otherwise keep hitting
    } else {
      turnEnded = true;
    }
    const next: DuelState =
      seat === "A"
        ? { ...state, handA: hand, drawIndex }
        : { ...state, handB: hand, drawIndex };
    if (!turnEnded) return next;
    if (seat === "A") return { ...next, phase: "b_turn" };
    return resolveAndSettle(next); // B finished -> dealer resolves, settle, terminal
  }

  encodeState(s: DuelState): Uint8Array {
    return core.concatBytes([
      DOMAIN,
      core.u64ToBeBytes(s.seed.length),
      Uint8Array.from(s.seed),
      core.u64ToBeBytes(s.dealerHand.length),
      Uint8Array.from(s.dealerHand),
      core.u64ToBeBytes(s.handA.length),
      Uint8Array.from(s.handA),
      core.u64ToBeBytes(s.handB.length),
      Uint8Array.from(s.handB),
      new Uint8Array([PHASE_CODE[s.phase]]),
      core.u64ToBeBytes(s.drawIndex),
      core.u64ToBeBytes(s.balanceA),
      core.u64ToBeBytes(s.balanceB),
      core.u64ToBeBytes(s.wager),
    ]);
  }

  balances(s: DuelState): Balances {
    return { a: s.balanceA, b: s.balanceB };
  }

  isTerminal(s: DuelState): boolean {
    return s.phase === "over";
  }

  randomMove(s: DuelState, by: Party, _rng: () => number): DuelMove | null {
    if (s.phase === "over") return null;
    const seat: Party = s.phase === "a_turn" ? "A" : "B";
    if (by !== seat) return null;
    const hand = seat === "A" ? s.handA : s.handB;
    return { action: handValue(hand) < DEALER_STANDS_AT ? "hit" : "stand" };
  }
}

/** Resolve the shared dealer (draw to >=17), apply the head-to-head wager swap, go terminal. */
function resolveAndSettle(s: DuelState): DuelState {
  let dealerHand = s.dealerHand;
  let drawIndex = s.drawIndex;
  while (handValue(dealerHand) < DEALER_STANDS_AT) {
    dealerHand = [...dealerHand, rankValue(drawRank(s.seed, drawIndex))];
    drawIndex += 1;
  }
  const winner = settleOutcome(s.handA, s.handB, dealerHand);
  let balanceA = s.balanceA;
  let balanceB = s.balanceB;
  if (winner === "A") {
    const amt = s.wager <= balanceB ? s.wager : balanceB;
    balanceA += amt;
    balanceB -= amt;
  } else if (winner === "B") {
    const amt = s.wager <= balanceA ? s.wager : balanceA;
    balanceB += amt;
    balanceA -= amt;
  }
  return { ...s, dealerHand, drawIndex, phase: "over", balanceA, balanceB };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend/src/games/blackjack && bun test packages/client/src/lib/bjDuelProtocol.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/blackjack/packages/client/src/lib/bjDuelProtocol.ts \
        frontend/src/games/blackjack/packages/client/src/lib/bjDuelProtocol.test.ts
git commit -m "feat(blackjack): pvp duel protocol (shared dealer, head-to-head)"
```

---

## Task 3: PvP identity — wallet + per-match ephemeral key + attestation

**Files:**

- Create: `frontend/src/games/blackjack/packages/client/src/lib/bjPvpIdentity.ts`
- Test: `frontend/src/games/blackjack/packages/client/src/lib/bjPvpIdentity.test.ts`

A faucet-funded wallet `Ed25519Keypair` (localStorage, on-chain identity) + a fresh ephemeral
SDK keypair per match (IndexedDB, move signer) + the `party.hello` attestation (wallet signs
`matchId‖ephemeralPubkeyHex` via Sui personal-message; opponent verifies client-side).

- [ ] **Step 1: Write the failing test** (attestation round-trip — the pure, testable core)

Create `bjPvpIdentity.test.ts`:

```ts
import { test, expect } from "bun:test";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { attestEphemeral, verifyAttestation } from "./bjPvpIdentity";

test("attestation verifies for the right wallet and matchId, rejects tampering", async () => {
  const wallet = new Ed25519Keypair();
  const addr = wallet.getPublicKey().toSuiAddress();
  const matchId = "match_abc";
  const ephPubHex = "aa".repeat(32);

  const sig = await attestEphemeral(wallet, matchId, ephPubHex);
  expect(await verifyAttestation(matchId, ephPubHex, sig, addr)).toBe(true);
  // wrong matchId / wrong eph / wrong wallet all fail
  expect(await verifyAttestation("other", ephPubHex, sig, addr)).toBe(false);
  expect(await verifyAttestation(matchId, "bb".repeat(32), sig, addr)).toBe(
    false,
  );
  const other = new Ed25519Keypair().getPublicKey().toSuiAddress();
  expect(await verifyAttestation(matchId, ephPubHex, sig, other)).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend/src/games/blackjack && bun test packages/client/src/lib/bjPvpIdentity.test.ts`
Expected: FAIL — `Cannot find module "./bjPvpIdentity"`.

- [ ] **Step 3: Implement `bjPvpIdentity.ts`**

```ts
/**
 * PvP identities. Two independent keys per the integration doc:
 *  - WALLET: a @mysten Ed25519Keypair, seed in localStorage, faucet-funded; on-chain identity
 *    (funds the stake, receives winnings). Reused across matches.
 *  - EPHEMERAL: a fresh SDK keypair per match (IndexedDB by matchId); signs every move + the
 *    lobby connect nonce. Holds no funds.
 * The party.hello attestation signs `matchId‖ephemeralPubkeyHex` with the wallet via Sui
 * personal-message; the opponent verifies it client-side against `opponentWallet`.
 */
import { core } from "sui-tunnel-ts";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";
import { fromHEX, toHEX } from "@mysten/sui/utils";

const WALLET_KEY = "bj_pvp_wallet.v1";

export interface EphemeralKey {
  coreKey: ReturnType<typeof core.keyPairFromSecret>; // { publicKey, secretKey }
  pubkeyHex: string;
}

/** Load (or create + persist) this browser's faucet-funded wallet keypair. */
export function loadOrCreateWallet(): Ed25519Keypair {
  let seed: Uint8Array;
  try {
    const stored = localStorage.getItem(WALLET_KEY);
    if (stored) seed = fromHEX(stored);
    else {
      seed = core.generateKeyPair().secretKey;
      localStorage.setItem(WALLET_KEY, toHEX(seed));
    }
  } catch {
    seed = core.generateKeyPair().secretKey;
  }
  return Ed25519Keypair.fromSecretKey(seed);
}

const dbReq = () => indexedDB.open("bj_pvp", 1);
function withStore<T>(
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = dbReq();
    req.onupgradeneeded = () => req.result.createObjectStore("eph");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const tx = req.result.transaction("eph", mode);
      const r = fn(tx.objectStore("eph"));
      r.onsuccess = () => resolve(r.result as T);
      r.onerror = () => reject(r.error);
    };
  });
}

/** Get the persisted ephemeral key for `matchId`, or mint+persist a fresh one. */
export async function getOrCreateEphemeral(
  matchId: string,
): Promise<EphemeralKey> {
  const existing = await withStore<string | undefined>("readonly", (s) =>
    s.get(matchId),
  );
  const seed = existing ? fromHEX(existing) : core.generateKeyPair().secretKey;
  if (!existing)
    await withStore("readwrite", (s) => s.put(toHEX(seed), matchId));
  const coreKey = core.keyPairFromSecret(seed);
  return { coreKey, pubkeyHex: toHEX(coreKey.publicKey) };
}

const attMessage = (matchId: string, ephPubHex: string) =>
  new TextEncoder().encode(`${matchId}:${ephPubHex}`);

/** Wallet signs the attestation (Sui personal-message, base64). */
export async function attestEphemeral(
  wallet: Ed25519Keypair,
  matchId: string,
  ephPubHex: string,
): Promise<string> {
  const { signature } = await wallet.signPersonalMessage(
    attMessage(matchId, ephPubHex),
  );
  return signature;
}

/** Verify an opponent's attestation: recovers the signer and checks it equals `walletAddr`. */
export async function verifyAttestation(
  matchId: string,
  ephPubHex: string,
  walletSig: string,
  walletAddr: string,
): Promise<boolean> {
  try {
    const pk = await verifyPersonalMessageSignature(
      attMessage(matchId, ephPubHex),
      walletSig,
    );
    return pk.toSuiAddress() === walletAddr;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend/src/games/blackjack && bun test packages/client/src/lib/bjPvpIdentity.test.ts`
Expected: PASS. (IndexedDB functions are not unit-tested here — they're exercised in the
browser e2e in Task 9; the attestation crypto is the testable core.)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/blackjack/packages/client/src/lib/bjPvpIdentity.ts \
        frontend/src/games/blackjack/packages/client/src/lib/bjPvpIdentity.test.ts
git commit -m "feat(blackjack): pvp wallet + ephemeral key + attestation"
```

---

## Task 4: On-chain PTB builders for PvP

**Files:**

- Create: `frontend/src/games/blackjack/packages/client/src/lib/bjPvpOnchain.ts`

Wrap `onchain/txbuilders.ts` for the PvP lifecycle: open (`create_and_share`), deposit own
seat, cooperative close from the co-signed settlement. Cast the client's `@mysten/sui@1.45`
`Transaction` to the SDK's pinned type at the builder boundary (same pattern as the existing
`bjTunnel.ts`).

- [ ] **Step 1: Implement `bjPvpOnchain.ts`**

```ts
process.env.PACKAGE_ID ??= import.meta.env.VITE_TUNNEL_PACKAGE_ID;

import { Transaction } from "@mysten/sui/transactions";
import { core, onchain } from "sui-tunnel-ts";

const SUI = "0x2::sui::SUI";
type SdkTx = Parameters<typeof onchain.buildCreateAndShare>[0];

export interface PvpParty {
  walletAddress: string;
  ephemeralPubkey: Uint8Array;
}

/** Open + share the tunnel (seat A pays the trivial create gas). penalty = stake. */
export function buildCreateAndShareTx(
  a: PvpParty,
  b: PvpParty,
  stake: bigint,
): Transaction {
  const tx = new Transaction();
  onchain.buildCreateAndShare(tx as unknown as SdkTx, {
    partyA: {
      address: a.walletAddress,
      publicKey: a.ephemeralPubkey,
      signatureType: core.SignatureScheme.ED25519,
    },
    partyB: {
      address: b.walletAddress,
      publicKey: b.ephemeralPubkey,
      signatureType: core.SignatureScheme.ED25519,
    },
    timeoutMs: 86_400_000n,
    penaltyAmount: stake,
  });
  return tx;
}

/** Fund this seat's stake from the wallet's gas coin (signed by the seat's own wallet). */
export function buildDepositTx(tunnelId: string, stake: bigint): Transaction {
  const tx = new Transaction();
  onchain.buildDepositFromGas(tx as unknown as SdkTx, {
    tunnelId,
    amount: stake,
  });
  return tx;
}

/** Cooperative close from the dual-signed settlement (the engine's combineSettlement output). */
export function buildCloseTx(
  tunnelId: string,
  settlement: core.CoSignedSettlement,
): Transaction {
  const tx = new Transaction();
  onchain.buildCloseFromSettlement(
    tx as unknown as SdkTx,
    tunnelId,
    settlement,
    SUI,
  );
  return tx;
}

export const parseTunnelId = onchain.parseTunnelId;
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend/src/games/blackjack && bun run --cwd packages/client typecheck`
Expected: clean (file compiles; not yet imported).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/games/blackjack/packages/client/src/lib/bjPvpOnchain.ts
git commit -m "feat(blackjack): pvp on-chain ptb builders"
```

---

## Task 5: Relay client + multiplexed engine transport

**Files:**

- Create: `frontend/src/games/blackjack/packages/client/src/lib/bjRelay.ts`

A WS client for `GET ${VITE_MP_URL}/v1/mp` matching `mp/protocol.rs`: signed-nonce connect,
quick-match, `party.hello`, `tunnel.opened`, and a relay channel **multiplexed** between the
engine's opaque frames (`t:"frame"`) and app messages such as settlement halves (`t:"settle"`,
`t:"closed"`). Connect-nonce is signed with the **ephemeral** key (raw ed25519, hex).

- [ ] **Step 1: Implement `bjRelay.ts`**

```ts
import { core, bytesToHex } from "sui-tunnel-ts";

type Json = Record<string, unknown>;
export interface MatchInfo {
  matchId: string;
  role: "A" | "B";
  opponentWallet: string;
  game: string;
}
export interface RelayTransport {
  send: (frame: Uint8Array) => void;
  onFrame: (cb: (f: Uint8Array) => void) => void;
}

const dec = new TextDecoder();
const enc = new TextEncoder();

/** One authenticated relay connection for a player. */
export class RelayClient {
  private ws: WebSocket;
  private nonce = "";
  private handlers: Record<string, ((m: Json) => void)[]> = {};
  private frameCbs: Record<string, (f: Uint8Array) => void> = {}; // matchId -> engine onFrame
  private appCbs: Record<string, (m: Json) => void> = {}; // matchId -> app msg handler
  ready: Promise<void>;

  constructor(
    private url: string,
    private walletAddress: string,
    private eph: ReturnType<typeof core.keyPairFromSecret>,
  ) {
    this.ws = new WebSocket(`${url.replace(/\/$/, "")}/v1/mp`);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("error", () =>
        reject(new Error("relay ws error")),
      );
      this.ws.addEventListener("message", (ev) =>
        this.onMessage(String(ev.data), resolve),
      );
    });
  }

  private onMessage(text: string, onConnected: () => void) {
    let m: Json;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    switch (m.type) {
      case "challenge": {
        this.nonce = String(m.nonce);
        const sig = core.sign(enc.encode(this.nonce), this.eph.secretKey);
        this.send({
          type: "connect",
          wallet: this.walletAddress,
          pubkey: bytesToHex(this.eph.publicKey),
          sig: bytesToHex(sig),
          nonce: this.nonce,
        });
        onConnected(); // presence is set server-side on connect; no explicit ack
        break;
      }
      case "relay": {
        const matchId = String(m.matchId);
        let env: Json;
        try {
          env = JSON.parse(String(m.payload));
        } catch {
          return;
        }
        if (env.t === "frame")
          this.frameCbs[matchId]?.(enc.encode(String(env.f)));
        else this.appCbs[matchId]?.(env);
        break;
      }
      default:
        (this.handlers[String(m.type)] ?? []).forEach((h) => h(m));
    }
  }

  private send(o: Json) {
    this.ws.send(JSON.stringify(o));
  }
  on(type: string, cb: (m: Json) => void) {
    (this.handlers[type] ??= []).push(cb);
  }

  queueJoin(game: string) {
    this.send({ type: "queue.join", game });
  }
  partyHello(matchId: string, ephemeralPubkey: string, walletSig: string) {
    this.send({ type: "party.hello", matchId, ephemeralPubkey, walletSig });
  }
  tunnelOpened(matchId: string, tunnelId: string) {
    this.send({ type: "tunnel.opened", matchId, tunnelId });
  }

  /** App-level message to the other seat (settlement half, closed digest, …). */
  sendApp(matchId: string, msg: Json) {
    this.send({ type: "relay", matchId, payload: JSON.stringify({ ...msg }) });
  }
  onApp(matchId: string, cb: (m: Json) => void) {
    this.appCbs[matchId] = cb;
  }

  /** Engine transport for one match: engine frames travel as `{t:"frame", f}` relay payloads. */
  transport(matchId: string): RelayTransport {
    return {
      send: (frame) =>
        this.send({
          type: "relay",
          matchId,
          payload: JSON.stringify({ t: "frame", f: dec.decode(frame) }),
        }),
      onFrame: (cb) => {
        this.frameCbs[matchId] = cb;
      },
    };
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend/src/games/blackjack && bun run --cwd packages/client typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/games/blackjack/packages/client/src/lib/bjRelay.ts
git commit -m "feat(blackjack): pvp relay client + engine transport"
```

---

## Task 6: Headless PvP integration test (full duel over the live relay)

**Files:**

- Create: `frontend/src/games/blackjack/packages/client/scripts/pvpDuelE2E.ts`

Two simulated clients connect to the running relay, quick-match, exchange `party.hello`, then
play a FULL duel through two `DistributedTunnel`s (both auto-bot) and exchange + combine the
settlement halves. Proves the protocol + relay + engine path end-to-end **without** the chain
(a placeholder `tunnelId` is fine — the engine co-signs, it doesn't read chain). The relay
backend must be running (see header).

- [ ] **Step 1: Implement the integration script**

```ts
import { core, bytesToHex } from "sui-tunnel-ts";
import { RelayClient } from "../src/lib/bjRelay";
import {
  BlackjackDuelProtocol,
  STAKE,
  type DuelState,
  type DuelMove,
} from "../src/lib/bjDuelProtocol";

const URL = process.env.MP_URL ?? "ws://127.0.0.1:8080";
const GAME = "blackjack";
const TUNNEL = "0xpvp_test_tunnel"; // placeholder; engine never reads the chain

function mkSeat(name: string) {
  const wallet = core.generateKeyPair(); // stand-in wallet (address only here)
  const eph = core.generateKeyPair();
  return {
    name,
    wallet,
    walletAddr: core.ed25519Address(wallet.publicKey),
    eph: core.keyPairFromSecret(eph.secretKey),
  };
}

async function run() {
  const a = mkSeat("A");
  const b = mkSeat("B");
  const ra = new RelayClient(URL, a.walletAddr, a.eph);
  const rb = new RelayClient(URL, b.walletAddr, b.eph);
  await Promise.all([ra.ready, rb.ready]);

  const matched = new Promise<{ ma: any; mb: any }>((resolve) => {
    let ma: any, mb: any;
    ra.on("match.found", (m) => {
      ma = m;
      if (mb) resolve({ ma, mb });
    });
    rb.on("match.found", (m) => {
      mb = m;
      if (ma) resolve({ ma, mb });
    });
  });
  ra.queueJoin(GAME);
  await new Promise((r) => setTimeout(r, 150));
  rb.queueJoin(GAME);
  const { ma } = await matched;
  const matchId = ma.matchId;

  const backend = core.defaultBackend();
  const mk = (
    self: typeof a,
    opp: typeof b,
    role: "A" | "B",
    relay: RelayClient,
  ) =>
    new core.DistributedTunnel<DuelState, DuelMove>(
      new BlackjackDuelProtocol(),
      {
        tunnelId: TUNNEL,
        self: core.makeEndpoint(
          backend,
          self.walletAddr,
          {
            publicKey: self.eph.publicKey,
            scheme: 0,
            secretKey: self.eph.secretKey,
          },
          true,
        ),
        opponent: core.makeEndpoint(
          backend,
          opp.walletAddr,
          { publicKey: opp.eph.publicKey, scheme: 0 },
          false,
        ),
        selfParty: role,
      },
      relay.transport(matchId),
      { a: STAKE, b: STAKE },
    );
  const ta = mk(a, b, "A", ra);
  const tb = mk(b, a, "B", rb);

  // Both bots: whenever it's my turn, propose basic strategy until terminal.
  const proto = new BlackjackDuelProtocol();
  const drive = (
    t: core.DistributedTunnel<DuelState, DuelMove>,
    seat: "A" | "B",
  ) => {
    const step = () => {
      const s = t.state;
      if (proto.isTerminal(s)) return;
      const turn = s.phase === "a_turn" ? "A" : "B";
      if (turn !== seat) return;
      const mv = proto.randomMove(s, seat, Math.random);
      if (mv) t.propose(mv, BigInt(1)); // fixed ts; not chain-checked in this headless test
    };
    t.onConfirmed = () => step();
    return step;
  };
  drive(ta, "A")(); // A kicks off (it's a_turn)
  drive(tb, "B");

  // Wait for both to reach terminal.
  await new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (proto.isTerminal(ta.state) && proto.isTerminal(tb.state)) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - t0 > 15000) {
        clearInterval(iv);
        reject(new Error("duel did not terminate"));
      }
    }, 50);
  });

  const ok1 =
    JSON.stringify(ta.protocol.balances(ta.state)) ===
    JSON.stringify(tb.protocol.balances(tb.state));
  console.log(
    ok1 ? "PASS  both seats agree on final balances" : "FAIL  balances differ",
    ta.protocol.balances(ta.state),
  );

  // Exchange + combine settlement halves over the relay (app channel).
  const ha = ta.buildSettlementHalf(BigInt(1));
  const hb = tb.buildSettlementHalf(BigInt(1));
  const gotB = new Promise<Uint8Array>((res) =>
    ra.onApp(matchId, (m) => {
      if (m.t === "settle")
        res(Uint8Array.from(Buffer.from(String(m.sig), "hex")));
    }),
  );
  const gotA = new Promise<Uint8Array>((res) =>
    rb.onApp(matchId, (m) => {
      if (m.t === "settle")
        res(Uint8Array.from(Buffer.from(String(m.sig), "hex")));
    }),
  );
  rb.sendApp(matchId, { t: "settle", sig: bytesToHex(hb.sigSelf) });
  ra.sendApp(matchId, { t: "settle", sig: bytesToHex(ha.sigSelf) });
  const coSignedA = ta.combineSettlement(ha.settlement, ha.sigSelf, await gotB);
  void tb.combineSettlement(hb.settlement, hb.sigSelf, await gotA);
  const ok2 = !!coSignedA.sigA && !!coSignedA.sigB;
  console.log(
    ok2 ? "PASS  settlement co-signed + verified" : "FAIL  settlement combine",
  );

  ra.close();
  rb.close();
  const allOk = ok1 && ok2;
  console.log(allOk ? "\nHEADLESS PVP DUEL OK" : "\nFAILED");
  process.exit(allOk ? 0 : 1);
}
run().catch((e) => {
  console.error("E2E ERROR:", e);
  process.exit(2);
});
```

- [ ] **Step 2: Run it against the live relay**

Start the backend (header command) in another terminal, then:

```bash
cd /Users/alvin/Developer/dopamint-arena/frontend/src/games/blackjack
bun run packages/client/scripts/pvpDuelE2E.ts
```

Expected: `PASS  both seats agree on final balances`, `PASS  settlement co-signed + verified`,
`HEADLESS PVP DUEL OK`, exit 0. (If it can't connect, the relay isn't running.)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/games/blackjack/packages/client/scripts/pvpDuelE2E.ts
git commit -m "test(blackjack): headless pvp duel over relay"
```

> **Milestone:** Tasks 1–6 prove the protocol + relay + engine + settlement path end-to-end.

---

## Task 7: Orchestration hook `usePvpBlackjack`

**Files:**

- Create: `frontend/src/games/blackjack/packages/client/src/hooks/usePvpBlackjack.ts`

Drives the whole online match: connect → quick-match → exchange+verify `party.hello` → open
(seat A) / wait (seat B) → verify seat → deposit → detect activation → `DistributedTunnel`
play (human moves + per-seat bot toggle) → exchange settlement halves → cooperative close.
Reuses `getSuiClient`/faucet from `@/lib/bjBots`, the wallet/ephemeral/attestation from
`@/lib/bjPvpIdentity`, on-chain builders from `@/lib/bjPvpOnchain`, the relay from
`@/lib/bjRelay`, and `BlackjackDuelProtocol`.

- [ ] **Step 1: Implement the hook**

```ts
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { core, bytesToHex } from "sui-tunnel-ts";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiClient } from "@mysten/sui/client";
import { getSuiClient } from "@/lib/bjBots";
import {
  loadOrCreateWallet,
  getOrCreateEphemeral,
  attestEphemeral,
  verifyAttestation,
} from "@/lib/bjPvpIdentity";
import {
  buildCreateAndShareTx,
  buildDepositTx,
  buildCloseTx,
  parseTunnelId,
} from "@/lib/bjPvpOnchain";
import { RelayClient } from "@/lib/bjRelay";
import {
  BlackjackDuelProtocol,
  STAKE,
  type DuelState,
  type DuelMove,
} from "@/lib/bjDuelProtocol";

const MP_URL = import.meta.env.VITE_MP_URL ?? "ws://127.0.0.1:8080";
const BOT_MOVE_MS = 700;

export type PvpPhase =
  | "idle"
  | "connecting"
  | "queuing"
  | "opening"
  | "funding"
  | "playing"
  | "settling"
  | "done"
  | "error"
  | "interrupted";

export interface PvpView {
  phase: PvpPhase;
  error: string | null;
  role: "A" | "B" | null;
  myHand: number[];
  oppHand: number[];
  dealerHand: number[];
  myTurn: boolean;
  state: DuelState | null;
  result: "win" | "lose" | "push" | null;
  auto: boolean;
  walletAddress: string;
  walletBalance: bigint;
  digests: { create?: string; deposit?: string; close?: string };
  fund: () => void;
  queue: () => void;
  hit: () => void;
  stand: () => void;
  setAuto: (on: boolean) => void;
  leave: () => void;
}

export function usePvpBlackjack(): PvpView {
  const client = useMemo<SuiClient>(() => getSuiClient(), []);
  const wallet = useMemo<Ed25519Keypair>(() => loadOrCreateWallet(), []);
  const walletAddress = useMemo(
    () => wallet.getPublicKey().toSuiAddress(),
    [wallet],
  );
  const proto = useMemo(() => new BlackjackDuelProtocol(), []);

  const [phase, setPhase] = useState<PvpPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<"A" | "B" | null>(null);
  const [state, setState] = useState<DuelState | null>(null);
  const [auto, setAutoState] = useState(false);
  const [walletBalance, setWalletBalance] = useState<bigint>(0n);
  const [digests, setDigests] = useState<{
    create?: string;
    deposit?: string;
    close?: string;
  }>({});

  const relayRef = useRef<RelayClient | null>(null);
  const tunnelRef = useRef<core.DistributedTunnel<DuelState, DuelMove> | null>(
    null,
  );
  const roleRef = useRef<"A" | "B" | null>(null);
  const autoRef = useRef(false);
  const createdAtRef = useRef<bigint>(0n);
  const matchIdRef = useRef<string>("");
  const settledRef = useRef(false);
  // App-channel resolvers (the backend forwards `relay` payloads but NOT tunnel.opened, so the
  // opener delivers the tunnelId to B over the app channel; settle halves arrive the same way).
  const openedResolveRef = useRef<((id: string) => void) | null>(null);
  const settleResolveRef = useRef<((sig: Uint8Array) => void) | null>(null);
  const bufferedSettleRef = useRef<Uint8Array | null>(null);

  const refreshBalance = useCallback(async () => {
    try {
      const b = await client.getBalance({ owner: walletAddress });
      setWalletBalance(BigInt(b.totalBalance));
    } catch {
      /* ignore */
    }
  }, [client, walletAddress]);
  useEffect(() => {
    void refreshBalance();
  }, [refreshBalance]);

  const submit = useCallback(
    async (tx: any) => {
      const res = await client.signAndExecuteTransaction({
        signer: wallet,
        transaction: tx,
        options: { showObjectChanges: true, showEffects: true },
      });
      if (res.effects?.status?.status !== "success")
        throw new Error(res.effects?.status?.error ?? "tx failed");
      await client.waitForTransaction({ digest: res.digest });
      return res;
    },
    [client, wallet],
  );

  const fund = useCallback(() => {
    void (async () => {
      try {
        const { requestSuiFromFaucetV2, getFaucetHost } =
          await import("@mysten/sui/faucet");
        await requestSuiFromFaucetV2({
          host: getFaucetHost("testnet"),
          recipient: walletAddress,
        });
        for (let i = 0; i < 8; i++) {
          await refreshBalance();
          await new Promise((r) => setTimeout(r, 1500));
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [walletAddress, refreshBalance]);

  const finishSettle = useCallback(
    async (
      t: core.DistributedTunnel<DuelState, DuelMove>,
      relay: RelayClient,
      matchId: string,
    ) => {
      if (settledRef.current) return;
      settledRef.current = true;
      setPhase("settling");
      const half = t.buildSettlementHalf(createdAtRef.current); // both sign with the on-chain created_at
      relay.sendApp(matchId, { t: "settle", sig: bytesToHex(half.sigSelf) });
      // Use the opponent's half if it already arrived (buffered by the dispatcher), else await it.
      const otherSig =
        bufferedSettleRef.current ??
        (await new Promise<Uint8Array>((res) => {
          settleResolveRef.current = res;
        }));
      const coSigned = t.combineSettlement(
        half.settlement,
        half.sigSelf,
        otherSig,
      );
      if (roleRef.current === "A") {
        // A submits the cooperative close, then broadcasts the digest
        const res = await submit(buildCloseTx(t.tunnelId, coSigned));
        setDigests((d) => ({ ...d, close: res.digest }));
        relay.sendApp(matchId, { t: "closed", digest: res.digest });
      }
      await refreshBalance();
      setPhase("done");
    },
    [submit, refreshBalance],
  );

  const queue = useCallback(() => {
    void (async () => {
      setError(null);
      setPhase("connecting");
      settledRef.current = false;
      try {
        // Per-connection ephemeral key is bound at match time; use a temporary one for connect auth.
        const connEph = core.generateKeyPair();
        const relay = new RelayClient(
          MP_URL,
          walletAddress,
          core.keyPairFromSecret(connEph.secretKey),
        );
        relayRef.current = relay;
        await relay.ready;
        setPhase("queuing");
        relay.on("error", (m) => {
          setError(`${m.code}: ${m.message}`);
        });
        relay.on("match.found", (m) => {
          void onMatch(relay, m as any);
        });
        relay.queueJoin("blackjack");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    })();
  }, [walletAddress]); // eslint-disable-line react-hooks/exhaustive-deps

  const onMatch = useCallback(
    async (
      relay: RelayClient,
      m: { matchId: string; role: "A" | "B"; opponentWallet: string },
    ) => {
      try {
        matchIdRef.current = m.matchId;
        roleRef.current = m.role;
        setRole(m.role);
        // One persistent app-channel dispatcher per match: opened tunnelId, settle half, closed digest.
        relay.onApp(m.matchId, (mm) => {
          if (mm.t === "opened")
            openedResolveRef.current?.(String(mm.tunnelId));
          else if (mm.t === "settle") {
            const sig = Uint8Array.from(Buffer.from(String(mm.sig), "hex"));
            if (settleResolveRef.current) settleResolveRef.current(sig);
            else bufferedSettleRef.current = sig;
          } else if (mm.t === "closed")
            setDigests((d) => ({ ...d, close: String(mm.digest) }));
        });
        // Register the party.hello capture SYNCHRONOUSLY (before any await) so an early arrival
        // from the opponent can't be dropped.
        let helloResolve!: (h: {
          ephemeralPubkey: string;
          walletSig: string;
        }) => void;
        const oppHelloMsg = new Promise<{
          ephemeralPubkey: string;
          walletSig: string;
        }>((res) => {
          helloResolve = res;
        });
        relay.on("party.hello", (h) => {
          if (h.matchId === m.matchId)
            helloResolve({
              ephemeralPubkey: String(h.ephemeralPubkey),
              walletSig: String(h.walletSig),
            });
        });

        const myEph = await getOrCreateEphemeral(m.matchId);
        const walletSig = await attestEphemeral(
          wallet,
          m.matchId,
          myEph.pubkeyHex,
        );
        relay.partyHello(m.matchId, myEph.pubkeyHex, walletSig);

        // Exchange + verify wallet-attested ephemeral pubkeys.
        const oppHello = await oppHelloMsg;
        if (
          !(await verifyAttestation(
            m.matchId,
            oppHello.ephemeralPubkey,
            oppHello.walletSig,
            m.opponentWallet,
          ))
        ) {
          throw new Error("opponent attestation failed");
        }
        const oppEphPubkey = Uint8Array.from(
          Buffer.from(oppHello.ephemeralPubkey, "hex"),
        );

        // Open (A) or wait for tunnel.opened (B).
        let tunnelId: string;
        if (m.role === "A") {
          setPhase("opening");
          const res = await submit(
            buildCreateAndShareTx(
              { walletAddress, ephemeralPubkey: myEph.coreKey.publicKey },
              {
                walletAddress: m.opponentWallet,
                ephemeralPubkey: oppEphPubkey,
              },
              STAKE,
            ),
          );
          const id = parseTunnelId(res.objectChanges);
          if (!id) throw new Error("no tunnelId");
          tunnelId = id;
          setDigests((d) => ({ ...d, create: res.digest }));
          relay.tunnelOpened(m.matchId, tunnelId); // server record
          relay.sendApp(m.matchId, { t: "opened", tunnelId }); // deliver to B (server doesn't forward tunnel.opened)
        } else {
          setPhase("opening");
          tunnelId = await new Promise<string>((resolve) => {
            openedResolveRef.current = resolve;
          });
        }

        // Read created_at (shared settlement timestamp) + verify own seat.
        const obj = await client.getObject({
          id: tunnelId,
          options: { showContent: true },
        });
        const fields = (
          obj.data?.content as { fields?: Record<string, unknown> } | undefined
        )?.fields;
        createdAtRef.current = BigInt(
          (fields?.created_at as string | undefined) ?? 0,
        );

        // Fund own seat, then wait for activation (both deposits) on-chain.
        setPhase("funding");
        const dep = await submit(buildDepositTx(tunnelId, STAKE));
        setDigests((d) => ({ ...d, deposit: dep.digest }));
        for (let i = 0; i < 40; i++) {
          const o = await client.getObject({
            id: tunnelId,
            options: { showContent: true },
          });
          const f = (
            o.data?.content as { fields?: Record<string, unknown> } | undefined
          )?.fields;
          if (
            Number(f?.status ?? 0) >= 1 &&
            BigInt((f?.party_a_deposit as string) ?? 0) > 0n &&
            BigInt((f?.party_b_deposit as string) ?? 0) > 0n
          )
            break;
          await new Promise((r) => setTimeout(r, 1500));
        }

        // Build the engine over the relay transport and start playing.
        const backend = core.defaultBackend();
        const t = new core.DistributedTunnel<DuelState, DuelMove>(
          proto,
          {
            tunnelId,
            self: core.makeEndpoint(
              backend,
              walletAddress,
              {
                publicKey: myEph.coreKey.publicKey,
                scheme: 0,
                secretKey: myEph.coreKey.secretKey,
              },
              true,
            ),
            opponent: core.makeEndpoint(
              backend,
              m.opponentWallet,
              { publicKey: oppEphPubkey, scheme: 0 },
              false,
            ),
            selfParty: m.role,
          },
          relay.transport(m.matchId),
          { a: STAKE, b: STAKE },
        );
        tunnelRef.current = t;

        const onAdvance = () => {
          setState({ ...t.state });
          if (proto.isTerminal(t.state)) {
            void finishSettle(t, relay, m.matchId);
            return;
          }
          const turn = t.state.phase === "a_turn" ? "A" : "B";
          if (turn === m.role && autoRef.current) {
            const mv = proto.randomMove(t.state, m.role, Math.random);
            if (mv)
              setTimeout(() => {
                try {
                  t.propose(mv, BigInt(Date.now()));
                } catch {
                  /* not my turn / in flight */
                }
              }, BOT_MOVE_MS);
          }
        };
        t.onConfirmed = () => onAdvance();
        setPhase("playing");
        setState({ ...t.state });
        onAdvance(); // if it's my turn and auto, kick off
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    },
    [client, proto, submit, wallet, walletAddress, finishSettle],
  );

  const propose = useCallback((action: "hit" | "stand") => {
    const t = tunnelRef.current;
    if (!t) return;
    const turn = t.state.phase === "a_turn" ? "A" : "B";
    if (turn !== roleRef.current) return;
    try {
      t.propose({ action }, BigInt(Date.now()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  const hit = useCallback(() => propose("hit"), [propose]);
  const stand = useCallback(() => propose("stand"), [propose]);
  const setAuto = useCallback(
    (on: boolean) => {
      autoRef.current = on;
      setAutoState(on);
      const t = tunnelRef.current;
      if (on && t && !proto.isTerminal(t.state)) {
        const turn = t.state.phase === "a_turn" ? "A" : "B";
        if (turn === roleRef.current) {
          const mv = proto.randomMove(t.state, roleRef.current!, Math.random);
          if (mv)
            setTimeout(() => {
              try {
                t.propose(mv, BigInt(Date.now()));
              } catch {
                /* ignore */
              }
            }, BOT_MOVE_MS);
        }
      }
    },
    [proto],
  );
  const leave = useCallback(() => {
    relayRef.current?.close();
    relayRef.current = null;
    tunnelRef.current = null;
    setPhase("idle");
    setState(null);
    setRole(null);
    setDigests({});
    settledRef.current = false;
  }, []);

  useEffect(() => () => relayRef.current?.close(), []);

  const s = state;
  const myTurn =
    !!s &&
    s.phase !== "over" &&
    (s.phase === "a_turn" ? "A" : "B") === roleRef.current;
  const myHand = s ? (roleRef.current === "A" ? s.handA : s.handB) : [];
  const oppHand = s ? (roleRef.current === "A" ? s.handB : s.handA) : [];
  // Hide the dealer's hole card(s) until the duel is over.
  const dealerHand = s
    ? s.phase === "over"
      ? s.dealerHand
      : s.dealerHand.slice(0, 1)
    : [];
  let result: "win" | "lose" | "push" | null = null;
  if (s?.phase === "over") {
    const mine = roleRef.current === "A" ? s.balanceA : s.balanceB;
    result = mine > STAKE ? "win" : mine < STAKE ? "lose" : "push";
  }

  return {
    phase,
    error,
    role,
    myHand,
    oppHand,
    dealerHand,
    myTurn,
    state: s,
    result,
    auto,
    walletAddress,
    walletBalance,
    digests,
    fund,
    queue,
    hit,
    stand,
    setAuto,
    leave,
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend/src/games/blackjack && bun run --cwd packages/client typecheck`
Expected: clean. (If `res.objectChanges`/`fields` typing needs a cast, add `as any` at that
boundary only — the engine + protocol types must stay strict.)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/games/blackjack/packages/client/src/hooks/usePvpBlackjack.ts
git commit -m "feat(blackjack): usePvpBlackjack orchestration hook"
```

---

## Task 8: UI — `PvpBlackjack` page + menu entry + route

**Files:**

- Create: `frontend/src/games/blackjack/packages/client/src/pages/PvpBlackjack.tsx`
- Modify: `frontend/src/games/blackjack/packages/client/src/pages/Home.tsx`
- Modify: `frontend/src/games/blackjack/packages/client/src/App.tsx`
- Modify: `frontend/src/games/blackjack/packages/client/.env`

Reuses `CardDisplay` (`cards` = display indices via `handToCardIndices`, `sum` = `handValue`)
and the casino styling. Matchmaking → duel table with Hit/Stand + an Auto-bot toggle.

- [ ] **Step 1: Add the relay URL env var**

Append to `frontend/src/games/blackjack/packages/client/.env`:

```
VITE_MP_URL="ws://127.0.0.1:8080"
```

- [ ] **Step 2: Implement `PvpBlackjack.tsx`**

```tsx
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { usePvpBlackjack } from "@/hooks/usePvpBlackjack";
import { CardDisplay } from "@/components/app/CardDisplay";
import { handToCardIndices, handValue } from "@/lib/bjCards";

const fmt = (mist: bigint) => (Number(mist) / 1e9).toFixed(3);

export default function PvpBlackjack() {
  const g = usePvpBlackjack();
  const navigate = useNavigate();
  useEffect(() => {
    document.title = "Blackjack — PvP";
  }, []);
  const funded = g.walletBalance > 20_000_000n;

  return (
    <div className="w-screen h-screen flex flex-col items-center justify-center menu-background text-white p-4 overflow-auto select-none">
      <div className="bg-zinc-950/90 border border-zinc-800 rounded-2xl p-6 w-full max-w-2xl shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-2xl font-black text-gold uppercase tracking-widest">
            Blackjack · PvP
          </h1>
          <button
            onClick={() => {
              g.leave();
              navigate("/");
            }}
            className="text-xs text-zinc-400 hover:text-white"
          >
            ← menu
          </button>
        </div>

        <div className="text-[11px] text-zinc-500 mb-4 font-mono break-all">
          wallet {g.walletAddress.slice(0, 10)}… · {fmt(g.walletBalance)} SUI
        </div>

        {(g.phase === "idle" ||
          g.phase === "connecting" ||
          g.phase === "queuing" ||
          g.phase === "error") && (
          <div className="flex flex-col gap-3">
            {!funded && (
              <button
                onClick={g.fund}
                className="w-full bg-zinc-800 hover:bg-zinc-700 py-3 rounded-xl font-bold"
              >
                Fund wallet (faucet)
              </button>
            )}
            <button
              onClick={g.queue}
              disabled={
                !funded || g.phase === "queuing" || g.phase === "connecting"
              }
              className="w-full bg-gradient-to-r from-amber-500 to-amber-600 text-zinc-950 font-black py-4 rounded-xl uppercase tracking-widest disabled:opacity-40"
            >
              {g.phase === "queuing"
                ? "Finding an opponent…"
                : g.phase === "connecting"
                  ? "Connecting…"
                  : "Find match"}
            </button>
            {g.phase === "queuing" && (
              <button
                onClick={g.leave}
                className="text-xs text-zinc-400 hover:text-white"
              >
                cancel
              </button>
            )}
            {g.error && <div className="text-rose-400 text-sm">{g.error}</div>}
          </div>
        )}

        {(g.phase === "opening" || g.phase === "funding") && (
          <div className="text-center text-amber-400 py-8 animate-pulse">
            {g.phase === "opening"
              ? "Opening tunnel on-chain…"
              : "Funding your seat…"}
          </div>
        )}

        {(g.phase === "playing" ||
          g.phase === "settling" ||
          g.phase === "done") &&
          g.state && (
            <div className="flex flex-col gap-4">
              <CardDisplay
                title="Dealer"
                cards={handToCardIndices(g.dealerHand, 999)}
                sum={g.phase === "done" ? handValue(g.dealerHand) : 0}
              />
              <div className="grid grid-cols-2 gap-3">
                <CardDisplay
                  title={`You (${g.role})`}
                  cards={handToCardIndices(g.myHand, 1)}
                  sum={handValue(g.myHand)}
                  isPlayer
                />
                <CardDisplay
                  title="Opponent"
                  cards={handToCardIndices(g.oppHand, 2)}
                  sum={handValue(g.oppHand)}
                />
              </div>

              <label className="flex items-center gap-2 text-sm text-zinc-300">
                <input
                  type="checkbox"
                  checked={g.auto}
                  onChange={(e) => g.setAuto(e.target.checked)}
                />
                Auto (let my bot play)
              </label>

              {g.phase === "playing" && (
                <div className="flex gap-3">
                  <button
                    onClick={g.hit}
                    disabled={!g.myTurn || g.auto}
                    className="flex-1 bg-amber-600 disabled:opacity-30 text-zinc-950 font-black py-3 rounded-xl"
                  >
                    Hit
                  </button>
                  <button
                    onClick={g.stand}
                    disabled={!g.myTurn || g.auto}
                    className="flex-1 bg-zinc-700 disabled:opacity-30 font-black py-3 rounded-xl"
                  >
                    Stand
                  </button>
                </div>
              )}
              {!g.myTurn && g.phase === "playing" && (
                <div className="text-center text-zinc-400 text-sm">
                  Opponent's turn…
                </div>
              )}
              {g.phase === "settling" && (
                <div className="text-center text-amber-400 animate-pulse">
                  Settling on-chain…
                </div>
              )}
              {g.phase === "done" && (
                <div className="text-center">
                  <div
                    className={`text-3xl font-black ${g.result === "win" ? "text-emerald-400" : g.result === "lose" ? "text-rose-400" : "text-zinc-300"}`}
                  >
                    {g.result === "win"
                      ? "You win!"
                      : g.result === "lose"
                        ? "You lose"
                        : "Push"}
                  </div>
                  <button
                    onClick={() => {
                      g.leave();
                      g.queue();
                    }}
                    className="mt-4 bg-amber-600 text-zinc-950 font-black px-6 py-3 rounded-xl"
                  >
                    Rematch
                  </button>
                </div>
              )}

              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-500 font-mono">
                {g.digests.create && (
                  <a
                    className="underline"
                    target="_blank"
                    rel="noreferrer"
                    href={`https://suiscan.xyz/testnet/tx/${g.digests.create}`}
                  >
                    open {g.digests.create.slice(0, 6)}…
                  </a>
                )}
                {g.digests.deposit && (
                  <a
                    className="underline"
                    target="_blank"
                    rel="noreferrer"
                    href={`https://suiscan.xyz/testnet/tx/${g.digests.deposit}`}
                  >
                    deposit {g.digests.deposit.slice(0, 6)}…
                  </a>
                )}
                {g.digests.close && (
                  <a
                    className="underline"
                    target="_blank"
                    rel="noreferrer"
                    href={`https://suiscan.xyz/testnet/tx/${g.digests.close}`}
                  >
                    close {g.digests.close.slice(0, 6)}…
                  </a>
                )}
              </div>
              {g.error && (
                <div className="text-rose-400 text-sm">{g.error}</div>
              )}
            </div>
          )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add the menu entry** in `Home.tsx`

After the existing "Watch Bot Arena" button (the `navigate("/bot")` button), add:

```tsx
<button
  onClick={() => navigate("/pvp")}
  className="w-full bg-zinc-900 hover:bg-zinc-800 text-zinc-300 hover:text-white border border-zinc-800 font-bold py-3 rounded-xl text-sm uppercase tracking-wider transition-all active:scale-95"
>
  🌐 Play vs Player (online)
</button>
```

- [ ] **Step 4: Add the route** in `App.tsx`

Add the import after `import PlayerVsDealer ...`:

```tsx
import PvpBlackjack from "@/pages/PvpBlackjack";
```

Add the route inside `<Routes>` (before the `*` catch-all):

```tsx
<Route path="/pvp" element={<PvpBlackjack />} />
```

- [ ] **Step 5: Typecheck + build**

Run: `cd frontend/src/games/blackjack && bun run --cwd packages/client typecheck && bun run build`
Expected: typecheck clean; build succeeds (the pre-existing chunk-size warning is benign).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/games/blackjack/packages/client/src/pages/PvpBlackjack.tsx \
        frontend/src/games/blackjack/packages/client/src/pages/Home.tsx \
        frontend/src/games/blackjack/packages/client/src/App.tsx \
        frontend/src/games/blackjack/packages/client/.env.example
echo 'VITE_MP_URL="ws://127.0.0.1:8080"' >> frontend/src/games/blackjack/packages/client/.env.example
git add frontend/src/games/blackjack/packages/client/.env.example
git commit -m "feat(blackjack): pvp online page + menu entry"
```

(`.env` is gitignored — Step 1 edits it locally; commit only `.env.example`.)

---

## Task 9: Full build + manual two-tab e2e

**Files:** none (verification only)

- [ ] **Step 1: Re-run the protocol/identity units + build**

```bash
cd /Users/alvin/Developer/dopamint-arena/frontend/src/games/blackjack
bun test packages/client/src/lib/bjDuelProtocol.test.ts packages/client/src/lib/bjPvpIdentity.test.ts
bun run --cwd packages/client typecheck && bun run build
```

Expected: all tests pass; typecheck clean; build succeeds.

- [ ] **Step 2: Manual two-tab e2e (testnet)**

Start the relay backend (header command). Then `bun run dev` and open **two** browser tabs at
the dev URL. In each: menu → **Play vs Player (online)** → Fund wallet (faucet) → **Find match**.
Verify: both tabs match, open + fund complete (digests link to suiscan), a hand plays
(try one tab on **Auto** and one manual Hit/Stand), the dealer reveals at the end, and the
**close** digest appears with the pot paid to the winner's wallet (balances update). Confirm
the existing **Play vs Dealer** / **Watch Bot Arena** self-play modes still work unchanged.

- [ ] **Step 3: No commit** (verification). If a defect surfaces, fix it in the owning task's
      files and re-run.

---

## Self-review notes (for the executor)

- **Type names are consistent across tasks:** `DuelState`, `DuelMove`, `DuelPhase`,
  `BlackjackDuelProtocol`, `STAKE`, `settleOutcome` (Task 2); `loadOrCreateWallet`,
  `getOrCreateEphemeral`, `attestEphemeral`, `verifyAttestation` (Task 3); `buildCreateAndShareTx`,
  `buildDepositTx`, `buildCloseTx`, `parseTunnelId` (Task 4); `RelayClient`, `RelayTransport`,
  `MatchInfo` (Task 5); `usePvpBlackjack`/`PvpView` (Task 7). The hook + integration test use the
  SDK `core.DistributedTunnel`/`core.makeEndpoint`/`core.defaultBackend` exposed in Task 1.
- **Identity rule:** `makeEndpoint(backend, walletAddress, { publicKey: ephemeralPubkey, scheme:0,
secretKey? }, controlled)` — wallet address + ephemeral pubkey passed separately everywhere;
  `create_and_share` registers `{ address: wallet, publicKey: ephemeral }` per seat.
- **Settlement timestamp:** both seats sign `buildSettlementHalf(createdAt)` with the on-chain
  `created_at` so the messages are byte-identical; `onchainNonce=0` ⇒ `finalNonce=1` (no
  `update_state`); seat A submits the cooperative close.
- **No repo-core edits beyond Task 1** (`src/core/index.ts`); never stage `sui_tunnel/**` or
  other `sui-tunnel-ts/**` source; `.env` is gitignored (only `.env.example` is committed).
- **Relay multiplexing:** engine frames travel as `{t:"frame"}` relay payloads; settlement
  halves + closed-digest as `{t:"settle"}` / `{t:"closed"}` — demuxed by `RelayClient`.
