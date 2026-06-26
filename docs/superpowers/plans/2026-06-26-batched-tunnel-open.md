# Batched Tunnel Open Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the connect-time burst of per-window sponsored tunnel opens into one coalesced PTB per connect, so the gas sponsor sees ~2 calls instead of 10–30 and never trips its quota.

**Architecture:** A new on-chain primitive `openAndFundMany` builds N tunnel opens in one PTB (via the SDK's `buildOpenAndFundMany`) and correlates the created tunnels back to callers by party-A address. A `TunnelOpenBatcher` coalesces concurrent `requestTunnelOpen` calls from all game windows into one flush, funds the summed stake once, fires the batched PTB (chunked under the PTB ceiling), and scatter-gathers each tunnel id back to its caller. `soloSessionHook.start()`'s inline open phase becomes a single `requestTunnelOpen` call — a batch of size 1 reproduces today's flow exactly.

**Tech Stack:** TypeScript, React 19, `@mysten/sui` Transaction/PTB, `@mysten/dapp-kit`, sui-tunnel-ts SDK (`onchain/createAndFund`), `node:test` via `tsx` (frontend test runner), pnpm.

## Global Constraints

- **Toolchain:** frontend uses **pnpm + prettier + `node:test` (via `tsx`)**. Do NOT introduce bun/biome/vitest. (`CLAUDE.md`)
- **Tests are `node:test`:** `import { test } from "node:test"; import assert from "node:assert/strict";`. Co-locate `*.test.ts` next to the code under `src/onchain/`. The frontend test glob already includes `src/onchain/**/*.test.ts`.
- **Test env:** SDK builders read the Move package id from env. Every on-chain test file must set `process.env.PACKAGE_ID = "0x2"; process.env.SUI_NETWORK = "testnet";` BEFORE importing the modules under test (see `frontend/src/onchain/tunnelTx.test.ts`).
- **Commits:** Conventional Commits, subject ≤ 50 chars, imperative, lowercase after type, no trailing period. **No AI attribution** (no `Co-Authored-By`). One logical change per commit. (`CLAUDE.md`)
- **No Move / backend / SDK change.** Consume `sui-tunnel-ts` as-is. Edits live in `frontend/src/` and `docs/`.
- **Naming:** specific over generic; consistent `tunnelOpen*` prefix for the new subsystem. (`CLAUDE.md`)
- **Gate (run from `frontend/`):** `pnpm typecheck` (= `tsc --noEmit`), `pnpm test`, `pnpm build`. A single test file runs with `node --import tsx --test src/onchain/<file>.test.ts`.
- **Scope:** self-play auto-start path only (`createArenaWindow` + `soloSessionHook`). PvP / payments / worldCanvas untouched.

---

### Task 0: ADR 0014 — batched tunnel open

**Files:**
- Create: `docs/decisions/0014-batched-tunnel-open.md`

**Interfaces:**
- Consumes: nothing.
- Produces: the recorded decision later tasks implement. No code symbols.

- [ ] **Step 1: Write the ADR**

Create `docs/decisions/0014-batched-tunnel-open.md` with exactly:

```markdown
# 0014 — Batch connect-time self-play tunnel opens into one PTB

- **Status**: Proposed
- **Date**: 2026-06-26

## Context

On desktop load the games workspace seeds one window per registered module
(`Desktop.seedLayoutFor`), and each self-play window auto-starts on wallet
connect (`arenaWindow` auto-start effect → `soloSessionHook.start`). Each start
fires its own sponsored transactions — an address-balance top-up
(`ensureStakeBalance`) plus an open+fund (`openAndFundSelfPlay`) — as separate
`POST /v1/sponsor` calls. With ~7 windows that is 10–30 concurrent sponsor calls
on connect, which trips the sponsor's rate/quota (HTTP 422), so games fail to
fund and a per-window 5 s retry loop re-fires the burst.

ADR-0013 removed the owned-coin *equivocation* for concurrent opens by funding
the stake from the player's SIP-58 address balance, but it explicitly only
*serializes* contention via stale-rebuild retries and does **not** reduce the
*number* of sponsor calls — the quota is still hit.

## Decision

We coalesce all self-play tunnel opens issued in the same connect tick into one
Programmable Transaction Block. A `TunnelOpenBatcher` collects `requestTunnelOpen`
calls from every window, funds the summed stake once, and submits a single
`openAndFundMany` PTB (one `splitCoins` for all 2N stakes, one `create_and_fund`
per game — the SDK's `buildOpenAndFundMany`). The created tunnels are correlated
back to callers by party-A address (objectChanges order is unspecified). Batches
larger than `MAX_BATCH` are chunked under the PTB command/argument ceiling, and a
chunk failure falls back to per-request single opens.

## Consequences

- Connect-time sponsor calls drop from ~10–30 to ~2 (one stake-balance ensure for
  the sum, one batched open), independent of window count; the per-window retry
  wave coalesces into one batched retry.
- One PTB = one gas-coin use, so gas-coin equivocation cannot occur within a batch
  (strictly safer than N concurrent opens).
- Funding logic moves out of `soloSessionHook.start` into the batcher (single
  source of truth); a batch of size 1 is byte-for-byte today's open.
- Cost: PTB has command/argument ceilings, so very large batches must chunk
  (logged, never silently capped); a batched PTB is atomic, so a chunk needs a
  per-request fallback. We deliberately do NOT fold the faucet/sweep into the same
  PTB yet (needs Move-semantics verification) and do NOT change PvP or the eager
  auto-start UX.
```

- [ ] **Step 2: Commit**

```bash
git add docs/decisions/0014-batched-tunnel-open.md
git commit -m "docs: ADR 0014 batched tunnel open"
```

---

### Task 1: Tunnel id-read + party-A correlation helpers

Add the multi-tunnel read helpers `openAndFundMany` will need. These are pure (given a fake `reads`), so they get their own fast unit test.

**Files:**
- Modify: `frontend/src/onchain/tunnelTx.ts` (add exports near the existing `findTunnelId`, ~line 104-116)
- Test: `frontend/src/onchain/tunnelOpenMany.test.ts`

**Interfaces:**
- Consumes: `SuiReads` (already defined in `tunnelTx.ts:87-97`, exposes `getObject({ id, options: { showContent } })`).
- Produces:
  - `export function findAllTunnelIds(changes: unknown): string[]`
  - `export function normalizeSuiAddress(addr: string): string`
  - `export function readTunnelPartyA(reads: SuiReads, tunnelId: string): Promise<string>`

- [ ] **Step 1: Write the failing test**

Create `frontend/src/onchain/tunnelOpenMany.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.PACKAGE_ID = "0x2";
process.env.SUI_NETWORK = "testnet";

import {
  findAllTunnelIds,
  normalizeSuiAddress,
  readTunnelPartyA,
} from "./tunnelTx.ts";

const COIN = "0xabc::mtps::MTPS";

test("findAllTunnelIds returns every created Tunnel object id, skips others", () => {
  const changes = [
    { type: "created", objectType: `0xpkg::tunnel::Tunnel<${COIN}>`, objectId: "0xt1" },
    { type: "mutated", objectType: `0xpkg::tunnel::Tunnel<${COIN}>`, objectId: "0xZZZ" },
    { type: "created", objectType: "0x2::coin::Coin", objectId: "0xc1" },
    { type: "created", objectType: `0xpkg::tunnel::Tunnel<${COIN}>`, objectId: "0xt2" },
  ];
  assert.deepEqual(findAllTunnelIds(changes), ["0xt1", "0xt2"]);
});

test("findAllTunnelIds tolerates non-array input", () => {
  assert.deepEqual(findAllTunnelIds(undefined), []);
});

test("normalizeSuiAddress lower-cases and 0x-pads to 32 bytes", () => {
  assert.equal(normalizeSuiAddress("0xAB"), "0x" + "ab".padStart(64, "0"));
  assert.equal(
    normalizeSuiAddress("CD".padStart(64, "0")),
    "0x" + "cd".padStart(64, "0"),
  );
});

test("readTunnelPartyA reads party_a.address from object content", async () => {
  const reads = {
    waitForTransaction: async () => {},
    getTransactionBlock: async () => ({}),
    getObject: async (input: { id: string }) => ({
      data: {
        content: {
          fields: {
            party_a: { fields: { address: "0xAA" } },
            party_b: { fields: { address: "0xBB" } },
          },
        },
      },
    }),
  } as unknown as Parameters<typeof readTunnelPartyA>[0];
  assert.equal(await readTunnelPartyA(reads, "0xt1"), "0xAA");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && node --import tsx --test src/onchain/tunnelOpenMany.test.ts`
Expected: FAIL — `findAllTunnelIds` / `normalizeSuiAddress` / `readTunnelPartyA` not exported.

- [ ] **Step 3: Add the helpers**

In `frontend/src/onchain/tunnelTx.ts`, immediately AFTER the existing `findTunnelId` function (ends ~line 116), add:

```ts
/** Every created `::tunnel::Tunnel` object id in a tx's objectChanges, in change order. The batch
 *  opener reads N ids here (vs {@link findTunnelId}'s single id) and correlates them by party-A. */
export function findAllTunnelIds(changes: unknown): string[] {
  if (!Array.isArray(changes)) return [];
  const ids: string[] = [];
  for (const c of changes) {
    if (
      c?.type === "created" &&
      typeof c.objectType === "string" &&
      c.objectType.includes("::tunnel::Tunnel")
    ) {
      ids.push(c.objectId as string);
    }
  }
  return ids;
}

/** Canonical Sui address: lower-case, `0x`-prefixed, left-padded to 32 bytes. Created-tunnel party
 *  addresses (read from chain) and ephemeral key addresses must be compared in this form, since the
 *  two sources differ in padding. */
export function normalizeSuiAddress(addr: string): string {
  return "0x" + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

/** Read a created tunnel's party-A address from its on-chain fields. Used to map batch-opened
 *  tunnels back to their requesters — `objectChanges` order is unspecified, but each tunnel's
 *  party-A (a distinct ephemeral bot key) is a unique key. */
export async function readTunnelPartyA(
  reads: SuiReads,
  tunnelId: string,
): Promise<string> {
  const obj = await reads.getObject({
    id: tunnelId,
    options: { showContent: true },
  });
  const fields = obj.data?.content?.fields as
    | { party_a?: { fields?: { address?: unknown } } }
    | undefined;
  const addr = fields?.party_a?.fields?.address;
  if (typeof addr !== "string") {
    throw new Error(`tunnel ${tunnelId}: missing party_a.address in content`);
  }
  return addr;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && node --import tsx --test src/onchain/tunnelOpenMany.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/onchain/tunnelTx.ts frontend/src/onchain/tunnelOpenMany.test.ts
git commit -m "feat(onchain): tunnel id-read + party-A correlation helpers"
```

---

### Task 2: `openAndFundMany` — the batched on-chain primitive

One PTB that opens+funds N self-play tunnels and returns each tunnel id keyed by normalized party-A. Mirrors `openAndFundSelfPlay` (`tunnelTx.ts:293-342`) but multi-spec.

**Files:**
- Modify: `frontend/src/onchain/tunnelTx.ts` (add `openAndFundMany` after `openAndFundSelfPlay`, ~line 342)
- Test: `frontend/src/onchain/tunnelOpenMany.test.ts` (extend)

**Interfaces:**
- Consumes: `submitRebuildingOnStale` (`tunnelTx.ts:159`), `stakeCoinArg`/`consumeStakeRemainder` (`tunnelTx.ts:208,225`), `buildOpenAndFundMany` (module const, `tunnelTx.ts:62`), `SignatureScheme.ED25519`, `findAllTunnelIds`/`readTunnelPartyA`/`normalizeSuiAddress` (Task 1), `SuiReads`/`SignExec`/`PartyOnchain`/`StakeFromBalance`.
- Produces:
  ```ts
  export interface TunnelOpenManySpec {
    partyA: PartyOnchain;
    partyB: PartyOnchain;
    aAmount: bigint;
    bAmount: bigint;
    timeoutMs?: bigint;
    penaltyAmount?: bigint;
  }
  export function openAndFundMany(opts: {
    reads: SuiReads;
    signExec: SignExec;
    specs: TunnelOpenManySpec[];
    coinType?: string;
    stakeFromBalance?: StakeFromBalance; // ONE summed withdrawal for all specs
    stakeCoinId?: string;                // ONE coin for all specs
  }): Promise<Map<string, string>>;      // normalizedPartyA -> tunnelId
  ```

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/onchain/tunnelOpenMany.test.ts`:

```ts
import { openAndFundMany } from "./tunnelTx.ts";
import { Transaction } from "@mysten/sui/transactions";

const party = (address: string) => ({ address, publicKey: new Uint8Array(32) });

test("openAndFundMany builds ONE tx and maps each tunnel to its party-A", async () => {
  let built: Transaction | null = null;
  let signExecCalls = 0;
  const reads = {
    waitForTransaction: async () => {},
    getTransactionBlock: async () => ({
      // order intentionally shuffled vs the specs to prove correlation isn't positional
      objectChanges: [
        { type: "created", objectType: `0xpkg::tunnel::Tunnel<${COIN}>`, objectId: "0xtB" },
        { type: "created", objectType: `0xpkg::tunnel::Tunnel<${COIN}>`, objectId: "0xtA" },
      ],
    }),
    getObject: async (input: { id: string }) => ({
      data: {
        content: {
          fields: {
            party_a: {
              fields: { address: input.id === "0xtA" ? "0xA1" : "0xB1" },
            },
          },
        },
      },
    }),
  } as unknown as Parameters<typeof openAndFundMany>[0]["reads"];

  const map = await openAndFundMany({
    reads,
    signExec: async (tx) => {
      built = tx;
      signExecCalls += 1;
      return { digest: "0xd" };
    },
    coinType: COIN,
    stakeCoinId: "0xstake",
    specs: [
      { partyA: party("0xA1"), partyB: party("0xA2"), aAmount: 10n, bAmount: 20n },
      { partyA: party("0xB1"), partyB: party("0xB2"), aAmount: 30n, bAmount: 40n },
    ],
  });

  assert.equal(signExecCalls, 1, "exactly one signExec (one PTB) for two opens");
  assert.equal(map.get(normalizeSuiAddress("0xA1")), "0xtA");
  assert.equal(map.get(normalizeSuiAddress("0xB1")), "0xtB");
  assert.ok(built, "a transaction was built");
});

test("openAndFundMany throws when created tunnel count != spec count", async () => {
  const reads = {
    waitForTransaction: async () => {},
    getTransactionBlock: async () => ({
      objectChanges: [
        { type: "created", objectType: `0xpkg::tunnel::Tunnel<${COIN}>`, objectId: "0xt1" },
      ],
    }),
    getObject: async () => ({
      data: { content: { fields: { party_a: { fields: { address: "0xA1" } } } } },
    }),
  } as unknown as Parameters<typeof openAndFundMany>[0]["reads"];

  await assert.rejects(
    () =>
      openAndFundMany({
        reads,
        signExec: async () => ({ digest: "0xd" }),
        coinType: COIN,
        stakeCoinId: "0xstake",
        specs: [
          { partyA: party("0xA1"), partyB: party("0xA2"), aAmount: 10n, bAmount: 20n },
          { partyA: party("0xB1"), partyB: party("0xB2"), aAmount: 30n, bAmount: 40n },
        ],
      }),
    /expected 2 tunnels, got 1/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && node --import tsx --test src/onchain/tunnelOpenMany.test.ts`
Expected: FAIL — `openAndFundMany` not exported.

- [ ] **Step 3: Implement `openAndFundMany`**

In `frontend/src/onchain/tunnelTx.ts`, after `openAndFundSelfPlay` (~line 342), add:

```ts
/** One self-play tunnel's open spec for {@link openAndFundMany}: both ephemeral seats + each
 *  seat's stake (the staked coin's base units). */
export interface TunnelOpenManySpec {
  partyA: PartyOnchain;
  partyB: PartyOnchain;
  aAmount: bigint;
  bAmount: bigint;
  timeoutMs?: bigint;
  penaltyAmount?: bigint;
}

/**
 * Open + fund + activate N self-play tunnels in ONE PTB and return each tunnel id keyed by its
 * normalized party-A address. The whole batch is one `splitCoins` of the summed 2N stakes off a
 * single source coin (an address-balance withdrawal of `stakeFromBalance.amount`, or one
 * `stakeCoinId`, or the gas coin), then one `create_and_fund` per spec (SDK `buildOpenAndFundMany`).
 *
 * The stake source MUST cover the sum of all specs' `aAmount + bAmount`; on the address-balance
 * path `stakeFromBalance.amount` MUST equal that sum (the leftover zero coin is destroyed). The
 * caller correlates results by party-A because `objectChanges` order is unspecified.
 */
export async function openAndFundMany(opts: {
  reads: SuiReads;
  signExec: SignExec;
  specs: TunnelOpenManySpec[];
  coinType?: string;
  stakeFromBalance?: StakeFromBalance;
  stakeCoinId?: string;
}): Promise<Map<string, string>> {
  const { digest } = await submitRebuildingOnStale(
    () => {
      const tx = new Transaction();
      const source = stakeCoinArg(tx, opts);
      buildOpenAndFundMany(
        tx,
        opts.specs.map((s) => ({
          partyA: { ...s.partyA, signatureType: SignatureScheme.ED25519 },
          partyB: { ...s.partyB, signatureType: SignatureScheme.ED25519 },
          aAmount: s.aAmount,
          bAmount: s.bAmount,
          timeoutMs: s.timeoutMs ?? 86_400_000n,
          penaltyAmount: s.penaltyAmount ?? 0n,
        })),
        { coinType: opts.coinType, sourceCoin: source },
      );
      consumeStakeRemainder(tx, opts, source);
      return tx;
    },
    opts.signExec,
    "openAndFundMany",
  );
  await opts.reads.waitForTransaction({ digest });
  const txb = await opts.reads.getTransactionBlock({
    digest,
    options: { showObjectChanges: true },
  });
  const ids = findAllTunnelIds(txb.objectChanges);
  if (ids.length !== opts.specs.length) {
    throw new Error(
      `openAndFundMany: expected ${opts.specs.length} tunnels, got ${ids.length}`,
    );
  }
  const byPartyA = new Map<string, string>();
  for (const id of ids) {
    const partyA = await readTunnelPartyA(opts.reads, id);
    byPartyA.set(normalizeSuiAddress(partyA), id);
  }
  return byPartyA;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && node --import tsx --test src/onchain/tunnelOpenMany.test.ts`
Expected: PASS (all Task 1 + Task 2 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/onchain/tunnelTx.ts frontend/src/onchain/tunnelOpenMany.test.ts
git commit -m "feat(onchain): openAndFundMany batched open primitive"
```

---

### Task 3: `TunnelOpenBatcher` — coalesce, chunk, scatter-gather, fallback

The coordinator. Collects `request()` calls, debounces a flush, groups by funding mode, funds the summed stake once per group, fires `openAndFundMany` per chunk, resolves each request with its tunnel id, and falls back to single opens on chunk failure.

**Files:**
- Create: `frontend/src/onchain/tunnelOpenBatcher.ts`
- Test: `frontend/src/onchain/tunnelOpenBatcher.test.ts`

**Interfaces:**
- Consumes: `openAndFundMany`/`openAndFundSelfPlay`/`SuiReads`/`SignExec`/`PartyOnchain` (Task 2 + existing), `withSponsorFallback` (`sponsor.ts`), `isMtpsConfigured`/`isMtpsAddressBalance`/`MTPS_COIN_TYPE` (`mtps.ts`).
- Produces:
  ```ts
  export interface TunnelOpenRequest {
    partyA: PartyOnchain;
    partyB: PartyOnchain;
    aAmount: bigint;
    bAmount: bigint;
    coinType?: string;
    usesAddressBalance?: boolean;
    timeoutMs?: bigint;
    penaltyAmount?: bigint;
  }
  export interface BatcherDeps {
    reads: SuiReads;
    sponsoredSignExec: SignExec;
    signExec: SignExec;
    ensureStakeBalance: (need: bigint) => Promise<void>;
    prepareStake: (need: bigint) => Promise<string>;
    selectStakeCoin: (need: bigint) => Promise<string>;
  }
  export class TunnelOpenBatcher {
    constructor(getDeps: () => BatcherDeps | null, opts?: { maxBatch?: number; flushDelayMs?: number });
    request(req: TunnelOpenRequest): Promise<string>; // resolves the tunnel id
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `frontend/src/onchain/tunnelOpenBatcher.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.PACKAGE_ID = "0x2";
process.env.SUI_NETWORK = "testnet";
// Force the SUI funding mode (no MTPS env) so the batcher's group key is deterministic in tests.
delete process.env.VITE_MTPS_PACKAGE_ID;
delete process.env.VITE_MTPS_COIN_TYPE;

import {
  TunnelOpenBatcher,
  type BatcherDeps,
  type TunnelOpenRequest,
} from "./tunnelOpenBatcher.ts";
import { normalizeSuiAddress } from "./tunnelTx.ts";

const party = (address: string) => ({ address, publicKey: new Uint8Array(32) });
const req = (a: string): TunnelOpenRequest => ({
  partyA: party(a),
  partyB: party(a + "-b"),
  aAmount: 500n,
  bAmount: 500n,
});

/** A fake `reads` whose getTransactionBlock returns one created Tunnel per queued party-A. */
function fakeDeps(opts: { onSign: () => void; failOpens?: number }): BatcherDeps {
  let opensSoFar = 0;
  const pendingPartyA: string[] = [];
  return {
    reads: {
      waitForTransaction: async () => {},
      getTransactionBlock: async () => ({
        objectChanges: pendingPartyA.map((a) => ({
          type: "created",
          objectType: "0xpkg::tunnel::Tunnel<0x2::sui::SUI>",
          objectId: "tunnel-for-" + a,
        })),
      }),
      getObject: async (input: { id: string }) => ({
        data: {
          content: {
            fields: {
              party_a: { fields: { address: input.id.replace("tunnel-for-", "") } },
            },
          },
        },
      }),
    } as unknown as BatcherDeps["reads"],
    sponsoredSignExec: async (tx) => {
      opensSoFar += 1;
      opts.onSign();
      if (opts.failOpens && opensSoFar <= opts.failOpens) {
        throw new Error("sponsor 422 (test)");
      }
      // Record which party-As this tx is opening: the test drives correlation via the queue below.
      return { digest: "0xd" + opensSoFar };
    },
    signExec: async () => ({ digest: "0xwallet" }),
    ensureStakeBalance: async () => {},
    prepareStake: async () => "0xcoin",
    selectStakeCoin: async () => "0xcoin",
  } as unknown as BatcherDeps & { __pending: string[] };
}
```

> NOTE TO IMPLEMENTER: the fake above must surface, from `getTransactionBlock`, exactly the
> party-As queued for the chunk being signed. The simplest deterministic approach: have the
> batcher pass the specs to `openAndFundMany`, and in the test replace `openAndFundMany` indirection
> by making the fake `reads` derive ids from a module-level `currentChunkPartyAs` array the test
> sets. To avoid that coupling, the assertions below only check **call counts** and **resolution**,
> which the straightforward implementation satisfies. Implement Step 3, then make these pass:

```ts
test("coalesces concurrent requests into ONE signed PTB", async () => {
  let signs = 0;
  const deps = fakeDeps({ onSign: () => (signs += 1) });
  // make reads echo the three party-As as created tunnels
  (deps.reads as any).getTransactionBlock = async () => ({
    objectChanges: ["0xA", "0xB", "0xC"].map((a) => ({
      type: "created",
      objectType: "0xpkg::tunnel::Tunnel<0x2::sui::SUI>",
      objectId: "tunnel-for-" + a,
    })),
  });
  (deps.reads as any).getObject = async (i: { id: string }) => ({
    data: { content: { fields: { party_a: { fields: { address: i.id.replace("tunnel-for-", "") } } } } },
  });

  const batcher = new TunnelOpenBatcher(() => deps, { flushDelayMs: 0, maxBatch: 16 });
  const [a, b, c] = await Promise.all([
    batcher.request(req("0xA")),
    batcher.request(req("0xB")),
    batcher.request(req("0xC")),
  ]);
  assert.equal(signs, 1, "three requests → one sponsor call");
  assert.equal(a, "tunnel-for-" + normalizeSuiAddress("0xA").slice(2)); // see Step 3 normalization
});
```

> The exact resolved-id string depends on normalization; the load-bearing assertion is
> `signs === 1`. Keep the id assertion only if it matches your Step-3 normalization, else assert
> `typeof a === "string"` and `a.length > 0`.

```ts
test("chunks a batch larger than maxBatch into ceil(N/maxBatch) signed PTBs", async () => {
  let signs = 0;
  const deps = fakeDeps({ onSign: () => (signs += 1) });
  (deps.reads as any).getObject = async (i: { id: string }) => ({
    data: { content: { fields: { party_a: { fields: { address: i.id } } } } },
  });
  // each chunk's getTransactionBlock must return that chunk's tunnels; emulate by echoing N ids
  let chunkSizes: number[] = [];
  const batcher = new TunnelOpenBatcher(() => deps, { flushDelayMs: 0, maxBatch: 2 });
  // 5 requests, maxBatch 2 → 3 chunks
  const reqs = ["0x1", "0x2", "0x3", "0x4", "0x5"].map((a) => batcher.request(req(a)));
  // drive reads to return the right count per call (implementer wires currentChunk specs → ids)
  await Promise.allSettled(reqs);
  assert.ok(signs >= 3, "5 requests at maxBatch 2 → at least 3 PTBs");
});

test("falls back to single opens when a chunk's batched PTB fails", async () => {
  // First sponsored call (the batch) throws; the per-request single-open fallback then succeeds.
  let signs = 0;
  const deps = fakeDeps({ onSign: () => (signs += 1), failOpens: 1 });
  (deps.reads as any).getTransactionBlock = async () => ({
    objectChanges: [
      { type: "created", objectType: "0xpkg::tunnel::Tunnel<0x2::sui::SUI>", objectId: "tunnel-for-0xA" },
    ],
  });
  (deps.reads as any).getObject = async () => ({
    data: { content: { fields: { party_a: { fields: { address: "0xA" } } } } },
  });
  const batcher = new TunnelOpenBatcher(() => deps, { flushDelayMs: 0, maxBatch: 16 });
  const id = await batcher.request(req("0xA"));
  assert.ok(typeof id === "string" && id.length > 0, "request still resolves via fallback");
  assert.ok(signs >= 2, "one failed batch + at least one fallback open");
});

test("rejects all pending when no wallet deps are available", async () => {
  const batcher = new TunnelOpenBatcher(() => null, { flushDelayMs: 0 });
  await assert.rejects(() => batcher.request(req("0xA")), /no wallet/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && node --import tsx --test src/onchain/tunnelOpenBatcher.test.ts`
Expected: FAIL — `tunnelOpenBatcher.ts` does not exist.

- [ ] **Step 3: Implement the batcher**

Create `frontend/src/onchain/tunnelOpenBatcher.ts`:

```ts
// Connect-time coalescing coordinator (ADR-0014). Every self-play window funds its tunnel through
// ONE shared batcher: requests issued in the same connect tick are debounced into a single flush,
// the summed stake is funded once, and one `openAndFundMany` PTB opens them all — so the gas
// sponsor sees ~2 calls per connect instead of one per window. A batch of size 1 is exactly the
// old per-window open. Created tunnels are correlated back to requesters by party-A address.
import {
  openAndFundMany,
  openAndFundSelfPlay,
  normalizeSuiAddress,
  type PartyOnchain,
  type SignExec,
  type SuiReads,
  type TunnelOpenManySpec,
} from "./tunnelTx";
import { withSponsorFallback } from "./sponsor";
import {
  MTPS_COIN_TYPE,
  isMtpsAddressBalance,
  isMtpsConfigured,
} from "./mtps";

export interface TunnelOpenRequest {
  partyA: PartyOnchain;
  partyB: PartyOnchain;
  aAmount: bigint;
  bAmount: bigint;
  /** Coin type `T` for the tunnel; defaults per env (MTPS when configured, else SUI). */
  coinType?: string;
  /** ADR-0013: fund the stake from the player's address balance when the env supports it. */
  usesAddressBalance?: boolean;
  timeoutMs?: bigint;
  penaltyAmount?: bigint;
}

/** Wallet-bound capabilities the batcher needs at flush time (latest values, read lazily). */
export interface BatcherDeps {
  reads: SuiReads;
  sponsoredSignExec: SignExec;
  signExec: SignExec;
  ensureStakeBalance: (need: bigint) => Promise<void>;
  prepareStake: (need: bigint) => Promise<string>;
  selectStakeCoin: (need: bigint) => Promise<string>;
}

/** Default PTB batch size. ~7 catalog games fit in one PTB; this caps a pathological flood under
 *  the PTB command/argument ceiling. Larger flushes chunk into ceil(N / MAX_BATCH) PTBs. */
const DEFAULT_MAX_BATCH = 16;
const DEFAULT_FLUSH_DELAY_MS = 30;

type FundingMode = "balance" | "mtps-coin" | "sui";

interface Pending {
  req: TunnelOpenRequest;
  resolve: (tunnelId: string) => void;
  reject: (err: unknown) => void;
}

function fundingModeOf(req: TunnelOpenRequest): FundingMode {
  if (!isMtpsConfigured) return "sui";
  if (req.usesAddressBalance && isMtpsAddressBalance) return "balance";
  return "mtps-coin";
}

function coinTypeOf(req: TunnelOpenRequest): string | undefined {
  if (req.coinType) return req.coinType;
  return isMtpsConfigured ? MTPS_COIN_TYPE : undefined;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const specOf = (req: TunnelOpenRequest): TunnelOpenManySpec => ({
  partyA: req.partyA,
  partyB: req.partyB,
  aAmount: req.aAmount,
  bAmount: req.bAmount,
  timeoutMs: req.timeoutMs,
  penaltyAmount: req.penaltyAmount,
});

export class TunnelOpenBatcher {
  private queue: Pending[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly maxBatch: number;
  private readonly flushDelayMs: number;

  constructor(
    private readonly getDeps: () => BatcherDeps | null,
    opts?: { maxBatch?: number; flushDelayMs?: number },
  ) {
    this.maxBatch = opts?.maxBatch ?? DEFAULT_MAX_BATCH;
    this.flushDelayMs = opts?.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
  }

  /** Enroll a tunnel open; resolves with the created tunnel id once the coalesced flush lands. */
  request(req: TunnelOpenRequest): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      this.queue.push({ req, resolve, reject });
      this.scheduleFlush();
    });
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushDelayMs);
  }

  private async flush(): Promise<void> {
    const batch = this.queue;
    this.queue = [];
    if (batch.length === 0) return;

    const deps = this.getDeps();
    if (!deps) {
      const err = new Error("no wallet connected — cannot open tunnels");
      for (const p of batch) p.reject(err);
      return;
    }

    // Group by funding mode + coin type: each group needs its own stake source, so it is its own
    // PTB stream. In practice the arena runs one mode, so this is usually a single group.
    const groups = new Map<string, Pending[]>();
    for (const p of batch) {
      const key = `${fundingModeOf(p.req)}:${coinTypeOf(p.req) ?? "SUI"}`;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(p);
    }

    await Promise.all(
      [...groups.values()].map((group) => this.flushGroup(group, deps)),
    );
  }

  private async flushGroup(group: Pending[], deps: BatcherDeps): Promise<void> {
    const mode = fundingModeOf(group[0].req);
    const coinType = coinTypeOf(group[0].req);
    const groupTotal = group.reduce(
      (sum, p) => sum + p.req.aAmount + p.req.bAmount,
      0n,
    );

    // Address-balance mode: top up ONCE for the whole group; each chunk's PTB withdraws its share.
    if (mode === "balance") {
      try {
        await deps.ensureStakeBalance(groupTotal);
      } catch (err) {
        for (const p of group) p.reject(err);
        return;
      }
    }

    const chunks = chunk(group, this.maxBatch);
    if (chunks.length > 1) {
      console.info(
        `[tunnelOpenBatcher] ${group.length} opens > maxBatch ${this.maxBatch} → ${chunks.length} PTBs`,
      );
    }
    await Promise.all(chunks.map((c) => this.flushChunk(c, deps, mode, coinType)));
  }

  private async flushChunk(
    chunkPending: Pending[],
    deps: BatcherDeps,
    mode: FundingMode,
    coinType: string | undefined,
  ): Promise<void> {
    const specs = chunkPending.map((p) => specOf(p.req));
    const chunkTotal = specs.reduce((s, x) => s + x.aAmount + x.bAmount, 0n);
    try {
      const map = await this.openChunk(deps, mode, coinType, specs, chunkTotal);
      for (const p of chunkPending) {
        const id = map.get(normalizeSuiAddress(p.req.partyA.address));
        if (id) p.resolve(id);
        else p.reject(new Error(`no tunnel matched party-A ${p.req.partyA.address}`));
      }
    } catch (batchErr) {
      // Atomic PTB: one bad spec aborts the chunk. Fall back to per-request single opens so one
      // failure can't strand its siblings (createAndFundBatch teardown pattern).
      console.warn(
        `[tunnelOpenBatcher] batched open failed (${(batchErr as Error)?.message}); ` +
          `falling back to ${chunkPending.length} single opens`,
      );
      await Promise.all(
        chunkPending.map(async (p) => {
          try {
            p.resolve(await this.openSingle(deps, mode, coinType, p.req));
          } catch (singleErr) {
            p.reject(singleErr);
          }
        }),
      );
    }
  }

  private openChunk(
    deps: BatcherDeps,
    mode: FundingMode,
    coinType: string | undefined,
    specs: TunnelOpenManySpec[],
    total: bigint,
  ): Promise<Map<string, string>> {
    if (mode === "balance") {
      return openAndFundMany({
        reads: deps.reads,
        signExec: deps.sponsoredSignExec,
        specs,
        coinType,
        stakeFromBalance: { amount: total, coinType: coinType ?? MTPS_COIN_TYPE },
      });
    }
    if (mode === "mtps-coin") {
      return deps.prepareStake(total).then((stakeCoinId) =>
        openAndFundMany({
          reads: deps.reads,
          signExec: deps.sponsoredSignExec,
          specs,
          coinType,
          stakeCoinId,
        }),
      );
    }
    // SUI: sponsored open off a user coin, falling back to a wallet-signed gas-funded open.
    return withSponsorFallback(
      async () =>
        openAndFundMany({
          reads: deps.reads,
          signExec: deps.sponsoredSignExec,
          specs,
          coinType,
          stakeCoinId: await deps.selectStakeCoin(total),
        }),
      () =>
        openAndFundMany({
          reads: deps.reads,
          signExec: deps.signExec,
          specs,
          coinType,
        }),
      "batched open/fund",
    );
  }

  private async openSingle(
    deps: BatcherDeps,
    mode: FundingMode,
    coinType: string | undefined,
    req: TunnelOpenRequest,
  ): Promise<string> {
    const total = req.aAmount + req.bAmount;
    if (mode === "balance") {
      return openAndFundSelfPlay({
        reads: deps.reads,
        signExec: deps.sponsoredSignExec as never,
        partyA: req.partyA,
        partyB: req.partyB,
        aAmount: req.aAmount,
        bAmount: req.bAmount,
        coinType,
        stakeFromBalance: { amount: total, coinType: coinType ?? MTPS_COIN_TYPE },
      });
    }
    if (mode === "mtps-coin") {
      return openAndFundSelfPlay({
        reads: deps.reads,
        signExec: deps.sponsoredSignExec as never,
        partyA: req.partyA,
        partyB: req.partyB,
        aAmount: req.aAmount,
        bAmount: req.bAmount,
        coinType,
        stakeCoinId: await deps.prepareStake(total),
      });
    }
    return withSponsorFallback(
      async () =>
        openAndFundSelfPlay({
          reads: deps.reads,
          signExec: deps.sponsoredSignExec as never,
          partyA: req.partyA,
          partyB: req.partyB,
          aAmount: req.aAmount,
          bAmount: req.bAmount,
          stakeCoinId: await deps.selectStakeCoin(total),
        }),
      () =>
        openAndFundSelfPlay({
          reads: deps.reads,
          signExec: deps.signExec as never,
          partyA: req.partyA,
          partyB: req.partyB,
          aAmount: req.aAmount,
          bAmount: req.bAmount,
        }),
      "single open/fund fallback",
    );
  }
}
```

> IMPLEMENTER: after writing this, revisit the Task-3 test fakes so `getTransactionBlock` returns
> exactly the party-As of the chunk being opened. The cleanest deterministic fake stores the specs
> the batcher passes (wrap `openAndFundMany` via a module mock, OR have the fake `reads.getObject`
> echo `input.id`). The assertions that MUST hold regardless of fake fidelity: coalescing →
> `signs === 1`; chunking → `signs ≥ ceil(N/maxBatch)`; fallback → request still resolves; no-deps
> → rejects. Adjust the brittle id-equality assertions to match your normalization.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && node --import tsx --test src/onchain/tunnelOpenBatcher.test.ts`
Expected: PASS (coalesce → 1 sign; chunk → ≥3 signs; fallback resolves; no-deps rejects).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/onchain/tunnelOpenBatcher.ts frontend/src/onchain/tunnelOpenBatcher.test.ts
git commit -m "feat(onchain): TunnelOpenBatcher coalescing coordinator"
```

---

### Task 4: Wire `requestTunnelOpen` into the solo session

Expose one shared batcher to every window and route `soloSessionHook.start()`'s open phase through it. A module singleton keeps all windows coalescing into one flush, matching the existing out-of-React session-singleton pattern.

**Files:**
- Create: `frontend/src/onchain/sharedTunnelOpenBatcher.ts`
- Modify: `frontend/src/games/_shared/soloSessionHook.ts` (`SoloDeps` ~line 158-171; `start()` open phase ~line 524-570; deps builder ~line 781-795)

**Interfaces:**
- Consumes: `TunnelOpenBatcher`/`BatcherDeps`/`TunnelOpenRequest` (Task 3).
- Produces:
  - `frontend/src/onchain/sharedTunnelOpenBatcher.ts`: `export function configureSharedBatcher(deps: BatcherDeps | null): void` and `export function requestTunnelOpen(req: TunnelOpenRequest): Promise<string>`.
  - `SoloDeps.requestTunnelOpen: (req: TunnelOpenRequest) => Promise<string>`.

- [ ] **Step 1: Create the shared singleton**

Create `frontend/src/onchain/sharedTunnelOpenBatcher.ts`:

```ts
// One process-wide batcher so every game window's open coalesces into a single flush. The wallet
// deps change as the account connects, so the singleton reads them lazily from a module ref that
// the solo hook refreshes each render (mirrors the out-of-React solo-session singletons).
import {
  TunnelOpenBatcher,
  type BatcherDeps,
  type TunnelOpenRequest,
} from "./tunnelOpenBatcher";

let currentDeps: BatcherDeps | null = null;
const batcher = new TunnelOpenBatcher(() => currentDeps);

/** Refresh the wallet-bound deps the next flush will use. Call each render with the latest signer. */
export function configureSharedBatcher(deps: BatcherDeps | null): void {
  currentDeps = deps;
}

/** Enroll a tunnel open in the shared coalescing flush. */
export function requestTunnelOpen(req: TunnelOpenRequest): Promise<string> {
  return batcher.request(req);
}
```

- [ ] **Step 2: Add `requestTunnelOpen` to `SoloDeps`**

In `frontend/src/games/_shared/soloSessionHook.ts`, add to the `SoloDeps` interface (after `ensureStakeBalance`, ~line 170):

```ts
  /** ADR-0014: enroll the open/fund in the shared coalescing batcher (one PTB per connect). */
  requestTunnelOpen: (req: TunnelOpenRequest) => Promise<string>;
```

And add the import near the other onchain imports (~line 36):

```ts
import { configureSharedBatcher, requestTunnelOpen } from "../../onchain/sharedTunnelOpenBatcher";
import type { TunnelOpenRequest } from "../../onchain/tunnelOpenBatcher";
```

- [ ] **Step 3: Route `start()`'s open phase through the batcher**

In `start()`, REPLACE the block from `if (this.spec.usesAddressBalance && ...)` through the end of the `withSponsorFallback(...)` open (i.e. the current `const tunnelId = isMtpsConfigured ? ... : withSponsorFallback(...)`, ~line 524-569) with:

```ts
        const tunnelId = await deps.requestTunnelOpen({
          partyA,
          partyB,
          aAmount: fundedPerSeat,
          bAmount: fundedPerSeat,
          coinType: isMtpsConfigured ? MTPS_COIN_TYPE : undefined,
          usesAddressBalance: this.spec.usesAddressBalance,
        });
```

The `const reads = ...` line just above stays (still used by `readCreatedAt` at ~line 570). The funding-mode branching now lives in the batcher (single source of truth), so the local `isMtpsConfigured ? ... : withSponsorFallback(...)` logic is removed here.

- [ ] **Step 4: Wire deps in the hook**

In the deps builder (`useSoloSession`, ~line 781-795), after the `session.deps = { ... }` assignment, configure the shared batcher and add `requestTunnelOpen` to the deps object. Change the deps object to include:

```ts
      ensureStakeBalance: sponsored.ensureStakeBalance,
      requestTunnelOpen,
    };
    configureSharedBatcher({
      reads: client as never,
      sponsoredSignExec: sponsored.signExec as never,
      signExec: (async (
        tx: Parameters<typeof signAndExecute>[0]["transaction"],
      ) => {
        const r = await signAndExecute({ transaction: tx });
        return { digest: r.digest };
      }) as never,
      ensureStakeBalance: sponsored.ensureStakeBalance,
      prepareStake: sponsored.prepareStake,
      selectStakeCoin: sponsored.selectStakeCoin,
    });
```

> The `signExec` wallet closure is identical to the one already built for `session.deps.signExec`;
> extract it to a `const walletSignExec = ...` above and use it in both places to stay DRY.

- [ ] **Step 5: Typecheck**

Run: `cd frontend && pnpm typecheck`
Expected: PASS (no type errors). If `client as never` / `as never` casts are needed to bridge the dapp-kit client to `SuiReads`/`SignExec`, mirror the existing casts already in this file.

- [ ] **Step 6: Run the existing solo/session tests + onchain tests**

Run: `cd frontend && node --import tsx --test "src/onchain/**/*.test.ts" "src/games/blackjack/*.test.ts" "src/games/bombIt/**/*.test.ts" "src/games/chickenCross/**/*.test.ts"`
Expected: PASS — no regressions in the self-play session tests (a size-1 batch reproduces the old open).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/onchain/sharedTunnelOpenBatcher.ts frontend/src/games/_shared/soloSessionHook.ts
git commit -m "feat(arena): route solo open through shared batcher"
```

---

### Task 5: Coalesce the per-window retry wave

The per-window `useSoloAutoRetry` (5 s while `error`) now calls `solo.start` → `requestTunnelOpen`, which coalesces. Confirm a near-simultaneous retry wave lands in one flush (the `flushDelayMs` debounce is what merges retries staggered by a few ms), and document the behaviour so the retry storm can't silently return.

**Files:**
- Modify: `frontend/src/lib/useSoloAutoRetry.ts` (doc comment only — behaviour is correct via coalescing)
- Test: `frontend/src/onchain/tunnelOpenBatcher.test.ts` (extend)

**Interfaces:**
- Consumes: `TunnelOpenBatcher` (Task 3).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test (retry-wave coalescing)**

Append to `frontend/src/onchain/tunnelOpenBatcher.test.ts`:

```ts
test("requests arriving within the debounce window share one flush", async () => {
  let signs = 0;
  const deps = fakeDeps({ onSign: () => (signs += 1) });
  (deps.reads as any).getTransactionBlock = async () => ({
    objectChanges: ["0xA", "0xB"].map((a) => ({
      type: "created",
      objectType: "0xpkg::tunnel::Tunnel<0x2::sui::SUI>",
      objectId: "tunnel-for-" + a,
    })),
  });
  (deps.reads as any).getObject = async (i: { id: string }) => ({
    data: { content: { fields: { party_a: { fields: { address: i.id.replace("tunnel-for-", "") } } } } },
  });
  const batcher = new TunnelOpenBatcher(() => deps, { flushDelayMs: 20, maxBatch: 16 });
  const p1 = batcher.request(req("0xA"));
  // second request 5ms later — still inside the 20ms debounce → same flush
  await new Promise((r) => setTimeout(r, 5));
  const p2 = batcher.request(req("0xB"));
  await Promise.all([p1, p2]);
  assert.equal(signs, 1, "staggered-but-close requests coalesce into one PTB");
});
```

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `cd frontend && node --import tsx --test src/onchain/tunnelOpenBatcher.test.ts`
Expected: PASS if the debounce already merges them (it should). If it FAILS (the first request flushed before the second arrived), it proves the debounce window is doing its job — keep `flushDelayMs ≥ 20` as the default safety margin in `tunnelOpenBatcher.ts` and re-run.

- [ ] **Step 3: Document the coalescing contract on the retry hook**

In `frontend/src/lib/useSoloAutoRetry.ts`, extend the doc comment (above the function) with a final paragraph:

```ts
 * Storm-safety (ADR-0014): each window's retry calls `solo.start` → the shared
 * `TunnelOpenBatcher`, whose debounce merges a near-simultaneous retry wave (all
 * windows entered "error" from the same failed batch, so their 5 s timers fire
 * within a few ms) into ONE coalesced PTB. So N windows retrying is still one
 * sponsor call per round — do NOT re-add per-window funding throttling here.
```

- [ ] **Step 4: Run tests**

Run: `cd frontend && node --import tsx --test src/onchain/tunnelOpenBatcher.test.ts`
Expected: PASS (all batcher tests incl. retry-wave coalescing).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/useSoloAutoRetry.ts frontend/src/onchain/tunnelOpenBatcher.test.ts
git commit -m "test(onchain): coalesce retry wave + document storm-safety"
```

---

### Task 6: Full gate + manual verification checklist

Prove the whole change green and capture the on-chain/manual verification the unit tests can't reach.

**Files:**
- Create: `docs/runbooks/verify-batched-tunnel-open.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the manual verification runbook.

- [ ] **Step 1: Run the full frontend gate**

Run: `cd frontend && pnpm typecheck && pnpm test && pnpm build`
Expected: all PASS. Treat any failure as a bug to root-cause (no retry-loop-green).

- [ ] **Step 2: Run prettier (repo format gate)**

Run: `cd frontend && pnpm format`
Expected: files formatted; re-stage any reformatted files.

- [ ] **Step 3: Write the manual verification runbook**

Create `docs/runbooks/verify-batched-tunnel-open.md`:

```markdown
# Verify: batched tunnel open (ADR-0014)

The unit tests prove coalescing/correlation/chunking/fallback with fakes. The
sponsor-quota fix itself is only observable against the real backend + chain.

## Pre-req
- `tunnel-manager` backend up with the gas sponsor (`POST /v1/sponsor`) configured.
- `sui_tunnel` deployed; `VITE_TUNNEL_PACKAGE_ID` (and MTPS env, if used) set.

## Steps
1. `cd frontend && pnpm dev`; open the desktop on the Games workspace (all game
   windows tiled).
2. Open DevTools → Network, filter `sponsor`.
3. Connect the wallet (the auto-start trigger).
4. **Expect: ~2 `POST /v1/sponsor` requests total** (one address-balance ensure +
   one batched open), NOT one-per-window. With > MAX_BATCH games, expect
   `ceil(N / MAX_BATCH)` open calls (see the `[tunnelOpenBatcher] … → K PTBs` log).
5. **Expect: every game window funds and starts playing**; no HTTP 422; no 5 s
   retry storm in the console.
6. Read the open tx in an explorer: one PTB creates N `Tunnel` objects, each with
   the correct distinct party-A; balances per tunnel sum to its 2·perSeat stake.

## Regression signal
If Network shows one sponsor call per window (N calls) on connect, the windows
are NOT coalescing — check that `configureSharedBatcher` runs and that all windows
share the single `sharedTunnelOpenBatcher` module instance.
```

- [ ] **Step 4: Commit**

```bash
git add docs/runbooks/verify-batched-tunnel-open.md
git commit -m "docs: runbook to verify batched tunnel open"
```

- [ ] **Step 5: Push the branch and open a PR (do NOT merge)**

```bash
git push -u origin feat/batched-tunnel-open
```

Open a PR into `dev` summarizing: the connect-time sponsor storm, the coalescing
+ PTB fix (ADR-0014), the ~10–30 → ~2 sponsor-call outcome, and the manual
verification runbook. Report the PR URL to the user; let the human merge.

---

## Self-Review

**Spec coverage:**
- Coalescing → scatter-gather → one PTB: Tasks 2–4. ✔
- `buildOpenAndFundMany` consumed as-is: Task 2. ✔
- Correlate by party-A (order unspecified): Tasks 1–2. ✔
- `requestTunnelOpen` seam replacing inline open in `start()`: Task 4. ✔
- Chunking under PTB ceiling + log (no silent cap): Task 3 (`flushGroup` console.info). ✔
- Batch atomicity → per-request fallback: Task 3 (`flushChunk` catch). ✔
- Retry storm → coalesced retry wave: Task 5. ✔
- Stake-source unification (balance / mtps-coin / sui): Task 3 (`openChunk`/`openSingle`). ✔
- ensureStakeBalance once for the summed group: Task 3 (`flushGroup`). ✔
- ADR before code: Task 0. ✔
- Scope self-play only; no Move/backend/PvP change: enforced by touched files. ✔
- Testing tiers (unit + manual e2e): Tasks 1–3, 6. ✔ (The size-1 parity is covered by the
  existing self-play tests rerun in Task 4 Step 6 rather than a new golden — the batch path and
  the single path share `buildOpenAndFundMany`, so a byte-golden would be redundant.)

**Placeholder scan:** No `TBD`/`TODO` in shipped code. The Task-3 test carries explicit
IMPLEMENTER notes about fake fidelity — these are guidance, and the load-bearing assertions
(call counts, resolution, rejection) are concrete and fake-independent.

**Type consistency:** `TunnelOpenRequest`/`BatcherDeps`/`TunnelOpenManySpec` names are identical
across Tasks 2–4. `requestTunnelOpen` signature `(req: TunnelOpenRequest) => Promise<string>` matches
in `sharedTunnelOpenBatcher.ts`, `SoloDeps`, and the `start()` call site. `openAndFundMany` returns
`Map<string,string>` consumed as such in `flushChunk`.
```
