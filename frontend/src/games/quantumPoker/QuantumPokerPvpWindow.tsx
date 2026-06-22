import type { CSSProperties } from "react";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import type { PokerState } from "sui-tunnel-ts/protocol/quantumPoker";
import type { GameWindowProps } from "../types";
import {
  HAND_CAP,
  STAKE_BALANCE,
  usePvpQuantumPoker,
} from "./usePvpQuantumPoker";
import { pokerRaiseSizes } from "./pokerBetting";

const SUITS = ["♠", "♥", "♦", "♣"] as const;
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];

const PHASE_LABEL: Record<PokerState["phase"], string> = {
  commit: "Shuffling",
  open_private_holes: "Dealing holes",
  preflop_bet: "Preflop",
  reveal_flop: "Dealing flop",
  flop_bet: "Flop",
  reveal_turn: "Dealing turn",
  turn_bet: "Turn",
  reveal_river: "Dealing river",
  river_bet: "River",
  showdown: "Showdown",
  hand_over: "Hand over",
  done: "Settled",
};

/**
 * Quantum Poker is its own always-dark table, but skinned in the app's violet/aurora identity
 * (not casino green): the board is a faint "quantum field", the pot is a Doto LED readout, and a
 * face-down card is a violet "superposed" tile — the dealerless two-party commit-reveal — that
 * resolves to a face the moment both seats open it. Sizing is kept tight so the whole table fits
 * the smallest (≈400×400) window without clipping.
 */
const QP: CSSProperties & Record<`--${string}`, string> = {
  "--qp-ink": "#0a0c16",
  "--qp-violet": "#613dff",
  "--qp-lilac": "#cab1ff",
  "--qp-gold": "#fbbf24",
  "--qp-mint": "#9cefcf",
  "--qp-coral": "#fb7185",
};

/** Mono uppercase label used for eyebrows/state — the utility face, never the headline. */
const EYEBROW = "wal-mono uppercase tracking-[0.14em]";
const BTN =
  "min-w-[3.25rem] max-w-[8rem] flex-1 whitespace-nowrap rounded-md px-2 py-1 text-[11px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--qp-lilac)]/60";

const fmt = (n: bigint): string => n.toLocaleString("en-US");

function cardText(card: number): string {
  return `${RANKS[card % 13]}${SUITS[Math.floor(card / 13)]}`;
}

function Card({ card, small }: { card: number | null; small?: boolean }) {
  const dims = small ? "h-8 w-6 text-[10px]" : "h-9 w-7 text-[11px]";
  if (card === null) {
    // Superposed: the card is committed cryptographically but hasn't collapsed to a face yet.
    return (
      <span
        className={[
          dims,
          "grid shrink-0 place-items-center rounded border border-[var(--qp-lilac)]/25",
          "bg-[repeating-linear-gradient(125deg,rgba(202,177,255,.15)_0_3px,rgba(13,15,24,.94)_3px_8px)]",
          "text-[var(--qp-lilac)]/35 shadow-[inset_0_0_9px_rgba(97,61,255,.3)]",
        ].join(" ")}
      >
        ◇
      </span>
    );
  }
  const suit = SUITS[Math.floor(card / 13)];
  const red = suit === "♥" || suit === "♦";
  return (
    <span
      className={[
        dims,
        "grid shrink-0 place-items-center rounded border bg-[#f6f3ec] font-bold tabular-nums",
        "shadow-[0_2px_7px_rgba(0,0,0,.45)]",
        "motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-90 motion-safe:duration-300",
        red
          ? "border-[var(--qp-coral)]/40 text-[#c4314e]"
          : "border-black/15 text-[#16181f]",
      ].join(" ")}
    >
      {cardText(card)}
    </span>
  );
}

function CardRow({
  cards,
  size,
  small,
}: {
  cards: (number | null)[];
  size: number;
  small?: boolean;
}) {
  return (
    <div className="flex items-center justify-center gap-1">
      {Array.from({ length: size }, (_, i) => {
        const c = cards[i] ?? null;
        // Key by slot+value so a card animates in only when that slot newly resolves (back → face).
        return <Card key={`${i}-${c ?? "x"}`} card={c} small={small} />;
      })}
    </div>
  );
}

function Seat({
  label,
  stack,
  streetBet,
  active,
  cards,
  won,
  you,
}: {
  label: string;
  stack: bigint;
  streetBet: bigint;
  active: boolean;
  cards: (number | null)[];
  won: boolean;
  you?: boolean;
}) {
  return (
    <div
      className={[
        "flex shrink-0 items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 transition-colors",
        active
          ? "border-[var(--qp-lilac)]/55 bg-[var(--qp-violet)]/12 shadow-[0_0_18px_-8px_var(--qp-violet)]"
          : won
            ? "border-[var(--qp-mint)]/45 bg-[var(--qp-mint)]/[.07]"
            : you
              ? "border-[var(--qp-violet)]/30 bg-white/[.03]"
              : "border-white/10 bg-white/[.03]",
      ].join(" ")}
    >
      <div className="min-w-0 leading-tight">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-100">
          <span className="truncate">{label}</span>
          {active && (
            <span
              className={`${EYEBROW} shrink-0 text-[9px] text-[var(--qp-lilac)] motion-safe:animate-pulse`}
            >
              to act
            </span>
          )}
          {won && (
            <span className="shrink-0 rounded-sm bg-[var(--qp-mint)] px-1 text-[9px] font-bold uppercase tracking-wide text-[#06281c]">
              win
            </span>
          )}
        </div>
        <div className="mt-0.5 flex items-baseline gap-1 wal-mono text-[10px]">
          <span className="text-[var(--qp-gold)]">{fmt(stack)}</span>
          <span className="text-[8px] uppercase tracking-wide text-slate-500">
            stack
          </span>
          {streetBet > 0n && (
            <span className="rounded-sm bg-black/45 px-1 text-[9px] text-slate-300">
              bet {fmt(streetBet)}
            </span>
          )}
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
      <div
        style={QP}
        className="flex h-full flex-col items-center justify-center gap-3 bg-[var(--qp-ink)] p-5 text-center"
      >
        <div className="flex flex-col items-center gap-1">
          <span className={`${EYEBROW} text-[10px] text-[var(--qp-lilac)]`}>
            heads-up · no dealer
          </span>
          <h2 className="wal-doto text-lg text-slate-50">QUANTUM POKER</h2>
        </div>
        <p className="max-w-[18rem] text-[12px] leading-relaxed text-slate-400">
          Each seat stakes{" "}
          <span className="wal-mono text-[var(--qp-gold)]">
            {fmt(STAKE_BALANCE)}
          </span>{" "}
          on-chain. The deck is dealt by a two-party commit-reveal — no dealer —
          and chips move off-chain over a Sui tunnel for up to{" "}
          <span className="wal-mono text-slate-200">{HAND_CAP.toString()}</span>{" "}
          hands, paid out at cooperative close.
        </p>
        <button
          type="button"
          onClick={g.findMatch}
          className="rounded-lg bg-[var(--qp-violet)] px-5 py-2 text-sm font-semibold text-white shadow-[0_0_24px_-6px_var(--qp-violet)] transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--qp-lilac)]/60"
        >
          Find match
        </button>
      </div>
    );
  }

  if (g.status === "matching" || g.status === "funding") {
    return (
      <div
        style={QP}
        className="flex h-full flex-col items-center justify-center gap-3 bg-[var(--qp-ink)] text-center"
      >
        <div className="flex gap-1.5">
          {[
            "[animation-delay:0ms]",
            "[animation-delay:160ms]",
            "[animation-delay:320ms]",
          ].map((delay, i) => (
            <span
              key={i}
              className={`h-2 w-2 rounded-full bg-[var(--qp-lilac)] motion-safe:animate-pulse ${delay}`}
            />
          ))}
        </div>
        <div className="text-sm text-slate-300">
          {g.status === "matching"
            ? "Finding an opponent…"
            : "Opening + funding the tunnel on-chain…"}
        </div>
        {g.opponentWallet && (
          <div className="wal-mono text-[11px] text-slate-500">
            vs {g.opponentWallet.slice(0, 10)}…
          </div>
        )}
      </div>
    );
  }

  if (g.status === "error") {
    return (
      <div
        style={QP}
        className="flex h-full flex-col items-center justify-center gap-3 bg-[var(--qp-ink)] p-5 text-center"
      >
        <p className="max-w-[18rem] text-sm text-[var(--qp-coral)]">
          {g.error}
        </p>
        <button
          type="button"
          onClick={g.reset}
          className="rounded-lg border border-white/15 px-4 py-1.5 text-sm text-slate-200 transition hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--qp-lilac)]/60"
        >
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
        ? `You win${s.lastResult?.reason === "fold" ? " — opponent folded" : ""}`
        : lost
          ? `You lose${s.lastResult?.reason === "fold" ? " — you folded" : ""}`
          : "Hand over"
    : g.myTurnToBet
      ? "Your turn"
      : `${PHASE_LABEL[s.phase]} · opponent's turn`;

  const legal = g.legal;
  // Pot-relative bet sizing. The protocol's `bet` amount is the increment to THIS seat's
  // street bet; a pot-sized raise = call + pot-after-call = pot + 2·diff (diff = amount to
  // call, 0 when first to act). Each size clamps to a legal min-raise and the stack (all-in).
  // Same three pot-relative sizes as the Bot lane (shared helper): ½ pot, pot, all-in.
  const sizes = pokerRaiseSizes({
    pot,
    callAmount: legal?.callAmount ?? 0n,
    minBet: legal?.minBet ?? 0n,
    maxBet: legal?.maxBet ?? 0n,
    canBet: !!legal?.canBet,
  });
  const halfPot = sizes.half;
  const fullPot = sizes.full;
  const allIn = sizes.allIn;
  const showHalf = sizes.showHalf;
  const showPot = sizes.showFull;
  const showAllIn = sizes.showAllIn;

  return (
    <div
      style={QP}
      className="flex h-full min-h-0 flex-col gap-1.5 overflow-hidden bg-[var(--qp-ink)] p-2 text-slate-100"
    >
      <div className="flex shrink-0 items-center justify-between text-[10px]">
        <span className="text-slate-400">
          You are{" "}
          <span className="font-semibold text-[var(--qp-lilac)]">{self}</span>
          {g.status === "settling" && (
            <span className="text-[var(--qp-gold)]"> · settling…</span>
          )}
          {g.status === "settled" && (
            <span className="text-[var(--qp-mint)]"> · settled ✓</span>
          )}
        </span>
        <div className="flex items-center gap-2">
          <span className={`${EYEBROW} text-[9px] text-slate-500`}>
            hand{" "}
            <span className="text-slate-300">{(s.handNo + 1n).toString()}</span>
            /{HAND_CAP.toString()}
          </span>
          {g.status === "playing" &&
            !terminal &&
            (g.endRequested ? (
              <span
                className={`${EYEBROW} whitespace-nowrap text-[9px] text-[var(--qp-gold)]`}
              >
                ends after this hand
              </span>
            ) : (
              <button
                type="button"
                onClick={g.requestSettle}
                title="End the match after this hand and settle on-chain at the current stacks"
                className="rounded border border-[var(--qp-gold)]/40 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-[var(--qp-gold)] transition hover:bg-[var(--qp-gold)]/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--qp-lilac)]/60"
              >
                settle
              </button>
            ))}
        </div>
      </div>

      {/* Opponent (top) — holes stay superposed until showdown */}
      <Seat
        label={`Opponent (${opp})`}
        stack={oppStack}
        streetBet={oppStreet}
        active={!terminal && s.toAct === opp}
        cards={oppCards}
        won={lost}
      />

      {/* The quantum field: board + pot. Flex-1 + min-h-0 so it absorbs/yields spare height. */}
      <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 overflow-hidden rounded-xl border border-[var(--qp-violet)]/20 bg-[radial-gradient(ellipse_at_center,rgba(97,61,255,.18)_0%,rgba(20,16,45,.55)_46%,var(--qp-ink)_100%)] p-2">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-[var(--qp-lilac)]/40 to-transparent"
        />
        <div className="flex flex-col items-center gap-0.5">
          <span className={`${EYEBROW} text-[8px] text-[var(--qp-gold)]/70`}>
            pot
          </span>
          <span className="wal-doto text-lg leading-none text-[var(--qp-gold)] [text-shadow:0_0_12px_rgba(251,191,36,.45)]">
            {fmt(pot)}
          </span>
        </div>
        <CardRow cards={s.board} size={5} />
        <span className={`${EYEBROW} text-[9px] text-[var(--qp-lilac)]/80`}>
          {PHASE_LABEL[s.phase]}
        </span>
      </div>

      {/* You (bottom) — your hole cards, always face-up */}
      <Seat
        label={`You (${self})`}
        stack={myStack}
        streetBet={myStreet}
        active={!terminal && s.toAct === self}
        cards={myCards}
        won={won}
        you
      />

      {/* Action bar — pinned, always visible so the hand can advance */}
      <div className="flex min-h-[2.25rem] shrink-0 flex-wrap items-center justify-center gap-1">
        {g.myTurnToBet && legal ? (
          <>
            {g.secondsLeft != null && (
              <span
                className={[
                  "wal-mono min-w-[2rem] rounded-md px-1.5 py-1 text-center text-[11px] font-semibold tabular-nums",
                  g.secondsLeft <= 3
                    ? "bg-[var(--qp-coral)]/20 text-[var(--qp-coral)] motion-safe:animate-pulse"
                    : "bg-white/5 text-[var(--qp-gold)]",
                ].join(" ")}
              >
                {g.secondsLeft}s
              </span>
            )}
            <button
              type="button"
              onClick={g.fold}
              className={`${BTN} border border-[var(--qp-coral)]/40 bg-[var(--qp-coral)]/15 text-[var(--qp-coral)] hover:bg-[var(--qp-coral)]/25`}
            >
              Fold
            </button>
            {legal.canCheck && (
              <button
                type="button"
                onClick={g.check}
                className={`${BTN} border border-white/12 bg-white/[.06] text-slate-100 hover:bg-white/[.12]`}
              >
                Check
              </button>
            )}
            {legal.canCall && (
              <button
                type="button"
                onClick={g.call}
                className={`${BTN} border border-white/12 bg-white/[.06] text-slate-100 hover:bg-white/[.12]`}
              >
                Call {fmt(legal.callAmount)}
              </button>
            )}
            {showHalf && (
              <button
                type="button"
                onClick={() => g.bet(halfPot)}
                className={`${BTN} bg-[var(--qp-violet)]/80 text-white hover:bg-[var(--qp-violet)]`}
              >
                ½ Pot · {fmt(halfPot)}
              </button>
            )}
            {showPot && (
              <button
                type="button"
                onClick={() => g.bet(fullPot)}
                className={`${BTN} bg-[var(--qp-violet)] text-white hover:brightness-110`}
              >
                Pot · {fmt(fullPot)}
              </button>
            )}
            {showAllIn && (
              <button
                type="button"
                onClick={() => g.bet(allIn)}
                className={`${BTN} bg-[var(--qp-gold)] text-[#231a02] hover:brightness-105`}
              >
                All-in · {fmt(allIn)}
              </button>
            )}
          </>
        ) : (
          <div
            className={[
              "text-center text-[12px] font-semibold",
              terminal
                ? won
                  ? "text-[var(--qp-mint)]"
                  : lost
                    ? "text-[var(--qp-coral)]"
                    : "text-slate-200"
                : "text-slate-300",
            ].join(" ")}
          >
            {banner}
          </div>
        )}
        {g.status === "settled" && (
          <button
            type="button"
            onClick={g.reset}
            className="rounded-md border border-white/15 px-2.5 py-1 text-[11px] text-slate-200 transition hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--qp-lilac)]/60"
          >
            Play again
          </button>
        )}
      </div>
    </div>
  );
}
