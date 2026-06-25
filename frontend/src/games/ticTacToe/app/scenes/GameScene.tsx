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
import { isMtpsConfigured } from "@/onchain/mtps";

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
    <div className="flex flex-col items-center gap-1.5">
      <span className="qp-eyebrow text-[11px] opacity-80 whitespace-nowrap">
        Games / tunnel
      </span>
      <div className="flex flex-wrap items-center justify-center gap-1.5">
        {GAME_PRESETS.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n)}
            disabled={disabled}
            className={`qp-btn transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              value === n ? "qp-btn--go" : ""
            } !px-2.5 !py-1 !text-xs`}
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
          className="qp-input w-14 px-2 py-1 bg-[#fffdf6] border-2 border-[var(--qp-ink)] focus:border-[var(--qp-amber)] rounded-md font-mono text-center tabular-nums outline-none disabled:opacity-40 disabled:cursor-not-allowed text-xs"
        />
      </div>
    </div>
  );
}

const SUISCAN_TX = "https://suiscan.xyz/testnet/tx/";
function shortDigest(d: string): string {
  return `${d.slice(0, 6)}…${d.slice(-4)}`;
}

/** One on-chain step in the log: a linked digest chip, or a dim placeholder. All sizes are
 *  em-relative so the chip scales with the parent OnchainLogStrip's base font-size. */
function LogChip({
  step,
  label,
  digest,
  link = true,
}: {
  step: number;
  label: string;
  digest?: string;
  /** Root has no own tx — render as a plain hash, not a suiscan link. */
  link?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-[0.4em] whitespace-nowrap">
      <span className="grid h-[1.5em] w-[1.5em] shrink-0 place-items-center rounded-full bg-[var(--qp-ink)] text-[0.72em] font-bold text-[var(--qp-paper)]">
        {step}
      </span>
      <span className="text-[0.92em] uppercase tracking-wide opacity-70">
        {label}
      </span>
      {digest ? (
        link ? (
          <a
            href={`${SUISCAN_TX}${digest}`}
            target="_blank"
            rel="noreferrer"
            className="font-mono text-[0.92em] text-primary underline hover:text-secondary"
          >
            {shortDigest(digest)}
          </a>
        ) : (
          <span title={digest} className="font-mono text-[0.92em] text-primary">
            {shortDigest(digest)}
          </span>
        )
      ) : (
        <span className="font-mono text-[0.92em] text-outline/40">—</span>
      )}
    </span>
  );
}

/** The four-step on-chain trail + a running settled-tunnel count. Lays out as a wrapping row
 *  (portrait footer) or a vertical list (the right side pane). The vertical variant scales its
 *  base font with the window (cqw) so it always fits the narrow pane. */
function OnchainLogStrip({
  g,
  vertical = false,
}: {
  g: BotGameView & { tunnels?: TunnelRecord[] };
  vertical?: boolean;
}) {
  const latest = g.tunnels?.[0];
  return (
    <div
      style={{ fontSize: vertical ? "clamp(8px, 1.9cqw, 11px)" : "11px" }}
      className={
        vertical
          ? "flex flex-col items-start gap-[0.5em]"
          : "flex flex-wrap items-center justify-center gap-x-4 gap-y-1"
      }
    >
      <LogChip step={1} label="Open" digest={g.digests.create} />
      <LogChip step={2} label="Root" digest={g.digests.root} link={false} />
      <LogChip step={3} label="State" digest={g.digests.update} />
      <LogChip step={4} label="Settle" digest={g.digests.close} />
      {g.tunnels && g.tunnels.length > 0 && (
        <span
          className={`inline-flex items-center gap-[0.4em] whitespace-nowrap ${
            vertical
              ? "mt-[0.3em] border-t border-[var(--qp-ink-soft)]/40 pt-[0.5em]"
              : "border-l border-[var(--qp-ink-soft)]/40 pl-4"
          }`}
        >
          <span className="text-[0.92em] uppercase tracking-wide opacity-70">
            Settled {g.tunnels.length}
          </span>
          {latest?.closeDigest && (
            <a
              href={`${SUISCAN_TX}${latest.closeDigest}`}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[0.92em] text-[var(--qp-ink-soft)] underline hover:text-[var(--qp-ink)]"
            >
              {shortDigest(latest.closeDigest)}
            </a>
          )}
        </span>
      )}
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
  // Sizing comes from `.ttt-ctl-btn` (cqw-scaled) so the side panes can shrink on small windows
  // without the buttons overflowing — Bomb It-style responsive controls.
  const autoToggle = (
    <button
      onClick={() => g.setAuto(!g.auto)}
      aria-pressed={g.auto}
      data-testid="ttt-auto"
      className={`qp-btn ttt-ctl-btn w-full flex items-center justify-center gap-2 ${
        g.auto ? "qp-btn--go" : ""
      }`}
    >
      <span
        className={`grid h-4 w-4 shrink-0 place-items-center border-[2px] border-[var(--qp-ink)] text-xs rounded-sm ${g.auto ? "bg-[var(--qp-ink)] text-[var(--qp-paper)]" : "bg-[var(--qp-paper)]"}`}
      >
        {g.auto ? "✓" : ""}
      </span>
      Auto
    </button>
  );
  const menuBtn = (
    <button onClick={onMenu} className="qp-btn ttt-ctl-btn w-full">
      ← Menu
    </button>
  );
  const controls =
    mode === "auto" ? (
      <>
        {menuBtn}
        {autoToggle}
      </>
    ) : (
      <>
        <button onClick={onBack} className="qp-btn ttt-ctl-btn w-full">
          ← Setup
        </button>
        <button
          onClick={g.newGame}
          disabled={busy}
          className="qp-btn qp-btn--go ttt-ctl-btn w-full disabled:opacity-40 disabled:cursor-not-allowed"
        >
          New game
        </button>
      </>
    );

  const title = gameType === "caro" ? "Caro" : "Tic-Tac-Toe";
  const status = statusText(g.phase, g.turn, g.winner, gameType, !g.auto);
  const progress =
    g.phase === "playing" || g.phase === "settling"
      ? `Game ${Math.min(g.currentGame, g.maxGames)} / ${g.maxGames}`
      : `${g.maxGames} game${g.maxGames === 1 ? "" : "s"} / tunnel`;

  // A scoreboard "seat" (one player's eyebrow + score + optional SUI balance).
  const seat = (label: string, score: number, balance: bigint) => (
    <div className="text-center leading-tight">
      <div className="qp-eyebrow text-sm">{label}</div>
      <div className="font-bold text-4xl tabular-nums">{score}</div>
      {/* MTPS mode: play is free + auto-funded — hide the SUI gas balance. */}
      {!isMtpsConfigured && (
        <div className="font-mono text-[10px] opacity-60">
          {fmtSui(balance)} SUI
        </div>
      )}
    </div>
  );
  // Compact seat for the right pane's two-up score row — sizes scale with the window (cqw)
  // so both seats fit one row even on a narrow pane.
  const seatMini = (label: string, score: number, balance: bigint) => (
    <div className="flex-1 min-w-0 text-center leading-tight">
      <div className="qp-eyebrow text-[0.62rem] truncate">{label}</div>
      <div className="font-bold text-[clamp(20px,6cqw,34px)] tabular-nums">
        {score}
      </div>
      {!isMtpsConfigured && (
        <div className="font-mono text-[0.55rem] opacity-60 truncate">
          {fmtSui(balance)}
        </div>
      )}
    </div>
  );
  const resetDraws = (
    <div className="flex flex-col items-center gap-0.5">
      <button
        onClick={g.resetScore}
        title="Reset scores"
        className="hover:bg-[var(--qp-ink-soft)]/20 p-1 rounded-full text-[var(--qp-ink-soft)] hover:text-[var(--qp-ink)] transition-colors"
      >
        <span className="material-symbols-outlined text-lg">autorenew</span>
      </button>
      <div className="font-bold text-[var(--qp-ink-soft)] text-sm">
        Draws {g.score.draws}
      </div>
    </div>
  );
  const tunnelControl = (
    <div className="flex flex-col items-center gap-2 w-full">
      <span className="qp-eyebrow text-[11px] opacity-80 text-center">
        {progress}
      </span>
      <GamesPerTunnel
        value={g.maxGames}
        onChange={g.setMaxGames}
        disabled={busy || g.auto}
      />
    </div>
  );

  const board =
    gameType === "caro" ? (
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
    );

  // Portrait: too narrow for side panes — stack board over a compact control/log block.
  if (isPortrait) {
    return (
      <div className="w-full h-full overflow-hidden flex flex-col items-center gap-1 p-1">
        <header className="w-full flex items-center justify-between gap-3 border-b-2 border-[var(--qp-ink-soft)] pb-2">
          <h1 className="qp-title text-2xl truncate shrink-0">{title}</h1>
          <div className="flex items-center gap-5">
            {seat(g.auto ? "Bot X (X)" : "You (X)", g.score.x, g.balances.x)}
            {resetDraws}
            {seat("Bot (O)", g.score.o, g.balances.o)}
          </div>
        </header>
        <div className="ttt-board-area flex-1 min-h-0 w-full grid place-items-center">
          <div className="ttt-board-square">{board}</div>
        </div>
        <div className="text-center qp-title text-xl min-h-[24px]">
          {status}
        </div>
        <div className="w-full max-w-[480px] flex flex-col items-center gap-2 border-t-2 border-[var(--qp-ink-soft)] pt-2">
          <div className="flex items-stretch gap-3 w-full">{controls}</div>
          {tunnelControl}
          <OnchainLogStrip g={g} />
          {g.error && (
            <div className="text-[11px] text-secondary italic">
              * Error: {g.error}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Landscape: Bomb It-style three columns — controls pane | board hero | info pane.
  return (
    <div className="w-full h-full overflow-hidden flex flex-row items-stretch gap-3 px-1 py-2">
      {/* Left pane (top→bottom): Menu, Auto, game progress, status, games-per-tunnel. */}
      <aside className="ttt-pane qp-panel qp-stroke shrink-0 flex flex-col items-center gap-3 overflow-y-auto">
        <div className="w-full flex flex-col gap-2">{controls}</div>
        <span className="qp-eyebrow text-[11px] opacity-80 text-center">
          {progress}
        </span>
        <div className="qp-title text-base leading-tight text-center min-h-[2.4em] flex items-center">
          {status}
        </div>
        <GamesPerTunnel
          value={g.maxGames}
          onChange={g.setMaxGames}
          disabled={busy || g.auto}
        />
        {g.error && (
          <div className="text-[11px] text-secondary italic w-full text-center">
            * Error: {g.error}
          </div>
        )}
      </aside>

      {/* Center: board hero only — no title, so the playfield is a square that fills the area. */}
      <main className="ttt-board-area flex-1 min-w-0 grid place-items-center">
        <div className="ttt-board-square">{board}</div>
      </main>

      {/* Right pane: both scores on one row, then draws + the condensed on-chain trail. */}
      <aside className="ttt-pane qp-panel qp-stroke shrink-0 flex flex-col items-center gap-3 overflow-y-auto">
        <div className="w-full flex items-start justify-between gap-1">
          {seatMini(g.auto ? "Bot X (X)" : "You (X)", g.score.x, g.balances.x)}
          {seatMini("Bot (O)", g.score.o, g.balances.o)}
        </div>
        {resetDraws}
        <div className="w-full border-t-2 border-[var(--qp-ink-soft)]/40 pt-2">
          <div className="qp-eyebrow text-[11px] opacity-80 mb-1.5">
            On-chain
          </div>
          <OnchainLogStrip g={g} vertical />
        </div>
      </aside>
    </div>
  );
}
