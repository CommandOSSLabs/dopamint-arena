/**
 * Dedicated worker entry for ONE solo (self-play) game window. `engineClient` spawns ONE of these
 * per solo window (self-play is pure crypto with no relay socket, so it keeps per-window isolation)
 * and `Comlink.expose`s a typed `SoloEngineApi`; main `Comlink.wrap`s it, calls
 * `init`/`attachBridge`/`subscribe` once, then drives the session.
 *
 * PvP runs in the SHARED `engine.pvp.worker.ts` hub instead (M1: one socket for all PvP windows).
 *
 * The chain bridge and the snapshot callback arrive as Comlink proxies; the engine invokes them by
 * reference and each call RPCs back to main. Those proxy ports are owned for the worker's lifetime;
 * main releases the wrapped API and terminates the worker on dispose, which disentangles them.
 */
import * as Comlink from "comlink";
import { SoloEngine } from "./soloEngine";
import { getSoloSpec } from "./specs/registry";
import { elog } from "./debug";
import type { SoloEngineApi } from "./engineApi";

const soloEngine = new SoloEngine(getSoloSpec);

const api: SoloEngineApi = {
  init: (config) => soloEngine.init(config),
  attachBridge: (bridge) => soloEngine.attachBridge(bridge),
  subscribe: (onSnapshot) => soloEngine.subscribe(onSnapshot),
  findSoloMatch: (gameId, setup) => soloEngine.findSoloMatch(gameId, setup),
  submitInput: (input) => soloEngine.submitInput(input),
  setAuto: (on) => soloEngine.setAuto(on),
  setVisibility: (visible) => soloEngine.setVisibility(visible),
  setPaused: (paused) => soloEngine.setPaused(paused),
  settleSolo: () => soloEngine.settleSolo(),
  reset: () => soloEngine.reset(),
};

Comlink.expose(api);

// Proof this ran in a Web Worker; `self.name` is set by engineClient (e.g. `[solo] blackjack#abc123`).
elog("worker", "solo booted", typeof self !== "undefined" ? self.name : "");
