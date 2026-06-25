import { execFileSync } from "node:child_process";
import { homedir } from "node:os";

/** Lowercase, replace runs of non-alphanumerics with a single dash, trim, cap at 40. */
export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

/** Human-readable env name: $LOADBENCH_ENV if set, else the git branch slug, else "default". */
export function envName(): string {
  const override = process.env.LOADBENCH_ENV?.trim();
  if (override) return slug(override) || "default";
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (branch && branch !== "HEAD") return slug(branch) || "default";
  } catch {
    // not a git repo / git unavailable
  }
  return "default";
}

export function project(name: string = envName()): string {
  return `loadbench-${name}`;
}

/** Per-stack sui CLI config dir — isolates env/keystore/active-address from the global ~/.sui. */
export function suiConfigDir(name: string = envName()): string {
  return `${homedir()}/.loadbench/${name}/sui_config`;
}

function fnv1a(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface BenchPorts {
  rpc: number;
  faucet: number;
  valkey: number;
  relay: number;
  slot: number;
}

/** Deterministic, non-overlapping host ports for this env. slot = fnv1a(name) % 100. */
export function ports(name: string = envName()): BenchPorts {
  const slot = fnv1a(name) % 100;
  return { rpc: 9000 + slot, valkey: 9200 + slot, relay: 9300 + slot, faucet: 9400 + slot, slot };
}
