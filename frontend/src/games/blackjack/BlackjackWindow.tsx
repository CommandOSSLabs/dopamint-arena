import type { GameWindowProps } from "../types";
import { useBlackjackSession } from "./useBlackjackSession";
import { BetPanel } from "./components/BetPanel";
import { BlackjackTable } from "./components/BlackjackTable";

/** Bot-vs-bot Blackjack over a REAL Sui tunnel: the wallet opens+funds it (one signature),
 *  the bots co-sign play off-chain, and the result settles back on-chain. */
export function BlackjackWindow(_props: GameWindowProps) {
  const { status, view, result, error, start, reset } = useBlackjackSession();

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
    return <BetPanel onDeal={start} />;
  }

  return (
    <BlackjackTable
      view={view}
      result={result}
      settled={status === "settled"}
      onPlayAgain={reset}
    />
  );
}
