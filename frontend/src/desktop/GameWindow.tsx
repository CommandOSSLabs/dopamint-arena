import type { ReactNode } from "react";

/**
 * Static (non-draggable) window chrome. Windows cascade by `index` so multiple
 * stay visible. Drag/resize is a deliberate later addition.
 */
export function GameWindow({
  title,
  icon,
  index,
  onClose,
  children,
}: {
  title: string;
  icon: string;
  index: number;
  onClose: () => void;
  children: ReactNode;
}) {
  const offset = index * 28;
  return (
    <div
      className="absolute flex w-[380px] flex-col rounded-lg border border-arena-edge bg-arena-panel shadow-xl"
      style={{ left: 24 + offset, top: 24 + offset }}
    >
      <header className="flex items-center justify-between rounded-t-lg border-b border-arena-edge bg-arena-bg/60 px-3 py-2">
        <span className="flex items-center gap-2 text-xs font-medium text-arena-text">
          <span>{icon}</span>
          {title}
        </span>
        <button
          onClick={onClose}
          aria-label="Close window"
          className="text-arena-muted hover:text-red-400"
        >
          ✕
        </button>
      </header>
      <div className="min-h-0">{children}</div>
    </div>
  );
}
