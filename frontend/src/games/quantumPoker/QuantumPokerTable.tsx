import type { JSX } from "react";
import type {
  PokerPhase,
  PokerState,
} from "sui-tunnel-ts/protocol/quantumPoker";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import "./quantumPoker.css";

export const PHASE_LABEL: Record<PokerPhase, string> = {
  commit: "Shuffling",
  open_private_holes: "Dealing",
  preflop_bet: "Preflop",
  reveal_flop: "Flop…",
  flop_bet: "Flop",
  reveal_turn: "Turn…",
  turn_bet: "Turn",
  reveal_river: "River…",
  river_bet: "River",
  showdown: "Showdown",
  hand_over: "Hand over",
  done: "Done",
};

export const SUITS = ["♠", "♥", "♦", "♣"] as const;
export const RANKS = [
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

// ---------------------------------------------------------------------------
// Presentational constants
// ---------------------------------------------------------------------------

export function cardText(card: number): string {
  return `${RANKS[card % 13]}${SUITS[Math.floor(card / 13)]}`;
}

// Compact chip count. At 0-decimal MTPS (ADR-0023) stacks are small whole tokens (≤ ~10k), so
// this returns the exact integer; the K/M/B abbreviation is a safety net for large COUNTS (a
// number abbreviation, NOT a decimal conversion). Thresholds carry the rounding margin so a value
// just under a unit reads as the next one up (≈999.99M → "1.0B"; 999,999 → "1.0M", never "1000K").
function fmtChips(n: bigint): string {
  if (n >= 999_950_000n) return `${(Number(n) / 1e9).toFixed(1)}B`;
  if (n >= 999_500n) return `${(Number(n) / 1e6).toFixed(1)}M`;
  if (n >= 100_000n) return `${(Number(n) / 1e3).toFixed(0)}K`;
  return n.toLocaleString("en-US");
}

function Card({
  card,
  hidden,
  hole,
}: {
  card: number | null;
  hidden?: boolean;
  hole?: boolean;
}) {
  if (hidden || card === null) {
    return (
      <span
        className={`qp-card qp-card--back${hole ? " qp-card--hole" : ""}`}
      />
    );
  }
  const suit = SUITS[Math.floor(card / 13)];
  const red = suit === "♥" || suit === "♦";
  return (
    <span
      className={`qp-card${red ? " qp-card--red" : ""}${hole ? " qp-card--hole" : ""}`}
    >
      {RANKS[card % 13]}
      {suit}
    </span>
  );
}

function CardRow({
  cards,
  hidden,
  hole,
  size = 5,
}: {
  cards: number[];
  hidden?: boolean;
  hole?: boolean;
  size?: number;
}) {
  return (
    <div className="qp-cardrow">
      {Array.from({ length: size }, (_, i) => (
        <Card
          key={i}
          card={cards[i] ?? null}
          hidden={hidden || cards[i] === undefined}
          hole={hole}
        />
      ))}
    </div>
  );
}

function PlayerSeat({
  party,
  hero,
  name,
  stack,
  bet,
  holes,
  active,
  winner,
}: {
  party: Party;
  hero: Party;
  name: string;
  stack: bigint;
  bet: bigint;
  holes: number[];
  active: boolean;
  winner: boolean;
}) {
  const role = party === hero ? "hero" : "opp";
  return (
    <div className={`qp-player qp-player--${role}`}>
      <section
        className={`qp-seat qp-seat--${role} sketch-stroke sketch-panel${
          active ? " sketch-stroke--accent" : ""
        }`}
      >
        <div className="qp-seat__who">
          <span className={`qp-seat__id qp-seat__id--${party.toLowerCase()}`}>
            {party}
          </span>
          <div className="min-w-0">
            <div className="qp-seat__name truncate">
              {name}
              {winner && <span className="qp-win">WIN</span>}
            </div>
            <div className="qp-seat__stack tabular-nums">
              <span className="qp-chip" />
              {fmtChips(stack)}
            </div>
          </div>
        </div>
        <CardRow cards={holes} hidden={holes.length === 0} hole size={2} />
      </section>
      {bet > 0n && (
        <div className="qp-bet tabular-nums">
          <span className="qp-chip" />
          {fmtChips(bet)}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// QuantumPokerTable — shared sketchy felt for the Bot and Auto lanes
// ---------------------------------------------------------------------------

export function QuantumPokerTable({
  state,
  hero = "A",
  holesA,
  holesB,
  nameA,
  nameB,
}: {
  state: PokerState;
  /** The viewer's seat — rendered at the bottom; the other party sits on top. */
  hero?: Party;
  holesA: number[];
  holesB: number[];
  nameA: string;
  nameB: string;
}): JSX.Element {
  // The protocol keeps `balance` as the FULL stack and tracks live bets in `totalBet` (it never
  // deducts a bet from the balance — `settle` only moves the net at showdown). Rendering raw
  // `balance` + a separate pot double-counts the bet chips, so a split pot looks like both seats
  // "lost" their bets. Show a real table: a seat's live stack = balance − what it pushed into THIS
  // pot; at hand_over the pot has settled into the balances, so show the settled balance and an
  // empty pot (a tie hands both bets back — stacks return to where they began).
  const settled = state.phase === "hand_over" || state.phase === "done";
  const stackA = settled ? state.balanceA : state.balanceA - state.totalBetA;
  const stackB = settled ? state.balanceB : state.balanceB - state.totalBetB;
  const betA = settled ? 0n : state.totalBetA;
  const betB = settled ? 0n : state.totalBetB;
  const pot = settled ? 0n : state.totalBetA + state.totalBetB;
  const winner = state.lastResult?.winner;

  const opp: Party = hero === "A" ? "B" : "A";
  const seatProps = (p: Party) => ({
    party: p,
    hero,
    name: p === "A" ? nameA : nameB,
    stack: p === "A" ? stackA : stackB,
    bet: p === "A" ? betA : betB,
    holes: p === "A" ? holesA : holesB,
    active: state.toAct === p,
    winner: winner === p,
  });

  return (
    <section className="qp-felt">
      {/* Opponent seat (top — the non-hero party) */}
      <PlayerSeat {...seatProps(opp)} />

      {/* Community board: pot above, five cards centered, phase below */}
      <div className="qp-board">
        {pot > 0n && (
          <div className="qp-board__pot">
            <div className="qp-pot">
              <span className="qp-chip" />
              {fmtChips(pot)}
            </div>
          </div>
        )}
        <CardRow cards={state.board} size={5} />
      </div>

      {/* Hero seat (bottom — the viewer) */}
      <PlayerSeat {...seatProps(hero)} />
    </section>
  );
}
