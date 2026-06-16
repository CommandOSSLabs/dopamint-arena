import { useState } from "react";
import { ConnectButton } from "@mysten/dapp-kit";
import "../games"; // register all game modules (side-effect import)
import { get, list } from "../games/registry";
import { useTelemetry } from "../telemetry/TelemetryProvider";
import { SystemDashboard } from "../panels/SystemDashboard";
import { TpsChart } from "../panels/TpsChart";
import { LiveTransactionsFeed } from "../panels/LiveTransactionsFeed";
import { TransactionLog } from "../panels/TransactionLog";
import { RecentDeposits } from "../panels/RecentDeposits";
import { GameWindow } from "./GameWindow";
import { Taskbar } from "./Taskbar";

interface OpenWindow {
  windowId: string;
  gameId: string;
}

/** Every registered game opens in its own window on load, tiled in a grid. */
function defaultWindows(): OpenWindow[] {
  return list().map((g) => ({ windowId: g.id, gameId: g.id }));
}

export function Desktop() {
  const [open, setOpen] = useState<OpenWindow[]>(defaultWindows);
  const { snapshot } = useTelemetry();

  function close(windowId: string) {
    setOpen((cur) => cur.filter((w) => w.windowId !== windowId));
  }

  return (
    <div className="flex h-full flex-col bg-arena-bg text-arena-text">
      <header className="flex shrink-0 items-center justify-between border-b border-arena-edge px-3 py-2">
        <span className="text-sm font-semibold tracking-tight">
          Dopamint <span className="text-arena-accent">Arena</span>
        </span>
        <ConnectButton />
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1 overflow-auto p-2">
          {open.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-arena-muted">
              All windows closed — reload to restore the lineup.
            </div>
          ) : (
            <div className="grid auto-rows-[16rem] grid-cols-2 gap-2 xl:grid-cols-4">
              {open.map((w) => {
                const mod = get(w.gameId);
                if (!mod) return null;
                const Content = mod.Window;
                return (
                  <GameWindow
                    key={w.windowId}
                    title={mod.name}
                    icon={mod.icon}
                    onClose={() => close(w.windowId)}
                  >
                    <Content
                      windowId={w.windowId}
                      onClose={() => close(w.windowId)}
                    />
                  </GameWindow>
                );
              })}
            </div>
          )}
        </main>

        <aside className="flex w-80 shrink-0 flex-col gap-2 border-l border-arena-edge p-2">
          <LiveTransactionsFeed snapshot={snapshot} />
          <SystemDashboard snapshot={snapshot} />
          <TpsChart snapshot={snapshot} />
        </aside>
      </div>

      <div className="grid h-56 shrink-0 grid-cols-2 gap-2 border-t border-arena-edge p-2">
        <TransactionLog snapshot={snapshot} />
        <RecentDeposits snapshot={snapshot} />
      </div>

      <Taskbar
        openWindows={open.map((w) => {
          const mod = get(w.gameId);
          return {
            windowId: w.windowId,
            name: mod?.name ?? w.gameId,
            icon: mod?.icon ?? "▢",
          };
        })}
      />
    </div>
  );
}
