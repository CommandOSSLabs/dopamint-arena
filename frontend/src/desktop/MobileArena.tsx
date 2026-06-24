import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";

import { GameIcon } from "../games/GameIcon";
import { get, listByWorkspace } from "../games/registry";
import type { Workspace } from "../games/types";
import { disposeWindow } from "@/lib/windowSessions";
import {
  forgetWindow,
  markWindowActive,
  resolveWindowId,
} from "@/lib/activeWindows";

const WORKSPACE_LABEL: Record<Workspace, string> = {
  games: "Games",
  payment: "Payments",
  chat: "Chat",
};

/**
 * The phone floor (< lg) for one workspace: always opens to that workspace's catalog
 * so switching the bottom-nav tab lands you on the picker (the parent keys this by
 * workspace, so each tab is a fresh picker). Tapping a card opens it full-bleed with a
 * back bar — and resumes the exact window instance you last focused (a desktop
 * `gameId#uuid` duplicate included, via {@link resolveWindowId}), so a session-backed
 * game continues rather than restarts. "Back" only unmounts the window (state is
 * resumable); the game signalling `onClose` disposes it for real.
 */
export function MobileArena({
  workspace = "games",
}: {
  workspace?: Workspace;
}) {
  const modules = listByWorkspace(workspace);
  // Start on the picker — switching tabs should show the catalog, not jump into an app.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = selectedId ? get(selectedId) : undefined;

  // A remembered id can outlive its game (registry change) — drop it so the list shows.
  useEffect(() => {
    if (selectedId && !get(selectedId)) setSelectedId(null);
  }, [selectedId]);

  if (selected) {
    const Content = selected.Window;
    // Resume the last-active instance of this game (a desktop duplicate keeps its id).
    const windowId = resolveWindowId(selected.id);
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-secondary/40 px-2 py-1.5">
          <button
            type="button"
            onClick={() => setSelectedId(null)}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground active:scale-95"
          >
            <ArrowLeft className="size-4" /> {WORKSPACE_LABEL[workspace]}
          </button>
          <span className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
            <GameIcon game={selected} className="size-5" />
            <span className="truncate">{selected.name}</span>
          </span>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <Content
            windowId={windowId}
            onClose={() => {
              disposeWindow(windowId);
              forgetWindow(windowId);
              setSelectedId(null);
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="bg-dot-grid flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-4 pt-4 pb-1">
        <span className="wal-eyebrow text-muted-foreground">
          Dopamint · {workspace}
        </span>
        <h1 className="wal-display text-xl">
          {workspace === "games" ? "Pick a game" : WORKSPACE_LABEL[workspace]}
        </h1>
      </div>
      <ul className="grid min-h-0 flex-1 grid-cols-2 content-start gap-3 overflow-auto p-3">
        {modules.map((g) => (
          <li key={g.id}>
            <button
              type="button"
              onClick={() => {
                markWindowActive(resolveWindowId(g.id));
                setSelectedId(g.id);
              }}
              className="flex h-full w-full flex-col gap-2.5 rounded-2xl border border-border bg-card p-3 text-left shadow-sm transition-colors hover:border-primary/50 hover:bg-secondary/40 active:scale-[0.99]"
            >
              <GameIcon
                game={g}
                className="grid h-28 w-full place-items-center rounded-xl text-5xl"
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate text-sm font-semibold text-foreground">
                  {g.name}
                </span>
                {g.description && (
                  <span className="line-clamp-2 text-xs text-muted-foreground">
                    {g.description}
                  </span>
                )}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
