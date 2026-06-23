import "../bomb-it.css";

/** Quick-join PvP entry (single shared queue, no room code) — consistent with the other games. */
export function BombLobby({
  onFindMatch,
  onBenchmark,
}: {
  onFindMatch: () => void;
  /** Enter the bot-vs-bot TPS benchmark (self-play). Omitted hides the entry. */
  onBenchmark?: () => void;
}) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-arena-bg p-4 text-center">
      <h2 className="text-gold text-lg font-extrabold uppercase tracking-widest">
        Bomb It PvP
      </h2>
      <p className="max-w-xs text-sm text-arena-muted">
        Find an opponent and bomb each other on a shared grid over a Sui tunnel.
      </p>

      <button
        onClick={onFindMatch}
        className="gold-glow-hover rounded border border-amber-500 bg-arena-accent px-6 py-2 font-bold uppercase tracking-widest text-arena-bg transition-all hover:opacity-90"
      >
        Find Match
      </button>

      {onBenchmark && (
        <button
          onClick={onBenchmark}
          className="text-[11px] uppercase tracking-widest text-arena-muted underline-offset-2 transition-all hover:text-gold hover:underline"
        >
          TPS Benchmark · bot vs bot
        </button>
      )}
    </div>
  );
}
