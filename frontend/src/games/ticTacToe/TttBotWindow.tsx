import type { GameWindowProps } from "../types";
import { useTttBotSession } from "./useTttBotSession";

const CELL = (v: number) => (v === 1 ? "X" : v === 2 ? "O" : "");

/** Bot-vs-bot Tic-Tac-Toe over a REAL Sui tunnel: the wallet opens+funds both seats (one
 *  signature), the bots co-sign moves off-chain, and the result settles back on-chain. */
export function TttBotWindow(_props: GameWindowProps) {
  const g = useTttBotSession();

  if (g.status === "idle") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
        <p className="text-sm text-arena-muted">
          Two bots stake <span className="text-arena-accent">500 each</span> and co-sign a game over
          a real tunnel; winner takes 100 on-chain.
        </p>
        <button
          onClick={g.start}
          className="rounded bg-arena-accent px-4 py-2 text-sm font-semibold text-black"
        >
          Run Bots
        </button>
      </div>
    );
  }

  if (g.status === "funding") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-arena-muted">
        Opening + funding the tunnel on-chain… approve in your wallet.
      </div>
    );
  }

  if (g.status === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
        <p className="text-sm text-red-400">{g.error ?? "something went wrong"}</p>
        <button onClick={g.reset} className="rounded border border-arena-edge px-3 py-1.5 text-sm">
          Back
        </button>
      </div>
    );
  }

  const banner =
    g.winner === 1
      ? "Bot X wins (+100 on-chain)"
      : g.winner === 2
        ? "Bot O wins (+100 on-chain)"
        : g.winner === 3
          ? "Draw — stakes returned"
          : g.status === "settling"
            ? "Settling on-chain…"
            : "Bots playing…";

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-3">
      <div className="text-xs text-arena-muted">
        Bot <span className="text-arena-accent font-semibold">X</span> vs Bot{" "}
        <span className="text-arena-accent font-semibold">O</span>
        {g.status === "settled" && " · settled ✓"}
      </div>
      <div className="grid grid-cols-3 gap-1">
        {g.board.map((v, i) => (
          <div
            key={i}
            className="flex h-16 w-16 items-center justify-center rounded bg-arena-panel text-2xl font-bold text-arena-text"
          >
            {CELL(v)}
          </div>
        ))}
      </div>
      <div className="text-sm font-semibold text-arena-text">{banner}</div>
      {(g.status === "settled" || g.winner !== 0) && (
        <button onClick={g.reset} className="rounded border border-arena-edge px-3 py-1.5 text-sm">
          Run Again
        </button>
      )}
    </div>
  );
}
