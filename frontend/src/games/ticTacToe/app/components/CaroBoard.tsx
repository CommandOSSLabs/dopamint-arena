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
  const cell = Math.max(14, Math.floor(540 / size));
  const dim = cell * size;
  const win = new Set(winningLine(board, size, lastMove));
  return (
    <div className="max-w-full max-h-[620px] overflow-auto border-[2px] border-primary rounded-sm bg-surface p-1">
      <div
        className="grid"
        style={{
          gridTemplateColumns: `repeat(${size}, ${cell}px)`,
          gridTemplateRows: `repeat(${size}, ${cell}px)`,
          width: dim,
          height: dim,
        }}
      >
        {board.map((v, i) => {
          const playable = !disabled && v === 0 && !!onPlay;
          return (
            <div
              key={i}
              onClick={playable ? () => onPlay!(i) : undefined}
              className={`flex items-center justify-center border border-primary/15 ${
                win.has(i)
                  ? "bg-secondary/40"
                  : i === lastMove
                    ? "bg-tertiary/30"
                    : ""
              } ${playable ? "cursor-pointer hover:bg-tertiary/20" : ""}`}
              style={{ fontSize: Math.floor(cell * 0.7), lineHeight: 1 }}
            >
              {v === 1 ? (
                <span className="text-primary font-bold">✕</span>
              ) : v === 2 ? (
                <span className="text-secondary font-bold">◯</span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
