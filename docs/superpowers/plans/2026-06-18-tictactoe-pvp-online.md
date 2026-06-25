# Tic-Tac-Toe PvP Online Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an online PvP mode to the tic-tac-toe game — two humans matched over the relay server, playing classic 3×3 or caro (N×N 5-in-a-row), each move co-signed off-chain via `DistributedTunnel`, with one cooperative on-chain settlement, plus an auto mode where a local strategy bot plays the user's turns.

**Architecture:** A self-contained PvP flow beside the existing bot-vs-bot self-play, reusing the relay + on-chain tunnel infra proven by blackjack PvP. A new `usePvpTicTacToe(variant, boardSize)` hook drives `core.DistributedTunnel` over the relay with the existing `MultiGameTicTacToeProtocol` / `MultiGameCaroProtocol` and the existing bots. Each player has one local faucet-funded keypair used as both wallet and move-signer. A new `pvp` scene renders the lobby + interactive board.

**Tech Stack:** TypeScript, React, bun + vite (ttt client), `bun test` (`@ttt/shared`), `sui-tunnel-ts` (repo-root SDK, supplies `DistributedTunnel`), `@mysten/sui`.

**Spec:** `docs/superpowers/specs/2026-06-18-tictactoe-pvp-online-design.md`

---

## File Structure

Working directory for all paths below: repo root `/Users/alvin/Developer/dopamint-arena`.
ttt client root: `frontend/src/games/ticTacToe/packages/client/src/`.

Created:

- `lib/pvpRelay.ts` — relay WebSocket client (verbatim port of blackjack's `bjRelay.ts`).
- `lib/pvpIdentity.ts` — `loadOrCreateMe()` single local keypair + faucet/balance helpers.
- `lib/pvpOnchain.ts` — `buildCreateAndShareTx` / `buildDepositTx` / `buildCloseTx` / `parseTunnelId`.
- `hooks/usePvpTicTacToe.ts` — the PvP engine hook (the bulk of the feature).
- `scenes/PvpScene.tsx` — lobby + interactive table.
- `packages/shared/src/.../` — no new shared files (protocols/bots already exist).
- `lib/pvpEngine.e2e.test.ts` — headless two-`DistributedTunnel` integration test (both variants).

Modified:

- `frontend/src/games/ticTacToe/packages/client/package.json` — point `sui-tunnel-ts` at the repo-root SDK.
- `components/CaroBoard.tsx` — add `onPlay?` + `disabled` props (make it interactive).
- `scenes/SetupScene.tsx` — add a "Play online (PvP)" button.
- `App.tsx` — add the `pvp` scene + entry + card sizing.

**Constants (used across tasks):** `STAKE = 1n` (MIST, ttt 3×3 only — caro is fixed 0n by its protocol), `BANKROLL = 1000n` (MIST per seat), `MAX_GAMES = 1000` (high cap → play until Stop), `MP_URL = import.meta.env.VITE_MP_URL ?? "ws://127.0.0.1:8080"`.

---

## Task 0: Switch ttt to the repo-root SDK (hard gate)

The ttt client depends on `reference/sui-tunnel-ts`, an older snapshot **without** `DistributedTunnel`. The repo-root `sui-tunnel-ts` (used by blackjack) is a superset at the same version that exports `DistributedTunnel`, `makeEndpoint`, `defaultBackend`, and the PvP on-chain helpers. This task switches the dependency and proves the self-play still works.

**Files:**

- Modify: `frontend/src/games/ticTacToe/packages/client/package.json:21`

- [ ] **Step 1: Confirm current state is green (baseline)**

Run:

```bash
cd /Users/alvin/Developer/dopamint-arena/frontend/src/games/ticTacToe/packages/shared && bun test 2>&1 | tail -5
cd /Users/alvin/Developer/dopamint-arena/frontend/src/games/ticTacToe/packages/client && bunx tsc --noEmit 2>&1 | tail -5
```

Expected: shared tests pass; client typecheck clean. (Records the baseline before the switch.)

- [ ] **Step 2: Point the SDK dependency at the repo-root copy**

Edit `frontend/src/games/ticTacToe/packages/client/package.json` line 21. The blackjack client uses
`"sui-tunnel-ts": "file:../../../../../../sui-tunnel-ts"` (six `..` from `packages/client` up to the repo root). The ttt client lives at the same depth (`frontend/src/games/ticTacToe/packages/client`), so the same relative target resolves to the repo root:

```json
    "sui-tunnel-ts": "file:../../../../../../sui-tunnel-ts",
```

Replace the existing `"sui-tunnel-ts": "file:../../../reference/sui-tunnel-ts",`.

- [ ] **Step 3: Reinstall**

Run:

```bash
cd /Users/alvin/Developer/dopamint-arena/frontend/src/games/ticTacToe/packages/client && bun install 2>&1 | tail -5
```

Expected: install completes; `sui-tunnel-ts` now resolves to the repo-root package.

- [ ] **Step 4: Verify DistributedTunnel + helpers are now visible**

Run:

```bash
cd /Users/alvin/Developer/dopamint-arena/frontend/src/games/ticTacToe/packages/client
bun -e "const m=require('sui-tunnel-ts'); console.log('DistributedTunnel', typeof m.core.DistributedTunnel, '| makeEndpoint', typeof m.core.makeEndpoint, '| buildCreateAndShare', typeof m.onchain.buildCreateAndShare)"
```

Expected: `DistributedTunnel function | makeEndpoint function | buildCreateAndShare function`.

- [ ] **Step 5: Prove the self-play is unbroken**

Run:

```bash
cd /Users/alvin/Developer/dopamint-arena/frontend/src/games/ticTacToe/packages/shared && bun test 2>&1 | tail -5
cd /Users/alvin/Developer/dopamint-arena/frontend/src/games/ticTacToe/packages/client && bunx tsc --noEmit 2>&1 | tail -10 && bunx vite build 2>&1 | tail -5
```

Expected: shared tests still pass; client typecheck clean; `vite build` succeeds.
**If anything regresses** (API drift in the self-play path), STOP and report — the contingency is Approach 2 (vendor `distributedTunnel.ts` + `distributedFrame.ts` into the ttt client), which changes Tasks 1/3/5/6 imports from `sui-tunnel-ts` to the vendored module.

- [ ] **Step 6: Commit**

```bash
cd /Users/alvin/Developer/dopamint-arena
git add frontend/src/games/ticTacToe/packages/client/package.json frontend/src/games/ticTacToe/packages/client/bun.lock
git commit -m "build(ttt): use repo-root sdk for distributed tunnel"
```

(If `bun install` updated a differently-named lockfile, stage that file instead; do not `git add -A`.)

---

## Task 1: Port the relay client

`bjRelay.ts` is game-agnostic (the queue game name is a caller argument). Copy it verbatim.

**Files:**

- Create: `frontend/src/games/ticTacToe/packages/client/src/lib/pvpRelay.ts`

- [ ] **Step 1: Copy the relay client verbatim**

Run:

```bash
cd /Users/alvin/Developer/dopamint-arena
cp frontend/src/games/blackjack/packages/client/src/lib/bjRelay.ts \
   frontend/src/games/ticTacToe/packages/client/src/lib/pvpRelay.ts
```

The file content is correct as-is: it imports `{ core, bytesToHex }` from `sui-tunnel-ts` (available after Task 0), exposes `RelayClient` with `queueJoin(game)`, `partyHello(matchId, pubkeyHex, walletSig)`, `tunnelOpened`, `sendApp`/`onApp`, and `transport(matchId)`. No edits needed.

- [ ] **Step 2: Typecheck**

Run:

```bash
cd /Users/alvin/Developer/dopamint-arena/frontend/src/games/ticTacToe/packages/client && bunx tsc --noEmit 2>&1 | tail -5
```

Expected: clean (no new errors).

- [ ] **Step 3: Commit**

```bash
cd /Users/alvin/Developer/dopamint-arena
git add frontend/src/games/ticTacToe/packages/client/src/lib/pvpRelay.ts
git commit -m "feat(ttt): add pvp relay client"
```

---

## Task 2: PvP identity (single local keypair)

One persistent ed25519 keypair per browser, used as both the on-chain wallet (Sui `Ed25519Keypair`) and the off-chain move-signer (`core.KeyPair`). Mirrors `lib/bots.ts`'s `loadOrCreateBot` (one seed, both derivations, asserted equal).

**Files:**

- Create: `frontend/src/games/ticTacToe/packages/client/src/lib/pvpIdentity.ts`
- Test: `frontend/src/games/ticTacToe/packages/client/src/lib/pvpIdentity.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/games/ticTacToe/packages/client/src/lib/pvpIdentity.test.ts
import { test, expect, describe } from "bun:test";
import { deriveMe } from "./pvpIdentity";
import { core } from "sui-tunnel-ts";

describe("deriveMe", () => {
  test("on-chain and off-chain public keys agree for the same seed", () => {
    const seed = core.generateKeyPair().secretKey;
    const me = deriveMe(seed);
    expect(me.coreKey.publicKey).toEqual(
      me.keypair.getPublicKey().toRawBytes(),
    );
    expect(me.address).toBe(me.keypair.getPublicKey().toSuiAddress());
    expect(me.pubkeyHex.length).toBe(64); // 32 bytes hex
  });

  test("the same seed derives a stable identity", () => {
    const seed = core.generateKeyPair().secretKey;
    expect(deriveMe(seed).address).toBe(deriveMe(seed).address);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd /Users/alvin/Developer/dopamint-arena/frontend/src/games/ticTacToe/packages/client && bun test src/lib/pvpIdentity.test.ts 2>&1 | tail -8
```

Expected: FAIL — `deriveMe` is not exported (module not found / undefined).

- [ ] **Step 3: Implement the identity module**

```ts
// frontend/src/games/ticTacToe/packages/client/src/lib/pvpIdentity.ts
/**
 * PvP identity: ONE local ed25519 keypair per browser, faucet-funded, used as BOTH the on-chain
 * wallet (open/deposit/close txs) AND the off-chain tunnel move-signer. One seed, two derivations
 * (Sui `Ed25519Keypair` + SDK `core.KeyPair`); we assert their public keys match so the on-chain
 * `PartyConfig.public_key` equals the off-chain signer. Mirrors `lib/bots.ts`. Throwaway testnet
 * identity — the security boundary is the on-chain seat (lobby identity is self-asserted in v1).
 */
import { core } from "sui-tunnel-ts";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { fromHEX, toHEX } from "@mysten/sui/utils";
import { requestSuiFromFaucetV2, getFaucetHost } from "@mysten/sui/faucet";
import type { SuiClient } from "@mysten/sui/client";

const ME_KEY = "ttt_pvp_me.v1";

export interface PvpIdentity {
  coreKey: ReturnType<typeof core.keyPairFromSecret>; // off-chain signer { publicKey, secretKey }
  keypair: Ed25519Keypair; // on-chain signer
  address: string;
  pubkeyHex: string; // 32-byte ed25519 public key, hex
}

/** Build both derivations from a 32-byte seed and assert they agree. Pure (unit-testable). */
export function deriveMe(seed: Uint8Array): PvpIdentity {
  const coreKey = core.keyPairFromSecret(seed);
  const keypair = Ed25519Keypair.fromSecretKey(seed);
  if (toHEX(coreKey.publicKey) !== toHEX(keypair.getPublicKey().toRawBytes())) {
    throw new Error("pvp identity: off/on-chain pubkey mismatch");
  }
  return {
    coreKey,
    keypair,
    address: keypair.getPublicKey().toSuiAddress(),
    pubkeyHex: toHEX(coreKey.publicKey),
  };
}

/** Load (or create + persist) this browser's PvP identity. */
export function loadOrCreateMe(): PvpIdentity {
  let seed: Uint8Array;
  try {
    const stored = localStorage.getItem(ME_KEY);
    if (stored) seed = fromHEX(stored);
    else {
      seed = core.generateKeyPair().secretKey;
      localStorage.setItem(ME_KEY, toHEX(seed));
    }
  } catch {
    seed = core.generateKeyPair().secretKey;
  }
  return deriveMe(seed);
}

/** Fetch the identity's SUI balance (MIST). */
export async function balanceOf(
  client: SuiClient,
  address: string,
): Promise<bigint> {
  try {
    return BigInt((await client.getBalance({ owner: address })).totalBalance);
  } catch {
    return 0n;
  }
}

/** Request testnet SUI from the faucet for this identity. */
export async function faucet(address: string): Promise<void> {
  await requestSuiFromFaucetV2({
    host: getFaucetHost("testnet"),
    recipient: address,
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
cd /Users/alvin/Developer/dopamint-arena/frontend/src/games/ticTacToe/packages/client && bun test src/lib/pvpIdentity.test.ts 2>&1 | tail -8
```

Expected: 2 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
cd /Users/alvin/Developer/dopamint-arena
git add frontend/src/games/ticTacToe/packages/client/src/lib/pvpIdentity.ts frontend/src/games/ticTacToe/packages/client/src/lib/pvpIdentity.test.ts
git commit -m "feat(ttt): add pvp single-key identity"
```

---

## Task 3: PvP on-chain tx builders

Adapt blackjack's `bjPvpOnchain.ts`. Same SDK helpers (`buildCreateAndShare`, `buildDepositFromGas`, `buildCloseFromSettlement`), same `SdkTx` cast pattern already used in ttt's `lib/tunnel.ts` for the @mysten/sui version skew. Penalty is `0n` (we always close cooperatively, so the penalty is never exercised).

**Files:**

- Create: `frontend/src/games/ticTacToe/packages/client/src/lib/pvpOnchain.ts`

- [ ] **Step 1: Implement the tx builders**

```ts
// frontend/src/games/ticTacToe/packages/client/src/lib/pvpOnchain.ts
import { Transaction } from "@mysten/sui/transactions";
import { core, onchain } from "sui-tunnel-ts";

const SUI = "0x2::sui::SUI";
// SDK builders are typed against the SDK's pinned @mysten/sui; the client uses a newer one. The
// built bytes are identical — cast only at this boundary (same pattern as lib/tunnel.ts).
type SdkTx = Parameters<typeof onchain.buildCreateAndShare>[0];

export interface PvpParty {
  walletAddress: string;
  publicKey: Uint8Array;
}

/** Open + share the tunnel registering both parties (the opener pays the trivial create gas). */
export function buildCreateAndShareTx(
  a: PvpParty,
  b: PvpParty,
  penaltyAmount: bigint,
): Transaction {
  const tx = new Transaction();
  onchain.buildCreateAndShare(tx as unknown as SdkTx, {
    partyA: {
      address: a.walletAddress,
      publicKey: a.publicKey,
      signatureType: core.SignatureScheme.ED25519,
    },
    partyB: {
      address: b.walletAddress,
      publicKey: b.publicKey,
      signatureType: core.SignatureScheme.ED25519,
    },
    timeoutMs: 86_400_000n,
    penaltyAmount,
  });
  return tx;
}

/** Fund this seat's bankroll from its own gas coin (signed by the seat's own keypair). */
export function buildDepositTx(tunnelId: string, amount: bigint): Transaction {
  const tx = new Transaction();
  onchain.buildDepositFromGas(tx as unknown as SdkTx, { tunnelId, amount });
  return tx;
}

/** Cooperative close from the dual-signed settlement (combineSettlement output). */
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

Run:

```bash
cd /Users/alvin/Developer/dopamint-arena/frontend/src/games/ticTacToe/packages/client && bunx tsc --noEmit 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
cd /Users/alvin/Developer/dopamint-arena
git add frontend/src/games/ticTacToe/packages/client/src/lib/pvpOnchain.ts
git commit -m "feat(ttt): add pvp on-chain tx builders"
```

---

## Task 4: Make CaroBoard interactive

The 3×3 `Board` already takes `onPlay`/`disabled`. `CaroBoard` is render-only; add optional `onPlay` + `disabled` so PvP can place stones. Backward-compatible (props optional → self-play passes neither and stays read-only).

**Files:**

- Modify: `frontend/src/games/ticTacToe/packages/client/src/components/CaroBoard.tsx`

- [ ] **Step 1: Replace the component with an interactive version**

Replace the entire file with:

```tsx
// frontend/src/games/ticTacToe/packages/client/src/components/CaroBoard.tsx
import { winningLine } from "@ttt/shared";

// Caro board: a fit-to-card size×size grid. Marks: 1 = X (✕), 2 = O (◯). The last move is
// highlighted; once a game is won the 5-in-a-row line is highlighted too (winningLine is empty
// mid-game). Read-only unless `onPlay` is given and `disabled` is false (PvP places stones).
export function CaroBoard({
  board,
  size,
  lastMove,
  onPlay,
  disabled = true,
}: {
  board: number[];
  size: number;
  lastMove: number;
  onPlay?: (cell: number) => void;
  disabled?: boolean;
}) {
  const cell = Math.max(14, Math.floor(320 / size));
  const dim = cell * size;
  const win = new Set(winningLine(board, size, lastMove));
  return (
    <div className="max-w-full max-h-[340px] overflow-auto border-[2px] border-primary rounded-sm bg-surface p-1">
      <div
        className="grid"
        style={{
          gridTemplateColumns: `repeat(${size}, ${cell}px)`,
          gridTemplateRows: `repeat(${size}, ${cell}px)`,
          width: dim,
          height: dim,
        }}
      >
        {board.map((v, i) => {
          const playable = !disabled && v === 0 && !!onPlay;
          return (
            <div
              key={i}
              onClick={playable ? () => onPlay!(i) : undefined}
              className={`flex items-center justify-center border border-primary/15 ${
                win.has(i)
                  ? "bg-secondary/40"
                  : i === lastMove
                    ? "bg-tertiary/30"
                    : ""
              } ${playable ? "cursor-pointer hover:bg-tertiary/20" : ""}`}
              style={{ fontSize: Math.floor(cell * 0.7), lineHeight: 1 }}
            >
              {v === 1 ? (
                <span className="text-primary font-bold">✕</span>
              ) : v === 2 ? (
                <span className="text-secondary font-bold">◯</span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + confirm self-play call site still compiles**

Run:

```bash
cd /Users/alvin/Developer/dopamint-arena/frontend/src/games/ticTacToe/packages/client && bunx tsc --noEmit 2>&1 | tail -8
```

Expected: clean. (The self-play `GameScene` renders `<CaroBoard board size lastMove />` with no `onPlay`/`disabled` — still valid because both are optional and `disabled` defaults to `true`.)

- [ ] **Step 3: Commit**

```bash
cd /Users/alvin/Developer/dopamint-arena
git add frontend/src/games/ticTacToe/packages/client/src/components/CaroBoard.tsx
git commit -m "feat(ttt): make caro board interactive"
```

---

## Task 5: Headless two-tunnel integration test (both variants)

The highest-value test: two `DistributedTunnel`s wired together over an in-memory transport play several games through the _real_ multi-game protocols, and `combineSettlement` yields conserved, matching balances. This proves the two-party engine drives the ttt/caro protocols before any UI exists (mirrors blackjack's `pvpDuelE2E`). It exercises existing code, so it passes once written — a regression guard for the engine↔protocol boundary.

**Files:**

- Create: `frontend/src/games/ticTacToe/packages/client/src/lib/pvpEngine.e2e.test.ts`

- [ ] **Step 1: Write the test**

```ts
// frontend/src/games/ticTacToe/packages/client/src/lib/pvpEngine.e2e.test.ts
import { test, expect, describe } from "bun:test";
import { core, type protocols } from "sui-tunnel-ts";
import {
  MultiGameTicTacToeProtocol,
  MultiGameCaroProtocol,
  optimalMoves,
  CELL_EMPTY,
  CELL_SERVER,
  CELL_PLAYER,
  pickCaroMove,
} from "@ttt/shared";

type CellMove = { cell: number };
type AnyState = {
  inner: { board: number[]; turn: "A" | "B"; winner: number; size?: number };
  gamesPlayed: number;
  maxGames: number;
};

// A pair of in-memory transports that forward frames to each other synchronously.
function linkedTransports() {
  let aCb: ((f: Uint8Array) => void) | null = null;
  let bCb: ((f: Uint8Array) => void) | null = null;
  return {
    a: {
      send: (f: Uint8Array) => bCb?.(f),
      onFrame: (cb: (f: Uint8Array) => void) => {
        aCb = cb;
      },
    },
    b: {
      send: (f: Uint8Array) => aCb?.(f),
      onFrame: (cb: (f: Uint8Array) => void) => {
        bCb = cb;
      },
    },
  };
}

function endpoints(tunnelId: string) {
  const ka = core.generateKeyPair(),
    kb = core.generateKeyPair();
  const backend = core.defaultBackend();
  return {
    selfA: core.makeEndpoint(
      backend,
      "0xA",
      { publicKey: ka.publicKey, scheme: 0, secretKey: ka.secretKey },
      true,
    ),
    oppB: core.makeEndpoint(
      backend,
      "0xB",
      { publicKey: kb.publicKey, scheme: 0 },
      false,
    ),
    selfB: core.makeEndpoint(
      backend,
      "0xB",
      { publicKey: kb.publicKey, scheme: 0, secretKey: kb.secretKey },
      true,
    ),
    oppA: core.makeEndpoint(
      backend,
      "0xA",
      { publicKey: ka.publicKey, scheme: 0 },
      false,
    ),
  };
}

function tttBestCell(inner: { board: number[] }, by: "A" | "B"): number {
  const mark = by === "A" ? 1 : 2;
  const board = inner.board.map((v) =>
    v === 0 ? CELL_EMPTY : v === mark ? CELL_SERVER : CELL_PLAYER,
  );
  return optimalMoves(board, CELL_SERVER)[0];
}

// Drive a full session: both seats auto-play with a deterministic strategy; A advances between
// games. Returns the two tunnels (their states must agree) after playing `maxGames`.
function playOut(variant: "ttt" | "caro", maxGames: number) {
  const tunnelId = "0x" + "11".repeat(32);
  const proto = (variant === "caro"
    ? new MultiGameCaroProtocol(maxGames, 9)
    : new MultiGameTicTacToeProtocol(
        maxGames,
        1n,
      )) as unknown as protocols.Protocol<AnyState, CellMove>;
  const t = linkedTransports();
  const e = endpoints(tunnelId);
  const balances = { a: 1000n, b: 1000n };
  let ts = 1n;
  const A = new core.DistributedTunnel<AnyState, CellMove>(
    proto,
    { tunnelId, self: e.selfA, opponent: e.oppB, selfParty: "A" },
    t.a,
    balances,
  );
  const B = new core.DistributedTunnel<AnyState, CellMove>(
    proto,
    { tunnelId, self: e.selfB, opponent: e.oppA, selfParty: "B" },
    t.b,
    balances,
  );
  const pick = (s: AnyState, by: "A" | "B"): CellMove =>
    variant === "caro"
      ? { cell: pickCaroMove(s.inner as any, by, () => 0.5, "strong") }
      : { cell: tttBestCell(s.inner, by) };

  // Loop until the *session* is terminal. The seat whose turn it is proposes; A drives advances.
  for (let guard = 0; guard < 100_000; guard++) {
    const s = A.state;
    if (proto.isTerminal(s)) break;
    if (s.inner.winner !== 0) {
      A.propose({ cell: 0 }, ts++);
      continue;
    } // between games: A advances
    const mover = s.inner.turn === "A" ? A : B;
    mover.propose(pick(s, s.inner.turn), ts++);
  }
  return { A, B, proto };
}

describe("ttt PvP engine (two DistributedTunnels over a link)", () => {
  for (const variant of ["ttt", "caro"] as const) {
    test(`${variant}: both seats agree and balances are conserved after the session`, () => {
      const { A, B, proto } = playOut(variant, variant === "ttt" ? 3 : 2);
      // Both seats converged on the same state hash.
      expect(core.bytesToHex(A.protocol.encodeState(A.state))).toBe(
        core.bytesToHex(B.protocol.encodeState(B.state)),
      );
      // Settlement: each builds its half, then combines with the other's, verifying signatures.
      const ha = A.buildSettlementHalf(0n);
      const hb = B.buildSettlementHalf(0n);
      const co = A.combineSettlement(ha.settlement, ha.sigSelf, hb.sigSelf);
      expect(co.settlement.partyABalance + co.settlement.partyBBalance).toBe(
        2000n,
      );
      // Caro never moves money (stake 0); ttt may shift the 1-MIST stake on decisive games.
      if (variant === "caro") {
        expect(co.settlement.partyABalance).toBe(1000n);
        expect(co.settlement.partyBBalance).toBe(1000n);
      }
    });
  }
});
```

- [ ] **Step 2: Run the test**

Run:

```bash
cd /Users/alvin/Developer/dopamint-arena/frontend/src/games/ticTacToe/packages/client && bun test src/lib/pvpEngine.e2e.test.ts 2>&1 | tail -10
```

Expected: 2 pass, 0 fail. If a `pickCaroMove`/`optimalMoves` import path differs, the failure names the missing symbol — fix the import from `@ttt/shared` (all are re-exported there per the spec).

- [ ] **Step 3: Commit**

```bash
cd /Users/alvin/Developer/dopamint-arena
git add frontend/src/games/ticTacToe/packages/client/src/lib/pvpEngine.e2e.test.ts
git commit -m "test(ttt): pvp engine drives both variants end to end"
```

---

## Task 6: The PvP engine hook

`usePvpTicTacToe(variant, boardSize)` — adapts blackjack's `usePvpBlackjack.ts`. The match/open/fund/settle scaffolding is structurally identical; the differences are: (1) protocol is the multi-game ttt/caro protocol, (2) the move is a board cell, (3) turn alternates between two humans, (4) A (=X) opens the tunnel + drives the between-games advance + submits the close, (5) on-chain signing uses the local `me` keypair (no dapp-kit), (6) identity is one key (no ephemeral, no attestation — just verify the opponent's pubkey derives its reported address).

**Files:**

- Create: `frontend/src/games/ticTacToe/packages/client/src/hooks/usePvpTicTacToe.ts`

- [ ] **Step 1: Implement the hook (complete file)**

```ts
// frontend/src/games/ticTacToe/packages/client/src/hooks/usePvpTicTacToe.ts
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { core, bytesToHex, hexToBytes, type protocols } from "sui-tunnel-ts";
import { SuiClient } from "@mysten/sui/client";
import { Ed25519PublicKey } from "@mysten/sui/keypairs/ed25519";
import {
  MultiGameTicTacToeProtocol,
  MultiGameCaroProtocol,
  optimalMoves,
  CELL_EMPTY,
  CELL_SERVER,
  CELL_PLAYER,
  pickCaroMove,
} from "@ttt/shared";
import { getSuiClient } from "@/lib/bots";
import {
  loadOrCreateMe,
  balanceOf,
  faucet,
  type PvpIdentity,
} from "@/lib/pvpIdentity";
import {
  buildCreateAndShareTx,
  buildDepositTx,
  buildCloseTx,
  parseTunnelId,
} from "@/lib/pvpOnchain";
import { RelayClient } from "@/lib/pvpRelay";

export type Variant = "ttt" | "caro";

const MP_URL = import.meta.env.VITE_MP_URL ?? "ws://127.0.0.1:8080";
const STAKE = 1n; // MIST per game; caro's protocol forces 0 regardless
const BANKROLL = 1000n; // MIST deposited per seat
const MAX_GAMES = 1000; // high cap → play until a side stops or busts
const MOVE_MS = 600; // auto move cadence
const NEXT_MS = 800; // pause before auto-advancing to the next game

export type PvpPhase =
  | "idle"
  | "connecting"
  | "queuing"
  | "opening"
  | "funding"
  | "playing"
  | "settling"
  | "done"
  | "error";

export interface GameResult {
  game: number;
  winner: 1 | 2 | 3;
} // 1 X, 2 O, 3 draw

// Minimal shared shape of both multi-game states (caro adds size/lastMove).
type InnerState = {
  board: number[];
  turn: "A" | "B";
  winner: number;
  balanceA: bigint;
  balanceB: bigint;
  size?: number;
  lastMove?: number;
};
type AnyState = { inner: InnerState; gamesPlayed: number; maxGames: number };
type CellMove = { cell: number };

export interface PvpTttView {
  phase: PvpPhase;
  error: string | null;
  role: "A" | "B" | null; // A = X (opener), B = O
  variant: Variant;
  board: number[];
  size: number;
  lastMove: number;
  turn: "A" | "B" | null;
  winner: number; // current game: 0 none | 1 X | 2 O | 3 draw
  myMark: 0 | 1 | 2; // 1 if I'm X, 2 if I'm O
  isMyTurn: boolean;
  innerOver: boolean; // current game finished (between games)
  terminal: boolean; // session terminal → auto-settle
  score: { x: number; o: number; draws: number };
  games: GameResult[];
  currentGame: number; // gamesPlayed + 1
  auto: boolean;
  address: string;
  balance: bigint; // me's SUI balance (MIST)
  digests: { create?: string; deposit?: string; close?: string };
  fund: () => void;
  queue: () => void;
  play: (cell: number) => void;
  next: () => void;
  stop: () => void;
  setAuto: (on: boolean) => void;
  leave: () => void;
}

// Perfect 3×3 move via @ttt/shared minimax (maps protocol marks 1/2 to CELL_SERVER/CELL_PLAYER).
function tttBestCell(inner: InnerState, by: "A" | "B"): number {
  const mark = by === "A" ? 1 : 2;
  const board = inner.board.map((v) =>
    v === 0 ? CELL_EMPTY : v === mark ? CELL_SERVER : CELL_PLAYER,
  );
  return optimalMoves(board, CELL_SERVER)[0];
}

export function usePvpTicTacToe(
  variant: Variant,
  boardSize: number,
): PvpTttView {
  const client = useMemo<SuiClient>(() => getSuiClient(), []);
  const me = useMemo<PvpIdentity>(() => loadOrCreateMe(), []);
  const proto = useMemo(
    () =>
      (variant === "caro"
        ? new MultiGameCaroProtocol(MAX_GAMES, boardSize)
        : new MultiGameTicTacToeProtocol(
            MAX_GAMES,
            STAKE,
          )) as unknown as protocols.Protocol<AnyState, CellMove>,
    [variant, boardSize],
  );

  const [phase, setPhase] = useState<PvpPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<"A" | "B" | null>(null);
  const [state, setState] = useState<AnyState | null>(null);
  const [games, setGames] = useState<GameResult[]>([]);
  const [auto, setAutoState] = useState(false);
  const [balance, setBalance] = useState<bigint>(0n);
  const [digests, setDigests] = useState<{
    create?: string;
    deposit?: string;
    close?: string;
  }>({});

  const relayRef = useRef<RelayClient | null>(null);
  const tunnelRef = useRef<core.DistributedTunnel<AnyState, CellMove> | null>(
    null,
  );
  const roleRef = useRef<"A" | "B" | null>(null);
  const autoRef = useRef(false);
  const createdAtRef = useRef<bigint>(0n);
  const matchIdRef = useRef<string>("");
  const settledRef = useRef(false);
  const stoppingRef = useRef(false);
  const onMatchRef =
    useRef<
      (
        relay: RelayClient,
        m: { matchId: string; role: "A" | "B"; opponentWallet: string },
      ) => Promise<void>
    >();
  const openedResolveRef = useRef<((id: string) => void) | null>(null);
  const settleResolveRef = useRef<((sig: Uint8Array) => void) | null>(null);
  const bufferedSettleRef = useRef<Uint8Array | null>(null);
  const helloResolveRef = useRef<((pub: string) => void) | null>(null);
  const bufferedHelloRef = useRef<string | null>(null);

  const refreshBalance = useCallback(async () => {
    setBalance(await balanceOf(client, me.address));
  }, [client, me]);
  useEffect(() => {
    void refreshBalance();
  }, [refreshBalance]);

  const submit = useCallback(
    async (tx: any) => {
      const res = await client.signAndExecuteTransaction({
        signer: me.keypair,
        transaction: tx,
        options: { showObjectChanges: true, showEffects: true },
      });
      await client.waitForTransaction({ digest: res.digest });
      if (res.effects?.status?.status !== "success")
        throw new Error(res.effects?.status?.error ?? "tx failed");
      return res;
    },
    [client, me],
  );

  const fund = useCallback(() => {
    void (async () => {
      try {
        await faucet(me.address);
        for (let i = 0; i < 8; i++) {
          await refreshBalance();
          await new Promise((r) => setTimeout(r, 1500));
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [me, refreshBalance]);

  const finishSettle = useCallback(
    async (
      t: core.DistributedTunnel<AnyState, CellMove>,
      relay: RelayClient,
      matchId: string,
    ) => {
      if (settledRef.current) return;
      settledRef.current = true;
      setPhase("settling");
      const half = t.buildSettlementHalf(createdAtRef.current);
      relay.sendApp(matchId, { t: "settle", sig: bytesToHex(half.sigSelf) });
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
        // X (the opener) submits the cooperative close
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
      stoppingRef.current = false;
      setGames([]);
      autoRef.current = false;
      setAutoState(false); // fresh game (incl. rematch) starts in manual mode
      bufferedSettleRef.current = null;
      bufferedHelloRef.current = null;
      try {
        const relay = new RelayClient(MP_URL, me.address, me.coreKey);
        relayRef.current = relay;
        await relay.ready;
        setPhase("queuing");
        relay.on("error", (m) => {
          setError(`${m.code}: ${m.message}`);
          setPhase("error");
        });
        relay.on("match.found", (m) => {
          void onMatchRef.current?.(relay, m as any);
        });
        relay.queueJoin("tictactoe");
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    })();
  }, [me]);

  const onMatch = useCallback(
    async (
      relay: RelayClient,
      m: { matchId: string; role: "A" | "B"; opponentWallet: string },
    ) => {
      try {
        matchIdRef.current = m.matchId;
        roleRef.current = m.role;
        setRole(m.role);
        // App-channel dispatcher: opened tunnelId, settle half, closed digest, stop request.
        relay.onApp(m.matchId, (mm) => {
          if (mm.t === "opened")
            openedResolveRef.current?.(String(mm.tunnelId));
          else if (mm.t === "settle") {
            const sig = hexToBytes(String(mm.sig));
            if (settleResolveRef.current) settleResolveRef.current(sig);
            else bufferedSettleRef.current = sig;
          } else if (mm.t === "closed")
            setDigests((d) => ({ ...d, close: String(mm.digest) }));
          else if (mm.t === "stop") {
            stoppingRef.current = true;
            if (tunnelRef.current)
              void finishSettle(tunnelRef.current, relay, m.matchId);
          }
        });
        // party.hello carries the single pubkey (no attestation): capture synchronously, buffer races.
        relay.on("party.hello", (h) => {
          if (h.matchId !== m.matchId) return;
          const pub = String(h.ephemeralPubkey);
          if (helloResolveRef.current) helloResolveRef.current(pub);
          else bufferedHelloRef.current = pub;
        });
        relay.partyHello(m.matchId, me.pubkeyHex, ""); // single-key identity; walletSig unused in v1

        const oppPubHex =
          bufferedHelloRef.current ??
          (await new Promise<string>((res) => {
            helloResolveRef.current = res;
          }));
        const oppPubkey = hexToBytes(oppPubHex);
        try {
          if (
            new Ed25519PublicKey(oppPubkey).toSuiAddress() !== m.opponentWallet
          ) {
            console.warn(
              "[pvp] opponent pubkey does not derive its reported address; proceeding (v1 self-asserted)",
            );
          }
        } catch {
          console.warn("[pvp] could not verify opponent pubkey; proceeding");
        }

        // Roles: A = X (opener), B = O. X opens the tunnel registering partyA = self, partyB = opponent.
        let tunnelId: string;
        if (m.role === "A") {
          setPhase("opening");
          const res = await submit(
            buildCreateAndShareTx(
              { walletAddress: me.address, publicKey: me.coreKey.publicKey }, // partyA = X (self)
              { walletAddress: m.opponentWallet, publicKey: oppPubkey }, // partyB = O (opponent)
              0n,
            ),
          );
          const id = parseTunnelId(res.objectChanges);
          if (!id) throw new Error("no tunnelId");
          tunnelId = id;
          setDigests((d) => ({ ...d, create: res.digest }));
          relay.tunnelOpened(m.matchId, tunnelId);
          relay.sendApp(m.matchId, { t: "opened", tunnelId });
        } else {
          setPhase("opening");
          tunnelId = await new Promise<string>((resolve) => {
            openedResolveRef.current = resolve;
          });
        }

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

        setPhase("funding");
        const dep = await submit(buildDepositTx(tunnelId, BANKROLL));
        setDigests((d) => ({ ...d, deposit: dep.digest }));
        let activated = false;
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
          ) {
            activated = true;
            break;
          }
          await new Promise((r) => setTimeout(r, 1500));
        }
        if (!activated)
          throw new Error(
            "tunnel did not activate (opponent may not have funded)",
          );

        const backend = core.defaultBackend();
        const t = new core.DistributedTunnel<AnyState, CellMove>(
          proto,
          {
            tunnelId,
            self: core.makeEndpoint(
              backend,
              me.address,
              {
                publicKey: me.coreKey.publicKey,
                scheme: 0,
                secretKey: me.coreKey.secretKey,
              },
              true,
            ),
            opponent: core.makeEndpoint(
              backend,
              m.opponentWallet,
              { publicKey: oppPubkey, scheme: 0 },
              false,
            ),
            selfParty: m.role,
          },
          relay.transport(m.matchId),
          { a: BANKROLL, b: BANKROLL },
        );
        tunnelRef.current = t;

        let lastLoggedGame = 0;
        const onAdvance = () => {
          const st = t.state;
          setState({ ...st, inner: { ...st.inner } });
          // Log each completed game once (winner is set on the inner game just before the advance).
          const gameNo = st.gamesPlayed + 1;
          if (st.inner.winner !== 0 && gameNo > lastLoggedGame) {
            setGames((prev) =>
              [
                ...prev,
                { game: gameNo, winner: st.inner.winner as 1 | 2 | 3 },
              ].slice(-50),
            );
            lastLoggedGame = gameNo;
          }
          if (stoppingRef.current) return;
          if (proto.isTerminal(st)) {
            void finishSettle(t, relay, m.matchId);
            return;
          }
          if (st.inner.winner !== 0) {
            // Between games: only X (A) drives the advance (avoids a double-advance race).
            if (m.role === "A" && autoRef.current)
              setTimeout(() => {
                try {
                  t.propose({ cell: 0 }, BigInt(Date.now()));
                } catch {
                  /* raced */
                }
              }, NEXT_MS);
          } else if (st.inner.turn === m.role && autoRef.current) {
            const cell =
              variant === "caro"
                ? pickCaroMove(st.inner as any, m.role, Math.random, "strong")
                : tttBestCell(st.inner, m.role);
            setTimeout(() => {
              try {
                t.propose({ cell }, BigInt(Date.now()));
              } catch {
                /* not my turn / in flight */
              }
            }, MOVE_MS);
          }
        };
        t.onConfirmed = () => onAdvance();
        setPhase("playing");
        setState({ ...t.state, inner: { ...t.state.inner } });
        onAdvance();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setPhase("error");
      }
    },
    [client, proto, submit, me, variant, finishSettle],
  );
  onMatchRef.current = onMatch;

  const play = useCallback((cell: number) => {
    const t = tunnelRef.current;
    if (!t) return;
    const st = t.state;
    if (st.inner.winner !== 0 || st.inner.turn !== roleRef.current) return; // not my turn / between games
    try {
      t.propose({ cell }, BigInt(Date.now()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const next = useCallback(() => {
    const t = tunnelRef.current;
    if (!t) return;
    if (
      roleRef.current !== "A" ||
      t.state.inner.winner === 0 ||
      proto.isTerminal(t.state)
    )
      return; // X advances between games
    try {
      t.propose({ cell: 0 }, BigInt(Date.now()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [proto]);

  const stop = useCallback(() => {
    const t = tunnelRef.current;
    const relay = relayRef.current;
    if (!t || !relay) return;
    if (t.state.inner.winner === 0) return; // settle cleanly between games
    stoppingRef.current = true;
    relay.sendApp(matchIdRef.current, { t: "stop" });
    void finishSettle(t, relay, matchIdRef.current);
  }, [finishSettle]);

  const setAuto = useCallback(
    (on: boolean) => {
      autoRef.current = on;
      setAutoState(on);
      const t = tunnelRef.current;
      if (!on || !t || stoppingRef.current || proto.isTerminal(t.state)) return;
      const st = t.state;
      if (st.inner.winner !== 0) {
        if (roleRef.current === "A")
          setTimeout(() => {
            try {
              t.propose({ cell: 0 }, BigInt(Date.now()));
            } catch {
              /* ignore */
            }
          }, NEXT_MS);
      } else if (st.inner.turn === roleRef.current) {
        const cell =
          variant === "caro"
            ? pickCaroMove(
                st.inner as any,
                roleRef.current,
                Math.random,
                "strong",
              )
            : tttBestCell(st.inner, roleRef.current);
        setTimeout(() => {
          try {
            t.propose({ cell }, BigInt(Date.now()));
          } catch {
            /* ignore */
          }
        }, MOVE_MS);
      }
    },
    [proto, variant],
  );

  const leave = useCallback(() => {
    relayRef.current?.close();
    relayRef.current = null;
    tunnelRef.current = null;
    setPhase("idle");
    setState(null);
    setRole(null);
    setDigests({});
    setGames([]);
    settledRef.current = false;
    stoppingRef.current = false;
    autoRef.current = false;
    setAutoState(false);
    openedResolveRef.current = null;
    settleResolveRef.current = null;
    bufferedSettleRef.current = null;
    helloResolveRef.current = null;
    bufferedHelloRef.current = null;
  }, []);

  useEffect(() => () => relayRef.current?.close(), []);

  const s = state;
  const inner = s?.inner ?? null;
  const winner = inner ? inner.winner : 0;
  const myMark: 0 | 1 | 2 =
    roleRef.current === "A" ? 1 : roleRef.current === "B" ? 2 : 0;
  const isMyTurn =
    !!inner &&
    inner.winner === 0 &&
    inner.turn === roleRef.current &&
    phase === "playing";
  const score = games.reduce(
    (acc, g) => {
      if (g.winner === 1) acc.x++;
      else if (g.winner === 2) acc.o++;
      else acc.draws++;
      return acc;
    },
    { x: 0, o: 0, draws: 0 },
  );

  return {
    phase,
    error,
    role: roleRef.current,
    variant,
    board: inner ? inner.board : [],
    size: inner ? (inner.size ?? 3) : variant === "caro" ? boardSize : 3,
    lastMove: inner ? (inner.lastMove ?? -1) : -1,
    turn: inner ? inner.turn : null,
    winner,
    myMark,
    isMyTurn,
    innerOver: !!inner && inner.winner !== 0,
    terminal: s ? proto.isTerminal(s) : false,
    score,
    games,
    currentGame: s ? s.gamesPlayed + 1 : 0,
    auto,
    address: me.address,
    balance,
    digests,
    fund,
    queue,
    play,
    next,
    stop,
    setAuto,
    leave,
  };
}
```

- [ ] **Step 2: Typecheck**

Run:

```bash
cd /Users/alvin/Developer/dopamint-arena/frontend/src/games/ticTacToe/packages/client && bunx tsc --noEmit 2>&1 | tail -15
```

Expected: clean. If `client.signAndExecuteTransaction`'s option/return types differ from the inline `any` usage, that boundary is intentionally loose (`tx: any`); only fix genuine type errors elsewhere.

- [ ] **Step 3: Re-run the engine test (no regression)**

Run:

```bash
cd /Users/alvin/Developer/dopamint-arena/frontend/src/games/ticTacToe/packages/client && bun test src/lib/pvpEngine.e2e.test.ts 2>&1 | tail -6
```

Expected: 2 pass (the hook doesn't change the engine, but confirms imports still resolve).

- [ ] **Step 4: Commit**

```bash
cd /Users/alvin/Developer/dopamint-arena
git add frontend/src/games/ticTacToe/packages/client/src/hooks/usePvpTicTacToe.ts
git commit -m "feat(ttt): add pvp engine hook"
```

---

## Task 7: The PvP scene (lobby + table)

A single scene: a lobby (identity + faucet + variant select + Find match) until `phase` reaches `playing`/`settling`/`done`, then the interactive table (board + role/turn badge + score + games log + Auto + Stop & settle + Next game + digest links). The scene owns the `variant`/`boardSize` selectors (locked once not idle) and passes them to the hook.

**Files:**

- Create: `frontend/src/games/ticTacToe/packages/client/src/scenes/PvpScene.tsx`

- [ ] **Step 1: Implement the scene (complete file)**

```tsx
// frontend/src/games/ticTacToe/packages/client/src/scenes/PvpScene.tsx
import { useState } from "react";
import { usePvpTicTacToe, type Variant } from "@/hooks/usePvpTicTacToe";
import { Board } from "@/components/Board";
import { CaroBoard } from "@/components/CaroBoard";

const SUISCAN_TX = "https://suiscan.xyz/testnet/tx/";
const fmtSui = (mist: bigint) => (Number(mist) / 1e9).toFixed(4);
const CARO_SIZES = [9, 15, 19];

function Digest({ label, digest }: { label: string; digest?: string }) {
  if (!digest) return null;
  return (
    <a
      href={`${SUISCAN_TX}${digest}`}
      target="_blank"
      rel="noreferrer"
      className="text-[11px] font-mono text-tertiary underline underline-offset-2"
    >
      {label} {digest.slice(0, 6)}…
    </a>
  );
}

function statusText(g: ReturnType<typeof usePvpTicTacToe>): string {
  if (g.phase === "opening") return "Opening tunnel on-chain…";
  if (g.phase === "funding") return "Funding your seat…";
  if (g.phase === "settling") return "Settling on-chain…";
  if (g.phase === "done") return "Settled — game over";
  if (g.innerOver) {
    if (g.terminal) return "Session over — settling…";
    return g.role === "A"
      ? "You won/lost/drew — start the next game"
      : "Waiting for X to start the next game…";
  }
  if (g.isMyTurn) return `Your turn (${g.myMark === 1 ? "✕" : "◯"})`;
  return "Opponent's turn…";
}

export function PvpScene({ onBack }: { onBack: () => void }) {
  const [variant, setVariant] = useState<Variant>("ttt");
  const [boardSize, setBoardSize] = useState(15);
  const g = usePvpTicTacToe(variant, boardSize);

  const playing =
    g.phase === "playing" || g.phase === "settling" || g.phase === "done";
  const funded = g.balance > 20_000_000n;
  const locked = g.phase !== "idle" && g.phase !== "error";

  return (
    <div className="w-full h-full flex flex-col gap-3 p-4 text-on-surface">
      <div className="flex items-center justify-between">
        <button
          onClick={() => {
            g.leave();
            onBack();
          }}
          className="text-sm text-secondary underline"
        >
          ← back
        </button>
        <span className="text-sm font-bold uppercase tracking-widest">
          Tic-Tac-Toe · PvP
        </span>
        <span className="text-[11px] font-mono text-on-surface/50">
          {g.address.slice(0, 8)}…
        </span>
      </div>

      {!playing ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          <div className="text-[11px] font-mono text-on-surface/60">
            {fmtSui(g.balance)} SUI
          </div>
          <div className="flex flex-col items-center gap-2">
            <span className="text-[11px] uppercase tracking-widest text-on-surface/60">
              Variant
            </span>
            <div className="flex gap-2">
              {(["ttt", "caro"] as const).map((v) => (
                <button
                  key={v}
                  disabled={locked}
                  onClick={() => setVariant(v)}
                  className={`px-4 py-2 rounded-lg text-sm font-bold disabled:opacity-40 ${variant === v ? "bg-tertiary text-on-tertiary" : "bg-surface border border-primary/30"}`}
                >
                  {v === "ttt" ? "3×3" : "Caro"}
                </button>
              ))}
            </div>
            {variant === "caro" && (
              <div className="flex gap-2 mt-1">
                {CARO_SIZES.map((sz) => (
                  <button
                    key={sz}
                    disabled={locked}
                    onClick={() => setBoardSize(sz)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold disabled:opacity-40 ${boardSize === sz ? "bg-secondary text-on-secondary" : "bg-surface border border-primary/30"}`}
                  >
                    {sz}×{sz}
                  </button>
                ))}
              </div>
            )}
          </div>
          {!funded && (
            <button
              onClick={g.fund}
              className="px-4 py-2 rounded-lg bg-surface border border-primary/30 text-sm font-bold"
            >
              Fund (faucet)
            </button>
          )}
          <button
            onClick={g.queue}
            disabled={
              !funded || g.phase === "queuing" || g.phase === "connecting"
            }
            className="px-6 py-3 rounded-xl bg-tertiary text-on-tertiary font-black uppercase tracking-widest disabled:opacity-40"
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
              className="text-xs text-on-surface/60 underline"
            >
              cancel
            </button>
          )}
          {g.error && (
            <div className="text-sm text-red-500 text-center max-w-xs">
              {g.error}
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center gap-3">
          <div className="flex items-center gap-4 text-sm">
            <span>
              You are <b>{g.myMark === 1 ? "✕ (X)" : "◯ (O)"}</b>
            </span>
            <span className="text-on-surface/50">Game {g.currentGame}</span>
            <span className="font-mono">
              X {g.score.x} · O {g.score.o} · D {g.score.draws}
            </span>
          </div>
          <div className="px-4 py-1.5 rounded-full bg-surface border border-primary/20 text-sm font-bold">
            {statusText(g)}
          </div>

          {g.variant === "caro" ? (
            <CaroBoard
              board={g.board}
              size={g.size}
              lastMove={g.lastMove}
              disabled={!g.isMyTurn || g.auto}
              onPlay={g.play}
            />
          ) : (
            <Board
              board={g.board}
              disabled={!g.isMyTurn || g.auto}
              onPlay={g.play}
            />
          )}

          <div className="flex flex-wrap items-center justify-center gap-2">
            {g.innerOver && !g.terminal && g.role === "A" && (
              <button
                onClick={g.next}
                disabled={g.auto}
                className="px-4 py-2 rounded-lg bg-tertiary text-on-tertiary font-bold disabled:opacity-40"
              >
                Next game
              </button>
            )}
            {g.innerOver && (
              <button
                onClick={g.stop}
                className="px-4 py-2 rounded-lg bg-red-700 text-white font-bold"
              >
                Stop &amp; settle
              </button>
            )}
            {g.phase === "done" && (
              <button
                onClick={() => {
                  g.leave();
                  g.queue();
                }}
                className="px-4 py-2 rounded-lg bg-tertiary text-on-tertiary font-bold"
              >
                Rematch
              </button>
            )}
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={g.auto}
                onChange={(e) => g.setAuto(e.target.checked)}
              />{" "}
              Auto
            </label>
          </div>

          <div className="flex items-center gap-3">
            <Digest label="open" digest={g.digests.create} />
            <Digest label="deposit" digest={g.digests.deposit} />
            <Digest label="close" digest={g.digests.close} />
          </div>
          {g.error && (
            <div className="text-sm text-red-500 text-center">{g.error}</div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run:

```bash
cd /Users/alvin/Developer/dopamint-arena/frontend/src/games/ticTacToe/packages/client && bunx tsc --noEmit 2>&1 | tail -10
```

Expected: clean. (If a Tailwind color token like `text-on-tertiary` is unknown to the linter, that is a runtime/CSS concern, not a tsc error — ignore for typecheck.)

- [ ] **Step 3: Commit**

```bash
cd /Users/alvin/Developer/dopamint-arena
git add frontend/src/games/ticTacToe/packages/client/src/scenes/PvpScene.tsx
git commit -m "feat(ttt): add pvp lobby and table scene"
```

---

## Task 8: Wire the scene into the app

Add the `pvp` scene to the App state machine, a "Play online (PvP)" button on the SetupScene, and card sizing for the new scene.

**Files:**

- Modify: `frontend/src/games/ticTacToe/packages/client/src/App.tsx`
- Modify: `frontend/src/games/ticTacToe/packages/client/src/scenes/SetupScene.tsx`

- [ ] **Step 1: Add an `onPlayOnline` button to SetupScene**

`SetupScene` is a presentational component that takes callbacks. Add an optional `onPlayOnline?: () => void` prop and a button that invokes it. First add the prop to the component's prop list (find the `export function SetupScene({ ... }: { ... })` signature and add `onPlayOnline,` to the destructure and `onPlayOnline?: () => void;` to the type). Then add this button next to the existing Start/Back controls (search for the `onStart` button and place it just below):

```tsx
{
  onPlayOnline && (
    <button
      onClick={onPlayOnline}
      className="w-full mt-2 px-4 py-2 rounded-lg border border-tertiary text-tertiary font-bold text-sm uppercase tracking-widest hover:bg-tertiary hover:text-on-tertiary transition-colors"
    >
      Play online (PvP)
    </button>
  );
}
```

- [ ] **Step 2: Add the `pvp` scene to App.tsx**

In `frontend/src/games/ticTacToe/packages/client/src/App.tsx`:

1. Add the import (after the other scene imports, around line 7):

```tsx
import { PvpScene } from "@/scenes/PvpScene";
```

2. Widen the `Scene` type (line 10):

```tsx
type Scene = "login" | "setup" | "game" | "pvp";
```

3. Pass `onPlayOnline` to `SetupScene` (add inside the `<SetupScene ... />` props, e.g. after `onBack`):

```tsx
              onPlayOnline={() => setScene("pvp")}
```

4. Render the scene (add after the `scene === "game"` line, ~line 110):

```tsx
{
  scene === "pvp" && <PvpScene onBack={() => setScene("setup")} />;
}
```

5. Add card sizing for `pvp` (in the `if (scene === ...)` chain, after the `scene === "game"` block, ~line 77):

```tsx
  } else if (scene === "pvp") {
    targetWidth = isPortrait ? 460 : 720;
    targetHeight = 820;
  }
```

- [ ] **Step 3: Typecheck + build**

Run:

```bash
cd /Users/alvin/Developer/dopamint-arena/frontend/src/games/ticTacToe/packages/client && bunx tsc --noEmit 2>&1 | tail -10 && bunx vite build 2>&1 | tail -5
```

Expected: clean typecheck; `vite build` succeeds.

- [ ] **Step 4: Commit**

```bash
cd /Users/alvin/Developer/dopamint-arena
git add frontend/src/games/ticTacToe/packages/client/src/App.tsx frontend/src/games/ticTacToe/packages/client/src/scenes/SetupScene.tsx
git commit -m "feat(ttt): wire pvp scene into app"
```

---

## Task 9: Full verification + manual E2E

**Files:** none (verification only).

- [ ] **Step 1: Full test + build sweep**

Run:

```bash
cd /Users/alvin/Developer/dopamint-arena/frontend/src/games/ticTacToe/packages/shared && bun test 2>&1 | tail -5
cd /Users/alvin/Developer/dopamint-arena/frontend/src/games/ticTacToe/packages/client && bun test 2>&1 | tail -5 && bunx tsc --noEmit 2>&1 | tail -5 && bunx vite build 2>&1 | tail -5
```

Expected: all tests pass; typecheck clean; build succeeds.

- [ ] **Step 2: Manual two-window E2E (golden path)**

Start the relay (`tunnel-manager`) on `127.0.0.1:8080` and the ttt dev server, then in two browser windows:

1. Each: open the ttt app → log in → SetupScene → "Play online (PvP)".
2. Each: pick the **same** variant (and caro size), "Fund (faucet)" if needed, then "Find match".
3. Verify they match, X moves first, turns alternate, a game resolves, X starts the next game (or tick Auto on one/both seats to watch it self-play).
4. Either window: "Stop & settle" between games → the close digest link appears in both windows and the score reflects the games played.
5. Repeat for the other variant.

- [ ] **Step 3: Finish the branch**

Invoke `superpowers:finishing-a-development-branch`.

---

## Self-Review

**1. Spec coverage:**

- Both variants → Task 6 (`variant` param) + Task 7 (selector) + Task 5 (tests both). ✓
- Minimal 1-MIST stake → `STAKE = 1n` (ttt); caro forced 0n, documented in Task 5/6. ✓
- Auto + multi-game-until-stop → Task 6 (`autoRef`, `MAX_GAMES=1000`, `next`/`stop`). ✓
- Approach 1 SDK switch → Task 0 (hard gate + contingency). ✓
- Single local identity → Task 2. ✓
- A=X opener/advance/close → Task 6 (`m.role === "A"` open + `roleRef.current === "A"` close + `next`). ✓
- create_and_share + own deposits + cooperative close → Tasks 3, 6. ✓
- CaroBoard interactive → Task 4. ✓
- New pvp scene + entry → Tasks 7, 8. ✓
- Integration test → Task 5. ✓
- Error handling / buffering → Task 6 (error phase, activation throw, settle/hello buffers). ✓

**2. Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output. ✓

**3. Type consistency:** `PvpIdentity` (`coreKey`/`keypair`/`address`/`pubkeyHex`) consistent across Tasks 2/6. `PvpParty` uses `publicKey` (Task 3) and the hook passes `me.coreKey.publicKey` / `oppPubkey` (Task 6). `CellMove = { cell }`, `AnyState.inner.{board,turn,winner}` consistent across Tasks 5/6/7. `PvpTttView` fields consumed by `PvpScene` (Task 7) all exist in the hook's return (Task 6): `board,size,lastMove,turn,winner,myMark,isMyTurn,innerOver,terminal,score,games,currentGame,auto,address,balance,digests,phase,error,role,variant` + actions `fund,queue,play,next,stop,setAuto,leave`. ✓
