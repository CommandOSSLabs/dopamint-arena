import { Cell } from "./Cell";

export function Board({ board, onPlay, disabled }: {
  board: number[]; onPlay: (cell: number) => void; disabled: boolean;
}) {
  return (
    <div className="w-[280px] h-[280px] relative hand-drawn-grid select-none">
      <div className="v-line-1"></div>
      <div className="v-line-2"></div>
      <div className="grid grid-cols-3 grid-rows-3 h-full w-full relative z-10">
        {board.map((v, i) => (
          <Cell key={i} value={v} playable={!disabled && v === 0} onClick={() => onPlay(i)} />
        ))}
      </div>
    </div>
  );
}
