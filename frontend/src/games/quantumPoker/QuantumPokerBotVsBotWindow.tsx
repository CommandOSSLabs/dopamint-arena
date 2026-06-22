import type { CSSProperties } from "react";
import type { GameWindowProps } from "../types";
import { useQuantumPokerAuto } from "./useQuantumPokerAuto";
import { QuantumPokerTable, HEADS_UP_STYLE } from "./QuantumPokerTable";

const STYLE: CSSProperties & Record<`--${string}`, string> = {
  "--qp-ink": "#090d12",
  "--qp-gold": "#f7c45b",
  "--qp-green": "#2dd4bf",
  "--qp-rail": "#151a20",
};

function sui(mist: bigint): string {
  return (Number(mist) / 1e9).toFixed(3);
}

export function QuantumPokerBotVsBotWindow({
  windowId,
  onExit,
}: GameWindowProps & { onExit?: () => void }) {
  const s = useQuantumPokerAuto(windowId);
  const running = s.status === "running";

  return (
    <div
      style={{ ...STYLE, ...HEADS_UP_STYLE }}
      className="flex h-full min-h-[14rem] flex-col overflow-hidden bg-[var(--qp-ink)] text-slate-100"
    >
      <header className="flex h-8 shrink-0 items-center justify-between border-b border-white/10 bg-[var(--qp-rail)] px-2">
        <div className="flex items-center gap-1.5">
          {onExit && (
            <button
              type="button"
              onClick={onExit}
              disabled={running}
              className="h-5 rounded-sm border border-white/10 px-1.5 text-[10px] text-slate-300 disabled:opacity-40"
            >
              Back
            </button>
          )}
          <span className="rounded-sm bg-[var(--qp-gold)] px-1.5 py-0.5 text-[8px] font-black text-slate-950">
            AUTO
          </span>
          <span className="text-[11px] font-semibold">Bot arena</span>
        </div>
        <div className="flex items-center gap-1">
          {running ? (
            <button
              type="button"
              onClick={s.stopAuto}
              title="Finishes the current tunnel, then stops"
              className="h-5 rounded-sm border border-rose-200/50 px-2 text-[10px] font-semibold text-rose-100"
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={s.startAuto}
              disabled={!s.funded || s.status === "funding"}
              className="h-5 rounded-sm bg-[var(--qp-gold)] px-2 text-[10px] font-black text-slate-950 disabled:opacity-45"
            >
              Start
            </button>
          )}
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col gap-2 p-2">
        {!s.funded && (
          <section className="rounded-md border border-white/10 bg-white/[0.04] p-2 text-[10px]">
            <div className="mb-1 text-slate-400">
              Fund bot A once — it stakes both seats and signs each open; bot B
              collects its winnings at close and never needs funding.
            </div>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={s.fund}
                disabled={s.status === "funding"}
                className="h-6 rounded-sm border border-[var(--qp-green)]/40 px-2 text-[10px] text-[var(--qp-green)] disabled:opacity-45"
              >
                {s.status === "funding" ? "Funding…" : "Faucet"}
              </button>
              {s.canFundFromWallet && (
                <button
                  type="button"
                  onClick={s.fundFromWallet}
                  disabled={s.status === "funding"}
                  className="h-6 rounded-sm border border-amber-200/40 px-2 text-[10px] text-amber-100 disabled:opacity-45"
                >
                  Fund bot A 0.1 SUI
                </button>
              )}
            </div>
          </section>
        )}

        {s.state && (
          <QuantumPokerTable
            state={s.state}
            holesA={s.holesA}
            holesB={s.holesB}
            nameA={s.personas?.a ?? "Bot A"}
            nameB={s.personas?.b ?? "Bot B"}
          />
        )}

        <section className="grid grid-cols-2 gap-2 rounded-md border border-white/10 bg-white/[0.04] p-2">
          <div className="min-w-0">
            <div className="text-[9px] uppercase text-slate-500">Bot A</div>
            <div className="truncate text-[11px] font-semibold">
              {s.personas?.a ?? "—"}
            </div>
            <div className="text-[10px] tabular-nums text-[var(--qp-green)]">
              {sui(s.balances.a)} SUI · wins {s.score.a}
            </div>
          </div>
          <div className="min-w-0 text-right">
            <div className="text-[9px] uppercase text-slate-500">Bot B</div>
            <div className="truncate text-[11px] font-semibold">
              {s.personas?.b ?? "—"}
            </div>
            <div className="text-[10px] tabular-nums text-[var(--qp-green)]">
              {sui(s.balances.b)} SUI · wins {s.score.b}
            </div>
          </div>
        </section>

        <section className="grid grid-cols-3 gap-1.5 rounded-md border border-white/10 bg-black/20 p-2 text-center">
          <div>
            <div className="text-[9px] uppercase text-slate-500">Tunnels</div>
            <div className="text-[12px] font-semibold tabular-nums">{s.tunnels}</div>
          </div>
          <div>
            <div className="text-[9px] uppercase text-slate-500">Actions</div>
            <div className="text-[12px] font-semibold tabular-nums">{s.actions}</div>
          </div>
          <div>
            <div className="text-[9px] uppercase text-slate-500">Status</div>
            <div className="truncate text-[12px] font-semibold">{s.status}</div>
          </div>
        </section>

        {s.error && (
          <div className="rounded-sm border border-rose-300/30 bg-rose-400/10 px-2 py-1 text-[10px] text-rose-100">
            {s.error}
          </div>
        )}
      </main>
    </div>
  );
}
