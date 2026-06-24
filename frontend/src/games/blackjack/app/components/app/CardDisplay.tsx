import React from "react";

interface CardDisplayProps {
  title: string;
  cards: number[];
  sum: number;
  className?: string;
  isWinning?: boolean;
  isPlayer?: boolean;
}

const SUIT_SYMBOLS: Record<string, string> = {
  clubs: "♣",
  diamonds: "♦",
  hearts: "♥",
  spades: "♠",
};

const SUIT_COLORS: Record<string, string> = {
  clubs: "text-zinc-950",
  diamonds: "text-red-600",
  hearts: "text-red-600",
  spades: "text-zinc-950",
};

function CssCard({
  name,
  suit,
  size = "md",
}: {
  name: string;
  suit: string;
  size?: "sm" | "md";
}) {
  const symbol = SUIT_SYMBOLS[suit] || "";
  const colorClass = SUIT_COLORS[suit] || "text-zinc-950";

  const width = size === "sm" ? "80px" : "96px";
  const height = size === "sm" ? "112px" : "140px";
  const fontSizeVal = size === "sm" ? "text-sm" : "text-base";
  const fontSizeSym = size === "sm" ? "text-xs" : "text-sm";
  const centerSymSize = size === "sm" ? "text-2xl" : "text-4xl";

  return (
    <div
      className={`bg-white border border-zinc-200 rounded-lg shadow-md select-none relative flex flex-col justify-between p-1.5 md:p-2 ${colorClass}`}
      style={{ width, height, fontStyle: "normal" }}
    >
      {/* Top Left */}
      <div className="flex flex-col items-center leading-none self-start">
        <span className={`font-mono font-bold ${fontSizeVal}`}>{name}</span>
        <span className={fontSizeSym}>{symbol}</span>
      </div>

      {/* Center Symbol */}
      <div
        className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 font-bold ${centerSymSize}`}
      >
        {symbol}
      </div>

      {/* Bottom Right */}
      <div className="flex flex-col items-center leading-none self-end transform rotate-180">
        <span className={`font-mono font-bold ${fontSizeVal}`}>{name}</span>
        <span className={fontSizeSym}>{symbol}</span>
      </div>
    </div>
  );
}

export const CardDisplay: React.FC<CardDisplayProps> = ({
  title,
  cards,
  sum,
  className,
  isWinning,
  isPlayer = false,
}) => {
  const suits = ["clubs", "diamonds", "hearts", "spades"];
  const names = [
    "A",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
    "9",
    "10",
    "J",
    "Q",
    "K",
  ];

  const cardDetails = cards.map((cardIndex) => {
    const suit = suits[Math.floor(cardIndex / 13)];
    const name = names[cardIndex % 13];
    return { name, suit };
  });

  return (
    <div className={"flex flex-col items-center w-full relative " + className}>
      {/* Title */}
      <h3 className="text-sm uppercase font-semibold tracking-wider text-emerald-200/60 mb-2">
        {title}
      </h3>

      <div className="relative h-28 md:h-36 flex justify-center items-center">
        {/* Card Stack Mobile */}
        <div
          className="relative md:hidden flex justify-center"
          style={{ width: `${cards.length * 20 + 80}px`, height: "110px" }}
        >
          {cardDetails.map((card, index) => {
            const centerIndex = (cards.length - 1) / 2;
            const rotation = isPlayer ? (index - centerIndex) * 6 : 0;
            const translateY = isPlayer ? Math.abs(index - centerIndex) * 3 : 0;
            return (
              <div
                key={index}
                className="absolute transition-all duration-300 hover:-translate-y-2"
                style={{
                  left: `${index * 20}px`,
                  zIndex: index,
                  transform: isPlayer
                    ? `rotate(${rotation}deg) translateY(${translateY}px)`
                    : undefined,
                  transformOrigin: "bottom center",
                }}
              >
                <CssCard name={card.name} suit={card.suit} size="sm" />
              </div>
            );
          })}
          {cards.length > 0 && (
            <div className="absolute -right-4 top-1/2 -translate-y-1/2 flex items-center justify-center w-8 h-8 rounded-full border-2 border-[#d4af37] bg-[#2a1708] text-[#d4af37] font-bold text-sm shadow-lg z-10">
              {sum}
            </div>
          )}
        </div>

        {/* Card Stack Desktop */}
        <div
          className="relative hidden md:block"
          style={{ width: `${cards.length * 24 + 96}px`, height: "140px" }}
        >
          {cardDetails.map((card, index) => {
            const centerIndex = (cards.length - 1) / 2;
            const rotation = isPlayer ? (index - centerIndex) * 6 : 0;
            const translateY = isPlayer ? Math.abs(index - centerIndex) * 4 : 0;
            return (
              <div
                key={index}
                className="absolute transition-all duration-300 hover:-translate-y-3"
                style={{
                  left: `${index * 24}px`,
                  zIndex: index,
                  transform: isPlayer
                    ? `rotate(${rotation}deg) translateY(${translateY}px)`
                    : undefined,
                  transformOrigin: "bottom center",
                }}
              >
                <CssCard name={card.name} suit={card.suit} size="md" />
              </div>
            );
          })}
          {cards.length > 0 && (
            <div className="absolute -right-5 top-1/2 -translate-y-1/2 flex items-center justify-center w-9 h-9 rounded-full border-2 border-[#d4af37] bg-[#2a1708] text-[#d4af37] font-bold text-base shadow-lg z-10">
              {sum}
            </div>
          )}
        </div>
      </div>

      {/* Winning Indicator */}
      {isWinning && (
        <div className="mt-2 text-xs md:text-sm font-bold text-[#d4af37] flex items-center gap-1 animate-pulse">
          🏆 Winner
        </div>
      )}
    </div>
  );
};
