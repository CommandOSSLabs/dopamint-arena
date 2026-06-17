import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { ConnectButton, useCurrentAccount } from "@mysten/dapp-kit";
import { usePvpBlackjack } from "@/hooks/usePvpBlackjack";
import { CardDisplay } from "@/components/app/CardDisplay";
import { handToCardIndices, handValue } from "@/lib/bjCards";

const fmt = (mist: bigint) => (Number(mist) / 1e9).toFixed(3);

export default function PvpBlackjack() {
  const g = usePvpBlackjack();
  const navigate = useNavigate();
  const account = useCurrentAccount();
  useEffect(() => { document.title = "Blackjack — PvP"; }, []);
  const funded = g.walletBalance > 20_000_000n;

  // PvP needs a connected wallet (it funds + receives winnings). Normally you arrive here
  // already connected via the menu; guard direct navigation.
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

  return (
    <div className="w-screen h-screen flex flex-col items-center justify-center menu-background text-white p-4 overflow-auto select-none">
      <div className="bg-zinc-950/90 border border-zinc-800 rounded-2xl p-6 w-full max-w-2xl shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-2xl font-black text-gold uppercase tracking-widest">Blackjack · PvP</h1>
          <button onClick={() => { g.leave(); navigate("/"); }} className="text-xs text-zinc-400 hover:text-white">← menu</button>
        </div>

        <div className="text-[11px] text-zinc-500 mb-4 font-mono break-all">
          wallet {g.walletAddress.slice(0, 10)}… · {fmt(g.walletBalance)} SUI
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
          <div className="text-center text-amber-400 py-8 animate-pulse">
            {g.phase === "opening" ? "Opening tunnel on-chain…" : "Funding your seat…"}
          </div>
        )}

        {(g.phase === "playing" || g.phase === "settling" || g.phase === "done") && g.state && (
          <div className="flex flex-col gap-4">
            <CardDisplay title="Dealer" cards={handToCardIndices(g.dealerHand, 999)} sum={g.phase === "done" ? handValue(g.dealerHand) : 0} />
            <div className="grid grid-cols-2 gap-3">
              <CardDisplay title={`You (${g.role})`} cards={handToCardIndices(g.myHand, 1)} sum={handValue(g.myHand)} isPlayer />
              <CardDisplay title="Opponent" cards={handToCardIndices(g.oppHand, 2)} sum={handValue(g.oppHand)} />
            </div>

            <label className="flex items-center gap-2 text-sm text-zinc-300">
              <input type="checkbox" checked={g.auto} onChange={(e) => g.setAuto(e.target.checked)} />
              Auto (let my bot play)
            </label>

            {g.phase === "playing" && (
              <div className="flex gap-3">
                <button onClick={g.hit} disabled={!g.myTurn || g.auto} className="flex-1 bg-amber-600 disabled:opacity-30 text-zinc-950 font-black py-3 rounded-xl">Hit</button>
                <button onClick={g.stand} disabled={!g.myTurn || g.auto} className="flex-1 bg-zinc-700 disabled:opacity-30 font-black py-3 rounded-xl">Stand</button>
              </div>
            )}
            {!g.myTurn && g.phase === "playing" && <div className="text-center text-zinc-400 text-sm">Opponent's turn…</div>}
            {g.phase === "settling" && <div className="text-center text-amber-400 animate-pulse">Settling on-chain…</div>}
            {g.phase === "done" && (
              <div className="text-center">
                <div className={`text-3xl font-black ${g.result === "win" ? "text-emerald-400" : g.result === "lose" ? "text-rose-400" : "text-zinc-300"}`}>
                  {g.result === "win" ? "You win!" : g.result === "lose" ? "You lose" : "Push"}
                </div>
                <button onClick={() => { g.leave(); g.queue(); }} className="mt-4 bg-amber-600 text-zinc-950 font-black px-6 py-3 rounded-xl">Rematch</button>
              </div>
            )}

            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-500 font-mono">
              {g.digests.create && <a className="underline" target="_blank" rel="noreferrer" href={`https://suiscan.xyz/testnet/tx/${g.digests.create}`}>open {g.digests.create.slice(0, 6)}…</a>}
              {g.digests.deposit && <a className="underline" target="_blank" rel="noreferrer" href={`https://suiscan.xyz/testnet/tx/${g.digests.deposit}`}>deposit {g.digests.deposit.slice(0, 6)}…</a>}
              {g.digests.close && <a className="underline" target="_blank" rel="noreferrer" href={`https://suiscan.xyz/testnet/tx/${g.digests.close}`}>close {g.digests.close.slice(0, 6)}…</a>}
            </div>
            {g.error && <div className="text-rose-400 text-sm">{g.error}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
