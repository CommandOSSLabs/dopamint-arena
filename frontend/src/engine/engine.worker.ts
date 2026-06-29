/**
 * Dedicated worker entry for ONE game window's tunnel client. Bridges raw `postMessage` to a
 * `PvpEngine`, and exposes a `MainBridge` proxy that RPCs privileged ops (wallet/storage)
 * back to the main thread, resolving on the matching `bridgeResult`.
 */
import type {
  ToEngine,
  FromEngine,
  MainBridge,
  BridgeMethod,
} from "./engineApi";
import { PvpEngine } from "./pvpEngine";
import { getSpec } from "./specs/registry";

const ctx = self as unknown as {
  postMessage(m: FromEngine): void;
  onmessage: ((ev: MessageEvent<ToEngine>) => void) | null;
};

let bridgeSeq = 0;
const pending = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();

function callBridge(method: BridgeMethod, ...args: unknown[]): Promise<unknown> {
  const id = ++bridgeSeq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ctx.postMessage({ t: "bridgeCall", id, method, args });
  });
}

// The worker calls bridge.openTunnel(...) etc.; each call becomes a bridgeCall RPC to main.
const bridge = new Proxy({} as MainBridge, {
  get:
    (_t, prop) =>
    (...args: unknown[]) =>
      callBridge(String(prop) as BridgeMethod, ...args),
});

const engine = new PvpEngine(bridge, (m) => ctx.postMessage(m), getSpec);

ctx.onmessage = (ev) => {
  const m = ev.data;
  if (m.t === "bridgeResult") {
    const p = pending.get(m.id);
    if (p) {
      pending.delete(m.id);
      if (m.ok) p.resolve(m.value);
      else p.reject(new Error(m.error));
    }
    return;
  }
  engine.handle(m);
};
