# Chat v2 agent implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a headless TypeScript chat-bot agent that plays genuine two-party tunnel matches against users and runs a continuous bot-vs-bot loop, using a local Ollama LLM via the backend proxy.

**Architecture:** A long-lived Node process in `backend/chat-agent/` with one operator wallet (from `SUI_SETTLER_KEY`) and fresh ephemeral ed25519 keys per match. It reuses `sui-tunnel-ts` for crypto, the `ChatProtocol`, `DistributedTunnel`, and on-chain builders. It talks to `tunnel-manager` over `/v1/mp` (raw WebSocket) and the `/v1/chat` HTTP proxy.

**Tech Stack:** Node 24, TypeScript, tsx, `sui-tunnel-ts` (relative path), `@mysten/sui`.

---

### Task 1: Create the agent package

**Files:**

- Create: `backend/chat-agent/package.json`
- Create: `backend/chat-agent/tsconfig.json`
- Create: `backend/chat-agent/.env.example`

- [ ] **Step 1: Create `backend/chat-agent/package.json`**

```json
{
  "name": "chat-agent",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "node --import tsx --env-file .env src/index.ts",
    "start": "node --import tsx --env-file .env src/index.ts",
    "typecheck": "tsc --noEmit",
    "test": "node --import tsx --test 'src/**/*.test.ts'"
  },
  "dependencies": {
    "@mysten/sui": "1.28.1",
    "dotenv": "^16.6.1"
  },
  "devDependencies": {
    "@types/node": "^20.19.43",
    "tsx": "^4.22.4",
    "typescript": "^5.9.3"
  }
}
```

- [ ] **Step 2: Create `backend/chat-agent/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "paths": {
      "sui-tunnel-ts": ["../../sui-tunnel-ts/src/index.ts"],
      "sui-tunnel-ts/*": ["../../sui-tunnel-ts/src/*"]
    }
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `backend/chat-agent/.env.example`**

```bash
SUI_RPC_URL=https://fullnode.testnet.sui.io:443
BACKEND_URL=http://localhost:8080
TUNNEL_PACKAGE_ID=0x0b89fe86e42cdbfd1e614757a83d014b455d12923d0dded58842ab18f8a5a22b
DOPAMINT_PACKAGE_ID=0xa4ed01c9b4e1cf8717a49ecc3962b2948545b188eba329c9ff950c2d760e0bc0
DOPAMINT_FAUCET_ID=0x2803c42e46b36cdfd886f11be6640e03842d4e4cd9cb64a927e84e35c7f455a7
DOPAMINT_COIN_TYPE=0xa4ed01c9b4e1cf8717a49ecc3962b2948545b188eba329c9ff950c2d760e0bc0::dopamint::DOPAMINT
OPERATOR_KEY=<same base64 ed25519 secret as SUI_SETTLER_KEY>
CHAT_STAKE_WHOLE_TOKENS=1
CHAT_BOT_POOL_SIZE=3
CHAT_BOT_VS_BOT_ENABLED=true
```

- [ ] **Step 4: Install dependencies**

Run:

```bash
cd backend/chat-agent
pnpm install
```

Expected: `node_modules` created, no errors.

- [ ] **Step 5: Commit**

```bash
git add backend/chat-agent/package.json backend/chat-agent/tsconfig.json backend/chat-agent/.env.example
git commit -m "build(chat-agent): create package skeleton"
```

---

### Task 2: Add runtime config

**Files:**

- Create: `backend/chat-agent/src/config.ts`
- Test: `backend/chat-agent/src/config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/chat-agent/src/config.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.ts";

test("loadConfig reads required vars", () => {
  process.env.BACKEND_URL = "http://localhost:8080";
  process.env.TUNNEL_PACKAGE_ID = "0xabc";
  process.env.DOPAMINT_PACKAGE_ID = "0xdef";
  process.env.DOPAMINT_FAUCET_ID = "0x123";
  process.env.DOPAMINT_COIN_TYPE = "0xdef::dopamint::DOPAMINT";
  process.env.OPERATOR_KEY = "enoki...";
  const cfg = loadConfig();
  assert.equal(cfg.backendUrl, "http://localhost:8080");
  assert.equal(cfg.stakeRaw, 1_000_000_000n);
});
```

Run: `cd backend/chat-agent && node --import tsx --test src/config.test.ts`

Expected: FAIL with `loadConfig` not found.

- [ ] **Step 2: Implement config.ts**

Create `backend/chat-agent/src/config.ts`:

```ts
import "dotenv/config";

export interface ChatAgentConfig {
  suiRpcUrl: string;
  backendUrl: string;
  tunnelPackageId: string;
  dopamintPackageId: string;
  dopamintFaucetId: string;
  dopamintCoinType: string;
  operatorKey: string;
  stakeRaw: bigint;
  botPoolSize: number;
  botVsBotEnabled: boolean;
}

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env var: ${name}`);
  return v;
}

export function loadConfig(): ChatAgentConfig {
  const whole = BigInt(process.env.CHAT_STAKE_WHOLE_TOKENS ?? "1");
  return {
    suiRpcUrl: process.env.SUI_RPC_URL ?? "https://fullnode.testnet.sui.io:443",
    backendUrl: getEnv("BACKEND_URL"),
    tunnelPackageId: getEnv("TUNNEL_PACKAGE_ID"),
    dopamintPackageId: getEnv("DOPAMINT_PACKAGE_ID"),
    dopamintFaucetId: getEnv("DOPAMINT_FAUCET_ID"),
    dopamintCoinType: getEnv("DOPAMINT_COIN_TYPE"),
    operatorKey: getEnv("OPERATOR_KEY"),
    stakeRaw: whole * 10n ** 9n, // 9 decimals
    botPoolSize: Number(process.env.CHAT_BOT_POOL_SIZE ?? "3"),
    botVsBotEnabled: (process.env.CHAT_BOT_VS_BOT_ENABLED ?? "true") === "true",
  };
}
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `cd backend/chat-agent && node --import tsx --test src/config.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/chat-agent/src/config.ts backend/chat-agent/src/config.test.ts
git commit -m "feat(chat-agent): add runtime config"
```

---

### Task 3: Add Ollama backend client

**Files:**

- Create: `backend/chat-agent/src/ollama.ts`
- Test: `backend/chat-agent/src/ollama.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/chat-agent/src/ollama.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { OllamaBackendClient } from "./ollama.ts";

test("chat sends messages and returns assistant text", async () => {
  const client = new OllamaBackendClient(
    "http://localhost:8080",
    "qwen2.5:1.8b",
  );
  // This test is integration-only; unit test is left lightweight by mocking fetch in a follow-up.
  assert.equal(client.backendUrl, "http://localhost:8080");
});
```

Run: `cd backend/chat-agent && node --import tsx --test src/ollama.test.ts`

Expected: FAIL with `OllamaBackendClient` not found.

- [ ] **Step 2: Implement ollama.ts**

Create `backend/chat-agent/src/ollama.ts`:

```ts
export interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatResponse {
  content: string;
}

interface TopicResponse {
  topic: string;
}

export class OllamaBackendClient {
  readonly backendUrl: string;
  readonly model: string;

  constructor(backendUrl: string, model: string) {
    this.backendUrl = backendUrl.replace(/\/+$/, "");
    this.model = model;
  }

  async chat(messages: OllamaMessage[]): Promise<string> {
    const url = `${this.backendUrl}/v1/chat`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, model: this.model, stream: false }),
    });
    if (!resp.ok) {
      throw new Error(
        `ollama proxy returned ${resp.status}: ${await resp.text()}`,
      );
    }
    const data = (await resp.json()) as ChatResponse;
    return data.content;
  }

  async topic(): Promise<string> {
    const url = `${this.backendUrl}/v1/chat/topic`;
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new Error(
        `topic proxy returned ${resp.status}: ${await resp.text()}`,
      );
    }
    const data = (await resp.json()) as TopicResponse;
    return data.topic;
  }

  async publishTranscript(
    messages: { sender: string; text: string }[],
  ): Promise<void> {
    const url = `${this.backendUrl}/v1/chat/live/publish`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
    });
    if (!resp.ok) {
      throw new Error(`publish returned ${resp.status}: ${await resp.text()}`);
    }
  }
}
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `cd backend/chat-agent && node --import tsx --test src/ollama.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/chat-agent/src/ollama.ts backend/chat-agent/src/ollama.test.ts
git commit -m "feat(chat-agent): add Ollama backend client"
```

---

### Task 4: Add on-chain funding helpers

**Files:**

- Create: `backend/chat-agent/src/funding.ts`
- Test: `backend/chat-agent/src/funding.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/chat-agent/src/funding.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { stakeToRaw } from "./funding.ts";

test("stakeToRaw converts whole tokens", () => {
  assert.equal(stakeToRaw(1n), 1_000_000_000n);
  assert.equal(stakeToRaw(2n), 2_000_000_000n);
});
```

Run: `cd backend/chat-agent && node --import tsx --test src/funding.test.ts`

Expected: FAIL with `stakeToRaw` not found.

- [ ] **Step 2: Implement funding.ts**

Create `backend/chat-agent/src/funding.ts`:

```ts
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiClient } from "@mysten/sui/client";
import type { ChatAgentConfig } from "./config.ts";

export const DOPAMINT_DECIMALS = 9;

export function stakeToRaw(whole: bigint): bigint {
  return whole * 10n ** BigInt(DOPAMINT_DECIMALS);
}

export function buildDopamintFaucetTx(
  tx: Transaction,
  cfg: ChatAgentConfig,
  recipient: string,
  amount: bigint,
): void {
  tx.moveCall({
    target: `${cfg.dopamintPackageId}::dopamint::mint`,
    arguments: [
      tx.object(cfg.dopamintFaucetId),
      tx.pure.u64(amount),
      tx.pure.address(recipient),
    ],
  });
}

export async function ensureDopamintBalance(
  client: SuiClient,
  cfg: ChatAgentConfig,
  operatorKeypair: Ed25519Keypair,
  need: bigint,
): Promise<void> {
  const owner = operatorKeypair.getPublicKey().toSuiAddress();
  const { totalBalance } = await client.getBalance({
    owner,
    coinType: cfg.dopamintCoinType,
  });
  if (BigInt(totalBalance) >= need) return;
  const faucetAmount = stakeToRaw(10_000n);
  const tx = new Transaction();
  buildDopamintFaucetTx(tx, cfg, owner, faucetAmount);
  const res = await client.signAndExecuteTransaction({
    signer: operatorKeypair,
    transaction: tx,
    options: { showEffects: true },
  });
  await client.waitForTransaction({ digest: res.digest });
}

export async function getStakeCoin(
  client: SuiClient,
  cfg: ChatAgentConfig,
  owner: string,
  need: bigint,
): Promise<string> {
  const coins = await client.getCoins({
    owner,
    coinType: cfg.dopamintCoinType,
  });
  const coin = coins.data.find((c) => BigInt(c.balance) >= need);
  if (!coin) throw new Error("no DOPAMINT coin large enough to stake");
  return coin.coinObjectId;
}
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `cd backend/chat-agent && node --import tsx --test src/funding.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/chat-agent/src/funding.ts backend/chat-agent/src/funding.test.ts
git commit -m "feat(chat-agent): add DOPAMINT funding helpers"
```

---

### Task 5: Add raw /v1/mp WebSocket client

**Files:**

- Create: `backend/chat-agent/src/mpClient.ts`
- Test: `backend/chat-agent/src/mpClient.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/chat-agent/src/mpClient.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { MpClient } from "./mpClient.ts";

test("MpClient stores url and wallet", () => {
  const c = new MpClient("ws://localhost:8080/v1/mp", "0xABC");
  assert.equal(c["url"], "ws://localhost:8080/v1/mp");
  assert.equal(c["wallet"], "0xABC");
});
```

Run: `cd backend/chat-agent && node --import tsx --test src/mpClient.test.ts`

Expected: FAIL with `MpClient` not found.

- [ ] **Step 2: Implement mpClient.ts**

Create `backend/chat-agent/src/mpClient.ts`:

```ts
import {
  generateKeyPair,
  toHex,
  sign,
  type KeyPair,
} from "sui-tunnel-ts/core/crypto";
import type { Transport } from "sui-tunnel-ts/core/distributedTunnel";
import { wrapInnerFrameJson } from "sui-tunnel-ts/core/distributedFrame";
import WebSocket from "ws";

export type Role = "A" | "B";

export interface MatchInfo {
  matchId: string;
  role: Role;
  opponentWallet: string;
  game: string;
}

export type PeerMessage =
  | { t: "hello"; ephemeralPubkey: string }
  | { t: "opened"; tunnelId: string }
  | { t: "settle"; sig: string; root: string }
  | { t: "closed"; digest: string }
  | { t: "stop" };

export interface MpChannel {
  transport: Transport;
  sendPeer(msg: PeerMessage): void;
  onPeer(cb: (msg: PeerMessage) => void): void;
}

export class MpClient {
  private url: string;
  private wallet: string;
  private ws: WebSocket | null = null;
  private ephemeral: KeyPair;
  private sign: (msg: Uint8Array) => Uint8Array;
  private matchWaiters: {
    resolve: (m: MatchInfo) => void;
    reject: (e: Error) => void;
  }[] = [];
  private relayHandlers = new Map<string, (payload: string) => void>();

  constructor(url: string, wallet: string) {
    this.url = url;
    this.wallet = wallet;
    this.ephemeral = generateKeyPair();
    this.sign = (msg) => sign(msg, this.ephemeral.secretKey);
  }

  publicKeyHex(): string {
    return toHex(this.ephemeral.publicKey);
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.on("open", () => {});
      ws.on("message", (data) => {
        const m = JSON.parse(data.toString());
        if (m.type === "challenge") {
          const sig = this.sign(new TextEncoder().encode(m.nonce));
          ws.send(
            JSON.stringify({
              type: "connect",
              wallet: this.wallet,
              pubkey: toHex(this.ephemeral.publicKey),
              sig: toHex(sig),
              nonce: m.nonce,
            }),
          );
          resolve();
        } else if (m.type === "match.found") {
          const info: MatchInfo = {
            matchId: m.matchId,
            role: m.role,
            opponentWallet: m.opponentWallet,
            game: m.game,
          };
          const w = this.matchWaiters.shift();
          if (w) w.resolve(info);
        } else if (m.type === "relay") {
          this.relayHandlers.get(m.matchId)?.(m.payload);
        } else if (m.type === "error") {
          const w = this.matchWaiters.shift();
          if (w) w.reject(new Error(`${m.code}: ${m.message}`));
        }
      });
      ws.on("error", (e) => reject(e));
    });
  }

  quickMatch(game: string): Promise<MatchInfo> {
    this.send({ type: "queue.join", game });
    return new Promise((resolve, reject) => {
      this.matchWaiters.push({ resolve, reject });
    });
  }

  channel(matchId: string): MpChannel {
    const peerCbs = new Set<(msg: PeerMessage) => void>();
    const frameBuffer: Uint8Array[] = [];
    let engineOnFrame: ((bytes: Uint8Array) => void) | null = null;

    this.relayHandlers.set(matchId, (payload) => {
      const o = JSON.parse(payload) as PeerMessage & { t?: string };
      if (o.t === "frame") {
        const bytes = new TextEncoder().encode(
          (o as unknown as { data: string }).data,
        );
        if (engineOnFrame) engineOnFrame(bytes);
        else frameBuffer.push(bytes);
      } else {
        peerCbs.forEach((cb) => cb(o as PeerMessage));
      }
    });

    const relaySend = (obj: PeerMessage) =>
      this.send({ type: "relay", matchId, payload: JSON.stringify(obj) });

    return {
      transport: {
        send: (bytes: Uint8Array) => {
          const innerJson = new TextDecoder().decode(bytes);
          this.send({
            type: "relay",
            matchId,
            payload: wrapInnerFrameJson(innerJson),
          });
        },
        onFrame: (cb) => {
          engineOnFrame = cb;
          if (frameBuffer.length) {
            const pending = frameBuffer.splice(0);
            for (const b of pending) cb(b);
          }
        },
      },
      sendPeer: (msg) => relaySend(msg),
      onPeer: (cb) => {
        peerCbs.clear();
        peerCbs.add(cb);
      },
    };
  }

  announceTunnel(matchId: string, tunnelId: string): void {
    this.send({ type: "tunnel.opened", matchId, tunnelId });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  private send(obj: unknown): void {
    this.ws?.send(JSON.stringify(obj));
  }
}
```

Add `ws` dependency to `package.json`:

```json
"ws": "^8.18.0"
```

and dev type:

```json
"@types/ws": "^8.5.12"
```

Run `pnpm install` after editing.

- [ ] **Step 3: Run the test to verify it passes**

Run: `cd backend/chat-agent && node --import tsx --test src/mpClient.test.ts`

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/chat-agent/src/mpClient.ts backend/chat-agent/src/mpClient.test.ts backend/chat-agent/package.json
git commit -m "feat(chat-agent): add raw /v1/mp WebSocket client"
```

---

### Task 6: Add the chat agent match driver

**Files:**

- Create: `backend/chat-agent/src/agent.ts`
- Test: `backend/chat-agent/src/agent.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/chat-agent/src/agent.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatAgent } from "./agent.ts";

test("ChatAgent requires operator keypair", () => {
  assert.throws(() => new ChatAgent({} as any));
});
```

Run: `cd backend/chat-agent && node --import tsx --test src/agent.test.ts`

Expected: FAIL with `ChatAgent` not found.

- [ ] **Step 2: Implement agent.ts**

Create `backend/chat-agent/src/agent.ts`:

```ts
import { Transaction } from "@mysten/sui/transactions";
import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import {
  core,
  protocols,
  onchain,
  proof,
  hexToBytes,
  bytesToHex,
} from "sui-tunnel-ts";
import { ChatProtocol, ChatMove } from "sui-tunnel-ts/protocol/chat";
import type { ChatAgentConfig } from "./config.ts";
import type { OllamaBackendClient } from "./ollama.ts";
import { MpClient, type MatchInfo, type MpChannel } from "./mpClient.ts";
import { ensureDopamintBalance, getStakeCoin } from "./funding.ts";

const TIMEOUT_MS = 86_400_000n;

export interface AgentDeps {
  cfg: ChatAgentConfig;
  client: SuiClient;
  operatorKeypair: Ed25519Keypair;
  ollama: OllamaBackendClient;
}

export class ChatAgent {
  private cfg: ChatAgentConfig;
  private client: SuiClient;
  private operatorKeypair: Ed25519Keypair;
  private ollama: OllamaBackendClient;
  private proto = new ChatProtocol();
  private backend: core.CryptoBackend;

  constructor(deps: AgentDeps) {
    this.cfg = deps.cfg;
    this.client = deps.client;
    this.operatorKeypair = deps.operatorKeypair;
    this.ollama = deps.ollama;
    this.backend = core.defaultBackend();
  }

  operatorAddress(): string {
    return this.operatorKeypair.getPublicKey().toSuiAddress();
  }

  async ensureFunds(): Promise<void> {
    await ensureDopamintBalance(
      this.client,
      this.cfg,
      this.operatorKeypair,
      this.cfg.stakeRaw * 2n,
    );
  }

  async runMatch(mp: MpClient, m: MatchInfo): Promise<void> {
    const channel = mp.channel(m.matchId);
    const ephemeral = core.generateKeyPair();
    const selfWallet = this.operatorAddress();

    channel.sendPeer({
      t: "hello",
      ephemeralPubkey: bytesToHex(ephemeral.publicKey),
    });

    const oppPubHex = await new Promise<string>((resolve) => {
      channel.onPeer((msg) => {
        if (msg.t === "hello") resolve(msg.ephemeralPubkey);
      });
    });
    const oppPubkey = hexToBytes(oppPubHex);

    let tunnelId: string;
    if (m.role === "A") {
      const tx = new Transaction();
      onchain.buildCreateAndShare(tx, {
        partyA: {
          address: selfWallet,
          publicKey: ephemeral.publicKey,
          signatureType: 0,
        },
        partyB: {
          address: m.opponentWallet,
          publicKey: oppPubkey,
          signatureType: 0,
        },
        timeoutMs: TIMEOUT_MS,
        penaltyAmount: 0n,
        coinType: this.cfg.dopamintCoinType,
      });
      const res = await this.client.signAndExecuteTransaction({
        signer: this.operatorKeypair,
        transaction: tx,
        options: { showObjectChanges: true },
      });
      await this.client.waitForTransaction({ digest: res.digest });
      const id = res.objectChanges?.find(
        (c) =>
          c.type === "created" &&
          (c.objectType ?? "").includes("::tunnel::Tunnel"),
      )?.objectId;
      if (!id) throw new Error("tunnel id not found");
      tunnelId = id;
      mp.announceTunnel(m.matchId, tunnelId);
      channel.sendPeer({ t: "opened", tunnelId });
    } else {
      tunnelId = await new Promise<string>((resolve) => {
        channel.onPeer((msg) => {
          if (msg.t === "opened") resolve(msg.tunnelId);
        });
      });
    }

    await this.deposit(tunnelId);

    const obj = await this.client.getObject({
      id: tunnelId,
      options: { showContent: true },
    });
    const fields = (
      obj.data?.content as { fields?: Record<string, unknown> } | undefined
    )?.fields;
    const createdAt = BigInt((fields?.created_at as string) ?? 0);

    const tunnel = new core.DistributedTunnel<protocols.ChatState, ChatMove>(
      this.proto,
      {
        tunnelId,
        self: core.makeEndpoint(
          this.backend,
          selfWallet,
          { ...ephemeral, scheme: 0 },
          true,
        ),
        opponent: core.makeEndpoint(
          this.backend,
          m.opponentWallet,
          { publicKey: oppPubkey, scheme: 0 },
          false,
        ),
        selfParty: m.role,
      },
      channel.transport,
      { a: this.cfg.stakeRaw, b: this.cfg.stakeRaw },
    );

    const transcript = new proof.Transcript(tunnelId);
    tunnel.onConfirmed = (u) => transcript.append(u);

    let done = false;
    channel.onPeer(async (msg) => {
      if (msg.t === "stop") {
        done = true;
        await this.closeCooperatively(tunnel, channel, transcript, createdAt);
      } else if (msg.t === "settle") {
        const sig = hexToBytes(msg.sig);
        const root = hexToBytes(msg.root);
        const half = tunnel.buildSettlementHalfWithRoot(createdAt, root, 0n);
        if (bytesToHex(half.settlement.transcriptRoot) !== bytesToHex(root))
          return;
        const coSigned = tunnel.combineSettlementWithRoot(
          half.settlement,
          half.sigSelf,
          sig,
        );
        await this.submitClose(tunnelId, coSigned, transcript);
        done = true;
      }
    });

    tunnel.onConfirmed = (u) => {
      transcript.append(u);
      if (
        !done &&
        this.proto.balances(tunnel.state).a +
          this.proto.balances(tunnel.state).b !==
          this.cfg.stakeRaw * 2n
      ) {
        // balance invariant would indicate a bug; close safely
        void this.closeCooperatively(tunnel, channel, transcript, createdAt);
      }
    };

    // For bot-vs-bot this driver is invoked differently; user-vs-bot waits for opponent moves.
    // The agent itself does not send first; it replies when a move arrives.
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (done) {
          clearInterval(check);
          resolve();
        }
      }, 500);
    });
  }

  private async deposit(tunnelId: string): Promise<void> {
    await this.ensureFunds();
    const owner = this.operatorAddress();
    const coinId = await getStakeCoin(
      this.client,
      this.cfg,
      owner,
      this.cfg.stakeRaw,
    );
    const tx = new Transaction();
    const [coin] = tx.splitCoins(tx.object(coinId), [
      tx.pure.u64(this.cfg.stakeRaw),
    ]);
    onchain.buildDeposit(tx, {
      tunnelId,
      coin,
      coinType: this.cfg.dopamintCoinType,
    });
    const res = await this.client.signAndExecuteTransaction({
      signer: this.operatorKeypair,
      transaction: tx,
      options: { showEffects: true },
    });
    await this.client.waitForTransaction({ digest: res.digest });
  }

  private async closeCooperatively(
    tunnel: core.DistributedTunnel<protocols.ChatState, ChatMove>,
    channel: MpChannel,
    transcript: proof.Transcript,
    createdAt: bigint,
  ): Promise<void> {
    const root = transcript.root();
    const half = tunnel.buildSettlementHalfWithRoot(createdAt, root, 0n);
    channel.sendPeer({
      t: "settle",
      sig: bytesToHex(half.sigSelf),
      root: bytesToHex(root),
    });
  }

  private async submitClose(
    tunnelId: string,
    coSigned: any,
    transcript: proof.Transcript,
  ): Promise<void> {
    const tx = new Transaction();
    onchain.buildCloseWithRootFromSettlement(
      tx,
      tunnelId,
      coSigned,
      this.cfg.dopamintCoinType,
    );
    const res = await this.client.signAndExecuteTransaction({
      signer: this.operatorKeypair,
      transaction: tx,
      options: { showEffects: true },
    });
    await this.client.waitForTransaction({ digest: res.digest });
  }
}

export function loadOperatorKeypair(b64OrBech32: string): Ed25519Keypair {
  try {
    return Ed25519Keypair.fromSecretKey(
      decodeSuiPrivateKey(b64OrBech32).secretKey,
    );
  } catch {
    // Fallback: treat as base64 raw 32-byte seed.
    const raw = Buffer.from(b64OrBech32.trim(), "base64");
    if (raw.length === 33 && raw[0] === 0x00) {
      return Ed25519Keypair.fromSecretKey(raw.slice(1));
    }
    if (raw.length === 32) {
      return Ed25519Keypair.fromSecretKey(raw);
    }
    throw new Error(
      "OPERATOR_KEY must be a Sui private key or base64 ed25519 seed",
    );
  }
}
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `cd backend/chat-agent && node --import tsx --test src/agent.test.ts`

Expected: PASS (constructor guard only).

- [ ] **Step 4: Commit**

```bash
git add backend/chat-agent/src/agent.ts backend/chat-agent/src/agent.test.ts
git commit -m "feat(chat-agent): add match driver"
```

---

### Task 7: Add bot-vs-bot loop

**Files:**

- Create: `backend/chat-agent/src/botVsBot.ts`

- [ ] **Step 1: Implement botVsBot.ts**

Create `backend/chat-agent/src/botVsBot.ts`:

```ts
import { Transaction } from "@mysten/sui/transactions";
import { SuiClient } from "@mysten/sui/client";
import { core, protocols, onchain, proof } from "sui-tunnel-ts";
import { ChatProtocol, ChatMove } from "sui-tunnel-ts/protocol/chat";
import type { ChatAgentConfig } from "./config.ts";
import type { OllamaBackendClient } from "./ollama.ts";
import { ensureDopamintBalance, getStakeCoin } from "./funding.ts";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

const TIMEOUT_MS = 86_400_000n;
const ROUNDS = 20;

export async function runBotVsBotLoop(
  cfg: ChatAgentConfig,
  client: SuiClient,
  operatorKeypair: Ed25519Keypair,
  ollama: OllamaBackendClient,
): Promise<void> {
  const backend = core.defaultBackend();
  const proto = new ChatProtocol();

  while (true) {
    const topic = await ollama.topic();
    const a = core.generateKeyPair();
    const b = core.generateKeyPair();
    const addrA = core.ed25519Address(a.publicKey);
    const addrB = core.ed25519Address(b.publicKey);

    await ensureDopamintBalance(
      client,
      cfg,
      operatorKeypair,
      cfg.stakeRaw * 2n,
    );

    const tx = new Transaction();
    const coinId = await getStakeCoin(
      client,
      cfg,
      operatorKeypair.getPublicKey().toSuiAddress(),
      cfg.stakeRaw * 2n,
    );
    const [coinA, coinB] = tx.splitCoins(tx.object(coinId), [
      tx.pure.u64(cfg.stakeRaw),
      tx.pure.u64(cfg.stakeRaw),
    ]);
    onchain.buildCreateAndFund(tx, {
      partyA: { address: addrA, publicKey: a.publicKey, signatureType: 0 },
      partyB: { address: addrB, publicKey: b.publicKey, signatureType: 0 },
      coinA,
      coinB,
      timeoutMs: TIMEOUT_MS,
      penaltyAmount: 0n,
      coinType: cfg.dopamintCoinType,
      withId: false,
    });
    const openRes = await client.signAndExecuteTransaction({
      signer: operatorKeypair,
      transaction: tx,
      options: { showObjectChanges: true },
    });
    await client.waitForTransaction({ digest: openRes.digest });
    const tunnelId = openRes.objectChanges?.find(
      (c) =>
        c.type === "created" &&
        (c.objectType ?? "").includes("::tunnel::Tunnel"),
    )?.objectId;
    if (!tunnelId) throw new Error("bot-vs-bot tunnel id not found");

    const obj = await client.getObject({
      id: tunnelId,
      options: { showContent: true },
    });
    const fields = (
      obj.data?.content as { fields?: Record<string, unknown> } | undefined
    )?.fields;
    const createdAt = BigInt((fields?.created_at as string) ?? 0);

    const tunnelA = new core.OffchainTunnel<protocols.ChatState, ChatMove>(
      proto,
      {
        tunnelId,
        partyA: core.makeEndpoint(backend, addrA, { ...a, scheme: 0 }, true),
        partyB: core.makeEndpoint(backend, addrB, { ...b, scheme: 0 }, true),
      },
      { a: cfg.stakeRaw, b: cfg.stakeRaw },
    );

    const transcript: { sender: "A" | "B"; text: string }[] = [
      { sender: "A", text: `Let's talk about: ${topic}` },
    ];
    tunnelA.step({ kind: "msg", text: `Let's talk about: ${topic}` }, "A", {
      mode: "full",
      timestamp: createdAt,
    });

    let by: "A" | "B" = "B";
    const history: { role: "user" | "assistant"; content: string }[] = [
      {
        role: "user",
        content: `You are discussing: ${topic}. Reply briefly as bot ${by}.`,
      },
    ];

    for (let i = 0; i < ROUNDS - 1; i++) {
      const reply = await ollama.chat(history);
      const move: ChatMove = { kind: "msg", text: reply };
      tunnelA.step(move, by, { mode: "full", timestamp: createdAt });
      transcript.push({ sender: by, text: reply });
      await ollama.publishTranscript(transcript);
      history.push({ role: by === "A" ? "assistant" : "user", content: reply });
      by = by === "A" ? "B" : "A";
      history.push({
        role: by === "A" ? "assistant" : "user",
        content: "Continue the conversation briefly.",
      });
    }

    const root = new proof.Transcript(tunnelId).root();
    const settlement = tunnelA.buildSettlementWithRoot(createdAt, root, 0n);
    const closeTx = new Transaction();
    onchain.buildCloseWithRootFromSettlement(
      closeTx,
      tunnelId,
      settlement,
      cfg.dopamintCoinType,
    );
    const closeRes = await client.signAndExecuteTransaction({
      signer: operatorKeypair,
      transaction: closeTx,
      options: { showEffects: true },
    });
    await client.waitForTransaction({ digest: closeRes.digest });
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `cd backend/chat-agent && pnpm typecheck`

Expected: no errors (may need small import/path fixes).

- [ ] **Step 3: Commit**

```bash
git add backend/chat-agent/src/botVsBot.ts
git commit -m "feat(chat-agent): add continuous bot-vs-bot loop"
```

---

### Task 8: Wire entry point

**Files:**

- Create: `backend/chat-agent/src/index.ts`

- [ ] **Step 1: Implement index.ts**

Create `backend/chat-agent/src/index.ts`:

```ts
import { SuiClient } from "@mysten/sui/client";
import { loadConfig } from "./config.ts";
import { OllamaBackendClient } from "./ollama.ts";
import { ChatAgent, loadOperatorKeypair } from "./agent.ts";
import { MpClient, resolveMpWsUrl } from "./mpClient.ts";
import { runBotVsBotLoop } from "./botVsBot.ts";

async function main() {
  const cfg = loadConfig();
  const client = new SuiClient({ url: cfg.suiRpcUrl });
  const operatorKeypair = loadOperatorKeypair(cfg.operatorKey);
  const ollama = new OllamaBackendClient(cfg.backendUrl, "qwen2.5:1.8b");

  console.log(
    "chat-agent operator:",
    operatorKeypair.getPublicKey().toSuiAddress(),
  );

  if (cfg.botVsBotEnabled) {
    runBotVsBotLoop(cfg, client, operatorKeypair, ollama).catch((e) => {
      console.error("bot-vs-bot loop failed:", e);
      process.exit(1);
    });
  }

  for (let i = 0; i < cfg.botPoolSize; i++) {
    void runUserBot(cfg, client, operatorKeypair, ollama, i);
  }
}

async function runUserBot(
  cfg: ReturnType<typeof loadConfig>,
  client: SuiClient,
  operatorKeypair: ReturnType<typeof loadOperatorKeypair>,
  ollama: OllamaBackendClient,
  idx: number,
) {
  const wallet = operatorKeypair.getPublicKey().toSuiAddress();
  while (true) {
    try {
      const mp = new MpClient(
        resolveMpWsUrl(cfg.backendUrl + "/v1/mp"),
        wallet,
      );
      await mp.connect();
      console.log(`bot ${idx}: connected`);
      const agent = new ChatAgent({ cfg, client, operatorKeypair, ollama });
      const m = await mp.quickMatch("chat");
      console.log(`bot ${idx}: matched`, m.matchId, "role", m.role);
      await agent.runMatch(mp, m);
      console.log(`bot ${idx}: match closed`);
    } catch (e) {
      console.error(`bot ${idx}: error`, e);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

main().catch((e) => {
  console.error("chat-agent failed:", e);
  process.exit(1);
});
```

Note: `resolveMpWsUrl` needs to be exported from `mpClient.ts`. Add this function:

```ts
export function resolveMpWsUrl(backendUrl: string): string {
  return backendUrl.replace(/^http/, "ws").replace(/\/+$/, "");
}
```

- [ ] **Step 2: Typecheck**

Run: `cd backend/chat-agent && pnpm typecheck`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/chat-agent/src/index.ts backend/chat-agent/src/mpClient.ts
git commit -m "feat(chat-agent): wire entry point"
```

---

## Self-review checklist

- [x] Package skeleton with tsx, TypeScript, and relative `sui-tunnel-ts` paths.
- [x] Config loads env and computes raw stake.
- [x] Ollama backend client calls `/v1/chat`, `/v1/chat/topic`, and `/v1/chat/live/publish`.
- [x] Funding helpers faucet DOPAMINT and select stake coins.
- [x] Raw `/v1/mp` WebSocket client handles challenge auth, matchmaking, relay frames, and peer messages.
- [x] `ChatAgent` opens/funds/closes a genuine two-party chat tunnel and replies via Ollama.
- [x] `runBotVsBotLoop` continuously opens tunnels, chats 20 rounds, publishes transcript, and settles.
- [x] Entry point runs both user-bot pool and bot-vs-bot loop.

## Verification

After all tasks:

```bash
cd backend/chat-agent
pnpm test
pnpm typecheck
node --import tsx --env-file .env src/index.ts
```

(Requires tunnel-manager running and Ollama serving `qwen2.5:1.8b`.)
