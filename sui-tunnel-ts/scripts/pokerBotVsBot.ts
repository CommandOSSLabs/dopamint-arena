/**
 * Headless bot-vs-bot Quantum Poker load driver on testnet. Mirrors `blackjackBotVsBot.ts`
 * (real on-chain create_and_fund -> off-chain self-play -> close_cooperative_with_root) but
 * adds the control-plane reporting the in-browser bot lane is too slow to sustain:
 * registerSession + periodic heartbeats so the backend's "Total Actions" / "Network TPS"
 * (GET /v1/stats/live) actually climb. Two persistent bots play many hands per tunnel and
 * loop tunnel after tunnel; the funder alternates each game so neither wallet drains.
 *
 * Run (Homebrew node + tsx):
 *   SUI_FUNDER_KEY=<suiprivkey…> node --import tsx scripts/pokerBotVsBot.ts
 *
 * Env (all optional except the key):
 *   SUI_FUNDER_KEY  funded testnet key (suiprivkey…) — seeds the two bot wallets   [required]
 *   BACKEND_URL     control-plane base URL                  [default: live dev ALB]
 *   GAMES           tunnels to play, 0 = run forever                    [default: 0]
 *   HAND_CAP        hands per tunnel (more = more actions per on-chain tx) [default: 2000]
 *   STAKE           per-seat locked stake, MIST                       [default: 1000]
 *   FUND_BOT_SUI    total SUI seeded across the two bots              [default: 0.3]
 *   HEARTBEAT_EVERY actions per heartbeat flush                        [default: 200]
 *   GAME_ID         stats bucket name                       [default: quantum_poker]
 */
import { core, createSuiClient, onchain } from "../src/index.ts";
import { buildOpenAndFundMany } from "../src/onchain/createAndFund.ts";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  createPokerAutoGame,
  type PokerGameAdapters,
} from "../src/protocol/pokerGameController.ts";
import type { CoSignedSettlementWithRoot } from "../src/core/tunnel.ts";

const PACKAGE_ID =
  "0x0b89fe86e42cdbfd1e614757a83d014b455d12923d0dded58842ab18f8a5a22b";
process.env.PACKAGE_ID ??= PACKAGE_ID;

const BACKEND_URL = (
  process.env.BACKEND_URL ??
  "http://dopamint-dev-alb-0fac7e0-1152788681.us-east-1.elb.amazonaws.com"
).replace(/\/$/, "");
const GAMES = Number(process.env.GAMES ?? "0"); // 0 = forever (total across all workers)
const CONCURRENCY = Number(process.env.CONCURRENCY ?? "4"); // parallel tunnels (one bot pair each)
// ~180 hands keeps the full transcript under the backend's 2MB body limit so /settle accepts it
// and the settler sponsors the close gas (above ~200 it 413s → bot-keypair fallback).
const HAND_CAP = BigInt(process.env.HAND_CAP ?? "180");
// Per-SEAT stake (MIST). Default 0.05 SUI/seat = 0.1 SUI/tunnel (the top-up model: 0.1 split
// evenly). It is play money funded into the tunnel and returned at close, NOT gas.
const STAKE = BigInt(process.env.STAKE_MIST ?? String(50_000_000));
// Gas budget per worker, split across its two bots. With /settle sponsoring the CLOSE, the bots
// pay only OPEN gas; the funder alternates so the 0.05-SUI/seat stake nets ~zero between them.
const FUND_PER_WORKER_MIST = Math.round(
  Number(process.env.FUND_PER_WORKER_SUI ?? "0.5") * 1e9
);
const HEARTBEAT_EVERY = Number(process.env.HEARTBEAT_EVERY ?? "200");
const GAME_ID = process.env.GAME_ID ?? "quantum_poker";
// Persistent bot seeds (gitignored). Bots are reused across runs — fund once, recycle forever —
// exactly like Blackjack's localStorage bots, just file-backed for Node. Seeds are low value
// (gas + tiny stakes) but must not be committed.
const BOTS_FILE = process.env.POKER_BOTS_FILE ?? ".poker-bots.json";

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const fromHex = (h: string) => new Uint8Array(Buffer.from(h, "hex"));

function botFromSeed(seed: Uint8Array) {
  const k = core.keyPairFromSecret(seed);
  const keypair = Ed25519Keypair.fromSecretKey(seed);
  if (toHex(keypair.getPublicKey().toRawBytes()) !== toHex(k.publicKey))
    throw new Error("off/on-chain pubkey mismatch");
  return {
    coreKey: k,
    keypair,
    address: keypair.getPublicKey().toSuiAddress(),
    publicKey: k.publicKey,
  };
}

type Bot = ReturnType<typeof botFromSeed>;

/** Load `n` persistent bot PAIRS from BOTS_FILE, generating + saving any that don't exist yet.
 *  Reused across runs (fund once, recycle), mirroring Blackjack's localStorage bots. */
function loadOrCreateBots(n: number): Array<{ a: Bot; b: Bot }> {
  let seeds: Array<{ a: string; b: string }> = [];
  if (existsSync(BOTS_FILE)) {
    try {
      seeds = JSON.parse(readFileSync(BOTS_FILE, "utf8")).pairs ?? [];
    } catch {
      seeds = [];
    }
  }
  let changed = false;
  while (seeds.length < n) {
    seeds.push({
      a: toHex(core.generateKeyPair().secretKey),
      b: toHex(core.generateKeyPair().secretKey),
    });
    changed = true;
  }
  if (changed)
    writeFileSync(BOTS_FILE, JSON.stringify({ pairs: seeds }, null, 2));
  return seeds
    .slice(0, n)
    .map((p) => ({
      a: botFromSeed(fromHex(p.a)),
      b: botFromSeed(fromHex(p.b)),
    }));
}

/** Register a stats session for one tunnel; returns the bearer needed for heartbeats. */
async function registerSession(
  tunnelId: string,
  a: string,
  b: string
): Promise<{ sessionId: string; statsToken: string } | null> {
  try {
    const res = await fetch(`${BACKEND_URL}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userAddress: a,
        game: GAME_ID,
        tunnels: [{ tunnelId, partyA: a, partyB: b }],
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as { sessionId: string; statsToken: string };
  } catch (e) {
    console.warn("[stats] registerSession failed (continuing):", String(e));
    return null;
  }
}

/** Report `actionsDelta` off-chain actions for the session — this is what moves Total Actions/TPS. */
async function heartbeat(
  sess: { sessionId: string; statsToken: string } | null,
  tunnelId: string,
  nonce: bigint,
  actionsDelta: number,
  windowMs: number
): Promise<void> {
  if (!sess || actionsDelta <= 0) return;
  try {
    await fetch(`${BACKEND_URL}/v1/sessions/${sess.sessionId}/heartbeat`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${sess.statsToken}`,
      },
      body: JSON.stringify({
        tunnelId,
        nonce: String(nonce),
        actionsDelta,
        windowMs,
      }),
    });
  } catch (e) {
    console.warn("[stats] heartbeat failed (continuing):", String(e));
  }
}

/** POST /settle: the settler dry-runs + submits close_cooperative_with_root and SPONSORS the gas
 *  (ADR-0007). Body mirrors the frontend's coSignedToSettleRequest — u64 -> decimal string,
 *  32-byte -> lowercase hex (no 0x). Throws on non-2xx so the caller can fall back. */
async function settleViaBackend(
  tunnelId: string,
  co: CoSignedSettlementWithRoot,
  transcriptEntries: Array<{
    nonce: string;
    message: string;
    sigA: string;
    sigB: string;
  }>
): Promise<void> {
  const s = co.settlement;
  const body = {
    settlement: {
      tunnelId: s.tunnelId,
      partyABalance: s.partyABalance.toString(),
      partyBBalance: s.partyBBalance.toString(),
      finalNonce: s.finalNonce.toString(),
      timestamp: s.timestamp.toString(),
      transcriptRoot: toHex(s.transcriptRoot),
    },
    sigA: toHex(co.sigA),
    sigB: toHex(co.sigB),
    transcript: transcriptEntries,
  };
  const res = await fetch(`${BACKEND_URL}/v1/tunnels/${tunnelId}/settle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok)
    throw new Error(
      `settle HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`
    );
}

async function fundBot(
  client: ReturnType<typeof createSuiClient>,
  funder: Ed25519Keypair,
  to: string,
  mist: number
) {
  const tx = new Transaction();
  const [c] = tx.splitCoins(tx.gas, [mist]);
  tx.transferObjects([c], to);
  const r = await client.signAndExecuteTransaction({
    signer: funder,
    transaction: tx,
    options: { showEffects: true },
  });
  await client.waitForTransaction({ digest: r.digest });
}

/** One tunnel: open on-chain, play HAND_CAP hands off-chain (heartbeating throughout), close.
 *  All on-chain/network glue is wired into the framework-agnostic poker controller as adapters;
 *  this function only supplies the testnet-specific implementations (Sui client + /settle fetch). */
async function playTunnel(
  client: ReturnType<typeof createSuiClient>,
  funder: Bot,
  botA: Bot,
  botB: Bot,
  onActions: (n: number) => void
): Promise<{ actions: number; hands: number }> {
  // Stats reporting is per-tunnel: registerSession returns the bearer the heartbeats need, and the
  // heartbeat window is time-based, so we track the session + beat clock across reportActions calls.
  let sess: { sessionId: string; statsToken: string } | null = null;
  let beatStart = Date.now();

  const adapters: PokerGameAdapters = {
    async open(spec) {
      // open + fund both seats in ONE PTB, signed by the alternating funder.
      const openTx = new Transaction();
      buildOpenAndFundMany(openTx, [
        {
          partyA: spec.partyA,
          partyB: spec.partyB,
          aAmount: spec.aAmount,
          bAmount: spec.bAmount,
          timeoutMs: 86_400_000n,
          penaltyAmount: 0n,
        },
      ]);
      const openRes = await client.signAndExecuteTransaction({
        signer: funder.keypair,
        transaction: openTx,
        options: { showObjectChanges: true, showEffects: true },
      });
      if (openRes.effects?.status?.status !== "success")
        throw new Error(
          `create_and_fund failed: ${
            openRes.effects?.status?.error ?? "unknown"
          }`
        );
      await client.waitForTransaction({ digest: openRes.digest });
      const tunnelId = onchain.parseTunnelId(openRes.objectChanges);
      if (!tunnelId) throw new Error("could not find created Tunnel id");

      const obj = await client.getObject({
        id: tunnelId,
        options: { showContent: true },
      });
      const fields = (
        obj.data?.content as { fields?: Record<string, unknown> } | undefined
      )?.fields;
      const createdAt = BigInt((fields?.created_at as string) ?? 0);
      return { tunnelId, createdAt };
    },

    async reportSession(info) {
      sess = await registerSession(info.tunnelId, info.partyA, info.partyB);
    },

    reportActions(batch) {
      // Report `actionsDelta` over the elapsed time window — this is what moves Total Actions/TPS.
      // Best-effort (heartbeat swallows its own errors), so fire-and-forget keeps the loop sync.
      const now = Date.now();
      void heartbeat(
        sess,
        batch.tunnelId,
        batch.nonce,
        batch.actionsDelta,
        Math.max(1, now - beatStart)
      );
      onActions(batch.actionsDelta);
      beatStart = now;
    },

    async settle(tunnelId, co, transcriptEntries) {
      // settle through the backend /settle (settler SPONSORS the close gas, ADR-0007) — same as the
      // Blackjack bot. The bots therefore pay only the OPEN gas; close costs them nothing. The
      // co-signed settlement is self-authenticating, so no session/bearer is needed.
      //
      // Full transcript so the backend archives the complete play history to Walrus (the verifiable
      // proof). NOTE: this must fit the backend's request-body limit (axum default 2MB ≈ HAND_CAP
      // 200); above that /settle returns 413 and the controller falls back to close().
      await settleViaBackend(
        tunnelId,
        co,
        transcriptEntries as Array<{
          nonce: string;
          message: string;
          sigA: string;
          sigB: string;
        }>
      );
    },

    async close(tunnelId, co) {
      // Fallback: a bot-keypair cooperative close (funder pays the gas) when /settle is unavailable.
      console.warn(`[settle] backend settle failed, bot-keypair fallback`);
      const closeTx = new Transaction();
      onchain.buildCloseWithRootFromSettlement(closeTx, tunnelId, co);
      const cres = await client.signAndExecuteTransaction({
        signer: funder.keypair,
        transaction: closeTx,
        options: { showEffects: true },
      });
      if (cres.effects?.status?.status !== "success")
        throw new Error(
          `close failed: ${cres.effects?.status?.error ?? "unknown"}`
        );
      await client.waitForTransaction({ digest: cres.digest });
    },
  };

  // The controller owns the pump loop (commit/reveal plumbing + NARI/JULES betting) and the
  // settle-or-fallback at terminal; we just hand it the seats, stake, and the adapters above.
  beatStart = Date.now();
  const game = createPokerAutoGame({
    handCap: HAND_CAP,
    perSeat: STAKE,
    seatA: { coreKey: botA.coreKey, address: botA.address },
    seatB: { coreKey: botB.coreKey, address: botB.address },
    adapters,
    reportEvery: HEARTBEAT_EVERY,
  });
  return game.start();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const funderKey = process.env.SUI_FUNDER_KEY;
  if (!funderKey)
    throw new Error("set SUI_FUNDER_KEY=<suiprivkey…> (funded testnet key)");
  const client = createSuiClient("testnet");
  const funder = Ed25519Keypair.fromSecretKey(
    decodeSuiPrivateKey(funderKey).secretKey
  );

  // Persistent bot pair per worker (reused across runs from BOTS_FILE) — distinct gas coins so
  // their open/close txs never contend on the same object version.
  const pairs = loadOrCreateBots(CONCURRENCY);
  console.log(
    `backend: ${BACKEND_URL}  game: ${GAME_ID}  workers: ${CONCURRENCY}  ` +
      `handCap: ${HAND_CAP}  stake: ${STAKE}  games: ${
        GAMES === 0 ? "∞" : GAMES
      }  bots: ${BOTS_FILE}`
  );

  // Top up ONLY the bots below target (sequential — they share the funder's one gas coin). Bots
  // persist across runs, so on a warm run most already hold enough and we fund nothing; the
  // 0.05-SUI/seat stake recycles via the alternating funder. Each bot targets FUND_PER_WORKER/2.
  const perBot = Math.floor(FUND_PER_WORKER_MIST / 2);
  const lowWater = Math.floor(perBot / 4); // only refill a bot that has dipped below ~1/4 of target
  let funded = 0;
  for (const p of pairs) {
    for (const bot of [p.a, p.b]) {
      const bal = Number(
        (await client.getBalance({ owner: bot.address })).totalBalance
      );
      if (bal < lowWater) {
        await fundBot(client, funder, bot.address, perBot - bal);
        funded++;
      }
    }
  }
  console.log(
    funded > 0
      ? `topped up ${funded}/${pairs.length * 2} bots to ${perBot / 1e9} SUI`
      : `all ${pairs.length * 2} bots already funded`
  );

  let totalActions = 0;
  let gamesStarted = 0;
  let gamesDone = 0;
  const startedAt = Date.now();
  // Claim a game slot under the shared GAMES budget (single-threaded JS → no real race).
  const claimGame = (): boolean => {
    if (GAMES !== 0 && gamesStarted >= GAMES) return false;
    gamesStarted++;
    return true;
  };

  async function worker(id: number, botA: Bot, botB: Bot): Promise<void> {
    let g = 0;
    while (claimGame()) {
      // Alternate the funder so the per-seat stake nets ~zero between the two bots over a long
      // run (the funder fronts both stakes; only its own seat returns at close). partyA/partyB
      // stay botA/botB regardless of who opens.
      const funderBot = g++ % 2 === 0 ? botA : botB;
      try {
        const { actions, hands } = await playTunnel(
          client,
          funderBot,
          botA,
          botB,
          (n) => {
            totalActions += n;
          }
        );
        gamesDone++;
        const secs = (Date.now() - startedAt) / 1000;
        console.log(
          `[w${id}] done: ${hands} hands, ${actions} actions | total ${totalActions} ` +
            `(~${Math.round(
              totalActions / Math.max(1, secs)
            )}/s) over ${gamesDone} games`
        );
      } catch (e) {
        console.error(`[w${id}] game FAILED (continuing):`, String(e));
        await sleep(2000); // brief backoff so a transient RPC/gas error doesn't spin hot
      }
    }
  }

  // Total bot balance right before play — so the gas figure is THIS run's spend, accurate on
  // warm runs too (persistent bots don't start from the nominal seed).
  const allBots = pairs.flatMap((p) => [p.a, p.b]);
  const sumBalance = async () =>
    (
      await Promise.all(
        allBots.map((b) => client.getBalance({ owner: b.address }))
      )
    ).reduce((s, b) => s + BigInt(b.totalBalance), 0n);
  const startBalance = await sumBalance();

  await Promise.all(pairs.map((p, i) => worker(i + 1, p.a, p.b)));

  // With /settle sponsoring the close and the funder alternating, the bots' net drop this run is
  // OPEN gas (the 0.05-SUI/seat stake nets ~zero across the alternating pair).
  const gas = startBalance - (await sumBalance());
  const perGame = gamesDone > 0 ? Number(gas) / gamesDone : 0;
  const perWorkerGames =
    perGame > 0 ? Math.floor(FUND_PER_WORKER_MIST / perGame) : Infinity;
  const gasPerAction = totalActions > 0 ? Number(gas) / totalActions : 0;
  console.log(
    `done: ${gamesDone} tunnels, ${totalActions} off-chain actions\n` +
      `open gas burned: ${(Number(gas) / 1e9).toFixed(4)} SUI (~${(
        perGame / 1e6
      ).toFixed(2)}M MIST/tunnel, ` +
      `${gasPerAction.toFixed(0)} MIST/action) → ${
        FUND_PER_WORKER_MIST / 1e9
      } SUI/worker funds ~${perWorkerGames} tunnels (close gas = settler)`
  );
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
