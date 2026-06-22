import { CELL_PLAYER, CELL_SERVER } from "@ttt/shared";

export function Cell({
  value,
  onClick,
  playable,
}: {
  value: number;
  onClick: () => void;
  playable: boolean;
}) {
  const label = value === CELL_PLAYER ? "O" : value === CELL_SERVER ? "X" : "";
  const markClass =
    value === CELL_PLAYER
      ? "mark-o text-5xl md:text-6xl"
      : value === CELL_SERVER
        ? "mark-x text-5xl md:text-6xl animate-[ping_0.15s_ease-out_1]"
        : "";

  return (
    <button
      onClick={onClick}
      disabled={!playable}
      className={`w-full h-full flex items-center justify-center transition-colors focus:outline-none
                  ${playable ? "hover:bg-tertiary-container/15 cursor-pointer" : "cursor-default"}`}
    >
      {label && (
        <span className={`${markClass} select-none font-bold`}>{label}</span>
      )}
    </button>
  );
}
