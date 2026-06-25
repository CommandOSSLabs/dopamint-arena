import { test, expect, afterEach } from "bun:test";
import { homedir } from "node:os";
import { slug, envName, project, suiConfigDir, ports } from "./benchEnv";

const ORIG = process.env.LOADBENCH_ENV;
afterEach(() => {
  if (ORIG === undefined) delete process.env.LOADBENCH_ENV;
  else process.env.LOADBENCH_ENV = ORIG;
});

test("slug lowercases and dashes non-alphanumerics, trims, caps length", () => {
  expect(slug("feat/Local-Bench_Stack")).toBe("feat-local-bench-stack");
  expect(slug("  weird//name!! ")).toBe("weird-name");
  expect(slug("a".repeat(60)).length).toBe(40);
});

test("envName honors LOADBENCH_ENV override (slugified)", () => {
  process.env.LOADBENCH_ENV = "Alice/Onchain";
  expect(envName()).toBe("alice-onchain");
});

test("project prefixes the name", () => {
  expect(project("feat-x")).toBe("loadbench-feat-x");
});

test("suiConfigDir is under ~/.loadbench/<name>", () => {
  expect(suiConfigDir("feat-x")).toBe(`${homedir()}/.loadbench/feat-x/sui_config`);
});

test("ports are deterministic and land in non-overlapping bands", () => {
  const a = ports("feat-x");
  const b = ports("feat-x");
  expect(a).toEqual(b); // deterministic
  for (const name of ["dev", "feat-x", "main", "alice", "default"]) {
    const p = ports(name);
    expect(p.slot).toBeGreaterThanOrEqual(0);
    expect(p.slot).toBeLessThan(100);
    expect(p.rpc).toBe(9000 + p.slot);
    expect(p.valkey).toBe(9200 + p.slot);
    expect(p.relay).toBe(9300 + p.slot);
    expect(p.faucet).toBe(9400 + p.slot);
    // bands: rpc 9000-9099, valkey 9200-9299, relay 9300-9399, faucet 9400-9499 — disjoint
    expect(p.rpc).toBeLessThan(9100);
    expect(p.faucet).toBeGreaterThanOrEqual(9400);
  }
});
