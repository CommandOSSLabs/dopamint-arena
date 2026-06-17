import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { ConnectButton, useCurrentAccount } from "@mysten/dapp-kit";
import { CardDisplay } from "@/components/app/CardDisplay";
import { usePvpBlackjack } from "@/hooks/usePvpBlackjack";
import { handToCardIndices } from "@/lib/bjCards";

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
    while (remaining >= value && stack.length < 6) { stack.push(asset); remaining -= value; }
  }
  if (stack.length === 0 && balance > 0) stack.push(chip25);
  return stack;
}

const SUISCAN_TX = "https://suiscan.xyz/testnet/tx/";
const fmtSui = (mist: bigint) => (Number(mist) / 1e9).toFixed(4);

function DigestLink({ label, digest }: { label: string; digest?: string }) {
  if (!digest) return null;
  return (
    <a href={`${SUISCAN_TX}${digest}`} target="_blank" rel="noreferrer"
      className="inline-flex items-center gap-1 text-[11px] font-mono text-[#d4af37] hover:text-amber-300 underline underline-offset-2">
      {label}<span className="text-zinc-500">{digest.slice(0, 6)}…</span>
    </a>
  );
}

function ChipStack({ balance }: { balance: bigint }) {
  return (
    <div className="profile-chip-stack">
      {getChipStack(Number(balance)).map((chip, idx) => (
        <img key={idx} src={chip} className="stacked-chip" alt="chip"
          style={{ bottom: `${idx * 8}px`, transform: `rotate(${idx * 4 - 8}deg)` }} />
      ))}
    </div>
  );
}

function statusText(g: ReturnType<typeof usePvpBlackjack>): string {
  if (g.phase === "opening") return "Opening tunnel on-chain…";
  if (g.phase === "funding") return "Funding your seat…";
  if (g.phase === "settling") return "Settling on-chain…";
  if (g.gamePhase === "player") return g.isDealer ? "Player is deciding…" : "Your turn — Hit or Stand";
  if (g.gamePhase === "dealer") return "Dealer drawing…";
  if (g.gamePhase === "round_over") return g.terminal ? "Session over — Stop to cash out" : `Round ${g.round} over`;
  return "";
}

export default function PvpBlackjack() {
  const g = usePvpBlackjack();
  const navigate = useNavigate();
  const account = useCurrentAccount();
  useEffect(() => { document.title = "Blackjack — PvP"; }, []);

  const funded = g.walletBalance > 20_000_000n;
  const playing = g.phase === "playing" || g.phase === "settling" || g.phase === "done";
  const wins = g.rounds.filter((r) => r.outcome === "win").length;
  const losses = g.rounds.filter((r) => r.outcome === "lose").length;
  const myBal = g.isDealer ? g.balanceDealer : g.balancePlayer;
  const oppBal = g.isDealer ? g.balancePlayer : g.balanceDealer;
  const finalResult = myBal > oppBal ? "win" : myBal < oppBal ? "lose" : "push";

  return (
    <div className="h-screen w-screen flex flex-col relative text-white overflow-hidden select-none bg-zinc-950">
      {/* Casino felt (same background as the bot-vs-bot table) */}
      <div className="flex-1 w-full relative bg-cover bg-center" style={{ backgroundImage: "url('/dealer-desk-plain-rotated.png')" }}>
        <button onClick={() => { g.leave(); navigate("/"); }}
          className="absolute top-4 left-4 z-30 p-2.5 text-zinc-400 hover:text-white bg-black/60 hover:bg-black/85 rounded-full border border-zinc-800/85 transition-all active:scale-95"
          title="Exit to menu">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>
        </button>

        {/* Round / role badge */}
        {playing && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 px-4 py-1.5 bg-black/70 backdrop-blur-sm border border-amber-950 rounded-full shadow-lg z-10 flex items-center gap-2">
            <span className="text-[10px] md:text-xs text-[#d4af37] font-extrabold uppercase tracking-widest font-serif">Round {g.round}</span>
            <span className="text-[10px] text-zinc-400 uppercase tracking-widest">· you are the {g.isDealer ? "dealer" : "player"}</span>
          </div>
        )}

        {/* Rounds log (top-right) */}
        {g.rounds.length > 0 && (
          <div className="absolute top-16 right-3 md:top-4 md:right-4 z-20 w-44 md:w-52 flex flex-col bg-black/70 backdrop-blur-sm border border-amber-950 rounded-lg shadow-lg overflow-hidden">
            <div className="px-3 py-1.5 text-[10px] font-extrabold uppercase tracking-widest text-[#d4af37] font-serif border-b border-amber-950/70 flex justify-between">
              <span>Rounds</span><span className="text-zinc-400">P{wins} · D{losses}</span>
            </div>
            <div className="max-h-[240px] overflow-y-auto px-2 py-1.5 flex flex-col gap-0.5">
              {[...g.rounds].reverse().map((r) => (
                <div key={r.round} className="flex items-center justify-between gap-2 font-mono text-[11px] tabular-nums">
                  <span className="text-zinc-500">R{r.round}</span>
                  <span className="text-zinc-300">P:{r.playerSum} D:{r.dealerSum}</span>
                  <span className={`font-bold ${r.outcome === "win" ? "text-emerald-400" : r.outcome === "lose" ? "text-rose-400" : "text-amber-400"}`}>
                    {r.outcome === "win" ? "PLAYER" : r.outcome === "lose" ? "DEALER" : "PUSH"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {playing && (
          <>
            {/* Dealer hand (top) + chip stack */}
            <div className="absolute top-[18%] md:top-[15%] left-1/2 -translate-x-1/2 z-20 w-full max-w-xs flex flex-col items-center">
              <div className="absolute -left-10 md:-left-16 top-[40px] flex flex-col items-center">
                <span className="text-[7px] text-emerald-200/50 uppercase tracking-widest mb-1 font-bold">Dealer</span>
                <ChipStack balance={g.balanceDealer} />
              </div>
              <CardDisplay title="Dealer" cards={handToCardIndices(g.dealerHand, g.round * 2 + 1)} sum={g.dealerSum} isWinning={finalResult === "lose" && g.phase === "done"} />
            </div>

            {/* Center status */}
            <div className="absolute top-[49%] left-1/2 -translate-x-1/2 -translate-y-1/2 z-20 text-center">
              {g.phase === "done" ? (
                <div className={`px-6 py-2 rounded-full text-sm font-bold shadow-xl backdrop-blur-sm border-2 ${finalResult === "win" ? "bg-emerald-950/90 border-emerald-500/80 text-emerald-400" : finalResult === "lose" ? "bg-rose-950/90 border-rose-500/80 text-rose-400" : "bg-amber-950/90 border-amber-500/80 text-amber-400"}`}>
                  {finalResult === "win" ? "You come out ahead" : finalResult === "lose" ? "You're down" : "Even"}
                </div>
              ) : (
                <div className="px-5 py-1.5 bg-black/70 border border-amber-950 rounded-full text-xs md:text-sm text-amber-200 font-bold backdrop-blur-sm">{statusText(g)}</div>
              )}
            </div>

            {/* Player hand (bottom) + chip stack */}
            <div className="absolute top-[68%] left-1/2 -translate-x-1/2 z-20 w-full max-w-xs flex flex-col items-center">
              <div className="absolute -left-10 md:-left-16 top-[40px] flex flex-col items-center">
                <span className="text-[7px] text-emerald-200/50 uppercase tracking-widest mb-1 font-bold">Player</span>
                <ChipStack balance={g.balancePlayer} />
              </div>
              <CardDisplay title={`Player${g.isDealer ? "" : " (you)"}`} cards={handToCardIndices(g.playerHand, g.round * 2)} sum={g.playerSum} isPlayer isWinning={finalResult === "win" && g.phase === "done"} />
            </div>
          </>
        )}

        {/* Pre-game / connect overlay */}
        {!playing && (
          <div className="absolute inset-0 z-20 flex items-center justify-center p-4">
            <div className="bg-zinc-950/90 border border-zinc-800 rounded-2xl p-6 w-full max-w-md shadow-2xl flex flex-col items-center gap-4">
              <h1 className="text-2xl font-black text-gold uppercase tracking-widest">Blackjack · PvP</h1>
              {!account ? (
                <>
                  <p className="text-sm text-zinc-400">Connect your Sui wallet to play.</p>
                  <ConnectButton />
                </>
              ) : g.phase === "opening" || g.phase === "funding" ? (
                <div className="text-amber-400 py-6 animate-pulse">{statusText(g)}</div>
              ) : (
                <div className="w-full flex flex-col gap-3">
                  <div className="text-[11px] text-zinc-500 font-mono break-all text-center">{g.walletAddress.slice(0, 12)}… · {fmtSui(g.walletBalance)} SUI</div>
                  {!funded && <button onClick={g.fund} className="w-full bg-zinc-800 hover:bg-zinc-700 py-3 rounded-xl font-bold">Fund wallet (faucet)</button>}
                  <button onClick={g.queue} disabled={!funded || g.phase === "queuing" || g.phase === "connecting"}
                    className="w-full bg-gradient-to-r from-amber-500 to-amber-600 text-zinc-950 font-black py-4 rounded-xl uppercase tracking-widest disabled:opacity-40">
                    {g.phase === "queuing" ? "Finding an opponent…" : g.phase === "connecting" ? "Connecting…" : "Find match"}
                  </button>
                  {g.phase === "queuing" && <button onClick={g.leave} className="text-xs text-zinc-400 hover:text-white">cancel</button>}
                  {g.error && <div className="text-rose-400 text-sm text-center">{g.error}</div>}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Bottom HUD: balances + controls + on-chain links */}
      {playing && (
        <div className="w-full bg-zinc-950/95 backdrop-blur-md border-t border-zinc-800 z-30 px-4 md:px-8 py-3 flex flex-col md:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-5 text-xs">
            <span>Player <span className="font-mono text-emerald-300">{fmtSui(g.balancePlayer)} SUI</span></span>
            <span>Dealer <span className="font-mono text-rose-300">{fmtSui(g.balanceDealer)} SUI</span></span>
          </div>

          <div className="flex flex-wrap items-center gap-2 justify-center">
            {g.phase === "playing" && g.myTurn && (
              <>
                <button onClick={g.hit} disabled={g.auto} className="px-5 py-2.5 bg-amber-600 disabled:opacity-30 text-zinc-950 font-black rounded-xl">Hit</button>
                <button onClick={g.stand} disabled={g.auto} className="px-5 py-2.5 bg-zinc-700 disabled:opacity-30 font-black rounded-xl">Stand</button>
              </>
            )}
            {g.phase === "playing" && g.inRoundOver && (
              <>
                {!g.terminal && <button onClick={g.next} disabled={g.auto} className="px-5 py-2.5 bg-amber-600 disabled:opacity-30 text-zinc-950 font-black rounded-xl">Next round</button>}
                <button onClick={g.stop} className="px-5 py-2.5 bg-rose-700 hover:bg-rose-600 font-black rounded-xl">Stop &amp; settle</button>
              </>
            )}
            {g.phase === "done" && (
              <button onClick={() => { g.leave(); g.queue(); }} className="px-5 py-2.5 bg-amber-600 text-zinc-950 font-black rounded-xl">Rematch</button>
            )}
            <label className="flex items-center gap-1.5 text-xs text-zinc-300 ml-1">
              <input type="checkbox" checked={g.auto} onChange={(e) => g.setAuto(e.target.checked)} />
              Auto
            </label>
          </div>

          <div className="flex items-center gap-3">
            <DigestLink label="open" digest={g.digests.create} />
            <DigestLink label="deposit" digest={g.digests.deposit} />
            <DigestLink label="close" digest={g.digests.close} />
          </div>
        </div>
      )}
    </div>
  );
}
