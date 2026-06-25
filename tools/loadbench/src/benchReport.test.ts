import { test, expect } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { PLAYABLE } from "./games";

const REPORTS = new URL("../reports", import.meta.url).pathname;
const CLI = new URL("./cli.ts", import.meta.url).pathname;

// Offchain needs no stack, so this exercises the full --game all → multi-core
// swarm → report wiring (per-game fleet, aggregate, file write) without infra.
// Small fixed fleet + 1 match keeps it fast and deterministic.
test("offchain --game all writes a markdown report listing every game", () => {
  const env = "reporttest";
  const prefix = `bench-${env}-local-offchain-`;
  if (existsSync(REPORTS)) {
    for (const f of readdirSync(REPORTS)) if (f.startsWith(prefix)) rmSync(`${REPORTS}/${f}`);
  }

  execFileSync(
    "bun",
    ["run", CLI, "--game", "all", "--offchain", "--channel", "local", "--workers", "2", "--matches", "1"],
    { env: { ...process.env, LOADBENCH_ENV: env }, encoding: "utf8", timeout: 120_000 },
  );

  const written = readdirSync(REPORTS).filter((f) => f.startsWith(prefix) && f.endsWith(".md"));
  expect(written.length).toBeGreaterThan(0);
  const md = readFileSync(`${REPORTS}/${written[0]}`, "utf8");
  for (const g of PLAYABLE) expect(md).toContain(`| ${g} |`);
  expect(md).toContain("## Aggregate");
}, 120_000);
