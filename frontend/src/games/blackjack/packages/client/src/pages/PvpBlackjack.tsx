import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { ConnectButton, useCurrentAccount } from "@mysten/dapp-kit";
import { CardDisplay } from "@/components/app/CardDisplay";
import { usePvpBlackjack, type RoundResult } from "@/hooks/usePvpBlackjack";
import { handToCardIndices, handValue } from "@/lib/bjCards";

const SUISCAN_TX = "https://suiscan.xyz/testnet/tx/";
const fmtSui = (mist: bigint) => (Number(mist) / 1e9).toFixed(3);

function DigestLink({ label, digest }: { label: string; digest?: string }) {
  if (!digest) return null;
  return (
    <a href={`${SUISCAN_TX}${digest}`} target="_blank" rel="noreferrer"
      className="inline-flex items-center gap-1 text-[11px] font-mono text-[#d4af37] hover:text-amber-300 underline underline-offset-2">
      {label} <span className="text-zinc-500">{digest.slice(0, 6)}…</span>
    </a>
  );
}

function statusText(g: ReturnType<typeof usePvpBlackjack>): string {
  if (g.phase === "opening") return "Opening tunnel on-chain…";
  if (g.phase === "funding") return "Funding your seat…";
  if (g.phase === "settling") return "Settling on-chain…";
  if (g.gamePhase === "player") return g.isDealer ? "Player is deciding…" : "Your turn — Hit or Stand";
  if (g.gamePhase === "dealer") return "Dealer drawing…";
  if (g.gamePhase === "round_over") return g.terminal ? "Session over — settle to cash out" : `Round ${g.round} over`;
  return "";
}

export default function PvpBlackjack() {
  const g = usePvpBlackjack();
  const navigate = useNavigate();
  const account = useCurrentAccount();
  useEffect(() => { document.title = "Blackjack — PvP"; }, []);
  const funded = g.walletBalance > 20_000_000n;

  if (!account) {
    return (
      <div className="w-screen h-screen flex flex-col items-center justify-center menu-background text-white p-4 select-none">
        <div className="bg-zinc-950/90 border border-zinc-800 rounded-2xl p-6 w-full max-w-md shadow-2xl flex flex-col items-center gap-4">
          <h1 className="text-2xl font-black text-gold uppercase tracking-widest">Blackjack · PvP</h1>
          <p className="text-sm text-zinc-400">Connect your Sui wallet to play.</p>
          <ConnectButton />
          <button onClick={() => navigate("/")} className="text-xs text-zinc-400 hover:text-white">← menu</button>
        </div>
      </div>
    );
  }

  const wins = g.rounds.filter((r) => r.outcome === "win").length;
  const losses = g.rounds.filter((r) => r.outcome === "lose").length;
  const pushes = g.rounds.filter((r) => r.outcome === "push").length;
  const playing = g.phase === "playing" || g.phase === "settling" || g.phase === "done";
  const myBal = g.isDealer ? g.balanceDealer : g.balancePlayer;
  const oppBal = g.isDealer ? g.balancePlayer : g.balanceDealer;
  const finalResult = myBal > oppBal ? "win" : myBal < oppBal ? "lose" : "push";

  return (
    <div className="w-screen min-h-screen flex flex-col items-center justify-center menu-background text-white p-4 overflow-auto select-none">
      <div className="bg-zinc-950/90 border border-zinc-800 rounded-2xl p-6 w-full max-w-3xl shadow-2xl">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-2xl font-black text-gold uppercase tracking-widest">Blackjack · PvP</h1>
          <button onClick={() => { g.leave(); navigate("/"); }} className="text-xs text-zinc-400 hover:text-white">← menu</button>
        </div>
        <div className="text-[11px] text-zinc-500 mb-4 font-mono break-all">
          wallet {g.walletAddress.slice(0, 10)}… · {fmtSui(g.walletBalance)} SUI
          {g.role && <span className="ml-2 text-amber-400">· you are the {g.isDealer ? "DEALER" : "PLAYER"}</span>}
        </div>

        {(g.phase === "idle" || g.phase === "connecting" || g.phase === "queuing" || g.phase === "error") && (
          <div className="flex flex-col gap-3">
            {!funded && <button onClick={g.fund} className="w-full bg-zinc-800 hover:bg-zinc-700 py-3 rounded-xl font-bold">Fund wallet (faucet)</button>}
            <button onClick={g.queue} disabled={!funded || g.phase === "queuing" || g.phase === "connecting"}
              className="w-full bg-gradient-to-r from-amber-500 to-amber-600 text-zinc-950 font-black py-4 rounded-xl uppercase tracking-widest disabled:opacity-40">
              {g.phase === "queuing" ? "Finding an opponent…" : g.phase === "connecting" ? "Connecting…" : "Find match"}
            </button>
            {g.phase === "queuing" && <button onClick={g.leave} className="text-xs text-zinc-400 hover:text-white">cancel</button>}
            {g.error && <div className="text-rose-400 text-sm">{g.error}</div>}
          </div>
        )}

        {(g.phase === "opening" || g.phase === "funding") && (
          <div className="text-center text-amber-400 py-10 animate-pulse">{statusText(g)}</div>
        )}

        {playing && (
          <div className="flex flex-col gap-4">
            {/* Scoreboard */}
            <div className="flex justify-between items-center text-sm border-b border-zinc-800 pb-3">
              <div>Player <span className="font-black text-emerald-400">{wins}</span></div>
              <div className="text-zinc-500">Pushes {pushes} · Round {g.round}</div>
              <div>Dealer <span className="font-black text-rose-400">{losses}</span></div>
            </div>

            {/* Hands */}
            <CardDisplay title="Dealer" cards={handToCardIndices(g.dealerHand, g.round * 2 + 1)} sum={g.gamePhase === "player" ? 0 : g.dealerSum} />
            <CardDisplay title={`Player${g.isDealer ? "" : " (you)"}`} cards={handToCardIndices(g.playerHand, g.round * 2)} sum={g.playerSum} isPlayer />

            <div className="text-center font-bold text-lg text-amber-300 min-h-[28px]">{statusText(g)}</div>

            <label className="flex items-center justify-center gap-2 text-sm text-zinc-300">
              <input type="checkbox" checked={g.auto} onChange={(e) => g.setAuto(e.target.checked)} />
              {g.isDealer ? "Auto (keep dealing rounds)" : "Auto (let my bot play)"}
            </label>

            {g.phase === "playing" && (
              <div className="flex flex-wrap gap-3 justify-center">
                {g.myTurn && (
                  <>
                    <button onClick={g.hit} disabled={g.auto} className="flex-1 min-w-[120px] bg-amber-600 disabled:opacity-30 text-zinc-950 font-black py-3 rounded-xl">Hit</button>
                    <button onClick={g.stand} disabled={g.auto} className="flex-1 min-w-[120px] bg-zinc-700 disabled:opacity-30 font-black py-3 rounded-xl">Stand</button>
                  </>
                )}
                {g.inRoundOver && (
                  <>
                    {!g.terminal && <button onClick={g.next} disabled={g.auto} className="flex-1 min-w-[120px] bg-amber-600 disabled:opacity-30 text-zinc-950 font-black py-3 rounded-xl">Next round</button>}
                    <button onClick={g.stop} className="flex-1 min-w-[120px] bg-rose-700 hover:bg-rose-600 font-black py-3 rounded-xl">Stop &amp; settle</button>
                  </>
                )}
                {!g.myTurn && !g.inRoundOver && <div className="text-center text-zinc-400 text-sm w-full">{g.gamePhase === "dealer" ? "Dealer drawing…" : "Opponent's turn…"}</div>}
              </div>
            )}

            {g.phase === "settling" && <div className="text-center text-amber-400 animate-pulse">Settling on-chain…</div>}
            {g.phase === "done" && (
              <div className="text-center">
                <div className={`text-3xl font-black ${finalResult === "win" ? "text-emerald-400" : finalResult === "lose" ? "text-rose-400" : "text-zinc-300"}`}>
                  {finalResult === "win" ? "You come out ahead!" : finalResult === "lose" ? "You're down" : "Even"}
                </div>
                <div className="text-xs text-zinc-500 mt-1">final · you {fmtSui(myBal)} SUI · opponent {fmtSui(oppBal)} SUI</div>
                <button onClick={() => { g.leave(); g.queue(); }} className="mt-4 bg-amber-600 text-zinc-950 font-black px-6 py-3 rounded-xl">Rematch</button>
              </div>
            )}

            {/* Round log */}
            {g.rounds.length > 0 && (
              <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-3 max-h-40 overflow-auto">
                <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Rounds</div>
                <ul className="space-y-1 text-xs font-mono">
                  {[...g.rounds].reverse().map((r: RoundResult) => (
                    <li key={r.round} className="flex justify-between">
                      <span className="text-zinc-400">#{r.round}</span>
                      <span>P {r.playerSum} · D {r.dealerSum}</span>
                      <span className={r.outcome === "win" ? "text-emerald-400" : r.outcome === "lose" ? "text-rose-400" : "text-zinc-400"}>
                        {r.outcome === "win" ? "player" : r.outcome === "lose" ? "dealer" : "push"}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex flex-wrap gap-x-4 gap-y-1 justify-center pt-1">
              <DigestLink label="open" digest={g.digests.create} />
              <DigestLink label="deposit" digest={g.digests.deposit} />
              <DigestLink label="close" digest={g.digests.close} />
            </div>
            {g.error && <div className="text-rose-400 text-sm text-center">{g.error}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
