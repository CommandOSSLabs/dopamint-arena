import type { GameModule } from "./types";

const modules = new Map<string, GameModule>();

/** Register a game module. Throws on duplicate id to catch copy-paste mistakes. */
export function register(module: GameModule): void {
  if (modules.has(module.id)) {
    throw new Error(`duplicate game module id: ${module.id}`);
  }
  modules.set(module.id, module);
}

/** Catalog modules — those shown in the picker / mobile list / seed. Excludes
 *  `catalog: false` widgets (e.g. default floating ones), which `get()` still resolves. */
export function list(): GameModule[] {
  return [...modules.values()].filter((m) => m.catalog !== false);
}

export function get(id: string): GameModule | undefined {
  return modules.get(id);
}
