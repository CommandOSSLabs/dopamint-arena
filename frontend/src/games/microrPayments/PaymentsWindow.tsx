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

  // Animation + transition tracking
  const [newestId, setNewestId] = useState<string | null>(null);
  const [isPushing, setIsPushing] = useState(false);
  const [newSettledId, setNewSettledId] = useState<string | null>(null);
  const [settledPushing, setSettledPushing] = useState(false);
  const [lingerUntil, setLingerUntil] = useState<Record<string, number>>({});
  const [exiting, setExiting] = useState<Record<string, boolean>>({});
  const prevIdsRef = useRef<string[]>([]);
  const prevPhasesRef = useRef<Record<string, MachinePhase>>({});
  const prevSettledVisibleRef = useRef<string[]>([]);

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

  // Track new cards (for enter slide) + domino push on siblings
  useEffect(() => {
    const currIds = machines.map((m) => m.id);
    const prev = prevIdsRef.current;

    const added = currIds.filter((id) => !prev.includes(id));
    if (added.length > 0) {
      const freshId = added[0];
      setNewestId(freshId);
      setIsPushing(true);

      const PUSH_MS = 820;
      const NEW_MARKER_MS = 1100;
      setTimeout(() => setIsPushing(false), PUSH_MS);
      setTimeout(() => setNewestId(null), NEW_MARKER_MS);
    }

    prevIdsRef.current = currIds;
  }, [machines]);

  // When a card finishes (running/settling -> closed), keep it visible ~2.5s showing NFT, then exit
  useEffect(() => {
    const prevPhases = prevPhasesRef.current;
    const LINGER_MS = 3200;

    machines.forEach((m) => {
      const old = prevPhases[m.id];
      if (old && old !== "closed" && m.phase === "closed") {
        const until = Date.now() + LINGER_MS;
        setLingerUntil((u) => ({ ...u, [m.id]: until }));

        // Trigger settle-in animation if the user is currently viewing settled or all
        if (filter === "settled" || filter === "all") {
          setNewSettledId(m.id);
          setSettledPushing(true);
          setTimeout(() => setSettledPushing(false), 820);
          setTimeout(() => setNewSettledId(null), 1100);
        }

        // After linger, trigger exit anim then drop
        setTimeout(() => {
          setExiting((e) => ({ ...e, [m.id]: true }));
          setTimeout(() => {
            setExiting((e) => {
              const next = { ...e };
              delete next[m.id];
              return next;
            });
            setLingerUntil((u) => {
              const next = { ...u };
              delete next[m.id];
              return next;
            });
          }, 300);
        }, LINGER_MS);
      }
    });

    prevPhasesRef.current = Object.fromEntries(
      machines.map((m) => [m.id, m.phase]),
    );
  }, [machines, filter]);

  // Auto-enter shop when wallet connects (default behaviour).
  // Manual "Back" will set entered=false without being immediately overridden.
  useEffect(() => {
    if (walletConnected && !entered) {
      const timerEnter = setTimeout(() => {
        setEntered(true);

        clearTimeout(timerEnter);
      }, 500);

      return () => {
        clearTimeout(timerEnter);
      };
    }
  }, [walletConnected]);

  // Reset animation flags on tab change so existing cards in the new view don't animate.
  useEffect(() => {
    setNewestId(null);
    setIsPushing(false);
    setNewSettledId(null);
    setSettledPushing(false);
    prevSettledVisibleRef.current = [];
  }, [filter]);

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

  const visible = useMemo(() => {
    const base = machines.filter((s) => phaseFilter(s.phase, filter));

    if (filter !== "running") return base;

    const now = Date.now();
    // Include just-closed cards for the linger window so user sees the NFT before they vanish
    const lingering = machines.filter((s) => {
      if (s.phase !== "closed") return false;
      const until = lingerUntil[s.id];
      const isExitingNow = !!exiting[s.id];
      if (isExitingNow) return true; // keep in DOM for exit animation
      return until != null && now < until;
    });

    const merged: typeof base = [];
    for (const l of lingering) {
      if (!base.some((b) => b.id === l.id)) merged.push(l);
    }
    // Append the just-settled linger cards so active cards keep their positions
    return [...base, ...merged];
  }, [machines, filter, lingerUntil, exiting]);

  const runningCount = machines.filter(
    (s) =>
      s.phase === "running" || s.phase === "spawning" || s.phase === "settling",
  ).length;

  const settledCount = machines.filter((s) => s.phase === "closed").length;

  const canMint =
    walletConnected &&
    machines.filter((s) => s.phase === "running" || s.phase === "spawning")
      .length < MAX_CONCURRENT_RUNNING;

  if (!entered) {
    return (
      <div
        className={`${SKETCH_SURFACE} grid h-full min-h-56 place-items-center overflow-hidden p-[clamp(12px,4cqmin,28px)] text-center`}
      >
        <SketchDefs />

        <div className="flex flex-col justify-center items-center gap-6">
          <div className="relative isolate max-w-[min(22rem,92%)] rounded-[10px] p-[clamp(14px,4cqmin,26px)]">
            <span
              className={`${SKETCH_INK} -z-10 rounded-[10px] bg-[#fffefb] border-[#23221f] border-[2.5px]`}
            />
            <span className="text-[clamp(9px,2.4cqmin,14px)] tracking-widest text-[#e8920c]">
              Self-play vending
            </span>
            <div className="mt-1 mb-1 text-[clamp(15px,4.2cqmin,28px)] leading-none">
              Micro Payments
            </div>
            <p className="mb-3 text-[clamp(11px,3cqmin,17px)] leading-snug text-[rgba(35,34,31,0.6)]">
              Deposit 10 MTPS, stream 500 co-signed payments over 5 s, settle
              on-chain, then mint a random NFT reward to your wallet.
            </p>
            <button
              className="relative isolate text-[clamp(11px,3cqmin,18px)] leading-none px-[clamp(8px,2.6cqmin,18px)] py-[clamp(4px,1.4cqmin,9px)] transition-transform hover:-translate-y-px hover:-rotate-[0.4deg] active:translate-y-px disabled:opacity-45"
              disabled={!walletConnected}
              onClick={() => setEntered(true)}
            >
              <span
                className={`${SKETCH_INK} -z-10 rounded-[9px] bg-[#ffe9bd] border-[#e8920c] border-[2.5px]`}
              />
              Enter shop
            </button>
          </div>

          {!walletConnected && (
            <p className="text-red-500">
              please connect your wallet in the top bar to play
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`${SKETCH_SURFACE} flex h-full min-h-0 w-full min-w-0 flex-col`}
    >
      <SketchDefs />

      <header className="px-[clamp(8px,2.4cqmin,18px)] py-[clamp(5px,1.6cqmin,12px)] space-y-5">
        <button
          onClick={() => setEntered(false)}
          className="relative isolate text-[clamp(9px,2.3cqmin,16px)] leading-none px-[clamp(6px,1.8cqmin,11px)] py-[clamp(2px,0.9cqmin,6px)] transition-transform hover:-translate-y-px hover:-rotate-[0.4deg] active:translate-y-px text-[rgba(35,34,31,0.65)]"
          title="Back to intro screen"
        >
          <span
            className={`${SKETCH_INK} -z-10 rounded-[9px] bg-[#fffefb] border-[#23221f] border-[2.5px]`}
          />
          ← Back
        </button>

        <div className="flex items-center justify-between gap-[clamp(6px,2cqmin,14px)] ">
          <div className="flex items-center gap-1.5">
            {(
              [
                ["all", "All"],
                ["running", `Running (${runningCount})`],
                ["settled", `Settled (${settledCount})`],
              ] as const
            ).map(([key, label]) => {
              const active = filter === key;
              return (
                <button
                  key={key}
                  className="relative isolate text-[clamp(10px,2.6cqmin,16px)] leading-none px-[clamp(7px,2.2cqmin,14px)] py-[clamp(3px,1.2cqmin,8px)] transition-transform hover:-translate-y-px hover:-rotate-[0.4deg] active:translate-y-px"
                  onClick={() => setFilter(key)}
                >
                  <span
                    className={`${SKETCH_INK} -z-10 rounded-[9px] ${active ? "bg-[#eaf8ee] border-[#2f9e44]" : "bg-[#fffefb] border-[#23221f]"} border-[2.5px]`}
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
                className={`${SKETCH_INK} -z-10 rounded-[9px] ${autoMintEnabled ? "bg-[#eaf8ee] border-[#2f9e44]" : "bg-[#fffefb] border-[#23221f]"} border-[2.5px]`}
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
                className={`${SKETCH_INK} -z-10 rounded-[9px] bg-[#ffe9bd] border-[#e8920c] border-[2.5px]`}
              />
              <Sparkles className="size-3.5" strokeWidth={2.25} />
              Mint NFT
            </button>
          </div>
        </div>
      </header>

      <div
        className={`grid flex-1 content-start gap-[clamp(8px,2.4cqmin,16px)] overflow-y-auto px-[clamp(8px,2.4cqmin,18px)] pb-[clamp(8px,2.4cqmin,16px)] grid-cols-2 @min-[540px]:grid-cols-3 @min-[840px]:grid-cols-4`}
      >
        {visible.length === 0 ? (
          <p className="col-span-full px-2 py-8 text-center text-[clamp(11px,3cqmin,17px)] leading-snug text-[rgba(35,34,31,0.6)]">
            {machines.length === 0
              ? "Click Mint NFT to open a tunnel and start farming."
              : "No machines in this view."}
          </p>
        ) : (
          visible.map((s, idx) => {
            const isExiting = !!exiting[s.id];
            const isRunningView = filter === "running" || filter === "all";

            // Spawn-based anims only apply in views that show active cards
            const spawnNew =
              isRunningView && s.id === newestId && s.phase !== "closed";
            const spawnPush =
              isRunningView &&
              isPushing &&
              s.id !== newestId &&
              s.phase !== "closed";

            // Settled-tab only: animate newly arrived closed cards (when they render in settled view)
            const onSettledView = filter === "settled" || filter === "all";
            const settledNew =
              onSettledView && s.phase === "closed" && s.id === newSettledId;
            const settledPush =
              onSettledView &&
              s.phase === "closed" &&
              settledPushing &&
              s.id !== newSettledId;

            const removeAt =
              filter === "running" ? lingerUntil[s.id] : undefined;

            const card = (
              <MachineCard
                session={s}
                isNewlyAdded={!isExiting && (spawnNew || settledNew)}
                isPushing={spawnPush || settledPush}
                listIndex={idx}
                isLingering={
                  filter === "running" && (!!lingerUntil[s.id] || isExiting)
                }
                removeAt={removeAt}
              />
            );
            return (
              <div
                key={s.id}
                className={isExiting ? "pshop-card-exit" : undefined}
              >
                {card}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
