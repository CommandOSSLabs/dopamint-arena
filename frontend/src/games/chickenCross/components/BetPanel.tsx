import { useState } from "react";
import { WIN_LANE } from "sui-tunnel-ts/protocol/cross";
import "../cross.css";

/** Idle-state control: the player sets a stake; two bot chickens race it out. */
export function BetPanel({ onStart }: { onStart: (stake: number) => void }) {
  const [stake, setStake] = useState<number>(500);
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-arena-bg p-4 text-center">
      <h2 className="text-gold text-lg font-extrabold uppercase tracking-widest">Chicken Cross</h2>
      <p className="text-sm text-arena-text">Set a stake — two bot chickens race across the lanes.</p>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] uppercase tracking-wider text-arena-muted">Stake</span>
        <input
          id="chicken-cross-stake"
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
        onClick={() => onStart(stake)}
        className="gold-glow-hover rounded border border-amber-500 bg-arena-accent px-6 py-2 font-bold uppercase tracking-widest text-arena-bg transition-all hover:opacity-90"
      >
        Race
      </button>
      <p className="max-w-xs text-[11px] text-arena-muted">
        Each tick is co-signed over a Sui tunnel; first chicken to lane {WIN_LANE} takes the pot.
      </p>
    </div>
  );
}
