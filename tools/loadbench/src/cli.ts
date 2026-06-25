import { spawn } from "node:child_process";
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
      case "--anchor": {
        const v = need(argv, ++i, a);
        if (v !== "onchain" && v !== "offchain") throw new Error(`--anchor must be onchain or offchain (got ${v})`);
        p.anchor = v; break;
      }
      case "--game": p.game = need(argv, ++i, a); break;
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
  if (p.game !== null) {
    push("--matches", p.matches);
    push("--concurrency", p.concurrency);
    const head = p.game === "all" ? ["--all"] : [p.game];
    return { mode: "game", innerArgv: [...head, "--channel", p.channel, "--anchor", p.anchor, ...tail] };
  }
  push("--workers", p.workers);
  push("--concurrency", p.concurrency);
  push("--matches", p.matches);
  push("--duration", p.duration);
  push("--games", p.games);
  push("--mem-budget-mb", p.memBudgetMb);
  push("--per-match-kb", p.perMatchKb);
  return { mode: "swarm", innerArgv: ["--channel", p.channel, "--anchor", p.anchor, ...tail] };
}

export function planRun(argv: string[], composeFile: string, project: string): RunPlan {
  const p = parse(argv);

  if (p.game !== null) {
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

function main(): void {
  const argv = process.argv.slice(2);
  const composeFile = new URL("../docker-compose.yml", import.meta.url).pathname;
  const plan = planRun(argv, composeFile, benchProject());

  if (plan.kind === "container") {
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
