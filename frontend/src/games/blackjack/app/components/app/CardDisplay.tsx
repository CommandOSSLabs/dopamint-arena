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

function CssCard({
  name,
  suit,
  size = "md",
  hidden,
}: {
  name: string;
  suit: string;
  size?: "sm" | "md";
  hidden?: boolean;
}) {
  if (hidden || !name || !suit) {
    return (
      <span
        className="qp-card qp-card--back"
        style={{
          width: size === "sm" ? "3.6rem" : "4.6rem",
          height: size === "sm" ? "5.0rem" : "6.4rem",
        }}
      />
    );
  }
  const symbol = SUIT_SYMBOLS[suit] || "";
  const isRed = suit === "hearts" || suit === "diamonds";
  const displayRank = name === "10" ? "T" : name;

  return (
    <span
      className={`qp-card${isRed ? " qp-card--red" : ""}`}
      style={{
        width: size === "sm" ? "3.6rem" : "4.6rem",
        height: size === "sm" ? "5.0rem" : "6.4rem",
        fontSize: size === "sm" ? "22px" : "28px",
      }}
    >
      {displayRank}
      {symbol}
    </span>
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
      <h3 className="qp-eyebrow mb-2">{title}</h3>

      <div className="flex items-center gap-3">
        <div className="qp-cardrow">
          {cardDetails.map((card, index) => (
            <CssCard
              key={index}
              name={card.name}
              suit={card.suit}
              size={isPlayer ? "md" : "sm"}
            />
          ))}
        </div>

        {cards.length > 0 && (
          <div
            className="flex items-center justify-center w-10 h-10 rounded-full border-2 border-[var(--qp-ink)] bg-[#fffdf6] text-[var(--qp-ink)] font-bold text-lg md:text-xl z-10"
            style={{ filter: "url(#qpRough)" }}
          >
            {sum}
          </div>
        )}
      </div>

      {/* Winning Indicator */}
      {isWinning && (
        <div className="mt-2 text-xs md:text-sm font-bold text-[var(--qp-amber)] flex items-center gap-1 qp-win">
          Winner
        </div>
      )}
    </div>
  );
};
