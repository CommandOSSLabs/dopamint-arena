/**
 * Dedicated worker entry for ONE game window's tunnel client. Builds a `PvpEngine` and
 * `Comlink.expose`s a typed `EngineApi` (design §4): `engineClient` (main) `Comlink.wrap`s it,
 * calls `init`/`attachBridge`/`subscribe` once, then drives the match.
 *
 * The chain bridge and the snapshot callback arrive as Comlink proxies (main `Comlink.proxy`'d
 * them), so the engine invokes them by reference and each call RPCs back to main. Those proxy
 * ports are owned for the worker's lifetime; main releases the wrapped API and terminates the
 * worker on dispose, which disentangles them (no manual release needed worker-side).
 */
import * as Comlink from "comlink";
import { PvpEngine } from "./pvpEngine";
import { getSpec } from "./specs/registry";
import type { EngineApi } from "./engineApi";

const engine = new PvpEngine(getSpec);

const api: EngineApi = {
  init: (config) => engine.init(config),
  attachBridge: (bridge) => engine.attachBridge(bridge),
  subscribe: (onSnapshot) => engine.subscribe(onSnapshot),
  findMatch: (gameId, setup) => engine.findMatch(gameId, setup),
  resume: (gameId) => engine.resume(gameId),
  submitInput: (input) => engine.submitInput(input),
  setAuto: (on) => engine.setAuto(on),
  setVisibility: (visible) => engine.setVisibility(visible),
  reset: () => engine.reset(),
};

Comlink.expose(api);
