import { useCurrentAccount } from "@mysten/dapp-kit";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { toHex } from "sui-tunnel-ts/core/bytes";
import {
  type PokerMove,
  type PokerPhase,
} from "sui-tunnel-ts/protocol/quantumPoker";
import type { Party } from "sui-tunnel-ts/protocol/Protocol";
import type { GameWindowProps } from "../types";
import {
  createLocalQuantumPokerRuntime,
  type LocalQuantumPokerRuntime,
  type QuantumPokerRuntimeSnapshot,
  type QuantumPokerRuntimeStep,
} from "./runtime";
import {
  createServerQuantumPokerRuntime,
  type ServerQuantumPokerRuntime,
  type ServerQuantumPokerRuntimeSnapshot,
} from "./serverRuntime";

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
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];

interface QuantumLogEntry {
  id: number;
  party: Party | "SYS";
  label: string;
}

type RuntimeLike = LocalQuantumPokerRuntime | ServerQuantumPokerRuntime;
type RuntimeSnapshot =
  | QuantumPokerRuntimeSnapshot
  | ServerQuantumPokerRuntimeSnapshot;

const HEADS_UP_STYLE: CSSProperties & Record<`--${string}`, string> = {
  "--qp-felt": "#0f6b52",
  "--qp-felt-dark": "#08372f",
  "--qp-rail": "#14191d",
  "--qp-gold": "#f4c45d",
  "--qp-cyan": "#67e8f9",
};

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

function shortHash(bytes: Uint8Array): string {
  return toHex(bytes).slice(0, 8);
}

function shortDigest(digest: string | null | undefined): string | null {
  if (!digest) return null;
  return digest.length > 12 ? `${digest.slice(0, 6)}...${digest.slice(-4)}` : digest;
}

function isServerRuntime(runtime: RuntimeLike): runtime is ServerQuantumPokerRuntime {
  return "settle" in runtime;
}

function isServerSnapshot(
  snapshot: RuntimeSnapshot,
): snapshot is ServerQuantumPokerRuntimeSnapshot {
  return "mode" in snapshot;
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

export function QuantumPokerWindow(_props: GameWindowProps) {
  const account = useCurrentAccount();
  const runtimeRef = useRef<RuntimeLike>(createLocalQuantumPokerRuntime(1802));
  const logIdRef = useRef(1);
  const settlingRef = useRef(false);
  const [paused, setPaused] = useState(true);
  const [busy, setBusy] = useState(false);
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot>(() =>
    runtimeRef.current.snapshot(),
  );
  const [logs, setLogs] = useState<QuantumLogEntry[]>([
    { id: 0, party: "SYS", label: "local preview ready" },
  ]);

  const state = snapshot.state;
  const nonce = snapshot.nonce;
  const board = state.board;
  const pot = state.totalBetA + state.totalBetB;
  const result = state.lastResult;
  const shownA = state.shownHoleA ?? [];
  const shownB = state.shownHoleB ?? [];
  const liveHoleA = state.shownA ? shownA : (snapshot.userHoles ?? []);
  const liveHoleB = state.shownB ? shownB : [];
  const serverSnapshot = isServerSnapshot(snapshot) ? snapshot : null;
  const terminal = state.phase === "done";
  const stateHash = shortHash(
    snapshot.latest?.update.stateHash ?? snapshot.stateHash,
  );

  function appendLog(entry: Omit<QuantumLogEntry, "id">) {
    setLogs((current) =>
      [{ ...entry, id: logIdRef.current++ }, ...current].slice(0, 7),
    );
  }

  async function settleIfReady() {
    const runtime = runtimeRef.current;
    if (
      !isServerRuntime(runtime) ||
      state.phase !== "done" ||
      settlingRef.current
    ) {
      return false;
    }
    settlingRef.current = true;
    setBusy(true);
    setPaused(true);
    appendLog({ party: "SYS", label: "settling root close" });
    try {
      const closed = await runtime.settle();
      setSnapshot(runtime.snapshot());
      appendLog({
        party: "SYS",
        label: `closed ${shortDigest(closed?.txDigest) ?? "on-chain"}`,
      });
    } catch (error) {
      appendLog({
        party: "SYS",
        label: error instanceof Error ? error.message : String(error),
      });
      setSnapshot(runtime.snapshot());
    } finally {
      setBusy(false);
    }
    return true;
  }

  async function step() {
    if (busy) return;
    if (state.phase === "done") {
      const settled = await settleIfReady();
      if (!settled) {
        setPaused(true);
        appendLog({ party: "SYS", label: "settlement ready" });
      }
      return;
    }
    setBusy(true);
    try {
      const result = (await runtimeRef.current.step()) as
        | QuantumPokerRuntimeStep
        | null;
      if (result) {
        setSnapshot(runtimeRef.current.snapshot());
        appendLog({
          party: result.by,
          label: `${moveLabel(result.move)} · n${result.nonce.toString()}`,
        });
        return;
      }
      appendLog({ party: "SYS", label: "waiting for legal move" });
    } catch (error) {
      setPaused(true);
      appendLog({
        party: "SYS",
        label: error instanceof Error ? error.message : String(error),
      });
      setSnapshot(runtimeRef.current.snapshot());
    } finally {
      setBusy(false);
    }
  }

  async function openServerTunnel() {
    if (busy) return;
    if (!account) {
      appendLog({ party: "SYS", label: "connect wallet first" });
      return;
    }
    setBusy(true);
    setPaused(true);
    appendLog({ party: "SYS", label: "opening BUCK tunnel" });
    try {
      const runtime = await createServerQuantumPokerRuntime(account.address);
      runtimeRef.current = runtime;
      const nextSnapshot = runtime.snapshot();
      setSnapshot(nextSnapshot);
      appendLog({
        party: "SYS",
        label: `opened ${shortDigest(nextSnapshot.openTxDigest) ?? "tunnel"}`,
      });
      setPaused(false);
      settlingRef.current = false;
    } catch (error) {
      appendLog({
        party: "SYS",
        label: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    runtimeRef.current = createLocalQuantumPokerRuntime(
      1802 + logIdRef.current,
    );
    setSnapshot(runtimeRef.current.snapshot());
    settlingRef.current = false;
    setLogs([
      {
        id: logIdRef.current++,
        party: "SYS",
        label: "local preview reset",
      },
    ]);
    setPaused(true);
  }

  useEffect(() => {
    if (paused || busy) return;
    const timer = window.setTimeout(() => {
      void step();
    }, isServerSnapshot(snapshot) ? 650 : 900);
    return () => window.clearTimeout(timer);
  }, [busy, paused, snapshot, state]);

  const resultLabel =
    result?.winner === "tie"
      ? "CHOP"
      : result?.winner
        ? `${result.winner} WINS`
        : PHASE_LABEL[state.phase].toUpperCase();
  const tunnelStatus = serverSnapshot
    ? serverSnapshot.status
    : terminal
      ? "close ready"
      : snapshot.latest
        ? "signed"
        : "preview";

  return (
    <div
      style={HEADS_UP_STYLE}
      className="flex h-full min-h-[14rem] flex-col overflow-hidden bg-[#080b0d] text-slate-100"
    >
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-white/10 bg-[var(--qp-rail)] px-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="grid h-4 w-7 place-items-center rounded-sm bg-[var(--qp-gold)] text-[9px] font-black text-slate-950">
            HU
          </span>
          <span className="truncate text-[11px] font-semibold">
            {resultLabel}
          </span>
          <span className="rounded-sm border border-white/10 px-1.5 py-0.5 text-[9px] tabular-nums text-slate-400">
            n{nonce.toString()}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void openServerTunnel()}
            disabled={busy || !!serverSnapshot}
            className="h-5 rounded-sm border border-amber-200/30 px-2 text-[10px] text-amber-100 hover:border-amber-200/70 disabled:opacity-35"
          >
            {busy && !serverSnapshot ? "..." : "Open"}
          </button>
          <button
            type="button"
            onClick={() => setPaused((value) => !value)}
            disabled={busy}
            className="h-5 rounded-sm border border-white/10 px-2 text-[10px] text-slate-200 hover:border-cyan-300/50 disabled:opacity-35"
          >
            {paused ? "Run" : "Pause"}
          </button>
          <button
            type="button"
            onClick={() => void step()}
            disabled={!paused || busy}
            className="h-5 rounded-sm border border-white/10 px-2 text-[10px] text-slate-200 disabled:opacity-35"
          >
            Step
          </button>
          <button
            type="button"
            onClick={reset}
            disabled={busy}
            className="h-5 rounded-sm border border-white/10 px-2 text-[10px] text-slate-200 hover:border-rose-300/50"
          >
            Reset
          </button>
        </div>
      </div>

      <main className="flex min-h-0 flex-1 flex-col gap-2 p-2">
        <section className="relative flex min-h-0 flex-1 flex-col justify-between gap-2 rounded-lg border border-emerald-200/20 bg-[linear-gradient(145deg,rgba(255,255,255,.06),transparent_28%),radial-gradient(ellipse_at_center,var(--qp-felt)_0%,var(--qp-felt-dark)_68%,#031615_100%)] p-2 shadow-[inset_0_0_0_5px_rgba(0,0,0,.2)]">
          <PlayerSeat
            party="B"
            name={snapshot.seatB.name}
            persona={snapshot.seatB.persona}
            balance={state.balanceB}
            bet={state.totalBetB}
            holes={liveHoleB}
            active={state.toAct === "B"}
            winner={result?.winner === "B"}
            side="top"
          />

          <div className="relative grid min-h-[5.8rem] place-items-center rounded-[999px] border border-amber-100/20 bg-black/15 px-2 py-2">
            <div className="absolute top-1 flex items-center gap-1 rounded-full border border-amber-100/25 bg-black/35 px-2 py-0.5 text-[10px] font-semibold tabular-nums text-amber-100">
              <span className="h-2 w-2 rounded-full bg-[var(--qp-gold)]" />
              <span>{pot.toString()}</span>
            </div>
            <CardRow cards={board} size={5} />
            <div className="absolute bottom-1 flex max-w-[92%] items-center gap-2 overflow-hidden text-[9px] uppercase tracking-[0.08em] text-emerald-50/70">
              <span className="truncate">{PHASE_LABEL[state.phase]}</span>
              <span className="h-1 w-1 rounded-full bg-emerald-100/45" />
              <span>hand {state.handNo.toString()}</span>
            </div>
          </div>

          <PlayerSeat
            party="A"
            name={snapshot.seatA.name}
            persona={snapshot.seatA.persona}
            balance={state.balanceA}
            bet={state.totalBetA}
            holes={liveHoleA}
            active={state.toAct === "A"}
            winner={result?.winner === "A"}
            side="bottom"
          />
        </section>

        <section className="grid h-[3.25rem] shrink-0 grid-cols-[1fr_auto] gap-2 rounded-md border border-white/10 bg-[var(--qp-rail)] px-2 py-1.5">
          <div className="min-w-0 space-y-0.5">
            {logs.slice(0, 2).map((entry) => (
              <div
                key={entry.id}
                className="truncate text-[10px] leading-tight"
              >
                <span
                  className={[
                    "mr-1 font-semibold",
                    entry.party === "A"
                      ? "text-emerald-300"
                      : entry.party === "B"
                        ? "text-cyan-300"
                        : "text-slate-500",
                  ].join(" ")}
                >
                  {entry.party}
                </span>
                <span className="text-slate-300">{entry.label}</span>
              </div>
            ))}
          </div>
          <div className="flex w-[5.2rem] flex-col items-end justify-center border-l border-white/10 pl-2 text-right">
            <div className="text-[9px] uppercase text-slate-500">
              {busy ? "busy" : tunnelStatus}
            </div>
            <div className="max-w-full truncate text-[10px] font-medium tabular-nums text-[var(--qp-cyan)]">
              {serverSnapshot?.transcriptRoot
                ? `r:${shortDigest(serverSnapshot.transcriptRoot)}`
                : serverSnapshot?.openTxDigest
                  ? `tx:${shortDigest(serverSnapshot.openTxDigest)}`
                  : `h:${stateHash}`}
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}
