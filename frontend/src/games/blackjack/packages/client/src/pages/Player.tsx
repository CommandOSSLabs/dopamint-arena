import React, { useEffect, useState } from "react";
import { OwnedObjectsGrid } from "@/components/general/OwnedObjectsGrid";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { deriveWalletFromPrivateKey, createGameInitData, getCardSum } from "@poc/shared";
import { bcs } from "@mysten/bcs";
import {
  getPublicKey as getBlsPublicKey,
  sign as blsSign,
  utils as blsUtils,
  verify as blsVerify,
} from "@noble/bls12-381";
import { fromHEX, toHEX } from "@mysten/bcs";
import { CardDisplay } from "@/components/app/CardDisplay";
import { useSuiClient } from "@mysten/dapp-kit";
import { useCustomWallet } from "@/contexts/CustomWallet";
import useBlackJack from "@/hooks/useBlackJack";
import toast from "react-hot-toast";
import { useNavigate } from "react-router-dom";
import { addGameActionData } from "@/lib/utils/indexedDB";
import { PageLoader } from "@/components/general/PageLoader";
import { GameCardScale } from "@/components/general/GameCardScale";
import { useRequestSui } from "@/hooks/useRequestSui";
import { LoadingModal } from "@/components/general/LoadingModal";
import { useAuthentication } from "@/contexts/Authentication";
import { useBalance } from "@/contexts/BalanceContext";
import { toFixedWithoutRounding } from "@/lib/utils/toFixedWithoutRounding";
import { useRequestBuck } from "@/hooks/useRequestBuck";

export default function Player() {
  const suiClient = useSuiClient();

  const { handleLogout } = useAuthentication();
  const { logout: walletLogout, address } = useCustomWallet();

  const { createGame, isFetchingGame, gameId, isCreatingGame } = useBlackJack();
  const navigate = useNavigate();

  const { handleRequestBuck, loading: requestingBuck } = useRequestBuck();
  const { balance } = useBalance();

  const [depositAmount, setDepositAmount_] = useState<string>("");
  const [betAmountInput, setBetAmountInput_] = useState<string>("");

  // useEffect(() => {
  //   if (router && !address) {
  //     router.push("/");
  //   }
  // }, [router, address]);

  const setDepositAmount = (value: string) => {
    let coinType = import.meta.env.VITE_COIN_TYPE || "";
    if (coinType === "0x2::sui::SUI" && parseFloat(value) > balance) {
      value = (balance - 0.000002).toString();
      toast.success("Some Sui reserved for gas fees");
    }
    if (parseFloat(value) < 0.1) {
      value = "0";
    }

    value = toFixedWithoutRounding(parseFloat(value), 2).toString();
    value = parseFloat(value).toString();
    console.log({ balance, value });

    setDepositAmount_(value);
  };

  const setBetAmountInput = (value: string) => {
    if (parseFloat(value) < 0.1) {
      value = "0";
    }
    if (parseFloat(depositAmount) < parseFloat(value)) {
      console.log({ depositAmount, value });
      value = depositAmount;
    }
    value = parseFloat(value).toFixed(2);
    value = parseFloat(value).toString();

    setBetAmountInput_(value);
  };

  const handleCreateGame = async () => {
    try {
      const deposit = parseFloat(depositAmount);
      const bet = parseFloat(betAmountInput);

      if (deposit > 0 && bet > 0) {
        if (bet > deposit) {
          toast.error("Bet amount should be less than deposit amount");
          return;
        }
        let coinType = import.meta.env.VITE_COIN_TYPE as string;
        await createGame({
          amount: deposit * 10 ** 9,
          betAmount: bet * 10 ** 9,
          coinType,
        });
        toast.success(`Game Created`);
      }
    } catch (e: any) {
      console.error(e);
      toast.error("Error: " + e.message);
    }
  };

  const handleDealerDeposit = () => {
    navigate("/dealer");
  };

  if (isFetchingGame) {
    return <PageLoader theme="lobby" message="Retrieving active game session..." />;
  }

  if (gameId) {
    navigate(`/player/game`);
    return <></>;
  }

  const selectBetChip = (value: number) => {
    setBetAmountInput(value.toString());
    if (!depositAmount || parseFloat(depositAmount) < value) {
      setDepositAmount((value * 5).toString()); // Sensible deposit (5 rounds of play)
    }
  };

  if (gameId) {
    navigate(`/player/game`);
    return <></>;
  }

  return (
    <div className="w-screen h-screen flex flex-col items-center justify-center menu-background relative text-white overflow-hidden select-none">
      <GameCardScale>
        <div className="bg-zinc-950/90 border border-zinc-800 rounded-2xl p-6 md:p-8 w-full max-w-md shadow-2xl z-10 fade-in-up">
          <h2 className="text-3xl font-extrabold text-center text-gold font-serif mb-6 tracking-widest uppercase">
            GAME SETUP
          </h2>
          
          <div className="mb-6 p-4 bg-zinc-900/60 border border-zinc-800/80 rounded-xl flex items-center justify-between">
            <span className="text-sm text-zinc-400 font-medium">Your {import.meta.env.VITE_COIN_SYMBOL} Balance:</span>
            <span className="text-xl font-bold text-gold font-mono">
              ${toFixedWithoutRounding(balance, 2)}
            </span>
          </div>

          {/* Deposit Amount Input */}
          <div className="mb-5">
            <label
              className="block text-zinc-400 text-xs font-bold uppercase tracking-wider mb-2"
              htmlFor="depositAmount"
            >
              Deposit Amount ({import.meta.env.VITE_COIN_SYMBOL}):
            </label>
            <input
              type="number"
              inputMode="decimal"
              id="depositAmount"
              className="w-full bg-zinc-900 border border-zinc-800 rounded-xl py-3 px-4 text-white placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-amber-500/50 focus:border-amber-500/50 font-mono text-lg transition-all"
              placeholder="0.00"
              value={depositAmount}
              onChange={(e) => setDepositAmount(e.target.value)}
              min="0"
              step="0.01"
            />
          </div>

          {/* Bet Amount Input with Chips */}
          <div className="mb-6">
            <label
              className="block text-zinc-400 text-xs font-bold uppercase tracking-wider mb-2"
              htmlFor="betAmount"
            >
              Bet Amount Each Round ({import.meta.env.VITE_COIN_SYMBOL}):
            </label>
            <input
              type="number"
              inputMode="decimal"
              id="betAmount"
              className="w-full bg-zinc-900 border border-zinc-800 rounded-xl py-3 px-4 text-white placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-amber-500/50 focus:border-amber-500/50 font-mono text-lg transition-all"
              placeholder="0.00"
              value={betAmountInput}
              onChange={(e) => setBetAmountInput(e.target.value)}
              min="0"
              step="0.01"
            />

            {/* Quick Chip Selection */}
            <div className="flex justify-between items-center mt-3 bg-zinc-900/30 p-2 rounded-xl border border-zinc-800/20">
              <span className="text-[10px] text-zinc-500 uppercase font-bold tracking-wider pl-1">Quick Bet:</span>
              <div className="flex gap-1.5 flex-wrap justify-end">
                {[1, 5, 10, 20, 50, 100].map((val) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => selectBetChip(val)}
                    className="w-8 h-8 rounded-full border-2 border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-[10px] font-bold text-zinc-300 hover:text-white transition-all shadow-md active:scale-95"
                  >
                    {val}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-3">
            <button
              className="bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-zinc-950 font-black py-3.5 px-4 rounded-xl w-full text-base uppercase tracking-widest shadow-lg transition-all gold-glow-hover active:scale-95"
              onClick={() => handleCreateGame()}
            >
              Confirm &amp; Deal
            </button>
            <button
              className="bg-zinc-800 hover:bg-zinc-700 text-zinc-350 hover:text-white font-bold py-3 px-4 rounded-xl w-full border border-zinc-700 text-xs uppercase tracking-wider transition-all active:scale-95"
              onClick={() => navigate("/")}
            >
              Back to Menu
            </button>
          </div>
        </div>
      </GameCardScale>

      <LoadingModal isOpen={isCreatingGame} message="Creating game and shuffling cards..." />
    </div>
  );
}
