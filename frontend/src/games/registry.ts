import type { GameModule, Workspace } from "./types";

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

/** The arena game id a module's window funds when opened — the DEFAULT (first) protocol of a module
 *  hosting several (tic-tac-toe + caro → caro, since caro is the variant the window opens in).
 *  `undefined` if the module isn't arena-wired. Single source of truth for the connect-time batch and
 *  the add-a-game lazy allocation, so both fund the same id. */
export function arenaGameIdForModule(id: string): string | undefined {
  const arenaGameId = modules.get(id)?.arenaGameId;
  if (!arenaGameId) return undefined;
  return Array.isArray(arenaGameId) ? arenaGameId[0] : arenaGameId;
}

/** Every module in a workspace, catalog flag aside — the Add dialog groups by this.
 *  Modules default to the `games` workspace, so games stay together while the
 *  `payment`/`chat` widgets surface under their own headings. */
export function listByWorkspace(workspace: Workspace): GameModule[] {
  return [...modules.values()].filter(
    (m) => (m.workspace ?? "games") === workspace,
  );
}
