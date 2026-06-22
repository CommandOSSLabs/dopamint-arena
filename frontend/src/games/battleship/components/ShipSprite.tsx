import { cn } from "@/lib/utils";

/**
 * A ship sprite sized to fill its footprint cell-box. We ship ONE image per
 * vessel (`<id>_h.png`, horizontal) and rotate it 90° for vertical placement —
 * the `_v` art is just the rotated `_h`, so a single asset stays in sync.
 *
 * Horizontal: the image fills the box (object-cover crops the square sprite's
 * transparent padding). Vertical: render it as the TRANSPOSED box (size× wider,
 * 1/size× taller) and rotate 90° so it lands square in the tall footprint.
 * The parent must be `relative overflow-hidden`.
 */
export function ShipSprite({
  id,
  size,
  horizontal,
  className,
}: {
  id: string;
  size: number;
  horizontal: boolean;
  className?: string;
}) {
  return (
    <img
      src={`/games/ships/${id}_h.png`}
      alt=""
      draggable={false}
      className={cn(
        "pointer-events-none object-cover mix-blend-screen",
        horizontal
          ? "h-full w-full"
          : "absolute top-1/2 left-1/2 max-w-none origin-center -translate-x-1/2 -translate-y-1/2 rotate-90",
        className,
      )}
      style={
        horizontal
          ? undefined
          : { width: `${size * 100}%`, height: `${100 / size}%` }
      }
    />
  );
}
