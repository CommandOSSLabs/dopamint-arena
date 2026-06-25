import { parentPort, workerData } from "node:worker_threads";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { runSwarm } from "./swarm";
import { runFullMatch } from "./runMatch";

interface WorkerInput {
  workerId: number;
  channel: "local" | "relay";
  anchor: "onchain" | "offchain";
  games: string[];
  concurrency: number;
  matches: number | null;
  durationMs: number | null;
  env: Record<string, string>;
}

async function run() {
  const d = workerData as WorkerInput;
  const ctx: { client?: SuiClient; funder?: Ed25519Keypair } = {};
  if (d.anchor === "onchain") {
    process.env.PACKAGE_ID = d.env.PACKAGE_ID;
    process.env.SUI_NETWORK = d.env.SUI_NETWORK;
    ctx.client = new SuiClient({ url: d.env.SUI_RPC_URL || getFullnodeUrl("localnet") });
    const { secretKey } = decodeSuiPrivateKey(d.env.SUI_SETTLER_KEY);
    ctx.funder = Ed25519Keypair.fromSecretKey(secretKey);
  }
  let g = 0;
  const nextGame = () => d.games[g++ % d.games.length];
  const res = await runSwarm(() => runFullMatch(nextGame(), d.channel, d.anchor, ctx), {
    concurrency: d.concurrency,
    matches: d.matches,
    durationMs: d.durationMs,
    now: () => performance.now(),
  });
  parentPort!.postMessage({ ok: true, moves: res.moves, matches: res.matches });
}

run().catch((e) => parentPort!.postMessage({ ok: false, error: String(e?.stack ?? e) }));
