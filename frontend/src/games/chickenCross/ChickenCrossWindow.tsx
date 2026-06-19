import type { GameWindowProps } from "../types";
import { usePvpChickenCross } from "./usePvpChickenCross";
import { CrossLobby } from "./components/CrossLobby";
import { CrossBoard } from "./components/CrossBoard";

/** PvP Chicken Cross: two players race their chickens over a shared Sui tunnel. */
export function ChickenCrossWindow(_props: GameWindowProps) {
  const { status, role, code, view, winner, error, create, join, setDir, reset } =
    usePvpChickenCross();

  if (status === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
        <p className="text-sm text-red-400">{error ?? "something went wrong"}</p>
        <button
          onClick={reset}
          className="rounded border border-arena-edge px-3 py-1.5 text-sm"
        >
          Back
        </button>
      </div>
    );
  }

  if (status === "idle") {
    return <CrossLobby onCreate={create} onJoin={join} />;
  }

  if (status === "matching") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
        {code && (
          <div className="flex flex-col items-center gap-1 rounded border border-amber-500 bg-arena-accent/10 px-6 py-3">
            <span className="text-[11px] uppercase tracking-wider text-arena-muted">Match code</span>
            <span className="font-mono text-2xl font-extrabold tracking-[0.25em] text-gold">{code}</span>
          </div>
        )}
        <p className="text-sm text-arena-muted">
          Waiting for opponent… share this code — they Join with it (a different wallet).
        </p>
        <button onClick={reset} className="rounded border border-arena-edge px-3 py-1.5 text-sm text-arena-text">
          Cancel
        </button>
      </div>
    );
  }

  if (status === "funding") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-arena-muted">
        Opening + funding the tunnel on-chain… approve in your wallet.
      </div>
    );
  }

  if (
    (status === "playing" || status === "settling" || status === "settled") &&
    view !== null
  ) {
    return (
      <CrossBoard
        view={view}
        winner={winner}
        role={role}
        onDir={setDir}
        onPlayAgain={reset}
        seed={view.seed}
      />
    );
  }

  // Fallback for transitional states (e.g. playing but view not yet populated).
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-arena-muted">
      Loading…
    </div>
  );
}
