import { useState } from "react";
import type { GameWindowProps } from "../types";
import { usePvpChickenCross } from "./usePvpChickenCross";
import { useChickenCrossSession } from "./useChickenCrossSession";
import { CrossLobby } from "./components/CrossLobby";
import { CrossBoard } from "./components/CrossBoard";
import { MIN_STAKE } from "sui-tunnel-ts/protocol/cross";

/** PvP Chicken Cross: two players race their chickens over a shared Sui tunnel. */
export function ChickenCrossWindow(_props: GameWindowProps) {
  const { status, role, code, view, winner, error, create, join, findMatch, setDir, reset } =
    usePvpChickenCross();
  const session = useChickenCrossSession();

  const [mode, setMode] = useState<"pvp" | "solo">("pvp");

  // Solo (self-play bot demo) rendering path.
  if (mode === "solo") {
    return (
      <div className="relative flex h-full w-full flex-col">
        <button
          onClick={() => { session.stopLoop(); setMode("pvp"); }}
          className="absolute right-2 top-2 z-10 rounded border border-arena-edge px-3 py-1 text-xs text-arena-muted hover:text-arena-text"
        >
          Stop
        </button>
        {session.view === null ? (
          <div className="flex h-full items-center justify-center text-sm text-arena-muted">
            Starting bots…
          </div>
        ) : (
          <CrossBoard
            view={session.view}
            winner={null}
            role={null}
            onDir={() => {}}
            onPlayAgain={() => {}}
            seed={session.view.seed}
          />
        )}
      </div>
    );
  }

  // PvP path — entirely unchanged below this point.

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
    return (
      <div className="flex h-full w-full flex-col">
        <CrossLobby onCreate={create} onJoin={join} onFindMatch={findMatch} />
        <div className="flex justify-center pb-4">
          <button
            onClick={() => {
              setMode("solo");
              session.startLoop(Number(MIN_STAKE), 5 * 60 * 1000, 15);
            }}
            className="rounded border border-arena-edge px-4 py-1.5 text-sm text-arena-muted hover:text-arena-text"
          >
            Self-play (bots)
          </button>
        </div>
      </div>
    );
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
