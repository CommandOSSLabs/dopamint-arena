import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  ConnectButton,
  useCurrentAccount,
  useSignAndExecuteTransaction,
} from "@mysten/dapp-kit";
import { CardDisplay } from "@/components/app/CardDisplay";
import { usePlayerVsDealer, type TablePhase } from "@/hooks/usePlayerVsDealer";
import { loadOrCreateBots, buildFundTx, FUND_PER_BOT_MIST } from "@/lib/bjBots";

const chip25 = "/chip-25.svg";
const chip100 = "/chip-100.svg";
const chip500 = "/chip-500.svg";
const chip1000 = "/chip-1000.svg";

function getChipStack(balance: number): string[] {
  const stack: string[] = [];
  let remaining = balance;
  
  const chipTypes = [
    { value: 1000, asset: chip1000 },
    { value: 500, asset: chip500 },
    { value: 100, asset: chip100 },
    { value: 25, asset: chip25 },
  ];

  for (const chip of chipTypes) {
    while (remaining >= chip.value && stack.length < 6) {
      stack.push(chip.asset);
      remaining -= chip.value;
    }
  }
  
  if (stack.length === 0 && balance > 0) {
    stack.push(chip25);
  }
  
  return stack;
}

// Render MIST (bigint) as a short SUI string. 1 SUI = 1e9 MIST.
function suiOf(mist: bigint): string {
  return (Number(mist) / 1e9).toLocaleString(undefined, {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  });
}

const SUISCAN_TX = "https://suiscan.xyz/testnet/tx/";

const OUTCOME_STYLE: Record<
  "win" | "lose" | "push",
  { text: string; label: string }
> = {
  win: { text: "text-emerald-400", label: "WIN" },
  lose: { text: "text-rose-400", label: "LOSE" },
  push: { text: "text-zinc-400", label: "PUSH" },
};

function signed(delta: number): string {
  return delta > 0 ? `+${delta}` : String(delta);
}

function DigestLink({ label, digest }: { label: string; digest?: string }) {
  if (!digest) return null;
  return (
    <a
      href={`${SUISCAN_TX}${digest}`}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-[11px] font-mono text-[#d4af37] hover:text-amber-300 underline underline-offset-2 transition-colors"
    >
      {label}
      <span className="text-zinc-500">{digest.slice(0, 6)}…</span>
    </a>
  );
}

// Human-vs-dealer blackjack. Forks the bot-arena casino layout, but the human drives party
// A's Hit/Stand moves over the same off-chain state channel. Party B (the dealer/house)
// auto-resolves after each Stand. Settles cooperatively on Sui testnet via Cash out.
export default function PlayerVsDealer() {
  const navigate = useNavigate();
  const game = usePlayerVsDealer();
  const {
    view,
    result,
    rounds,
    phase,
    error,
    fundNote,
    digests,
    balances,
    isPlayerTurn,
    isTerminal,
  } = game;
  const latestRound = rounds.length > 0 ? rounds[rounds.length - 1] : null;

  const [animState, setAnimState] = useState<"idle" | "deal" | "win" | "lose" | "push">("idle");
  const prevRoundRef = useRef<number>(-1);
  const prevPhaseRef = useRef<string>("");
  const prevBalanceRef = useRef<number>(-1);
  const roundsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    roundsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [rounds.length]);

  useEffect(() => {
    const hasCards = view.playerCards.length > 0 || view.dealerCards.length > 0;
    if (!hasCards) {
      setAnimState("idle");
      prevRoundRef.current = -1;
      return;
    }

    if (prevRoundRef.current === -1) {
      prevRoundRef.current = view.round;
      prevPhaseRef.current = view.phase;
      prevBalanceRef.current = view.playerBalance;
      if (view.phase === "player") {
        setAnimState("deal");
      }
      return;
    }

    const roundChanged = view.round !== prevRoundRef.current;
    const phaseChanged = view.phase !== prevPhaseRef.current;

    if (roundChanged || (phaseChanged && view.phase === "player")) {
      setAnimState("deal");
    } else if (phaseChanged && view.phase === "round_over") {
      const balanceDiff = view.playerBalance - prevBalanceRef.current;
      if (balanceDiff > 0) {
        setAnimState("win");
      } else if (balanceDiff < 0) {
        setAnimState("lose");
      } else {
        setAnimState("push");
      }
    }

    prevRoundRef.current = view.round;
    prevPhaseRef.current = view.phase;
    prevBalanceRef.current = view.playerBalance;
  }, [view.round, view.phase, view.playerBalance]);

  type ToastMsg = { id: number; msg: string; type: "info" | "win" | "lose" | "push" };
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const toastIdRef = useRef(0);

  const addToast = (msg: string, type: ToastMsg["type"] = "info") => {
    setToasts((prev) => {
      const newToasts = [...prev, { id: toastIdRef.current++, msg, type }];
      if (newToasts.length > 5) return newToasts.slice(newToasts.length - 5);
      return newToasts;
    });
  };

  const prevViewRef = useRef(view);
  const prevRoundsLenRef = useRef(rounds.length);

  useEffect(() => {
    const prev = prevViewRef.current;
    
    // Player Hit
    if (view.playerCards.length > prev.playerCards.length && prev.playerCards.length > 0) {
      addToast(`Player Hits (${view.playerSum})`);
    }
    // Player Stand
    if (prev.phase === "player" && view.phase === "dealer") {
      addToast(`Player Stands (${prev.playerSum})`);
    }
    // Dealer Hit
    if (view.dealerCards.length > prev.dealerCards.length && prev.dealerCards.length > 0) {
      addToast(`Dealer Hits (${view.dealerSum})`);
    }
    // Dealer Stand
    if (prev.phase === "dealer" && view.phase === "round_over") {
      addToast(`Dealer Stands (${prev.dealerSum})`);
    }
    
    prevViewRef.current = view;
  }, [view]);

  useEffect(() => {
    if (rounds.length > prevRoundsLenRef.current) {
      const newRound = rounds[rounds.length - 1];
      if (newRound) {
        if (newRound.outcome === "win") addToast(`Player Wins!`, "win");
        else if (newRound.outcome === "lose") addToast(`Dealer Wins!`, "lose");
        else addToast(`Round Push`, "push");
      }
    }
    prevRoundsLenRef.current = rounds.length;
  }, [rounds]);

  // Reset animation state to idle after win/lose/push completes
  useEffect(() => {
    if (animState === "win" || animState === "lose" || animState === "push") {
      const timer = setTimeout(() => {
        setAnimState("idle");
      }, 850);
      return () => clearTimeout(timer);
    }
  }, [animState]);

  // Wallet funding: send FUND_PER_BOT_MIST to each local player key from the connected
  // wallet's gas coin. Persistent keys mean one top-up covers many tables.
  const account = useCurrentAccount();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  const [walletFunding, setWalletFunding] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);
  const fundTotalSui = ((FUND_PER_BOT_MIST * 2) / 1e9).toLocaleString();

  const fundFromWallet = async () => {
    setWalletFunding(true);
    setWalletError(null);
    const prev = balances;
    try {
      await signAndExecute({ transaction: buildFundTx(loadOrCreateBots()) });
      await game.pollBalances(prev);
    } catch (e) {
      setWalletError(e instanceof Error ? e.message : String(e));
    } finally {
      setWalletFunding(false);
    }
  };

  const walletFundEl = account ? (
    <button
      onClick={fundFromWallet}
      disabled={walletFunding}
      className="border-2 border-amber-500 text-black bg-[#d4af37] hover:bg-amber-400 px-6 py-3 rounded-lg text-sm font-black tracking-widest uppercase transition-all hover:scale-105 active:scale-95 cursor-pointer disabled:opacity-50 disabled:pointer-events-none"
    >
      {walletFunding ? "Funding…" : `Fund from wallet (${fundTotalSui} SUI)`}
    </button>
  ) : (
    <ConnectButton connectText="Connect wallet" />
  );

  const running =
    phase === "funding" ||
    phase === "opening" ||
    phase === "settling";
  const inGame =
    phase === "opening" || phase === "playing" || phase === "settling";
  const terminal = phase === "done" || result !== null;
  const unfunded = balances.a === 0n || balances.b === 0n;
  // Treat "no cards yet, no table in flight" as the pre-table start screen.
  const started =
    view.playerCards.length > 0 || view.dealerCards.length > 0 || inGame;
  // The tunnel is live (table open, not yet settled) — controls are interactive.
  const tableOpen = phase === "playing";
  const roundOver = view.phase === "round_over";

  const fundBtn = (
    <button
      onClick={game.fund}
      disabled={phase === "funding"}
      className="border-2 border-amber-500 text-[#d4af37] bg-amber-950/20 hover:bg-amber-500 hover:text-black px-6 py-3 rounded-lg text-sm font-black tracking-widest uppercase transition-all hover:scale-105 active:scale-95 cursor-pointer disabled:opacity-50 disabled:pointer-events-none"
    >
      Faucet
    </button>
  );

  const refreshBtn = (
    <button
      onClick={() => void game.pollBalances()}
      className="text-[11px] text-zinc-400 hover:text-[#d4af37] underline underline-offset-2 transition-colors cursor-pointer"
      title="Re-check wallet balances (faucet can deliver late)"
    >
      Refresh balances
    </button>
  );

  const dealBtn = (
    <button
      onClick={game.openTable}
      disabled={running || unfunded || tableOpen}
      className="border-2 border-emerald-500 text-white bg-[#032a14]/65 hover:bg-emerald-500 hover:text-black px-6 py-3 rounded-lg text-sm font-black tracking-widest uppercase transition-all hover:scale-105 active:scale-95 cursor-pointer disabled:opacity-50 disabled:pointer-events-none"
    >
      Deal / Start table
    </button>
  );

  const hitBtn = (
    <button
      onClick={game.hit}
      disabled={!isPlayerTurn}
      className="border-2 border-emerald-500 text-white bg-[#032a14]/65 hover:bg-emerald-500 hover:text-black px-6 py-3 rounded-lg text-sm font-black tracking-widest uppercase transition-all hover:scale-105 active:scale-95 cursor-pointer disabled:opacity-50 disabled:pointer-events-none"
    >
      Hit
    </button>
  );

  const standBtn = (
    <button
      onClick={game.stand}
      disabled={!isPlayerTurn}
      className="border-2 border-amber-500 text-[#d4af37] bg-amber-950/20 hover:bg-amber-500 hover:text-black px-6 py-3 rounded-lg text-sm font-black tracking-widest uppercase transition-all hover:scale-105 active:scale-95 cursor-pointer disabled:opacity-50 disabled:pointer-events-none"
    >
      Stand
    </button>
  );

  const nextRoundBtn =
    tableOpen && roundOver && !isTerminal ? (
      <button
        onClick={game.nextRound}
        className="border-2 border-zinc-650 text-white bg-zinc-900/60 hover:bg-zinc-650/20 px-6 py-3 rounded-lg text-sm font-black tracking-widest uppercase transition-all hover:scale-105 active:scale-95 cursor-pointer"
      >
        Next round
      </button>
    ) : null;

  const cashOutBtn = tableOpen ? (
    <button
      onClick={game.cashOut}
      className="border-2 border-rose-500 text-white bg-[#2d090c]/65 hover:bg-rose-500/20 px-6 py-3 rounded-lg text-sm font-black tracking-widest uppercase transition-all hover:scale-105 active:scale-95 cursor-pointer"
    >
      Cash out
    </button>
  ) : null;

  // Pre-table start screen: no table has been dealt yet.
  if (!started) {
    return (
      <div
        className="h-screen w-screen flex flex-col items-center justify-center relative text-white overflow-hidden select-none bg-zinc-950 bg-cover bg-center fade-in-up"
        style={{ backgroundImage: "url('/dealer-desk-plain-rotated.png')" }}
      >
        <div className="absolute inset-0 bg-black/60" />
        <div className="relative z-10 flex flex-col items-center gap-6 bg-zinc-950/85 border border-zinc-800 rounded-2xl p-8 max-w-md w-full mx-4 shadow-2xl">
          <h1 className="text-3xl font-extrabold text-[#d4af37] font-serif tracking-widest uppercase text-center">
            Play vs Dealer
          </h1>
          <p className="text-sm text-zinc-400 text-center">
            You play Hit/Stand against the house dealer on an off-chain state
            channel, settled on Sui testnet. Fund your player key, then deal.
          </p>

          <div className="flex flex-col items-center gap-1.5 text-xs font-mono text-zinc-400">
            <span>
              Player: <span className="text-white">{suiOf(balances.a)} SUI</span>
            </span>
            <span>
              Dealer: <span className="text-white">{suiOf(balances.b)} SUI</span>
            </span>
            {refreshBtn}
          </div>

          <div className="flex flex-col items-center gap-2 w-full">
            {walletFundEl}
            <div className="flex items-center gap-3">
              {fundBtn}
              {dealBtn}
            </div>
          </div>

          {walletError && (
            <div className="text-xs text-rose-400 text-center max-w-full break-words">
              {walletError}
            </div>
          )}
          {phase === "funding" && (
            <div className="text-xs text-[#d4af37] animate-pulse uppercase tracking-widest">
              Funding from faucet…
            </div>
          )}
          {fundNote && (
            <div className="text-xs text-amber-400 text-center max-w-full break-words">
              {fundNote}
            </div>
          )}
          {error && (
            <div className="text-xs text-rose-400 text-center max-w-full break-words">
              {error}
            </div>
          )}
          {unfunded && phase !== "funding" && !error && (
            <div className="text-[11px] text-zinc-500 text-center">
              Fund your player key from wallet or the testnet faucet to begin.
            </div>
          )}

          <button
            onClick={() => navigate("/")}
            className="text-xs text-zinc-500 hover:text-white transition-colors font-semibold"
          >
            ← Back to menu
          </button>
        </div>
      </div>
    );
  }

  const phaseLabel: Record<TablePhase, string> = {
    idle: "Idle",
    funding: "Funding…",
    opening: "Opening tunnel…",
    playing: isPlayerTurn
      ? "Your move"
      : roundOver
        ? "Round complete"
        : "Dealer playing…",
    settling: "Settling on-chain…",
    done: "Cashed out",
    error: "Error",
  };

  return (
    <div className="h-screen w-screen flex flex-col relative text-white overflow-hidden select-none bg-zinc-950 fade-in-up">
      <div
        className="flex-1 w-full relative bg-cover bg-center"
        style={{ backgroundImage: "url('/dealer-desk-plain-rotated.png')" }}
      >
        <button
          onClick={() => navigate("/")}
          className="absolute top-4 left-4 z-30 p-2.5 text-zinc-400 hover:text-white bg-black/60 hover:bg-black/85 rounded-full border border-zinc-800/85 transition-all shadow-md active:scale-95 flex items-center justify-center cursor-pointer"
          title="Exit to menu"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M10 19l-7-7m0 0l7-7m-7 7h18"
            />
          </svg>
        </button>

        <div className="absolute top-4 left-1/2 -translate-x-1/2 px-4 py-1.5 bg-black/70 backdrop-blur-sm border border-amber-950 rounded-full shadow-lg z-10 flex items-center gap-2">
          <span className="text-[10px] md:text-xs text-[#d4af37] font-extrabold uppercase tracking-widest font-serif">
            Round {view.round + 1}
          </span>
          <span className="text-[10px] text-zinc-400 uppercase tracking-widest">
            · {phaseLabel[phase]}
          </span>
        </div>

        {/* Rounds running log: top-right corner, fixed height for ~3 rows, scrollable */}
        {rounds.length > 0 && (
          <div className="absolute top-16 right-3 md:top-4 md:right-4 z-20 w-44 md:w-52 flex flex-col bg-black/70 backdrop-blur-sm border border-amber-950 rounded-lg shadow-lg overflow-hidden">
            <div className="px-3 py-1.5 text-[10px] font-extrabold uppercase tracking-widest text-[#d4af37] font-serif border-b border-amber-950/70">
              Rounds
            </div>
            <div className="max-h-[250px] overflow-y-auto px-2 py-1.5 flex flex-col gap-0.5 scrollbar-thin">
              {rounds.map((r, i) => {
                const style = OUTCOME_STYLE[r.outcome];
                return (
                  <div
                    key={`${r.round}-${i}`}
                    className={`flex items-center justify-between gap-2 font-mono text-[11px] tabular-nums ${style.text}`}
                  >
                    <span className="text-zinc-500">R{r.round + 1}</span>
                    <span className="text-zinc-300">
                      P:{r.playerSum} D:{r.dealerSum}
                    </span>
                    <span className="font-bold">
                      {style.label}
                      {r.outcome !== "push" && (
                        <span className="ml-1">{signed(r.delta)}</span>
                      )}
                    </span>
                  </div>
                );
              })}
              <div ref={roundsEndRef} />
            </div>
          </div>
        )}

        {/* Toasts overlay: left of Rounds panel */}
        <div className="absolute top-16 right-48 md:top-4 md:right-60 z-30 flex flex-col items-end gap-2 pointer-events-none">
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`px-3 py-1.5 rounded-md shadow-lg text-xs font-mono font-bold fade-in-up
              ${
                t.type === "win"
                  ? "bg-emerald-900/90 text-emerald-400 border border-emerald-500/50"
                  : t.type === "lose"
                  ? "bg-rose-900/90 text-rose-400 border border-rose-500/50"
                  : t.type === "push"
                  ? "bg-amber-900/90 text-amber-400 border border-amber-500/50"
                  : "bg-zinc-900/90 text-zinc-300 border border-zinc-700/50"
              }`}
            >
              {t.msg}
            </div>
          ))}
        </div>

        {/* Betting Spot (Desk Layout) */}
        <div className={`betting-spot ${animState !== "idle" ? "active" : ""}`}>
          <div className="betting-label">PAYS 3 TO 2</div>
          <div className="text-[8px] text-[#d4af37]/60 font-mono tracking-wider font-extrabold uppercase mt-1">WAGER $100</div>
        </div>

        {/* Active Animated Chips Layer */}
        {animState !== "idle" && (
          <div className="table-chips-layer">
            {animState === "deal" && (
              <img src={chip100} className="animated-chip chip-deal" alt="bet chip" />
            )}
            {animState === "win" && (
              <>
                <img src={chip100} className="animated-chip chip-win-collect-1" alt="bet chip 1" />
                <img src={chip100} className="animated-chip chip-win-collect-2" alt="bet chip 2" />
              </>
            )}
            {animState === "lose" && (
              <img src={chip100} className="animated-chip chip-lose" alt="bet chip" />
            )}
            {animState === "push" && (
              <img src={chip100} className="animated-chip chip-push" alt="bet chip" />
            )}
          </div>
        )}

        <div className="absolute top-[20%] md:top-[16%] left-1/2 -translate-x-1/2 z-20 w-full max-w-2xl flex items-center justify-center gap-4 md:gap-12">
          <div className="flex-1 flex flex-col items-center relative pl-8 md:pl-24">
            <CardDisplay
              title="Dealer"
              cards={view.dealerCards}
              sum={view.dealerSum}
              isWinning={result === "lose"}
            />
          </div>
          <div className="w-16 md:w-24 shrink-0 flex items-end justify-center mb-4 md:mb-8">
            <div className="profile-chip-stack">
              {getChipStack(view.dealerBalance).map((chip, idx) => (
                <img
                  key={idx}
                  src={chip}
                  className="stacked-chip"
                  style={{ bottom: `${idx * 8}px`, transform: `rotate(${idx * 4 - 8}deg)` }}
                  alt="chip"
                />
              ))}
            </div>
          </div>
        </div>

        {!terminal && latestRound && roundOver && (
          <div
            key={`flash-${latestRound.round}`}
            className="absolute top-[55%] left-1/2 -translate-x-1/2 z-20 flex items-center justify-center pointer-events-none fade-in-up"
          >
            <div className="px-5 py-1.5 bg-black/75 border-2 border-amber-950 rounded-full shadow-xl backdrop-blur-sm flex items-center gap-2 font-mono text-xs md:text-sm">
              <span className="text-zinc-500">R{latestRound.round + 1}</span>
              <span className="text-zinc-300">
                P:{latestRound.playerSum} D:{latestRound.dealerSum}
              </span>
              <span
                className={`font-extrabold ${OUTCOME_STYLE[latestRound.outcome].text}`}
              >
                {OUTCOME_STYLE[latestRound.outcome].label}
                {latestRound.outcome !== "push" && (
                  <span className="ml-1">{signed(latestRound.delta)}</span>
                )}
              </span>
            </div>
          </div>
        )}

        <div className="absolute top-[50%] left-1/2 -translate-x-1/2 -translate-y-1/2 z-20 flex items-center justify-center">
          {terminal && result && (
            <div className="select-none">
              {result === "win" ? (
                <div className="px-6 py-2 bg-emerald-950/90 border-2 border-emerald-500/80 text-emerald-400 font-bold rounded-full text-xs md:text-sm shadow-xl backdrop-blur-sm animate-bounce">
                  You win
                </div>
              ) : result === "lose" ? (
                <div className="px-6 py-2 bg-rose-950/90 border-2 border-rose-500/80 text-rose-400 font-bold rounded-full text-xs md:text-sm shadow-xl backdrop-blur-sm">
                  Dealer wins
                </div>
              ) : (
                <div className="px-6 py-2 bg-amber-950/90 border-2 border-amber-500/80 text-amber-400 font-bold rounded-full text-xs md:text-sm shadow-xl backdrop-blur-sm">
                  Push
                </div>
              )}
            </div>
          )}
        </div>

        <div className="absolute top-[70%] left-1/2 -translate-x-1/2 z-20 w-full max-w-2xl flex items-center justify-center gap-4 md:gap-12">
          <div className="flex-1 flex flex-col items-center relative pl-8 md:pl-24">
            <CardDisplay
              title="You"
              cards={view.playerCards}
              sum={view.playerSum}
              isPlayer
              isWinning={result === "win"}
            />
          </div>
          <div className="w-16 md:w-24 shrink-0 flex items-end justify-center mb-4 md:mb-8">
            <div className="profile-chip-stack">
              {getChipStack(view.playerBalance).map((chip, idx) => (
                <img
                  key={idx}
                  src={chip}
                  className="stacked-chip"
                  style={{ bottom: `${idx * 8}px`, transform: `rotate(${idx * 4 - 8}deg)` }}
                  alt="chip"
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Bottom HUD */}
      <div className="w-full bg-zinc-950/95 backdrop-blur-md border-t border-zinc-800 shadow-[0_-10px_30px_rgba(0,0,0,0.95)] z-30 select-none px-4 md:px-8 py-3">
        <div className="w-full flex flex-col md:flex-row items-center justify-between gap-3">
          <div className="flex flex-row flex-wrap items-center justify-center gap-x-5 gap-y-1">
            <div className="flex flex-col items-start gap-0.5">
              <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                <span>Your stake:</span>
                <span className="text-white font-mono font-black">
                  {view.playerBalance}
                </span>
                <span className="text-zinc-600">({view.playerSum})</span>
              </div>
              <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                <span>Dealer stake:</span>
                <span className="text-white font-mono font-black">
                  {view.dealerBalance}
                </span>
                <span className="text-zinc-600">({view.dealerSum})</span>
              </div>
            </div>
            <div className="flex flex-col items-start gap-0.5">
              <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                <span>Player wallet:</span>
                <span className="text-white font-mono font-black">
                  {suiOf(balances.a)} SUI
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-zinc-500">
                <span>Dealer wallet:</span>
                <span className="text-white font-mono font-black">
                  {suiOf(balances.b)} SUI
                </span>
              </div>
              <div className="mt-0.5">{refreshBtn}</div>
            </div>
          </div>

          {/* Controls: Hit/Stand mid-round, Next round after, Cash out anytime the table
              is open; Faucet + Deal otherwise. */}
          <div className="flex flex-wrap items-center justify-center gap-3">
            {tableOpen ? (
              <>
                {hitBtn}
                {standBtn}
                {nextRoundBtn}
                {cashOutBtn}
              </>
            ) : (
              <>
                {walletFundEl}
                {fundBtn}
                {dealBtn}
              </>
            )}
          </div>
        </div>

        <div className="w-full flex flex-col md:flex-row items-center justify-between gap-2 mt-2 pt-2 border-t border-zinc-850">
          <div className="text-[11px] uppercase tracking-widest font-bold">
            {phase === "error" || error || walletError ? (
              <span className="text-rose-400 normal-case tracking-normal font-mono break-words">
                {error ?? walletError ?? "Error"}
              </span>
            ) : fundNote ? (
              <span className="text-amber-400 normal-case tracking-normal break-words">
                {fundNote}
              </span>
            ) : (
              <span
                className={
                  running ? "text-[#d4af37] animate-pulse" : "text-zinc-500"
                }
              >
                {phaseLabel[phase]}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-1">
            <DigestLink label="create" digest={digests.create} />
            <DigestLink label="depositA" digest={digests.depositA} />
            <DigestLink label="depositB" digest={digests.depositB} />
            <DigestLink label="state checkpoint" digest={digests.update} />
            <DigestLink label="close" digest={digests.close} />
            {digests.root ? (
              <span
                title={`transcript root ${digests.root}`}
                className="text-[11px] font-mono text-zinc-500"
              >
                root {digests.root.slice(0, 8)}…
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
