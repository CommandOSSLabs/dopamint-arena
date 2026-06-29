/**
 * Dedicated worker entry for ONE game window's tunnel client. Builds the per-lane engines and
 * `Comlink.expose`s a typed `EngineApi` (design §4): `engineClient` (main) `Comlink.wrap`s it,
 * calls `init`/`attachBridge`/`subscribe` once, then drives the match.
 *
 * A window is EITHER pvp or solo: both engines are constructed (cheap; neither opens anything until
 * `findMatch`/`findSoloMatch`), but only the lane that actually started is "active". Setup commands
 * fan out to BOTH (they never emit); control commands (input/auto/visibility/reset) route to the
 * active lane only — otherwise the idle lane's `setAuto`/`reset` would flush a snapshot that
 * clobbers the active lane's. `findMatch`/`resume` select pvp; `findSoloMatch` selects solo.
 *
 * The chain bridge and the snapshot callback arrive as Comlink proxies (main `Comlink.proxy`'d
 * them), so the engines invoke them by reference and each call RPCs back to main. Those proxy ports
 * are owned for the worker's lifetime; main releases the wrapped API and terminates the worker on
 * dispose, which disentangles them (no manual release needed worker-side).
 */
import * as Comlink from "comlink";
import { PvpEngine } from "./pvpEngine";
import { SoloEngine } from "./soloEngine";
import { getSpec, getSoloSpec } from "./specs/registry";
import { elog } from "./debug";
import type { EngineApi } from "./engineApi";

const pvpEngine = new PvpEngine(getSpec);
const soloEngine = new SoloEngine(getSoloSpec);

/** Which lane this window is driving. Null until the first `findMatch`/`findSoloMatch`/`resume`;
 *  cleared by `reset`. Routes control commands to the lane that actually started. */
let lane: "pvp" | "solo" | null = null;

/** The lane currently driving the match, or null before one started (control commands no-op). */
function active(): PvpEngine | SoloEngine | null {
  if (lane === "pvp") return pvpEngine;
  if (lane === "solo") return soloEngine;
  return null;
}

const api: EngineApi = {
  init: (config) => {
    pvpEngine.init(config);
    soloEngine.init(config);
  },
  attachBridge: (bridge) => {
    pvpEngine.attachBridge(bridge);
    soloEngine.attachBridge(bridge);
  },
  subscribe: (onSnapshot) => {
    pvpEngine.subscribe(onSnapshot);
    soloEngine.subscribe(onSnapshot);
  },
  findMatch: (gameId, setup) => {
    lane = "pvp";
    return pvpEngine.findMatch(gameId, setup);
  },
  findSoloMatch: (gameId, setup) => {
    lane = "solo";
    return soloEngine.findSoloMatch(gameId, setup);
  },
  resume: (gameId) => {
    lane = "pvp";
    return pvpEngine.resume(gameId);
  },
  submitInput: (input) => active()?.submitInput(input),
  setAuto: (on) => active()?.setAuto(on),
  setVisibility: (visible) => active()?.setVisibility(visible),
  // Solo-only commands: the cabinet hover-freeze and the on-demand cash-out exist only on the
  // self-play lane, so they no-op unless this window is actually driving solo.
  setPaused: (paused) => {
    if (lane === "solo") soloEngine.setPaused(paused);
  },
  settleSolo: () => {
    if (lane === "solo") soloEngine.settleSolo();
  },
  reset: async () => {
    // Reset the lane that ran; if none started, reset both (idempotent cleanup). Clear the lane so
    // the next match re-selects it.
    if (lane === "pvp") await pvpEngine.reset();
    else if (lane === "solo") await soloEngine.reset();
    else {
      await pvpEngine.reset();
      await soloEngine.reset();
    }
    lane = null;
  },
};

Comlink.expose(api);

// Definitive proof this ran in a Web Worker: this line only executes inside the worker thread,
// and `self.name` is the per-window worker name set by engineClient (`tunnel-<windowId>`).
elog("worker", "booted", typeof self !== "undefined" ? self.name : "");
