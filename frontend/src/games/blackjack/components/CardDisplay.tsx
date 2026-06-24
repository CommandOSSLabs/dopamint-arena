import { cardUrlFromIndex } from "../cardAssets";

interface CardDisplayProps {
  cards: number[]; // display indices 0..51
  sum: number; // authoritative total from the SDK (handValue)
  title: string;
  isWinning?: boolean;
  isPlayer?: boolean;
  className?: string;
}

export function CardDisplay({
  title,
  cards,
  sum,
  className,
  isWinning,
  isPlayer = false,
}: CardDisplayProps) {
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
    return { name, suit, url: cardUrlFromIndex(cardIndex) };
  });

  return (
    <div className={`flex flex-col w-full relative ${className || "items-center"}`}>
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
              <img
                key={index}
                src={card.url}
                alt={`${card.name} of ${card.suit}`}
                className="absolute w-20 rounded-md transition-all duration-300 hover:-translate-y-2"
                style={{
                  left: `${index * 20}px`,
                  zIndex: index,
                  filter: "drop-shadow(0px 6px 10px rgba(0,0,0,0.4))",
                  transform: isPlayer
                    ? `rotate(${rotation}deg) translateY(${translateY}px)`
                    : undefined,
                  transformOrigin: "bottom center",
                }}
              />
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
              <img
                key={index}
                src={card.url}
                alt={`${card.name} of ${card.suit}`}
                className="absolute w-24 rounded-lg transition-all duration-300 hover:-translate-y-3"
                style={{
                  left: `${index * 24}px`,
                  zIndex: index,
                  filter: "drop-shadow(0px 10px 15px rgba(0,0,0,0.5))",
                  transform: isPlayer
                    ? `rotate(${rotation}deg) translateY(${translateY}px)`
                    : undefined,
                  transformOrigin: "bottom center",
                }}
              />
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
}
