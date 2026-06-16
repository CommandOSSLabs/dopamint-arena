import React from "react";
import { SuitSpinner } from "@/components/general/SuitSpinner";
import { GameCardScale } from "@/components/general/GameCardScale";

interface LoadingModalProps {
  isOpen: boolean;
  message?: string;
}

export const LoadingModal: React.FC<LoadingModalProps> = ({
  isOpen,
  message = "Processing...",
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-[9999] flex items-center justify-center animate-fade-in transition-all p-4">
      <GameCardScale targetWidth={280} targetHeight={300}>
        <div className="bg-zinc-900/90 border-2 border-zinc-800 rounded-2xl p-8 w-full shadow-[0_25px_50px_-12px_rgba(0,0,0,0.8)] flex flex-col items-center justify-center relative overflow-hidden">
          {/* Top gold accent line */}
          <div className="h-1 w-full bg-gradient-to-r from-amber-600 via-amber-400 to-amber-600 absolute top-0 left-0" />

          {/* Rotating glowing card suits loader */}
          <div className="mb-5">
            <SuitSpinner />
          </div>

          {/* Loading Message */}
          <p className="text-sm font-bold text-center text-zinc-100 font-sans tracking-wide">
            {message}
          </p>
          <p className="text-[10px] text-zinc-500 text-center mt-1.5 font-bold uppercase tracking-widest font-mono">
            Please wait
          </p>
        </div>
      </GameCardScale>
    </div>
  );
};
