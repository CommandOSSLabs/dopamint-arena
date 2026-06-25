import { memo } from "react";
import { winningLine } from "@ttt/shared";

/** Hand-drawn grid: one rough-filtered SVG (a frame + interior lines) drawn once and stretched to
 *  the square board. Memoized on `size` so the frequent move re-renders never repaint 40+ lines. */
const CaroGrid = memo(function CaroGrid({ size }: { size: number }) {
  const lines = [];
  for (let i = 1; i < size; i++) {
    lines.push(
      <line
        key={`h${i}`}
        x1={0}
        y1={i}
        x2={size}
        y2={i}
        stroke="var(--qp-ink-soft)"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />,
      <line
        key={`v${i}`}
        x1={i}
        y1={0}
        x2={i}
        y2={size}
        stroke="var(--qp-ink-soft)"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />,
    );
  }
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox={`0 0 ${size} ${size}`}
      preserveAspectRatio="none"
      style={{ filter: "url(#qpRough)" }}
    >
      {lines}
      <rect
        x={0}
        y={0}
        width={size}
        height={size}
        fill="none"
        stroke="var(--qp-ink)"
        strokeWidth={2.5}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
});

// Caro board: a fit-to-card size×size grid. Marks: 1 = X (red), 2 = O (ink), drawn as hand-lettered
// glyphs (Gochi Hand) on the sketch grid. The last move is highlighted; once a game is won the
// 5-in-a-row line is highlighted too. Read-only unless `onPlay` is given and `disabled` is false.
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
    <div className="@container relative mx-auto aspect-square h-full w-full max-h-full max-w-full select-none">
      <CaroGrid size={size} />
      <div
        className="relative grid h-full w-full"
        style={{
          gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${size}, minmax(0, 1fr))`,
        }}
      >
        {board.map((v, i) => {
          const playable = !disabled && v === 0 && !!onPlay;
          // Deterministic per-cell tilt so marks look hand-placed, not stamped.
          const tilt = ((i * 17) % 9) - 4;
          return (
            <div
              key={i}
              onClick={playable ? () => onPlay!(i) : undefined}
              className={`flex items-center justify-center ${
                win.has(i)
                  ? "bg-secondary/30"
                  : i === lastMove
                    ? "bg-tertiary/25"
                    : ""
              } ${playable ? "cursor-pointer hover:bg-tertiary/15" : ""}`}
              style={{ fontSize: `calc(72cqw / ${size})`, lineHeight: 1 }}
            >
              {v === 1 ? (
                <span
                  className="mark-x font-bold"
                  style={{ transform: `rotate(${tilt}deg)` }}
                >
                  X
                </span>
              ) : v === 2 ? (
                <span
                  className="mark-o font-bold"
                  style={{ transform: `rotate(${tilt}deg)` }}
                >
                  O
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
