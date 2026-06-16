import { useState } from "react";
import "../blackjack.css";
import dealerDesk from "../assets/dealer-desk.png";

/** Idle-state control: the player only sets a stake; the bots play it out. */
export function BetPanel({ onDeal }: { onDeal: (stake: number) => void }) {
  const [stake, setStake] = useState<number>(500);
  return (
    <div
      className="relative flex h-full w-full flex-col items-center justify-center gap-3 bg-cover bg-center p-4 text-center"
      style={{ backgroundImage: `url(${dealerDesk})` }}
    >
      {/* Dark vignette so the form stays readable over the felt art */}
      <div className="absolute inset-0 bg-black/65" />

      <div className="fade-in-up relative z-10 flex flex-col items-center gap-3">
        <h2 className="text-gold text-lg font-extrabold uppercase tracking-widest">
          Blackjack
        </h2>
        <p className="text-sm text-arena-text">
          Set a stake — two bots play it out.
        </p>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-arena-muted">
            Stake
          </span>
          <input
            id="blackjack-stake"
            name="stake"
            type="number"
            min={100}
            step={100}
            value={stake}
            onChange={(e) => setStake(Number(e.target.value) || 0)}
            className="w-40 rounded border border-arena-edge bg-arena-bg px-2 py-1.5 text-center font-mono text-arena-text"
          />
        </label>

        <button
          onClick={() => onDeal(stake)}
          className="gold-glow-hover rounded border border-amber-500 bg-arena-accent px-6 py-2 font-bold uppercase tracking-widest text-arena-bg transition-all hover:opacity-90"
        >
          Deal
        </button>

        <p className="max-w-xs text-[11px] text-arena-muted">
          Bots co-sign each move over a Sui tunnel; play runs until one is out of
          chips.
        </p>
      </div>
    </div>
  );
}
