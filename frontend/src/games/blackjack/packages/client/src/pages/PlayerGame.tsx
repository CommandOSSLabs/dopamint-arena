import React, { useState, useEffect, useRef } from "react";
import { OwnedObjectsGrid } from "@/components/general/OwnedObjectsGrid";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { deriveWalletFromPrivateKey, createGameInitData, getCardSum } from "@poc/shared";
import { LoadingModal } from "@/components/general/LoadingModal";
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
import Confetti from "react-confetti";

export default function PlayerGame() {
  const suiClient = useSuiClient();
  const { address } = useCustomWallet();
  const [actionButtonClicked, setActionButtonClicked] = useState(false);

  const {
    action,
    createGame,
    gameId,
    isFetchingGame,
    betAmount,
    coinType,
    gameDepositAmount,
    playerBalance,
    dealerBalance,
    isStand,
    setIsStand,
    playerCards,
    dealerCards,
    playerCardsSum,
    dealerCardsSum,
    playerBusted,
    winner,
    dealerBusted,
    newBetAmount,
    setNewBetAmount,
    canContinue,
    settleing,
  } = useBlackJack();

  const [loadingMessage, setLoadingMessage] = useState("Processing move...");
  const [hudScale, setHudScale] = useState(1);
  const [tableScale, setTableScale] = useState(1);

  useEffect(() => {
    const handleResize = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      
      // HUD scale
      let hScale = 1;
      if (width < 768) {
        hScale = Math.max(Math.min(width / 420, height / 720, 1), 0.7);
      } else {
        if (height < 700) {
          hScale = Math.max(height / 700, 0.85);
        }
      }
      setHudScale(hScale);

      // Table scale
      let tScale = 1;
      if (width < 768) {
        tScale = Math.max(Math.min(width / 390, height / 680, 1), 0.7);
      } else {
        if (height < 750) {
          tScale = Math.max(height / 750, 0.8);
        }
      }
      setTableScale(tScale);
    };

    window.addEventListener("resize", handleResize);
    handleResize();
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const isInitialMount = useRef(true);

  // Show status toasts on winner / round completion
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }
    if (!winner) return;

    if (winner === "player") {
      if (dealerBusted) {
        toast.success("Dealer Busted! You Win! 🏆");
      } else {
        toast.success("You Win! 🏆");
      }
    } else if (winner === "dealer") {
      if (playerBusted) {
        toast.error("You Busted! Dealer Wins! 💸");
      } else {
        toast.error("Dealer Wins! 💸");
      }
    } else if (winner === "tie") {
      toast.success("It's a Tie! 🤝", {
        style: {
          border: "1px solid rgba(245, 158, 11, 0.8)",
          background: "rgba(69, 39, 0, 0.95)",
          color: "#f59e0b",
        },
        iconTheme: {
          primary: "#f59e0b",
          secondary: "#451a03",
        }
      });
    }
  }, [winner, dealerBusted, playerBusted]);

  const handleChipClick = (value: number) => {
    const increment = value * 10 ** 9;
    let nextBet = newBetAmount + increment;
    const maxLimit = Math.min(playerBalance, dealerBalance) * 10 ** 9;
    if (nextBet > maxLimit) {
      nextBet = maxLimit;
    }
    setNewBetAmount(nextBet);
  };

  const handleClearBet = () => {
    setNewBetAmount(0);
  };

  const handleAction = async (
    action_name: "HIT" | "STAND" | "CONTINUE" | "SETTLE"
  ) => {
    try {
      if (action_name === "HIT") setLoadingMessage("Drawing card...");
      else if (action_name === "STAND") setLoadingMessage("Dealer playing...");
      else if (action_name === "CONTINUE") setLoadingMessage("Shuffling & dealing next round...");
      else if (action_name === "SETTLE") setLoadingMessage("Settling bets...");
      setActionButtonClicked(true);
      await action(action_name);
      
      if (action_name === "HIT") {
        toast.success("Hit! Card drawn.");
      } else if (action_name === "STAND") {
        toast.success("Stand! Dealer's turn.");
      } else if (action_name === "CONTINUE") {
        toast.success("Dealing next hand. Good luck!");
      } else if (action_name === "SETTLE") {
        toast.success("Settling game...");
      }
    } catch (e: any) {
      toast.error("Action failed: " + (e?.message || e));
      throw e;
    } finally {
      setActionButtonClicked(false);
    }
  };

  const navigate = useNavigate();

  if (isFetchingGame) {
    return <PageLoader theme="game" message="Connecting to table..." />;
  }

  if (!gameId) {
    navigate("/player");
    return <></>;
  } else {
    return (
      <div className="h-screen w-screen flex flex-col relative text-white overflow-hidden select-none bg-zinc-950 fade-in-up">
        {/* Play Area: Takes up remaining height and displays the clean high-res desk/dealer background */}
        <div 
          className="flex-1 w-full relative bg-cover bg-center"
          style={{ backgroundImage: "url('/dealer-desk.png')" }}
        >
          {winner === "player" && (
            <div className="z-20">
              <Confetti
                initialVelocityY={20}
                gravity={0.3}
                numberOfPieces={200}
                recycle={false}
              />
            </div>
          )}

          {/* Subtle Back Button */}
          <button
            onClick={() => navigate("/player")}
            className="absolute top-4 left-4 z-30 p-2.5 text-zinc-400 hover:text-white bg-black/60 hover:bg-black/85 rounded-full border border-zinc-800/85 transition-all shadow-md active:scale-95 flex items-center justify-center cursor-pointer origin-top-left"
            style={{ transform: `scale(${tableScale})` }}
            title="Exit to Setup"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
          </button>

          {/* Dealer Name Badge */}
          <div 
            className="absolute top-4 left-1/2 -translate-x-1/2 px-4 py-1.5 bg-black/70 backdrop-blur-sm border border-amber-950 rounded-full shadow-lg z-10 flex items-center justify-center origin-top"
            style={{ transform: `translateX(-50%) scale(${tableScale})` }}
          >
            <span className="text-[10px] md:text-xs text-[#d4af37] font-extrabold uppercase tracking-widest font-serif">
              Liam (House)
            </span>
          </div>

          {/* Dealer Cards Container: Positioned on the dealer's side of the table felt */}
          <div 
            className="absolute top-[34%] md:top-[54%] left-1/2 -translate-x-1/2 z-20 w-full max-w-xs flex flex-col items-center origin-center"
            style={{ transform: `translateX(-50%) scale(${tableScale})` }}
          >
            <CardDisplay
              title=""
              cards={dealerCards}
              isWinning={winner === "dealer"}
            />
          </div>

          {/* Winner Text display banner */}
          <div 
            className="absolute top-[55%] md:top-[64%] left-1/2 -translate-x-1/2 z-20 flex items-center justify-center w-full h-10 origin-center"
            style={{ transform: `translateX(-50%) scale(${tableScale})` }}
          >
            {winner && (
              <div className="select-none">
                {winner === "player" ? (
                  <div className="px-6 py-2 bg-emerald-950/90 border-2 border-emerald-500/80 text-emerald-400 font-bold rounded-full text-xs md:text-sm shadow-xl backdrop-blur-sm animate-bounce">
                    {dealerBusted ? "Dealer Busted! You Win!" : "You Win!"}
                  </div>
                ) : winner === "dealer" ? (
                  <div className="px-6 py-2 bg-rose-950/90 border-2 border-rose-500/80 text-rose-400 font-bold rounded-full text-xs md:text-sm shadow-xl backdrop-blur-sm">
                    {playerBusted ? "You Busted! Dealer Wins!" : "Dealer Wins!"}
                  </div>
                ) : winner === "tie" ? (
                  <div className="px-6 py-2 bg-amber-950/90 border-2 border-amber-500/80 text-amber-400 font-bold rounded-full text-xs md:text-sm shadow-xl backdrop-blur-sm">
                    It's a Tie!
                  </div>
                ) : null}
              </div>
            )}
          </div>

          {/* Player Cards Container: Positioned on the player's side of the table felt */}
          <div 
            className="absolute top-[72%] md:top-[74%] left-1/2 -translate-x-1/2 z-20 w-full max-w-xs flex flex-col items-center origin-center"
            style={{ transform: `translateX(-50%) scale(${tableScale})` }}
          >
            <CardDisplay
              title=""
              cards={playerCards}
              isWinning={winner === "player"}
              isPlayer={true}
            />
            <div className="px-4 py-1.5 bg-black/40 border border-emerald-500/20 rounded-full shadow-inner select-none mt-2">
              <span className="text-xs font-bold uppercase tracking-[0.15em] text-[#d4af37]">You</span>
            </div>
          </div>
        </div>

        {/* Bottom Control panel HUD */}
        <div 
          className="w-full bg-zinc-950/95 backdrop-blur-md border-t border-zinc-800 shadow-[0_-10px_30px_rgba(0,0,0,0.95)] z-30 select-none flex items-center justify-center transition-all duration-75"
          style={{
            paddingTop: `${Math.max(4, 8 * hudScale)}px`,
            paddingBottom: `${Math.max(4, 8 * hudScale)}px`,
            paddingLeft: `${Math.min(24, 8 + 16 * hudScale)}px`,
            paddingRight: `${Math.min(24, 8 + 16 * hudScale)}px`,
          }}
        >
          {/* Desktop HUD Content (hidden on mobile) */}
          <div 
            className="hidden md:flex w-full flex-row items-center justify-between gap-4 origin-bottom"
            style={{ 
              transform: `scale(${hudScale})`,
              transformOrigin: "bottom center",
            }}
          >
            {/* Left Column: Balance, Bet and Chips */}
            <div className="flex flex-row items-center gap-4 w-auto">
              <div className="flex flex-col items-start gap-0.5">
                <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-zinc-500">
                  <span>Balance:</span>
                  <span className="text-white font-mono text-sm font-black">${playerBalance.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                </div>
                <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-zinc-500">
                  <span>Bet:</span>
                  <span className="text-white font-mono text-sm font-black">${(isStand && canContinue ? newBetAmount / 10 ** 9 : betAmount / 10 ** 9).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                </div>
              </div>

              <div 
                className={`flex items-center gap-1.5 p-1.5 rounded-full border border-zinc-850 shadow-inner transition-all duration-300 ${
                  isStand && canContinue 
                    ? "bg-black/45 opacity-100" 
                    : "bg-black/20 opacity-30 pointer-events-none grayscale"
                }`}
              >
                {[1, 5, 10, 20, 50, 100].map((val) => {
                  let chipBg = "bg-slate-600 border-slate-400 text-slate-100";
                  if (val === 5) chipBg = "bg-red-600 border-red-400 text-red-100";
                  else if (val === 10) chipBg = "bg-blue-600 border-blue-400 text-blue-100";
                  else if (val === 20) chipBg = "bg-emerald-600 border-emerald-400 text-emerald-100";
                  else if (val === 50) chipBg = "bg-purple-600 border-purple-400 text-purple-100";
                  else if (val === 100) chipBg = "bg-zinc-800 border-amber-500 text-amber-500";
                  return (
                    <button
                      key={val}
                      onClick={() => handleChipClick(val)}
                      disabled={actionButtonClicked || !(isStand && canContinue)}
                      className={`casino-chip !w-12 !h-12 !text-sm !border-[2.5px] ${chipBg} hover:scale-105 active:scale-95 transition-all disabled:opacity-50 cursor-pointer flex-shrink-0`}
                    >
                      ${val}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Center Column: Actions (Hit/Stand or Continue/Settle) */}
            <div className="flex items-center justify-center gap-3 w-auto">
              {actionButtonClicked ? (
                <div className="flex items-center justify-center gap-1 text-xs text-zinc-400 font-bold uppercase tracking-widest h-13 min-w-[220px]">
                  <span className="text-[#d4af37] animate-pulse">{loadingMessage}</span>
                  <span className="inline-flex gap-0.5">
                    <span className="animate-bounce" style={{ animationDelay: "0ms" }}>.</span>
                    <span className="animate-bounce" style={{ animationDelay: "150ms" }}>.</span>
                    <span className="animate-bounce" style={{ animationDelay: "300ms" }}>.</span>
                  </span>
                </div>
              ) : (
                <>
                  {isStand ? (
                    <div className="flex items-center gap-3 w-auto">
                      <button
                        className="border-2 border-zinc-650 text-white bg-zinc-900/60 hover:bg-zinc-650/20 px-8 py-3 rounded-lg text-sm font-black tracking-widest uppercase transition-all hover:scale-105 active:scale-95 cursor-pointer min-w-[130px] h-13 flex items-center justify-center"
                        onClick={() => handleAction("SETTLE")}
                        disabled={actionButtonClicked}
                      >
                        Settle
                      </button>

                      {canContinue && (
                        <button
                          className="border-2 border-amber-500 text-[#d4af37] bg-amber-950/20 hover:bg-amber-500 hover:text-black px-8 py-3 rounded-lg text-sm font-black tracking-widest uppercase transition-all hover:scale-105 active:scale-95 cursor-pointer min-w-[130px] h-13 flex items-center justify-center"
                          onClick={() => handleAction("CONTINUE")}
                          disabled={actionButtonClicked || newBetAmount === 0}
                        >
                          Deal Next
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 w-auto">
                      <button
                        className="border-2 border-emerald-500 text-white bg-[#032a14]/65 hover:bg-emerald-500 hover:text-black px-8 py-3 rounded-lg text-sm font-black tracking-widest uppercase transition-all hover:scale-105 active:scale-95 cursor-pointer min-w-[130px] h-13 flex items-center justify-center"
                        onClick={() => handleAction("HIT")}
                        disabled={actionButtonClicked}
                      >
                        Hit
                      </button>
                      <button
                        className="border-2 border-rose-500 text-white bg-[#2d090c]/65 hover:bg-rose-500/20 px-8 py-3 rounded-lg text-sm font-black tracking-widest uppercase transition-all hover:scale-105 active:scale-95 cursor-pointer min-w-[130px] h-13 flex items-center justify-center"
                        onClick={() => handleAction("STAND")}
                        disabled={actionButtonClicked}
                      >
                        Stand
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Right Column: Clear Bet button */}
            <div className="flex w-28 justify-end">
              {isStand && canContinue && newBetAmount > 0 && (
                <button
                  onClick={handleClearBet}
                  disabled={actionButtonClicked}
                  className="text-xs text-zinc-400 hover:text-white border-2 border-zinc-700/60 bg-zinc-900/60 hover:bg-zinc-800 px-3.5 py-2 rounded-lg transition-all font-bold uppercase hover:scale-105 active:scale-95 cursor-pointer"
                >
                  Clear Bet
                </button>
              )}
            </div>
          </div>

          {/* Mobile HUD Content (hidden on desktop) */}
          <div 
            className="flex md:hidden w-full flex-col"
            style={{ 
              gap: `${6 * hudScale}px`,
            }}
          >
            {/* Row 1: Chips */}
            <div 
              className={`flex items-center rounded-full border border-zinc-850 shadow-inner overflow-x-auto max-w-full justify-center w-full transition-all duration-300 ${
                isStand && canContinue 
                  ? "bg-black/45 opacity-100" 
                  : "bg-black/20 opacity-30 pointer-events-none grayscale"
              }`}
              style={{
                gap: `${4 * hudScale}px`,
                padding: `${4 * hudScale}px`,
              }}
            >
              {[1, 5, 10, 20, 50, 100].map((val) => {
                let chipBg = "bg-slate-600 border-slate-400 text-slate-100";
                if (val === 5) chipBg = "bg-red-600 border-red-400 text-red-100";
                else if (val === 10) chipBg = "bg-blue-600 border-blue-400 text-blue-100";
                else if (val === 20) chipBg = "bg-emerald-600 border-emerald-400 text-emerald-100";
                else if (val === 50) chipBg = "bg-purple-600 border-purple-400 text-purple-100";
                else if (val === 100) chipBg = "bg-zinc-800 border-amber-500 text-amber-500";
                return (
                  <button
                    key={val}
                    onClick={() => handleChipClick(val)}
                    disabled={actionButtonClicked || !(isStand && canContinue)}
                    className={`casino-chip ${chipBg} hover:scale-105 active:scale-95 transition-all disabled:opacity-50 cursor-pointer flex-shrink-0`}
                    style={{
                      "--chip-size": `${32 * hudScale}px`,
                      "--chip-font": `${10 * hudScale}px`,
                      "--chip-border": `${2 * hudScale}px`,
                      "--chip-inset": `${4 * hudScale}px`,
                      "--chip-inner-border": `${1 * hudScale}px`,
                    } as React.CSSProperties}
                  >
                    ${val}
                  </button>
                );
              })}
            </div>

            {/* Row 2: Stats & Actions */}
            <div className="w-full flex flex-row items-center justify-between" style={{ gap: `${12 * hudScale}px` }}>
              {/* Left Column: Balance, Bet */}
              <div className="flex flex-col items-start flex-shrink-0" style={{ gap: `${2 * hudScale}px` }}>
                <div className="flex items-center text-zinc-500 font-bold uppercase tracking-wider" style={{ gap: `${4 * hudScale}px`, fontSize: `${10 * hudScale}px` }}>
                  <span>Bal:</span>
                  <span className="text-white font-mono font-black" style={{ fontSize: `${12 * hudScale}px` }}>${playerBalance.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                </div>
                <div className="flex items-center text-zinc-500 font-bold uppercase tracking-wider" style={{ gap: `${4 * hudScale}px`, fontSize: `${10 * hudScale}px` }}>
                  <span>Bet:</span>
                  <span className="text-white font-mono font-black" style={{ fontSize: `${12 * hudScale}px` }}>${(isStand && canContinue ? newBetAmount / 10 ** 9 : betAmount / 10 ** 9).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
                  {isStand && canContinue && newBetAmount > 0 && (
                    <button
                      onClick={handleClearBet}
                      disabled={actionButtonClicked}
                      className="ml-1 text-zinc-400 hover:text-white border border-zinc-700 bg-zinc-900 font-bold uppercase active:scale-95 cursor-pointer flex items-center justify-center"
                      style={{
                        padding: `${2 * hudScale}px ${4 * hudScale}px`,
                        fontSize: `${8 * hudScale}px`,
                        borderRadius: `${4 * hudScale}px`,
                        height: `${14 * hudScale}px`,
                      }}
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>

              {/* Right Column: Actions */}
              <div className="flex items-center justify-end flex-1" style={{ gap: `${8 * hudScale}px` }}>
                {actionButtonClicked ? (
                  <div 
                    className="flex items-center justify-center text-zinc-400 font-bold uppercase tracking-wider flex-1"
                    style={{
                      gap: `${4 * hudScale}px`,
                      fontSize: `${10 * hudScale}px`,
                      height: `${32 * hudScale}px`,
                    }}
                  >
                    <span className="text-[#d4af37] animate-pulse">{loadingMessage}</span>
                    <span className="inline-flex gap-0.5">
                      <span className="animate-bounce" style={{ animationDelay: "0ms" }}>.</span>
                      <span className="animate-bounce" style={{ animationDelay: "150ms" }}>.</span>
                      <span className="animate-bounce" style={{ animationDelay: "300ms" }}>.</span>
                    </span>
                  </div>
                ) : (
                  <>
                    {isStand ? (
                      <div className="flex items-center w-full justify-end" style={{ gap: `${8 * hudScale}px` }}>
                        <button
                          className="border border-zinc-650 text-white bg-zinc-900/60 hover:bg-zinc-650/20 font-black tracking-wider uppercase transition-all active:scale-95 cursor-pointer flex items-center justify-center"
                          onClick={() => handleAction("SETTLE")}
                          disabled={actionButtonClicked}
                          style={{
                            height: `${32 * hudScale}px`,
                            fontSize: `${10 * hudScale}px`,
                            minWidth: `${65 * hudScale}px`,
                            padding: `0 ${12 * hudScale}px`,
                            borderRadius: `${6 * hudScale}px`,
                          }}
                        >
                          Settle
                        </button>

                        {canContinue && (
                          <button
                            className="border border-amber-500 text-[#d4af37] bg-amber-950/20 hover:bg-amber-500 hover:text-black font-black tracking-wider uppercase transition-all active:scale-95 cursor-pointer flex items-center justify-center"
                            onClick={() => handleAction("CONTINUE")}
                            disabled={actionButtonClicked || newBetAmount === 0}
                            style={{
                              height: `${32 * hudScale}px`,
                              fontSize: `${10 * hudScale}px`,
                              minWidth: `${75 * hudScale}px`,
                              padding: `0 ${12 * hudScale}px`,
                              borderRadius: `${6 * hudScale}px`,
                            }}
                          >
                            Deal Next
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className="flex items-center w-full justify-end" style={{ gap: `${8 * hudScale}px` }}>
                        <button
                          className="border border-emerald-500 text-white bg-[#032a14]/65 hover:bg-emerald-500 hover:text-black font-black tracking-wider uppercase transition-all active:scale-95 cursor-pointer flex items-center justify-center"
                          onClick={() => handleAction("HIT")}
                          disabled={actionButtonClicked}
                          style={{
                            height: `${32 * hudScale}px`,
                            fontSize: `${10 * hudScale}px`,
                            minWidth: `${65 * hudScale}px`,
                            padding: `0 ${12 * hudScale}px`,
                            borderRadius: `${6 * hudScale}px`,
                          }}
                        >
                          Hit
                        </button>
                        <button
                          className="border border-rose-500 text-white bg-[#2d090c]/65 hover:bg-rose-500/20 font-black tracking-wider uppercase transition-all active:scale-95 cursor-pointer flex items-center justify-center"
                          onClick={() => handleAction("STAND")}
                          disabled={actionButtonClicked}
                          style={{
                            height: `${32 * hudScale}px`,
                            fontSize: `${10 * hudScale}px`,
                            minWidth: `${65 * hudScale}px`,
                            padding: `0 ${12 * hudScale}px`,
                            borderRadius: `${6 * hudScale}px`,
                          }}
                        >
                          Stand
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
