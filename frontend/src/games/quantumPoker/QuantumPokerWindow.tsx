import { useCurrentAccount } from "@mysten/dapp-kit";
import type { CSSProperties } from "react";
import type { PokerMove, PokerPhase } from "sui-tunnel-ts/protocol/quantumPoker";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import type { GameWindowProps } from "../types";
import { useQuantumPokerBot } from "./useQuantumPokerBot";

// ---------------------------------------------------------------------------
// Presentational constants
// ---------------------------------------------------------------------------

const PHASE_LABEL: Record<PokerPhase, string> = {
  commit: "Commit",
  open_private_holes: "Private open",
  preflop_bet: "Preflop",
  reveal_flop: "Flop reveal",
  flop_bet: "Flop",
  reveal_turn: "Turn reveal",
  turn_bet: "Turn",
  reveal_river: "River reveal",
  river_bet: "River",
  showdown: "Showdown",
  hand_over: "Settled",
  done: "Done",
};

const SUITS = ["♠", "♥", "♦", "♣"] as const;
const RANKS = [
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "T",
  "J",
  "Q",
  "K",
  "A",
];

const HEADS_UP_STYLE: CSSProperties & Record<`--${string}`, string> = {
  "--qp-felt": "#0f6b52",
  "--qp-felt-dark": "#08372f",
  "--qp-rail": "#14191d",
  "--qp-gold": "#f4c45d",
  "--qp-cyan": "#67e8f9",
};

// ---------------------------------------------------------------------------
// Presentational helpers
// ---------------------------------------------------------------------------

function cardText(card: number): string {
  return `${RANKS[card % 13]}${SUITS[Math.floor(card / 13)]}`;
}

function moveLabel(move: PokerMove): string {
  switch (move.kind) {
    case "commit_slots":
      return "committed 9 slots";
    case "reveal_slots":
      return `revealed ${move.slots.join("/")}`;
    case "bet":
      return `bet ${move.amount}`;
    case "check":
      return "check";
    case "call":
      return "call";
    case "fold":
      return "fold";
    case "next_hand":
      return "next hand";
  }
}

// Keep moveLabel referenced so TypeScript doesn't warn on an unused export.
void moveLabel;

function Card({ card, hidden }: { card: number | null; hidden?: boolean }) {
  const suit = card === null ? "" : SUITS[Math.floor(card / 13)];
  const red = suit === "♥" || suit === "♦";
  return (
    <span
      className={[
        "grid h-10 w-7 shrink-0 place-items-center rounded-[4px] border text-[10px] font-bold shadow-[0_3px_10px_rgba(0,0,0,.28)]",
        hidden
          ? "border-cyan-200/25 bg-[repeating-linear-gradient(135deg,rgba(103,232,249,.16)_0_3px,rgba(8,20,24,.9)_3px_7px)] text-cyan-100"
          : red
            ? "border-rose-200/50 bg-[#f1eadc] text-rose-700"
            : "border-slate-200/50 bg-[#f1eadc] text-slate-950",
      ].join(" ")}
    >
      {hidden || card === null ? "" : cardText(card)}
    </span>
  );
}

function CardRow({
  cards,
  hidden,
  size = 5,
}: {
  cards: number[];
  hidden?: boolean;
  size?: number;
}) {
  return (
    <div className="flex items-center justify-center gap-1">
      {Array.from({ length: size }, (_, i) => (
        <Card
          key={i}
          card={cards[i] ?? null}
          hidden={hidden || cards[i] === undefined}
        />
      ))}
    </div>
  );
}

function ChipStack({ value }: { value: bigint }) {
  return (
    <div className="flex items-center gap-1 text-[10px] tabular-nums text-slate-300">
      <span className="h-2.5 w-2.5 rounded-full border border-amber-100/50 bg-[var(--qp-gold)] shadow-[0_0_0_2px_rgba(244,196,93,.18)]" />
      <span>{value.toString()}</span>
    </div>
  );
}

function PlayerSeat({
  party,
  name,
  persona,
  balance,
  bet,
  holes,
  active,
  winner,
  side,
}: {
  party: Party;
  name: string;
  persona: string;
  balance: bigint;
  bet: bigint;
  holes: number[];
  active: boolean;
  winner: boolean;
  side: "top" | "bottom";
}) {
  return (
    <section
      className={[
        "relative flex min-h-[4.6rem] min-w-0 items-center justify-between gap-2 rounded-md border px-2 py-1.5 shadow-[0_8px_24px_rgba(0,0,0,.24)]",
        active
          ? "border-cyan-200/60 bg-cyan-200/10"
          : "border-white/10 bg-[rgba(20,25,29,.82)]",
      ].join(" ")}
    >
      <div
        className={[
          "absolute left-1/2 h-2 w-10 -translate-x-1/2 rounded-full bg-black/35",
          side === "top" ? "-bottom-1" : "-top-1",
        ].join(" ")}
      />
      <div className="flex min-w-0 items-center gap-2">
        <div
          className={[
            "grid h-8 w-8 shrink-0 place-items-center rounded-full border text-[12px] font-bold",
            active
              ? "border-cyan-200 bg-cyan-200 text-slate-950"
              : "border-white/15 bg-black/35 text-slate-100",
          ].join(" ")}
        >
          {party}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-200">
            <span>{name}</span>
            {winner && (
              <span className="rounded-sm bg-emerald-300 px-1 text-[8px] text-slate-950">
                WIN
              </span>
            )}
          </div>
          <ChipStack value={balance} />
          <div className="text-[9px] tabular-nums text-slate-500">
            {persona} · street {bet.toString()}
          </div>
        </div>
      </div>
      <div className="rounded-md bg-black/18 p-1">
        <CardRow cards={holes} hidden={holes.length === 0} size={2} />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// ActionBar — human betting controls
// ---------------------------------------------------------------------------

function ActionBar({
  legal,
  onAct,
}: {
  legal: NonNullable<ReturnType<typeof useQuantumPokerBot>["legal"]>;
  onAct: (m: PokerMove) => void;
}) {
  const raise = (amt: bigint) => onAct({ kind: "bet", amount: amt });
  const clamp = (v: bigint) =>
    v < legal.minBet ? legal.minBet : v > legal.maxBet ? legal.maxBet : v;
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-white/10 bg-black/30 p-2">
      <button
        type="button"
        onClick={() => onAct({ kind: "fold" })}
        className="h-7 rounded-sm border border-rose-300/40 px-3 text-[11px] font-semibold text-rose-100"
      >
        Fold
      </button>
      {legal.canCheck && (
        <button
          type="button"
          onClick={() => onAct({ kind: "check" })}
          className="h-7 rounded-sm border border-white/20 px-3 text-[11px] font-semibold text-slate-100"
        >
          Check
        </button>
      )}
      {legal.canCall && (
        <button
          type="button"
          onClick={() => onAct({ kind: "call" })}
          className="h-7 rounded-sm border border-[var(--qp-cyan)]/50 px-3 text-[11px] font-semibold text-cyan-100"
        >
          Call {legal.callAmount.toString()}
        </button>
      )}
      {legal.minBet > 0n && (
        <>
          <button
            type="button"
            onClick={() => raise(legal.minBet)}
            className="h-7 rounded-sm border border-amber-200/40 px-3 text-[11px] font-semibold text-amber-100"
          >
            Raise {legal.minBet.toString()}
          </button>
          <button
            type="button"
            onClick={() => raise(clamp(legal.maxBet / 2n))}
            className="h-7 rounded-sm border border-amber-200/40 px-3 text-[11px] font-semibold text-amber-100"
          >
            ½
          </button>
          <button
            type="button"
            onClick={() => raise(legal.maxBet)}
            className="h-7 rounded-sm bg-[var(--qp-gold)] px-3 text-[11px] font-black text-slate-950"
          >
            All-in {legal.maxBet.toString()}
          </button>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main window
// ---------------------------------------------------------------------------

export function QuantumPokerWindow({
  windowId,
  onExit,
}: GameWindowProps & { lane?: "bot" | "auto"; onExit?: () => void }) {
  const account = useCurrentAccount();
  const game = useQuantumPokerBot(windowId);
  const s = game.state;

  if (!s) {
    return (
      <div
        style={HEADS_UP_STYLE}
        className="flex h-full min-h-[14rem] flex-col items-center justify-center gap-3 bg-[#080b0d] p-5 text-center text-slate-100"
      >
        <span className="rounded-sm bg-[var(--qp-gold)] px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.14em] text-slate-950">
          bot mode
        </span>
        <p className="max-w-[17rem] text-[12px] text-slate-400">
          Open a real self-play tunnel: your wallet funds both seats once, you
          play party A, a random-persona bot plays party B, then it settles
          gas-free.
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={game.open}
            disabled={game.status === "funding" || !account}
            className="rounded-md bg-[var(--qp-gold)] px-4 py-2 text-[12px] font-bold text-slate-950 disabled:opacity-45"
          >
            {game.status === "funding"
              ? "Opening…"
              : account
                ? "Open tunnel"
                : "Connect wallet"}
          </button>
          {onExit && (
            <button
              type="button"
              onClick={onExit}
              className="rounded-md border border-white/15 px-4 py-2 text-[12px] font-semibold text-slate-200"
            >
              Back
            </button>
          )}
        </div>
        {game.error && (
          <div className="text-[10px] text-rose-300">{game.error}</div>
        )}
      </div>
    );
  }

  const pot = s.totalBetA + s.totalBetB;
  const result = s.lastResult;
  const holesB = s.shownHoleB ?? [];

  return (
    <div
      style={HEADS_UP_STYLE}
      className="flex h-full min-h-[14rem] flex-col overflow-hidden bg-[#080b0d] text-slate-100"
    >
      <main className="flex min-h-0 flex-1 flex-col gap-2 p-2">
        <section className="relative flex min-h-0 flex-1 flex-col justify-between gap-2 rounded-lg border border-emerald-200/20 bg-[linear-gradient(145deg,rgba(255,255,255,.06),transparent_28%),radial-gradient(ellipse_at_center,var(--qp-felt)_0%,var(--qp-felt-dark)_68%,#031615_100%)] p-2 shadow-[inset_0_0_0_5px_rgba(0,0,0,.2)]">
          {/* Opponent seat (party B, top) */}
          <PlayerSeat
            party="B"
            name="Bot"
            persona="random"
            balance={s.balanceB}
            bet={s.totalBetB}
            holes={holesB}
            active={s.toAct === "B"}
            winner={result?.winner === "B"}
            side="top"
          />

          {/* Board + pot */}
          <div className="relative grid min-h-[5.8rem] place-items-center rounded-[999px] border border-amber-100/20 bg-black/15 px-2 py-2">
            <div className="absolute top-1 flex items-center gap-1 rounded-full border border-amber-100/25 bg-black/35 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-amber-100">
              <span className="h-2 w-2 rounded-full bg-[var(--qp-gold)]" />
              <span>{pot.toString()}</span>
            </div>
            <CardRow cards={s.board} size={5} />
            <div className="absolute bottom-1 flex max-w-[92%] items-center gap-2 overflow-hidden text-[9px] uppercase tracking-[0.08em] text-emerald-50/70">
              <span className="truncate">{PHASE_LABEL[s.phase]}</span>
              <span className="h-1 w-1 rounded-full bg-emerald-100/45" />
              <span>hand {s.handNo.toString()}</span>
            </div>
          </div>

          {/* Human seat (party A, bottom) */}
          <PlayerSeat
            party="A"
            name="You"
            persona="human"
            balance={s.balanceA}
            bet={s.totalBetA}
            holes={game.humanHoles}
            active={s.toAct === "A"}
            winner={result?.winner === "A"}
            side="bottom"
          />
        </section>

        {/* Human action bar — only shown when it's the human's betting turn */}
        {game.status === "awaitHuman" && game.legal && (
          <ActionBar legal={game.legal} onAct={game.act} />
        )}

        {/* Status footer */}
        <div className="px-2 py-1 text-[10px] text-slate-500">
          {game.status === "settled"
            ? "Settled."
            : game.status === "settling"
              ? "Settling…"
              : `phase ${s.phase}`}
          {game.status === "settled" && (
            <button
              type="button"
              onClick={game.open}
              className="ml-2 rounded-sm border border-white/15 px-2 py-0.5 text-[10px]"
            >
              New tunnel
            </button>
          )}
          {onExit && (
            <button
              type="button"
              onClick={onExit}
              className="ml-2 rounded-sm border border-white/15 px-2 py-0.5 text-[10px]"
            >
              Back
            </button>
          )}
        </div>
      </main>
    </div>
  );
}
