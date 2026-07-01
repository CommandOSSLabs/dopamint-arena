/**
 * Main-thread manager for the PvP tunnel worker. ONE shared "hub" worker serves ALL windows,
 * multiplexing every match over ONE relay socket (the `tunnel-pvp` worker). PvP windows don't each
 * spawn a worker — they are cheap store slots the hub fans snapshots to, keyed by windowId.
 *
 * Transport is Comlink (design §4): the worker exposes a typed API we `Comlink.wrap`; the bridge
 * and snapshot sinks are `Comlink.proxy`'d so the worker invokes them by reference. `dispose`
 * releases the wrapped API (`Comlink.releaseProxy`) and `terminate()`s the worker.
 */
import * as Comlink from "comlink";
import type {
  EngineConfig,
  GameId,
  MainBridge,
  MatchSnapshot,
  PvpHubApi,
  WorkerArenaEntry,
} from "./engineApi";
import { registerWindowDisposer } from "@/lib/windowSessions";
import { maxLiveWindows } from "./deviceTier";
import { elog } from "./debug";

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

/** A PvP window's store slot (the worker is the shared hub, not per-window). */
interface PvpWindow {
  snap: MatchSnapshot;
  listeners: Set<() => void>;
}

let bridge: MainBridge | null = null;
let config: EngineConfig | null = null;

const pvpWindows = new Map<string, PvpWindow>();

/**
 * Adaptive main-thread render throttle. The worker already coalesces its own snapshots, but with N
 * live windows the main thread still gets N independent streams — and each notify triggers a board
 * re-render. So we decouple "store the latest snapshot" (immediate, keeps getSnapshot fresh) from
 * "notify React" (throttled): a window re-renders at most once per `renderIntervalMs()`, which GROWS
 * with the live-window count so the TOTAL board-render rate stays ≈ constant no matter how many
 * windows are open. A status change (idle→playing→settled) and the trailing edge always notify, so
 * the UI never sticks on a stale frame.
 */
const RENDER_BASE_MS = 40; // single-window cadence (~25fps); ×N windows = the shared budget
const RENDER_MAX_MS = 250; // never starve a window below ~4fps, however many are open
interface SnapThrottle {
  lastNotifyMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  lastStatus: MatchSnapshot["status"] | null;
}
const snapThrottle = new Map<string, SnapThrottle>();

function renderIntervalMs(): number {
  const n = pvpWindows.size;
  return Math.min(RENDER_MAX_MS, Math.max(RENDER_BASE_MS, n * RENDER_BASE_MS));
}

/** Store `snap` on the window's slot immediately, then notify its React listeners on the throttled
 *  cadence (leading + trailing). `store` writes the slot; `listeners` are the subscribers. */
function deliverSnapshot(
  windowId: string,
  listeners: Set<() => void>,
  snap: MatchSnapshot,
  store: (s: MatchSnapshot) => void,
): void {
  store(snap);
  let t = snapThrottle.get(windowId);
  if (!t) {
    t = { lastNotifyMs: 0, timer: null, lastStatus: null };
    snapThrottle.set(windowId, t);
  }
  const throttle = t;
  const fire = (): void => {
    throttle.timer = null;
    throttle.lastNotifyMs = performance.now();
    for (const l of listeners) l();
  };
  const statusChanged = snap.status !== throttle.lastStatus;
  throttle.lastStatus = snap.status;
  const since = performance.now() - throttle.lastNotifyMs;
  const interval = renderIntervalMs();
  if (statusChanged || since >= interval) {
    if (throttle.timer) clearTimeout(throttle.timer);
    fire();
  } else if (throttle.timer === null) {
    throttle.timer = setTimeout(fire, interval - since);
  }
}

function clearSnapThrottle(windowId: string): void {
  const t = snapThrottle.get(windowId);
  if (t?.timer) clearTimeout(t.timer);
  snapThrottle.delete(windowId);
}

/** The single shared PvP hub worker + its wrapped API; null until the first PvP command spawns it. */
let hubWorker: Worker | null = null;
let hubApi: Comlink.Remote<PvpHubApi> | null = null;
let hubWired = false;

/** Called by EngineProvider/useConfigureEngine once the wallet is known. Idempotent, and it
 *  retroactively wires the hub if it spawned BEFORE the bridge was ready. */
export function configureEngine(
  cfg: EngineConfig,
  mainBridge: MainBridge,
): void {
  config = cfg;
  bridge = mainBridge;
  wireHub();
}

/** Fire a worker command without awaiting. The engine surfaces failures via the snapshot's
 *  `error` field (not the command's promise), so a rejection here is safe to swallow. */
function fire(p: Promise<unknown>): void {
  void p.catch(() => {});
}

// --- PvP lane: one shared hub worker for all windows ---------------------------------------

function wireHub(): void {
  if (hubWired || !hubApi || !config || !bridge) return;
  const onSnapshot = (windowId: string, snap: MatchSnapshot): void => {
    const w = pvpWindows.get(windowId);
    if (!w) return; // window disposed between the worker's emit and this callback
    deliverSnapshot(windowId, w.listeners, snap, (s) => {
      w.snap = s;
    });
  };
  fire(hubApi.init(config));
  fire(hubApi.attachBridge(Comlink.proxy(bridge)));
  fire(hubApi.subscribe(Comlink.proxy(onSnapshot)));
  hubWired = true;
  elog("client", "wired pvp hub");
}

/** Spawn (once) the shared PvP hub worker. */
function ensureHub(): Comlink.Remote<PvpHubApi> {
  if (hubApi) return hubApi;
  hubWorker = new Worker(new URL("./engine.pvp.worker.ts", import.meta.url), {
    type: "module",
    name: "[pvp-hub] all-pvp-matches",
  });
  hubApi = Comlink.wrap<PvpHubApi>(hubWorker);
  hubWired = false;
  elog("client", "spawn pvp hub", { configured: !!(config && bridge) });
  wireHub();
  return hubApi;
}

/** Ensure a PvP window's store slot + its window-close disposer. */
function ensurePvpWindow(windowId: string): PvpWindow {
  let w = pvpWindows.get(windowId);
  if (w) return w;
  w = { snap: IDLE_SNAPSHOT, listeners: new Set() };
  pvpWindows.set(windowId, w);
  registerWindowDisposer(windowId, "engine", () => disposeWindow(windowId));
  return w;
}

// --- dispose ------------------------------------------------------------------------------

function disposeWindow(windowId: string): void {
  const w = pvpWindows.get(windowId);
  if (!w) return;
  pvpWindows.delete(windowId);
  clearSnapThrottle(windowId);
  // Tear this window's match down inside the hub (cancels a queued open, releases the matchId from
  // the shared socket, and closes the socket if it was the last session). Then, if no PvP windows
  // remain, terminate the hub worker to reclaim its isolate (re-spawned on the next PvP command).
  const api = hubApi;
  const finishIfEmpty = (): void => {
    if (pvpWindows.size > 0 || !hubWorker) return;
    hubApi?.[Comlink.releaseProxy]();
    hubWorker.terminate();
    hubWorker = null;
    hubApi = null;
    hubWired = false;
  };
  if (api) api.reset(windowId).then(finishIfEmpty, finishIfEmpty);
  else finishIfEmpty();
}

// --- public surface (the React bindings call these) ---------------------------------------

export const engineClient = {
  /** Subscribe to a window's snapshot store (the shared hub fans this window's snapshots here). */
  subscribe(windowId: string, cb: () => void): () => void {
    const w = ensurePvpWindow(windowId);
    w.listeners.add(cb);
    return () => w.listeners.delete(cb);
  },

  getSnapshot(windowId: string): MatchSnapshot {
    return pvpWindows.get(windowId)?.snap ?? IDLE_SNAPSHOT;
  },

  /** Live PvP window slots vs the device live-window guideline — surfaced by the perf HUD. The PvP
   *  hub is a single shared isolate, so windows never contend for per-window workers (`atCap` false). */
  liveWindowStats(): { live: number; max: number; atCap: boolean } {
    return { live: pvpWindows.size, max: maxLiveWindows(), atCap: false };
  },

  // PvP commands → shared hub.
  findMatch(windowId: string, gameId: GameId, setup?: unknown): void {
    ensurePvpWindow(windowId);
    fire(ensureHub().findMatch(windowId, gameId, setup));
  },
  resume(windowId: string, gameId: GameId): void {
    ensurePvpWindow(windowId);
    fire(ensureHub().resume(windowId, gameId));
  },
  /** Arena entry (ADR-0028): hand the worker a fleet allocation (pre-opened tunnel + main-minted key)
   *  to join + play, instead of quickMatch + open. Funding already happened on main (batched PTB). */
  enterArenaMatch(
    windowId: string,
    gameId: GameId,
    entry: WorkerArenaEntry,
  ): void {
    ensurePvpWindow(windowId);
    fire(ensureHub().enterArenaMatch(windowId, gameId, entry));
  },
  submitInput(windowId: string, input: unknown): void {
    if (hubApi) fire(hubApi.submitInput(windowId, input));
  },
  setAuto(windowId: string, on: boolean): void {
    if (hubApi) fire(hubApi.setAuto(windowId, on));
  },
  setVisibility(windowId: string, visible: boolean): void {
    if (hubApi) fire(hubApi.setVisibility(windowId, visible));
  },
  reset(windowId: string): void {
    if (hubApi) fire(hubApi.reset(windowId));
  },
  /** Terminate a window's match in the hub and reclaim (also auto-run on window close). */
  dispose(windowId: string): void {
    disposeWindow(windowId);
  },
  disposeWindow(windowId: string): void {
    disposeWindow(windowId);
  },
};
