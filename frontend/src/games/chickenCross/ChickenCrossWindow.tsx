import type { GameWindowProps } from "../types";
import { usePvpChickenCross } from "./usePvpChickenCross";
import { CrossLobby } from "./components/CrossLobby";
import { CrossBoard } from "./components/CrossBoard";

/** PvP Chicken Cross: two players race their chickens over a shared Sui tunnel. */
export function ChickenCrossWindow(_props: GameWindowProps) {
  const { status, role, view, winner, error, create, join, setDir, reset } =
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
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-arena-muted">
        Waiting for opponent… share your code.
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
