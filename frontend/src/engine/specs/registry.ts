/**
 * Spec registry wiring. Each game self-registers via `defineGame` at module load (design §3.1),
 * so this module only imports the spec modules for their side-effects. Lookups go through
 * `getSpec`, re-exported here so the worker's import site (`./specs/registry`) stays stable and
 * importing this module guarantees every in-scope spec is registered first.
 */
import "@/games/bombIt/bombItSpec";
import "@/games/chickenCross/chickenCrossSpec";
import "@/games/worldCanvas/worldCanvasSpec";
import "@/games/battleship/battleshipSpec";

export { getSpec } from "./defineGame";
