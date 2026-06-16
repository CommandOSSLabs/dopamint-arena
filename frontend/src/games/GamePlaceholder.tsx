import type { GameWindowProps } from "./types";

/**
 * Builds a placeholder window for a game whose owner hasn't wired the real UI
 * yet. Each game folder registers one of these; the owner swaps it for a real
 * `Window` component (see regularPayments for the worked example).
 */
export function makePlaceholder(name: string) {
  return function PlaceholderWindow(_props: GameWindowProps) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
        <p className="text-sm text-arena-text">{name}</p>
        <p className="text-[11px] text-arena-muted">
          Bot self-play stub — wire to the {name} Protocol + agent loop.
        </p>
      </div>
    );
  };
}
