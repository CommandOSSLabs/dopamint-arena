// One process-wide batcher so every game window's open coalesces into a single flush. The wallet
// deps change as the account connects, so the singleton reads them lazily from a module ref that
// the solo hook refreshes each render (mirrors the out-of-React solo-session singletons).
import {
  TunnelOpenBatcher,
  type BatcherDeps,
  type TunnelOpenRequest,
} from "./tunnelOpenBatcher";

let currentDeps: BatcherDeps | null = null;
// Coalescing window. The legacy main-thread solo path issues all its opens in the SAME render tick,
// so the 30ms default coalesced them. The WORKER path's opens instead arrive spread over ~1-2s —
// each game window lazily spawns its own worker, then `findSolo` RPCs back across the Comlink bridge
// to call `requestTunnelOpen` — so a 30ms window flushed each ALONE (`openSingle`), firing a
// separate sponsored tx per game that then equivocates on the shared gas object. A wider window lets
// those spread opens still coalesce into ONE `openAndFundMany` PTB (one sponsored tx), which is the
// reason the legacy path never equivocates. Startup cost: a solo game shows "funding" up to this
// long before its (coalesced) open lands — fine for an auto-play arena.
const SOLO_OPEN_COALESCE_MS = 2000;
const batcher = new TunnelOpenBatcher(() => currentDeps, {
  flushDelayMs: SOLO_OPEN_COALESCE_MS,
});

/** Refresh the wallet-bound deps the next flush will use. Call each render with the latest signer. */
export function configureSharedBatcher(deps: BatcherDeps | null): void {
  currentDeps = deps;
}

/** Enroll a tunnel open in the shared coalescing flush. */
export function requestTunnelOpen(req: TunnelOpenRequest): Promise<string> {
  return batcher.request(req);
}
