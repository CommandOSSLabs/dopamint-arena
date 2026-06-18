import { cn } from "@/lib/utils";
import type { GameModule } from "./types";

/**
 * A game's logo (from public/games), rendered as a rounded app-icon. Size and
 * corner radius come from `className`; defaults to a small rounded square.
 */
export function GameIcon({
  game,
  className,
}: {
  game: GameModule;
  className?: string;
}) {
  return (
    <img
      src={game.image}
      alt=""
      aria-hidden
      draggable={false}
      className={cn("size-5 shrink-0 rounded-md object-cover", className)}
    />
  );
}
