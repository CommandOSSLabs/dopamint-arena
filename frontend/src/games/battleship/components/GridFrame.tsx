import type { ReactNode } from "react";

const COLS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
const ROWS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/**
 * The classic 10×10 Battleship frame: column letters A–J across the top, row
 * numbers 1–10 down the side. `renderCell` draws each of the 100 squares by its
 * row-major index, so both the firing and fleet boards share one layout.
 */
export function GridFrame({
  renderCell,
}: {
  renderCell: (cell: number) => ReactNode;
}) {
  return (
    <div
      className="grid w-full gap-[2px]"
      style={{ gridTemplateColumns: "0.9rem repeat(10, minmax(0, 1fr))" }}
    >
      <span />
      {COLS.map((c) => (
        <span
          key={`c${c}`}
          className="text-center text-[9px] leading-4 text-arena-muted"
        >
          {c}
        </span>
      ))}
      {ROWS.map((r, ri) => (
        <FrameRow key={`r${r}`} label={r}>
          {COLS.map((_, ci) => renderCell(ri * 10 + ci))}
        </FrameRow>
      ))}
    </div>
  );
}

function FrameRow({ label, children }: { label: number; children: ReactNode }) {
  return (
    <>
      <span className="flex items-center justify-center text-[9px] text-arena-muted">
        {label}
      </span>
      {children}
    </>
  );
}
