import { SuiClient, getFullnodeUrl } from "./suiClient";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { isPlayable, PLAYABLE } from "./games";
import { readEnvLocal } from "./env";
import { ensureRelay } from "./relayProcess";
import { runFullMatch } from "./runMatch";
import { summarize, ratePerSec } from "./metrics";
import { startResourceMonitor, formatResources } from "./resourceMonitor";

export function parseBenchArgs(argv: string[]) {
  const out = {
    game: "",
    channel: "relay" as "local" | "relay",
    anchor: "onchain" as "onchain" | "offchain",
    matches: 1,
    concurrency: 1,
    all: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") out.all = true;
    else if (a === "--offchain") out.anchor = "offchain";
    else if (a === "--onchain") out.anchor = "onchain";
    else if (a === "--tunnel-anchor") out.anchor = argv[++i] as "onchain" | "offchain";
    else if (a === "--channel") out.channel = argv[++i] as "local" | "relay";
    else if (a === "--matches") out.matches = Number(argv[++i]);
    else if (a === "--concurrency") out.concurrency = Number(argv[++i]);
    else if (!a.startsWith("--")) out.game = a;
  }
  return out;
}

function funderFromEnv(env: Record<string, string>): Ed25519Keypair {
  const { secretKey } = decodeSuiPrivateKey(env.SUI_SETTLER_KEY);
  return Ed25519Keypair.fromSecretKey(secretKey);
}

async function benchOne(
  game: string,
  args: ReturnType<typeof parseBenchArgs>,
  ctx: { client?: SuiClient; funder?: Ed25519Keypair },
) {
  const latencies: number[] = [];
  let moves = 0;
  const start = performance.now();
  for (let done = 0; done < args.matches; done += args.concurrency) {
    const batch = Math.min(args.concurrency, args.matches - done);
    const runs = await Promise.all(
      Array.from({ length: batch }, () => runFullMatch(game, args.channel, args.anchor, ctx)),
    );
    for (const r of runs) {
      latencies.push(...r.latenciesMs);
      moves += r.moves;
    }
  }
  const elapsed = performance.now() - start;
  const s = summarize(latencies);
  console.log(
    `[${args.channel}/${args.anchor}] ${game}: ${moves} moves, ${ratePerSec(moves, elapsed).toFixed(1)} moves/s, p50=${s.p50.toFixed(2)}ms p99=${s.p99.toFixed(2)}ms over ${args.matches} match(es)`,
  );
}

async function main() {
  const args = parseBenchArgs(process.argv.slice(2));
  const games = args.all ? [...PLAYABLE] : [args.game];
  for (const g of games) {
    if (!isPlayable(g)) throw new Error(`game "${g}" is not playable (try: ${PLAYABLE.join(", ")})`);
  }
  // offchain needs no chain; onchain needs the published package + funded settler.
  const ctx: { client?: SuiClient; funder?: Ed25519Keypair } = {};
  if (args.anchor === "onchain") {
    const e = readEnvLocal();
    const pkg = process.env.TUNNEL_PACKAGE_ID ?? e.TUNNEL_PACKAGE_ID;
    if (!pkg) throw new Error("onchain run needs a package id: pass --package-id or run `bun run stack`");
    process.env.PACKAGE_ID = pkg;
    process.env.TUNNEL_PACKAGE_ID = pkg;
    process.env.SUI_NETWORK = process.env.SUI_NETWORK ?? e.SUI_NETWORK ?? "";
    const rpc = process.env.SUI_RPC_URL ?? e.SUI_RPC_URL ?? "";
    ctx.client = new SuiClient({ url: rpc || getFullnodeUrl("localnet") });
    const settlerKey = process.env.SUI_SETTLER_KEY ?? e.SUI_SETTLER_KEY;
    if (!settlerKey) throw new Error("onchain run needs a settler key: pass --settler-key or run `bun run stack`");
    ctx.funder = funderFromEnv({ SUI_SETTLER_KEY: settlerKey });
  }
  let relay: { stop(): void } | null = null;
  if (args.channel === "relay") relay = await ensureRelay({ wsUrl: process.env.MP_WS_URL });
  const monitor = startResourceMonitor();
  try {
    for (const g of games) await benchOne(g, args, ctx);
  } finally {
    relay?.stop();
    console.log(`resources: ${formatResources(monitor.stop())}`);
  }
}

if (import.meta.main) main().catch((e) => { console.error(e); process.exit(1); });
