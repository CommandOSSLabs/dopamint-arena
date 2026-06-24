import { useState } from "react";
import {
  usePvpTicTacToe,
  type Variant,
} from "@/games/ticTacToe/app/hooks/usePvpTicTacToe";
import { Board } from "@/games/ticTacToe/app/components/Board";
import { CaroBoard } from "@/games/ticTacToe/app/components/CaroBoard";
import { isDopamintConfigured } from "@/onchain/dopamint";

const SUISCAN_TX = "https://suiscan.xyz/testnet/tx/";
const fmtSui = (mist: bigint) => (Number(mist) / 1e9).toFixed(4);
const CARO_SIZES = [9, 15, 19];

// The 3×3 Cell renders value 1 ("O") / 2 ("X"), but the protocol marks seat A (X) as 1 and
// seat B (O) as 2 — the opposite. Swap 1↔2 so your X shows as X (CaroBoard already maps 1→✕).
function uiBoard(board: number[]): number[] {
  return board.map((v) => (v === 1 ? 2 : v === 2 ? 1 : 0));
}

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
  // SUI mode: the connected wallet pays gas + the (tiny) deposit, so it needs a little testnet
  // SUI. DOPAMINT mode (ADR-0010): gas is sponsored and the stake is faucet-minted, so play is
  // free — never gate on the SUI balance.
  const funded = isDopamintConfigured || g.balance > 10_000_000n;
  const locked = g.phase !== "idle" && g.phase !== "error";

  return (
    <div className="qp-panel qp-stroke w-[98%] max-w-[120rem] h-[98%] max-h-none p-6 md:p-12 flex flex-col mx-auto text-left relative">
      {(!isPortrait || !playing) && (
        <div
          className={`flex justify-between border-[var(--qp-ink-soft)] shrink-0 ${
            isPortrait
              ? "border-b-2 pb-2 items-center"
              : "border-b-4 pb-4 items-center"
          }`}
        >
          {isPortrait ? (
            <div className="flex flex-col items-start gap-1">
              <span className="qp-title !text-3xl uppercase tracking-widest">
                PvP Matchmaking
              </span>
              <button
                onClick={() => {
                  g.leave();
                  onBack();
                }}
                className="!text-sm md:!text-base font-bold text-[var(--qp-ink-soft)] hover:text-[var(--qp-ink)] transition-colors flex items-center gap-1 uppercase tracking-widest"
              >
                <span className="material-symbols-outlined !text-lg">
                  arrow_back
                </span>{" "}
                Return
              </button>
            </div>
          ) : (
            <button
              onClick={() => {
                g.leave();
                onBack();
              }}
              className="!text-2xl font-bold text-[var(--qp-ink-soft)] hover:text-[var(--qp-ink)] transition-colors flex items-center gap-1 uppercase tracking-widest"
            >
              <span className="material-symbols-outlined !text-3xl">
                arrow_back
              </span>{" "}
              Return
            </button>
          )}

          {!isPortrait && (
            <span className="qp-title !text-5xl md:!text-6xl uppercase tracking-widest">
              PvP Matchmaking
            </span>
          )}
        </div>
      )}

      {!playing ? (
        <div
          className={`flex-1 flex flex-col items-center pb-4 pt-4 ${isPortrait ? "gap-3" : "gap-6"}`}
        >
          <div
            className={`flex flex-col items-center qp-panel w-[90%] max-w-4xl mt-2 ${
              isPortrait ? "gap-3 p-4" : "gap-8 p-10 md:p-14"
            }`}
          >
            <span
              className={`text-[var(--qp-amber)] tracking-[0.08em] uppercase font-bold ${isPortrait ? "text-lg" : "text-3xl"}`}
            >
              Game Variant
            </span>
            <div className={`flex w-full ${isPortrait ? "gap-2" : "gap-4"}`}>
              {(["ttt", "caro"] as const).map((v) => (
                <button
                  key={v}
                  disabled={locked}
                  onClick={() => setVariant(v)}
                  className={`qp-btn flex-1 transition-colors disabled:opacity-40 ${
                    isPortrait ? "!py-3 !text-base" : "!py-8 !text-4xl"
                  } ${variant === v ? "qp-btn--go" : ""}`}
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
                    className={`qp-btn transition-colors disabled:opacity-40 ${
                      isPortrait
                        ? "!px-4 !py-2 !text-base"
                        : "!px-10 !py-5 !text-4xl"
                    } ${boardSize === sz ? "qp-btn--go" : ""}`}
                  >
                    {sz}×{sz}
                  </button>
                ))}
              </div>
            )}
          </div>

          {!funded && !isDopamintConfigured && (
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
              className={`qp-btn qp-btn--go w-[80%] max-w-3xl uppercase tracking-widest disabled:opacity-40 flex items-center justify-center font-black ${
                isPortrait
                  ? "!px-6 !py-4 !text-xl gap-2"
                  : "!px-12 !py-8 !text-4xl gap-4"
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
          className={`flex ${isPortrait ? "flex-col items-center gap-6" : "flex-row gap-8 items-start justify-between"} mt-2 w-full flex-1 min-h-0`}
        >
          {/* Left Column: Game Area */}
          <section
            className={`${isPortrait ? "w-full max-w-[480px]" : "flex-1 min-w-[560px]"} flex flex-col items-center min-h-0`}
          >
            <div className="flex flex-col items-center gap-1 mb-6">
              <span className="text-lg font-bold text-primary">
                You are:{" "}
                <span className="font-black text-2xl">
                  {g.myMark === 1 ? "✕ (X)" : "◯ (O)"}
                </span>
              </span>
              <div className="flex items-center gap-4 text-sm font-mono text-[var(--qp-ink-soft)] px-4 py-1.5 rounded-md border border-[var(--qp-ink-soft)] mt-1">
                <span>Game {g.currentGame}</span>
                <span className="border-l-2 border-[var(--qp-ink-soft)] pl-4">
                  X: {g.score.x} &nbsp; O: {g.score.o} &nbsp; D: {g.score.draws}
                </span>
              </div>
            </div>

            <div className="flex justify-center flex-1 min-h-0 w-full mb-2">
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
                  board={uiBoard(g.board)}
                  disabled={!g.isMyTurn || g.auto}
                  onPlay={g.play}
                />
              )}
            </div>

            <div className="qp-title text-2xl mt-4 min-h-[28px]">
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
                        className="qp-btn qp-btn--go flex-1 !px-4 !py-3 !text-sm disabled:opacity-40 uppercase tracking-wider"
                      >
                        Next Game →
                      </button>
                    )}
                  {g.innerOver && g.phase === "playing" && (
                    <button
                      onClick={g.stop}
                      className="qp-btn flex-1 !px-4 !py-3 !text-sm uppercase tracking-wider"
                    >
                      Stop &amp; Settle
                    </button>
                  )}
                  {g.phase === "done" && (
                    <button
                      onClick={g.requeue}
                      className="qp-btn qp-btn--go flex-1 !px-4 !py-3 !text-sm uppercase tracking-wider"
                    >
                      Find New Match
                    </button>
                  )}
                </div>

                <div className="flex gap-4 items-center justify-between w-full">
                  <button
                    onClick={() => {
                      g.leave();
                      onBack();
                    }}
                    className="qp-btn flex-1 !px-4 !py-2.5 !text-sm"
                  >
                    ← Leave
                  </button>

                  <button
                    onClick={() => g.setAuto(!g.auto)}
                    className={`qp-btn flex-1 !px-4 !py-2.5 !text-sm flex items-center justify-center gap-2 ${g.auto ? "qp-btn--go" : ""}`}
                  >
                    <span
                      className={`grid h-4 w-4 place-items-center border-[2px] border-[var(--qp-ink)] text-xs rounded-sm ${g.auto ? "bg-[var(--qp-ink)] text-[var(--qp-paper)]" : "bg-[var(--qp-paper)]"}`}
                    >
                      {g.auto ? "✓" : ""}
                    </span>
                    Auto-Play
                  </button>
                </div>
              </div>
            )}
          </section>

          {/* Right Column: Game Log / Info */}
          {!isPortrait && (
            <aside className="w-[340px] shrink-0 flex flex-col gap-4">
              <div className="qp-panel qp-stroke p-4 w-full flex flex-col items-center">
                <h2 className="qp-title text-xl mb-4 self-start flex items-center gap-2">
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
                        className="qp-btn qp-btn--go w-full !px-4 !py-3 !text-sm disabled:opacity-40 uppercase tracking-wider"
                      >
                        Next Game →
                      </button>
                    )}
                  {g.innerOver && g.phase === "playing" && (
                    <button
                      onClick={g.stop}
                      className="qp-btn w-full !px-4 !py-3 !text-sm uppercase tracking-wider"
                    >
                      Stop &amp; Settle
                    </button>
                  )}
                  {g.phase === "done" && (
                    <button
                      onClick={g.requeue}
                      className="qp-btn qp-btn--go w-full !px-4 !py-3 !text-sm uppercase tracking-wider"
                    >
                      Find New Match
                    </button>
                  )}
                </div>

                <div className="flex gap-4 items-center justify-between w-full mt-3">
                  <button
                    onClick={() => {
                      g.leave();
                      onBack();
                    }}
                    className="qp-btn flex-1 !px-4 !py-2.5 !text-sm"
                  >
                    ← Leave
                  </button>
                  <button
                    onClick={() => g.setAuto(!g.auto)}
                    className={`qp-btn flex-1 !px-4 !py-2.5 !text-sm flex items-center justify-center gap-2 ${g.auto ? "qp-btn--go" : ""}`}
                  >
                    <span
                      className={`grid h-4 w-4 place-items-center border-[2px] border-[var(--qp-ink)] text-xs rounded-sm ${g.auto ? "bg-[var(--qp-ink)] text-[var(--qp-paper)]" : "bg-[var(--qp-paper)]"}`}
                    >
                      {g.auto ? "✓" : ""}
                    </span>
                    Auto-Play
                  </button>
                </div>
              </div>

              <h2 className="qp-title text-2xl mt-2 mb-1 flex items-center gap-2">
                <span className="material-symbols-outlined">edit_note</span>
                Game Log
              </h2>

              <div className="qp-panel qp-stroke p-6 w-full">
                <ul className="space-y-4 pt-2 font-mono font-bold text-xs">
                  {g.games.length > 0 && (
                    <div className="w-full max-h-40 overflow-y-auto flex flex-col gap-1 text-sm font-mono mb-4 bg-[var(--qp-paper)] p-3 rounded-lg border border-[var(--qp-ink-soft)]/20 shadow-inner">
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

                  <div className="flex flex-col gap-2 mt-4 text-xs font-mono border-t border-[var(--qp-ink-soft)]/40 pt-4">
                    <Digest label="OPEN:" digest={g.digests.create} />
                    <Digest label="DEPOSIT:" digest={g.digests.deposit} />
                    <Digest label="CLOSE:" digest={g.digests.close} />
                  </div>

                  {g.error && (
                    <div className="mt-4 text-xs font-bold text-red-500 bg-red-50 p-3 rounded-lg border border-red-200 w-full break-words">
                      {g.error}
                    </div>
                  )}
                </ul>

                {g.auto && (
                  <div className="mt-6 text-xs text-[var(--qp-amber)] italic font-bold text-center leading-tight">
                    * Auto-play enabled *
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
