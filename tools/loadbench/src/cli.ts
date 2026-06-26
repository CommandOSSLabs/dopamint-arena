import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import os from "node:os";
import { project as benchProject } from "./benchEnv";

export type RunMode = "swarm" | "game";

export type RunPlan =
  | { kind: "host"; mode: RunMode; innerArgv: string[]; childEnv: Record<string, string> }
  | { kind: "container"; innerArgv: string[]; dockerArgs: string[]; composeEnv: Record<string, string> };

type Parsed = {
  channel: "local" | "relay";
  anchor: "onchain" | "offchain";
  game: string | null;
  container: boolean;
  cpus: string | null;
  memory: string | null;
  rpcUrl: string | null;
  packageId: string | null;
  settlerKey: string | null;
  relayUrl: string | null;
  workers: string | null;
  duration: string | null;
  games: string | null;
  memBudgetMb: string | null;
  perMatchKb: string | null;
  matches: string | null;
  concurrency: string | null;
};

function need(argv: string[], i: number, flag: string): string {
  if (i >= argv.length) throw new Error(`${flag} requires a value`);
  return argv[i];
}

function parse(argv: string[]): Parsed {
  const p: Parsed = {
    channel: "local", anchor: "onchain", game: null, container: false,
    cpus: null, memory: null, rpcUrl: null, packageId: null, settlerKey: null, relayUrl: null,
    workers: null, duration: null, games: null, memBudgetMb: null, perMatchKb: null,
    matches: null, concurrency: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--channel": {
        const v = need(argv, ++i, a);
        if (v !== "local" && v !== "relay") throw new Error(`--channel must be local or relay (got ${v})`);
        p.channel = v; break;
      }
      case "--offchain": p.anchor = "offchain"; break;
      case "--onchain": p.anchor = "onchain"; break;
      case "--tunnel-anchor": {
        const v = need(argv, ++i, a);
        if (v !== "onchain" && v !== "offchain") throw new Error(`--tunnel-anchor must be onchain or offchain (got ${v})`);
        p.anchor = v; break;
      }
      case "--game": p.game = need(argv, ++i, a); break;
      case "--all": p.game = "all"; break;
      case "--container": p.container = true; break;
      case "--cpus": p.cpus = need(argv, ++i, a); break;
      case "--memory": p.memory = need(argv, ++i, a); break;
      case "--rpc-url": p.rpcUrl = need(argv, ++i, a); break;
      case "--package-id": p.packageId = need(argv, ++i, a); break;
      case "--settler-key": p.settlerKey = need(argv, ++i, a); break;
      case "--relay-url": p.relayUrl = need(argv, ++i, a); break;
      case "--workers": p.workers = need(argv, ++i, a); break;
      case "--duration": p.duration = need(argv, ++i, a); break;
      case "--games": p.games = need(argv, ++i, a); break;
      case "--mem-budget-mb": p.memBudgetMb = need(argv, ++i, a); break;
      case "--per-match-kb": p.perMatchKb = need(argv, ++i, a); break;
      case "--matches": p.matches = need(argv, ++i, a); break;
      case "--concurrency": p.concurrency = need(argv, ++i, a); break;
      default: throw new Error(`unknown flag: ${a}`);
    }
  }
  return p;
}

function infraEnv(p: Parsed): Record<string, string> {
  const e: Record<string, string> = {};
  if (p.rpcUrl !== null) e.SUI_RPC_URL = p.rpcUrl;
  if (p.packageId !== null) { e.PACKAGE_ID = p.packageId; e.TUNNEL_PACKAGE_ID = p.packageId; }
  if (p.settlerKey !== null) e.SUI_SETTLER_KEY = p.settlerKey;
  if (p.relayUrl !== null) e.MP_WS_URL = p.relayUrl;
  return e;
}

function buildInner(p: Parsed): { mode: RunMode; innerArgv: string[] } {
  const tail: string[] = [];
  const push = (flag: string, v: string | null) => { if (v !== null) tail.push(flag, v); };
  // --game all: multi-core per-game report, driven by the swarm worker fleet.
  if (p.game === "all") {
    push("--workers", p.workers);
    push("--concurrency", p.concurrency);
    push("--matches", p.matches);
    push("--duration", p.duration);
    push("--mem-budget-mb", p.memBudgetMb);
    push("--per-match-kb", p.perMatchKb);
    return { mode: "swarm", innerArgv: ["--all", "--channel", p.channel, "--tunnel-anchor", p.anchor, ...tail] };
  }
  // single game: latency mode (single-stream).
  if (p.game !== null) {
    push("--matches", p.matches);
    push("--concurrency", p.concurrency);
    return { mode: "game", innerArgv: [p.game, "--channel", p.channel, "--tunnel-anchor", p.anchor, ...tail] };
  }
  push("--workers", p.workers);
  push("--concurrency", p.concurrency);
  push("--matches", p.matches);
  push("--duration", p.duration);
  push("--games", p.games);
  push("--mem-budget-mb", p.memBudgetMb);
  push("--per-match-kb", p.perMatchKb);
  return { mode: "swarm", innerArgv: ["--channel", p.channel, "--tunnel-anchor", p.anchor, ...tail] };
}

export function planRun(argv: string[], composeFile: string, project: string): RunPlan {
  const p = parse(argv);

  // Single-game latency mode is single-stream + matches-based; --game all is the
  // multi-core per-game report and accepts the swarm tuning flags.
  if (p.game !== null && p.game !== "all") {
    if (p.workers !== null) throw new Error("--workers is not valid in --game (latency) mode");
    if (p.duration !== null) throw new Error("--duration is not valid in --game (latency) mode");
    if (p.games !== null) throw new Error("--games is not valid in --game (latency) mode");
    if (p.memBudgetMb !== null) throw new Error("--mem-budget-mb is not valid in --game (latency) mode");
    if (p.perMatchKb !== null) throw new Error("--per-match-kb is not valid in --game (latency) mode");
  }
  if (!p.container && p.cpus !== null) throw new Error("--cpus only applies with --container");
  if (!p.container && p.memory !== null) throw new Error("--memory only applies with --container");
  if (p.container && p.channel === "relay")
    throw new Error("--channel relay is not supported in --container (relay runs host-side)");

  const { mode, innerArgv } = buildInner(p);
  const env = infraEnv(p);

  if (p.container) {
    const composeEnv: Record<string, string> = {};
    if (p.cpus !== null) composeEnv.BENCH_CPUS = p.cpus;
    if (p.memory !== null) composeEnv.BENCH_MEMORY = p.memory;
    const eArgs = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const dockerArgs = [
      "compose", "-f", composeFile, "-p", project, "--profile", "bench", "run", "--rm",
      ...eArgs, "loadbench", ...innerArgv,
    ];
    return { kind: "container", innerArgv, dockerArgs, composeEnv };
  }
  return { kind: "host", mode, innerArgv, childEnv: env };
}

// ── executor ────────────────────────────────────────────────────────────────

function run(cmd: string, cmdArgs: string[], extraEnv: Record<string, string>): void {
  const child = spawn(cmd, cmdArgs, { stdio: "inherit", env: { ...process.env, ...extraEnv } });
  child.on("exit", (code, signal) => {
    if (signal) process.exit(128 + (os.constants.signals[signal] ?? 1));
    process.exit(code ?? 1);
  });
  child.on("error", (err) => { console.error(String(err?.message ?? err)); process.exit(1); });
}
const HELP = `loadbench — benchmark real off-chain games on the sui-tunnel engine.

A "match" opens a tunnel, plays many moves, then cooperatively settles it. The
moves are the throughput; opening/settling are the bookends. Two independent
axes control a run: the CHANNEL (how moves are transported) and the ANCHOR
(whether the bookends touch the chain). Moves are always off-chain.

Usage: bun run bench [flags]

MODES (pick one; default = swarm)
  (no --game)        swarm: many concurrent matches across all games at once;
                     reports aggregate move-TPS (and tunnels-settled/s onchain).
  --game <name>      latency: one game only, single-stream, reports per-move
                     p50/p99. Playable: ticTacToe, blackjack, battleship,
                     quantumPoker, bombIt, cross.
  --game all         multi-core report: runs every game in turn through the
                     worker fleet, then writes an aggregated markdown report
                     (per-game TPS, Matches/s, and CPU utilization %).

CHANNEL — how moves travel
  --channel local    (default) two transports paired in memory; no network.
                     This is the pure engine/signing ceiling.
  --channel relay    headless WebSocket client through the tunnel-manager relay
                     (real networking). Auto-spawns a relay unless --relay-url
                     is given. Not supported with --container.

ANCHOR — whether tunnel open/settle hit the Sui chain
  --tunnel-anchor onchain   (default) real on-chain open (create_and_fund) + cooperative
                     settle (close_cooperative_with_root) on a Sui localnet.
                     Requires a published package + funded settler -> run
                     'bun run stack' first, or pass --package-id/--settler-key.
  --tunnel-anchor offchain  no chain: synthetic tunnel id, pure move loop. No infra.
  --onchain          shorthand for --tunnel-anchor onchain.
  --offchain         shorthand for --tunnel-anchor offchain.

CAP — how much work per run
  --duration S       run for S seconds. Swarm: total run length. --game all:
                     per-game time budget (default 10s) — the fair way to compare
                     games with different move counts.
  --matches N        swarm: stop after N matches. --game/--game all: run exactly
                     N matches (mutually exclusive with --duration in latency mode).
  --concurrency N    matches kept in flight at once per worker (default auto).

FLEET — multi-core sizing (swarm and --game all)
  --workers N|auto   OS worker threads for true multi-core (default auto ≈ 1.5×
                     cores). This is what drives CPU toward full utilization.
  --mem-budget-mb N  memory ceiling used to auto-pick concurrency (io runs).
  --per-match-kb N   per-match RSS estimate used by auto concurrency.
  --games a,b,c      swarm only: restrict to these games (default: all).

ONCHAIN INFRA — resolved as flag -> .env.local -> process env
  --rpc-url <url>    Sui RPC endpoint (e.g. http://127.0.0.1:9000).
  --package-id <id>  published tunnel package object id.
  --settler-key <k>  settler private key (suiprivkey…) that funds/settles.
  --relay-url <ws>   ws URL of a relay you're already running (else auto-spawn).

CONTAINER — run isolated inside the loadbench Docker service
  --container        re-exec this run in Docker; joins this env's compose project.
                     CPU % is then measured against the container's assigned cores.
  --cpus N           CPU limit for the container run.
  --memory Ng        memory limit for the container run.

  -h, --help         show this help and exit.

EXAMPLES
  # no infra, pure engine burst:
  bun run bench --offchain --channel local --duration 10
  # one game's latency (no infra):
  bun run bench --game blackjack --offchain --channel local --matches 50
  # every game, multi-core, aggregated report (30s each):
  bun run bench --game all --channel local --duration 30
  # onchain swarm against a local stack (run 'bun run stack' first):
  bun run bench --channel local --duration 15
  # all-games report isolated in a container capped at 8 cores:
  bun run bench --game all --container --cpus 8 --offchain --channel local
`;;

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return;
  }
  if (argv.includes("--ablation")) {
    import("./ablationRun")
      .then((m) => m.runAblation(argv))
      .catch((e: unknown) => {
        console.error(String((e as Error)?.message ?? e));
        process.exit(1);
      });
    return;
  }
  const composeFile = new URL("../docker-compose.yml", import.meta.url).pathname;
  const plan = planRun(argv, composeFile, benchProject());

  if (plan.kind === "container") {
    // Create the bind-mount source on the host first, so Docker doesn't create
    // it as root; the container writes its all-games report here.
    mkdirSync(new URL("../reports", import.meta.url).pathname, { recursive: true });
    run("docker", plan.dockerArgs, plan.composeEnv);
  } else {
    const target = plan.mode === "game" ? "src/benchGame.ts" : "src/swarm.ts";
    run("bun", ["run", target, ...plan.innerArgv], plan.childEnv);
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (e: unknown) {
    console.error(String((e as Error)?.message ?? e));
    process.exit(1);
  }
}
