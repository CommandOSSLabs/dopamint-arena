// frontend/src/games/ticTacToe/packages/client/src/scenes/PvpScene.tsx
import { useState } from "react";
import { usePvpTicTacToe, type Variant } from "@/hooks/usePvpTicTacToe";
import { Board } from "@/components/Board";
import { CaroBoard } from "@/components/CaroBoard";

const SUISCAN_TX = "https://suiscan.xyz/testnet/tx/";
const fmtSui = (mist: bigint) => (Number(mist) / 1e9).toFixed(4);
const CARO_SIZES = [9, 15, 19];

function Digest({ label, digest }: { label: string; digest?: string }) {
  if (!digest) return null;
  return (
    <a href={`${SUISCAN_TX}${digest}`} target="_blank" rel="noreferrer" className="text-xs font-mono text-tertiary underline underline-offset-2">
      {label} {digest.slice(0, 6)}…
    </a>
  );
}

function statusText(g: ReturnType<typeof usePvpTicTacToe>): string {
  if (g.phase === "opening") return "Opening tunnel on-chain…";
  if (g.phase === "funding") return "Funding your seat…";
  if (g.phase === "settling") return "Settling on-chain…";
  if (g.phase === "done") return "Settled — game over";
  if (g.innerOver) {
    if (g.terminal) return "Session over — settling…";
    return g.role === "A" ? "You won/lost/drew — start the next game" : "Waiting for X to start the next game…";
  }
  if (g.isMyTurn) return `Your turn (${g.myMark === 1 ? "✕" : "◯"})`;
  return "Opponent's turn…";
}

export function PvpScene({ onBack }: { onBack: () => void }) {
  const [variant, setVariant] = useState<Variant>("ttt");
  const [boardSize, setBoardSize] = useState(15);
  const g = usePvpTicTacToe(variant, boardSize);

  const playing = g.phase === "playing" || g.phase === "settling" || g.phase === "done";
  // The connected zkLogin wallet pays gas + the (tiny) deposit; need a little testnet SUI.
  const funded = g.balance > 10_000_000n;
  const locked = g.phase !== "idle" && g.phase !== "error";

  return (
    <div className="w-full h-full flex flex-col gap-4 p-6 text-on-surface">
      <div className="flex items-center justify-between border-b-2 border-primary/20 pb-4">
        <button onClick={() => { g.leave(); onBack(); }} className="text-base font-bold text-secondary hover:text-primary transition-colors flex items-center gap-1">
          <span className="material-symbols-outlined text-lg">arrow_back</span> Back
        </button>
        <span className="text-lg font-headline-sm uppercase tracking-widest text-primary font-bold">PvP Matchmaking</span>
        <span className="text-sm font-mono text-on-surface/60 bg-surface px-2 py-1 rounded border border-primary/10 shadow-sm">{g.address.slice(0, 8)}…</span>
      </div>

      {!playing ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-6">
          <div className="text-sm font-mono text-on-surface/80 bg-surface px-4 py-2 rounded-lg shadow-sm border border-primary/20">
            Wallet: <span className="font-bold">{g.address.slice(0, 8)}…</span> &nbsp;·&nbsp; Balance: <span className="font-bold text-primary">{fmtSui(g.balance)} SUI</span>
          </div>
          
          <div className="flex flex-col items-center gap-4 bg-surface-container-low p-6 rounded-xl border-2 border-dashed border-primary/30 w-full max-w-sm">
            <span className="text-base font-bold uppercase tracking-widest text-primary">Game Variant</span>
            <div className="flex gap-3 w-full">
              {(["ttt", "caro"] as const).map((v) => (
                <button key={v} disabled={locked} onClick={() => setVariant(v)}
                  className={`flex-1 py-3 rounded-lg text-base font-bold shadow-sm disabled:opacity-40 transition-all ${variant === v ? "bg-tertiary text-on-tertiary scale-[1.02]" : "bg-surface border-[2px] border-primary/30 hover:border-primary/60"}`}>
                  {v === "ttt" ? "3×3 Classic" : "Caro"}
                </button>
              ))}
            </div>
            {variant === "caro" && (
              <div className="flex gap-2 mt-2">
                {CARO_SIZES.map((sz) => (
                  <button key={sz} disabled={locked} onClick={() => setBoardSize(sz)}
                    className={`px-4 py-2 rounded-lg text-sm font-bold shadow-sm disabled:opacity-40 transition-all ${boardSize === sz ? "bg-secondary text-on-secondary scale-[1.02]" : "bg-surface border-[2px] border-primary/30 hover:border-primary/60"}`}>
                    {sz}×{sz}
                  </button>
                ))}
              </div>
            )}
          </div>
          
          {!funded && <div className="text-base text-secondary font-bold text-center max-w-sm bg-secondary/10 p-3 rounded-lg">Your connected wallet needs a little testnet SUI to play (gas + deposit).</div>}
          
          <button onClick={g.queue} disabled={!funded || locked}
            className="w-full max-w-xs mt-2 px-6 py-4 rounded-sm border-[3px] border-primary bg-surface text-primary font-headline-lg-mobile text-xl uppercase tracking-widest disabled:opacity-40 shadow-[4px_4px_0px_#001e40] hover:-translate-y-1 hover:translate-x-1 hover:shadow-[6px_6px_0px_#001e40] active:translate-y-0 active:translate-x-0 active:shadow-[2px_2px_0px_#001e40] transition-all flex items-center justify-center gap-2">
            <span className="material-symbols-outlined text-2xl">{g.phase === "queuing" ? "search" : g.phase === "connecting" ? "sync" : "sports_esports"}</span>
            {g.phase === "connecting" ? "Connecting…"
              : g.phase === "queuing" ? "Finding Opponent…"
              : g.phase === "opening" ? "Opening tunnel…"
              : g.phase === "funding" ? "Funding seat…"
              : "Find Match"}
          </button>
          
          {(g.phase === "queuing" || g.phase === "connecting") && <button onClick={g.leave} className="text-base text-outline font-bold underline mt-2 hover:text-secondary transition-colors">Cancel Search</button>}
          {g.error && <div className="text-base font-bold text-red-500 text-center max-w-sm bg-red-50 p-3 rounded-lg border border-red-200">{g.error}</div>}
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center gap-4 mt-2">
          <div className="flex flex-col items-center gap-1">
            <span className="text-lg font-bold text-primary">You are: <span className="font-black text-2xl">{g.myMark === 1 ? "✕ (X)" : "◯ (O)"}</span></span>
            <div className="flex items-center gap-4 text-sm font-mono text-on-surface/70 bg-surface px-4 py-1.5 rounded-lg border border-primary/20 shadow-sm mt-1">
              <span>Game {g.currentGame}</span>
              <span className="border-l-2 border-primary/20 pl-4">X: {g.score.x} &nbsp; O: {g.score.o} &nbsp; D: {g.score.draws}</span>
            </div>
          </div>
          
          <div className="px-6 py-2 rounded-sm bg-tertiary/10 border-2 border-tertiary text-tertiary text-base font-bold uppercase tracking-wider">{statusText(g)}</div>

          {g.variant === "caro"
            ? <CaroBoard board={g.board} size={g.size} lastMove={g.lastMove} disabled={!g.isMyTurn || g.auto} onPlay={g.play} />
            : <Board board={g.board} disabled={!g.isMyTurn || g.auto} onPlay={g.play} />}

          <div className="flex flex-wrap items-center justify-center gap-3 mt-4">
            {g.phase === "playing" && g.innerOver && !g.terminal && g.role === "A" && (
              <button onClick={g.next} disabled={g.auto} className="px-6 py-3 rounded-sm border-[3px] border-primary bg-primary text-surface font-bold disabled:opacity-40 uppercase tracking-wider hover:-translate-y-1 hover:shadow-[4px_4px_0px_#001e40] transition-all">Next Game →</button>
            )}
            {g.innerOver && g.phase === "playing" && <button onClick={g.stop} className="px-6 py-3 rounded-sm border-[3px] border-secondary bg-surface text-secondary font-bold uppercase tracking-wider hover:bg-secondary hover:text-on-secondary transition-all shadow-[3px_3px_0px_#bc0000]">Stop &amp; Settle</button>}
            {g.phase === "done" && <button onClick={() => { g.leave(); g.queue(); }} className="px-6 py-3 rounded-sm border-[3px] border-primary bg-surface text-primary font-bold uppercase tracking-wider hover:bg-primary/10 transition-all shadow-[3px_3px_0px_#001e40]">Rematch</button>}
            <label className="flex items-center gap-2 text-base font-bold text-outline cursor-pointer bg-surface px-4 py-3 rounded-sm border-[2px] border-outline hover:border-primary hover:text-primary transition-colors">
              <input type="checkbox" className="w-5 h-5 accent-primary cursor-pointer" checked={g.auto} onChange={(e) => g.setAuto(e.target.checked)} /> Auto-Play
            </label>
          </div>

          {g.games.length > 0 && (
            <div className="w-full max-w-sm max-h-32 overflow-y-auto flex flex-col gap-1 text-sm font-mono mt-4 bg-surface-container-lowest p-3 rounded-lg border border-primary/10 shadow-inner">
              {[...g.games].reverse().map((r) => (
                <div key={r.game} className="flex justify-between text-on-surface/80 px-2 py-1 hover:bg-primary/5 rounded">
                  <span className="font-bold">Game {r.game}</span>
                  <span className={`font-bold ${r.winner === 1 ? "text-primary" : r.winner === 2 ? "text-secondary" : "text-outline"}`}>
                    {r.winner === 1 ? "X WON" : r.winner === 2 ? "O WON" : "DRAW"}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center gap-4 mt-2">
            <Digest label="OPEN:" digest={g.digests.create} />
            <Digest label="DEPOSIT:" digest={g.digests.deposit} />
            <Digest label="CLOSE:" digest={g.digests.close} />
          </div>
          {g.error && <div className="text-base font-bold text-red-500 text-center bg-red-50 p-3 rounded-lg border border-red-200 w-full max-w-sm">{g.error}</div>}
        </div>
      )}
    </div>
  );
}
