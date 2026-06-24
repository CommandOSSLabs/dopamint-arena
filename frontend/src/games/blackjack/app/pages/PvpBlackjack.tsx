import { useEffect, useRef, useState } from "react";
import { useGameNavigate } from "@/games/blackjack/app/useGameRouter";
import { useGameScale } from "@/games/blackjack/app/components/app/ScaledWrapper";
import { ConnectButton, useCurrentAccount } from "@mysten/dapp-kit";
import { CardDisplay } from "@/games/blackjack/app/components/app/CardDisplay";
import { usePvpBlackjack } from "@/games/blackjack/app/hooks/usePvpBlackjack";
import { handToCardIndices } from "@/games/blackjack/app/lib/bjCards";
import { isDopamintConfigured } from "@/onchain/dopamint";

const chip25 = "/chip-25.svg";
const chip100 = "/chip-100.svg";
const chip500 = "/chip-500.svg";
const chip1000 = "/chip-1000.svg";

// Greedy chip breakdown of `balance` (capped at 6 chips), mirroring the bot-vs-bot table.
function getChipStack(balance: number): string[] {
  const stack: string[] = [];
  let remaining = balance;
  for (const { value, asset } of [
    { value: 1000, asset: chip1000 },
    { value: 500, asset: chip500 },
    { value: 100, asset: chip100 },
    { value: 25, asset: chip25 },
  ]) {
    while (remaining >= value && stack.length < 6) {
      stack.push(asset);
      remaining -= value;
    }
  }
  if (stack.length === 0 && balance > 0) stack.push(chip25);
  return stack;
}

// The single chip image that best represents a wager (so the deal animation shows the bet size).
function betChip(amount: bigint): string {
  const n = Number(amount);
  if (n >= 1000) return chip1000;
  if (n >= 500) return chip500;
  if (n >= 100) return chip100;
  return chip25;
}

const SUISCAN_TX = "https://suiscan.xyz/testnet/tx/";
const fmtSui = (mist: bigint) => (Number(mist) / 1e9).toFixed(4);

const MIN_BUYIN = 1000; // need at least the top bet ($1,000) coverable for a meaningful game
// Chips are denominated 1:1 with MIST (1 SUI = 1,000,000,000 chips). Render a chip amount as SUI.
const chipsToSui = (chips: bigint) =>
  (Number(chips) / 1e9).toLocaleString("en-US", { maximumFractionDigits: 9 });

function DigestLink({ label, digest }: { label: string; digest?: string }) {
  if (!digest) return null;
  return (
    <a
      href={`${SUISCAN_TX}${digest}`}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 text-[11px] font-mono text-[#d4af37] hover:text-amber-300 underline underline-offset-2"
    >
      {label}
      <span className="text-zinc-500">{digest.slice(0, 6)}…</span>
    </a>
  );
}

function ChipStack({ balance }: { balance: bigint }) {
  return (
    <div className="profile-chip-stack">
      {getChipStack(Number(balance)).map((chip, idx) => (
        <img
          key={idx}
          src={chip}
          className="stacked-chip"
          alt="chip"
          style={{
            bottom: `${idx * 8}px`,
            transform: `rotate(${idx * 4 - 8}deg)`,
          }}
        />
      ))}
    </div>
  );
}

function statusText(g: ReturnType<typeof usePvpBlackjack>): string {
  if (g.phase === "opening") return "Opening tunnel on-chain…";
  if (g.phase === "funding") return "Funding your seat…";
  if (g.phase === "settling") return "Settling on-chain…";
  if (g.gamePhase === "player")
    return g.isDealer ? "Player is deciding…" : "Your turn — Hit or Stand";
  if (g.gamePhase === "dealer") return "Dealer drawing…";
  if (g.gamePhase === "round_over") {
    if (g.terminal)
      return g.outOfChips
        ? `${g.outOfChips === "player" ? "Player" : "Dealer"} is out of chips — settling…`
        : "Round cap reached — settling…";
    return g.isDealer
      ? "Waiting for the player's bet…"
      : "Place your bet for the next round";
  }
  return "";
}

export default function PvpBlackjack() {
  const g = usePvpBlackjack();
  const navigate = useGameNavigate();
  const { isPortrait } = useGameScale();
  const account = useCurrentAccount();
  useEffect(() => {
    document.title = "Blackjack — PvP";
  }, []);

  // DOPAMINT mode: gas is sponsored and the buy-in is faucet-minted DOPAMINT, so a 0-SUI player can
  // play — the wallet-SUI gate doesn't apply. SUI mode still needs gas to open/deposit.
  const funded = isDopamintConfigured || g.walletBalance > 20_000_000n;
  const playing =
    g.phase === "playing" || g.phase === "settling" || g.phase === "done";
  const wins = g.rounds.filter((r) => r.outcome === "win").length;
  const losses = g.rounds.filter((r) => r.outcome === "lose").length;
  const myBal = g.myBalance;
  const oppBal = g.oppBalance;
  const finalResult = myBal > oppBal ? "win" : myBal < oppBal ? "lose" : "push";

  // Perspective-based rendering (always show "self" at the bottom and "opponent" at the top)
  const selfTitle = g.isDealer ? "Dealer (you)" : "Player (you)";
  const selfLabel = g.isDealer ? "Dealer" : "Player";
  const selfCards = g.isDealer ? g.dealerHand : g.playerHand;
  const selfCardSeed = g.isDealer ? g.round * 2 + 1 : g.round * 2;
  const selfSum = g.isDealer ? g.dealerSum : g.playerSum;
  const selfBalance = g.isDealer ? g.balanceDealer : g.balancePlayer;
  const selfIsWinning = finalResult === "win" && g.phase === "done";

  const oppTitle = g.isDealer ? "Player" : "Dealer";
  const oppLabel = g.isDealer ? "Player" : "Dealer";
  const oppCards = g.isDealer ? g.playerHand : g.dealerHand;
  const oppCardSeed = g.isDealer ? g.round * 2 : g.round * 2 + 1;
  const oppSum = g.isDealer ? g.playerSum : g.dealerSum;
  const oppBalance = g.isDealer ? g.balancePlayer : g.balanceDealer;
  const oppIsWinning = finalResult === "lose" && g.phase === "done";

  // Bet/payout chip animation, driven off the player's (party A) seat — matching the fixed
  // player-bottom / dealer-top layout (same felt motion as the bot-vs-bot self-play table).
  const [customStake, setCustomStake] = useState(""); // free-typed buy-in (empty → a preset is active)
  const [animState, setAnimState] = useState<
    "idle" | "deal" | "win" | "lose" | "push"
  >("idle");
  const prevRoundRef = useRef(-1);
  const prevPhaseRef = useRef("");
  const prevBalanceRef = useRef(-1);
  useEffect(() => {
    const hasCards = g.playerHand.length > 0 || g.dealerHand.length > 0;
    if (!hasCards) {
      setAnimState("idle");
      prevRoundRef.current = -1;
      return;
    }
    const balance = Number(g.myBalance);
    if (prevRoundRef.current === -1) {
      if (g.gamePhase === "player") setAnimState("deal");
    } else {
      const roundChanged = g.round !== prevRoundRef.current;
      const phaseChanged = g.gamePhase !== prevPhaseRef.current;
      if (roundChanged || (phaseChanged && g.gamePhase === "player")) {
        setAnimState("deal"); // a fresh round was dealt → chip slides from the player to the spot
      } else if (phaseChanged && g.gamePhase === "round_over") {
        const diff = balance - prevBalanceRef.current;
        setAnimState(diff > 0 ? "win" : diff < 0 ? "lose" : "push");
      }
    }
    prevRoundRef.current = g.round;
    prevPhaseRef.current = g.gamePhase ?? "";
    prevBalanceRef.current = balance;
  }, [
    g.round,
    g.gamePhase,
    g.myBalance,
    g.playerHand.length,
    g.dealerHand.length,
  ]);
  // Settle animations are one-shot — return to the resting spot once they finish.
  useEffect(() => {
    if (animState === "win" || animState === "lose" || animState === "push") {
      const timer = setTimeout(() => setAnimState("idle"), 850);
      return () => clearTimeout(timer);
    }
  }, [animState]);
  const dealChip = betChip(g.currentBet);

  return (
    <div className="h-full w-full flex flex-col relative text-white overflow-hidden select-none bg-zinc-950">
      {/* Casino felt (same background as the bot-vs-bot table) */}
      <div className="flex-1 w-full relative casino-felt">
        <button
          onClick={() => {
            g.leave();
            navigate("/");
          }}
          className="absolute top-4 left-4 z-30 p-2.5 text-zinc-400 hover:text-white bg-black/60 hover:bg-black/85 rounded-full border border-zinc-800/85 transition-all active:scale-95"
          title="Exit to menu"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M10 19l-7-7m0 0l7-7m-7 7h18"
            />
          </svg>
        </button>

        {/* Round / role badge */}
        {playing && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 px-4 py-1.5 bg-black/70 backdrop-blur-sm border border-amber-950 rounded-full shadow-lg z-10 flex items-center gap-2">
            <span className="text-[10px] md:text-xs text-[#d4af37] font-extrabold uppercase tracking-widest font-serif">
              Round {g.round}
            </span>
            <span className="text-[10px] text-zinc-400 uppercase tracking-widest">
              · you are the {g.isDealer ? "dealer" : "player"}
            </span>
          </div>
        )}

        {/* Rounds log (top-right) */}
        {!isPortrait && g.rounds.length > 0 && (
          <div className="hidden md:flex absolute top-16 right-3 md:top-4 md:right-4 z-20 w-44 md:w-52 flex-col bg-black/70 backdrop-blur-sm border border-amber-950 rounded-lg shadow-lg overflow-hidden">
            <div className="px-3 py-1.5 text-[10px] font-extrabold uppercase tracking-widest text-[#d4af37] font-serif border-b border-amber-950/70 flex justify-between">
              <span>Rounds</span>
              <span className="text-zinc-400">
                P{wins} · D{losses}
              </span>
            </div>
            <div className="max-h-[240px] overflow-y-auto px-2 py-1.5 flex flex-col gap-0.5">
              {[...g.rounds].reverse().map((r) => (
                <div
                  key={r.round}
                  className="flex items-center justify-between gap-2 font-mono text-[11px] tabular-nums"
                >
                  <span className="text-zinc-500">R{r.round}</span>
                  <span className="text-zinc-300">
                    P:{r.playerSum} D:{r.dealerSum}
                  </span>
                  <span
                    className={`font-bold ${r.outcome === "win" ? "text-emerald-400" : r.outcome === "lose" ? "text-rose-400" : "text-amber-400"}`}
                  >
                    {r.outcome === "win"
                      ? "PLAYER"
                      : r.outcome === "lose"
                        ? "DEALER"
                        : "PUSH"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {playing && (
          <>
            {/* Resting bet spot + animated chip (slides on deal, collects/pays out on settle) */}
            <div
              className={`betting-spot ${animState !== "idle" ? "active" : ""}`}
            >
              <div className="betting-label">
                {g.currentBet > 0n
                  ? `$${Number(g.currentBet).toLocaleString()}`
                  : "PLACE BET"}
              </div>
            </div>
            {animState !== "idle" && (
              <div className="table-chips-layer">
                {animState === "deal" && (
                  <img
                    src={dealChip}
                    className={`animated-chip ${g.isDealer ? "chip-deal-reverse" : "chip-deal"}`}
                    alt="bet chip"
                  />
                )}
                {animState === "win" && (
                  <>
                    <img
                      src={dealChip}
                      className="animated-chip chip-win-collect-1"
                      alt="bet chip"
                    />
                    {!g.isDealer && (
                      <img
                        src={dealChip}
                        className="animated-chip chip-win-collect-2"
                        alt="bet chip"
                      />
                    )}
                  </>
                )}
                {animState === "lose" && (
                  <>
                    <img
                      src={dealChip}
                      className="animated-chip chip-lose"
                      alt="bet chip"
                    />
                    {g.isDealer && (
                      <img
                        src={dealChip}
                        className="animated-chip chip-lose-from-bottom"
                        alt="bet chip"
                      />
                    )}
                  </>
                )}
                {animState === "push" && (
                  <img
                    src={dealChip}
                    className={`animated-chip ${g.isDealer ? "chip-lose" : "chip-push"}`}
                    alt="bet chip"
                  />
                )}
              </div>
            )}

            {/* Opponent hand (top) + chip stack */}
            <div className="absolute top-[18%] md:top-[15%] left-1/2 -translate-x-1/2 z-20 w-full max-w-xs flex flex-col items-center">
              <div className="absolute -left-10 md:-left-16 top-[40px] flex flex-col items-center">
                <span className="text-[7px] text-emerald-200/50 uppercase tracking-widest mb-1 font-bold">
                  {oppLabel}
                </span>
                <ChipStack balance={oppBalance} />
              </div>
              <CardDisplay
                title={oppTitle}
                cards={handToCardIndices(oppCards, oppCardSeed)}
                sum={oppSum}
                isWinning={oppIsWinning}
              />
            </div>

            {/* Center status */}
            <div className="absolute top-[49%] left-1/2 -translate-x-1/2 -translate-y-1/2 z-20 text-center">
              {g.phase === "done" ? (
                <div
                  className={`px-6 py-2 rounded-full text-sm font-bold shadow-xl backdrop-blur-sm border-2 ${finalResult === "win" ? "bg-emerald-950/90 border-emerald-500/80 text-emerald-400" : finalResult === "lose" ? "bg-rose-950/90 border-rose-500/80 text-rose-400" : "bg-amber-950/90 border-amber-500/80 text-amber-400"}`}
                >
                  {finalResult === "win"
                    ? "You come out ahead"
                    : finalResult === "lose"
                      ? "You're down"
                      : "Even"}
                </div>
              ) : (
                <div className="px-5 py-1.5 bg-black/70 border border-amber-950 rounded-full text-xs md:text-sm text-amber-200 font-bold backdrop-blur-sm">
                  {statusText(g)}
                </div>
              )}
            </div>

            {/* Self hand (bottom) + chip stack */}
            <div className="absolute top-[68%] md:top-[60%] left-1/2 -translate-x-1/2 z-20 w-full max-w-xs flex flex-col items-center">
              <div className="absolute -left-10 md:-left-16 top-[40px] flex flex-col items-center">
                <span className="text-[7px] text-emerald-200/50 uppercase tracking-widest mb-1 font-bold">
                  {selfLabel}
                </span>
                <ChipStack balance={selfBalance} />
              </div>
              <CardDisplay
                title={selfTitle}
                cards={handToCardIndices(selfCards, selfCardSeed)}
                sum={selfSum}
                isPlayer
                isWinning={selfIsWinning}
              />
            </div>
          </>
        )}

        {/* Pre-game / connect overlay */}
        {!playing && (
          <div className="absolute inset-0 z-20 flex items-center justify-center p-4">
            <div className="bg-zinc-950/90 border border-zinc-800 rounded-3xl p-8 md:p-12 w-[85%] max-w-4xl shadow-2xl flex flex-col items-center gap-4">
              <h1 className="text-2xl font-black text-gold uppercase tracking-widest">
                Blackjack · PvP
              </h1>
              {!account ? (
                <>
                  <p className="text-sm text-zinc-400">
                    Connect your Sui wallet to play.
                  </p>
                  <ConnectButton />
                </>
              ) : g.phase === "opening" || g.phase === "funding" ? (
                <div className="text-amber-400 py-6 animate-pulse">
                  {statusText(g)}
                </div>
              ) : (
                <div className="w-full flex flex-col gap-3">
                  <div className="text-[11px] text-zinc-500 font-mono break-all text-center">
                    {g.walletAddress.slice(0, 12)}…
                    {!isDopamintConfigured && (
                      <> · {fmtSui(g.walletBalance)} SUI</>
                    )}
                  </div>
                  {/* Buy-in: each player brings their own bankroll; the table caps bets at min(both). */}
                  <div className="flex flex-col gap-2">
                    <span className="text-[11px] text-zinc-400 uppercase tracking-widest text-center">
                      Your buy-in
                    </span>
                    <div className="grid grid-cols-4 gap-2">
                      {g.fundOptions.map((amt) => {
                        const selected =
                          customStake === "" && g.stake === BigInt(amt);
                        return (
                          <button
                            key={amt}
                            onClick={() => {
                              g.setStake(BigInt(amt));
                              setCustomStake("");
                            }}
                            disabled={
                              g.phase === "queuing" || g.phase === "connecting"
                            }
                            className={`py-2 rounded-lg text-xs font-black tabular-nums transition-colors disabled:opacity-40 ${selected ? "bg-amber-500 text-zinc-950" : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"}`}
                          >
                            ${amt.toLocaleString()}
                          </button>
                        );
                      })}
                    </div>
                    {/* Custom buy-in */}
                    <div className="flex items-center gap-2">
                      <span className="text-zinc-500 text-sm font-bold">$</span>
                      <input
                        type="number"
                        inputMode="numeric"
                        min={MIN_BUYIN}
                        placeholder="Custom amount"
                        value={customStake}
                        disabled={
                          g.phase === "queuing" || g.phase === "connecting"
                        }
                        onChange={(e) => {
                          const v = e.target.value.replace(/[^0-9]/g, "");
                          setCustomStake(v);
                          if (v) g.setStake(BigInt(v));
                        }}
                        className="flex-1 min-w-0 bg-zinc-900 border border-zinc-700 focus:border-amber-500 rounded-lg px-3 py-2 text-sm font-mono tabular-nums outline-none disabled:opacity-40"
                      />
                    </div>
                    {/* SUI explanation — chips are 1:1 with MIST. Hidden under DOPAMINT (the token
                        is intentionally invisible; the buy-in is just game chips, auto-funded). */}
                    {!isDopamintConfigured && (
                      <div className="text-[11px] text-zinc-400 text-center leading-relaxed">
                        ${Number(g.stake).toLocaleString()} buy-in ≈{" "}
                        <span className="font-mono text-emerald-300">
                          {chipsToSui(g.stake)} SUI
                        </span>{" "}
                        on-chain
                        <br />
                        <span className="text-zinc-500">
                          1 SUI = 1,000,000,000 chips · e.g. $500 ={" "}
                          {chipsToSui(500n)} SUI
                        </span>
                      </div>
                    )}
                    {g.stake < BigInt(MIN_BUYIN) && (
                      <div className="text-rose-400 text-[11px] text-center">
                        minimum buy-in is ${MIN_BUYIN.toLocaleString()}
                      </div>
                    )}
                  </div>
                  {!funded && (
                    <button
                      onClick={g.fund}
                      className="w-full bg-zinc-800 hover:bg-zinc-700 py-3 rounded-xl font-bold"
                    >
                      Fund wallet (faucet)
                    </button>
                  )}
                  <button
                    onClick={g.queue}
                    disabled={
                      !funded ||
                      g.stake < BigInt(MIN_BUYIN) ||
                      g.phase === "queuing" ||
                      g.phase === "connecting"
                    }
                    className="w-full bg-gradient-to-r from-amber-500 to-amber-600 text-zinc-950 font-black py-4 rounded-xl uppercase tracking-widest disabled:opacity-40"
                  >
                    {g.phase === "queuing"
                      ? "Finding an opponent…"
                      : g.phase === "connecting"
                        ? "Connecting…"
                        : "Find match"}
                  </button>
                  {g.phase === "queuing" && (
                    <button
                      onClick={g.leave}
                      className="text-xs text-zinc-400 hover:text-white"
                    >
                      cancel
                    </button>
                  )}
                  {g.error && (
                    <div className="text-rose-400 text-sm text-center">
                      {g.error}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Bottom HUD: balances + controls + on-chain links */}
      {playing && (
        <div
          className={`w-full bg-zinc-950/95 backdrop-blur-md border-t border-zinc-800 z-30 px-4 md:px-8 py-2 md:py-3 flex items-center justify-between gap-3 flex-shrink-0 ${
            isPortrait ? "flex-col h-[110px]" : "flex-row h-[64px]"
          }`}
        >
          {/* Left / Top: Balances */}
          <div
            className={`flex items-center text-xs ${
              isPortrait ? "gap-5 justify-center" : "flex-1 gap-5 justify-start"
            }`}
          >
            <span>
              Player{" "}
              <span className="font-mono text-emerald-300">
                ${Number(g.balancePlayer).toLocaleString()}
              </span>
            </span>
            <span>
              Dealer{" "}
              <span className="font-mono text-rose-300">
                ${Number(g.balanceDealer).toLocaleString()}
              </span>
            </span>
            {g.currentBet > 0n && (
              <span className="text-zinc-500">
                · bet{" "}
                <span className="font-mono text-amber-300">
                  ${Number(g.currentBet).toLocaleString()}
                </span>
              </span>
            )}
          </div>

          {/* Center: Controls */}
          <div
            className={`flex items-center gap-2 justify-center ${
              isPortrait ? "flex-wrap" : "flex-shrink-0"
            }`}
          >
            {g.phase === "playing" && g.myTurn && (
              <>
                <button
                  onClick={g.hit}
                  disabled={g.auto}
                  className="px-5 py-2.5 bg-amber-600 disabled:opacity-30 text-zinc-950 font-black rounded-xl"
                >
                  Hit
                </button>
                <button
                  onClick={g.stand}
                  disabled={g.auto}
                  className="px-5 py-2.5 bg-zinc-700 disabled:opacity-30 font-black rounded-xl"
                >
                  Stand
                </button>
              </>
            )}
            {g.phase === "playing" && g.inRoundOver && (
              <>
                {!g.terminal && !g.isDealer && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] text-zinc-400 uppercase tracking-wide mr-0.5">
                      Bet
                    </span>
                    {g.betOptions.map((amt) => (
                      <button
                        key={amt}
                        onClick={() => g.bet(amt)}
                        disabled={g.auto}
                        className="px-3.5 py-2.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-30 text-zinc-950 font-black rounded-xl"
                      >
                        ${amt}
                      </button>
                    ))}
                  </div>
                )}
                {!g.terminal && g.isDealer && (
                  <span className="px-4 py-2.5 text-xs text-amber-200/80 font-bold">
                    Player is betting…
                  </span>
                )}
                <button
                  onClick={g.stop}
                  className="px-5 py-2.5 bg-rose-700 hover:bg-rose-600 font-black rounded-xl"
                >
                  Stop &amp; settle
                </button>
              </>
            )}
            {g.phase === "done" && (
              <button
                onClick={() => {
                  g.leave();
                  g.queue();
                }}
                className="px-5 py-2.5 bg-amber-600 text-zinc-950 font-black rounded-xl"
              >
                Rematch
              </button>
            )}
          </div>

          {/* Right / Bottom: Auto toggle and Digest Links */}
          <div
            className={`flex items-center ${
              isPortrait ? "justify-center gap-4" : "flex-1 justify-end gap-4"
            }`}
          >
            {/* Auto governs the player only (hit/stand + re-bet); the dealer always draws deterministically. */}
            <button
              onClick={() => g.setAuto(!g.auto)}
              className={`flex items-center gap-2 border-2 px-3 py-1.5 rounded-xl text-xs font-black tracking-wider uppercase transition-all hover:scale-105 active:scale-95 cursor-pointer ${
                g.auto
                  ? "border-emerald-500 text-white bg-emerald-950/45 hover:bg-emerald-900/40"
                  : "border-zinc-700 text-zinc-400 bg-zinc-900/60 hover:bg-zinc-800/60"
              }`}
            >
              <span
                className={`grid h-3.5 w-3.5 place-items-center rounded border transition-colors ${
                  g.auto
                    ? "border-emerald-400 bg-emerald-500 text-zinc-950"
                    : "border-zinc-600 bg-zinc-800"
                }`}
              >
                {g.auto ? "✓" : ""}
              </span>
              Auto
            </button>
            {!isPortrait && (
              <div className="flex items-center gap-3">
                <DigestLink label="open" digest={g.digests.create} />
                <DigestLink label="deposit" digest={g.digests.deposit} />
                <DigestLink label="close" digest={g.digests.close} />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
