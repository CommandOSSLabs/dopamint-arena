import { winningLine } from "@ttt/shared";

// Caro board: a fit-to-card size×size grid. Marks: 1 = Bot X (✕), 2 = Bot O (◯).
// The last move is highlighted; once a game is won, the 5-in-a-row line is highlighted too
// (winningLine is empty mid-game). Read-only (bot-vs-bot); cells aren't clickable.
export function CaroBoard({
  board,
  size,
  lastMove,
}: {
  board: number[];
  size: number;
  lastMove: number;
}) {
  // Keep the board's footprint close to the 3×3 board so the action buttons below it stay on
  // screen inside the fixed-height game card. Cells shrink as the board grows (min 14px keeps
  // marks legible); a board larger than the frame scrolls inside it rather than growing the card.
  const cell = Math.max(14, Math.floor(320 / size));
  const dim = cell * size;
  const win = new Set(winningLine(board, size, lastMove));
  return (
    <div className="max-w-full max-h-[340px] overflow-auto border-[2px] border-primary rounded-sm bg-surface p-1">
      <div
        className="grid"
        style={{
          gridTemplateColumns: `repeat(${size}, ${cell}px)`,
          gridTemplateRows: `repeat(${size}, ${cell}px)`,
          width: dim,
          height: dim,
        }}
      >
        {board.map((v, i) => (
          <div
            key={i}
            className={`flex items-center justify-center border border-primary/15 ${
              win.has(i) ? "bg-secondary/40" : i === lastMove ? "bg-tertiary/30" : ""
            }`}
            style={{ fontSize: Math.floor(cell * 0.7), lineHeight: 1 }}
          >
            {v === 1 ? (
              <span className="text-primary font-bold">✕</span>
            ) : v === 2 ? (
              <span className="text-secondary font-bold">◯</span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
