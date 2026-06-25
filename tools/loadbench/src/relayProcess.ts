import { spawn, type ChildProcess } from "node:child_process";
import { readEnvLocal } from "./env";
import { ports } from "./benchEnv";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** WebSocket URL for the relay multiplexer.
 *  Override with MP_WS_URL when pointing at a remote relay. */
export function relayWsUrl(): string {
  return process.env.MP_WS_URL ?? `ws://127.0.0.1:${ports().relay}/v1/mp`;
}

/** Derive the relay's HTTP origin (for /healthz) from its ws(s) URL. */
export function httpBaseFromWs(wsUrl: string): string {
  const u = new URL(wsUrl);
  const proto = u.protocol === "wss:" ? "https:" : "http:";
  return `${proto}//${u.host}`;
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
 *  When `wsUrl` is supplied the relay is assumed to be externally managed:
 *  probe its health and return immediately — never spawn.  Without `wsUrl`
 *  the existing behaviour applies: probe localhost, then cargo-spawn as
 *  fallback with REDIS_* stripped so tunnel-manager uses its in-memory store. */
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

  const relayPort = ports().relay;
  const httpBase = opts.httpBase ?? `http://127.0.0.1:${relayPort}`;
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
    TUNNEL_MANAGER_ADDR: `127.0.0.1:${relayPort}`,
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
