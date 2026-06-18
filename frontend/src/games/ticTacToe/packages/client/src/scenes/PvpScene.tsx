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
    <a href={`${SUISCAN_TX}${digest}`} target="_blank" rel="noreferrer" className="text-[11px] font-mono text-tertiary underline underline-offset-2">
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
    <div className="w-full h-full flex flex-col gap-3 p-4 text-on-surface">
      <div className="flex items-center justify-between">
        <button onClick={() => { g.leave(); onBack(); }} className="text-sm text-secondary underline">← back</button>
        <span className="text-sm font-bold uppercase tracking-widest">Tic-Tac-Toe · PvP</span>
        <span className="text-[11px] font-mono text-on-surface/50">{g.address.slice(0, 8)}…</span>
      </div>

      {!playing ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          <div className="text-[11px] font-mono text-on-surface/60">Wallet {g.address.slice(0, 8)}… · {fmtSui(g.balance)} SUI</div>
          <div className="flex flex-col items-center gap-2">
            <span className="text-[11px] uppercase tracking-widest text-on-surface/60">Variant</span>
            <div className="flex gap-2">
              {(["ttt", "caro"] as const).map((v) => (
                <button key={v} disabled={locked} onClick={() => setVariant(v)}
                  className={`px-4 py-2 rounded-lg text-sm font-bold disabled:opacity-40 ${variant === v ? "bg-tertiary text-on-tertiary" : "bg-surface border border-primary/30"}`}>
                  {v === "ttt" ? "3×3" : "Caro"}
                </button>
              ))}
            </div>
            {variant === "caro" && (
              <div className="flex gap-2 mt-1">
                {CARO_SIZES.map((sz) => (
                  <button key={sz} disabled={locked} onClick={() => setBoardSize(sz)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold disabled:opacity-40 ${boardSize === sz ? "bg-secondary text-on-secondary" : "bg-surface border border-primary/30"}`}>
                    {sz}×{sz}
                  </button>
                ))}
              </div>
            )}
          </div>
          {!funded && <div className="text-xs text-amber-600 text-center max-w-xs">Your connected wallet needs a little testnet SUI to play (gas + deposit).</div>}
          <button onClick={g.queue} disabled={!funded || g.phase === "queuing" || g.phase === "connecting"}
            className="px-6 py-3 rounded-xl bg-tertiary text-on-tertiary font-black uppercase tracking-widest disabled:opacity-40">
            {g.phase === "queuing" ? "Finding an opponent…" : g.phase === "connecting" ? "Connecting…" : "Find match"}
          </button>
          {g.phase === "queuing" && <button onClick={g.leave} className="text-xs text-on-surface/60 underline">cancel</button>}
          {g.error && <div className="text-sm text-red-500 text-center max-w-xs">{g.error}</div>}
        </div>
      ) : (
        <div className="flex-1 flex flex-col items-center gap-3">
          <div className="flex items-center gap-4 text-sm">
            <span>You are <b>{g.myMark === 1 ? "✕ (X)" : "◯ (O)"}</b></span>
            <span className="text-on-surface/50">Game {g.currentGame}</span>
            <span className="font-mono">X {g.score.x} · O {g.score.o} · D {g.score.draws}</span>
          </div>
          <div className="px-4 py-1.5 rounded-full bg-surface border border-primary/20 text-sm font-bold">{statusText(g)}</div>

          {g.variant === "caro"
            ? <CaroBoard board={g.board} size={g.size} lastMove={g.lastMove} disabled={!g.isMyTurn || g.auto} onPlay={g.play} />
            : <Board board={g.board} disabled={!g.isMyTurn || g.auto} onPlay={g.play} />}

          <div className="flex flex-wrap items-center justify-center gap-2">
            {g.innerOver && !g.terminal && g.role === "A" && (
              <button onClick={g.next} disabled={g.auto} className="px-4 py-2 rounded-lg bg-tertiary text-on-tertiary font-bold disabled:opacity-40">Next game</button>
            )}
            {g.innerOver && g.phase === "playing" && <button onClick={g.stop} className="px-4 py-2 rounded-lg bg-red-700 text-white font-bold">Stop &amp; settle</button>}
            {g.phase === "done" && <button onClick={() => { g.leave(); g.queue(); }} className="px-4 py-2 rounded-lg bg-tertiary text-on-tertiary font-bold">Rematch</button>}
            <label className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={g.auto} onChange={(e) => g.setAuto(e.target.checked)} /> Auto
            </label>
          </div>

          {g.games.length > 0 && (
            <div className="w-full max-w-xs max-h-28 overflow-y-auto flex flex-col gap-0.5 text-[11px] font-mono">
              {[...g.games].reverse().map((r) => (
                <div key={r.game} className="flex justify-between text-on-surface/70">
                  <span>Game {r.game}</span>
                  <span className={r.winner === 1 ? "text-primary" : r.winner === 2 ? "text-secondary" : "text-on-surface/50"}>
                    {r.winner === 1 ? "X won" : r.winner === 2 ? "O won" : "Draw"}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center gap-3">
            <Digest label="open" digest={g.digests.create} />
            <Digest label="deposit" digest={g.digests.deposit} />
            <Digest label="close" digest={g.digests.close} />
          </div>
          {g.error && <div className="text-sm text-red-500 text-center">{g.error}</div>}
        </div>
      )}
    </div>
  );
}
