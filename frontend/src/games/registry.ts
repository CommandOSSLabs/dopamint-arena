import type { GameModule, Workspace } from "./types";

const modules = new Map<string, GameModule>();

/** Register a game module. Throws on duplicate id to catch copy-paste mistakes. */
export function register(module: GameModule): void {
  if (modules.has(module.id)) {
    console.warn(`duplicate game module id: ${module.id}`);
    return;
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

/** Every module in a workspace, catalog flag aside — the Add dialog groups by this.
 *  Modules default to the `games` workspace, so games stay together while the
 *  `payment`/`chat` widgets surface under their own headings. */
export function listByWorkspace(workspace: Workspace): GameModule[] {
  return [...modules.values()].filter(
    (m) => (m.workspace ?? "games") === workspace,
  );
}
