/**
 * Main-thread manager for the per-game-window tunnel workers. Spawns ONE dedicated worker
 * per `windowId` (lazy, on first command), keeps that window's latest snapshot for
 * `useSyncExternalStore`, routes the worker's privileged `bridgeCall`s to the configured
 * `MainBridge`, and terminates the worker on dispose.
 *
 * Transport is raw `postMessage` with the typed `ToEngine`/`FromEngine` envelopes — no
 * Comlink dependency. The bridge is a single per-user instance (wallet is per-user), set
 * once by `EngineProvider`; every window's worker shares it.
 */
import type {
  ToEngine,
  FromEngine,
  MainBridge,
  MatchSnapshot,
  EngineConfig,
  GameId,
  BridgeMethod,
} from "./engineApi";
import { registerWindowDisposer } from "@/lib/windowSessions";
import { maxLiveWindows } from "./deviceTier";

const IDLE_SNAPSHOT: MatchSnapshot = {
  status: "idle",
  role: null,
  auto: true,
  stake: 0,
  view: null,
  winner: null,
  opponentWallet: null,
  tunnelId: null,
  connStatus: "closed",
  error: null,
};

/**
 * Returned for a NEW window the device live-window cap (design §2.1) refused to spawn — never
 * for one with a live worker. A stable singleton so `useSyncExternalStore` sees a constant
 * reference. TODO(ui): branch on `snap.capped` in the game window to render an SSE-spectate
 * tile (design §2.1 escape hatch) instead of an interactive match; today the snapshot only
 * surfaces the capped state, the worker is simply never spawned.
 */
const CAPPED_SNAPSHOT: MatchSnapshot = {
  ...IDLE_SNAPSHOT,
  status: "error",
  error: "device live-window cap reached",
  capped: true,
};

interface WindowEntry {
  worker: Worker;
  snap: MatchSnapshot;
  listeners: Set<() => void>;
}

let bridge: MainBridge | null = null;
let config: EngineConfig | null = null;
const windows = new Map<string, WindowEntry>();

/** Called once by EngineProvider after the wallet is known. */
export function configureEngine(cfg: EngineConfig, mainBridge: MainBridge): void {
  config = cfg;
  bridge = mainBridge;
}

function post(worker: Worker, msg: ToEngine): void {
  worker.postMessage(msg);
}

async function handleBridgeCall(
  worker: Worker,
  id: number,
  method: BridgeMethod,
  args: readonly unknown[],
): Promise<void> {
  if (!bridge) {
    post(worker, { t: "bridgeResult", id, ok: false, error: "engine bridge not configured" });
    return;
  }
  try {
    const fn = bridge[method] as (...a: readonly unknown[]) => Promise<unknown>;
    const value = await fn(...args);
    post(worker, { t: "bridgeResult", id, ok: true, value });
  } catch (e) {
    post(worker, { t: "bridgeResult", id, ok: false, error: String((e as Error)?.message ?? e) });
  }
}

function spawn(windowId: string): WindowEntry {
  const worker = new Worker(new URL("./engine.worker.ts", import.meta.url), {
    type: "module",
    name: `tunnel-${windowId}`,
  });
  const entry: WindowEntry = { worker, snap: IDLE_SNAPSHOT, listeners: new Set() };
  worker.onmessage = (ev: MessageEvent<FromEngine>) => {
    const m = ev.data;
    if (m.t === "snapshot") {
      entry.snap = m.snap;
      for (const l of entry.listeners) l();
    } else if (m.t === "bridgeCall") {
      void handleBridgeCall(worker, m.id, m.method, m.args);
    }
  };
  if (config) post(worker, { t: "init", config });
  windows.set(windowId, entry);
  // Tear the worker down on explicit window close (mirrors the legacy session disposer); a
  // mere React remount/minimize keeps it alive so the match survives in the background.
  registerWindowDisposer(windowId, "engine", () => disposeWindow(windowId));
  return entry;
}

function disposeWindow(windowId: string): void {
  const entry = windows.get(windowId);
  if (entry) {
    entry.worker.terminate();
    windows.delete(windowId);
  }
}

/**
 * Returns the window's worker entry, spawning it lazily on first use — unless the device
 * live-window cap (design §2.1) is already reached for a NEW window, in which case it returns
 * null so the caller surfaces `CAPPED_SNAPSHOT` instead of oversubscribing per-worker memory.
 * An already-live window is always returned (it counts toward the cap, doesn't re-check it).
 */
function getOrSpawn(windowId: string): WindowEntry | null {
  const existing = windows.get(windowId);
  if (existing) return existing;
  if (windows.size >= maxLiveWindows()) return null;
  return spawn(windowId);
}

export const engineClient = {
  subscribe(windowId: string, cb: () => void): () => void {
    const entry = getOrSpawn(windowId);
    // Capped: no worker to listen to. `getSnapshot` returns CAPPED_SNAPSHOT; a no-op
    // unsubscribe keeps the store consistent.
    if (!entry) return () => {};
    entry.listeners.add(cb);
    return () => {
      entry.listeners.delete(cb);
    };
  },
  getSnapshot(windowId: string): MatchSnapshot {
    const entry = windows.get(windowId);
    if (entry) return entry.snap;
    // No worker yet: report the cap if we're at it (so a new window can't spawn), else idle.
    return windows.size >= maxLiveWindows() ? CAPPED_SNAPSHOT : IDLE_SNAPSHOT;
  },
  findMatch(windowId: string, gameId: GameId, setup?: unknown): void {
    const entry = getOrSpawn(windowId);
    if (entry) post(entry.worker, { t: "findMatch", gameId, setup });
  },
  resume(windowId: string, gameId: GameId): void {
    const entry = getOrSpawn(windowId);
    if (entry) post(entry.worker, { t: "resume", gameId });
  },
  submitInput(windowId: string, input: unknown): void {
    const entry = windows.get(windowId);
    if (entry) post(entry.worker, { t: "submitInput", input });
  },
  setAuto(windowId: string, on: boolean): void {
    const entry = windows.get(windowId);
    if (entry) post(entry.worker, { t: "setAuto", on });
  },
  setVisibility(windowId: string, visible: boolean): void {
    const entry = windows.get(windowId);
    if (entry) post(entry.worker, { t: "setVisibility", visible });
  },
  reset(windowId: string): void {
    const entry = windows.get(windowId);
    if (entry) post(entry.worker, { t: "reset" });
  },
  /** Terminate a window's worker and reclaim its memory (also auto-run on window close). */
  dispose(windowId: string): void {
    disposeWindow(windowId);
  },
};
