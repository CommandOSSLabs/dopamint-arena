import { useState } from "react";
import type { GameWindowProps } from "../types";
import { usePvpBombIt } from "./usePvpBombIt";
import { BombLobby } from "./components/BombLobby";
import { BombBoard } from "./components/BombBoard";
import { BombBench } from "./components/BombBench";

/** PvP Bomb It: two players bomb each other on a shared grid over a Sui tunnel.
 *  Also hosts a bot-vs-bot TPS benchmark (self-play) reachable from the lobby. */
export function BombItWindow(_props: GameWindowProps) {
  const [mode, setMode] = useState<"pvp" | "bench">("pvp");
  const { status, role, view, winner, error, findMatch, queueAction, reset } = usePvpBombIt();

  if (mode === "bench") {
    return <BombBench onExit={() => setMode("pvp")} />;
  }

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
    return <BombLobby onFindMatch={findMatch} onBenchmark={() => setMode("bench")} />;
  }

  if (status === "matching") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
        <p className="text-sm text-arena-muted">Finding an opponent…</p>
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
