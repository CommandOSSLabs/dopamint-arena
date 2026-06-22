import { CrossSounds } from "../scene/crossSounds.ts";
import "../cross.css";

const lobbySounds = new CrossSounds();

/** Quick-join PvP entry (single shared queue, no room code) — consistent with the other games. */
export function CrossLobby({ onFindMatch }: { onFindMatch: () => void }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-arena-bg p-4 text-center">
      <h2 className="text-gold text-lg font-extrabold uppercase tracking-widest">Chicken Cross PvP</h2>
      <p className="max-w-xs text-sm text-arena-muted">
        Find an opponent and race your chickens over a shared Sui tunnel.
      </p>

      <button
        onClick={() => {
          lobbySounds.play("click");
          onFindMatch();
        }}
        className="gold-glow-hover rounded border border-amber-500 bg-arena-accent px-6 py-2 font-bold uppercase tracking-widest text-arena-bg transition-all hover:opacity-90"
      >
        Find Match
      </button>
    </div>
  );
}
