import { useBombItBenchSession } from "../useBombItBenchSession";
import { BombBoard } from "./BombBoard";
import "../bomb-it.css";

/**
 * Bomb It TPS benchmark surface: bot-vs-bot self-play that GENERATES throughput. The headline is
 * the live measured ticks/sec (each tick = one dual-signed, settleable update); the slider sets
 * the target rate. Drives the same shared telemetry the desktop's TPS panel reads.
 */
export function BombBench({ onExit }: { onExit?: () => void }) {
  const {
    status,
    running,
    view,
    targetTps,
    measuredTps,
    gamesSettled,
    totalUpdates,
    result,
    error,
    start,
    stop,
    setTargetTps,
    reset,
  } = useBombItBenchSession();

  const statusLabel: Record<typeof status, string> = {
    idle: "idle",
    funding: "opening tunnel on-chain…",
    playing: "benchmarking",
    settling: "settling on-chain…",
    settled: "settled — next game…",
    error: "error",
  };

  return (
    <div className="flex h-full w-full flex-col gap-2 bg-arena-bg p-3">
      <div className="flex items-center justify-between">
        <h2 className="text-gold text-sm font-extrabold uppercase tracking-widest">
          Bomb It · TPS Bench
        </h2>
        {onExit && (
          <button
            onClick={onExit}
            className="rounded border border-arena-edge px-2 py-1 text-[11px] text-arena-muted hover:opacity-80"
          >
            ← PvP
          </button>
        )}
      </div>

      {/* Live readout — the headline is measured ticks/sec for the active game. */}
      <div className="grid grid-cols-4 gap-2 rounded border border-arena-edge bg-arena-accent/5 p-2 text-center">
        <Stat label="TPS (now)" value={measuredTps.toFixed(0)} accent />
        <Stat label="Target" value={String(targetTps)} />
        <Stat label="Games" value={String(gamesSettled)} />
        <Stat label="Updates" value={String(totalUpdates)} />
      </div>

      <label className="flex items-center gap-2 px-1 text-[11px] text-arena-muted">
        <span className="uppercase tracking-wider">Target TPS</span>
        <input
          type="range"
          min={10}
          max={200}
          step={5}
          value={targetTps}
          onChange={(e) => setTargetTps(Number(e.target.value))}
          className="flex-1 accent-amber-500"
        />
        <span className="w-8 text-right font-mono text-arena-text">
          {targetTps}
        </span>
      </label>

      <div className="flex items-center gap-2 px-1">
        {!running ? (
          <button
            onClick={start}
            className="gold-glow-hover rounded border border-amber-500 bg-arena-accent px-4 py-1.5 text-sm font-bold uppercase tracking-widest text-arena-bg transition-all hover:opacity-90"
          >
            Start
          </button>
        ) : (
          <button
            onClick={stop}
            className="rounded border border-arena-edge px-4 py-1.5 text-sm font-bold uppercase tracking-widest text-arena-text transition-all hover:opacity-90"
          >
            Stop
          </button>
        )}
        <button
          onClick={reset}
          className="rounded border border-arena-edge px-3 py-1.5 text-xs text-arena-muted transition-all hover:opacity-80"
        >
          Reset
        </button>
        <span className="ml-auto text-[11px] text-arena-muted">
          {statusLabel[status]}
        </span>
      </div>

      {error && <p className="px-1 text-xs text-red-400">{error}</p>}

      <div className="min-h-0 flex-1">
        {view ? (
          <BombBoard
            view={view}
            winner={result === "draw" ? null : result}
            role={null}
            onAction={() => {}}
            onPlayAgain={() => {}}
            spectate
          />
        ) : (
          <div className="flex h-full items-center justify-center text-center text-xs text-arena-muted">
            {running
              ? "opening the first tunnel…"
              : "Press Start — two bots self-play a settleable Bomb It match at the target rate."}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <span
        className={`font-mono text-lg font-extrabold ${accent ? "text-gold" : "text-arena-text"}`}
      >
        {value}
      </span>
      <span className="text-[10px] uppercase tracking-wider text-arena-muted">
        {label}
      </span>
    </div>
  );
}
