import { Board } from "@/games/ticTacToe/app/components/Board";
import { CaroBoard } from "@/games/ticTacToe/app/components/CaroBoard";
import type {
  BotGameView,
  BotPhase,
  TunnelRecord,
} from "@/games/ticTacToe/app/hooks/useBotGame";
import type {
  PlayMode,
  GameType,
} from "@/games/ticTacToe/app/scenes/SetupScene";
import { isDopamintConfigured } from "@/onchain/dopamint";

// Protocol marks (1 = botX/X, 2 = botO/O) -> Cell UI vocabulary (CELL_SERVER=2 renders "X",
// CELL_PLAYER=1 renders "O"). Map X->2, O->1 so botX shows as X.
function uiBoard(board: number[]): number[] {
  return board.map((v) => (v === 1 ? 2 : v === 2 ? 1 : 0));
}

function fmtSui(mist: bigint): string {
  const whole = mist / 1_000_000_000n;
  const frac = (mist % 1_000_000_000n)
    .toString()
    .padStart(9, "0")
    .replace(/0+$/, "");
  return frac ? `${whole}.${frac.slice(0, 4)}` : `${whole}`;
}

function renderTallies(count: number): string {
  if (count === 0) return "—";
  const groups = Math.floor(count / 5);
  const remainder = count % 5;
  let res = "";
  for (let i = 0; i < groups; i++) {
    res += "|||| / ";
  }
  for (let i = 0; i < remainder; i++) {
    res += "|";
  }
  return res.trim();
}

function statusText(
  phase: BotPhase,
  turn: "A" | "B",
  winner: number,
  gameType: "ttt" | "caro",
  manual: boolean,
): string {
  const fiveOrLine = gameType === "caro" ? " (5 in a row)" : "";
  // In manual mode you are X; the bot is O.
  if (winner === 1)
    return `${manual ? "You win" : "Bot X wins"}!${fiveOrLine} ❌`;
  if (winner === 2)
    return `${manual ? "Bot wins" : "Bot O wins"}!${fiveOrLine} ⭕`;
  if (winner === 3) return "Draw match.";
  switch (phase) {
    case "opening":
      return "Opening tunnel on-chain…";
    case "playing":
      if (turn === "A") return manual ? "Your move ❌" : "Bot X is thinking…";
      return manual ? "Bot is thinking… ⭕" : "Bot O is thinking…";
    case "settling":
      return "Settling on-chain…";
    case "done":
      return "Game over.";
    case "error":
      return "Error encountered.";
    default:
      return "Starting…";
  }
}

// "Games per tunnel": how many TTT games play inside ONE tunnel before the single
// on-chain settle. Presets plus a clamped custom input (the hook clamps 1..100).
const GAME_PRESETS = [1, 5, 10, 25] as const;

function GamesPerTunnel({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (n: number) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-2 my-3 w-full max-w-md">
      <span className="qp-eyebrow text-xs opacity-80">Games per tunnel</span>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {GAME_PRESETS.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            disabled={disabled}
            className={`qp-btn transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              value === n ? "qp-btn--go" : ""
            } !px-3 !py-1 !text-sm`}
          >
            {n}
          </button>
        ))}
        <input
          type="number"
          min={1}
          max={100}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label="Custom games per tunnel"
          className="qp-input w-16 px-2 py-1 bg-[#fffdf6] border-2 border-[var(--qp-ink)] focus:border-[var(--qp-amber)] rounded-md font-mono text-center tabular-nums outline-none disabled:opacity-40 disabled:cursor-not-allowed text-sm"
        />
      </div>
    </div>
  );
}

export function GameScene({
  g,
  mode,
  gameType,
  onBack,
  onMenu,
  isPortrait = false,
}: {
  g: BotGameView & {
    boardSize?: number;
    lastMove?: number;
    tunnels?: TunnelRecord[];
  };
  mode: PlayMode;
  gameType: GameType;
  onBack: () => void;
  /** Leave the game for the main menu (login). */
  onMenu: () => void;
  isPortrait?: boolean;
}) {
  const busy =
    g.phase === "opening" || g.phase === "playing" || g.phase === "settling";

  // Auto toggle: ticked = bots auto-play (watch); unticked hands X's turn to you (the bot keeps
  // playing O). Replaces the old "Stop Playing" — unticking pauses auto so you can play yourself.
  const autoToggle = (
    <button
      onClick={() => g.setAuto(!g.auto)}
      aria-pressed={g.auto}
      data-testid="ttt-auto"
      className={`qp-btn flex-1 !px-4 !py-2.5 !text-base flex items-center justify-center gap-2 ${
        g.auto ? "qp-btn--go" : ""
      }`}
    >
      <span
        className={`grid h-4 w-4 place-items-center border-[2px] border-[var(--qp-ink)] text-xs rounded-sm ${g.auto ? "bg-[var(--qp-ink)] text-[var(--qp-paper)]" : "bg-[var(--qp-paper)]"}`}
      >
        {g.auto ? "✓" : ""}
      </span>
      Auto
    </button>
  );
  const menuBtn = (
    <button onClick={onMenu} className="qp-btn flex-1 !px-4 !py-2.5 !text-base">
      ← Main menu
    </button>
  );

  return (
    <div
      className={`w-full h-full overflow-hidden flex flex-col ${isPortrait ? "gap-1 p-1" : "gap-2 p-2 md:p-4"}`}
    >
      {/* Header */}
      {!isPortrait && (
        <header className="flex justify-between items-center border-b-2 border-[var(--qp-ink-soft)] pb-3">
          <h1 className="qp-title text-3xl truncate">
            {gameType === "caro" ? "Caro" : "Tic-Tac-Toe"}
          </h1>
          <button
            onClick={onBack}
            className="text-xs font-bold text-[var(--qp-ink-soft)] hover:text-[var(--qp-ink)] uppercase tracking-widest flex items-center gap-1 transition-colors"
          >
            <span className="material-symbols-outlined text-sm">
              arrow_back
            </span>
            setup
          </button>
        </header>
      )}

      {/* Main Body Grid - switch from side-by-side to stacked dynamically in portrait */}
      <div
        className={`flex flex-1 min-h-0 ${isPortrait ? "flex-col items-center gap-2" : "flex-row gap-4 items-stretch justify-between"} mt-1 w-full`}
      >
        {/* Left Column: Game Area */}
        <section
          className={`${isPortrait ? "w-full max-w-[480px]" : "flex-1"} flex flex-col items-center min-h-0`}
        >
          {/* Scoreboard */}
          <div className="w-full max-w-[800px] flex justify-between items-end mb-6 px-4 border-b-2 border-[var(--qp-ink-soft)] pb-4">
            <div className="text-center">
              <div className="qp-eyebrow text-lg">
                {g.auto ? "Bot X (X)" : "You (X)"}
              </div>
              <div className="font-bold text-3xl mt-1 min-h-[30px] flex items-center justify-center">
                {g.score.x}
              </div>
              {/* DOPAMINT mode: play is free + auto-funded — hide the SUI gas balance. */}
              {!isDopamintConfigured && (
                <div className="font-mono text-[10px] opacity-60 mt-1">
                  {fmtSui(g.balances.x)} SUI
                </div>
              )}
            </div>
            <div className="text-center">
              <button
                onClick={g.resetScore}
                title="Reset scores"
                className="hover:bg-[var(--qp-ink-soft)]/20 p-1 rounded-full text-[var(--qp-ink-soft)] hover:text-[var(--qp-ink)] transition-colors mb-2"
              >
                <span className="material-symbols-outlined text-lg">
                  autorenew
                </span>
              </button>
              <div className="font-bold text-[var(--qp-ink-soft)] text-base">
                Draws: {g.score.draws}
              </div>
            </div>
            <div className="text-center">
              <div className="qp-eyebrow text-lg">
                {g.auto ? "Bot O (O)" : "Bot (O)"}
              </div>
              <div className="font-bold text-3xl mt-1 min-h-[30px] flex items-center justify-center">
                {g.score.o}
              </div>
              {!isDopamintConfigured && (
                <div className="font-mono text-[10px] opacity-60 mt-1">
                  {fmtSui(g.balances.o)} SUI
                </div>
              )}
            </div>
          </div>

          {/* Board: 3×3 grid for TTT, N×N grid for caro */}
          <div className="flex justify-center flex-1 min-h-0 w-full mb-2">
            {gameType === "caro" ? (
              <CaroBoard
                board={g.board}
                size={g.boardSize ?? 15}
                lastMove={g.lastMove ?? -1}
                onPlay={g.playCell}
                disabled={!g.myTurn}
              />
            ) : (
              <Board
                board={uiBoard(g.board)}
                onPlay={g.playCell}
                disabled={!g.myTurn}
              />
            )}
          </div>

          {/* Status text */}
          <div className="text-center qp-title text-2xl my-4 min-h-[28px]">
            {statusText(g.phase, g.turn, g.winner, gameType, !g.auto)}
          </div>

          {/* Portrait Controls */}
          {isPortrait && (
            <div className="mt-4 flex flex-wrap gap-4 justify-center w-full max-w-[480px]">
              {mode === "auto" ? (
                <>
                  {autoToggle}
                  {menuBtn}
                </>
              ) : (
                <>
                  <button
                    onClick={onBack}
                    className="qp-btn flex-1 !px-2 !py-2.5 !text-sm"
                  >
                    ← Setup
                  </button>
                  <button
                    onClick={g.newGame}
                    disabled={busy}
                    className="qp-btn qp-btn--go flex-1 !px-2 !py-2.5 !text-sm disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    New Game
                  </button>
                </>
              )}
            </div>
          )}
        </section>

        {/* Right Column: Game Log / Info */}
        {!isPortrait && (
          <aside className="w-[280px] lg:w-[320px] xl:w-[360px] shrink-0 flex flex-col gap-4 overflow-y-auto pr-2 pb-2">
            {/* Setup and Actions block */}
            <div className="qp-panel qp-stroke p-4 w-full flex flex-col items-center">
              <h2 className="qp-title text-xl mb-2 self-start flex items-center gap-2">
                <span className="material-symbols-outlined">settings</span>
                Controls
              </h2>

              {/* Per-tunnel progress: game k / N */}
              <div className="text-center qp-eyebrow text-xs mb-2 min-h-[16px] opacity-80">
                {g.phase === "playing" || g.phase === "settling"
                  ? `Game ${Math.min(g.currentGame, g.maxGames)} / ${g.maxGames} in this tunnel`
                  : `${g.maxGames} game${g.maxGames === 1 ? "" : "s"} per tunnel, one settle`}
              </div>

              {/* Games-per-tunnel control (presets + custom), disabled while playing */}
              <GamesPerTunnel
                value={g.maxGames}
                onChange={g.setMaxGames}
                disabled={busy || g.auto}
              />

              {/* Actions */}
              <div className="mt-4 flex flex-wrap gap-4 justify-center w-full">
                {mode === "auto" ? (
                  <>
                    {autoToggle}
                    {menuBtn}
                  </>
                ) : (
                  <>
                    <button
                      onClick={onBack}
                      className="qp-btn flex-1 !px-2 !py-2.5 !text-sm"
                    >
                      ← Setup
                    </button>
                    <button
                      onClick={g.newGame}
                      disabled={busy}
                      className="qp-btn qp-btn--go flex-1 !px-2 !py-2.5 !text-sm disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      New Game
                    </button>
                  </>
                )}
              </div>
            </div>

            <h2 className="qp-title text-2xl mt-2 mb-1 flex items-center gap-2">
              <span className="material-symbols-outlined">edit_note</span>
              Game Log
            </h2>

            <div className="qp-panel qp-stroke p-6 w-full">
              <ul className="space-y-4 pt-2 text-xs font-bold font-mono">
                <li className="flex justify-between items-center border-b border-[var(--qp-ink-soft)] pb-2">
                  <span className="font-bold text-outline uppercase text-[10px]">
                    Step
                  </span>
                  <span className="font-bold text-outline uppercase text-[10px]">
                    Tx Digest
                  </span>
                </li>

                <li className="flex justify-between items-center py-1 border-b border-[var(--qp-ink-soft)]/40">
                  <span className="flex items-center gap-1.5">
                    <span className="text-secondary font-bold">1</span> Open
                    &amp; Fund
                  </span>
                  {g.digests.create ? (
                    <a
                      href={`https://suiscan.xyz/testnet/tx/${g.digests.create}`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-primary underline hover:text-secondary"
                    >
                      {g.digests.create.slice(0, 6)}…
                      {g.digests.create.slice(-4)}
                    </a>
                  ) : (
                    <span className="text-outline/40">—</span>
                  )}
                </li>

                <li className="flex justify-between items-center py-1 border-b border-[var(--qp-ink-soft)]/40">
                  <span className="flex items-center gap-1.5">
                    <span className="text-secondary font-bold">2</span>{" "}
                    Transcript Root
                  </span>
                  {g.digests.root ? (
                    <span
                      title={g.digests.root}
                      className="font-mono text-primary"
                    >
                      {g.digests.root.slice(0, 8)}…{g.digests.root.slice(-4)}
                    </span>
                  ) : (
                    <span className="text-outline/40">—</span>
                  )}
                </li>

                <li className="flex justify-between items-center py-1 border-b border-[var(--qp-ink-soft)]/40">
                  <span className="flex items-center gap-1.5">
                    <span className="text-secondary font-bold">3</span> State
                    Checkpoint
                  </span>
                  {g.digests.update ? (
                    <a
                      href={`https://suiscan.xyz/testnet/tx/${g.digests.update}`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-primary underline hover:text-secondary"
                    >
                      {g.digests.update.slice(0, 6)}…
                      {g.digests.update.slice(-4)}
                    </a>
                  ) : (
                    <span className="text-outline/40">—</span>
                  )}
                </li>

                <li className="flex justify-between items-center py-1 border-b border-[var(--qp-ink-soft)]/40">
                  <span className="flex items-center gap-1.5">
                    <span className="text-secondary font-bold">4</span> Settle &
                    Close
                  </span>
                  {g.digests.close ? (
                    <a
                      href={`https://suiscan.xyz/testnet/tx/${g.digests.close}`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-primary underline hover:text-secondary"
                    >
                      {g.digests.close.slice(0, 6)}…{g.digests.close.slice(-4)}
                    </a>
                  ) : (
                    <span className="text-outline/40">—</span>
                  )}
                </li>
              </ul>

              {g.auto && (
                <div className="mt-6 text-xs text-[var(--qp-amber)] italic font-bold text-center leading-tight">
                  * Auto-play enabled *
                </div>
              )}

              {g.error && (
                <div className="mt-4 text-xs text-secondary font-label-sm border border-secondary/20 bg-secondary/5 p-2 rounded-sm italic">
                  * Error: {g.error}
                </div>
              )}

              {/* Scribbled notes */}
              <div className="mt-8 text-[var(--qp-ink-soft)] font-body-lg text-lg text-center transform -rotate-3 select-none leading-tight border-t border-dashed border-[var(--qp-ink-soft)] pt-4">
                Watch out for the diagonal trick!
              </div>
            </div>

            {/* Settled-tunnel history (caro): one row per on-chain close, newest first. The
                scoreboard resets each settle; this is the running record of past tunnels. */}
            {g.tunnels && g.tunnels.length > 0 && (
              <div className="qp-panel qp-stroke p-4 w-full">
                <h3 className="qp-title text-base mb-2 flex items-center gap-2">
                  <span className="material-symbols-outlined text-base">
                    history
                  </span>
                  Settled Tunnels
                </h3>
                <ul className="space-y-2 font-mono text-xs max-h-[220px] overflow-auto">
                  {g.tunnels.map((t, i) => (
                    <li
                      key={`${t.tunnelId}-${i}`}
                      className="flex justify-between items-center border-b border-[var(--qp-ink-soft)] pb-1.5"
                    >
                      <span className="flex items-center gap-2 tabular-nums">
                        <span className="text-outline">{t.games}g</span>
                        <span className="font-bold text-[var(--qp-red)]">✕{t.x}</span>
                        <span className="font-bold text-[var(--qp-ink)]">◯{t.o}</span>
                        <span className="opacity-75">={t.draws}</span>
                      </span>
                      {t.closeDigest ? (
                        <a
                          href={`https://suiscan.xyz/testnet/tx/${t.closeDigest}`}
                          target="_blank"
                          rel="noreferrer"
                          title={
                            t.rootHex
                              ? `transcript root ${t.rootHex}`
                              : undefined
                          }
                          className="font-mono text-[var(--qp-ink-soft)] underline hover:text-[var(--qp-ink)]"
                        >
                          {t.closeDigest.slice(0, 6)}…{t.closeDigest.slice(-4)}
                        </a>
                      ) : (
                        <span className="text-outline/40">—</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
