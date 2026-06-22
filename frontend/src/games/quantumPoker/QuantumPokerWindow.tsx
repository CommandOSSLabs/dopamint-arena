import { useCurrentAccount } from "@mysten/dapp-kit";
import type { PokerMove } from "sui-tunnel-ts/protocol/quantumPoker";
import type { GameWindowProps } from "../types";
import { useQuantumPokerBot } from "./useQuantumPokerBot";
import { QuantumPokerTable, HEADS_UP_STYLE } from "./QuantumPokerTable";
import { pokerRaiseSizes } from "./pokerBetting";

// ---------------------------------------------------------------------------
// Presentational helpers (local only — moveLabel drives the action transcript)
// ---------------------------------------------------------------------------

function moveLabel(move: PokerMove): string {
  switch (move.kind) {
    case "commit_slots":
      return "committed 9 slots";
    case "reveal_slots":
      return `revealed ${move.slots.join("/")}`;
    case "bet":
      return `bet ${move.amount}`;
    case "check":
      return "check";
    case "call":
      return "call";
    case "fold":
      return "fold";
    case "next_hand":
      return "next hand";
  }
}

// Keep moveLabel referenced so TypeScript doesn't warn on an unused export.
void moveLabel;

// ---------------------------------------------------------------------------
// ActionBar — human betting controls
// ---------------------------------------------------------------------------

function ActionBar({
  legal,
  pot,
  onAct,
}: {
  legal: NonNullable<ReturnType<typeof useQuantumPokerBot>["legal"]>;
  pot: bigint;
  onAct: (m: PokerMove) => void;
}) {
  const raise = (amt: bigint) => onAct({ kind: "bet", amount: amt });
  // Same three pot-relative sizes as PvP: ½ pot, pot, all-in.
  const sizes = pokerRaiseSizes({
    pot,
    callAmount: legal.callAmount,
    minBet: legal.minBet,
    maxBet: legal.maxBet,
    canBet: legal.minBet > 0n,
  });
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-white/10 bg-black/30 p-2">
      <button
        type="button"
        onClick={() => onAct({ kind: "fold" })}
        className="h-7 rounded-sm border border-rose-300/40 px-3 text-[11px] font-semibold text-rose-100"
      >
        Fold
      </button>
      {legal.canCheck && (
        <button
          type="button"
          onClick={() => onAct({ kind: "check" })}
          className="h-7 rounded-sm border border-white/20 px-3 text-[11px] font-semibold text-slate-100"
        >
          Check
        </button>
      )}
      {legal.canCall && (
        <button
          type="button"
          onClick={() => onAct({ kind: "call" })}
          className="h-7 rounded-sm border border-[var(--qp-cyan)]/50 px-3 text-[11px] font-semibold text-cyan-100"
        >
          Call {legal.callAmount.toString()}
        </button>
      )}
      {sizes.showHalf && (
        <button
          type="button"
          onClick={() => raise(sizes.half)}
          className="h-7 rounded-sm border border-amber-200/40 px-3 text-[11px] font-semibold text-amber-100"
        >
          ½ Pot · {sizes.half.toString()}
        </button>
      )}
      {sizes.showFull && (
        <button
          type="button"
          onClick={() => raise(sizes.full)}
          className="h-7 rounded-sm border border-amber-200/40 px-3 text-[11px] font-semibold text-amber-100"
        >
          Pot · {sizes.full.toString()}
        </button>
      )}
      {sizes.showAllIn && (
        <button
          type="button"
          onClick={() => raise(sizes.allIn)}
          className="h-7 rounded-sm bg-[var(--qp-gold)] px-3 text-[11px] font-black text-slate-950"
        >
          All-in · {sizes.allIn.toString()}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------

export function QuantumPokerWindow({
  windowId,
  onExit,
}: GameWindowProps & { lane?: "bot" | "auto"; onExit?: () => void }) {
  const account = useCurrentAccount();
  const game = useQuantumPokerBot(windowId);
  const s = game.state;

  if (!s) {
    return (
      <div
        style={HEADS_UP_STYLE}
        className="flex h-full min-h-[14rem] flex-col items-center justify-center gap-3 bg-[#080b0d] p-5 text-center text-slate-100"
      >
        <span className="rounded-sm bg-[var(--qp-gold)] px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.14em] text-slate-950">
          bot mode
        </span>
        <p className="max-w-[17rem] text-[12px] text-slate-400">
          Open a real self-play tunnel: your wallet funds both seats once, you
          play party A, a random-persona bot plays party B, then it settles
          gas-free.
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={game.open}
            disabled={game.status === "funding" || !account}
            className="rounded-md bg-[var(--qp-gold)] px-4 py-2 text-[12px] font-bold text-slate-950 disabled:opacity-45"
          >
            {game.status === "funding"
              ? "Opening…"
              : account
                ? "Open tunnel"
                : "Connect wallet"}
          </button>
          {onExit && (
            <button
              type="button"
              onClick={onExit}
              className="rounded-md border border-white/15 px-4 py-2 text-[12px] font-semibold text-slate-200"
            >
              Back
            </button>
          )}
        </div>
        {game.error && (
          <div className="text-[10px] text-rose-300">{game.error}</div>
        )}
      </div>
    );
  }

  const holesB = s.shownHoleB ?? [];

  return (
    <div
      style={HEADS_UP_STYLE}
      className="flex h-full min-h-[14rem] flex-col overflow-hidden bg-[#080b0d] text-slate-100"
    >
      <main className="flex min-h-0 flex-1 flex-col gap-2 p-2">
        <QuantumPokerTable
          state={s}
          holesA={game.humanHoles}
          holesB={holesB}
          nameA="You"
          nameB="Bot"
        />

        {/* Human action bar — only shown when it's the human's betting turn */}
        {game.status === "awaitHuman" && game.legal && (
          <ActionBar
            legal={game.legal}
            pot={s.totalBetA + s.totalBetB}
            onAct={game.act}
          />
        )}

        {/* Status footer */}
        <div className="px-2 py-1 text-[10px] text-slate-500">
          {game.status === "settled"
            ? "Settled."
            : game.status === "settling"
              ? "Settling…"
              : `phase ${s.phase}`}
          {game.status === "settled" && (
            <button
              type="button"
              onClick={game.open}
              className="ml-2 rounded-sm border border-white/15 px-2 py-0.5 text-[10px]"
            >
              New tunnel
            </button>
          )}
          {onExit && (
            <button
              type="button"
              onClick={onExit}
              className="ml-2 rounded-sm border border-white/15 px-2 py-0.5 text-[10px]"
            >
              Back
            </button>
          )}
        </div>
      </main>
    </div>
  );
}
