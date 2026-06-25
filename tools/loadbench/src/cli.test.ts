import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { planRun } from "./cli";

const COMPOSE = "/repo/tools/loadbench/docker-compose.yml";
const PROJECT = "loadbench-feat-x";
const CLI = new URL("./cli.ts", import.meta.url).pathname;

test("--help prints usage and exits 0 without running a benchmark", () => {
  const out = execFileSync("bun", ["run", CLI, "--help"], { encoding: "utf8" });
  expect(out).toContain("Usage: bun run bench");
  expect(out).toContain("--game all");
  expect(out).toContain("--container");
});

test("defaults to a host swarm run, local+onchain, no infra env", () => {
  expect(planRun([], COMPOSE, PROJECT)).toEqual({
    kind: "host",
    mode: "swarm",
    innerArgv: ["--channel", "local", "--anchor", "onchain"],
    childEnv: {},
  });
});

test("offchain local swarm forwards swarm tuning, no infra env", () => {
  expect(
    planRun(["--offchain", "--channel", "local", "--workers", "auto", "--duration", "10"], COMPOSE, PROJECT),
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
    PROJECT,
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
  const plan = planRun(["--channel", "relay", "--relay-url", "ws://r:8080/v1/mp"], COMPOSE, PROJECT) as Extract<
    ReturnType<typeof planRun>,
    { kind: "host" }
  >;
  expect(plan.childEnv).toEqual({ MP_WS_URL: "ws://r:8080/v1/mp" });
});

test("--game selects latency mode and emits a positional game name", () => {
  expect(
    planRun(["--game", "blackjack", "--offchain", "--channel", "local", "--matches", "5"], COMPOSE, PROJECT),
  ).toEqual({
    kind: "host",
    mode: "game",
    innerArgv: ["blackjack", "--channel", "local", "--anchor", "offchain", "--matches", "5"],
    childEnv: {},
  });
});

test("--game all routes to the multi-core swarm with --all", () => {
  const plan = planRun(["--game", "all", "--offchain"], COMPOSE, PROJECT) as Extract<
    ReturnType<typeof planRun>,
    { kind: "host" }
  >;
  expect(plan.mode).toBe("swarm");
  expect(plan.innerArgv).toEqual(["--all", "--channel", "local", "--anchor", "offchain"]);
});

test("--game all forwards fleet + duration tuning to the swarm", () => {
  const plan = planRun(
    ["--game", "all", "--offchain", "--workers", "8", "--duration", "10"],
    COMPOSE,
    PROJECT,
  ) as Extract<ReturnType<typeof planRun>, { kind: "host" }>;
  expect(plan.mode).toBe("swarm");
  expect(plan.innerArgv).toEqual([
    "--all", "--channel", "local", "--anchor", "offchain", "--workers", "8", "--duration", "10",
  ]);
});

test("rejects --duration in single-game latency mode", () => {
  expect(() => planRun(["--game", "blackjack", "--duration", "10"], COMPOSE, PROJECT)).toThrow(
    /--duration is not valid in --game/,
  );
});

test("--container re-execs in the env project with -p, resource env, -e infra, stripped inner argv", () => {
  const plan = planRun(
    ["--container", "--cpus", "8", "--memory", "8g", "--rpc-url", "http://sui:9000", "--duration", "10"],
    COMPOSE,
    PROJECT,
  );
  expect(plan).toEqual({
    kind: "container",
    innerArgv: ["--channel", "local", "--anchor", "onchain", "--duration", "10"],
    dockerArgs: [
      "compose", "-f", COMPOSE, "-p", PROJECT, "--profile", "bench", "run", "--rm",
      "-e", "SUI_RPC_URL=http://sui:9000",
      "loadbench",
      "--channel", "local", "--anchor", "onchain", "--duration", "10",
    ],
    composeEnv: { BENCH_CPUS: "8", BENCH_MEMORY: "8g" },
  });
});

test("rejects swarm-only flags in --game mode", () => {
  expect(() => planRun(["--game", "blackjack", "--workers", "4"], COMPOSE, PROJECT)).toThrow(
    /--workers is not valid in --game/,
  );
});

test("rejects --cpus without --container", () => {
  expect(() => planRun(["--cpus", "4"], COMPOSE, PROJECT)).toThrow(/--cpus only applies with --container/);
});

test("rejects --container with relay", () => {
  expect(() => planRun(["--container", "--channel", "relay"], COMPOSE, PROJECT)).toThrow(
    /relay is not supported in --container/,
  );
});

test("rejects unknown flags", () => {
  expect(() => planRun(["--frobnicate"], COMPOSE, PROJECT)).toThrow(/unknown flag: --frobnicate/);
});
