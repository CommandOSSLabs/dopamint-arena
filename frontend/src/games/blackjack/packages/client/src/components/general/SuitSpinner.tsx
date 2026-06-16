import React, { useEffect, useState } from "react";

export const SuitSpinner: React.FC = () => {
  const suits = [
    { char: "♠", color: "text-[#d4af37]", shadow: "drop-shadow-[0_0_10px_rgba(212,175,55,0.8)]" },
    { char: "♥", color: "text-rose-500", shadow: "drop-shadow-[0_0_10px_rgba(244,63,94,0.8)]" },
    { char: "♦", color: "text-amber-500", shadow: "drop-shadow-[0_0_10px_rgba(245,158,11,0.8)]" },
    { char: "♣", color: "text-emerald-500", shadow: "drop-shadow-[0_0_10px_rgba(16,185,129,0.8)]" },
  ];

  const [index, setIndex] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setIndex((prev) => (prev + 1) % suits.length);
    }, 600);
    return () => clearInterval(timer);
  }, [suits.length]);

  const currentSuit = suits[index];

  return (
    <div className="relative w-16 h-16 flex items-center justify-center">
      {/* Outer pulsing ring */}
      <div className="absolute inset-0 rounded-full border-2 border-amber-500/20 animate-ping" />
      
      {/* Middle rotating ring */}
      <div className="absolute w-14 h-14 rounded-full border-4 border-t-amber-500 border-r-transparent border-b-amber-500/30 border-l-transparent animate-spin" />

      {/* Inner cycling suit symbol */}
      <span 
        key={index}
        className={`text-3xl font-serif select-none absolute suit-anim ${currentSuit.color} ${currentSuit.shadow}`}
      >
        {currentSuit.char}
      </span>
    </div>
  );
};
