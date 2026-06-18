import type { GameWindowProps } from "../types";
import { ScaleToFit } from "../ScaleToFit";
import { usePvpTicTacToe } from "./usePvpTicTacToe";
import { TttBoard } from "./components/TttBoard";

/** Real two-player tic-tac-toe over a Sui tunnel: matchmaking + relay co-sign + on-chain stakes. */
export function TicTacToePvpWindow(_props: GameWindowProps) {
  const g = usePvpTicTacToe();

  if (g.status === "idle") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
        <p className="text-sm text-arena-muted">
          Stake 500 vs a real opponent. You play{" "}
          <span className="text-arena-accent">X if matched first</span>; winner takes 100 on-chain.
        </p>
        <button
          onClick={g.findMatch}
          className="rounded bg-arena-accent px-4 py-2 text-sm font-semibold text-black"
        >
          Find Match
        </button>
      </div>
    );
  }

  if (g.status === "matching" || g.status === "funding") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-arena-muted">
        <div>{g.status === "matching" ? "Finding an opponent…" : "Opening + funding the tunnel on-chain…"}</div>
        {g.opponentWallet && (
          <div className="text-[11px]">vs {g.opponentWallet.slice(0, 10)}…</div>
        )}
      </div>
    );
  }

  if (g.status === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
        <p className="text-sm text-red-400">{g.error}</p>
        <button onClick={g.reset} className="rounded border border-arena-edge px-3 py-1.5 text-sm">
          Back
        </button>
      </div>
    );
  }

  const banner =
    g.winner === 1 || g.winner === 2
      ? (g.winner === 1 ? "X" : "O") === g.mark
        ? "You win! (+100 on-chain)"
        : "You lose (-100)"
      : g.winner === 3
        ? "Draw — stakes returned"
        : g.myTurn
          ? "Your turn"
          : "Opponent's turn";

  return (
    <ScaleToFit designWidth={300} designHeight={372}>
      <div className="flex h-full w-full flex-col items-center justify-center gap-3">
        <div className="text-xs text-arena-muted">
          You are{" "}
          <span style={{ color: g.mark === "X" ? "#001e40" : "#bc0000", fontWeight: 700 }}>{g.mark}</span>
          {g.status === "settling" && " · settling on-chain…"}
          {g.status === "settled" && " · settled ✓"}
        </div>
        <TttBoard board={g.board} disabled={!g.myTurn} onPlay={g.play} />
        <div className="text-sm font-semibold text-arena-text">{banner}</div>
        {(g.status === "settled" || g.winner !== 0) && (
          <button onClick={g.reset} className="rounded border border-arena-edge px-3 py-1.5 text-sm">
            Play Again
          </button>
        )}
      </div>
    </ScaleToFit>
  );
}
