import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { PLAYABLE } from "./games";
import { readEnvLocal } from "./env";
import { ensureRelay } from "./relayProcess";
import { runFullMatch } from "./runMatch";
import { ratePerSec } from "./metrics";

export function parseSwarmArgs(argv: string[]): {
  channel: "local" | "relay";
  anchor: "onchain" | "offchain";
  concurrency: number;
  matches: number | null;
  durationS: number | null;
  games: string[];
} {
  const out = {
    channel: "relay" as "local" | "relay",
    anchor: "onchain" as "onchain" | "offchain",
    concurrency: 8,
    matches: null as number | null,
    durationS: null as number | null,
    games: [...PLAYABLE] as string[],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--channel") out.channel = argv[++i] as "local" | "relay";
    else if (a === "--offchain") out.anchor = "offchain";
    else if (a === "--anchor") out.anchor = argv[++i] as "onchain" | "offchain";
    else if (a === "--concurrency") out.concurrency = Number(argv[++i]);
    else if (a === "--matches") out.matches = Number(argv[++i]);
    else if (a === "--duration") out.durationS = Number(argv[++i]);
    else if (a === "--games") out.games = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

/** Run `run()` up to `concurrency` at a time until the matches cap OR duration
 *  is reached (whichever fires first, if both are set).
 *
 *  `now` is injectable so callers can drive time in unit tests without real timers. */
export async function runSwarm(
  run: () => Promise<{ moves: number }>,
  opts: {
    concurrency: number;
    matches: number | null;
    durationMs: number | null;
    now: () => number;
  },
): Promise<{ moves: number; matches: number; elapsedMs: number }> {
  const start = opts.now();
  let totalMoves = 0;
  let totalMatches = 0;
  // claimed tracks how many match slots have been reserved — checked before
  // each run to cap at opts.matches without over-shooting (JS event loop is
  // single-threaded so the check+increment pair is effectively atomic).
  let claimed = 0;

  const shouldStop = () => {
    if (opts.matches !== null && claimed >= opts.matches) return true;
    if (opts.durationMs !== null && opts.now() - start >= opts.durationMs) return true;
    return false;
  };

  async function worker() {
    while (!shouldStop()) {
      claimed++;
      const r = await run();
      totalMoves += r.moves;
      totalMatches++;
    }
  }

  await Promise.all(Array.from({ length: opts.concurrency }, () => worker()));
  return { moves: totalMoves, matches: totalMatches, elapsedMs: opts.now() - start };
}

async function main() {
  const args = parseSwarmArgs(process.argv.slice(2));
  // Default to a 15-second burst when neither stop condition is given.
  if (args.matches === null && args.durationS === null) args.durationS = 15;

  const ctx: { client?: SuiClient; funder?: Ed25519Keypair } = {};
  if (args.anchor === "onchain") {
    const env = readEnvLocal();
    if (!env.TUNNEL_PACKAGE_ID) throw new Error("run `bun run stack` first (.env.local missing PACKAGE_ID)");
    process.env.PACKAGE_ID = env.TUNNEL_PACKAGE_ID;
    process.env.SUI_NETWORK = env.SUI_NETWORK;
    ctx.client = new SuiClient({ url: getFullnodeUrl("localnet") });
    const { secretKey } = decodeSuiPrivateKey(env.SUI_SETTLER_KEY);
    ctx.funder = Ed25519Keypair.fromSecretKey(secretKey);
  }

  const relay = args.channel === "relay" ? await ensureRelay() : null;

  let gameIdx = 0;
  const nextGame = () => args.games[gameIdx++ % args.games.length];
  const tag = `${args.channel}/${args.anchor}`;

  try {
    const res = await runSwarm(
      () => runFullMatch(nextGame(), args.channel, args.anchor, ctx),
      {
        concurrency: args.concurrency,
        matches: args.matches,
        durationMs: args.durationS !== null ? args.durationS * 1000 : null,
        now: () => performance.now(),
      },
    );
    console.log(
      `[${tag}] swarm: ${res.moves} moves over ${res.matches} matches in ${(res.elapsedMs / 1000).toFixed(1)}s`,
    );
    console.log(`[${tag}] aggregate move-TPS: ${ratePerSec(res.moves, res.elapsedMs).toFixed(1)}`);
    if (args.anchor === "onchain") {
      console.log(
        `[${tag}] tunnels settled/s: ${ratePerSec(res.matches, res.elapsedMs).toFixed(2)} (on-chain-finality-bound)`,
      );
    }
  } finally {
    relay?.stop();
  }
}

if (import.meta.main) main().catch((e) => { console.error(e); process.exit(1); });
