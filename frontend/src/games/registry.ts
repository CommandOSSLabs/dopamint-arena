import type { GameModule } from "./types";

const modules = new Map<string, GameModule>();

/** Register a game module. Throws on duplicate id to catch copy-paste mistakes. */
export function register(module: GameModule): void {
  if (modules.has(module.id)) {
    throw new Error(`duplicate game module id: ${module.id}`);
  }
  modules.set(module.id, module);
}

export function list(): GameModule[] {
  return [...modules.values()];
}

export function get(id: string): GameModule | undefined {
  return modules.get(id);
}
