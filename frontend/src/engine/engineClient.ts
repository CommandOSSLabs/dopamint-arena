/**
 * Main-thread manager for the tunnel workers, across TWO lanes (M1):
 *  - SOLO (self-play): ONE dedicated worker per game window — pure crypto, no relay socket, so each
 *    window stays isolated (and parallel across cores).
 *  - PvP: ONE shared "hub" worker for ALL windows, multiplexing every match over ONE relay socket
 *    (the `tunnel-pvp` worker). PvP windows don't each spawn a worker — they're cheap.
 *
 * A window's lane is fixed by which binding it uses (`useGameMatch` → pvp, `useGameSolo` → solo),
 * declared via {@link engineClient.subscribe}'s `lane` arg; commands then route by it. Snapshots feed
 * `useSyncExternalStore`: solo workers emit `(snap)`, the hub emits `(windowId, snap)` which the
 * manager fans to the right window's listeners.
 *
 * Transport is Comlink (design §4): each worker exposes a typed API we `Comlink.wrap`; the bridge
 * and snapshot sinks are `Comlink.proxy`'d so the worker invokes them by reference. `dispose`
 * releases the wrapped API (`Comlink.releaseProxy`) and `terminate()`s the worker.
 */
import * as Comlink from "comlink";
import type {
  EngineConfig,
  GameId,
  Lane,
  MainBridge,
  MatchSnapshot,
  PvpHubApi,
  SoloEngineApi,
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

/**
 * Returned for a NEW solo window the device live-window cap (design §2.1) refused to spawn. A
 * stable singleton so `useSyncExternalStore` sees a constant reference. PvP windows are never capped
 * — they share the one hub worker, so they cost no extra isolate.
 * TODO(ui/design §2.1): offscreen-worker teardown (IntersectionObserver), capped-window re-admit on
 * slot-free, and an SSE-spectate tile remain follow-ups; today a capped solo window just isn't spawned.
 */
const CAPPED_SNAPSHOT: MatchSnapshot = {
  ...IDLE_SNAPSHOT,
  status: "error",
  error: "device live-window cap reached",
  capped: true,
};

interface SoloWindow {
  worker: Worker;
  api: Comlink.Remote<SoloEngineApi>;
  snap: MatchSnapshot;
  listeners: Set<() => void>;
  /** init/attachBridge/subscribe posted? A worker can spawn before the wallet bridge is ready. */
  wired: boolean;
}

/** A PvP window's store slot (the worker is the shared hub, not per-window). */
interface PvpWindow {
  snap: MatchSnapshot;
  listeners: Set<() => void>;
}

let bridge: MainBridge | null = null;
let config: EngineConfig | null = null;

const soloWindows = new Map<string, SoloWindow>();
const pvpWindows = new Map<string, PvpWindow>();
const windowLane = new Map<string, Lane>();

/** The single shared PvP hub worker + its wrapped API; null until the first PvP command spawns it. */
let hubWorker: Worker | null = null;
let hubApi: Comlink.Remote<PvpHubApi> | null = null;
let hubWired = false;

/** Called by EngineProvider/useConfigureEngine once the wallet is known. Idempotent, and it
 *  retroactively wires any worker (solo or the hub) that spawned BEFORE the bridge was ready. */
export function configureEngine(
  cfg: EngineConfig,
  mainBridge: MainBridge,
): void {
  config = cfg;
  bridge = mainBridge;
  for (const [windowId, entry] of soloWindows) wireSolo(windowId, entry);
  wireHub();
}

/** Fire a worker command without awaiting. The engine surfaces failures via the snapshot's
 *  `error` field (not the command's promise), so a rejection here is safe to swallow. */
function fire(p: Promise<unknown>): void {
  void p.catch(() => {});
}

// --- SOLO lane: one worker per window ------------------------------------------------------

function wireSolo(windowId: string, entry: SoloWindow): void {
  if (entry.wired || !config || !bridge) return;
  const onSnapshot = (snap: MatchSnapshot): void => {
    entry.snap = snap;
    for (const l of entry.listeners) l();
  };
  fire(entry.api.init(config));
  fire(entry.api.attachBridge(Comlink.proxy(bridge)));
  fire(entry.api.subscribe(Comlink.proxy(onSnapshot)));
  entry.wired = true;
  elog("client", "wired solo worker", windowId);
}

function spawnSolo(windowId: string): SoloWindow {
  const worker = new Worker(new URL("./engine.worker.ts", import.meta.url), {
    type: "module",
    name: `[solo] ${windowId}`,
  });
  const api = Comlink.wrap<SoloEngineApi>(worker);
  const entry: SoloWindow = {
    worker,
    api,
    snap: IDLE_SNAPSHOT,
    listeners: new Set(),
    wired: false,
  };
  soloWindows.set(windowId, entry);
  elog("client", "spawn solo worker", {
    windowId,
    configured: !!(config && bridge),
  });
  wireSolo(windowId, entry);
  registerWindowDisposer(windowId, "engine", () => disposeWindow(windowId));
  return entry;
}

/** Returns the solo window's worker, spawning it lazily — unless the device live-window cap
 *  (design §2.1) is already reached for a NEW window (returns null → CAPPED_SNAPSHOT). The cap
 *  counts solo workers only; the single shared PvP hub is one extra isolate, not per-window. */
function getOrSpawnSolo(windowId: string): SoloWindow | null {
  const existing = soloWindows.get(windowId);
  if (existing) return existing;
  if (soloWindows.size >= maxLiveWindows()) return null;
  return spawnSolo(windowId);
}

// --- PvP lane: one shared hub worker for all windows ---------------------------------------

function wireHub(): void {
  if (hubWired || !hubApi || !config || !bridge) return;
  const onSnapshot = (windowId: string, snap: MatchSnapshot): void => {
    const w = pvpWindows.get(windowId);
    if (!w) return; // window disposed between the worker's emit and this callback
    w.snap = snap;
    for (const l of w.listeners) l();
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

function disposeSolo(windowId: string): void {
  const entry = soloWindows.get(windowId);
  if (!entry) return;
  // Drop from the store first so subscribe/getSnapshot immediately treat the window as gone.
  soloWindows.delete(windowId);
  // Let the worker run reset() (cancel any queued open) before the abrupt terminate; reclaim the
  // proxy + isolate once it lands, with a timeout fallback for a wedged worker.
  let reclaimed = false;
  const reclaim = (): void => {
    if (reclaimed) return;
    reclaimed = true;
    entry.api[Comlink.releaseProxy]();
    entry.worker.terminate();
  };
  entry.api.reset().then(reclaim, reclaim);
  setTimeout(reclaim, 1000);
}

function disposePvp(windowId: string): void {
  const w = pvpWindows.get(windowId);
  if (!w) return;
  pvpWindows.delete(windowId);
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

function disposeWindow(windowId: string): void {
  const lane = windowLane.get(windowId);
  windowLane.delete(windowId);
  if (lane === "solo") disposeSolo(windowId);
  else disposePvp(windowId);
}

// --- public surface (the React bindings call these) ---------------------------------------

export const engineClient = {
  /** Subscribe to a window's snapshot store. `lane` is fixed by the binding (useGameMatch→pvp,
   *  useGameSolo→solo) and is recorded so later commands route to the right worker. */
  subscribe(windowId: string, lane: Lane, cb: () => void): () => void {
    windowLane.set(windowId, lane);
    if (lane === "solo") {
      const entry = getOrSpawnSolo(windowId);
      if (!entry) return () => {}; // capped: CAPPED_SNAPSHOT, no worker to listen to
      entry.listeners.add(cb);
      return () => entry.listeners.delete(cb);
    }
    const w = ensurePvpWindow(windowId);
    w.listeners.add(cb);
    return () => w.listeners.delete(cb);
  },

  getSnapshot(windowId: string, lane: Lane): MatchSnapshot {
    if (lane === "solo") {
      const entry = soloWindows.get(windowId);
      if (entry) return entry.snap;
      return soloWindows.size >= maxLiveWindows()
        ? CAPPED_SNAPSHOT
        : IDLE_SNAPSHOT;
    }
    return pvpWindows.get(windowId)?.snap ?? IDLE_SNAPSHOT;
  },

  // PvP commands → shared hub.
  findMatch(windowId: string, gameId: GameId, setup?: unknown): void {
    windowLane.set(windowId, "pvp");
    ensurePvpWindow(windowId);
    fire(ensureHub().findMatch(windowId, gameId, setup));
  },
  resume(windowId: string, gameId: GameId): void {
    windowLane.set(windowId, "pvp");
    ensurePvpWindow(windowId);
    fire(ensureHub().resume(windowId, gameId));
  },

  // SOLO command → per-window worker.
  findSolo(windowId: string, gameId: GameId, setup?: unknown): void {
    windowLane.set(windowId, "solo");
    const entry = getOrSpawnSolo(windowId);
    if (entry) fire(entry.api.findSoloMatch(gameId, setup));
  },

  // Shared control commands → route by the window's recorded lane.
  submitInput(windowId: string, input: unknown): void {
    const solo = soloWindows.get(windowId);
    if (windowLane.get(windowId) === "solo") {
      if (solo) fire(solo.api.submitInput(input));
    } else if (hubApi) fire(hubApi.submitInput(windowId, input));
  },
  setAuto(windowId: string, on: boolean): void {
    const solo = soloWindows.get(windowId);
    if (windowLane.get(windowId) === "solo") {
      if (solo) fire(solo.api.setAuto(on));
    } else if (hubApi) fire(hubApi.setAuto(windowId, on));
  },
  setVisibility(windowId: string, visible: boolean): void {
    const solo = soloWindows.get(windowId);
    if (windowLane.get(windowId) === "solo") {
      if (solo) fire(solo.api.setVisibility(visible));
    } else if (hubApi) fire(hubApi.setVisibility(windowId, visible));
  },
  /** SOLO lane only: cabinet hover-freeze. */
  setPaused(windowId: string, paused: boolean): void {
    const entry = soloWindows.get(windowId);
    if (entry) fire(entry.api.setPaused(paused));
  },
  /** SOLO lane only: on-demand cash-out. */
  settleSolo(windowId: string): void {
    const entry = soloWindows.get(windowId);
    if (entry) fire(entry.api.settleSolo());
  },
  reset(windowId: string): void {
    if (windowLane.get(windowId) === "solo") {
      const entry = soloWindows.get(windowId);
      if (entry) fire(entry.api.reset());
    } else if (hubApi) {
      fire(hubApi.reset(windowId));
    }
  },
  /** Terminate a window's worker and reclaim its memory (also auto-run on window close). */
  dispose(windowId: string): void {
    disposeWindow(windowId);
  },
  disposeWindow(windowId: string): void {
    disposeWindow(windowId);
  },
};
