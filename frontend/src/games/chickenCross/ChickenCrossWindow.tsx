import type { GameWindowProps } from "../types";
import { useChickenCrossSession } from "./useChickenCrossSession";
import { BetPanel } from "./components/BetPanel";
import { CrossBoard } from "./components/CrossBoard";

/** Bot-vs-bot Chicken Cross over a REAL Sui tunnel: the wallet opens+funds it (one signature),
 *  the bots co-sign each tick off-chain, and the winner settles back on-chain. */
export function ChickenCrossWindow(_props: GameWindowProps) {
  const { status, view, result, error, start, reset } = useChickenCrossSession();

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

  if (status === "funding") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-arena-muted">
        Opening + funding the tunnel on-chain… approve in your wallet.
      </div>
    );
  }

  if (status === "idle" || !view) {
    return <BetPanel onStart={start} />;
  }

  // `view.seed` is the protocol's hazard-field seed, so the board's cosmetic hazards line up
  // exactly with the collisions the protocol computed.
  return (
    <CrossBoard
      view={view}
      result={result}
      settled={status === "settled"}
      onPlayAgain={reset}
      seed={view.seed}
    />
  );
}
