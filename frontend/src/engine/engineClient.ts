/**
 * Main-thread manager for the per-game-window tunnel workers. Spawns ONE dedicated worker
 * per `windowId` (lazy, on first command), keeps that window's latest snapshot for
 * `useSyncExternalStore`, and terminates the worker on dispose.
 *
 * Transport is Comlink (design §4): each worker exposes an `EngineApi` we `Comlink.wrap`. The
 * bridge and the snapshot sink are handed over as `Comlink.proxy`'d references, so the worker
 * invokes them by reference (each call RPCs back here) — no hand-rolled `postMessage` envelopes.
 * The bridge is a single per-user instance (wallet is per-user), set once by `EngineProvider`;
 * every window's worker shares it.
 *
 * Proxy lifetimes: the wrapped `EngineApi` and the two proxied callbacks (bridge, snapshot) live
 * for the worker's lifetime. `dispose` releases the wrapped API (`Comlink.releaseProxy`) and
 * `terminate()`s the worker; terminating disentangles the bridge/snapshot ports so their
 * main-side `MessagePort` listeners are reclaimed (no proxy leak).
 */
import * as Comlink from "comlink";
import type {
  EngineApi,
  MainBridge,
  MatchSnapshot,
  EngineConfig,
  GameId,
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
  /** The worker's `EngineApi`, wrapped by Comlink — every method returns a `Promise`. */
  api: Comlink.Remote<EngineApi>;
  snap: MatchSnapshot;
  listeners: Set<() => void>;
  /** Whether init/attachBridge/subscribe have been posted. A worker can spawn before the wallet
   *  bridge is ready (React child effects run before the parent's `useConfigureEngine`), so it
   *  stays unwired until {@link configureEngine} wires it. */
  wired: boolean;
}

let bridge: MainBridge | null = null;
let config: EngineConfig | null = null;
const windows = new Map<string, WindowEntry>();

/** Called by EngineProvider/useConfigureEngine once the wallet is known. Idempotent, and it
 *  retroactively wires any workers that spawned BEFORE the bridge was ready (the effect-ordering
 *  foot-gun) — without this, a window mounted before the wallet stays a dead worker forever. */
export function configureEngine(
  cfg: EngineConfig,
  mainBridge: MainBridge,
): void {
  config = cfg;
  bridge = mainBridge;
  for (const [windowId, entry] of windows) wire(windowId, entry);
}

/** Fire a worker command without awaiting. The engine surfaces failures via the snapshot's
 *  `error` field (not the command's promise), so a rejection here is safe to swallow. */
function fire(p: Promise<unknown>): void {
  void p.catch(() => {});
}

/** Post init → attachBridge → subscribe to a worker once the per-user bridge is configured.
 *  Idempotent (skips if already wired or the bridge isn't set yet). Posts synchronously with no
 *  await between the three so they queue ahead of any later findMatch (Comlink preserves order). */
function wire(windowId: string, entry: WindowEntry): void {
  if (entry.wired || !config || !bridge) return;
  const onSnapshot = (snap: MatchSnapshot): void => {
    entry.snap = snap;
    for (const l of entry.listeners) l();
  };
  fire(entry.api.init(config));
  fire(entry.api.attachBridge(Comlink.proxy(bridge)));
  fire(entry.api.subscribe(Comlink.proxy(onSnapshot)));
  entry.wired = true;
  elog("client", "wired worker", windowId);
}

function spawn(windowId: string): WindowEntry {
  const worker = new Worker(new URL("./engine.worker.ts", import.meta.url), {
    type: "module",
    name: `tunnel-${windowId}`,
  });
  const api = Comlink.wrap<EngineApi>(worker);
  const entry: WindowEntry = {
    worker,
    api,
    snap: IDLE_SNAPSHOT,
    listeners: new Set(),
    wired: false,
  };
  windows.set(windowId, entry);
  elog("client", "spawn worker", {
    windowId,
    configured: !!(config && bridge),
  });
  // Wires now if the bridge is already configured; otherwise configureEngine wires it once the
  // wallet/EngineProvider is ready (so a worker that spawned first isn't left dead).
  wire(windowId, entry);
  if (!entry.wired) {
    elog(
      "client",
      "worker idle until wallet/EngineProvider (bridge not configured yet)",
      windowId,
    );
  }
  // Tear the worker down on explicit window close (mirrors the legacy session disposer); a
  // mere React remount/minimize keeps it alive so the match survives in the background.
  registerWindowDisposer(windowId, "engine", () => disposeWindow(windowId));
  return entry;
}

function disposeWindow(windowId: string): void {
  const entry = windows.get(windowId);
  if (!entry) return;
  // Drop from the store first so subscribe/getSnapshot immediately treat the window as gone.
  windows.delete(windowId);
  // Orphan-tunnel cancel (design §4.1): terminate() is abrupt, so let the worker run reset() first
  // — it cancels any seat-A open still queued in the main-thread bulk-open window, so a closed
  // window never flushes a tunnel (consuming stake) for a gone match. reset() awaits that cancel,
  // so once it resolves the intent is gone; only THEN release the API proxy + terminate (which
  // disentangles the bridge + snapshot proxy ports so their main-side listeners are reclaimed). A
  // wedged worker is still reclaimed by the timeout fallback.
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
    if (entry) fire(entry.api.findMatch(gameId, setup));
  },
  /** Start a SELF-PLAY (bot-vs-bot) session in this window — the solo-lane sibling of
   *  {@link findMatch}. Reuses the same lazy spawn / wire / device-cap / dispose path; a capped
   *  new window simply isn't spawned (the snapshot surfaces `capped`). `setup` optionally overrides
   *  the per-duel stake. */
  findSolo(windowId: string, gameId: GameId, setup?: unknown): void {
    const entry = getOrSpawn(windowId);
    if (entry) fire(entry.api.findSoloMatch(gameId, setup));
  },
  resume(windowId: string, gameId: GameId): void {
    const entry = getOrSpawn(windowId);
    if (entry) fire(entry.api.resume(gameId));
  },
  submitInput(windowId: string, input: unknown): void {
    const entry = windows.get(windowId);
    if (entry) fire(entry.api.submitInput(input));
  },
  setAuto(windowId: string, on: boolean): void {
    const entry = windows.get(windowId);
    if (entry) fire(entry.api.setAuto(on));
  },
  setVisibility(windowId: string, visible: boolean): void {
    const entry = windows.get(windowId);
    if (entry) fire(entry.api.setVisibility(visible));
  },
  /** SOLO lane: cabinet hover-freeze. Pauses/resumes the self-play loop AND its snapshot flush,
   *  independent of {@link setVisibility} (tab visibility); see `EngineApi.setPaused`. */
  setPaused(windowId: string, paused: boolean): void {
    const entry = windows.get(windowId);
    if (entry) fire(entry.api.setPaused(paused));
  },
  /** SOLO lane: on-demand cash-out — close the funded tunnel now at the current co-signed state. */
  settleSolo(windowId: string): void {
    const entry = windows.get(windowId);
    if (entry) fire(entry.api.settleSolo());
  },
  reset(windowId: string): void {
    const entry = windows.get(windowId);
    if (entry) fire(entry.api.reset());
  },
  /** Terminate a window's worker and reclaim its memory (also auto-run on window close). */
  dispose(windowId: string): void {
    disposeWindow(windowId);
  },
};
