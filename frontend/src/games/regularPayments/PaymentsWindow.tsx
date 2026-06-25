import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Repeat, Sparkles } from "lucide-react";
import type { GameWindowProps } from "../types";
import { MachineCard } from "./components/MachineCard";
import { SketchDefs } from "./components/SketchDefs";
import { SKETCH_INK, SKETCH_SURFACE } from "./sketchInk";
import {
  AUTO_MINT_INTERVAL_MS,
  MINT_COOLDOWN_MS,
  MAX_CONCURRENT_RUNNING,
} from "./constants";
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
  const [autoMintEnabled, setAutoMintEnabled] = useState(true);
  const [mintClickLocked, setMintClickLocked] = useState(false);

  const mintClickLockedRef = useRef(false);
  const mintCooldownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const { machines, spawnMachine, walletConnected } = usePaymentShop(windowId);

  useEffect(
    () => () => {
      if (mintCooldownTimerRef.current) {
        clearTimeout(mintCooldownTimerRef.current);
      }
    },
    [],
  );

  const withMintClickCooldown = useCallback((action: () => void) => {
    if (mintClickLockedRef.current) return;
    mintClickLockedRef.current = true;
    setMintClickLocked(true);
    action();
    if (mintCooldownTimerRef.current) {
      clearTimeout(mintCooldownTimerRef.current);
    }
    mintCooldownTimerRef.current = setTimeout(() => {
      mintClickLockedRef.current = false;
      setMintClickLocked(false);
      mintCooldownTimerRef.current = null;
    }, MINT_COOLDOWN_MS);
  }, []);

  useEffect(() => {
    if (!entered || !autoMintEnabled) return;
    const id = setInterval(() => spawnMachine(), AUTO_MINT_INTERVAL_MS);
    return () => clearInterval(id);
  }, [entered, autoMintEnabled, spawnMachine]);

  const handleMintNft = useCallback(() => {
    if (autoMintEnabled) setAutoMintEnabled(false);
    spawnMachine();
  }, [autoMintEnabled, spawnMachine]);

  const handleAutoMintToggle = useCallback(() => {
    setAutoMintEnabled((on) => !on);
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
  const canMint = walletConnected && runningCount < MAX_CONCURRENT_RUNNING;

  const gridCols =
    visible.length >= 3
      ? "grid-cols-2 @min-[640px]:grid-cols-3"
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
            Deposit 10 MTPS, stream 500 co-signed payments over 5 s, settle
            on-chain, then mint a random NFT reward to your wallet.
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

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            className="relative isolate inline-flex items-center gap-1.5 text-[clamp(11px,3cqmin,18px)] leading-none px-[clamp(8px,2.6cqmin,18px)] py-[clamp(4px,1.4cqmin,9px)] transition-transform hover:-translate-y-px hover:-rotate-[0.4deg] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => withMintClickCooldown(handleAutoMintToggle)}
            disabled={!walletConnected}
            title={
              !walletConnected
                ? "Connect wallet"
                : autoMintEnabled
                  ? "Stop auto-minting every 2s"
                  : "Mint one NFT every 2s until stopped"
            }
          >
            <span
              className={`${SKETCH_INK} -z-10 rounded-[9px]`}
              style={{
                backgroundColor: autoMintEnabled ? "#eaf8ee" : "#fffefb",
                borderColor: autoMintEnabled ? "#2f9e44" : "#23221f",
                borderWidth: 2.5,
              }}
            />
            <Repeat className="size-3.5" strokeWidth={2.25} />
            Auto mode
          </button>

          <button
            className="relative isolate inline-flex items-center gap-1.5 text-[clamp(11px,3cqmin,18px)] leading-none px-[clamp(8px,2.6cqmin,18px)] py-[clamp(4px,1.4cqmin,9px)] transition-transform hover:-translate-y-px hover:-rotate-[0.4deg] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => withMintClickCooldown(handleMintNft)}
            disabled={!canMint || mintClickLocked}
            title={
              !walletConnected
                ? "Connect wallet"
                : runningCount >= MAX_CONCURRENT_RUNNING
                  ? `Max ${MAX_CONCURRENT_RUNNING} running — wait for a mint to settle`
                  : autoMintEnabled
                    ? "Manual mint — turns off Auto Mint"
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
        </div>
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
          visible.map((s) => <MachineCard key={s.id} session={s} />)
        )}
      </div>
    </div>
  );
}
