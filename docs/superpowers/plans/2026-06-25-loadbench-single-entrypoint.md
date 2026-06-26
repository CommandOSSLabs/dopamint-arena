# loadbench Single Entry Point Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse loadbench's run scripts into one entry point — `bun run bench` — that selects swarm vs per-game latency by flag and re-execs in the Docker `loadbench` service on `--container`, while keeping the benchmark itself pure (just the game bots): all external infra (chain RPC, package id, settler key, relay URL) is fed in through flags, never orchestrated by the bench.

**Architecture:** A new `src/cli.ts` is the single dispatcher. A pure `planRun(argv, composeFile)` parses the full flag vocabulary — run mode, infra, container — and returns a `RunPlan` describing exactly what to execute (host swarm, host game, or a container re-exec). Infra flags are forwarded to the wrapped entry as environment variables (`SUI_RPC_URL`, `PACKAGE_ID`/`TUNNEL_PACKAGE_ID`, `SUI_SETTLER_KEY`, `MP_WS_URL`) — kept out of argv so secrets don't land in `ps`. The cli does **no** infra lifecycle: no stack bring-up. `src/swarm.ts` and `src/benchGame.ts` are edited only to prefer `process.env` infra over `.env.local` (so flags win, env-file is the fallback); the relay still auto-spawns *only* when no `--relay-url` is supplied.

**Tech Stack:** bun package, `bun test` (native `bun:test`), `node:child_process` (`spawn`), `@mysten/sui` SuiClient, Docker Compose v2.

## Global Constraints

- This is a **bun** package — do NOT convert tooling. Tests use `bun:test`; run with `bun test`. (CLAUDE.md)
- Do NOT edit `sui-tunnel-ts/` or `frontend/` source. Editing loadbench's own `src/swarm.ts` / `src/benchGame.ts` / `src/relayProcess.ts` is in scope for this plan.
- The benchmark itself performs **no infra orchestration** beyond the relay auto-spawn fallback: no `docker compose up`, no stack bring-up, no publishing. Infra is supplied via flags. (User directive, this plan.)
- Infra precedence is **flag → `.env.local` → `process.env`-default**: a provided flag wins; when omitted, the wrapped entry falls back to `.env.local` (what `bun run stack` writes) and existing env. Implemented by forwarding flags as `process.env` to the child and making the child prefer `process.env` over the `.env.local` file.
- Relay: `--relay-url ws://…` ⇒ connect to it, never spawn. Omitted ⇒ today's auto-spawn (`cargo run -p tunnel-manager`) fallback is preserved.
- `.env.local` and `keys.json` are gitignored localnet-only secrets — never commit, never bake into the image. (CLAUDE.md)
- Conventional Commits; subject ≤ 50 chars, imperative, lowercase after type, no trailing period. **No AI attribution** — commits read as human-authored. (CLAUDE.md)
- cli default channel = `local` (relay is unverified end-to-end); cli default anchor = `onchain`; cli default mode = swarm. These are the cli's own defaults, emitted explicitly into the inner argv as `--channel`/`--anchor`.
- Playable games (unchanged): `ticTacToe, blackjack, battleship, quantumPoker, bombIt, cross`.

---

## File Structure

- `tools/loadbench/src/cli.ts` — **new.** `planRun` (pure planner) + `RunPlan`/`RunMode` types + executor `main()`.
- `tools/loadbench/src/cli.test.ts` — **new.** Unit tests for `planRun` (pure; no IO).
- `tools/loadbench/src/relayProcess.ts` — **modify.** Add `httpBaseFromWs`; `ensureRelay` connects to a provided `wsUrl` instead of spawning.
- `tools/loadbench/src/relayProcess.test.ts` — **modify/extend** (or create if absent) to cover `httpBaseFromWs` + the connect-don't-spawn branch.
- `tools/loadbench/src/swarm.ts` — **modify.** Onchain infra read prefers `process.env` over `.env.local`; pass `--relay-url` through via `MP_WS_URL`.
- `tools/loadbench/src/benchGame.ts` — **modify.** Same onchain-infra precedence + relay wsUrl.
- `tools/loadbench/package.json` — **modify.** Scripts become `bench`, `stack`, `test` (drop `swarm`, `bench:game`).
- `tools/loadbench/Dockerfile` — **modify.** `ENTRYPOINT` → `["bun", "run", "src/cli.ts"]`.
- `tools/loadbench/docker-compose.yml` — **modify.** `loadbench` limits become env-interpolated (`${BENCH_CPUS:-4}` / `${BENCH_MEMORY:-4g}`); default command stays an offchain burst.
- `tools/loadbench/README.md` — **modify.** Rewrite around the single `bench` entry point + infra flags.

---

### Task 1: Pure run planner (`planRun`)

The brain of the cli: parse the whole flag vocabulary, validate, and emit a `RunPlan`. Infra flags become a `childEnv` map (host) or `-e KEY=VAL` docker args (container); they never enter the wrapped entry's argv. No IO, no spawning — fully unit-tested.

**Files:**
- Create: `tools/loadbench/src/cli.ts`
- Test: `tools/loadbench/src/cli.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `export type RunMode = "swarm" | "game"`
  - `export type RunPlan =`
    `| { kind: "host"; mode: RunMode; innerArgv: string[]; childEnv: Record<string, string> }`
    `| { kind: "container"; innerArgv: string[]; dockerArgs: string[]; composeEnv: Record<string, string> }`
  - `export function planRun(argv: string[], composeFile: string): RunPlan`

**Flag vocabulary cli owns** (every flag is consumed; unknown flags throw):
- Run shape — Shared: `--channel <local|relay>`, `--offchain`, `--anchor <onchain|offchain>`, `--matches <N>`, `--concurrency <N>`. Swarm-only: `--workers <N|auto>`, `--duration <S>`, `--games <a,b,c>`, `--mem-budget-mb <N>`, `--per-match-kb <N>`. Mode selector: `--game <name|all>` (present ⇒ latency mode; absent ⇒ swarm).
- Infra: `--rpc-url <url>`, `--package-id <id>`, `--settler-key <key>`, `--relay-url <ws-url>`.
- Container: `--container`, `--cpus <N>`, `--memory <S>` (e.g. `8g`).

**Normalization rules:**
- Defaults: `channel="local"`, `anchor="onchain"`. `--offchain` ⇒ `anchor="offchain"`; `--anchor X` sets it explicitly.
- Inner argv ALWAYS carries explicit `--channel <c> --anchor <a>`, overriding the wrapped scripts' own defaults.
- swarm inner argv: `["--channel", c, "--anchor", a, ...opt(--workers), ...opt(--concurrency), ...opt(--matches), ...opt(--duration), ...opt(--games), ...opt(--mem-budget-mb), ...opt(--per-match-kb)]`.
- game inner argv: `[<positional name> | "--all", "--channel", c, "--anchor", a, ...opt(--matches), ...opt(--concurrency)]`. `--game all` ⇒ `--all` (no positional); `--game X` ⇒ positional `X` first.
- Infra env map (built only from flags actually provided): `--rpc-url`→`SUI_RPC_URL`; `--package-id`→ both `PACKAGE_ID` and `TUNNEL_PACKAGE_ID`; `--settler-key`→`SUI_SETTLER_KEY`; `--relay-url`→`MP_WS_URL`.
- host plan: `childEnv` = that infra env map.
- container plan: infra env map becomes `-e KEY=VAL` pairs placed **before** the service name. `dockerArgs = ["compose", "-f", composeFile, "--profile", "bench", "run", "--rm", ...flatMap(([k,v]) => ["-e", \`${k}=${v}\`]), "loadbench", ...innerArgv]`. `composeEnv` = `{ BENCH_CPUS?, BENCH_MEMORY? }` from `--cpus`/`--memory`, else `{}`.

**Validation (throw `Error` with a clear message):**
- Unknown flag ⇒ `unknown flag: <flag>`. Value-flag at end ⇒ `<flag> requires a value`.
- `--channel`∉`{local,relay}` / `--anchor`∉`{onchain,offchain}` ⇒ message listing valid values.
- Swarm-only flag in game mode ⇒ `<flag> is not valid in --game (latency) mode`.
- `--cpus`/`--memory` without `--container` ⇒ `<flag> only applies with --container`.
- `--container` with `--channel relay` ⇒ `--channel relay is not supported in --container (relay runs host-side)`.

- [ ] **Step 1: Write the failing tests**

```ts
// tools/loadbench/src/cli.test.ts
import { test, expect } from "bun:test";
import { planRun } from "./cli";

const COMPOSE = "/repo/tools/loadbench/docker-compose.yml";

test("defaults to a host swarm run, local+onchain, no infra env", () => {
  expect(planRun([], COMPOSE)).toEqual({
    kind: "host",
    mode: "swarm",
    innerArgv: ["--channel", "local", "--anchor", "onchain"],
    childEnv: {},
  });
});

test("offchain local swarm forwards swarm tuning, no infra env", () => {
  expect(
    planRun(["--offchain", "--channel", "local", "--workers", "auto", "--duration", "10"], COMPOSE),
  ).toEqual({
    kind: "host",
    mode: "swarm",
    innerArgv: ["--channel", "local", "--anchor", "offchain", "--workers", "auto", "--duration", "10"],
    childEnv: {},
  });
});

test("infra flags become childEnv, not inner argv", () => {
  const plan = planRun(
    ["--channel", "local", "--rpc-url", "http://h:9000", "--package-id", "0xpkg", "--settler-key", "suipriv1"],
    COMPOSE,
  );
  expect(plan).toEqual({
    kind: "host",
    mode: "swarm",
    innerArgv: ["--channel", "local", "--anchor", "onchain"],
    childEnv: {
      SUI_RPC_URL: "http://h:9000",
      PACKAGE_ID: "0xpkg",
      TUNNEL_PACKAGE_ID: "0xpkg",
      SUI_SETTLER_KEY: "suipriv1",
    },
  });
});

test("--relay-url maps to MP_WS_URL in childEnv", () => {
  const plan = planRun(["--channel", "relay", "--relay-url", "ws://r:8080/v1/mp"], COMPOSE) as Extract<
    ReturnType<typeof planRun>,
    { kind: "host" }
  >;
  expect(plan.childEnv).toEqual({ MP_WS_URL: "ws://r:8080/v1/mp" });
});

test("--game selects latency mode and emits a positional game name", () => {
  expect(
    planRun(["--game", "blackjack", "--offchain", "--channel", "local", "--matches", "5"], COMPOSE),
  ).toEqual({
    kind: "host",
    mode: "game",
    innerArgv: ["blackjack", "--channel", "local", "--anchor", "offchain", "--matches", "5"],
    childEnv: {},
  });
});

test("--game all emits --all instead of a positional", () => {
  const plan = planRun(["--game", "all", "--offchain"], COMPOSE) as Extract<
    ReturnType<typeof planRun>,
    { kind: "host" }
  >;
  expect(plan.mode).toBe("game");
  expect(plan.innerArgv).toEqual(["--all", "--channel", "local", "--anchor", "offchain"]);
});

test("--container re-execs in compose with resource env, -e infra, stripped inner argv", () => {
  const plan = planRun(
    ["--container", "--cpus", "8", "--memory", "8g", "--rpc-url", "http://sui:9000", "--duration", "10"],
    COMPOSE,
  );
  expect(plan).toEqual({
    kind: "container",
    innerArgv: ["--channel", "local", "--anchor", "onchain", "--duration", "10"],
    dockerArgs: [
      "compose", "-f", COMPOSE, "--profile", "bench", "run", "--rm",
      "-e", "SUI_RPC_URL=http://sui:9000",
      "loadbench",
      "--channel", "local", "--anchor", "onchain", "--duration", "10",
    ],
    composeEnv: { BENCH_CPUS: "8", BENCH_MEMORY: "8g" },
  });
});

test("rejects swarm-only flags in --game mode", () => {
  expect(() => planRun(["--game", "blackjack", "--workers", "4"], COMPOSE)).toThrow(
    /--workers is not valid in --game/,
  );
});

test("rejects --cpus without --container", () => {
  expect(() => planRun(["--cpus", "4"], COMPOSE)).toThrow(/--cpus only applies with --container/);
});

test("rejects --container with relay", () => {
  expect(() => planRun(["--container", "--channel", "relay"], COMPOSE)).toThrow(
    /relay is not supported in --container/,
  );
});

test("rejects unknown flags", () => {
  expect(() => planRun(["--frobnicate"], COMPOSE)).toThrow(/unknown flag: --frobnicate/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd tools/loadbench && bun test src/cli.test.ts`
Expected: FAIL — `./cli` has no `planRun` export.

- [ ] **Step 3: Implement `planRun` (and the types) in `src/cli.ts`**

```ts
// tools/loadbench/src/cli.ts
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

export function planRun(argv: string[], composeFile: string): RunPlan {
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
      "compose", "-f", composeFile, "--profile", "bench", "run", "--rm",
      ...eArgs, "loadbench", ...innerArgv,
    ];
    return { kind: "container", innerArgv, dockerArgs, composeEnv };
  }
  return { kind: "host", mode, innerArgv, childEnv: env };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd tools/loadbench && bun test src/cli.test.ts`
Expected: PASS — all cases green.

- [ ] **Step 5: Commit**

```bash
git add tools/loadbench/src/cli.ts tools/loadbench/src/cli.test.ts
git commit -m "feat(loadbench): pure run planner for unified cli"
```

---

### Task 2: Infra by flag in the wrapped entries

Make the bench take infra as inputs: the relay connects to a supplied URL (spawning only as fallback), and onchain config prefers `process.env` (set by the cli from flags) over `.env.local`.

**Files:**
- Modify: `tools/loadbench/src/relayProcess.ts:8-75`
- Modify/Create test: `tools/loadbench/src/relayProcess.test.ts`
- Modify: `tools/loadbench/src/swarm.ts:150-160` (onchain env block) and `:160` (relay call)
- Modify: `tools/loadbench/src/benchGame.ts:71-80` (onchain block) and `:80` (relay call)

**Interfaces:**
- Consumes: `MP_WS_URL` / `SUI_RPC_URL` / `TUNNEL_PACKAGE_ID` / `PACKAGE_ID` / `SUI_SETTLER_KEY` from `process.env` (set by the cli in Task 3).
- Produces:
  - `export function httpBaseFromWs(wsUrl: string): string` — `ws://h:8080/v1/mp` → `http://h:8080`, `wss://h/x` → `https://h`.
  - `ensureRelay(opts?: { wsUrl?: string; httpBase?: string; fetchImpl?: typeof fetch }): Promise<{ alreadyRunning: boolean; stop(): void }>` — when `wsUrl` is set, probe its derived http base and connect (never spawn); otherwise unchanged (localhost probe + cargo spawn fallback).

- [ ] **Step 1: Write failing tests for the relay URL helpers**

```ts
// tools/loadbench/src/relayProcess.test.ts  (add these; keep any existing tests)
import { test, expect } from "bun:test";
import { httpBaseFromWs, ensureRelay } from "./relayProcess";

test("httpBaseFromWs derives http(s) origin from a ws(s) url", () => {
  expect(httpBaseFromWs("ws://127.0.0.1:8080/v1/mp")).toBe("http://127.0.0.1:8080");
  expect(httpBaseFromWs("wss://relay.example.com/v1/mp")).toBe("https://relay.example.com");
});

test("ensureRelay with wsUrl connects to that relay and never spawns", async () => {
  let probed = "";
  const fetchImpl = (async (url: string) => {
    probed = String(url);
    return { ok: true } as Response;
  }) as unknown as typeof fetch;
  const handle = await ensureRelay({ wsUrl: "ws://remote:9090/v1/mp", fetchImpl });
  expect(probed).toBe("http://remote:9090/healthz");
  expect(handle.alreadyRunning).toBe(true);
  handle.stop(); // no-op, must not throw
});
```

- [ ] **Step 2: Run the relay tests to verify they fail**

Run: `cd tools/loadbench && bun test src/relayProcess.test.ts`
Expected: FAIL — `httpBaseFromWs` not exported / `ensureRelay` ignores `wsUrl`.

- [ ] **Step 3: Implement `httpBaseFromWs` and the `wsUrl` branch in `relayProcess.ts`**

Add the helper near `relayWsUrl`:

```ts
/** Derive the relay's HTTP origin (for /healthz) from its ws(s) URL. */
export function httpBaseFromWs(wsUrl: string): string {
  const u = new URL(wsUrl);
  const proto = u.protocol === "wss:" ? "https:" : "http:";
  return `${proto}//${u.host}`;
}
```

Replace the body of `ensureRelay` so a supplied `wsUrl` short-circuits to connect-only:

```ts
export async function ensureRelay(
  opts: { wsUrl?: string; httpBase?: string; fetchImpl?: typeof fetch } = {},
): Promise<{ alreadyRunning: boolean; stop(): void }> {
  const f = opts.fetchImpl ?? fetch;

  // Explicit relay URL: connect to it, never spawn a local one.
  if (opts.wsUrl) {
    const httpBase = opts.httpBase ?? httpBaseFromWs(opts.wsUrl);
    await waitHealthy(httpBase, { fetchImpl: f });
    return { alreadyRunning: true, stop() {} };
  }

  const httpBase = opts.httpBase ?? "http://127.0.0.1:8080";
  try {
    if ((await f(`${httpBase}/healthz`)).ok) {
      return { alreadyRunning: true, stop() {} };
    }
  } catch {
    // not running yet — fall through to spawn
  }

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...readEnvLocal(),
    TUNNEL_MANAGER_ADDR: "127.0.0.1:8080",
  };
  delete env.REDIS_CACHE_URL;
  delete env.REDIS_PUBSUB_URL;

  const repoRoot = new URL("../../..", import.meta.url).pathname;
  const child: ChildProcess = spawn("cargo", ["run", "-q", "-p", "tunnel-manager"], {
    cwd: repoRoot, env, stdio: "inherit",
  });
  child.on("error", (err) => {
    console.error(`failed to spawn tunnel-manager via cargo: ${err.message}`);
  });

  await waitHealthy(httpBase, { fetchImpl: f });
  return { alreadyRunning: false, stop: () => child.kill("SIGTERM") };
}
```

- [ ] **Step 4: Run the relay tests to verify they pass**

Run: `cd tools/loadbench && bun test src/relayProcess.test.ts`
Expected: PASS.

- [ ] **Step 5: Onchain-infra precedence in `swarm.ts`**

In `src/swarm.ts` `main()`, replace the `if (args.anchor === "onchain") { … }` block and the relay line with:

```ts
  if (args.anchor === "onchain") {
    const e = readEnvLocal();
    const pkg = process.env.TUNNEL_PACKAGE_ID ?? e.TUNNEL_PACKAGE_ID;
    if (!pkg) throw new Error("onchain run needs a package id: pass --package-id or run `bun run stack`");
    env.PACKAGE_ID = pkg;
    env.SUI_NETWORK = process.env.SUI_NETWORK ?? e.SUI_NETWORK ?? "";
    env.SUI_RPC_URL = process.env.SUI_RPC_URL ?? e.SUI_RPC_URL ?? "";
    env.SUI_SETTLER_KEY = process.env.SUI_SETTLER_KEY ?? e.SUI_SETTLER_KEY;
  }

  const relay = args.channel === "relay" ? await ensureRelay({ wsUrl: process.env.MP_WS_URL }) : null;
```

- [ ] **Step 6: Onchain-infra precedence in `benchGame.ts`**

In `src/benchGame.ts` `main()`, replace the `if (args.anchor === "onchain") { … }` block and the relay line with:

```ts
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
    ctx.funder = funderFromEnv({ SUI_SETTLER_KEY: settlerKey });
  }
  let relay: { stop(): void } | null = null;
  if (args.channel === "relay") relay = await ensureRelay({ wsUrl: process.env.MP_WS_URL });
```

- [ ] **Step 7: Verify the full suite still passes and offchain still runs**

Run: `cd tools/loadbench && bun test`
Expected: PASS (onchain smoke skips when `.env.local` has no package id; everything else green). If the stack happens to be up, the smoke runs and passes.

Run: `cd tools/loadbench && bun run src/swarm.ts --offchain --channel local --duration 3`
Expected: prints the `[local/offchain]` swarm + resources lines; exits 0 (no infra needed, no behavior change for offchain).

- [ ] **Step 8: Commit**

```bash
git add tools/loadbench/src/relayProcess.ts tools/loadbench/src/relayProcess.test.ts tools/loadbench/src/swarm.ts tools/loadbench/src/benchGame.ts
git commit -m "feat(loadbench): take chain + relay infra by flag"
```

---

### Task 3: cli executor + package scripts

Wire `planRun` to execution: spawn the host run (`src/swarm.ts` / `src/benchGame.ts`) with infra `childEnv`, or the container re-exec. No infra orchestration. Repoint package scripts to the single `bench` entry.

**Files:**
- Modify: `tools/loadbench/src/cli.ts` (append executor + `import.meta.main` guard)
- Modify: `tools/loadbench/package.json:5-10`

**Interfaces:**
- Consumes: `planRun(argv, composeFile): RunPlan` (Task 1).
- Produces: a runnable `bun run src/cli.ts` entrypoint. No new exported symbols.

- [ ] **Step 1: Append the executor to `src/cli.ts`**

```ts
// ── executor ────────────────────────────────────────────────────────────────
import { spawn } from "node:child_process";

function run(cmd: string, cmdArgs: string[], extraEnv: Record<string, string>): void {
  const child = spawn(cmd, cmdArgs, { stdio: "inherit", env: { ...process.env, ...extraEnv } });
  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", (err) => { console.error(String(err?.message ?? err)); process.exit(1); });
}

function main(): void {
  const argv = process.argv.slice(2);
  const composeFile = new URL("../docker-compose.yml", import.meta.url).pathname;
  const plan = planRun(argv, composeFile);

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
```

- [ ] **Step 2: Repoint `package.json` scripts to the single entry**

Replace the `scripts` block in `tools/loadbench/package.json` with:

```json
  "scripts": {
    "bench": "bun run src/cli.ts",
    "stack": "bun run src/stack.ts",
    "test": "bun test"
  },
```

(Drops `swarm` and `bench:game`; keeps `stack` as the separate infra tool that writes `.env.local`, and `test`.)

- [ ] **Step 3: Verify unit suite still passes**

Run: `cd tools/loadbench && bun test src/cli.test.ts`
Expected: PASS — executor addition does not change `planRun`.

- [ ] **Step 4: Smoke the offchain host paths (no infra)**

Run: `cd tools/loadbench && bun run bench --offchain --channel local --duration 3`
Expected: swarm lines `[local/offchain] fleet: …`, `… aggregate move-TPS: …`, `… resources: …`; exits 0.

Run: `cd tools/loadbench && bun run bench --game blackjack --offchain --channel local --matches 2`
Expected: `[local/offchain] blackjack: … moves, … moves/s, p50=… p99=…` then `resources: …`; exits 0.

Run (error path): `cd tools/loadbench && bun run bench --cpus 4`
Expected: prints `--cpus only applies with --container` and exits 1.

- [ ] **Step 5: Commit**

```bash
git add tools/loadbench/src/cli.ts tools/loadbench/package.json
git commit -m "feat(loadbench): unified bench cli executor"
```

---

### Task 4: Container plumbing (cli entrypoint + resource overrides)

Point the image entrypoint at the cli and let `--cpus`/`--memory` override the compose limits per run via env interpolation. Infra reaches the container as `-e` vars from the host cli (Task 1) and, falling back, the mounted `.env.local` + compose `SUI_RPC_URL`; `process.env` precedence (Task 2) makes the in-container RPC resolve to `sui-localnet:9000` correctly.

**Files:**
- Modify: `tools/loadbench/Dockerfile:62`
- Modify: `tools/loadbench/docker-compose.yml:46-53`

**Interfaces:**
- Consumes: cli host dispatch (Task 3) — inside the container the cli sees no `--container`, so it runs `src/swarm.ts`/`src/benchGame.ts` directly. `runContainer` sets `BENCH_CPUS`/`BENCH_MEMORY` in the docker process env.

- [ ] **Step 1: Point the image entrypoint at the cli**

In `tools/loadbench/Dockerfile`, change the last line:

```dockerfile
ENTRYPOINT ["bun", "run", "src/cli.ts"]
```

- [ ] **Step 2: Interpolated limits in compose**

In `tools/loadbench/docker-compose.yml`, update the `loadbench` service `deploy.resources.limits` and the trailing comment/command:

```yaml
    deploy:
      resources:
        limits:
          # Overridden per run by the host cli via `--cpus` / `--memory`
          # (exported as BENCH_CPUS / BENCH_MEMORY before `docker compose run`).
          cpus: "${BENCH_CPUS:-4}"
          memory: "${BENCH_MEMORY:-4g}"
    # Default when run with no args: offchain burst. The host `bench --container …`
    # path passes explicit inner args. --channel relay is unsupported in-container.
    command: ["--channel", "local", "--anchor", "offchain", "--workers", "auto", "--duration", "10"]
```

(Leave `environment.SUI_RPC_URL: "http://sui-localnet:9000"` and the `.env.local`/`keys.json` read-only mounts as-is.)

- [ ] **Step 3: Verify compose resolves the interpolation both ways**

Run (default): `cd tools/loadbench && docker compose -f docker-compose.yml --profile bench config | grep -A4 -i 'limits'`
Expected: `cpus: "4"` and `memory: "4g"`.

Run (override): `cd tools/loadbench && BENCH_CPUS=8 BENCH_MEMORY=8g docker compose -f docker-compose.yml --profile bench config | grep -A4 -i 'limits'`
Expected: `cpus: "8"` and `memory: "8g"`.

- [ ] **Step 4: Build the image and smoke a container offchain run**

Run: `cd tools/loadbench && docker compose -f docker-compose.yml --profile bench build loadbench`
Expected: image builds successfully.

Run: `cd tools/loadbench && bun run bench --container --cpus 2 --memory 2g --offchain --channel local --duration 5`
Expected: host cli execs `docker compose … run --rm loadbench --channel local --anchor offchain --duration 5` with `BENCH_CPUS=2 BENCH_MEMORY=2g`; the container prints `[local/offchain] … aggregate move-TPS: …`; the `resources:` CPU peak stays at/below ~2 cores; exits 0.

- [ ] **Step 5: Commit**

```bash
git add tools/loadbench/Dockerfile tools/loadbench/docker-compose.yml
git commit -m "feat(loadbench): container cli entry + cpu/mem override"
```

---

### Task 5: README — one entry point, infra by flag

Rewrite the docs around `bench`. Replace the separate `swarm` / `bench:game` sections; document mode selection, infra flags, and the container flags.

**Files:**
- Modify: `tools/loadbench/README.md`

**Interfaces:**
- Consumes: the final cli surface (Tasks 1–4). No code.

- [ ] **Step 1: Replace the Commands section with a single `bench` section**

Edit `tools/loadbench/README.md` so the "Commands" section documents exactly one run entry point. It must cover:
- `bun run bench [flags]` is THE entry point. Default = aggregate move-TPS swarm; `--game <name>` = per-game open→play→settle latency; `--game all` = latency for every playable game.
- Defaults: `--channel local`, `--anchor onchain`, swarm mode. `--offchain` is the no-infra path.
- Infra is supplied by flag, with `.env.local` (written by `bun run stack`) as fallback: `--rpc-url`, `--package-id`, `--settler-key` for onchain; `--relay-url` for relay. State the precedence (flag → `.env.local`/env). Note the bench performs no stack bring-up — bring infra up yourself (`bun run stack` for a local one), then point `bench` at it.
- Relay: `--relay-url ws://…` connects to a running relay; omitted, the relay auto-spawns (`cargo run -p tunnel-manager`) as today.
- Container: `--container` re-execs the identical run inside the `loadbench` compose service; `--cpus N` / `--memory Ng` override the compose limits for that run; `--container` is incompatible with `--channel relay`. Infra flags pass through as `-e` vars.
- A worked examples block, e.g.:

````markdown
```bash
# pure engine burst — no infra (start here):
bun run bench --offchain --channel local --duration 10

# one game's latency, no infra:
bun run bench --game blackjack --offchain --channel local --matches 50

# onchain swarm against a local stack you brought up with `bun run stack`:
bun run bench --channel local --matches 40

# onchain against an explicit endpoint:
bun run bench --channel local --rpc-url http://127.0.0.1:9000 \
  --package-id 0x… --settler-key suiprivkey… --matches 40

# relay against a relay you're running:
bun run bench --channel relay --relay-url ws://127.0.0.1:8080/v1/mp --duration 10

# isolated in a container, capped at 8 cores / 8 GB:
bun run bench --container --cpus 8 --memory 8g --offchain --channel local --duration 10
```
````

- [ ] **Step 2: Update the Flags table and Container/Relay sections**

- In the Flags table, add rows for `--game <name|all>`, `--rpc-url`, `--package-id`, `--settler-key`, `--relay-url`, `--container`, `--cpus N`, `--memory Ng`; keep the existing swarm/bench flags but note they all now hang off `bench`.
- Rewrite the "Container" section so the documented invocation is `bun run bench --container …` (host-driven), not raw `docker compose … run`. Keep the note that `--channel relay` is host-only and that `.env.local`/`keys.json` are mounted read-only.
- Rewrite the "Relay specifics" section: `--relay-url` connects to a given relay; without it, auto-spawn with the in-memory store (REDIS_* stripped) as before.
- Update any "Prerequisites"/intro lines referencing `bun run swarm` / `bun run bench:game` to `bun run bench`. `bun run stack` stays documented as the separate, optional local-infra helper.

- [ ] **Step 3: Verify no stale command references remain**

Run: `cd tools/loadbench && grep -nE 'bun run (swarm|bench:game)' README.md`
Expected: no matches (exit status 1, no output).

- [ ] **Step 4: Commit**

```bash
git add tools/loadbench/README.md
git commit -m "docs(loadbench): single bench entry, infra by flag"
```

---

## Self-Review

**Spec coverage:**
- One entry point ⇒ Task 3 (scripts) + Task 1/3 (cli). ✅
- Swarm vs latency by flag ⇒ Task 1 (`--game`). ✅
- Benchmark pure / no infra orchestration ⇒ no `ensureStack` anywhere; cli only spawns the run or docker. ✅
- Infra through flags (rpc/package/settler/relay), with `.env.local` fallback ⇒ Task 1 (flags→env) + Task 2 (`process.env` precedence + relay wsUrl). ✅
- Relay auto-spawn preserved as fallback ⇒ Task 2 (`ensureRelay` keeps the no-`wsUrl` path). ✅
- Docker behind a flag + `--cpus`/`--memory` ⇒ Task 1 (container plan) + Task 4 (entrypoint + interpolation). ✅
- Docs ⇒ Task 5. ✅

**Placeholder scan:** No TBD/TODO; all code blocks complete; commands have expected output. ✅

**Type consistency:** `RunPlan`/`RunMode` defined in Task 1, consumed unchanged in Task 3. `planRun(argv, composeFile)` stable. `childEnv` (host) vs `dockerArgs`+`composeEnv` (container) consistent across tasks/tests. `ensureRelay({ wsUrl })` signature used identically in Task 2 swarm/benchGame edits and the relay test. `funderFromEnv({ SUI_SETTLER_KEY })` matches its existing definition (destructures `env.SUI_SETTLER_KEY`). ✅
