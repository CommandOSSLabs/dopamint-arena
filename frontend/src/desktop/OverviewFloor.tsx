import { ArrowRight } from "lucide-react";

import { get } from "../games/registry";
import type { Workspace } from "../games/types";
import { GameContent } from "./GameContent";
import { GameTpsBadge } from "./GameTpsBadge";
import { GameWindow } from "./GameWindow";

/** The game id embedded in a window id (`blackjack#ab12` → `blackjack`). */
const gameOf = (instanceId: string) => instanceId.split("#")[0];

/** Uniform tile height — a real window's footprint (TILE.h 5 × rowHeight 72) so overview
 *  windows read the same size as on a normal floor, just grouped. */
const TILE_H = "h-[360px]";

/** One workspace's slice for the overview: its label, the window instance ids open on
 *  its floor, and a stable close-by-id scoped to that floor. */
export interface OverviewGroup {
  ws: Workspace;
  label: string;
  ids: string[];
  onClose: (id: string) => void;
}

/**
 * The phone "All" view: every workspace's open windows at once, each under a group heading
 * (Game / Payment / Chat), as a vertical scroll of full-size tiles (1–2 per row on a phone).
 * It mounts the same {@link GameWindow} + {@link GameContent} the phone floor does, so games
 * keep auto-playing (and report real per-game TPS) and the take-over overlay still works.
 * The desktop "All" view instead reuses the real draggable floor per group (see WorkspaceFloor
 * in Desktop.tsx); this static-tile variant is the phone's, where floor gestures don't apply.
 *
 * Rendered exclusively (the per-workspace floor is unmounted while this is on screen), so
 * reusing the real window ids never double-mounts a session.
 */
export function OverviewFloor({
  groups,
  onOpenWorkspace,
}: {
  groups: OverviewGroup[];
  onOpenWorkspace: (ws: Workspace) => void;
}) {
  return (
    <div className="bg-dot-grid h-full overflow-y-auto p-2">
      <div className="flex flex-col gap-4">
        {groups.map((group) => (
          <section key={group.ws}>
            <header className="flex items-center px-0.5 pb-1.5">
              <button
                type="button"
                onClick={() => onOpenWorkspace(group.ws)}
                className="group inline-flex items-center gap-1.5 text-sm font-semibold text-foreground/70 transition-colors hover:text-foreground"
              >
                {group.label}
                <span className="rounded bg-secondary px-1 text-[10px] font-medium text-muted-foreground">
                  {group.ids.length}
                </span>
                <ArrowRight className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            </header>

            {group.ids.length === 0 ? (
              <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-border text-xs text-muted-foreground">
                Nothing open in {group.label}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {group.ids.map((id) => {
                  const mod = get(gameOf(id));
                  if (!mod) return null;
                  return (
                    <div key={id} className={TILE_H}>
                      <GameWindow
                        title={mod.name}
                        icon={<GameTpsBadge gameId={gameOf(id)} />}
                        domId={id}
                        onClose={() => group.onClose(id)}
                      >
                        <GameContent
                          gameId={gameOf(id)}
                          windowId={id}
                          onClose={group.onClose}
                        />
                      </GameWindow>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
