import type { CSSProperties, JSX } from "react";
import type { PokerPhase, PokerState } from "sui-tunnel-ts/protocol/quantumPoker";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";

// ---------------------------------------------------------------------------
// Presentational constants
// ---------------------------------------------------------------------------

export const PHASE_LABEL: Record<PokerPhase, string> = {
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

export const SUITS = ["♠", "♥", "♦", "♣"] as const;
export const RANKS = [
  "2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A",
];

export const HEADS_UP_STYLE: CSSProperties & Record<`--${string}`, string> = {
  "--qp-felt": "#0f6b52",
  "--qp-felt-dark": "#08372f",
  "--qp-rail": "#14191d",
  "--qp-gold": "#f4c45d",
  "--qp-cyan": "#67e8f9",
};

// ---------------------------------------------------------------------------
// Presentational helpers
// ---------------------------------------------------------------------------

export function cardText(card: number): string {
  return `${RANKS[card % 13]}${SUITS[Math.floor(card / 13)]}`;
}

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
  balance,
  bet,
  holes,
  active,
  winner,
  side,
}: {
  party: Party;
  name: string;
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
            street {bet.toString()}
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
// QuantumPokerTable — shared felt rendering for Bot and Auto lanes
// ---------------------------------------------------------------------------

export function QuantumPokerTable({
  state,
  holesA,
  holesB,
  nameA,
  nameB,
}: {
  state: PokerState;
  holesA: number[];
  holesB: number[];
  nameA: string;
  nameB: string;
}): JSX.Element {
  const pot = state.totalBetA + state.totalBetB;
  const result = state.lastResult;

  return (
    <section className="relative flex min-h-0 flex-1 flex-col justify-between gap-2 rounded-lg border border-emerald-200/20 bg-[linear-gradient(145deg,rgba(255,255,255,.06),transparent_28%),radial-gradient(ellipse_at_center,var(--qp-felt)_0%,var(--qp-felt-dark)_68%,#031615_100%)] p-2 shadow-[inset_0_0_0_5px_rgba(0,0,0,.2)]">
      {/* Opponent seat (party B, top) */}
      <PlayerSeat
        party="B"
        name={nameB}
        balance={state.balanceB}
        bet={state.totalBetB}
        holes={holesB}
        active={state.toAct === "B"}
        winner={result?.winner === "B"}
        side="top"
      />

      {/* Board + pot */}
      <div className="relative grid min-h-[5.8rem] place-items-center rounded-[999px] border border-amber-100/20 bg-black/15 px-2 py-2">
        <div className="absolute top-1 flex items-center gap-1 rounded-full border border-amber-100/25 bg-black/35 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-amber-100">
          <span className="h-2 w-2 rounded-full bg-[var(--qp-gold)]" />
          <span>{pot.toString()}</span>
        </div>
        <CardRow cards={state.board} size={5} />
        <div className="absolute bottom-1 flex max-w-[92%] items-center gap-2 overflow-hidden text-[9px] uppercase tracking-[0.08em] text-emerald-50/70">
          <span className="truncate">{PHASE_LABEL[state.phase]}</span>
          <span className="h-1 w-1 rounded-full bg-emerald-100/45" />
          <span>hand {state.handNo.toString()}</span>
        </div>
      </div>

      {/* Human/Bot A seat (party A, bottom) */}
      <PlayerSeat
        party="A"
        name={nameA}
        balance={state.balanceA}
        bet={state.totalBetA}
        holes={holesA}
        active={state.toAct === "A"}
        winner={result?.winner === "A"}
        side="bottom"
      />
    </section>
  );
}
