import { spawn, type ChildProcess } from "node:child_process";
import { readEnvLocal } from "./env";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** WebSocket URL for the relay multiplexer.
 *  Override with MP_WS_URL when pointing at a remote relay. */
export function relayWsUrl(): string {
  return process.env.MP_WS_URL ?? "ws://127.0.0.1:8080/v1/mp";
}

/** Poll GET <httpBase>/healthz until the relay is up or tries are exhausted.
 *  fetchImpl is injectable so unit tests never touch the network. */
export async function waitHealthy(
  httpBase: string,
  opts: { fetchImpl?: typeof fetch; intervalMs?: number; tries?: number } = {},
): Promise<void> {
  const f = opts.fetchImpl ?? fetch;
  const tries = opts.tries ?? 60;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await f(`${httpBase}/healthz`);
      if (r.ok) return;
    } catch {
      // relay not yet listening
    }
    await sleep(opts.intervalMs ?? 1000);
  }
  throw new Error(`relay not healthy at ${httpBase} after ${tries} tries`);
}

/** Return a running relay handle, spawning one if none is up.
 *
 *  If the relay is already healthy the returned handle has alreadyRunning:true
 *  and stop() is a no-op.  Otherwise `cargo run -q -p tunnel-manager` is
 *  launched from the repo root with env from .env.local, with REDIS_* vars
 *  stripped so the relay defaults to its in-memory store. */
export async function ensureRelay(
  opts: { httpBase?: string; fetchImpl?: typeof fetch } = {},
): Promise<{ alreadyRunning: boolean; stop(): void }> {
  const httpBase = opts.httpBase ?? "http://127.0.0.1:8080";
  const f = opts.fetchImpl ?? fetch;

  try {
    if ((await f(`${httpBase}/healthz`)).ok) {
      return { alreadyRunning: true, stop() {} };
    }
  } catch {
    // not running yet — fall through to spawn
  }

  // Build child env: process env + .env.local overrides, bound to localhost,
  // REDIS_* absent so tunnel-manager selects the in-memory store.
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...readEnvLocal(),
    TUNNEL_MANAGER_ADDR: "127.0.0.1:8080",
  };
  delete env.REDIS_CACHE_URL;
  delete env.REDIS_PUBSUB_URL;

  const repoRoot = new URL("../../../..", import.meta.url).pathname;
  const child: ChildProcess = spawn(
    "cargo",
    ["run", "-q", "-p", "tunnel-manager"],
    { cwd: repoRoot, env, stdio: "inherit" },
  );

  await waitHealthy(httpBase, { fetchImpl: f });
  return { alreadyRunning: false, stop: () => child.kill("SIGTERM") };
}
