import { useEffect, useState } from "react";

export interface TaskbarWindow {
  windowId: string;
  name: string;
  icon: string;
}

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span className="px-2 text-xs tabular-nums text-arena-muted">
      {now.toLocaleTimeString()}
    </span>
  );
}

export function Taskbar({ openWindows }: { openWindows: TaskbarWindow[] }) {
  return (
    <footer className="flex h-11 shrink-0 items-center gap-2 border-t border-arena-edge bg-arena-panel px-2">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {openWindows.map((w) => (
          <span
            key={w.windowId}
            className="flex shrink-0 items-center gap-1 rounded border border-arena-edge px-2 py-1 text-xs text-arena-text"
          >
            <span>{w.icon}</span>
            {w.name}
          </span>
        ))}
      </div>
      <Clock />
    </footer>
  );
}
