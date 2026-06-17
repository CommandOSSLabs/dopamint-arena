import { Board } from "@/components/Board";
import type { BotGameView, BotPhase } from "@/hooks/useBotGame";
import type { PlayMode } from "@/scenes/SetupScene";

// Protocol marks (1 = botX/X, 2 = botO/O) -> Cell UI vocabulary (CELL_SERVER=2 renders "X",
// CELL_PLAYER=1 renders "O"). Map X->2, O->1 so botX shows as X.
function uiBoard(board: number[]): number[] {
  return board.map((v) => (v === 1 ? 2 : v === 2 ? 1 : 0));
}

function fmtSui(mist: bigint): string {
  const whole = mist / 1_000_000_000n;
  const frac = (mist % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
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

function statusText(phase: BotPhase, turn: "A" | "B", winner: number): string {
  if (winner === 1) return "Bot X wins! ❌";
  if (winner === 2) return "Bot O wins! ⭕";
  if (winner === 3) return "Draw match.";
  switch (phase) {
    case "opening":
      return "Opening tunnel on-chain…";
    case "playing":
      return turn === "A" ? "Bot X is thinking…" : "Bot O is thinking…";
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
      <span className="font-label-sm text-[10px] uppercase tracking-wide text-outline">
        Games per tunnel
      </span>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {GAME_PRESETS.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            disabled={disabled}
            className={`px-3 py-1 border-2 border-primary rounded-sm font-label-sm text-xs transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
              value === n
                ? "bg-primary text-on-primary shadow-[1px_1px_0px_#001e40]"
                : "bg-surface text-primary hover:bg-primary/5"
            }`}
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
          className="w-16 px-2 py-1 border-2 border-primary rounded-sm bg-surface text-primary font-label-sm text-xs tabular-nums text-center disabled:opacity-40 disabled:cursor-not-allowed"
        />
      </div>
    </div>
  );
}

export function GameScene({
  g,
  mode,
  onBack,
  isPortrait = false,
}: {
  g: BotGameView;
  mode: PlayMode;
  onBack: () => void;
  isPortrait?: boolean;
}) {
  const busy = g.phase === "opening" || g.phase === "playing" || g.phase === "settling";

  return (
    <div className="w-full flex flex-col gap-6 pt-8 pb-4">
      {/* Header */}
      <header className="flex justify-between items-center border-b-2 border-primary/20 pb-3">
        <h1 className="font-headline-xl text-3xl text-primary underline decoration-secondary decoration-2 truncate tracking-tight">
          Tic-Tac-Toe Journal
        </h1>
        <button
          onClick={onBack}
          className="text-sm font-label-sm text-outline hover:text-secondary flex items-center gap-1 transition-colors"
        >
          <span className="material-symbols-outlined text-sm">arrow_back</span>
          setup
        </button>
      </header>

      {/* Main Body Grid - switch from side-by-side to stacked dynamically in portrait */}
      <div className={`flex ${isPortrait ? "flex-col items-center gap-6" : "flex-row gap-8 items-start justify-center"} mt-2 w-full`}>
        {/* Left Column: Game Area */}
        <section className={`${isPortrait ? "w-full max-w-[400px]" : "w-[440px]"} flex flex-col items-center`}>
          {/* Scoreboard */}
          <div className="w-full max-w-md flex justify-between items-end mb-8 px-4 border-b-2 border-primary/20 pb-4">
            <div className="text-center">
              <div className="font-headline-lg text-lg text-primary">Bot X (X)</div>
              <div className="font-body-lg text-3xl text-primary mt-1 min-h-[30px] flex items-center justify-center font-bold">
                {g.score.x}
              </div>
              <div className="font-label-sm text-[10px] text-outline mt-1">{fmtSui(g.balances.x)} SUI</div>
            </div>
            <div className="text-center">
              <button
                onClick={g.resetScore}
                title="Reset scores"
                className="hover:bg-primary/5 p-1 rounded-full text-outline hover:text-primary transition-colors mb-2"
              >
                <span className="material-symbols-outlined text-lg">autorenew</span>
              </button>
              <div className="font-body-lg text-outline/75 text-base">Draws: {g.score.draws}</div>
            </div>
            <div className="text-center">
              <div className="font-headline-lg text-lg text-secondary">Bot O (O)</div>
              <div className="font-body-lg text-3xl text-secondary mt-1 min-h-[30px] flex items-center justify-center font-bold">
                {g.score.o}
              </div>
              <div className="font-label-sm text-[10px] text-outline mt-1">{fmtSui(g.balances.o)} SUI</div>
            </div>
          </div>

          {/* Grid board */}
          <div className="flex justify-center my-4">
            <Board board={uiBoard(g.board)} onPlay={() => {}} disabled />
          </div>

          {/* Status text */}
          <div className="text-center font-body-lg text-2xl text-primary font-bold my-4 min-h-[28px] ink-bleed">
            {statusText(g.phase, g.turn, g.winner)}
          </div>

          {/* Per-tunnel progress: game k / N */}
          <div className="text-center font-label-sm text-xs text-outline -mt-2 mb-2 min-h-[16px]">
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
          <div className="mt-6 flex flex-wrap gap-4 justify-center">
            {mode === "auto" ? (
              g.auto ? (
                <button
                  onClick={g.stopAuto}
                  className="bg-secondary text-on-secondary font-headline-lg-mobile text-base px-6 py-2.5 rounded-sm shadow-[2px_2px_0px_#410000] hover:translate-y-[2px] hover:shadow-none transition-all transform -rotate-1 border-[2px] border-primary"
                >
                  ⏹ Stop Playing
                </button>
              ) : (
                <button
                  onClick={onBack}
                  className="bg-primary text-on-primary font-headline-lg-mobile text-base px-6 py-2.5 rounded-sm shadow-[2px_2px_0px_#bc0000] hover:translate-y-[2px] hover:shadow-none transition-all transform rotate-1 border-[2px] border-primary"
                >
                  ← Back to setup
                </button>
              )
            ) : (
              <>
                <button
                  onClick={onBack}
                  className="border-2 border-primary text-primary font-headline-lg-mobile text-base px-6 py-2.5 rounded-sm hover:bg-primary/5 transition-all transform -rotate-1 shadow-[2px_2px_0px_#001e40]"
                >
                  ← Setup
                </button>
                <button
                  onClick={g.newGame}
                  disabled={busy}
                  className="bg-primary text-on-primary font-headline-lg-mobile text-base px-6 py-2.5 rounded-sm shadow-[2px_2px_0px_#bc0000] hover:translate-y-[2px] hover:shadow-none transition-all transform rotate-1 border-[2px] border-primary disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  New Game
                </button>
              </>
            )}
          </div>
        </section>

        {/* Right Column: Game Log / Info */}
        <aside className={`${isPortrait ? "w-full max-w-[400px] mt-4" : "w-[400px]"} flex flex-col gap-4`}>
          <h2 className="font-headline-lg text-xl text-primary mb-1 flex items-center gap-2">
            <span className="material-symbols-outlined">edit_note</span>
            Game Log
          </h2>
          
          <div className="bg-surface-container-low border-[2px] border-primary p-6 relative rounded-sm shadow-[4px_4px_0px_#00336610] w-full">
            {/* Taped effect */}
            <div className="tape-top"></div>

            <ul className="space-y-4 pt-2 font-label-sm text-xs text-primary">
              <li className="flex justify-between items-center border-b border-primary/10 pb-2">
                <span className="font-bold text-outline uppercase text-[10px]">Step</span>
                <span className="font-bold text-outline uppercase text-[10px]">Tx Digest</span>
              </li>
              
              <li className="flex justify-between items-center py-1 border-b border-primary/5">
                <span className="flex items-center gap-1.5"><span className="text-secondary font-bold">1</span> Create Tunnel</span>
                {g.digests.create ? (
                  <a
                    href={`https://suiscan.xyz/testnet/tx/${g.digests.create}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-primary underline hover:text-secondary"
                  >
                    {g.digests.create.slice(0, 6)}…{g.digests.create.slice(-4)}
                  </a>
                ) : (
                  <span className="text-outline/40">—</span>
                )}
              </li>

              <li className="flex justify-between items-center py-1 border-b border-primary/5">
                <span className="flex items-center gap-1.5"><span className="text-secondary font-bold">2</span> Deposit Bot X</span>
                {g.digests.depositX ? (
                  <a
                    href={`https://suiscan.xyz/testnet/tx/${g.digests.depositX}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-primary underline hover:text-secondary"
                  >
                    {g.digests.depositX.slice(0, 6)}…{g.digests.depositX.slice(-4)}
                  </a>
                ) : (
                  <span className="text-outline/40">—</span>
                )}
              </li>

              <li className="flex justify-between items-center py-1 border-b border-primary/5">
                <span className="flex items-center gap-1.5"><span className="text-secondary font-bold">3</span> Deposit Bot O</span>
                {g.digests.depositO ? (
                  <a
                    href={`https://suiscan.xyz/testnet/tx/${g.digests.depositO}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-primary underline hover:text-secondary"
                  >
                    {g.digests.depositO.slice(0, 6)}…{g.digests.depositO.slice(-4)}
                  </a>
                ) : (
                  <span className="text-outline/40">—</span>
                )}
              </li>

              <li className="flex justify-between items-center py-1 border-b border-primary/5">
                <span className="flex items-center gap-1.5"><span className="text-secondary font-bold">4</span> Transcript Root</span>
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

              <li className="flex justify-between items-center py-1 border-b border-primary/5">
                <span className="flex items-center gap-1.5"><span className="text-secondary font-bold">5</span> Settle & Close</span>
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
              <div className="mt-6 text-xs text-secondary italic font-body-lg text-base text-center leading-tight">
                * Auto-play enabled *
              </div>
            )}

            {g.error && (
              <div className="mt-4 text-xs text-secondary font-label-sm border border-secondary/20 bg-secondary/5 p-2 rounded-sm italic">
                * Error: {g.error}
              </div>
            )}

            {/* Scribbled notes */}
            <div className="mt-8 text-primary/60 font-body-lg text-lg text-center transform -rotate-3 select-none leading-tight border-t border-dashed border-primary/20 pt-4">
              Watch out for the diagonal trick!
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
