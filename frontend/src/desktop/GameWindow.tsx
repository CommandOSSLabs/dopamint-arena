import type { ReactNode } from "react";

/**
 * Static (non-draggable) window chrome. Sized to fill its grid cell so the
 * default lineup tiles uniformly; the body scrolls. Drag/resize is a deliberate
 * later addition.
 */
export function GameWindow({
  title,
  icon,
  onClose,
  children,
}: {
  title: string;
  icon: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-arena-edge bg-arena-panel shadow-xl">
      <header className="flex shrink-0 items-center justify-between border-b border-arena-edge bg-arena-bg/60 px-3 py-2">
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
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </div>
  );
}
