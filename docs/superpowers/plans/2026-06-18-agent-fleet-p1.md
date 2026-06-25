# Scaled-Relay Agent Fleet — P1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove one real-app browser agent completes a full tic-tac-toe tunnel lifecycle (connect a programmatic wallet → quick-match → auto-play over the relay → settle on-chain → Walrus) with **no human input and no wallet popup**, then measure the single-relay and per-host numbers that size P2.

**Architecture:** A **game-agnostic agent engine** generalizes the working `sui-tunnel-ts/scripts/pvpTttBot.mjs` relay + on-chain lifecycle — it rotates **all** tunnel games via `createBehaviorProtocol(game)` + `proto.randomMove`. A **programmatic Wallet-Standard wallet** (in-page Ed25519 keypair, popup-free signing) registers + auto-connects only in **agent mode** (bare `?agent`, no game selection). Drive N agents as Playwright browser **contexts** against the dev relay. Measure throughput before any scale-out.

**Tech Stack:** React + Vite + TypeScript, `@mysten/dapp-kit` ^1.1.0, `@mysten/sui` ^2.18.0, `@mysten/wallet-standard` (new direct dep), `sui-tunnel-ts` SDK, Playwright, `node:test` via `tsx`. Prettier formatting (match the package).

**Refs:** spec `docs/superpowers/specs/2026-06-18-scaled-relay-agent-fleet-design.md`; ADR-0004; `frontend/src/games/ticTacToe/usePvpTicTacToe.ts`; `frontend/src/onchain/tunnelTx.ts`.

---

## Scope (P1 only)

In: programmatic wallet, agent-mode flag + auto-connect, tic-tac-toe agent controller, a treasury funding script, a 2-context Playwright e2e proof, and the load-test harness (§Numbers #1–#3 of the spec).
Out (→ P2): HA relay / local-matching scale-out, full fleet runner + autoscaling, blackjack agent, no-render mode, treasury fan-out at 10k scale. Out entirely: new Move code / PTB builders.

## File structure

- **Create** `frontend/src/wallet/programmaticWallet.ts` — a Wallet-Standard `Wallet` backed by an `Ed25519Keypair`; popup-free `connect` + `sui:signTransaction` + `sui:signAndExecuteTransaction`. One responsibility: be a headless wallet.
- **Create** `frontend/src/wallet/programmaticWallet.test.ts` — unit test (no network) for identity + feature surface.
- **Create** `frontend/src/agent/agentConfig.ts` — parse `?agent` (=`all` or a game id), `?key`; expose the rotation game list. One responsibility: agent-mode config.
- **Create** `frontend/src/agent/AgentBoot.tsx` — registers + auto-connects the programmatic wallet when agent mode is on; renders children otherwise unchanged.
- **Create** `frontend/src/agent/agentEngine.ts` — **game-agnostic** lifecycle: rotate games, `quickMatch(gameId)` → open/fund → `DistributedTunnel(createBehaviorProtocol(game))` → loop `proto.randomMove` → settle → next. One engine for all 5 tunnel games. (Generalizes `sui-tunnel-ts/scripts/pvpTttBot.mjs`.)
- **Create** `frontend/src/agent/AgentRunner.tsx` — mounts the engine in agent mode and renders a status line; the agent-mode "page".
- **Modify** `frontend/src/App.tsx` — when agent mode is on, render `<AgentRunner/>` instead of the desktop.
- **Modify** `frontend/src/providers/SuiProviders.tsx:22` — pass `autoConnect` explicitly and accept an optional pre-registered wallet (no behavior change for humans).
- **Modify** `frontend/package.json` — add `@mysten/wallet-standard`.
- **Create** `frontend/agent/fundTreasury.mjs` — fund N agent wallets from a treasury via one PTB fan-out (reuses the `tunnelTx` SUI patterns).
- **Create** `frontend/agent/runAgents.mjs` — Playwright: launch K contexts at `?agent`, with anti-throttle flags; assert match→play→settle.
- **Create** `frontend/agent/loadtestRelay.mjs` — open a deployed relay WS and measure sustained frame-forward rate + p99 (spec §Numbers #1).
- **Create** `frontend/agent/README.md` — how to run funding, agents, and the load test.

---

### Task 1: Add the `@mysten/wallet-standard` dependency

**Files:**

- Modify: `frontend/package.json`

- [ ] **Step 1: Add the dependency**

In `frontend/package.json` under `"dependencies"`, add (keep alphabetical with the other `@mysten/*` entries):

```json
"@mysten/wallet-standard": "^0.16.0",
```

- [ ] **Step 2: Install and verify it resolves to the same `@mysten/sui`**

Run: `cd frontend && pnpm install`
Then: `pnpm why @mysten/sui | head -20`
Expected: a single `@mysten/sui@2.18.x` (no duplicate major). If a second copy appears, add a `pnpm.overrides` pin for `@mysten/sui` to `^2.18.0` and re-install.

- [ ] **Step 3: Commit**

```bash
git add frontend/package.json frontend/pnpm-lock.yaml
git commit -m "build(frontend): add wallet-standard dep for agent wallet"
```

---

### Task 2: Programmatic Wallet-Standard wallet

A headless wallet whose accounts come from an injected `Ed25519Keypair`. Signing is in-page (no UI). It must satisfy `SignExec = (tx: Transaction) => Promise<{ digest: string }>` _through_ dapp-kit's `useSignAndExecuteTransaction`.

**Files:**

- Create: `frontend/src/wallet/programmaticWallet.ts`
- Test: `frontend/src/wallet/programmaticWallet.test.ts`

- [ ] **Step 1: Write the failing test (identity + feature surface, no network)**

```ts
// frontend/src/wallet/programmaticWallet.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { ProgrammaticWallet } from "./programmaticWallet";

test("exposes one account matching the injected keypair", async () => {
  const kp = new Ed25519Keypair();
  const w = new ProgrammaticWallet(
    kp,
    /* client */ undefined as never,
    "sui:testnet",
  );
  assert.equal(w.accounts.length, 1);
  assert.equal(w.accounts[0].address, kp.getPublicKey().toSuiAddress());
});

test("connect returns the account without UI", async () => {
  const kp = new Ed25519Keypair();
  const w = new ProgrammaticWallet(kp, undefined as never, "sui:testnet");
  const { accounts } = await w.features["standard:connect"].connect();
  assert.equal(accounts[0].address, kp.getPublicKey().toSuiAddress());
});

test("advertises the sui signing features dapp-kit needs", () => {
  const kp = new Ed25519Keypair();
  const w = new ProgrammaticWallet(kp, undefined as never, "sui:testnet");
  assert.ok(w.features["sui:signTransaction"]);
  assert.ok(w.features["sui:signAndExecuteTransaction"]);
  assert.ok(w.chains.includes("sui:testnet"));
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `cd frontend && pnpm exec tsx --test src/wallet/programmaticWallet.test.ts`
Expected: FAIL — cannot find module `./programmaticWallet`.

- [ ] **Step 3: Implement the wallet**

```ts
// frontend/src/wallet/programmaticWallet.ts
// A headless Wallet-Standard wallet for agent mode: accounts come from an injected
// Ed25519 keypair, all signing is in-page (no popup). Registering it and connecting
// once makes dapp-kit's useSignAndExecuteTransaction route through here unchanged.
import type { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { toBase64, fromBase64 } from "@mysten/sui/utils";
import { ReadonlyWalletAccount, type Wallet } from "@mysten/wallet-standard";

const ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=" as const;

export class ProgrammaticWallet implements Wallet {
  readonly version = "1.0.0" as const;
  readonly name = "Dopamint Agent";
  readonly icon = ICON;
  readonly chains: `${string}:${string}`[];
  readonly #account: ReadonlyWalletAccount;

  constructor(
    private readonly keypair: Ed25519Keypair,
    private readonly client: SuiClient,
    chain: `${string}:${string}` = "sui:testnet",
  ) {
    this.chains = [chain];
    this.#account = new ReadonlyWalletAccount({
      address: keypair.getPublicKey().toSuiAddress(),
      publicKey: keypair.getPublicKey().toRawBytes(),
      chains: this.chains,
      features: ["sui:signTransaction", "sui:signAndExecuteTransaction"],
    });
  }

  get accounts() {
    return [this.#account];
  }

  get features() {
    return {
      "standard:connect": {
        version: "1.0.0" as const,
        connect: async () => ({ accounts: this.accounts }),
      },
      "standard:events": {
        version: "1.0.0" as const,
        on: () => () => {},
      },
      "sui:signTransaction": {
        version: "2.0.0" as const,
        signTransaction: async ({
          transaction,
        }: {
          transaction: { toJSON(): Promise<string> };
        }) => {
          const tx = Transaction.from(await transaction.toJSON());
          const bytes = await tx.build({ client: this.client });
          const { signature } = await this.keypair.signTransaction(bytes);
          return { bytes: toBase64(bytes), signature };
        },
      },
      "sui:signAndExecuteTransaction": {
        version: "2.0.0" as const,
        signAndExecuteTransaction: async ({
          transaction,
        }: {
          transaction: { toJSON(): Promise<string> };
        }) => {
          const tx = Transaction.from(await transaction.toJSON());
          const bytes = await tx.build({ client: this.client });
          const { signature } = await this.keypair.signTransaction(bytes);
          const res = await this.client.executeTransactionBlock({
            transactionBlock: bytes,
            signature,
            options: { showRawEffects: true },
          });
          await this.client.waitForTransaction({ digest: res.digest });
          return {
            digest: res.digest,
            bytes: toBase64(bytes),
            signature,
            effects: toBase64(Uint8Array.from(res.rawEffects ?? [])),
          };
        },
      },
    };
  }
}

export function programmaticWalletFromHex(
  secretKeyHex: string,
  client: SuiClient,
) {
  const kp = Ed25519Keypair.fromSecretKey(fromBase64(secretKeyHex));
  return new ProgrammaticWallet(kp, client);
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `cd frontend && pnpm exec tsx --test src/wallet/programmaticWallet.test.ts`
Expected: PASS (3 tests). If `ReadonlyWalletAccount` import fails, confirm the export with `pnpm exec node -e "console.log(Object.keys(require('@mysten/wallet-standard')))"` and adjust the import name.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/wallet/programmaticWallet.ts frontend/src/wallet/programmaticWallet.test.ts
git commit -m "feat(frontend): programmatic wallet-standard wallet for agents"
```

---

### Task 3: Agent-mode config from the URL

**Files:**

- Create: `frontend/src/agent/agentConfig.ts`
- Test: `frontend/src/agent/agentConfig.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/agent/agentConfig.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAgentConfig } from "./agentConfig";

test("off when ?agent absent", () => {
  assert.equal(parseAgentConfig("https://x/?foo=1").enabled, false);
});

test("on for bare ?agent, with the key", () => {
  const c = parseAgentConfig("https://x/?agent&key=AbCd");
  assert.equal(c.enabled, true);
  assert.equal(c.secretKeyB64, "AbCd");
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `cd frontend && pnpm exec tsx --test src/agent/agentConfig.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

```ts
// frontend/src/agent/agentConfig.ts
// Agent mode is URL-driven: bare ?agent turns the real app into a self-driving agent that
// rotates ALL tunnel games to maximize concurrent tunnels. No per-game selection.
export interface GameSpec {
  /** relay queue id — MUST equal the id the human UI queues, so humans share the queue. */
  id: string;
  /** createBehaviorProtocol() key (sui-tunnel-ts/agents/behaviors). */
  behavior: "tictactoe" | "blackjack" | "payment" | "chat" | "poker";
  /** per-seat locked stake (MIST). */
  stake: bigint;
}

// The full rotation set; the engine cycles this to keep every queue populated.
export const AGENT_GAMES: GameSpec[] = [
  { id: "tictactoe", behavior: "tictactoe", stake: 500n },
  { id: "blackjack", behavior: "blackjack", stake: 500n },
  { id: "payments", behavior: "payment", stake: 500n },
  { id: "chat", behavior: "chat", stake: 500n },
  { id: "quantumpoker", behavior: "poker", stake: 500n },
];

export interface AgentConfig {
  enabled: boolean;
  secretKeyB64: string | null;
}

export function parseAgentConfig(href: string): AgentConfig {
  const p = new URL(href).searchParams;
  return { enabled: p.get("agent") !== null, secretKeyB64: p.get("key") };
}
```

- [ ] **Step 4: Run to confirm it passes**

Run: `cd frontend && pnpm exec tsx --test src/agent/agentConfig.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/agent/agentConfig.ts frontend/src/agent/agentConfig.test.ts
git commit -m "feat(frontend): agent-mode url config"
```

---

### Task 4: Register + auto-connect the programmatic wallet in agent mode

dapp-kit `autoConnect` only re-picks a wallet whose name is already in `localStorage`, so the **first** connect must be explicit (`useConnectWallet`). `AgentBoot` does this once, then renders children.

**Files:**

- Create: `frontend/src/agent/AgentBoot.tsx`
- Modify: `frontend/src/providers/SuiProviders.tsx:18-26`

- [ ] **Step 1: Make `autoConnect` explicit (no behavior change)**

In `frontend/src/providers/SuiProviders.tsx`, change line 22 from `<WalletProvider autoConnect>` to:

```tsx
<WalletProvider autoConnect={true}>{children}</WalletProvider>
```

- [ ] **Step 2: Implement `AgentBoot`**

```tsx
// frontend/src/agent/AgentBoot.tsx
// In agent mode: build a programmatic wallet from the injected key, register it with the
// Wallet Standard, and explicitly connect it ONCE (autoConnect can't pick an unseen wallet
// on first load). Human mode renders children untouched.
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { getWallets } from "@mysten/wallet-standard";
import {
  useConnectWallet,
  useCurrentAccount,
  useSuiClient,
} from "@mysten/dapp-kit";
import { fromBase64 } from "@mysten/sui/utils";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { ProgrammaticWallet } from "../wallet/programmaticWallet";
import { parseAgentConfig } from "./agentConfig";

export function AgentBoot({ children }: { children: ReactNode }) {
  const cfg = useMemo(() => parseAgentConfig(window.location.href), []);
  const client = useSuiClient();
  const account = useCurrentAccount();
  const { mutate: connect } = useConnectWallet();
  const wallet = useRef<ProgrammaticWallet | null>(null);
  const tried = useRef(false);

  useEffect(() => {
    if (!cfg.enabled || !cfg.secretKeyB64 || tried.current) return;
    tried.current = true;
    const kp = Ed25519Keypair.fromSecretKey(fromBase64(cfg.secretKeyB64));
    const w = new ProgrammaticWallet(kp, client);
    wallet.current = w;
    getWallets().register(w);
    connect({ wallet: w as never });
  }, [cfg, client, connect]);

  if (cfg.enabled && !account)
    return <div data-agent="connecting">agent connecting…</div>;
  return <>{children}</>;
}
```

- [ ] **Step 3: Typecheck**

Run: `cd frontend && pnpm typecheck`
Expected: PASS. (If `connect({ wallet })` complains about the wallet type, the `as never` cast is the intended bridge — dapp-kit accepts a registered Wallet-Standard wallet at runtime.)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/agent/AgentBoot.tsx frontend/src/providers/SuiProviders.tsx
git commit -m "feat(frontend): register+autoconnect programmatic wallet in agent mode"
```

---

### Task 5: Game-agnostic agent engine

One engine drives **all** tunnel games. It generalizes `sui-tunnel-ts/scripts/pvpTttBot.mjs` (same relay handshake + settlement) by selecting the protocol with `createBehaviorProtocol(game)` and the move with `proto.randomMove`. A thin React adapter (`AgentRunner`) supplies the dapp-kit `signExec` and runs the engine.

**Files:**

- Create: `frontend/src/agent/agentEngine.ts`
- Create: `frontend/src/agent/AgentRunner.tsx`
- Test: `frontend/src/agent/rotation.test.ts`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Write the failing test for game rotation (pure, no React)**

```ts
// frontend/src/agent/rotation.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextGameIndex } from "./agentEngine";

test("round-robins through the game list", () => {
  assert.equal(nextGameIndex(0, 3), 1);
  assert.equal(nextGameIndex(2, 3), 0); // wraps
});

test("single-game list stays put", () => {
  assert.equal(nextGameIndex(0, 1), 0);
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `cd frontend && pnpm exec tsx --test src/agent/rotation.test.ts`
Expected: FAIL — cannot find module / `nextGameIndex` not exported.

- [ ] **Step 3: Implement the engine**

```ts
// frontend/src/agent/agentEngine.ts
// Game-agnostic agent: rotate tunnel games, play each over the real relay + on-chain
// lifecycle via the protocol's randomMove. Generalizes scripts/pvpTttBot.mjs — the ONLY
// per-game variation is createBehaviorProtocol(game). React-free so it's unit-testable;
// AgentRunner is the thin adapter that injects signExec/account/client from dapp-kit.
import { MpClient, resolveMpWsUrl } from "../pvp/mpClient";
import { DistributedTunnel } from "sui-tunnel-ts/core/distributedTunnel";
import { createBehaviorProtocol } from "sui-tunnel-ts/agents/behaviors";
import { generateKeyPair, type KeyPair } from "sui-tunnel-ts/core/crypto";
import { makeEndpoint, defaultBackend } from "sui-tunnel-ts/core/tunnel";
import { toHex, fromHex } from "sui-tunnel-ts/core/bytes";
import {
  openAndFundSharedTunnel,
  depositStake,
  closeCooperative,
  readCreatedAt,
  type SignExec,
} from "../onchain/tunnelTx";
import { AGENT_GAMES, type GameSpec } from "./agentConfig";

export function nextGameIndex(i: number, len: number): number {
  return len <= 1 ? 0 : (i + 1) % len;
}

export interface AgentDeps {
  wallet: string; // programmatic wallet address
  signExec: SignExec; // dapp-kit wrapper -> programmatic wallet
  reads: Parameters<typeof readCreatedAt>[0]; // SuiClient (cast)
  backendUrl: string;
  concurrency: number; // M: concurrent tunnel slots per agent
  onStatus?: (s: string) => void;
}

// One match, any game. Mirrors pvpTttBot.mjs step-for-step; `proto` is the only difference.
// Each match gets its OWN ephemeral move-signing key (independent of the shared WS connect key).
async function playOneMatch(mp: MpClient, deps: AgentDeps, spec: GameSpec) {
  const eph: KeyPair = generateKeyPair(); // per-slot tunnel key
  const match = await mp.quickMatch(spec.id); // resolves on match.found
  const ch = mp.channel(match.matchId);
  const inbox = new Map<string, any>(),
    waiters = new Map<string, (m: any) => void>();
  ch.onPeer((m: any) => {
    const w = waiters.get(m.t);
    if (w) {
      waiters.delete(m.t);
      w(m);
    } else inbox.set(m.t, m);
  });
  const waitPeer = (t: string) =>
    new Promise<any>((res) => {
      const b = inbox.get(t);
      if (b) {
        inbox.delete(t);
        res(b);
      } else waiters.set(t, res);
    });

  ch.sendPeer({ t: "hello", ephemeralPubkey: toHex(eph.publicKey) });
  const oppPub = fromHex((await waitPeer("hello")).ephemeralPubkey);

  let tunnelId: string;
  if (match.role === "A") {
    tunnelId = await openAndFundSharedTunnel({
      reads: deps.reads,
      signExec: deps.signExec,
      partyA: { address: deps.wallet, publicKey: eph.publicKey },
      partyB: { address: match.opponentWallet, publicKey: oppPub },
      amount: spec.stake,
    });
    mp.announceTunnel(match.matchId, tunnelId);
    ch.sendPeer({ t: "open", tunnelId });
  } else {
    tunnelId = (await waitPeer("open")).tunnelId;
    await depositStake({
      signExec: deps.signExec,
      tunnelId,
      amount: spec.stake,
    });
  }
  const createdAt = await readCreatedAt(deps.reads, tunnelId);

  const proto: any = createBehaviorProtocol(spec.behavior);
  const backend = defaultBackend();
  const self = makeEndpoint(backend, deps.wallet, eph, true);
  const opp = makeEndpoint(
    backend,
    match.opponentWallet,
    { publicKey: oppPub, scheme: eph.scheme },
    false,
  );
  const dt: any = new DistributedTunnel(
    proto,
    { tunnelId, self, opponent: opp, selfParty: match.role },
    ch.transport,
    { a: spec.stake, b: spec.stake },
  );

  const move = () => {
    if (proto.isTerminal(dt.state)) return;
    if (dt.state.turn === match.role) {
      const m = proto.randomMove?.(dt.state, match.role, Math.random);
      if (m) dt.propose(m, createdAt);
    }
  };
  const done = new Promise<void>((resolve) => {
    dt.onConfirmed = () => {
      if (proto.isTerminal(dt.state)) resolve();
      else move();
    };
  });
  if (match.role === "A") await waitPeer("ready");
  else ch.sendPeer({ t: "ready" });
  move();
  await done;

  const half = dt.buildSettlementHalf(createdAt, 0n);
  ch.sendPeer({
    t: "settleHalf",
    partyABalance: half.settlement.partyABalance.toString(),
    partyBBalance: half.settlement.partyBBalance.toString(),
    finalNonce: half.settlement.finalNonce.toString(),
    timestamp: half.settlement.timestamp.toString(),
    sig: toHex(half.sigSelf),
  });
  const other = await waitPeer("settleHalf");
  const co = dt.combineSettlement(
    half.settlement,
    half.sigSelf,
    fromHex(other.sig),
  );
  if (match.role === "A")
    await closeCooperative({
      signExec: deps.signExec,
      tunnelId,
      settlement: co,
    });
}

export async function runAgent(
  deps: AgentDeps,
  shouldStop: () => boolean,
): Promise<void> {
  const connectKey = generateKeyPair(); // authenticates the one shared WS
  const mp = new MpClient(
    resolveMpWsUrl(deps.backendUrl),
    deps.wallet,
    connectKey,
  );
  await mp.connect();

  // Serialize this wallet's on-chain txs (one gas coin -> no Sui equivocation).
  let chain: Promise<unknown> = Promise.resolve();
  const slotDeps: AgentDeps = {
    ...deps,
    signExec: (tx) => {
      const p = chain.then(() => deps.signExec(tx));
      chain = p.catch(() => {});
      return p;
    },
  };

  // M concurrent slots share the one WS + wallet; each loops independently and never idles.
  const slot = async (i: number) => {
    let gi = i % AGENT_GAMES.length; // stagger starts so the fleet spreads across games
    while (!shouldStop()) {
      const spec = AGENT_GAMES[gi];
      deps.onStatus?.(`slot${i}:queue:${spec.id}`);
      try {
        await playOneMatch(mp, slotDeps, spec);
        deps.onStatus?.(`slot${i}:settled:${spec.id}`);
      } catch (e) {
        deps.onStatus?.(
          `slot${i}:error:${spec.id}:${String((e as Error)?.message ?? e)}`,
        );
      }
      gi = nextGameIndex(gi, AGENT_GAMES.length);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, deps.concurrency) }, (_, i) => slot(i)),
  );
  mp.close();
}
```

> Note: this is `pvpTttBot.mjs` (`sui-tunnel-ts/scripts/pvpTttBot.mjs`, lines 34–129) generalized — confirm the `MpClient`/`DistributedTunnel`/`tunnelTx` signatures against that working file and `usePvpTicTacToe.ts` (the `signExec` shape, `openAndFundSharedTunnel` args). The `any` casts bridge the `Protocol<unknown,unknown>` from `createBehaviorProtocol`; tighten later if desired. On a `queue.timeout` (no partner), `quickMatch` should reject → caught → rotate to the next game (add the `queue.timeout` reject to `MpClient.quickMatch` if not present).
>
> **Concurrency (decision #6) requires generalizing `MpClient`** — the main engine change. Today `channel()` overwrites a single `#onRelay` and `quickMatch` uses one `#once("match.found")`, so it serves **one** match at a time. For M concurrent slots over one WS: (1) route inbound `relay {matchId}` frames to a **per-`matchId` channel map**, and (2) correlate each `match.found` to the slot that issued its `queue.join` (e.g. a queue of pending-join resolvers, or a client-supplied join id echoed back). The **relay needs no change** — it already namespaces everything by `matchId`. For the **P1 proof, run M=1** (the single-match path works as-is); generalize `MpClient` and raise M when measuring §Numbers#2.

- [ ] **Step 4: Run the rotation test to confirm it passes**

Run: `cd frontend && pnpm exec tsx --test src/agent/rotation.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Implement `AgentRunner` (the dapp-kit adapter) and wire `App.tsx`**

```tsx
// frontend/src/agent/AgentRunner.tsx
import { useEffect, useRef, useState } from "react";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
  useSuiClient,
} from "@mysten/dapp-kit";
import { runAgent } from "./agentEngine";
import { resolveBackendUrl } from "../backend/controlPlane";

export function AgentRunner() {
  const account = useCurrentAccount();
  const client = useSuiClient();
  const { mutateAsync } = useSignAndExecuteTransaction();
  const [status, setStatus] = useState("init");
  const started = useRef(false);

  useEffect(() => {
    if (!account || started.current) return;
    started.current = true;
    const stop = { v: false };
    const signExec = async (
      tx: Parameters<typeof mutateAsync>[0]["transaction"],
    ) => {
      const r = await mutateAsync({ transaction: tx });
      return { digest: r.digest };
    };
    const M = Number(
      new URL(window.location.href).searchParams.get("m") ?? "1",
    ); // P1 proof: M=1; bump to measure
    void runAgent(
      {
        wallet: account.address,
        signExec,
        reads: client as never,
        backendUrl: resolveBackendUrl(),
        concurrency: M,
        onStatus: setStatus,
      },
      () => stop.v,
    );
    return () => {
      stop.v = true;
    };
  }, [account]);

  return <div data-agent-status={status}>agent: {status}</div>;
}
```

> Note: `resolveBackendUrl` is the same helper `usePvpTicTacToe.ts` uses (it calls `resolveMpWsUrl(resolveBackendUrl())`); import it from wherever that file imports it (`../backend/controlPlane` per the FE map).

In `frontend/src/App.tsx`, branch on agent mode (wrap the existing return):

```tsx
import { parseAgentConfig } from "./agent/agentConfig";
import { AgentBoot } from "./agent/AgentBoot";
import { AgentRunner } from "./agent/AgentRunner";

// inside App(), before the existing desktop return:
if (parseAgentConfig(window.location.href).enabled) {
  return (
    <AgentBoot>
      <AgentRunner />
    </AgentBoot>
  );
}
```

- [ ] **Step 6: Typecheck + build**

Run: `cd frontend && pnpm typecheck && pnpm build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/agent/agentEngine.ts frontend/src/agent/AgentRunner.tsx frontend/src/agent/rotation.test.ts frontend/src/App.tsx
git commit -m "feat(frontend): game-agnostic agent engine + agent-mode route"
```

---

### Task 6: Treasury funding script for agent wallets

Generate N agent keypairs and fund each (gas + the 500 MIST stake) from a treasury wallet in **one PTB** fan-out. Reuses the `@mysten/sui` Transaction patterns already in `tunnelTx.ts`.

**Files:**

- Create: `frontend/agent/fundTreasury.mjs`

- [ ] **Step 1: Implement the funding script**

```js
// frontend/agent/fundTreasury.mjs
// Generate N agent keypairs and fund each from a treasury in one PTB (splitCoins -> transfer).
// Writes keys.json: [{ address, secretKeyB64 }]. Run: SUI_TREASURY_KEY=<suiprivkey> N=20 node fundTreasury.mjs
import { writeFileSync } from "node:fs";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";

const N = Number(process.env.N ?? 20);
const PER = BigInt(process.env.PER_MIST ?? 50_000_000); // gas + stake headroom per agent
const client = new SuiClient({ url: getFullnodeUrl("testnet") });
const treasury = Ed25519Keypair.fromSecretKey(
  decodeSuiPrivateKey(process.env.SUI_TREASURY_KEY).secretKey,
);

const agents = Array.from({ length: N }, () => {
  const kp = new Ed25519Keypair();
  return {
    kp,
    address: kp.getPublicKey().toSuiAddress(),
    secretKeyB64: toBase64(kp.getSecretKey()),
  };
});

const tx = new Transaction();
const coins = tx.splitCoins(
  tx.gas,
  agents.map(() => tx.pure.u64(PER)),
);
agents.forEach((a, i) =>
  tx.transferObjects([coins[i]], tx.pure.address(a.address)),
);
const res = await client.signAndExecuteTransaction({
  signer: treasury,
  transaction: tx,
  options: { showEffects: true },
});
await client.waitForTransaction({ digest: res.digest });
if (res.effects?.status?.status !== "success")
  throw new Error(`fan-out failed: ${res.effects?.status?.error}`);

writeFileSync(
  new URL("./keys.json", import.meta.url),
  JSON.stringify(
    agents.map(({ address, secretKeyB64 }) => ({ address, secretKeyB64 })),
    null,
    2,
  ),
);
console.log(`funded ${N} agents @ ${PER} MIST each | digest ${res.digest}`);
```

- [ ] **Step 2: Dry-run with a small N against the treasury**

Run: `cd frontend/agent && SUI_TREASURY_KEY=<suiprivkey> N=4 node fundTreasury.mjs`
Expected: `funded 4 agents …` and a `keys.json` with 4 entries. Verify one address shows the balance on `https://suiscan.xyz/testnet/account/<address>`.

- [ ] **Step 3: Commit**

```bash
git add frontend/agent/fundTreasury.mjs
git commit -m "feat(agent): treasury PTB fan-out funding for agent wallets"
```

> P2 note: at 10k wallets this becomes batched (multiple PTBs, the testnet-SUI long-pole
> risk in spec §3). P1 only needs enough agents to load-test, so one PTB suffices.

---

### Task 7: Playwright 2-context end-to-end proof

Two agent contexts, each with a funded key, must match each other, play to terminal, and settle — through the real app, no human, no popup. This is P1's core success criterion.

**Files:**

- Create: `frontend/agent/runAgents.mjs`
- Modify: `frontend/package.json` (add `playwright` devDep + a script)

- [ ] **Step 1: Add Playwright**

Run: `cd frontend && pnpm add -D playwright && pnpm exec playwright install chromium`

- [ ] **Step 2: Implement the runner**

```js
// frontend/agent/runAgents.mjs
// Launch K agent contexts against the deployed page with bare ?agent (all-games rotation).
// Anti-throttle flags are REQUIRED or background contexts idle (spec §5).
// Run: BASE_URL=https://<page> K=2 node runAgents.mjs
// NOTE: every agent starts its rotation at game[0] (tic-tac-toe), so two agents launched
// together share that queue and match on round 1. At fleet scale, matches finish at
// different times and the rotation + queue.timeout fallback spreads agents across all games.
import { readFileSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:5173";
const keys = JSON.parse(readFileSync(new URL("./keys.json", import.meta.url)));
const K = Number(process.env.K ?? keys.length);

const browser = await chromium.launch({
  headless: true,
  args: [
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
  ],
});

const pages = [];
for (let i = 0; i < K; i++) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("console", (m) => console.log(`[agent ${i}] ${m.text()}`));
  const url = `${BASE}/?agent&key=${encodeURIComponent(keys[i].secretKeyB64)}`;
  await page.goto(url);
  pages.push(page);
}

// Two agents should reach a settled status within the timeout.
const settled = await Promise.all(
  pages.slice(0, 2).map((p) =>
    p
      .waitForSelector('[data-agent-status="settled"]', { timeout: 120_000 })
      .then(() => true)
      .catch(() => false),
  ),
);
console.log("settled:", settled);
if (!settled.every(Boolean)) {
  await browser.close();
  process.exit(1);
}
console.log("PASS: two real-app agents matched, played, and settled");
await browser.close();
```

- [ ] **Step 3: Run it (dev server in one terminal, runner in another)**

Run (terminal A): `cd frontend && pnpm dev`
Run (terminal B): `cd frontend/agent && K=2 BASE_URL=http://localhost:5173 node runAgents.mjs`
Expected: `PASS: two real-app agents matched, played, and settled`, and `suiscan` shows a `close_cooperative*` tx from one agent's wallet. If it hangs at "agent connecting…", the wallet didn't connect — re-check Task 4.

- [ ] **Step 4: Commit**

```bash
git add frontend/agent/runAgents.mjs frontend/package.json frontend/pnpm-lock.yaml
git commit -m "test(agent): playwright 2-context end-to-end proof"
```

---

### Task 8: Relay load-test harness (spec §Numbers #1)

Measure one relay instance's sustained frame-forward rate and p99 — the single number that sizes the P2 fleet. No game logic: two raw WS peers ping opaque frames as fast as the relay forwards them.

**Files:**

- Create: `frontend/agent/loadtestRelay.mjs`
- Create: `frontend/agent/README.md`

- [ ] **Step 1: Implement the micro-bench**

```js
// frontend/agent/loadtestRelay.mjs
// Open T paired raw WS connections to the relay and bounce opaque frames for D seconds,
// reporting forwarded-frames/sec and p99 round-trip. This is spec §Numbers #1: it sizes
// how many relay instances P2 needs. Run: MP_WS_URL=ws://<alb>/v1/mp T=50 D=20 node loadtestRelay.mjs
import { WebSocket } from "ws";
const URL = process.env.MP_WS_URL ?? "ws://localhost:8080/v1/mp";
const T = Number(process.env.T ?? 50); // tunnels (paired sockets)
const D = Number(process.env.D ?? 20) * 1000;
let frames = 0;
const lat = [];

// NOTE: this drives the relay's raw frame path. It assumes a relay echo/loopback test
// endpoint OR uses queue.join to pair two sockets per tunnel (see README for which the
// deployed build supports). Pairing handshake omitted here for brevity — see README step.
function pair() {
  /* open two sockets, complete connect+queue.join, then on match.found bounce frames */
}

const start = Date.now();
for (let i = 0; i < T; i++) pair();
setTimeout(() => {
  const secs = (Date.now() - start) / 1000;
  lat.sort((a, b) => a - b);
  console.log(
    `frames/sec ~ ${Math.round(frames / secs)} | p99 rtt ${lat[Math.floor(lat.length * 0.99)] ?? "n/a"}ms | tunnels ${T}`,
  );
  process.exit(0);
}, D);
```

- [ ] **Step 2: Write the README with the exact run procedure**

```md
# frontend/agent — agent fleet (P1)

1. Fund: `SUI_TREASURY_KEY=<key> N=50 node fundTreasury.mjs` → keys.json
2. Agents: `BASE_URL=<published page> GAME=tictactoe K=50 node runAgents.mjs`
3. Relay load test: `MP_WS_URL=ws://<alb>/v1/mp T=100 D=30 node loadtestRelay.mjs`

The relay pairing handshake in loadtestRelay.mjs mirrors `pvpTttBot.mjs`
(connect→challenge→queue.join→match.found→relay frames). Reuse that exact
handshake; the bench only differs in sending frames in a tight loop instead of
game moves. Record frames/sec and p99 — these size the P2 relay fleet.
```

- [ ] **Step 3: Run against the dev relay and record the number**

Run: `cd frontend/agent && pnpm add -D ws && MP_WS_URL=ws://dopamint-dev-alb-0fac7e0-1152788681.us-east-1.elb.amazonaws.com/v1/mp T=100 D=30 node loadtestRelay.mjs`
Expected: a `frames/sec ~ N` line. Record it in the spec's "Numbers — TBD" section, **then compare N against `R_min`** (spec §Numbers kill-criterion) and record which fallback branch (a/b/c) applies — this gates whether/how P2 scales.

- [ ] **Step 4: Commit**

```bash
git add frontend/agent/loadtestRelay.mjs frontend/agent/README.md frontend/package.json frontend/pnpm-lock.yaml
git commit -m "test(agent): single-relay frame-rate load-test harness"
```

---

## Self-review

**Spec coverage (P1 slice):**

- Agent mode + programmatic wallet (spec §1, §2) → Tasks 2, 4, 5. ✓
- Real-app path, not headless (spec §Why #2) → Tasks 5, 7 (drives the published page). ✓
- Funding via gated deposit + treasury fan-out (spec §3) → Task 6 (funds wallets; the gated `deposit_party_*` happens inside the engine's `openAndFundSharedTunnel`/`depositStake` calls in Task 5, reusing the unchanged `tunnelTx` builders). ✓
- Walrus + on-chain settle (spec §8) → reused unchanged via `closeCooperative` (verified by the suiscan check in Task 7). ✓
- Load-test first (spec §Numbers #1–#3) → Tasks 7, 8. ✓
- Human drop-in (spec §6) → **not P1**; the same `?agent`-off page is the human path, exercised in P2. Noted, not a gap.
- Anti-throttle + context-per-agent (spec §5) → Task 7. ✓

**Placeholder scan:** `loadtestRelay.mjs` leaves the WS pairing handshake as a documented reuse of `pvpTttBot.mjs` rather than re-pasting it — the README names the exact handshake. This is the one spot that defers code to an existing reference; flagged here intentionally, not a silent TODO.

**Type consistency:** `SignExec` = `(tx) => Promise<{ digest }>` (tunnelTx.ts:52) is satisfied by the wallet's `sui:signAndExecuteTransaction` returning `{ digest, ... }` → dapp-kit's `useSignAndExecuteTransaction` → the wrapper at `usePvpTicTacToe.ts:121`. `secretKeyB64` is produced by `fundTreasury.mjs` (`toBase64(kp.getSecretKey())`) and consumed by `agentConfig`/`AgentBoot` (`fromBase64`). Consistent.

**Open risk to verify first in execution:** the generic engine (Task 5) assumes the exact `MpClient` / `DistributedTunnel` / `tunnelTx` (`openAndFundSharedTunnel`, `depositStake`, `closeCooperative`, `readCreatedAt`, `SignExec`) signatures — confirm against the working `sui-tunnel-ts/scripts/pvpTttBot.mjs` and `usePvpTicTacToe.ts`; and the `@mysten/wallet-standard` feature method signatures for the installed version. Both surface immediately at Task 4/5 typecheck and Task 7's run, the right place to confirm them. Also confirm `MpClient.quickMatch` rejects on `queue.timeout` so the rotate-on-no-partner fallback works (add it if missing).
