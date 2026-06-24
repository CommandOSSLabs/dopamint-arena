import { useCallback, useMemo, useState } from "react";
import { Sparkles } from "lucide-react";
import type { GameWindowProps } from "../types";
import { MachineCard } from "./components/MachineCard";
import { SketchDefs } from "./components/SketchDefs";
import { SKETCH_INK, SKETCH_SURFACE } from "./sketchInk";
import { MAX_CONCURRENT_RUNNING } from "./constants";
import { usePaymentShop } from "./usePaymentShop";
import type { MachinePhase } from "./types";

type Filter = "all" | "running" | "settled";

function phaseFilter(phase: MachinePhase, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "running") {
    return phase === "spawning" || phase === "running" || phase === "settling";
  }
  return phase === "closed";
}

export function PaymentsWindow({ windowId }: GameWindowProps) {
  const [entered, setEntered] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [expandedPayments, setExpandedPayments] = useState<Set<string>>(
    () => new Set(),
  );
  const { machines, spawnMachine, walletConnected } = usePaymentShop(windowId);

  const togglePayments = useCallback((machineId: string) => {
    setExpandedPayments((prev) => {
      const next = new Set(prev);
      if (next.has(machineId)) next.delete(machineId);
      else next.add(machineId);
      return next;
    });
  }, []);

  const visible = useMemo(
    () => machines.filter((s) => phaseFilter(s.phase, filter)),
    [machines, filter],
  );

  const runningCount = machines.filter(
    (s) =>
      s.phase === "running" || s.phase === "spawning" || s.phase === "settling",
  ).length;
  const settledCount = machines.filter((s) => s.phase === "closed").length;
  const canMint =
    walletConnected && runningCount < MAX_CONCURRENT_RUNNING;

  const gridCols =
    visible.length >= 3
      ? "grid-cols-2 @min-[520px]:grid-cols-3"
      : "grid-cols-2";

  if (!entered) {
    return (
      <div
        className={`${SKETCH_SURFACE} grid h-full min-h-56 place-items-center overflow-hidden p-[clamp(12px,4cqmin,28px)] text-center`}
      >
        <SketchDefs />
        <div className="relative isolate max-w-[min(22rem,92%)] rounded-[10px] p-[clamp(14px,4cqmin,26px)]">
          <span
            className={`${SKETCH_INK} -z-10 rounded-[10px]`}
            style={{
              backgroundColor: "#fffefb",
              borderColor: "#23221f",
              borderWidth: 2.5,
            }}
          />
          <span className="text-[clamp(9px,2.4cqmin,14px)] tracking-widest text-[#e8920c]">
            Self-play vending
          </span>
          <div className="mt-1 mb-1 text-[clamp(15px,4.2cqmin,28px)] leading-none">
            Regular Payments
          </div>
          <p className="mb-3 text-[clamp(11px,3cqmin,17px)] leading-snug text-[rgba(35,34,31,0.6)]">
            Open a real tunnel with 0.1 SUI, stream 500 micro-payments at ~80 TPS
            (~6 s), then settle on-chain. NFT mint comes later — for now the shop
            closes the tunnel when the stream finishes.
          </p>
          <button
            className="relative isolate text-[clamp(11px,3cqmin,18px)] leading-none px-[clamp(8px,2.6cqmin,18px)] py-[clamp(4px,1.4cqmin,9px)] transition-transform hover:-translate-y-px hover:-rotate-[0.4deg] active:translate-y-px"
            onClick={() => setEntered(true)}
          >
            <span
              className={`${SKETCH_INK} -z-10 rounded-[9px]`}
              style={{
                backgroundColor: "#ffe9bd",
                borderColor: "#e8920c",
                borderWidth: 2.5,
              }}
            />
            Enter shop
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`${SKETCH_SURFACE} flex h-full min-h-0 w-full min-w-0 flex-col`}
    >
      <SketchDefs />

      <header className="flex items-center justify-between gap-[clamp(6px,2cqmin,14px)] px-[clamp(8px,2.4cqmin,18px)] py-[clamp(5px,1.6cqmin,12px)]">
        <div className="flex gap-1.5">
          {(
            [
              ["all", "All"],
              ["running", `Running (${runningCount})`],
              ["settled", `Settled (${settledCount})`],
            ] as const
          ).map(([key, label]) => {
            const active = filter === key;
            const btnFill = active ? "#eaf8ee" : "#fffefb";
            const btnStroke = active ? "#2f9e44" : "#23221f";
            return (
              <button
                key={key}
                className="relative isolate text-[clamp(10px,2.6cqmin,16px)] leading-none px-[clamp(7px,2.2cqmin,14px)] py-[clamp(3px,1.2cqmin,8px)] transition-transform hover:-translate-y-px hover:-rotate-[0.4deg] active:translate-y-px"
                onClick={() => setFilter(key)}
              >
                <span
                  className={`${SKETCH_INK} -z-10 rounded-[9px]`}
                  style={{
                    backgroundColor: btnFill,
                    borderColor: btnStroke,
                    borderWidth: 2.5,
                  }}
                />
                {label}
              </button>
            );
          })}
        </div>

        <button
          className="relative isolate inline-flex shrink-0 items-center gap-1.5 text-[clamp(11px,3cqmin,18px)] leading-none px-[clamp(8px,2.6cqmin,18px)] py-[clamp(4px,1.4cqmin,9px)] transition-transform hover:-translate-y-px hover:-rotate-[0.4deg] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40"
          onClick={spawnMachine}
          disabled={!canMint}
          title={
            !walletConnected
              ? "Connect wallet"
              : runningCount >= MAX_CONCURRENT_RUNNING
                ? `Max ${MAX_CONCURRENT_RUNNING} running — wait for a mint to settle`
                : "Open tunnel + start stream"
          }
        >
          <span
            className={`${SKETCH_INK} -z-10 rounded-[9px]`}
            style={{
              backgroundColor: "#ffe9bd",
              borderColor: "#e8920c",
              borderWidth: 2.5,
            }}
          />
          <Sparkles className="size-3.5" strokeWidth={2.25} />
          Mint NFT
        </button>
      </header>

      <div
        className={`grid flex-1 content-start gap-[clamp(8px,2.4cqmin,16px)] overflow-y-auto px-[clamp(8px,2.4cqmin,18px)] pb-[clamp(8px,2.4cqmin,16px)] ${gridCols}`}
      >
        {visible.length === 0 ? (
          <p className="col-span-full px-2 py-8 text-center text-[clamp(11px,3cqmin,17px)] leading-snug text-[rgba(35,34,31,0.6)]">
            {machines.length === 0
              ? "Click Mint NFT to open a tunnel and start farming."
              : "No machines in this view."}
          </p>
        ) : (
          visible.map((s) => (
            <MachineCard
              key={s.id}
              session={s}
              paymentsOpen={expandedPayments.has(s.id)}
              onPaymentsToggle={() => togglePayments(s.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}
