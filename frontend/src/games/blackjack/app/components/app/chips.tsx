// Shared sketch-chip helpers + rendering for the blackjack tables (bot self-play AND PvP), so the
// denomination palette and pile logic stay in ONE place. A chip pile reads a seat's balance as
// denomination chips; the centre "flying" chip animates between the seats and the pot.

// Denomination → colour (highest first). The 100-chip is a slate grey, not near-black, so it
// doesn't blend into the dark sketch border.
export const CHIP_DENOMS: { value: number; color: string }[] = [
  { value: 1000, color: "#7c3aed" }, // violet
  { value: 100, color: "#94a3b8" }, // slate grey
  { value: 50, color: "#ea580c" }, // orange
  { value: 20, color: "#15803d" }, // green
  { value: 10, color: "#2563eb" }, // blue
  { value: 5, color: "#dc2626" }, // red
];
const MAX_CHIPS = 8;

// Break a value into denomination-chip colours (highest first), capped so a fat stack stays compact.
export function chipStack(balance: number): string[] {
  const colors: string[] = [];
  let remaining = Math.floor(balance);
  for (const d of CHIP_DENOMS) {
    while (remaining >= d.value && colors.length < MAX_CHIPS) {
      colors.push(d.color);
      remaining -= d.value;
    }
  }
  return colors;
}

const THOUSANDS_COLOR = "#7c3aed"; // violet (the 1000-chip)
const THOUSANDS_CAP = 6;

// Split a seat's balance into TWO piles: a capped column of 1000-chips for the bulk, and the
// sub-1000 remainder broken into smaller denominations. Per-round swings are < 1000, so the
// remainder shifts every hand — making the pile visibly move — and its colours stand apart from
// the violet thousands. (A single greedy stack stayed pinned at the cap of 1000-chips all game.)
export function seatChipColumns(balance: number): {
  bulk: string[];
  remainder: string[];
} {
  const whole = Math.max(0, Math.floor(balance));
  const thousands = Math.min(Math.floor(whole / 1000), THOUSANDS_CAP);
  return {
    bulk: Array.from({ length: thousands }, () => THOUSANDS_COLOR),
    remainder: chipStack(whole % 1000),
  };
}

// Colour of the chip a seat tosses in — the wager's top denomination, so the thrown chip matches
// the bet (e.g. 1000 → violet, 500 → the 100-chip colour, 25 → the 20-chip colour).
export function betChipColor(bet: number): string {
  return chipStack(bet)[0] ?? CHIP_DENOMS[CHIP_DENOMS.length - 1].color;
}

// Flying-chip travel targets, in px relative to the centre betting spot — kept INSIDE the table
// (dealer seat up-left, player seat down-left, centre = the pot). vw/vh sent the chip to the
// viewport edges once the game is scaled down inside its window, so it flew off the table.
export const CHIP_DEALER_HOME = "-200px, -150px";
export const CHIP_PLAYER_HOME = "-200px, 200px";

// One vertical pile of sketch chips (base at the bottom, growing up; later chips overlap on top).
export function ChipColumn({ colors }: { colors: string[] }) {
  if (colors.length === 0) return null;
  return (
    <div
      className="relative w-6"
      style={{ height: 24 + (colors.length - 1) * 7 }}
    >
      {colors.map((color, i) => (
        <div
          key={i}
          className="absolute left-0 w-6 h-6 rounded-full border-[3px] border-[var(--qp-ink)] shadow-[0_2px_0_var(--qp-ink)] flex items-center justify-center"
          style={{ backgroundColor: color, bottom: i * 7 }}
        >
          <div className="w-3 h-3 rounded-full border border-[var(--qp-ink)] opacity-50"></div>
        </div>
      ))}
    </div>
  );
}

// Two side-by-side piles (thousands + remainder) for a seat, given its balance.
export function SeatChips({ balance }: { balance: number }) {
  const cols = seatChipColumns(balance);
  return (
    <div className="flex items-end gap-1.5">
      <ChipColumn colors={cols.bulk} />
      <ChipColumn colors={cols.remainder} />
    </div>
  );
}
