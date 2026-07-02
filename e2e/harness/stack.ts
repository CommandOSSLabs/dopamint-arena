// Reusable localnet harness: boot a devstack stack (local Sui node + faucet, no
// indexer), publish the pruned `sui_tunnel` package, and expose the resolved
// RPC URL + packageId plus the party keypairs the tests sign with.
//
// Why bring-your-own signer accounts for the parties: the off-chain tunnel
// engine co-signs state updates with each party's key, so the tests must HOLD
// those keys. devstack's default `account('a')` is ephemeral (devstack keeps
// the key and never extracts it). So `settler`, `a`, and `b` are all
// `kind:'signer'` accounts funded by devstack — we keep the Ed25519Keypairs.
import { Effect, SubscriptionRef } from 'effect';
import {
  defineDevstack,
  runStack,
  sui,
  account,
  localPackage,
} from '@mysten-incubation/devstack';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { prunedSuiTunnel } from './prune.ts';

export interface TunnelStack {
  readonly rpcUrl: string;
  readonly packageId: string;
  readonly settlerKp: Ed25519Keypair;
  readonly players: { readonly a: Ed25519Keypair; readonly b: Ed25519Keypair };
  readonly bootMs: number;
  readonly protocolVersion: number;
  /** A jsonRpc SuiClient (the same class the SDK resolves `@mysten/sui/client`
   *  to via the shim) pointed at the localnet. */
  readonly client: SuiJsonRpcClient;
  stop(): Promise<void>;
}

const SUI = 1_000_000_000n; // MIST per SUI

/** Boot the localnet stack and publish the pruned package. Sets
 *  `process.env.PACKAGE_ID` (the SDK's `buildTarget()` reads it at call time)
 *  and `SUI_NETWORK=localnet`. */
export async function bootStack(): Promise<TunnelStack> {
  const settlerKp = new Ed25519Keypair();
  const aKp = new Ed25519Keypair();
  const bKp = new Ed25519Keypair();
  const prunedDir = prunedSuiTunnel();
  const runtimeRoot = mkdtempSync(join(tmpdir(), 'devstack-e2e-'));

  const settler = account('settler', {
    kind: 'signer',
    signer: settlerKp,
    funding: [{ coin: 'sui', amount: 5n * SUI }],
  });
  const a = account('a', { kind: 'signer', signer: aKp, funding: [{ coin: 'sui', amount: 2n * SUI }] });
  const b = account('b', { kind: 'signer', signer: bKp, funding: [{ coin: 'sui', amount: 2n * SUI }] });

  const stack = defineDevstack({
    members: [
      // RPC + faucet only; devstack's default vendored image (recent enough:
      // localnet protocol v126 satisfies the package's testnet-v1.73.1 dep).
      sui({ mode: 'local', indexer: false }),
      settler,
      a,
      b,
      localPackage('sui_tunnel', { sourcePath: prunedDir, publisher: settler }),
    ],
  });

  const handle = runStack(stack, {
    runtimeRoot,
    identity: { app: 'tunnel-e2e', stack: 'e2e', network: 'localnet' },
  });

  const t0 = Date.now();
  await Effect.runPromise(handle.start);
  const bootMs = Date.now() - t0;

  const snap: any = await Effect.runPromise(SubscriptionRef.get(handle.state));
  const rpcUrl: string | undefined = snap.endpoints?.find((e: any) => e.name === 'rpc')?.url;
  const packageId: string | undefined = snap.packages?.find((p: any) => p.name === 'sui_tunnel')?.packageId;
  if (!rpcUrl || !packageId) {
    await Effect.runPromise(handle.stop);
    await Effect.runPromise(handle.awaitShutdown);
    throw new Error('bootStack: could not read rpcUrl/packageId from projection');
  }

  // The SDK reads these at call time.
  process.env.PACKAGE_ID = packageId;
  process.env.SUI_NETWORK = 'localnet';

  const client = new SuiJsonRpcClient({ url: rpcUrl });
  const protocolVersion = await readProtocolVersion(rpcUrl);

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await Effect.runPromise(handle.stop);
    await Effect.runPromise(handle.awaitShutdown);
  };

  return { rpcUrl, packageId, settlerKp, players: { a: aKp, b: bKp }, bootMs, protocolVersion, client, stop };
}

async function readProtocolVersion(rpcUrl: string): Promise<number> {
  try {
    const r = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sui_getProtocolConfig', params: [] }),
    });
    const j: any = await r.json();
    return Number(j?.result?.protocolVersion ?? 0);
  } catch {
    return 0;
  }
}
