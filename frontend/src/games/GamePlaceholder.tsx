import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import type { GameWindowProps } from "./types";

/** Per-game mock self-play flavour: result phrases, stake range, win odds. */
interface SelfPlayFlavor {
  win: string[];
  loss: string[];
  min: number;
  max: number;
  winRate: number;
}

const GENERIC: SelfPlayFlavor = {
  win: ["round won"],
  loss: ["round lost"],
  min: 1,
  max: 10,
  winRate: 0.5,
};

const FLAVORS: Record<string, SelfPlayFlavor> = {
  "Coin Flip": {
    win: ["Heads ✓", "Tails ✓"],
    loss: ["Heads ✗", "Tails ✗"],
    min: 1,
    max: 5,
    winRate: 0.5,
  },
  Dice: {
    win: ["roll under ✓"],
    loss: ["roll over ✗"],
    min: 1,
    max: 8,
    winRate: 0.48,
  },
  Blackjack: {
    win: ["21 ✓", "dealer bust", "stand win"],
    loss: ["bust", "dealer 20"],
    min: 2,
    max: 25,
    winRate: 0.47,
  },
  "Tic Tac Toe": {
    win: ["X wins", "fork win"],
    loss: ["O wins", "blocked"],
    min: 1,
    max: 3,
    winRate: 0.5,
  },
  "Quantum Poker": {
    win: ["showdown win", "bluff ✓"],
    loss: ["fold", "beat by flush"],
    min: 5,
    max: 60,
    winRate: 0.46,
  },
  Slots: {
    win: ["3× cherry", "JACKPOT", "2× bar"],
    loss: ["no match"],
    min: 1,
    max: 40,
    winRate: 0.3,
  },
  Chat: {
    win: ["memo relayed", "tip sent"],
    loss: ["retry"],
    min: 0.1,
    max: 2,
    winRate: 0.85,
  },
};

/**
 * Builds a mock self-playing window for a game whose real engine isn't wired
 * yet: a bot "plays" on an interval, streaming recent results and a running
 * P/L so the desktop looks alive in a demo. Swap for a real `Window` component
 * (see microPayments) when the protocol is connected.
 */
export function makePlaceholder(name: string) {
  const flavor = FLAVORS[name] ?? GENERIC;

  return function SelfPlayWindow(_props: GameWindowProps) {
    const [rounds, setRounds] = useState(0);
    const [net, setNet] = useState(0);
    const [log, setLog] = useState<
      { id: number; text: string; amount: number; win: boolean }[]
    >([]);
    const nextId = useRef(0);

    useEffect(() => {
      const period = 850 + Math.random() * 500; // stagger windows
      const id = setInterval(() => {
        const win = Math.random() < flavor.winRate;
        const phrases = win ? flavor.win : flavor.loss;
        const text = phrases[Math.floor(Math.random() * phrases.length)];
        const stake =
          Math.round(
            (flavor.min + Math.random() * (flavor.max - flavor.min)) * 100,
          ) / 100;
        const amount = win ? stake : -stake;
        setRounds((r) => r + 1);
        setNet((p) => Math.round((p + amount) * 100) / 100);
        setLog((l) =>
          [{ id: nextId.current++, text, amount, win }, ...l].slice(0, 7),
        );
      }, period);
      return () => clearInterval(id);
    }, []);

    return (
      <div className="flex h-full flex-col gap-2 p-3">
        <div className="flex items-center justify-between text-[11px] uppercase tracking-wider text-arena-muted">
          <span className="flex items-center gap-1.5">
            <span className="size-1.5 animate-pulse rounded-full bg-arena-accent" />
            self-play
          </span>
          <span className="tabular-nums">{rounds} rounds</span>
        </div>

        <div className="flex items-baseline justify-between">
          <span className="text-[11px] text-arena-muted">Net P/L</span>
          <span
            className={cn(
              "text-lg font-semibold tabular-nums",
              net >= 0 ? "text-success" : "text-destructive",
            )}
          >
            {net >= 0 ? "+" : "-"}${Math.abs(net).toFixed(2)}
          </span>
        </div>

        <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-hidden">
          {log.length === 0 && (
            <li className="text-[11px] text-arena-muted">dealing…</li>
          )}
          {log.map((e) => (
            <li
              key={e.id}
              className="flex items-center justify-between rounded-md border border-arena-edge/60 bg-arena-bg/40 px-2 py-1 text-xs"
            >
              <span className="truncate text-arena-text/80">{e.text}</span>
              <span
                className={cn(
                  "shrink-0 tabular-nums",
                  e.win ? "text-success" : "text-destructive",
                )}
              >
                {e.amount >= 0 ? "+" : "-"}${Math.abs(e.amount).toFixed(2)}
              </span>
            </li>
          ))}
        </ul>
      </div>
    );
  };
}
