import React from "react";
import { SuitSpinner } from "@/components/general/SuitSpinner";
import { GameCardScale } from "@/components/general/GameCardScale";

interface PageLoaderProps {
  theme?: "lobby" | "game";
  message?: string;
}

export const PageLoader: React.FC<PageLoaderProps> = ({
  theme = "lobby",
  message = "Syncing with blockchain...",
}) => {
  if (theme === "game") {
    return (
      <div 
        className="w-screen h-screen flex items-center justify-center bg-cover bg-center relative select-none overflow-hidden"
        style={{ backgroundImage: "url('/dealer-desk.png')" }}
      >
        <div className="absolute inset-0 bg-black/55 backdrop-blur-md" />
        <GameCardScale targetWidth={320} targetHeight={360}>
          <div className="bg-zinc-950/90 border border-zinc-800/80 rounded-2xl p-8 w-full shadow-[0_25px_50px_-12px_rgba(0,0,0,0.9)] flex flex-col items-center justify-center relative overflow-hidden z-10 fade-in-up">
            {/* Top gold accent line */}
            <div className="h-1 w-full bg-gradient-to-r from-amber-600 via-amber-400 to-amber-600 absolute top-0 left-0" />

            {/* Rotating glowing card suits loader */}
            <div className="mb-5">
              <SuitSpinner />
            </div>

            <p className="text-sm font-bold text-center text-zinc-100 font-sans tracking-wide">
              {message}
            </p>
            <p className="text-[10px] text-[#d4af37] text-center mt-1.5 font-extrabold uppercase tracking-widest font-mono">
              Entering Table
            </p>
          </div>
        </GameCardScale>
      </div>
    );
  }

  // Lobby theme
  return (
    <div className="w-screen h-screen flex items-center justify-center menu-background relative text-white select-none overflow-hidden">
      <GameCardScale targetWidth={320} targetHeight={360}>
        <div className="bg-zinc-950/90 border border-zinc-800/85 rounded-2xl p-8 w-full shadow-[0_25px_50px_-12px_rgba(0,0,0,0.9)] flex flex-col items-center justify-center relative overflow-hidden z-10 fade-in-up">
          {/* Top gold accent line */}
          <div className="h-1 w-full bg-gradient-to-r from-amber-600 via-amber-400 to-amber-600 absolute top-0 left-0" />

          {/* Rotating glowing card suits loader */}
          <div className="mb-5">
            <SuitSpinner />
          </div>

          <p className="text-sm font-bold text-center text-zinc-100 font-sans tracking-wide">
            {message}
          </p>
          <p className="text-[10px] text-[#d4af37] text-center mt-1.5 font-extrabold uppercase tracking-widest font-mono">
            Loading Casino
          </p>
        </div>
      </GameCardScale>
    </div>
  );
};
