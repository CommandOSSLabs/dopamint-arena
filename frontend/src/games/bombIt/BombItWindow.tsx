import type { GameWindowProps } from "../types";
import { usePvpBombIt } from "./usePvpBombIt";
import { BombLobby } from "./components/BombLobby";
import { BombBoard } from "./components/BombBoard";

/** PvP Bomb It: two players bomb each other on a shared grid over a Sui tunnel. */
export function BombItWindow(_props: GameWindowProps) {
  const { status, role, view, winner, error, create, join, queueAction, reset } = usePvpBombIt();

  if (status === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
        <p className="text-sm text-red-400">{error ?? "something went wrong"}</p>
        <button onClick={reset} className="rounded border border-arena-edge px-3 py-1.5 text-sm">
          Back
        </button>
      </div>
    );
  }

  if (status === "idle") {
    return <BombLobby onCreate={create} onJoin={join} />;
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

  if ((status === "playing" || status === "settling" || status === "settled") && view !== null) {
    return (
      <BombBoard view={view} winner={winner} role={role} onAction={queueAction} onPlayAgain={reset} />
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-arena-muted">
      Loading…
    </div>
  );
}
