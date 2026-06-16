import React, { useState } from "react";
import { OwnedObjectsGrid } from "@/components/general/OwnedObjectsGrid";
import { LoadingModal } from "@/components/general/LoadingModal";
import { Transaction } from "@mysten/sui/transactions";
import { BlackJackMoveClient } from "@poc/shared";
import { useCustomWallet } from "@/contexts/CustomWallet";
import { useResolveSuiNSName, useSuiClient } from "@mysten/dapp-kit";
import { getCoinInput } from "@/lib/utils/getCoinInput";
import useBlackJack from "@/hooks/useBlackJack";
import { displayAddress } from "@/lib/utils/displayAddress";
import { useNavigate } from "react-router-dom";
import { GameCardScale } from "@/components/general/GameCardScale";
import { toFixedWithoutRounding } from "@/lib/utils/toFixedWithoutRounding";
import { useBalance } from "@/contexts/BalanceContext"; // Assuming you have this context as in PlayerHomePage
import toast from "react-hot-toast";

export default function Dealer() {
  const suiClient = useSuiClient();
  const navigate = useNavigate();
  const { executeTransactionBlockWithoutSponsorship, address } =
    useCustomWallet();
  const { createGameManager, createGame, depositFunds, gameManager } =
    useBlackJack();
  const { balance } = useBalance(); // Assuming you have a balance context similar to PlayerHomePage

  const [depositAmount, setDepositAmount_] = useState<string>("");
  const [isDepositing, setIsDepositing] = useState(false);

  const setDepositAmount = (value: string) => {
    let coinType = import.meta.env.VITE_COIN_TYPE || "";

    if (
      coinType === "0x2::sui::SUI" &&
      parseFloat(value) >= balance - 0.000002
    ) {
      toast.success("Some SUI reserved for gas fees");
      value = (balance - 0.000002).toString();
    }
    if (parseFloat(value) < 0.1) {
      value = "0";
    }

    value = toFixedWithoutRounding(parseFloat(value), 2).toString();
    value = parseFloat(value).toString();
    console.log({ balance, value });

    setDepositAmount_(value);
  };

  const handleDepositFunds = async () => {
    const amount = parseFloat(depositAmount);
    if (amount > 0) {
      try {
        setIsDepositing(true);
        await depositFunds({
          coinType: import.meta.env.VITE_COIN_TYPE || "",
          amount: amount * 10 ** 9,
        });
        setDepositAmount("");
        toast.success("Deposit successful!");
      } catch (e: any) {
        toast.error("Deposit failed: " + (e?.message || e));
      } finally {
        setIsDepositing(false);
      }
    }
  };

  return (
    <div className="w-screen h-screen flex flex-col items-center justify-center menu-background relative text-white select-none overflow-hidden">
      <GameCardScale>
        <div className="bg-zinc-950/90 border border-zinc-800 rounded-2xl p-6 md:p-8 w-full max-w-md shadow-2xl z-10 relative overflow-hidden fade-in-up">
          {/* Top gold accent line */}
          <div className="h-1 w-full bg-gradient-to-r from-amber-600 via-amber-400 to-amber-600 absolute top-0 left-0" />

          <h2 className="text-xl font-black text-[#d4af37] font-serif tracking-wider mb-1 text-center uppercase">
            Dealer Profit Sharing
          </h2>
          <p className="text-zinc-500 text-[10px] text-center mb-6 font-bold uppercase tracking-widest">
            Stake & Earn House Profit
          </p>

          {/* Dealer Info Box */}
          <div className="bg-black/40 border border-zinc-800/80 rounded-xl p-4 mb-5 space-y-3">
            <div className="flex justify-between items-center pb-2.5 border-b border-zinc-800/60">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Dealer Address</span>
              <span className="font-mono text-xs font-semibold text-zinc-300">
                {displayAddress(gameManager?.dealer) || "Loading..."}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Dealer Pool Balance</span>
              <span className="font-mono text-sm font-black text-emerald-400">
                {gameManager?.balance
                  ? (gameManager.balance / 10 ** 9).toLocaleString(undefined, { minimumFractionDigits: 2 })
                  : "Loading..."}{" "}
                SUI
              </span>
            </div>
          </div>

          {/* User Stats Box */}
          <div className="bg-zinc-950/50 border border-zinc-850 rounded-xl p-4 mb-5 space-y-3">
            <div className="flex justify-between items-center text-[10px] font-bold uppercase tracking-wider text-zinc-500">
              <span>Your Stake Percentage</span>
              <span className="text-[#d4af37] font-mono text-xs font-black">0%</span>
            </div>
            <div className="flex justify-between items-center text-[10px] font-bold uppercase tracking-wider text-zinc-500">
              <span>Your Stake Value</span>
              <span className="text-zinc-300 font-mono text-xs font-extrabold">0 {import.meta.env.VITE_COIN_SYMBOL}</span>
            </div>
            <div className="pt-2.5 border-t border-zinc-850/60 flex justify-between items-center">
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Your Wallet Balance</span>
              <span className="font-mono text-xs font-extrabold text-white">
                {toFixedWithoutRounding(balance, 2)} {import.meta.env.VITE_COIN_SYMBOL}
              </span>
            </div>
          </div>

          {/* Input Field */}
          <div className="mb-6 space-y-2">
            <label
              className="block text-[10px] font-bold uppercase tracking-wider text-zinc-400 mb-1.5"
              htmlFor="depositAmount"
            >
              Deposit Amount ({import.meta.env.VITE_COIN_SYMBOL}):
            </label>
            <div className="relative flex items-center">
              <input
                type="number"
                inputMode="decimal"
                id="depositAmount"
                className="w-full bg-black/60 border-2 border-zinc-800 rounded-xl py-3 px-4 pl-4 pr-16 text-white leading-tight font-mono focus:outline-none focus:border-amber-500/80 transition-all text-sm"
                placeholder="0.00"
                value={depositAmount}
                onChange={(e) => setDepositAmount(e.target.value)}
                min="0"
                step="0.01"
              />
              <div className="absolute right-4 text-[10px] font-black uppercase tracking-wider text-zinc-500">
                {import.meta.env.VITE_COIN_SYMBOL}
              </div>
            </div>
          </div>

          {/* Buttons */}
          <div className="space-y-3">
            <button
              className="border-2 border-amber-500 text-[#d4af37] bg-amber-950/20 hover:bg-amber-500 hover:text-black font-black py-3 px-4 rounded-xl w-full tracking-widest text-xs uppercase transition-all hover:scale-[1.02] active:scale-98 cursor-pointer shadow-lg shadow-amber-950/20 flex items-center justify-center h-12"
              onClick={() => handleDepositFunds()}
            >
              Deposit Funds
            </button>
            
            <button
              className="text-zinc-400 hover:text-white border-2 border-zinc-800/80 bg-zinc-900/40 hover:bg-zinc-850 px-4 py-3 rounded-xl transition-all font-bold uppercase hover:scale-[1.02] active:scale-98 cursor-pointer w-full text-center h-12 flex items-center justify-center text-xs tracking-wider"
              onClick={() => {
                navigate("/player");
              }}
            >
              Go to Player
            </button>
          </div>
        </div>
      </GameCardScale>

      <LoadingModal isOpen={isDepositing} message="Depositing funds into dealer pool..." />
    </div>
  );
}
