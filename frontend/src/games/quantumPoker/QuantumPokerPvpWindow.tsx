import type { CSSProperties } from "react";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import type { PokerState } from "sui-tunnel-ts/protocol/quantumPoker";
import type { GameWindowProps } from "../types";
import { usePvpQuantumPoker } from "./usePvpQuantumPoker";

const SUITS = ["♠", "♥", "♦", "♣"] as const;
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];

const PHASE_LABEL: Record<PokerState["phase"], string> = {
  commit: "Shuffling…",
  open_private_holes: "Dealing holes…",
  preflop_bet: "Preflop",
  reveal_flop: "Dealing flop…",
  flop_bet: "Flop",
  reveal_turn: "Dealing turn…",
  turn_bet: "Turn",
  reveal_river: "Dealing river…",
  river_bet: "River",
  showdown: "Showdown",
  hand_over: "Hand over",
  done: "Settled",
};

const FELT: CSSProperties & Record<`--${string}`, string> = {
  "--qp-felt": "#0f6b52",
  "--qp-felt-dark": "#08372f",
  "--qp-gold": "#f4c45d",
};

function cardText(card: number): string {
  return `${RANKS[card % 13]}${SUITS[Math.floor(card / 13)]}`;
}

function Card({ card, small }: { card: number | null; small?: boolean }) {
  const suit = card === null ? "" : SUITS[Math.floor(card / 13)];
  const red = suit === "♥" || suit === "♦";
  return (
    <span
      className={[
        small ? "h-8 w-6 text-[10px]" : "h-9 w-7 text-xs",
        "grid shrink-0 place-items-center rounded border font-bold shadow-[0_2px_6px_rgba(0,0,0,.3)]",
        card === null
          ? "border-cyan-200/25 bg-[repeating-linear-gradient(135deg,rgba(103,232,249,.16)_0_3px,rgba(8,20,24,.9)_3px_7px)]"
          : red
            ? "border-rose-200/50 bg-[#f1eadc] text-rose-700"
            : "border-slate-200/50 bg-[#f1eadc] text-slate-950",
      ].join(" ")}
    >
      {card === null ? "" : cardText(card)}
    </span>
  );
}

function CardRow({ cards, size, small }: { cards: (number | null)[]; size: number; small?: boolean }) {
  return (
    <div className="flex items-center justify-center gap-1">
      {Array.from({ length: size }, (_, i) => (
        <Card key={i} card={cards[i] ?? null} small={small} />
      ))}
    </div>
  );
}

function Seat({
  label,
  balance,
  streetBet,
  active,
  cards,
  won,
  highlight,
}: {
  label: string;
  balance: bigint;
  streetBet: bigint;
  active: boolean;
  cards: (number | null)[];
  won: boolean;
  highlight?: boolean;
}) {
  return (
    <div
      className={[
        "flex shrink-0 items-center justify-between gap-2 rounded-md border px-2 py-1.5",
        active
          ? "border-cyan-200/60 bg-cyan-200/10"
          : highlight
            ? "border-arena-accent/40 bg-black/30"
            : "border-white/10 bg-black/30",
      ].join(" ")}
    >
      <div className="min-w-0 leading-tight">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-200">
          {label}
          {active && <span className="text-[9px] text-cyan-300">• to act</span>}
          {won && <span className="rounded-sm bg-emerald-300 px-1 text-[9px] text-slate-950">WIN</span>}
        </div>
        <div className="text-[10px] tabular-nums">
          <span className="text-[var(--qp-gold)]">{balance.toString()}</span>
          <span className="text-slate-500"> stack · bet </span>
          <span className="text-slate-300">{streetBet.toString()}</span>
        </div>
      </div>
      <CardRow cards={cards} size={2} small />
    </div>
  );
}

/** Heads-up Quantum Poker vs a real opponent: matchmaking + relay co-sign + on-chain stakes. */
export function QuantumPokerPvpWindow(_props: GameWindowProps) {
  const g = usePvpQuantumPoker();

  if (g.status === "idle") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
        <p className="text-sm text-arena-muted">
          Heads-up poker vs a real opponent. Each seat stakes{" "}
          <span className="text-arena-accent">500</span> on-chain; cards are dealt by a
          two-party commit-reveal (no dealer). Winner is paid at cooperative close.
        </p>
        <button
          type="button"
          onClick={g.findMatch}
          className="rounded bg-arena-accent px-4 py-2 text-sm font-semibold text-black"
        >
          Find Match
        </button>
      </div>
    );
  }

  if (g.status === "matching" || g.status === "funding") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-arena-muted">
        <div>
          {g.status === "matching"
            ? "Finding an opponent…"
            : "Opening + funding the tunnel on-chain…"}
        </div>
        {g.opponentWallet && (
          <div className="text-[11px]">vs {g.opponentWallet.slice(0, 10)}…</div>
        )}
      </div>
    );
  }

  if (g.status === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center">
        <p className="text-sm text-red-400">{g.error}</p>
        <button type="button" onClick={g.reset} className="rounded border border-arena-edge px-3 py-1.5 text-sm">
          Back
        </button>
      </div>
    );
  }

  const s = g.state;
  const self = g.selfParty;
  if (!s || !self) return null;
  const opp: Party = self === "A" ? "B" : "A";

  const myBalance = self === "A" ? s.balanceA : s.balanceB;
  const oppBalance = self === "A" ? s.balanceB : s.balanceA;
  const myStreet = self === "A" ? s.streetBetA : s.streetBetB;
  const oppStreet = self === "A" ? s.streetBetB : s.streetBetA;
  const myTotalBet = self === "A" ? s.totalBetA : s.totalBetB;
  const oppTotalBet = self === "A" ? s.totalBetB : s.totalBetA;
  // Remaining stack = balance minus chips committed this hand. Once the hand resolves
  // (`lastResult` set), the pot is already folded back into `balance`, so show it raw.
  const myStack = s.lastResult ? myBalance : myBalance - myTotalBet;
  const oppStack = s.lastResult ? oppBalance : oppBalance - oppTotalBet;
  const pot = s.totalBetA + s.totalBetB;
  const oppShown = self === "A" ? s.shownHoleB : s.shownHoleA;
  const oppCards: (number | null)[] = oppShown ?? [null, null];
  const myCards: (number | null)[] = g.myHole ?? [null, null];

  const terminal = s.phase === "done" || s.phase === "hand_over";
  const won = s.winner === self;
  const lost = s.winner === opp;
  const banner = terminal
    ? s.winner === "tie"
      ? "Split pot — stakes returned"
      : won
        ? `You win${s.lastResult?.reason === "fold" ? " (opponent folded)" : ""}`
        : lost
          ? `You lose${s.lastResult?.reason === "fold" ? " (you folded)" : ""}`
          : "Hand over"
    : g.myTurnToBet
      ? "Your turn"
      : `${PHASE_LABEL[s.phase]} · opponent's turn`;

  const legal = g.legal;
  // Pot-relative bet sizing. The protocol's `bet` amount is the increment to THIS seat's
  // street bet; a pot-sized raise = call + pot-after-call = pot + 2·diff (diff = amount to
  // call, 0 when first to act). Each size clamps to a legal min-raise and the stack (all-in).
  const diff = legal?.callAmount ?? 0n;
  const clampBet = (raw: bigint): bigint => {
    if (!legal) return 0n;
    return raw < legal.minBet ? legal.minBet : raw > legal.maxBet ? legal.maxBet : raw;
  };
  const halfPot = clampBet(diff > 0n ? diff + (pot + diff) / 2n : pot / 2n);
  const fullPot = clampBet(diff > 0n ? pot + 2n * diff : pot);
  const allIn = legal?.maxBet ?? 0n;
  // Surface only distinct, legal sizes — collapse to all-in when the stack is short.
  const showHalf = !!legal && legal.canBet && halfPot < fullPot && halfPot < allIn;
  const showPot = !!legal && legal.canBet && fullPot < allIn;
  const showAllIn = !!legal && legal.canBet;

  return (
    <div
      style={FELT}
      className="flex h-full min-h-0 flex-col gap-1.5 overflow-hidden bg-[#080b0d] p-2 text-slate-100"
    >
      <div className="flex shrink-0 items-center justify-between text-[10px] text-slate-400">
        <span>
          You are <span className="font-semibold text-arena-accent">{self}</span>
          {g.status === "settling" && " · settling…"}
          {g.status === "settled" && " · settled ✓"}
        </span>
        <span className="tabular-nums">hand {s.handNo.toString()}</span>
      </div>

      {/* Opponent (top) — holes hidden until showdown */}
      <Seat
        label={`Opponent (${opp})`}
        balance={oppStack}
        streetBet={oppStreet}
        active={!terminal && s.toAct === opp}
        cards={oppCards}
        won={lost}
      />

      {/* Board + pot — this is the part that shrinks if the window is short */}
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 rounded-lg border border-emerald-200/20 bg-[radial-gradient(ellipse_at_center,var(--qp-felt)_0%,var(--qp-felt-dark)_72%,#031615_100%)] p-1.5">
        <div className="flex items-center gap-1.5 rounded-full border border-amber-100/25 bg-black/35 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-amber-100">
          <span className="h-2 w-2 rounded-full bg-[var(--qp-gold)]" />
          pot {pot.toString()}
        </div>
        <CardRow cards={s.board} size={5} />
        <div className="text-[10px] uppercase tracking-wide text-emerald-50/70">
          {PHASE_LABEL[s.phase]}
        </div>
      </div>

      {/* You (bottom) — your hole cards, always visible */}
      <Seat
        label={`You (${self})`}
        balance={myStack}
        streetBet={myStreet}
        active={!terminal && s.toAct === self}
        cards={myCards}
        won={won}
        highlight
      />

      {/* Action bar — pinned, always visible so the hand can advance */}
      <div className="flex min-h-[2.25rem] shrink-0 flex-wrap items-center justify-center gap-1">
        {g.myTurnToBet && legal ? (
          <>
            {g.secondsLeft != null && (
              <span
                className={[
                  "min-w-[2rem] rounded px-1.5 py-1 text-center text-[11px] font-semibold tabular-nums",
                  g.secondsLeft <= 3 ? "bg-rose-500/20 text-rose-300" : "text-amber-200",
                ].join(" ")}
              >
                {g.secondsLeft}s
              </span>
            )}
            <button
              type="button"
              onClick={g.fold}
              className="min-w-[3.75rem] max-w-[9rem] flex-1 whitespace-nowrap rounded bg-rose-500/80 px-2 py-1 text-[11px] font-semibold text-white hover:bg-rose-500"
            >
              Fold
            </button>
            {legal.canCheck && (
              <button
                type="button"
                onClick={g.check}
                className="min-w-[3.75rem] max-w-[9rem] flex-1 whitespace-nowrap rounded bg-arena-panel px-2 py-1 text-[11px] font-semibold hover:bg-arena-edge"
              >
                Check
              </button>
            )}
            {legal.canCall && (
              <button
                type="button"
                onClick={g.call}
                className="min-w-[3.75rem] max-w-[9rem] flex-1 whitespace-nowrap rounded bg-arena-panel px-2 py-1 text-[11px] font-semibold hover:bg-arena-edge"
              >
                Call {legal.callAmount.toString()}
              </button>
            )}
            {showHalf && (
              <button
                type="button"
                onClick={() => g.bet(halfPot)}
                className="min-w-[3.75rem] max-w-[9rem] flex-1 whitespace-nowrap rounded bg-arena-accent/75 px-2 py-1 text-[11px] font-semibold text-black hover:bg-arena-accent"
              >
                ½ Pot · {halfPot.toString()}
              </button>
            )}
            {showPot && (
              <button
                type="button"
                onClick={() => g.bet(fullPot)}
                className="min-w-[3.75rem] max-w-[9rem] flex-1 whitespace-nowrap rounded bg-arena-accent px-2 py-1 text-[11px] font-semibold text-black"
              >
                Pot · {fullPot.toString()}
              </button>
            )}
            {showAllIn && (
              <button
                type="button"
                onClick={() => g.bet(allIn)}
                className="min-w-[3.75rem] max-w-[9rem] flex-1 whitespace-nowrap rounded bg-amber-400 px-2 py-1 text-[11px] font-semibold text-black hover:bg-amber-300"
              >
                All-in · {allIn.toString()}
              </button>
            )}
          </>
        ) : (
          <div className="text-xs font-semibold text-slate-200">{banner}</div>
        )}
        {g.status === "settled" && (
          <button
            type="button"
            onClick={g.reset}
            className="rounded border border-arena-edge px-2.5 py-1.5 text-xs"
          >
            Play Again
          </button>
        )}
      </div>
    </div>
  );
}
