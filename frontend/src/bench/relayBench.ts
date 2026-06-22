/**
 * Relay TPS benchmark for Blackjack.
 *
 * Drives many genuine two-party Blackjack tunnels through the real backend relay
 * (`/v1/mp` WebSocket) and Redis. Each process controls BOTH seats of every tunnel
 * (self-pairing), so measuring aggregate throughput is simple, but every move still
 * traverses the network: propose -> backend -> opponent -> ack -> backend -> confirm.
 *
 * Args:
 *   1. backend HTTP base URL, e.g. http://127.0.0.1:8080
 *   2. tunnels per process (default 10)
 *   3. duration ms (default 10000)
 *   4. process id / shard index (default 0)
 */
import { core } from "sui-tunnel-ts";
import { MpClient, type MatchInfo, type PeerMessage } from "@/pvp/mpClient";
import { createBlackjackKit } from "@/agent/games/blackjack/kit";
import {
  actorFor,
  type BetBlackjackMove,
  type BetBlackjackState,
} from "@/games/blackjack/app/lib/bjBetProtocol";

const GAME = "blackjack";
const STAKE = 1_000_000_000_000n; // Large enough that a bench run never bankrupts the table.
const SAMPLE_INTERVAL_MS = 100;

function mpUrl(backendUrl: string): string {
  return backendUrl.replace(/^http/, "ws").replace(/\/+$/, "") + "/v1/mp";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function proposeAndWait(
  tunnel: core.DistributedTunnel<BetBlackjackState, BetBlackjackMove>,
  move: BetBlackjackMove,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      tunnel.onConfirmed = undefined;
      reject(new Error("proposal ACK timeout"));
    }, 10_000);
    tunnel.onConfirmed = () => {
      clearTimeout(timer);
      tunnel.onConfirmed = undefined;
      resolve();
    };
    tunnel.propose(move, BigInt(Date.now()));
  });
}

interface BenchTunnel {
  tA: core.DistributedTunnel<BetBlackjackState, BetBlackjackMove>;
  tB: core.DistributedTunnel<BetBlackjackState, BetBlackjackMove>;
  botA: ReturnType<ReturnType<typeof createBlackjackKit>["createBot"]>;
  botB: ReturnType<ReturnType<typeof createBlackjackKit>["createBot"]>;
}

async function setupOneTunnel(
  clientA: MpClient,
  clientB: MpClient,
  game: string,
  idx: number,
): Promise<BenchTunnel> {
  // Stagger the two queue joins slightly: if both hit the backend atomically
  // the Redis Lua pair script can miss one of them.  Start both promises before
  // awaiting so A can wait while B joins — awaiting A first would deadlock.
  const pA = clientA.quickMatch(game);
  await sleep(50);
  const pB = clientB.quickMatch(game);
  const [mA, mB] = await Promise.all([pA, pB]);
  if (mA.matchId !== mB.matchId) {
    throw new Error(
      `match id mismatch: A=${mA.matchId} B=${mB.matchId}`,
    );
  }
  if (mA.role === mB.role) {
    throw new Error(`roles not complementary: A=${mA.role} B=${mB.role}`);
  }
  const matchId = mA.matchId;
  console.error(`[setup ${idx}] matched ${matchId} roles A=${mA.role} B=${mB.role}`);
  const chA = clientA.channel(matchId);
  const chB = clientB.channel(matchId);

  const ephA = core.generateKeyPair();
  const ephB = core.generateKeyPair();
  // The wire format requires a valid Sui address as tunnelId. We are not
  // creating an on-chain tunnel, but the signing/serialization still validates
  // the address format, so derive a deterministic one from the match id.
  const tunnelId = core.ed25519Address(
    core.blake2b256(new TextEncoder().encode(matchId)).slice(0, 32),
  );

  // MpClient.channel only keeps one onPeer callback, so each channel needs a
  // single dispatcher that resolves the right promise per message type.
  let resolveHelloA: (pubkey: string) => void;
  let resolveStakeA: (amount: number) => void;
  let resolveOpenA: () => void;
  let resolveHelloB: (pubkey: string) => void;
  let resolveStakeB: (amount: number) => void;
  const gotHelloA = new Promise<string>((resolve) => (resolveHelloA = resolve));
  const gotStakeA = new Promise<number>((resolve) => (resolveStakeA = resolve));
  const openedA = new Promise<void>((resolve) => (resolveOpenA = resolve));
  const gotHelloB = new Promise<string>((resolve) => (resolveHelloB = resolve));
  const gotStakeB = new Promise<number>((resolve) => (resolveStakeB = resolve));

  chA.onPeer((msg) => {
    if (msg.t === "hello") resolveHelloA!(msg.ephemeralPubkey);
    else if (msg.t === "stake") resolveStakeA!(msg.amount);
    else if (msg.t === "open" && msg.tunnelId === tunnelId) resolveOpenA!();
  });
  chB.onPeer((msg) => {
    if (msg.t === "hello") resolveHelloB!(msg.ephemeralPubkey);
    else if (msg.t === "stake") resolveStakeB!(msg.amount);
  });

  // Hello.
  chA.sendPeer({ t: "hello", ephemeralPubkey: core.toHex(ephA.publicKey) });
  chB.sendPeer({ t: "hello", ephemeralPubkey: core.toHex(ephB.publicKey) });
  console.error(`[setup ${idx}] waiting for hellos...`);
  const [pubHexB, pubHexA] = await Promise.all([gotHelloA, gotHelloB]);
  if (pubHexB !== core.toHex(ephB.publicKey)) {
    throw new Error("B pubkey mismatch in hello");
  }
  if (pubHexA !== core.toHex(ephA.publicKey)) {
    throw new Error("A pubkey mismatch in hello");
  }
  console.error(`[setup ${idx}] hello complete`);

  // Stake.
  const stakeAmount = Number(STAKE);
  chA.sendPeer({ t: "stake", amount: stakeAmount });
  chB.sendPeer({ t: "stake", amount: stakeAmount });
  console.error(`[setup ${idx}] waiting for stakes...`);
  await Promise.all([gotStakeA, gotStakeB]);
  console.error(`[setup ${idx}] stake complete`);

  // Role B "opens" the tunnel with a synthetic id (we are not doing on-chain creation).
  console.error(`[setup ${idx}] waiting for open...`);
  (mA.role === "B" ? chA : chB).sendPeer({ t: "open", tunnelId });
  await openedA;
  console.error(`[setup ${idx}] open complete`);

  const backend = core.defaultBackend();
  const addrA = core.ed25519Address(ephA.publicKey);
  const addrB = core.ed25519Address(ephB.publicKey);

  const endpointA = core.makeEndpoint(
    backend,
    addrA,
    { publicKey: ephA.publicKey, scheme: core.SignatureScheme.ED25519, secretKey: ephA.secretKey },
    true,
  );
  const endpointB = core.makeEndpoint(
    backend,
    addrB,
    { publicKey: ephB.publicKey, scheme: core.SignatureScheme.ED25519, secretKey: ephB.secretKey },
    true,
  );

  const kit = createBlackjackKit(STAKE);

  const tA = new core.DistributedTunnel(kit.protocol, {
    tunnelId,
    self: endpointA,
    opponent: { ...endpointB, sign: undefined, secretKey: undefined },
    selfParty: "A",
  }, chA.transport, { a: STAKE, b: STAKE });

  const tB = new core.DistributedTunnel(kit.protocol, {
    tunnelId,
    self: endpointB,
    opponent: { ...endpointA, sign: undefined, secretKey: undefined },
    selfParty: "B",
  }, chB.transport, { a: STAKE, b: STAKE });

  const botCtx = { rngForSeat: () => Math.random };
  return {
    tA,
    tB,
    botA: kit.createBot("A", botCtx),
    botB: kit.createBot("B", botCtx),
  };
}

async function runOneTunnel(
  bt: BenchTunnel,
  deadline: number,
  counters: { steps: number },
  errors: { count: number },
): Promise<void> {
  try {
    while (Date.now() < deadline) {
      const actor = actorFor(bt.tA.state);
      const [tunnel, bot] =
        actor === "A" ? [bt.tA, bt.botA] : [bt.tB, bt.botB];
      const move = bot.plan(tunnel.state);
      if (move === null) break; // terminal; stop this tunnel
      await proposeAndWait(tunnel, move);
      counters.steps++;
    }
  } catch (e) {
    errors.count++;
    // Log but do not crash other tunnels.
    console.error(`tunnel ${bt.tA.tunnelId} error:`, e);
  }
}

async function main() {
  const backendUrl = process.argv[2] || "http://127.0.0.1:8080";
  const numTunnels = parseInt(process.argv[3] || "10", 10);
  const durationMs = parseInt(process.argv[4] || "10000", 10);
  const processId = process.argv[5] || "0";

  console.error(`[${processId}] starting relay bench: url=${backendUrl} tunnels=${numTunnels} duration=${durationMs}`);

  const url = mpUrl(backendUrl);
  const walletA = core.generateKeyPair();
  const walletB = core.generateKeyPair();
  const clientA = new MpClient(
    url,
    core.ed25519Address(walletA.publicKey),
    walletA,
  );
  const clientB = new MpClient(
    url,
    core.ed25519Address(walletB.publicKey),
    walletB,
  );

  console.error(`[${processId}] connecting...`);
  await Promise.all([clientA.connect(), clientB.connect()]);
  console.error(`[${processId}] connected`);

  // Use a unique game name per process so this process self-pairs without
  // interfering with stale queue entries from other runs or processes.
  const game = `${GAME}-${processId}-${Date.now()}`;
  console.error(`[${processId}] setting up ${numTunnels} tunnels for game=${game}...`);
  const tunnels: BenchTunnel[] = [];
  for (let i = 0; i < numTunnels; i++) {
    tunnels.push(await setupOneTunnel(clientA, clientB, game, i));
    if ((i + 1) % 10 === 0 || i === numTunnels - 1) {
      console.error(`[${processId}] setup ${i + 1}/${numTunnels} tunnels`);
    }
  }
  console.error(`[${processId}] setup complete, running...`);

  const counters = { steps: 0 };
  const errors = { count: 0 };
  const t0 = Date.now();
  const deadline = t0 + durationMs;

  let sampleStartSteps = 0;
  let sampleStartTime = t0;
  let peakTps = 0;

  // Sample loop: runs concurrently with the tunnel loops.
  const sampleLoop = (async () => {
    while (Date.now() < deadline) {
      await sleep(SAMPLE_INTERVAL_MS);
      const now = Date.now();
      const dt = (now - sampleStartTime) / 1000;
      const tps = (counters.steps - sampleStartSteps) / dt;
      if (tps > peakTps) peakTps = tps;
      sampleStartTime = now;
      sampleStartSteps = counters.steps;
    }
  })();

  const tunnelLoops = tunnels.map((bt) =>
    runOneTunnel(bt, deadline, counters, errors),
  );

  await Promise.all([...tunnelLoops, sampleLoop]);
  const dt = (Date.now() - t0) / 1000;

  const result = `PROCESS=${processId} TUNNELS=${numTunnels} STEPS_PER_S=${Math.round(
    counters.steps / dt,
  )} PEAK_TPS=${Math.round(peakTps)} TOTAL_STEPS=${counters.steps} ERRORS=${errors.count}`;
  console.log(result);
  console.error(`[${processId}] done: ${result}`);

  clientA.close();
  clientB.close();
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
