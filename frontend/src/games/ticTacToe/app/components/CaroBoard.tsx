import { winningLine } from "@ttt/shared";

// Caro board: a fit-to-card size×size grid. Marks: 1 = X (✕), 2 = O (◯). The last move is
// highlighted; once a game is won the 5-in-a-row line is highlighted too (winningLine is empty
// mid-game). Read-only unless `onPlay` is given and `disabled` is false (PvP places stones).
export function CaroBoard({
  board,
  size,
  lastMove,
  onPlay,
  disabled = true,
}: {
  board: number[];
  size: number;
  lastMove: number;
  onPlay?: (cell: number) => void;
  disabled?: boolean;
}) {
  const win = new Set(winningLine(board, size, lastMove));
  return (
    <div className="@container w-full h-full max-h-[90vh] max-w-[90vw] aspect-square overflow-hidden border-[2px] border-[var(--qp-ink)] rounded-sm bg-surface p-1 flex justify-center items-center mx-auto">
      <div
        className="grid w-full h-full"
        style={{
          gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${size}, minmax(0, 1fr))`,
        }}
      >
        {board.map((v, i) => {
          const playable = !disabled && v === 0 && !!onPlay;
          return (
            <div
              key={i}
              onClick={playable ? () => onPlay!(i) : undefined}
              className={`flex items-center justify-center border border-[var(--qp-ink-soft)]/20 ${
                win.has(i)
                  ? "bg-secondary/40"
                  : i === lastMove
                    ? "bg-tertiary/30"
                    : ""
              } ${playable ? "cursor-pointer hover:bg-tertiary/20" : ""}`}
              style={{ fontSize: `calc(65cqw / ${size})`, lineHeight: 1 }}
            >
              {v === 1 ? (
                <span className="text-[var(--qp-red)] font-bold">✕</span>
              ) : v === 2 ? (
                <span className="text-[var(--qp-ink)] font-bold">◯</span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
