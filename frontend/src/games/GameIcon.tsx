import { useState } from "react";
import { cn } from "@/lib/utils";
import type { GameModule } from "./types";

/**
 * A game's logo (from public/games), rendered as a rounded app-icon. Size and
 * corner radius come from `className`; defaults to a small rounded square.
 * Falls back to the module's emoji `icon` when the image is missing or fails to
 * load (per GameModule.icon's documented role).
 */
export function GameIcon({
  game,
  className,
}: {
  game: GameModule;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  if (failed || !game.image) {
    return (
      <span
        aria-hidden
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-md",
          className,
        )}
      >
        {game.icon}
      </span>
    );
  }

  return (
    <img
      src={game.image}
      alt=""
      aria-hidden
      draggable={false}
      onError={() => setFailed(true)}
      className={cn("size-5 shrink-0 rounded-md object-cover", className)}
    />
  );
}
