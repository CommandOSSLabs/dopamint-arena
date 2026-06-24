import type { JSX } from "react";
import type { PokerPhase, PokerState } from "sui-tunnel-ts/protocol/quantumPoker";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import "./quantumPoker.css";

// ---------------------------------------------------------------------------
// Presentational constants
// ---------------------------------------------------------------------------

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
  "2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A",
];

// Kept for back-compat with windows that still spread it; the sketch skin styles
// everything through the `.qp-*` classes instead, so this is now a no-op object.
export const HEADS_UP_STYLE = {} as const;

// ---------------------------------------------------------------------------
// SketchDefs — the SVG roughen filter. Render ONCE per window; every `.qp-*`
// border (drawn on a ::before) references `url(#qpRough)` to get its hand-drawn
// wobble. Content text is never filtered, so it stays crisp.
// ---------------------------------------------------------------------------

export function SketchDefs(): JSX.Element {
  return (
    <svg aria-hidden width="0" height="0" className="qp-defs">
      <filter id="qpRough" x="-6%" y="-6%" width="112%" height="112%">
        <feTurbulence
          type="fractalNoise"
          baseFrequency="0.018"
          numOctaves={2}
          seed={7}
          result="noise"
        />
        <feDisplacementMap
          in="SourceGraphic"
          in2="noise"
          scale="2.6"
          xChannelSelector="R"
          yChannelSelector="G"
        />
      </filter>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Presentational helpers
// ---------------------------------------------------------------------------

export function cardText(card: number): string {
  return `${RANKS[card % 13]}${SUITS[Math.floor(card / 13)]}`;
}

// Compact chip count: small stacks (PvBot's 2,500) stay exact; the watch-bot's
// billion-unit stakes shrink to 1.2B so a hand-drawn seat isn't a wall of digits.
// Thresholds carry the rounding margin so a value just under a unit reads as the
// next one up (≈999.99M → "1.0B", never "1000.0M"; 999,999 → "1.0M", never "1000K").
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
    return <span className={`qp-card qp-card--back${hole ? " qp-card--hole" : ""}`} />;
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
  seat,
  party,
  name,
  stack,
  bet,
  holes,
  active,
  winner,
}: {
  /** Table position: the viewer ("hero", bottom) or their opponent ("opp", top). */
  seat: "hero" | "opp";
  /** Protocol party (A/B) — drives the corner badge + its colour, independent of position. */
  party: Party;
  name: string;
  stack: bigint;
  bet: bigint;
  holes: number[];
  active: boolean;
  winner: boolean;
}) {
  return (
    <div className={`qp-player qp-player--${seat}`}>
      <section
        className={`qp-seat qp-seat--${seat} qp-stroke${
          active ? " qp-stroke--active" : ""
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
  holesA,
  holesB,
  nameA,
  nameB,
  hero = "A",
}: {
  state: PokerState;
  holesA: number[];
  holesB: number[];
  nameA: string;
  nameB: string;
  /** Which protocol party is the viewer (rendered at the bottom). PvP passes its matched seat (which
   *  may be B); the self-play lanes leave it at "A". */
  hero?: Party;
}): JSX.Element {
  // The protocol keeps `balance` as the FULL stack and tracks live bets in `totalBet` (it never
  // deducts a bet from the balance — `settle` only moves the net at showdown). Rendering raw
  // `balance` + a separate pot double-counts the bet chips, so a split pot looks like both seats
  // "lost" their bets. Show a real table: a seat's live stack = balance − what it pushed into THIS
  // pot; at hand_over the pot has settled into the balances, so show the settled balance and an
  // empty pot (a tie hands both bets back — stacks return to where they began).
  const settled = state.phase === "hand_over" || state.phase === "done";
  const balanceOf = (p: Party) => (p === "A" ? state.balanceA : state.balanceB);
  const totalBetOf = (p: Party) => (p === "A" ? state.totalBetA : state.totalBetB);
  const holesOf = (p: Party) => (p === "A" ? holesA : holesB);
  const nameOf = (p: Party) => (p === "A" ? nameA : nameB);
  const stackOf = (p: Party) =>
    settled ? balanceOf(p) : balanceOf(p) - totalBetOf(p);
  const betOf = (p: Party) => (settled ? 0n : totalBetOf(p));
  const winner = state.lastResult?.winner;
  const opp: Party = hero === "A" ? "B" : "A";
  const pot = settled ? 0n : state.totalBetA + state.totalBetB;

  return (
    <section className="qp-felt">
      {/* Opponent seat (top) — holes stay face-down until showdown */}
      <PlayerSeat
        seat="opp"
        party={opp}
        name={nameOf(opp)}
        stack={stackOf(opp)}
        bet={betOf(opp)}
        holes={holesOf(opp)}
        active={state.toAct === opp}
        winner={winner === opp}
      />

      {/* Community board: pot above, five cards centered */}
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

      {/* Hero seat (bottom) — the viewer */}
      <PlayerSeat
        seat="hero"
        party={hero}
        name={nameOf(hero)}
        stack={stackOf(hero)}
        bet={betOf(hero)}
        holes={holesOf(hero)}
        active={state.toAct === hero}
        winner={winner === hero}
      />
    </section>
  );
}
