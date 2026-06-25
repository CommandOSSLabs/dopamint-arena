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
