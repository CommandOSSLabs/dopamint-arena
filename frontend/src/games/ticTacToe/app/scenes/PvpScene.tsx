// frontend/src/games/ticTacToe/packages/client/src/scenes/PvpScene.tsx
import { useState } from "react";
import {
  usePvpTicTacToe,
  type Variant,
} from "@/games/ticTacToe/app/hooks/usePvpTicTacToe";
import { Board } from "@/games/ticTacToe/app/components/Board";
import { CaroBoard } from "@/games/ticTacToe/app/components/CaroBoard";

const SUISCAN_TX = "https://suiscan.xyz/testnet/tx/";
const fmtSui = (mist: bigint) => (Number(mist) / 1e9).toFixed(4);
const CARO_SIZES = [9, 15, 19];

function Digest({ label, digest }: { label: string; digest?: string }) {
  if (!digest) return null;
  return (
    <a
      href={`${SUISCAN_TX}${digest}`}
      target="_blank"
      rel="noreferrer"
      className="text-xs font-mono text-tertiary underline underline-offset-2"
    >
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
    return g.role === "A"
      ? "You won/lost/drew — start the next game"
      : "Waiting for X to start the next game…";
  }
  if (g.isMyTurn) return `Your turn (${g.myMark === 1 ? "✕" : "◯"})`;
  return "Opponent's turn…";
}

export function PvpScene({
  onBack,
  isPortrait = false,
}: {
  onBack: () => void;
  isPortrait?: boolean;
}) {
  const [variant, setVariant] = useState<Variant>("ttt");
  const [boardSize, setBoardSize] = useState(15);
  const g = usePvpTicTacToe(variant, boardSize);

  const playing =
    g.phase === "playing" || g.phase === "settling" || g.phase === "done";
  // The connected zkLogin wallet pays gas + the (tiny) deposit; need a little testnet SUI.
  const funded = g.balance > 10_000_000n;
  const locked = g.phase !== "idle" && g.phase !== "error";

  return (
    <div
      className={`h-full flex flex-col text-on-surface relative ${isPortrait ? "w-full gap-3 p-2" : "w-[95%] max-w-5xl mx-auto gap-4 pt-0 pb-0 px-6"}`}
    >
      {(!isPortrait || !playing) && (
        <div className="flex items-center justify-between border-b-[6px] border-primary/20 pb-4 mt-2 shrink-0">
          <button
            onClick={() => {
              g.leave();
              onBack();
            }}
            className="text-2xl font-bold text-secondary hover:text-primary transition-colors flex items-center gap-2"
          >
            <span className="material-symbols-outlined text-3xl">
              arrow_back
            </span>{" "}
            Back
          </button>
          <span className="text-3xl md:text-4xl font-headline-xl uppercase tracking-widest text-primary font-bold">
            PvP Matchmaking
          </span>
          <span className="text-xl font-mono text-on-surface/60 bg-surface px-4 py-2 rounded-lg border-2 border-primary/10 shadow-sm">
            {g.address.slice(0, 8)}…
          </span>
        </div>
      )}

      {!playing ? (
        <div
          className={`flex-1 flex flex-col items-center pb-4 pt-4 ${isPortrait ? "gap-3" : "gap-6"}`}
        >
          <div
            className={`font-mono text-on-surface/80 bg-surface rounded-2xl shadow-sm border-primary/20 ${
              isPortrait
                ? "text-sm px-4 py-3 border-2"
                : "text-2xl md:text-3xl px-8 py-6 border-[4px]"
            }`}
          >
            Wallet: <span className="font-bold">{g.address.slice(0, 8)}…</span>{" "}
            &nbsp;·&nbsp; Balance:{" "}
            <span className="font-bold text-primary">
              {fmtSui(g.balance)} SUI
            </span>
          </div>

          <div
            className={`flex flex-col items-center bg-surface-container-low border-primary/30 w-[90%] max-w-4xl mt-2 ${
              isPortrait
                ? "gap-3 p-4 border-2 border-dashed rounded-xl"
                : "gap-8 p-10 md:p-14 border-4 border-dashed rounded-3xl"
            }`}
          >
            <span
              className={`font-bold uppercase tracking-widest text-primary ${isPortrait ? "text-sm" : "text-2xl md:text-3xl"}`}
            >
              Game Variant
            </span>
            <div className={`flex w-full ${isPortrait ? "gap-2" : "gap-4"}`}>
              {(["ttt", "caro"] as const).map((v) => (
                <button
                  key={v}
                  disabled={locked}
                  onClick={() => setVariant(v)}
                  className={`flex-1 font-bold shadow-sm disabled:opacity-40 transition-all ${
                    isPortrait
                      ? `py-3 rounded-lg text-base border-2 ${variant === v ? "bg-tertiary text-on-tertiary shadow-[2px_2px_0px_#bc0000]" : "bg-surface border-primary/30"}`
                      : `py-8 rounded-2xl text-3xl ${variant === v ? "bg-tertiary text-on-tertiary shadow-[6px_6px_0px_#bc0000]" : "bg-surface border-[4px] border-primary/30 hover:border-primary/60"}`
                  }`}
                >
                  {v === "ttt" ? "3×3 Classic" : "Caro"}
                </button>
              ))}
            </div>
            {variant === "caro" && (
              <div className={`flex mt-2 ${isPortrait ? "gap-3" : "gap-6"}`}>
                {CARO_SIZES.map((sz) => (
                  <button
                    key={sz}
                    disabled={locked}
                    onClick={() => setBoardSize(sz)}
                    className={`font-bold shadow-sm disabled:opacity-40 transition-all ${
                      isPortrait
                        ? `px-4 py-2 rounded-md text-xs border-2 ${boardSize === sz ? "bg-secondary text-on-secondary shadow-[2px_2px_0px_#bc0000]" : "bg-surface border-primary/30"}`
                        : `px-10 py-5 rounded-2xl text-2xl ${boardSize === sz ? "bg-secondary text-on-secondary shadow-[4px_4px_0px_#bc0000]" : "bg-surface border-[4px] border-primary/30 hover:border-primary/60"}`
                    }`}
                  >
                    {sz}×{sz}
                  </button>
                ))}
              </div>
            )}
          </div>

          {!funded && (
            <div
              className={`text-secondary font-bold text-center w-[90%] max-w-4xl bg-secondary/10 rounded-2xl mt-4 ${
                isPortrait ? "text-xs p-3 mt-1" : "text-2xl p-6"
              }`}
            >
              Your wallet needs SUI to play (gas + deposit).
            </div>
          )}

          <div className="mt-auto w-full flex flex-col items-center gap-4">
            <button
              onClick={g.queue}
              disabled={!funded || locked}
              className={`w-[80%] max-w-3xl rounded-xl border-primary bg-surface text-primary uppercase tracking-widest disabled:opacity-40 hover:-translate-y-1 hover:translate-x-1 transition-all flex items-center justify-center ${
                isPortrait
                  ? "px-6 py-4 border-4 text-xl gap-2 shadow-[4px_4px_0px_#001e40] hover:shadow-[5px_5px_0px_#001e40] active:translate-y-0 active:translate-x-0 active:shadow-[2px_2px_0px_#001e40]"
                  : "px-12 py-8 border-[6px] text-4xl gap-4 shadow-[8px_8px_0px_#001e40] hover:shadow-[10px_10px_0px_#001e40] active:translate-y-0 active:translate-x-0 active:shadow-[4px_4px_0px_#001e40]"
              }`}
            >
              <span
                className={`material-symbols-outlined ${isPortrait ? "text-2xl" : "text-5xl"}`}
              >
                {g.phase === "queuing"
                  ? "search"
                  : g.phase === "connecting"
                    ? "sync"
                    : "sports_esports"}
              </span>
              <span>
                {g.phase === "connecting"
                  ? "Connecting…"
                  : g.phase === "queuing"
                    ? "Finding Opponent…"
                    : g.phase === "opening"
                      ? "Opening tunnel…"
                      : g.phase === "funding"
                        ? "Funding seat…"
                        : "Find Match"}
              </span>
            </button>

            {(g.phase === "queuing" || g.phase === "connecting") && (
              <button
                onClick={g.leave}
                className={`text-outline font-bold underline hover:text-secondary transition-colors pb-2 ${
                  isPortrait ? "text-sm" : "text-2xl"
                }`}
              >
                Cancel Search
              </button>
            )}
            {g.error && (
              <div
                className={`font-bold text-red-500 text-center w-[90%] max-w-4xl bg-red-50 rounded-2xl pb-2 ${
                  isPortrait
                    ? "text-xs p-3 border-2 border-red-200"
                    : "text-2xl p-6 border-4 border-red-200"
                }`}
              >
                {g.error}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div
          className={`flex ${isPortrait ? "flex-col items-center gap-6" : "flex-row gap-8 items-start justify-between"} mt-2 w-full`}
        >
          {/* Left Column: Game Area */}
          <section
            className={`${isPortrait ? "w-full max-w-[480px]" : "flex-1 min-w-[560px]"} flex flex-col items-center`}
          >
            <div className="flex flex-col items-center gap-1 mb-6">
              <span className="text-lg font-bold text-primary">
                You are:{" "}
                <span className="font-black text-2xl">
                  {g.myMark === 1 ? "✕ (X)" : "◯ (O)"}
                </span>
              </span>
              <div className="flex items-center gap-4 text-sm font-mono text-on-surface/70 bg-surface px-4 py-1.5 rounded-lg border border-primary/20 shadow-sm mt-1">
                <span>Game {g.currentGame}</span>
                <span className="border-l-2 border-primary/20 pl-4">
                  X: {g.score.x} &nbsp; O: {g.score.o} &nbsp; D: {g.score.draws}
                </span>
              </div>
            </div>

            <div className="flex justify-center my-4">
              {g.variant === "caro" ? (
                <CaroBoard
                  board={g.board}
                  size={g.size}
                  lastMove={g.lastMove}
                  disabled={!g.isMyTurn || g.auto}
                  onPlay={g.play}
                />
              ) : (
                <Board
                  board={g.board}
                  disabled={!g.isMyTurn || g.auto}
                  onPlay={g.play}
                />
              )}
            </div>

            <div className="px-6 py-2 rounded-sm bg-tertiary/10 border-2 border-tertiary text-tertiary text-base font-bold uppercase tracking-wider mt-4">
              {statusText(g)}
            </div>

            {/* Portrait Controls */}
            {isPortrait && (
              <div className="mt-4 flex flex-col gap-3 w-full max-w-[480px]">
                <div className="flex gap-4 w-full">
                  {g.phase === "playing" &&
                    g.innerOver &&
                    !g.terminal &&
                    g.role === "A" && (
                      <button
                        onClick={g.next}
                        disabled={g.auto}
                        className="flex-1 px-4 py-3 rounded-sm border-[3px] border-primary bg-primary text-surface font-bold disabled:opacity-40 uppercase tracking-wider hover:-translate-y-1 hover:shadow-[4px_4px_0px_#001e40] transition-all"
                      >
                        Next Game →
                      </button>
                    )}
                  {g.innerOver && g.phase === "playing" && (
                    <button
                      onClick={g.stop}
                      className="flex-1 px-4 py-3 rounded-sm border-[3px] border-secondary bg-surface text-secondary font-bold uppercase tracking-wider hover:bg-secondary hover:text-on-secondary transition-all shadow-[3px_3px_0px_#bc0000]"
                    >
                      Stop &amp; Settle
                    </button>
                  )}
                  {g.phase === "done" && (
                    <button
                      onClick={() => {
                        g.leave();
                        g.queue();
                      }}
                      className="flex-1 px-4 py-3 rounded-sm border-[3px] border-primary bg-surface text-primary font-bold uppercase tracking-wider hover:bg-primary/10 transition-all shadow-[3px_3px_0px_#001e40]"
                    >
                      Rematch
                    </button>
                  )}
                </div>

                <div className="flex gap-4 items-center justify-between w-full">
                  <button
                    onClick={() => {
                      g.leave();
                      onBack();
                    }}
                    className="flex-1 border-2 border-primary text-primary font-bold text-sm px-4 py-2.5 rounded-sm hover:bg-primary/5 transition-all shadow-[2px_2px_0px_#001e40]"
                  >
                    ← Leave
                  </button>

                  <label className="flex-1 flex items-center justify-center gap-2 text-sm font-bold text-outline cursor-pointer bg-surface px-4 py-2.5 rounded-sm border-[2px] border-outline hover:border-primary hover:text-primary transition-colors">
                    <input
                      type="checkbox"
                      className="w-4 h-4 accent-primary cursor-pointer"
                      checked={g.auto}
                      onChange={(e) => g.setAuto(e.target.checked)}
                    />{" "}
                    Auto-Play
                  </label>
                </div>
              </div>
            )}
          </section>

          {/* Right Column: Game Log / Info */}
          {!isPortrait && (
            <aside className="w-[340px] shrink-0 flex flex-col gap-4">
              {/* Controls */}
              <div className="bg-surface-container-low border-[2px] border-primary p-4 relative rounded-sm shadow-[4px_4px_0px_#00336610] w-full flex flex-col items-center">
                <h2 className="font-headline-lg text-lg text-primary mb-4 self-start flex items-center gap-2">
                  <span className="material-symbols-outlined">settings</span>
                  Controls
                </h2>

                <div className="flex flex-col items-stretch w-full gap-3">
                  {g.phase === "playing" &&
                    g.innerOver &&
                    !g.terminal &&
                    g.role === "A" && (
                      <button
                        onClick={g.next}
                        disabled={g.auto}
                        className="w-full px-4 py-3 rounded-sm border-[3px] border-primary bg-primary text-surface font-bold disabled:opacity-40 uppercase tracking-wider hover:-translate-y-1 hover:shadow-[4px_4px_0px_#001e40] transition-all"
                      >
                        Next Game →
                      </button>
                    )}
                  {g.innerOver && g.phase === "playing" && (
                    <button
                      onClick={g.stop}
                      className="w-full px-4 py-3 rounded-sm border-[3px] border-secondary bg-surface text-secondary font-bold uppercase tracking-wider hover:bg-secondary hover:text-on-secondary transition-all shadow-[3px_3px_0px_#bc0000]"
                    >
                      Stop &amp; Settle
                    </button>
                  )}
                  {g.phase === "done" && (
                    <button
                      onClick={() => {
                        g.leave();
                        g.queue();
                      }}
                      className="w-full px-4 py-3 rounded-sm border-[3px] border-primary bg-surface text-primary font-bold uppercase tracking-wider hover:bg-primary/10 transition-all shadow-[3px_3px_0px_#001e40]"
                    >
                      Rematch
                    </button>
                  )}
                  <label className="flex items-center justify-center gap-2 text-base font-bold text-outline cursor-pointer bg-surface px-4 py-3 rounded-sm border-[2px] border-outline hover:border-primary hover:text-primary transition-colors">
                    <input
                      type="checkbox"
                      className="w-5 h-5 accent-primary cursor-pointer"
                      checked={g.auto}
                      onChange={(e) => g.setAuto(e.target.checked)}
                    />{" "}
                    Auto-Play
                  </label>
                </div>
              </div>

              {/* Game Log */}
              <div className="bg-surface-container-low border-[2px] border-primary p-6 relative rounded-sm shadow-[4px_4px_0px_#00336610] w-full mt-2">
                <div className="tape-top"></div>
                <h2 className="font-headline-lg text-xl text-primary mb-4 flex items-center gap-2">
                  <span className="material-symbols-outlined">edit_note</span>
                  Game Log
                </h2>

                {g.games.length > 0 && (
                  <div className="w-full max-h-40 overflow-y-auto flex flex-col gap-1 text-sm font-mono mb-4 bg-surface-container-lowest p-3 rounded-lg border border-primary/10 shadow-inner">
                    {[...g.games].reverse().map((r) => (
                      <div
                        key={r.game}
                        className="flex justify-between text-on-surface/80 px-2 py-1 hover:bg-primary/5 rounded"
                      >
                        <span className="font-bold">Game {r.game}</span>
                        <span
                          className={`font-bold ${r.winner === 1 ? "text-primary" : r.winner === 2 ? "text-secondary" : "text-outline"}`}
                        >
                          {r.winner === 1
                            ? "X WON"
                            : r.winner === 2
                              ? "O WON"
                              : "DRAW"}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex flex-col gap-2 mt-4 text-xs font-mono border-t border-primary/20 pt-4">
                  <Digest label="OPEN:" digest={g.digests.create} />
                  <Digest label="DEPOSIT:" digest={g.digests.deposit} />
                  <Digest label="CLOSE:" digest={g.digests.close} />
                </div>

                {g.error && (
                  <div className="mt-4 text-xs font-bold text-red-500 bg-red-50 p-3 rounded-lg border border-red-200 w-full break-words">
                    {g.error}
                  </div>
                )}
              </div>
            </aside>
          )}
        </div>
      )}
    </div>
  );
}
