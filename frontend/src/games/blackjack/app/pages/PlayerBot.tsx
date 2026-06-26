import { useState, useEffect, useRef, useCallback } from "react";
import { useGameNavigate } from "@/games/blackjack/app/useGameRouter";
import { useSoloCabinet } from "@/shell/cabinet/soloCabinet";
import { useSoloAutoRetry } from "@/lib/useSoloAutoRetry";
import { useGameScale } from "@/games/blackjack/app/components/app/ScaledWrapper";
import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
} from "@mysten/dapp-kit";
import { CardDisplay } from "@/games/blackjack/app/components/app/CardDisplay";
import { SketchDefs } from "@/games/blackjack/app/App";
import {
  useBlackjackBot,
  type BotPhase,
  MIN_ROUNDS_PER_TUNNEL,
  MAX_ROUNDS_PER_TUNNEL,
} from "@/games/blackjack/app/hooks/useBlackjackBot";
import {
  loadOrCreateBots,
  buildFundTx,
} from "@/games/blackjack/app/lib/bjBots";
import { isMtpsConfigured } from "@/onchain/mtps";
import {
  betChipColor,
  SeatChips,
  CHIP_DEALER_HOME,
  CHIP_PLAYER_HOME,
} from "@/games/blackjack/app/components/app/chips";

// Quick-pick targets for rounds played off-chain per tunnel before it settles once.
const ROUND_PRESETS = [5, 10, 25, 50, 100];

// Auto-fund policy: a bot below MIN_BOT_BALANCE_MIST is topped up from the wallet. The
// threshold sits just above the hook's MIN_PLAY floor (so the bot keeps playing as long as
// possible), and the top-up is large relative to per-tunnel gas — a big runway means few
// re-funds. The top-up is also >= the threshold, so a single fund always clears it.
const MIN_BOT_BALANCE_MIST = 30_000_000n; // 0.03 SUI (just above MIN_PLAY)
const TOPUP_PER_BOT_MIST = 200_000_000; // 0.2 SUI per bot — long runway, fewer re-funds

const SUISCAN_TX = "https://suiscan.xyz/testnet/tx/";

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

// "Play vs Bot" blackjack. Reuses the casino table layout from PlayerGame, fed by
// useBlackjackBot() (off-chain state channel, no wallet/login). Bot A is the player, bot B the
// dealer. With Auto ticked your bot self-plays the dealer bot; untick it to take the player's
// hand yourself (Hit/Stand) while the dealer keeps auto-resolving.
// `autoStarted` is the App-level (per-window) latch: each blackjack window auto-starts into a
// watch exactly once, on its first entry. It lives in App (not module scope) so every window has
// its OWN latch — otherwise the first window to mount would flip a shared flag and the rest stay
// stuck on config. It survives the back-to-menu → re-enter remount (App stays mounted) but resets
// when the window is closed/reset (App remounts), so a reset re-auto-starts all windows.
export default function PlayerBot({
  autoStarted,
}: {
  autoStarted: { current: boolean };
}) {
  const navigate = useGameNavigate();
  const { isPortrait } = useGameScale();
  const game = useBlackjackBot();
  const {
    view,
    result,
    rounds,
    phase,
    error,
    fundNote,
    digests,
    balances,
    auto,
    setAuto,
    myTurn,
    hit,
    stand,
    pause: gPause,
    resume: gResume,
    settleNow,
    backToConfig,
    maxRounds,
    setMaxRounds,
    bet,
    setBet,
    betOptions,
    rebalance,
    rebalancing,
    balancesLoaded,
  } = game;
  const latestRound = rounds.length > 0 ? rounds[rounds.length - 1] : null;
  // Colour of the chip tossed in — the wager's top denomination (shared with PvP).
  const thrownChipColor = betChipColor(bet);

  const [animState, setAnimState] = useState<
    "idle" | "deal" | "win" | "lose" | "push"
  >("idle");

  const getDealerChipTransform = () => {
    if (animState === "idle") return `translate(${CHIP_DEALER_HOME}) scale(0)`;
    if (animState === "deal") return "translate(-10px, 0px) scale(1)";
    if (animState === "win") return `translate(${CHIP_PLAYER_HOME}) scale(0)`;
    if (animState === "lose")
      return `translate(${CHIP_DEALER_HOME}) scale(1.5)`;
    if (animState === "push") return `translate(${CHIP_DEALER_HOME}) scale(0)`;
    return "translate(0,0) scale(1)";
  };

  const getPlayerChipTransform = () => {
    if (animState === "idle") return `translate(${CHIP_PLAYER_HOME}) scale(0)`;
    if (animState === "deal") return "translate(10px, 0px) scale(1)";
    if (animState === "win") return `translate(${CHIP_PLAYER_HOME}) scale(1.5)`;
    if (animState === "lose") return `translate(${CHIP_DEALER_HOME}) scale(0)`;
    if (animState === "push") return `translate(${CHIP_PLAYER_HOME}) scale(0)`;
    return "translate(0,0) scale(1)";
  };
  const prevRoundRef = useRef<number>(-1);
  const prevPhaseRef = useRef<string>("");
  const prevBalanceRef = useRef<number>(-1);
  const roundsListRef = useRef<HTMLDivElement>(null);

  // Auto-scroll the rounds log to the newest entry. Scroll the LIST element directly via its
  // own scrollTop — NOT scrollIntoView, which also scrolls every scrollable ancestor (the
  // desktop window's overflow-auto content area), yanking the whole window down when the first
  // round lands.
  useEffect(() => {
    const el = roundsListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
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

  type ToastMsg = {
    id: number;
    msg: string;
    type: "info" | "win" | "lose" | "push";
  };
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

    // Player Hit — "You" when the user is playing the hand (auto off), "Player Bot" otherwise.
    const player = auto ? "Player Bot" : "You";
    if (
      view.playerCards.length > prev.playerCards.length &&
      prev.playerCards.length > 0
    ) {
      addToast(`${player} ${auto ? "Hits" : "Hit"} (${view.playerSum})`);
    }
    // Player Stand
    if (prev.phase === "player" && view.phase === "dealer") {
      addToast(`${player} ${auto ? "Stands" : "Stand"} (${prev.playerSum})`);
    }
    // Dealer Hit
    if (
      view.dealerCards.length > prev.dealerCards.length &&
      prev.dealerCards.length > 0
    ) {
      addToast(`Dealer Bot Hits (${view.dealerSum})`);
    }
    // Dealer Stand
    if (prev.phase === "dealer" && view.phase === "round_over") {
      addToast(`Dealer Bot Stands (${prev.dealerSum})`);
    }

    prevViewRef.current = view;
  }, [view, auto]);

  useEffect(() => {
    if (rounds.length > prevRoundsLenRef.current) {
      const newRound = rounds[rounds.length - 1];
      if (newRound) {
        const youWin = auto ? "Player Bot Wins!" : "You Win!";
        if (newRound.outcome === "win") addToast(youWin, "win");
        else if (newRound.outcome === "lose")
          addToast(`Dealer Bot Wins!`, "lose");
        else addToast(`Round Push`, "push");
      }
    }
    prevRoundsLenRef.current = rounds.length;
  }, [rounds, auto]);

  // Reset animation state to idle after win/lose/push completes
  useEffect(() => {
    if (animState === "win" || animState === "lose" || animState === "push") {
      const timer = setTimeout(() => {
        setAnimState("idle");
      }, 850);
      return () => clearTimeout(timer);
    }
  }, [animState]);

  // Wallet funding: send TOPUP_PER_BOT_MIST to each bot from the connected wallet's gas
  // coin. Persistent bot keys mean one top-up covers many games (deposits are refunded).
  const account = useCurrentAccount();
  const { mutateAsync: signAndExecute } = useSignAndExecuteTransaction();
  // True while a wallet fund transaction is in-flight — used to show "Preparing bots…".
  const [walletFunding, setWalletFunding] = useState(false);
  const fundFromWallet = async () => {
    const prev = balances;
    setWalletFunding(true);
    try {
      await signAndExecute({
        transaction: buildFundTx(loadOrCreateBots(), TOPUP_PER_BOT_MIST),
      });
      // The fullnode lags the funding tx — poll until balances climb above their pre-fund
      // value (or time out) instead of reading the stale value once.
      await game.pollBalances(prev);
    } catch (e) {
      console.error("[blackjack] wallet fund failed", e);
    } finally {
      setWalletFunding(false);
    }
  };

  const running =
    phase === "funding" ||
    phase === "opening" ||
    phase === "playing" ||
    phase === "settling";
  // A game is mid-flight (tunnel opening through settling) — distinct from funding, which
  // can run on the start screen before any game exists.
  const inGame =
    phase === "opening" || phase === "playing" || phase === "settling";
  const terminal = phase === "done" || result !== null;
  // MTPS mode: bots play free (sponsored gas, faucet buy-ins), so the SUI-balance gate doesn't
  // apply — never treat the bots as unfunded. SUI fallback still gates on a positive balance.
  const unfunded =
    !isMtpsConfigured && (balances.a === 0n || balances.b === 0n);

  // Auto-pilot: wallet-fund the bots once if low, then start bot-vs-bot self-play.
  // Bots are SHARED across all blackjack windows (loadOrCreateBots reads shared
  // localStorage), so opening a 2nd blackjack window double-funds and races the same
  // keypair on tunnel-open — one window wins, the others error. The desktop seeds one
  // window per game; concurrent same-game windows are not supported here.
  const autoEvenedRef = useRef(false);
  const autoPilotRef = useRef(false);
  const autoStartedRef = useRef(false);
  // Bumped by the Start button to re-trigger the auto-pilot after Back returns to config.
  const [startNonce, setStartNonce] = useState(0);

  // Resets one-shot refs and bumps the nonce so the auto-pilot effect re-runs the
  // even/fund/start path. Back never calls this, so config stays after Back.
  const handleStart = useCallback(() => {
    autoEvenedRef.current = false;
    autoPilotRef.current = false;
    autoStartedRef.current = false;
    setStartNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!account || running) return;
    if (!balancesLoaded) return;
    // Auto-start only on the first entry of this window, or when the user presses Start
    // (startNonce > 0). Re-entering from the main menu remounts the page with startNonce 0 and
    // the latch already set → stay on the config screen instead of jumping into the game.
    if (autoStarted.current && startNonce === 0) return;
    if (unfunded) {
      const combined = balances.a + balances.b;
      const diff =
        balances.a > balances.b
          ? balances.a - balances.b
          : balances.b - balances.a;
      // Even the bots BEFORE spending wallet SUI: if shifting half the surplus from the richer
      // bot lifts the poorer one over the bar, do that cheap bot→bot transfer instead of a
      // wallet top-up. Only fund when the pair is genuinely short (combined can't cover both).
      if (
        !autoEvenedRef.current &&
        diff >= 4_000_000n &&
        combined >= 2n * MIN_BOT_BALANCE_MIST
      ) {
        autoEvenedRef.current = true;
        rebalance();
        return;
      }
      if (!autoPilotRef.current) {
        autoPilotRef.current = true;
        void fundFromWallet(); // top up from wallet when the pair is genuinely short
      }
      return;
    }
    // Funded + balanced: start after a short beat so the config screen (bot balances, any
    // even/fund just done) is visibly shown and can be overridden before play begins —
    // rather than jumping straight into the game.
    if (!autoStartedRef.current) {
      autoStartedRef.current = true;
      autoStarted.current = true;
      // Fresh window (auto-piloted, startNonce 0) starts in watch; from the main menu the user
      // pressed Start (startNonce > 0) → start in manual so they play the hands.
      game.startAuto(startNonce === 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    account,
    running,
    unfunded,
    balances.a,
    balances.b,
    game,
    rebalance,
    startNonce,
  ]);

  // Auto settle and navigate home when wallet disconnects during a live game
  const prevAccountRef = useRef(account);
  useEffect(() => {
    if (prevAccountRef.current && !account) {
      if (phase === "playing" || phase === "opening") {
        console.log(
          "[blackjack bot] Wallet disconnected during active game, settling now...",
        );
        void settleNow().then(() => {
          backToConfig();
          navigate("/");
        });
      } else {
        backToConfig();
        navigate("/");
      }
    }
    prevAccountRef.current = account;
  }, [account, phase, backToConfig, settleNow, navigate]);

  // The hook seeds an empty view; treat "no cards yet, no game in flight" as the start screen.
  const started =
    view.playerCards.length > 0 || view.dealerCards.length > 0 || inGame;

  // --- Shared arcade-cabinet seam (GameCabinet wraps every window in Desktop). The shell owns
  // hover → pause → overlay; this game wires the verbs to its engine via the shared useSoloCabinet
  // assembler (same as ttt). Offerable only while auto-playing a started session.
  const offerable = started && auto;
  // Hand the player's hand to the human (flip to manual). Idempotent; the assembler adds resume.
  const goManual = useCallback(() => setAuto(false), [setAuto]);
  // "Return to Home" → blackjack's own home (the menu route), stopping the in-flight tunnel first
  // so the self-play loop doesn't keep ticking after we leave (mirrors the in-game Back button).
  const goHome = useCallback(() => {
    backToConfig();
    navigate("/");
  }, [backToConfig, navigate]);
  useSoloCabinet({
    offerable,
    pause: gPause,
    resume: gResume,
    goManual,
    goHome,
  });

  useSoloAutoRetry(auto, phase, handleStart);

  // Auto toggle: ticked = your bot plays the hand (fast self-play vs the dealer bot); unticked
  // pauses at your decision so you play Hit/Stand. The dealer + betting stay automatic either way.
  const autoToggle = (
    <button
      onClick={() => setAuto(!auto)}
      data-testid="bj-auto"
      aria-pressed={auto}
      className={`qp-btn !px-4 !py-2.5 !text-xl font-black uppercase flex items-center gap-1.5 ${auto ? "qp-btn--go" : ""}`}
    >
      <span
        className={`grid h-3.5 w-3.5 place-items-center rounded border ${auto ? "border-emerald-600 bg-emerald-500/20 text-emerald-800" : "border-zinc-500"}`}
      >
        {auto ? "✓" : ""}
      </span>
      Auto
    </button>
  );

  // Manual controls: only while it's the player's turn (auto off). Hit is locked at 21+ where the
  // only legal move is Stand.
  const hitBtn = (
    <button
      onClick={hit}
      disabled={view.playerSum >= 21}
      data-testid="bj-hit"
      className="qp-btn qp-btn--go !px-8 !py-3.5 !text-xl font-black tracking-widest uppercase cursor-pointer disabled:opacity-50 disabled:pointer-events-none"
    >
      Hit
    </button>
  );

  const standBtn = (
    <button
      onClick={stand}
      data-testid="bj-stand"
      className="qp-btn qp-btn--stop !px-8 !py-3.5 !text-xl font-black tracking-widest uppercase cursor-pointer"
    >
      Stand
    </button>
  );

  // Rounds-per-tunnel selector: presets plus a clamped custom value. Disabled while a game is
  // in flight — the running tunnel already captured its target, so edits apply to the next run.
  const isPreset = ROUND_PRESETS.includes(maxRounds);
  const roundsSelector = (
    <div className="flex items-center gap-2">
      <label
        htmlFor="rounds-per-tunnel"
        className="text-sm font-bold uppercase tracking-wider text-[var(--qp-ink-soft)]"
      >
        Rounds per tunnel
      </label>
      <select
        id="rounds-per-tunnel"
        name="rounds-per-tunnel"
        value={isPreset ? String(maxRounds) : "custom"}
        onChange={(e) => {
          if (e.target.value !== "custom") setMaxRounds(Number(e.target.value));
        }}
        disabled={inGame}
        data-testid="bj-max-rounds"
        className="qp-input bg-[#fffdf6] border-2 border-[var(--qp-ink)] text-[var(--qp-ink)] text-sm font-mono rounded-md px-3 py-1.5 focus:outline-none disabled:opacity-50 cursor-pointer"
      >
        {ROUND_PRESETS.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
        <option value="custom">Custom…</option>
      </select>
      <input
        id="rounds-per-tunnel-custom"
        name="rounds-per-tunnel-custom"
        type="number"
        min={MIN_ROUNDS_PER_TUNNEL}
        max={MAX_ROUNDS_PER_TUNNEL}
        value={maxRounds}
        onChange={(e) => setMaxRounds(Number(e.target.value))}
        disabled={inGame}
        title={`Custom rounds (${MIN_ROUNDS_PER_TUNNEL}–${MAX_ROUNDS_PER_TUNNEL})`}
        className="w-20 qp-input bg-[#fffdf6] border-2 border-[var(--qp-ink)] text-[var(--qp-ink)] text-sm font-mono tabular-nums rounded-md px-3 py-1.5 focus:outline-none disabled:opacity-50"
      />
    </div>
  );

  // Per-round bet selector: the bots wager this many chips each round. A smaller bet against the
  // same buy-in stretches the bankroll over more rounds. Locked once a game is in flight.
  const betSelector = (
    <div className="flex items-center gap-2">
      <label
        htmlFor="bet-per-round"
        className="text-sm font-bold uppercase tracking-wider text-[var(--qp-ink-soft)]"
      >
        Bet / round
      </label>
      <select
        id="bet-per-round"
        name="bet-per-round"
        value={String(bet)}
        onChange={(e) => setBet(Number(e.target.value))}
        disabled={inGame}
        className="qp-input bg-[#fffdf6] border-2 border-[var(--qp-ink)] text-[var(--qp-ink)] text-sm font-mono rounded-md px-3 py-1.5 focus:outline-none disabled:opacity-50 cursor-pointer"
      >
        {betOptions.map((n) => (
          <option key={n} value={n}>
            {n.toLocaleString()} chips
          </option>
        ))}
      </select>
    </div>
  );

  // Config screen: shown on fresh load (before any game) and after Back from the game.
  // The Start button re-triggers auto-pilot via handleStart (resets one-shot refs + bumps
  // startNonce). Back never calls handleStart, so this screen stays after Back.
  if (!started) {
    // Show "Preparing bots…" only while actively funding (wallet tx in-flight or rebalancing).
    const preparing = walletFunding || rebalancing;
    return (
      <div className="qp-sketch h-full w-full flex flex-col items-center justify-center relative overflow-hidden select-none fade-in-up">
        <SketchDefs />

        <div className="qp-panel qp-stroke max-w-[min(48rem,95%)] p-10 md:p-12 flex flex-col items-center gap-5 text-center relative">
          <button
            onClick={() => navigate("/")}
            title="Exit to menu"
            className="qp-btn !px-4 !py-2 !absolute !top-4 !left-4 z-30 !text-sm font-semibold cursor-pointer"
          >
            ← Back to menu
          </button>

          <span className="qp-eyebrow">Play vs Bot</span>
          <h2 className="qp-title mb-1 mt-1">Blackjack</h2>
          <p className="qp-note mb-2">
            Your bot plays the dealer bot over an off-chain state channel.
            Untick Auto in-game to take the hand yourself.
          </p>
          {!account ? (
            <p className="text-center text-2xl md:text-3xl text-[var(--qp-red)] font-bold py-6 uppercase tracking-widest">
              Please connect your Sui wallet in the top bar to play.
            </p>
          ) : (
            <>
              <div className="flex flex-col items-center gap-3 mt-2">
                {roundsSelector}
                {betSelector}
              </div>
              {preparing && (
                <p className="text-xs text-[var(--qp-amber)] animate-pulse uppercase tracking-widest">
                  {walletFunding ? "Setting up bots…" : "Preparing bots…"}
                </p>
              )}
              {phase === "funding" && (
                <div className="text-xs text-[var(--qp-amber)] animate-pulse uppercase tracking-widest">
                  Funding bots from faucet…
                </div>
              )}
              {fundNote && (
                <div className="text-xs text-[var(--qp-amber)] text-center max-w-full break-words">
                  {fundNote}
                </div>
              )}
              {error && (
                <div className="text-xs text-[var(--qp-red)] text-center max-w-full break-words">
                  {error}
                </div>
              )}
              {!isMtpsConfigured &&
                unfunded &&
                phase !== "funding" &&
                !error && (
                  <div className="text-[11px] text-[var(--qp-ink-soft)] text-center">
                    Fund the bots from the testnet faucet to begin.
                  </div>
                )}

              <button
                onClick={handleStart}
                disabled={preparing}
                data-testid="bj-config-start"
                className="qp-btn qp-btn--go w-full max-w-[14rem] !py-4.5 !text-xl font-black tracking-widest uppercase cursor-pointer"
              >
                Start
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  const phaseLabel: Record<BotPhase, string> = {
    idle: "Idle",
    funding: "Funding bots…",
    opening: "Starting game…",
    playing: "Playing…",
    settling: "Ending…",
    done: "Round complete",
    error: "Error",
  };

  return (
    <div className="qp-sketch h-full w-full flex flex-col relative overflow-hidden select-none fade-in-up">
      <SketchDefs />

      {/* Play area felt wrapper */}
      <div className="relative z-10 flex-1 w-full flex items-center justify-center p-4">
        <div className="bj-felt w-full h-full relative">
          {/* Back to the main menu */}
          <button
            onClick={() => {
              game.backToConfig();
              navigate("/");
            }}
            className="qp-btn !px-4 !py-2 !absolute !top-4 !left-4 z-30 !text-sm font-semibold cursor-pointer"
            title="Back to menu"
          >
            ← Back
          </button>

          {/* Round / phase badge */}
          <div
            className="absolute top-4 left-1/2 -translate-x-1/2 px-4 py-1.5 bg-[#fffefb] border-2 border-[var(--qp-ink)] rounded-full shadow-md z-10 flex items-center gap-2"
            style={{ filter: "url(#qpRough)" }}
          >
            <span className="text-lg md:text-xl text-[var(--qp-amber)] font-extrabold uppercase tracking-widest">
              Round{" "}
              {Math.min(Math.max(view.round, terminal ? 0 : 1), maxRounds)} /{" "}
              {maxRounds}
            </span>
            <span className="text-lg text-[var(--qp-ink-soft)] uppercase tracking-widest">
              · {phaseLabel[phase]}
            </span>
          </div>

          {/* Toasts overlay */}
          <div
            className={`absolute z-30 flex flex-col items-end gap-2 pointer-events-none top-4 right-4 md:top-8 md:right-8`}
          >
            {toasts.map((t) => (
              <div
                key={t.id}
                className={`px-3 py-1 rounded-md shadow-md text-xs font-bold fade-in-up border-2
                ${
                  t.type === "win"
                    ? "bg-[#eaf8ee] text-emerald-850 border-emerald-600"
                    : t.type === "lose"
                      ? "bg-[#ffe9e9] text-red-850 border-red-600"
                      : t.type === "push"
                        ? "bg-[#ffe9bd] text-amber-850 border-amber-600"
                        : "bg-[#fffefb] text-zinc-700 border-zinc-600"
                }`}
              >
                {t.msg}
              </div>
            ))}
          </div>

          <div className="absolute top-[48%] left-1/2 -translate-x-1/2 -translate-y-1/2 z-10 flex flex-col items-center gap-1">
            {/* Dealer flying chip — coloured by the wager's denomination. */}
            <div
              className={`absolute left-1/2 top-0 -mt-3 -ml-3 w-6 h-6 rounded-full border-[3px] border-[var(--qp-ink)] shadow-[0_4px_0_var(--qp-ink)] z-40 transition-all duration-700 ease-[cubic-bezier(0.34,1.56,0.64,1)] flex items-center justify-center pointer-events-none ${animState === "idle" ? "opacity-0" : "opacity-100"}`}
              style={{
                transform: getDealerChipTransform(),
                backgroundColor: thrownChipColor,
              }}
            >
              <div className="w-3 h-3 rounded-full border border-[var(--qp-ink)] opacity-50"></div>
            </div>

            {/* Player flying chip — coloured by the wager's denomination. */}
            <div
              className={`absolute left-1/2 top-0 -mt-3 -ml-3 w-6 h-6 rounded-full border-[3px] border-[var(--qp-ink)] shadow-[0_4px_0_var(--qp-ink)] z-40 transition-all duration-700 ease-[cubic-bezier(0.34,1.56,0.64,1)] flex items-center justify-center pointer-events-none ${animState === "idle" ? "opacity-0" : "opacity-100"}`}
              style={{
                transform: getPlayerChipTransform(),
                backgroundColor: thrownChipColor,
              }}
            >
              <div className="w-3 h-3 rounded-full border border-[var(--qp-ink)] opacity-50"></div>
            </div>

            <div
              className="qp-bet relative z-10"
              style={{ filter: "url(#qpRough)" }}
            >
              <span className="qp-chip" /> Wager: {bet.toLocaleString()}
            </div>
            <div className="text-[10px] text-[var(--qp-ink-soft)] uppercase tracking-widest font-bold">
              Blackjack pays 3 to 2
            </div>
          </div>

          {/* Dealer seat (left) */}
          <div className="absolute top-[15%] left-[2%] md:left-[5%] z-20 flex flex-col items-center gap-2 scale-75 md:scale-90 origin-left">
            <div
              className="qp-seat qp-stroke flex items-center justify-center"
              style={{ filter: "url(#qpRough)" }}
            >
              <div className="qp-seat__who">
                <span className="qp-seat__id qp-seat__id--b">D</span>
                <div>
                  <div className="qp-seat__name">Dealer Bot</div>
                  <div className="qp-seat__stack">
                    <span className="qp-chip" />{" "}
                    {view.dealerBalance.toLocaleString()}
                  </div>
                </div>
              </div>
            </div>
            {/* Dealer chips: violet thousands pile + the sub-1000 remainder pile (moves each hand). */}
            <SeatChips balance={view.dealerBalance} />
          </div>

          {/* Dealer hand (center) */}
          <div className="absolute top-[16%] left-1/2 -translate-x-1/2 z-20 flex flex-col items-center gap-2">
            <CardDisplay
              title=""
              cards={view.dealerCards}
              sum={view.dealerSum}
              isWinning={result === "lose"}
            />
          </div>

          {/* Latest-round flash */}
          {!terminal && latestRound && (
            <div
              key={`flash-${latestRound.round}`}
              className="absolute top-[54%] left-1/2 -translate-x-1/2 z-20 flex items-center justify-center pointer-events-none fade-in-up"
            >
              <div
                className="px-5 py-2 bg-[#fffefb] border-2 border-[var(--qp-ink)] rounded-full shadow-md flex items-center gap-3 font-mono text-sm md:text-base text-[var(--qp-ink)]"
                style={{ filter: "url(#qpRough)" }}
              >
                <span className="text-zinc-400 font-bold">
                  R{latestRound.round + 1}
                </span>
                <span className="text-zinc-700 font-semibold">
                  P:{latestRound.playerSum} D:{latestRound.dealerSum}
                </span>
                <span
                  className={`font-extrabold text-base md:text-lg ${latestRound.outcome === "win" ? "text-emerald-600" : latestRound.outcome === "lose" ? "text-red-600" : "text-amber-600"}`}
                >
                  {latestRound.outcome.toUpperCase()}
                  {latestRound.outcome !== "push" && (
                    <span className="ml-1">{signed(latestRound.delta)}</span>
                  )}
                </span>
              </div>
            </div>
          )}

          {/* Result banner (center) */}
          <div className="absolute top-[54%] left-1/2 -translate-x-1/2 -translate-y-1/2 z-20 flex items-center justify-center pointer-events-none">
            {terminal && result && (
              <div
                className="select-none qp-win text-sm font-black px-6 py-2 shadow-lg"
                style={{
                  filter: "url(#qpRough)",
                  backgroundColor:
                    result === "win"
                      ? "var(--qp-felt)"
                      : result === "lose"
                        ? "var(--qp-red)"
                        : "var(--qp-amber)",
                }}
              >
                {result === "win"
                  ? "Player Bot wins"
                  : result === "lose"
                    ? "Dealer Bot wins"
                    : "Push"}
              </div>
            )}
          </div>

          {/* Player seat (left) */}
          <div className="absolute bottom-[2%] left-[2%] md:left-[5%] z-20 flex flex-col items-center gap-2 scale-75 md:scale-90 origin-left">
            {/* Player chips: violet thousands pile + the sub-1000 remainder pile (moves each hand). */}
            <SeatChips balance={view.playerBalance} />
            <div
              className="qp-seat qp-stroke flex items-center justify-center"
              style={{ filter: "url(#qpRough)" }}
            >
              <div className="qp-seat__who">
                <span className="qp-seat__id qp-seat__id--a">P</span>
                <div>
                  <div className="qp-seat__name">Player Bot</div>
                  <div className="qp-seat__stack">
                    <span className="qp-chip" />{" "}
                    {view.playerBalance.toLocaleString()}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Player hand (center) */}
          <div className="absolute bottom-[5%] left-1/2 -translate-x-1/2 z-20 flex flex-col items-center gap-2">
            <CardDisplay
              title=""
              cards={view.playerCards}
              sum={view.playerSum}
              isPlayer
              isWinning={result === "win"}
            />
          </div>
        </div>
      </div>

      {/* Bottom HUD — actions and bet display */}
      <div className="w-full qp-ticker border-t-2 border-[var(--qp-ink)] bg-[var(--qp-paper)] z-30 select-none px-4 py-2 flex flex-col md:flex-row items-center justify-center gap-4">
        <div className="flex items-center gap-2">
          {myTurn && hitBtn}
          {myTurn && standBtn}
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-[var(--qp-ink)] uppercase tracking-wide mr-0.5 font-bold">
            Bet:
          </span>
          {betOptions.map((amt) => {
            // Manual betting only — locked while auto-play runs (auto reuses the last set level).
            const canBet =
              !auto &&
              phase === "playing" &&
              view.phase === "round_over" &&
              !terminal;
            const isSelectedBet = bet === amt;
            return (
              <button
                key={amt}
                onClick={() => game.placeBet(amt)}
                disabled={!canBet}
                className={`qp-btn !px-4 !py-2.5 !text-sm font-black ${
                  isSelectedBet ? "qp-btn--go" : ""
                } ${canBet ? "" : "opacity-50"}`}
              >
                ${amt}
              </button>
            );
          })}
        </div>

        {autoToggle}
      </div>

      {/* Status + on-chain digests */}
      <div className="w-full bg-[var(--qp-paper)] border-t border-[var(--qp-ink-soft)]/20 z-30 select-none px-4 py-1.5 flex flex-col md:flex-row items-center justify-between gap-1 md:gap-2">
        <div className="text-xs md:text-sm uppercase tracking-widest font-bold text-[var(--qp-ink)]">
          {phase === "error" || error ? (
            <span className="text-[var(--qp-red)] normal-case tracking-normal font-mono break-words">
              {error ?? "Error"}
            </span>
          ) : fundNote ? (
            <span className="text-[var(--qp-amber)] normal-case tracking-normal break-words">
              {fundNote}
            </span>
          ) : (
            <span
              className={
                running
                  ? "text-[var(--qp-amber)] animate-pulse"
                  : "text-[var(--qp-ink-soft)]"
              }
            >
              {phaseLabel[phase]}
            </span>
          )}
        </div>
        {!isPortrait && (
          <div className="hidden md:flex flex-wrap items-center justify-end gap-x-4 gap-y-1">
            <DigestLink label="open & fund" digest={digests.create} />
            <DigestLink label="state checkpoint" digest={digests.update} />
            <DigestLink label="close" digest={digests.close} />
            {digests.root ? (
              <span
                title={`transcript root ${digests.root}`}
                className="text-[10px] font-mono text-[var(--qp-ink-soft)]"
              >
                root {digests.root.slice(0, 8)}…
              </span>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
