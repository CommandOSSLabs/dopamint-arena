/**
 * The original notebook-style Tic-Tac-Toe board, ported self-contained (inline styles only, no
 * dependency on the standalone app's CSS/theme) so it renders identically inside the platform
 * window. Marks: 1 = X (navy), 2 = O (red), drawn in a hand-written font; grid lines are slightly
 * rotated like the original hand-drawn arena. Interactive when `onPlay` is given and not disabled.
 */
const NAVY = "#001e40"; // primary (X + grid ink)
const RED = "#bc0000"; // secondary (O)
const HAND = "'Gochi Hand', 'Comic Sans MS', cursive";
const SIZE = 280;

export function TttBoard({
  board,
  lastMove = -1,
  onPlay,
  disabled = true,
}: {
  board: number[];
  lastMove?: number;
  onPlay?: (cell: number) => void;
  disabled?: boolean;
}) {
  const line = { position: "absolute" as const, background: NAVY, pointerEvents: "none" as const };
  return (
    <div
      style={{
        position: "relative",
        width: SIZE,
        height: SIZE,
        background: "#fbf7ec",
        borderRadius: 6,
        boxShadow: "0 3px 14px rgba(0,0,0,0.35)",
      }}
    >
      {/* hand-drawn grid lines (2 horizontal, 2 vertical), each slightly rotated */}
      <div style={{ ...line, top: "33.33%", left: 10, right: 10, height: 3, transform: "rotate(-0.5deg)" }} />
      <div style={{ ...line, top: "66.66%", left: 10, right: 10, height: 3, transform: "rotate(0.4deg)" }} />
      <div style={{ ...line, left: "33.33%", top: 10, bottom: 10, width: 3, transform: "rotate(0.2deg)" }} />
      <div style={{ ...line, left: "66.66%", top: 10, bottom: 10, width: 3, transform: "rotate(-0.3deg)" }} />

      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gridTemplateRows: "repeat(3, 1fr)",
        }}
      >
        {board.map((v, i) => {
          const playable = !disabled && v === 0 && !!onPlay;
          return (
            <button
              key={i}
              onClick={playable ? () => onPlay!(i) : undefined}
              disabled={!playable}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontFamily: HAND,
                fontWeight: 700,
                fontSize: 60,
                lineHeight: 1,
                color: v === 1 ? NAVY : RED,
                background: i === lastMove ? "rgba(212,175,55,0.18)" : "transparent",
                cursor: playable ? "pointer" : "default",
                border: "none",
                outline: "none",
                userSelect: "none",
              }}
            >
              {v === 1 ? "X" : v === 2 ? "O" : ""}
            </button>
          );
        })}
      </div>
    </div>
  );
}
