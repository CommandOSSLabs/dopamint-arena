// Spawn the tunnel-manager relayer (backend/tunnel-manager, Rust) as a child process in its
// in-memory mode (no Redis) and health-gate it, for the full-stack relay tier (T5).
//
// Why self-spawned, not a devstack `hostService`: the relay `/v1/mp` lane is chain-blind, so
// it needs no resolved stack values at config time — but it DOES need a direct loopback port
// for a raw WebSocket upgrade (devstack's host-service endpoint is HTTP-router-fronted), and
// its in-memory store is selected purely by leaving REDIS_CACHE_URL unset. A plain child
// process gives us the loopback port + lifecycle directly, and lets us inject the localnet
// RPC/package resolved AFTER boot (which static hostService env cannot carry).
//
// The relayer's own on-chain settle path is intentionally NOT exercised here: its close PTB
// pins the testnet genesis chain digest (sui.rs), so relayer-sponsored settle cannot execute
// on localnet. T5 settles client-side; the relay is pure transport.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

/** The built relayer binary (prefer release), or null if neither profile is built. */
export function relayerBinaryPath(): string | null {
  for (const rel of ['target/release/tunnel-manager', 'target/debug/tunnel-manager']) {
    const abs = resolve(REPO_ROOT, rel);
    if (existsSync(abs)) return abs;
  }
  return null;
}

/** Ask the OS for a free loopback port (closed before the relayer binds it). */
function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => res(port));
    });
  });
}

export interface Relayer {
  wsUrl: string;
  httpBase: string;
  stop(): Promise<void>;
}

/** Boot the relayer in-memory wired to the localnet RPC + package, and wait for /healthz 200. */
export async function startRelayer(opts: {
  rpcUrl: string;
  packageId: string;
  binary: string;
}): Promise<Relayer> {
  const port = await freePort();
  const addr = `127.0.0.1:${port}`;

  const env: Record<string, string | undefined> = {
    ...process.env,
    TUNNEL_MANAGER_ADDR: addr,
    SUI_RPC_URL: opts.rpcUrl,
    TUNNEL_PACKAGE_ID: opts.packageId,
    // Throwaway, never-funded ed25519 secret (base64 of 32 raw bytes). The relay /v1/mp lane
    // never signs, so this only has to PARSE (load_ed25519, backend/tunnel-manager/src/sui.rs);
    // it is never used to submit a tx and is never logged.
    SUI_SETTLER_KEY: Buffer.alloc(32, 0x2a).toString('base64'),
    // Walrus is required-at-boot but only used by the settle/archive path (unused here).
    WALRUS_PUBLISHER_URL: 'http://127.0.0.1:1',
    WALRUS_AGGREGATOR_URL: 'http://127.0.0.1:1',
    RUST_LOG: process.env.RUST_LOG ?? 'warn',
  };
  // Force the in-memory store: REDIS_CACHE_URL must be unset (and don't inherit a stray one).
  delete env.REDIS_CACHE_URL;
  delete env.REDIS_PUBSUB_URL;

  // cwd outside the repo so the relayer's dotenvy::dotenv() (which walks parent dirs) cannot
  // pick up a stray repo .env and override our explicit, in-memory configuration.
  const child: ChildProcess = spawn(opts.binary, [], {
    cwd: tmpdir(),
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });

  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let stderr = '';
  child.stderr?.on('data', (d) => {
    stderr += String(d);
  });
  child.once('exit', (code, signal) => {
    exited = { code, signal };
  });

  const httpBase = `http://${addr}`;
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (exited) {
      throw new Error(
        `relayer exited at startup (code ${exited.code}, signal ${exited.signal})\n${stderr.slice(-800)}`,
      );
    }
    try {
      const r = await fetch(`${httpBase}/healthz`);
      if (r.ok) break;
    } catch {
      /* socket not up yet */
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`relayer not healthy at ${httpBase}/healthz after 30s\n${stderr.slice(-800)}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  return {
    wsUrl: `ws://${addr}/v1/mp`,
    httpBase,
    async stop() {
      if (exited) return;
      child.kill('SIGTERM');
      await new Promise<void>((res) => {
        const t = setTimeout(() => {
          child.kill('SIGKILL');
          res();
        }, 3000);
        child.once('exit', () => {
          clearTimeout(t);
          res();
        });
      });
    },
  };
}
