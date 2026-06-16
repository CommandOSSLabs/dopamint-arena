import { useRef, useState } from "react";
import { ConnectButton } from "@mysten/dapp-kit";
import "../games"; // register all game modules (side-effect import)
import { get, list } from "../games/registry";
import { PLACEHOLDER_SNAPSHOT } from "../placeholders";
import { Catalog } from "../catalog/Catalog";
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

export function Desktop() {
  const [open, setOpen] = useState<OpenWindow[]>([]);
  const [catalogOpen, setCatalogOpen] = useState(true);
  const seq = useRef(0);
  const snapshot = PLACEHOLDER_SNAPSHOT;

  function launch(gameId: string) {
    seq.current += 1;
    setOpen((cur) => [...cur, { windowId: `w${seq.current}`, gameId }]);
    setCatalogOpen(false);
  }
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
        <main className="relative min-w-0 flex-1 overflow-hidden">
          {open.map((w, i) => {
            const mod = get(w.gameId);
            if (!mod) return null;
            const Content = mod.Window;
            return (
              <GameWindow
                key={w.windowId}
                title={mod.name}
                icon={mod.icon}
                index={i}
                onClose={() => close(w.windowId)}
              >
                <Content
                  windowId={w.windowId}
                  onClose={() => close(w.windowId)}
                />
              </GameWindow>
            );
          })}
          {catalogOpen && (
            <Catalog
              games={list()}
              onLaunch={launch}
              onClose={() => setCatalogOpen(false)}
            />
          )}
          {open.length === 0 && !catalogOpen && (
            <div className="flex h-full items-center justify-center text-sm text-arena-muted">
              Open the catalog from the taskbar to launch a game.
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
        onToggleCatalog={() => setCatalogOpen((v) => !v)}
      />
    </div>
  );
}
