import type { Transport } from "../../../../sui-tunnel-ts/src/core/distributedTunnel";

/** Two transports wired back-to-back in memory. No server, no network.
 *  Delivery is deferred to a microtask so a `send` inside an `onFrame` does not
 *  recurse on the C stack — matching the relay's async delivery semantics. */
export function pairLocalChannel(): [Transport, Transport] {
  let cbA: ((f: Uint8Array) => void) | null = null;
  let cbB: ((f: Uint8Array) => void) | null = null;
  const a: Transport = {
    send: (f) => queueMicrotask(() => cbB?.(f)),
    onFrame: (cb) => { cbA = cb; },
  };
  const b: Transport = {
    send: (f) => queueMicrotask(() => cbA?.(f)),
    onFrame: (cb) => { cbB = cb; },
  };
  return [a, b];
}
