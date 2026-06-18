import { useEffect, useRef, useState, type ReactElement } from "react";
import {
  Coins,
  Dices,
  Grid3x3,
  type LucideIcon,
  MousePointerClick,
  Zap,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** A win/loss/score readout shared by the games. */
function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: string;
}) {
  return (
    <div className="flex flex-col items-center leading-tight">
      <span className={cn("text-lg font-bold tabular-nums", tone)}>
        {value}
      </span>
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

const WIN = "text-success";
const LOSE = "text-destructive";

/* --- Tic Tac Toe vs a small blocking AI --- */
const LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

function winnerOf(board: (string | null)[]): string | null {
  for (const [a, b, c] of LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c])
      return board[a];
  }
  return board.every(Boolean) ? "draw" : null;
}

function aiMove(board: (string | null)[]): number {
  for (const mark of ["O", "X"]) {
    for (const line of LINES) {
      const cells = line.map((i) => board[i]);
      if (
        cells.filter((c) => c === mark).length === 2 &&
        cells.includes(null)
      ) {
        return line[cells.indexOf(null)];
      }
    }
  }
  if (board[4] === null) return 4;
  const open = board.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
  return open[Math.floor(Math.random() * open.length)];
}

function TicTacToe() {
  const empty = (): (string | null)[] => Array(9).fill(null);
  const [board, setBoard] = useState(empty);
  const [score, setScore] = useState({ w: 0, l: 0, d: 0 });
  const result = winnerOf(board);

  const play = (i: number) => {
    if (board[i] || result) return;
    const next = [...board];
    next[i] = "X";
    let res = winnerOf(next);
    if (!res) {
      next[aiMove(next)] = "O";
      res = winnerOf(next);
    }
    setBoard(next);
    if (res === "X") setScore((s) => ({ ...s, w: s.w + 1 }));
    else if (res === "O") setScore((s) => ({ ...s, l: s.l + 1 }));
    else if (res === "draw") setScore((s) => ({ ...s, d: s.d + 1 }));
  };

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="text-center text-xs text-muted-foreground">
        {result === "X"
          ? "You win!"
          : result === "O"
            ? "AI wins"
            : result === "draw"
              ? "Draw"
              : "You are X"}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-3 gap-1.5">
        {board.map((v, i) => (
          <button
            key={i}
            onClick={() => play(i)}
            className="grid min-h-9 place-items-center rounded-md border border-border bg-background text-2xl font-bold transition-colors hover:border-primary"
          >
            <span className={v === "X" ? "text-sky-400" : "text-rose-400"}>
              {v}
            </span>
          </button>
        ))}
      </div>
      <div className="flex items-center justify-between">
        <div className="flex gap-3">
          <Stat label="Win" value={score.w} tone={WIN} />
          <Stat label="Loss" value={score.l} tone={LOSE} />
          <Stat label="Draw" value={score.d} />
        </div>
        <Button size="sm" variant="ghost" onClick={() => setBoard(empty())}>
          New
        </Button>
      </div>
    </div>
  );
}

/* --- Coin flip --- */
function CoinFlip() {
  const [side, setSide] = useState<"H" | "T" | null>(null);
  const [flipping, setFlipping] = useState(false);
  const [score, setScore] = useState({ w: 0, l: 0 });

  const flip = (guess: "H" | "T") => {
    setFlipping(true);
    setTimeout(() => {
      const r: "H" | "T" = Math.random() < 0.5 ? "H" : "T";
      setSide(r);
      setFlipping(false);
      setScore((s) =>
        r === guess ? { ...s, w: s.w + 1 } : { ...s, l: s.l + 1 },
      );
    }, 550);
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
      <div
        className={cn(
          "grid size-16 place-items-center rounded-full text-2xl font-bold text-background",
          "bg-gradient-to-br from-amber-300 to-amber-500 shadow-lg",
          flipping && "animate-spin",
        )}
      >
        {side ?? "$"}
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={flipping}
          onClick={() => flip("H")}
        >
          Heads
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={flipping}
          onClick={() => flip("T")}
        >
          Tails
        </Button>
      </div>
      <div className="flex gap-3">
        <Stat label="Win" value={score.w} tone={WIN} />
        <Stat label="Loss" value={score.l} tone={LOSE} />
      </div>
    </div>
  );
}

/* --- Dice: roll under the target --- */
function DiceGame() {
  const [target] = useState(() => 40 + Math.floor(Math.random() * 20));
  const [roll, setRoll] = useState<number | null>(null);
  const [rolling, setRolling] = useState(false);
  const [score, setScore] = useState({ w: 0, l: 0 });
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(
    () => () => {
      if (ticker.current) clearInterval(ticker.current);
    },
    [],
  );

  const go = () => {
    setRolling(true);
    let ticks = 0;
    ticker.current = setInterval(() => {
      setRoll(Math.random() * 100);
      if (++ticks > 10 && ticker.current) {
        clearInterval(ticker.current);
        const final = Math.round(Math.random() * 10000) / 100;
        setRoll(final);
        setRolling(false);
        setScore((s) =>
          final < target ? { ...s, w: s.w + 1 } : { ...s, l: s.l + 1 },
        );
      }
    }, 45);
  };

  const won = roll != null && roll < target;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <div className="text-xs text-muted-foreground">
        Win if &lt; <b className="text-foreground">{target.toFixed(2)}</b>
      </div>
      <div
        className={cn(
          "text-4xl font-bold tabular-nums",
          roll == null ? "text-muted-foreground" : won ? WIN : LOSE,
        )}
      >
        {roll == null ? "—" : roll.toFixed(2)}
      </div>
      <Button size="sm" disabled={rolling} onClick={go}>
        {rolling ? "Rolling…" : "Roll"}
      </Button>
      <div className="flex gap-3">
        <Stat label="Win" value={score.w} tone={WIN} />
        <Stat label="Loss" value={score.l} tone={LOSE} />
      </div>
    </div>
  );
}

/* --- Reaction test --- */
type ReactionState = "idle" | "wait" | "go" | "done";

function Reaction() {
  const [state, setState] = useState<ReactionState>("idle");
  const [ms, setMs] = useState<number | string | null>(null);
  const [best, setBest] = useState<number | null>(null);
  const start = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const begin = () => {
    setState("wait");
    setMs(null);
    timer.current = setTimeout(
      () => {
        start.current = performance.now();
        setState("go");
      },
      800 + Math.random() * 2000,
    );
  };
  const tap = () => {
    if (state === "wait") {
      if (timer.current) clearTimeout(timer.current);
      setState("idle");
      setMs("Too soon!");
    } else if (state === "go") {
      const d = Math.round(performance.now() - start.current);
      setMs(d);
      setState("done");
      setBest((b) => (b == null ? d : Math.min(b, d)));
    }
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <button
        onClick={state === "idle" || state === "done" ? begin : tap}
        className={cn(
          "h-24 w-full max-w-48 rounded-xl text-sm font-bold transition-colors",
          state === "idle" || state === "done"
            ? "border border-border bg-secondary text-foreground"
            : state === "wait"
              ? "bg-destructive text-white"
              : "bg-primary text-primary-foreground",
        )}
      >
        {state === "idle" && "Click to start"}
        {state === "wait" && "Wait for green…"}
        {state === "go" && "CLICK!"}
        {state === "done" && `${ms} ms`}
      </button>
      <div className="flex gap-3">
        <Stat label="Last" value={typeof ms === "number" ? `${ms}ms` : "—"} />
        <Stat
          label="Best"
          value={best != null ? `${best}ms` : "—"}
          tone={WIN}
        />
      </div>
    </div>
  );
}

/* --- Clicker --- */
function Clicker() {
  const [count, setCount] = useState(0);
  const [perClick, setPerClick] = useState(1);
  const cost = perClick * 25;
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <button
        onClick={() => setCount((c) => c + perClick)}
        aria-label="Bake a cookie"
        className="text-5xl transition-transform active:scale-90"
      >
        🍪
      </button>
      <div className="text-2xl font-bold tabular-nums">
        {count.toLocaleString()}
      </div>
      <Button
        size="sm"
        variant="ghost"
        disabled={count < cost}
        onClick={() => {
          setCount((c) => c - cost);
          setPerClick((m) => m + 1);
        }}
      >
        +1 / click — {cost}
      </Button>
      <div className="text-[11px] text-muted-foreground">
        per click: +{perClick}
      </div>
    </div>
  );
}

export interface GameDef {
  name: string;
  icon: LucideIcon;
  Component: () => ReactElement;
  w: number;
  h: number;
  minW: number;
  minH: number;
}

export type GameKey = "ttt" | "coin" | "dice" | "react" | "clicker";

export const GAMES: Record<GameKey, GameDef> = {
  ttt: {
    name: "Tic Tac Toe",
    icon: Grid3x3,
    Component: TicTacToe,
    w: 4,
    h: 5,
    minW: 3,
    minH: 4,
  },
  coin: {
    name: "Coin Flip",
    icon: Coins,
    Component: CoinFlip,
    w: 3,
    h: 4,
    minW: 3,
    minH: 4,
  },
  dice: {
    name: "Dice",
    icon: Dices,
    Component: DiceGame,
    w: 4,
    h: 4,
    minW: 3,
    minH: 3,
  },
  react: {
    name: "Reaction",
    icon: Zap,
    Component: Reaction,
    w: 4,
    h: 4,
    minW: 3,
    minH: 3,
  },
  clicker: {
    name: "Clicker",
    icon: MousePointerClick,
    Component: Clicker,
    w: 3,
    h: 4,
    minW: 3,
    minH: 4,
  },
};
