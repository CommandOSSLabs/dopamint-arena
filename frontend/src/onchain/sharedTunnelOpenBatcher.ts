// One process-wide batcher so every game window's open coalesces into a single flush. The wallet
// deps change as the account connects, so the singleton reads them lazily from a module ref that
// the solo hook refreshes each render (mirrors the out-of-React solo-session singletons).
import {
  TunnelOpenBatcher,
  type BatcherDeps,
  type TunnelOpenRequest,
} from "./tunnelOpenBatcher";

let currentDeps: BatcherDeps | null = null;
const batcher = new TunnelOpenBatcher(() => currentDeps);

/** Refresh the wallet-bound deps the next flush will use. Call each render with the latest signer. */
export function configureSharedBatcher(deps: BatcherDeps | null): void {
  currentDeps = deps;
}

/** Enroll a tunnel open in the shared coalescing flush. */
export function requestTunnelOpen(req: TunnelOpenRequest): Promise<string> {
  return batcher.request(req);
}
